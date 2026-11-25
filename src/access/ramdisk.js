/**
 * @file src/access/ramdisk.js
 * @module access/ramdisk
 * @purpose The tmp cache of the house: a file system in the memory and a cache of bytes that
 *          the parent and the worker share.
 *
 *   Two things live here, and they are two halves of one idea: the work of a run must not
 *   wait for the disk.
 *
 *   - The **file system in the memory** is a backend of the access, the same way the disk
 *     is a backend: it answers `readFile`, `writeFile`, `readdir`, `stat`, `lstat`,
 *     `realpath`, `unlink`, `mkdir`, `rename` and `copy` in one shape. The rules of the
 *     paths stay the rules of `access/paths`, so a path that may not be touched on the
 *     disk may not be touched in the memory either.
 *   - The **cache of bytes** is one block of shared memory: the parent writes a picture
 *     into it, and the worker reads the very same bytes — not a copy of them. The block is
 *     a `SharedArrayBuffer`, so it crosses a thread and not a process.
 *
 *   The cache has a cap: the block is allocated once, and a picture that does not fit is
 *   refused with the reason named. The cap may be as big as the machine allows — 1 GB,
 *   2 GB, 4 GB, 8 GB — because the block is virtual memory: the pages are taken when the
 *   bytes are written, not when the block is made.
 *
 * @depends node:path
 * @usedBy access/index, agent/tools
 * @exports RAMDISK_MAGIC, RAMDISK_VERSION, createRamdiskFileSystem, createRamdisk,
 *          createSharedByteCache, allocateMemory, RAMDISK_LIMITS
 * @ai.tags house, ramdisk, cache, memory
 * @ai.hint io
 */

import path from 'node:path';

/** The mark of a shared block of the cache. */
export const RAMDISK_MAGIC = 0x52444B31; // 'RDK1'

/** The version of the layout of a shared block of the cache. */
export const RAMDISK_VERSION = 1;

/** The limits of the ramdisk. */
export const RAMDISK_LIMITS = Object.freeze({
    /** The biggest block of shared memory a caller may ask for, in bytes (8 GB). */
    maxBytes: 8 * 1024 * 1024 * 1024,
    /** The biggest file of the memory file system, in bytes. */
    maxFileBytes: 512 * 1024 * 1024,
    /** The number of the files of the memory file system. */
    maxFiles: 100_000,
});

/**
 * The key of a path: the absolute path without the trailing separator.
 * @param {string} target
 * @returns {string}
 * @ai.hint pure
 */
function keyOf(target) {
    const abs = path.resolve(String(target ?? '.'));
    return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

/**
 * The backend of the file system in the memory.
 *
 * The contract is the contract of the access: the state of a path is a plain object with
 * the properties, and every backend of the library answers in one shape.
 *
 * @param {{ capacityBytes?: number, root?: string }} [options]
 * @returns {object} the backend of the file system
 * @exports
 * @ai.hint io
 */
export function createRamdiskFileSystem({ capacityBytes = RAMDISK_LIMITS.maxFileBytes, root = process.cwd() } = {}) {
    /** @type {Map<string, { bytes: Uint8Array|null, isDirectory: boolean, mtimeMs: number }>} */
    const nodes = new Map();
    let used = 0;
    const cap = Math.max(1, Math.min(RAMDISK_LIMITS.maxFileBytes, Math.round(capacityBytes) || RAMDISK_LIMITS.maxFileBytes));

    const node = (target) => nodes.get(keyOf(target));

    const missing = (target) => {
        const error = new Error(`ENOENT: no such file or directory, '${target}'`);
        error.code = 'ENOENT';
        return error;
    };

    /**
     * The state of a path in the shape the facade expects.
     * @param {object|null} found
     * @returns {object|null}
     * @ai.hint pure
     */
    const state = (found) => (found ? {
        size: found.bytes ? found.bytes.byteLength : 0,
        isDirectory: found.isDirectory,
        isFile: !found.isDirectory,
        isSymbolicLink: false,
        mtimeMs: found.mtimeMs,
    } : null);

    return {
        nodes,
        /**
         * The bytes the memory holds right now.
         * @returns {number}
         * @ai.hint pure
         */
        used: () => used,

        /**
         * @param {string} target
         * @returns {Promise<Uint8Array>}
         */
        readFile: async (target) => {
            const found = node(target);
            if (!found || found.isDirectory || !found.bytes) throw missing(target);
            return found.bytes;
        },

        /**
         * @param {string} target
         * @param {Uint8Array} bytes
         * @returns {Promise<void>}
         */
        writeFile: async (target, bytes) => {
            const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
            if (data.byteLength > cap) {
                throw new Error(`The file is too big for the ramdisk: ${data.byteLength} bytes, the cap is ${cap}.`);
            }
            if (nodes.size >= RAMDISK_LIMITS.maxFiles && !node(target)) {
                throw new Error(`The ramdisk holds no more than ${RAMDISK_LIMITS.maxFiles} files.`);
            }
            const key = keyOf(target);
            const before = nodes.get(key);
            if (before?.bytes) used -= before.bytes.byteLength;
            used += data.byteLength;
            if (used > cap) {
                if (before?.bytes) used -= before.bytes.byteLength;
                throw new Error(`The ramdisk is full: ${used} bytes over the cap of ${cap}.`);
            }
            nodes.set(key, { bytes: data, isDirectory: false, mtimeMs: Date.now() });
        },

        /**
         * @param {string} target
         * @returns {Promise<Array<{ name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean, size: number }>>}
         */
        readdir: async (target) => {
            const found = node(target);
            if (!found) throw missing(target);
            if (!found.isDirectory) throw missing(target);
            const base = keyOf(target);
            const out = [];
            for (const [key, value] of nodes) {
                if (key === base) continue;
                const relative = path.relative(base, key);
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
                if (relative.includes(path.sep)) continue;
                out.push({
                    name: relative,
                    isDirectory: value.isDirectory,
                    isFile: !value.isDirectory,
                    isSymbolicLink: false,
                    size: value.bytes ? value.bytes.byteLength : 0,
                });
            }
            return out;
        },

        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        stat: async (target) => state(node(target)),

        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        lstat: async (target) => state(node(target)),

        /**
         * @param {string} target
         * @returns {Promise<string>}
         */
        realpath: async (target) => keyOf(target),

        /**
         * @param {string} target
         * @returns {Promise<void>}
         */
        unlink: async (target) => {
            const found = node(target);
            if (!found) throw missing(target);
            if (found.bytes) used -= found.bytes.byteLength;
            nodes.delete(keyOf(target));
        },

        /**
         * @param {string} target
         * @param {{ recursive?: boolean }} options
         * @returns {Promise<string|undefined>}
         */
        mkdir: async (target, { recursive = false } = {}) => {
            const abs = keyOf(target);
            if (nodes.has(abs)) return abs;
            if (!recursive) {
                nodes.set(abs, { bytes: null, isDirectory: true, mtimeMs: Date.now() });
                return abs;
            }
            // The parts are built from the root down: a drive letter is not a part of the path.
            const parts = [];
            let current = abs;
            while (current !== path.dirname(current)) {
                parts.unshift(path.basename(current));
                current = path.dirname(current);
            }
            let built = current;
            for (const part of parts) {
                built = path.join(built, part);
                if (!nodes.has(built)) nodes.set(built, { bytes: null, isDirectory: true, mtimeMs: Date.now() });
            }
            return abs;
        },

        /**
         * @param {string} from
         * @param {string} to
         * @returns {Promise<void>}
         */
        rename: async (from, to) => {
            const found = node(from);
            if (!found) throw missing(from);
            nodes.delete(keyOf(from));
            nodes.set(keyOf(to), found);
        },

        /**
         * Copy a file or a tree.
         * @param {string} from
         * @param {string} to
         * @param {{ recursive?: boolean, force?: boolean }} [options]
         * @returns {Promise<void>}
         */
        copy: async (from, to, { recursive = true, force = false } = {}) => {
            const source = keyOf(from);
            const found = node(from);
            if (!found) throw missing(from);
            const target = keyOf(to);
            if (nodes.has(target) && !force) {
                const error = new Error(`EEXIST: file already exists, '${to}'`);
                error.code = 'EEXIST';
                throw error;
            }
            const stamp = Date.now();
            nodes.set(target, { bytes: found.bytes, isDirectory: found.isDirectory, mtimeMs: stamp });
            if (!found.isDirectory || !recursive) return;
            const prefix = `${source}${path.sep}`;
            for (const [key, value] of [...nodes.entries()]) {
                if (!key.startsWith(prefix)) continue;
                const child = path.join(target, path.relative(source, key));
                nodes.set(child, { bytes: value.bytes, isDirectory: value.isDirectory, mtimeMs: stamp });
            }
        },
    };
}

/**
 * The cache of bytes that the parent and the worker share.
 *
 * One block of shared memory holds the bytes of one picture at a time. The parent writes
 * the bytes, the worker reads them, and the worker may write its own bytes back — the
 * block is one memory, and both sides see the same bytes.
 *
 * The block is a `SharedArrayBuffer`: it crosses a thread and not a process. A process
 * gets the bytes as base64 instead.
 *
 * @param {{ capacityBytes?: number, shared?: SharedArrayBuffer|null }} [options]
 * @returns {{ buffer: SharedArrayBuffer, capacityBytes: number, write: Function,
 *   read: Function, size: Function, release: Function, available: Function }}
 * @exports
 * @ai.hint io
 */
export function createSharedByteCache({ capacityBytes = 64 * 1024 * 1024, shared = null } = {}) {
    const cap = Math.max(1, Math.min(RAMDISK_LIMITS.maxBytes, Math.round(capacityBytes) || 0));
    const buffer = shared instanceof SharedArrayBuffer ? shared : new SharedArrayBuffer(cap);
    // The first word of the block says how many bytes are in it right now: the data
    // starts after it, so the length never sits on the bytes themselves.
    const words = new Int32Array(buffer, 0, 1);
    const LENGTH_WORD = 0;
    const HEADER_BYTES = 4;
    const bytes = new Uint8Array(buffer, HEADER_BYTES, Math.max(0, buffer.byteLength - HEADER_BYTES));

    /**
     * The number of the bytes in the block right now.
     * @returns {number}
     * @ai.hint pure
     */
    const size = () => Atomics.load(words, LENGTH_WORD);

    return {
        buffer,
        capacityBytes: bytes.byteLength,

        /**
         * The number of the bytes in the block right now.
         * @returns {number}
         * @ai.hint pure
         */
        size,

        /**
         * Put the bytes into the block: the other side sees them without a copy.
         * @param {Uint8Array|Buffer} payload
         * @returns {number} the number of the bytes written
         * @ai.hint io
         */
        write(payload) {
            const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload ?? []);
            if (data.byteLength > bytes.byteLength) {
                throw new Error(`The picture does not fit the shared cache: ${data.byteLength} bytes, the cap is ${bytes.byteLength}.`);
            }
            bytes.set(data, 0);
            Atomics.store(words, LENGTH_WORD, data.byteLength);
            return data.byteLength;
        },

        /**
         * The bytes of the block right now.
         * @returns {Uint8Array} a view of the block, not a copy of it
         * @ai.hint pure
         */
        read() {
            return bytes.subarray(0, size());
        },

        /**
         * The bytes of the block right now, as a copy.
         * @returns {Buffer}
         * @ai.hint pure
         */
        readCopy() {
            return Buffer.from(bytes.subarray(0, size()));
        },

        /**
         * Empty the block.
         * @returns {void}
         * @ai.hint pure
         */
        release() {
            Atomics.store(words, LENGTH_WORD, 0);
        },

        /**
         * Is there room for so many bytes?
         * @param {number} count
         * @returns {boolean}
         * @ai.hint pure
         */
        available(count) {
            return Math.max(0, Math.round(count) || 0) <= bytes.byteLength;
        },
    };
}

/**
 * The ramdisk of a run: the file system in the memory and the cache of bytes.
 *
 * @param {{ capacityBytes?: number, cacheBytes?: number, shared?: SharedArrayBuffer|null }} [options]
 * @returns {{ fs: object, cache: object, backend: object }}
 * @exports
 * @ai.hint io
 */
export function createRamdisk({ capacityBytes = RAMDISK_LIMITS.maxFileBytes, cacheBytes = 64 * 1024 * 1024, shared = null } = {}) {
    const fs = createRamdiskFileSystem({ capacityBytes });
    const cache = createSharedByteCache({ capacityBytes: cacheBytes, shared });
    return {
        fs,
        cache,
        backend: { fs, exec: null },
    };
}

/**
 * Allocate a block of memory for the work of a run.
 *
 * The block is a `SharedArrayBuffer`: the parent and the worker see the same bytes, and
 * the memory is taken when the bytes are written — not when the block is made. A run
 * that asks for 8 GB gets 8 GB of address space and the pages it actually touches.
 *
 * The ceiling of the package is 8 GB, and the caller may ask for less.
 *
 * @param {{ bytes?: number, allocateBytes?: number }} [options]
 * @returns {{ buffer: SharedArrayBuffer, bytes: Uint8Array, capacityBytes: number, size: Function }}
 * @exports
 * @ai.hint io
 */
export function allocateMemory({ bytes = 0, allocateBytes = null } = {}) {
    const wanted = Math.max(0, Math.round(Number(bytes) || 0));
    const ceiling = Math.max(1, Math.min(
        RAMDISK_LIMITS.maxBytes,
        Math.round(Number(allocateBytes) || RAMDISK_LIMITS.maxBytes),
    ));
    if (wanted > ceiling) {
        throw new Error(`The block of ${wanted} bytes is over the ceiling of ${ceiling} bytes.`);
    }
    const buffer = new SharedArrayBuffer(wanted);
    const view = new Uint8Array(buffer);
    return {
        buffer,
        bytes: view,
        capacityBytes: wanted,
        /**
         * The number of the bytes written into the block.
         * @returns {number}
         * @ai.hint pure
         */
        size() {
            return view.byteLength;
        },
    };
}
