/**
 * @file src/shared/code-mode.js
 * @module shared/code-mode
 * @purpose Code Mode: the model writes a program, and the program runs in a sandbox.
 *
 *   The ordinary cycle of a role asks the model for one tool call at a time. Every call
 *   costs a round trip to the API, and the model has to think about the order of the calls
 *   instead of about the work. Code Mode gives the model the whole step at once: it writes
 *   a program, the program calls the tools by itself, and the model reads the result.
 *
 *   The program does not run where the model writes it. It runs in a **sandbox** — a realm
 *   of `node:vm` inside a worker thread of its own:
 *
 *   - The realm is fresh: the program sees no global of the house, and it has no
 *     `process`, no `require`, no `Buffer` and no `fetch` unless the parent gives them.
 *   - The worker is a crash domain of its own: a program that hangs in an endless loop is
 *     stopped by `terminate()`, and the parent lives. (`node:vm` alone cannot stop a loop
 *     that never yields: only the worker can.)
 *   - The tools of the parent stay the tools of the parent: the sandbox holds *proxies*,
 *     and every call travels back to the parent, which runs it with its own rights and its
 *     own rules. The sandbox never touches a file by itself.
 *
 *   The memory of the house is available to the program too: the **RAM-FS** (a file system
 *   in the memory), the **shared block** (one `SharedArrayBuffer` the parent and the
 *   sandbox see at the same time, without a copy) and `allocate()` — a block of 1 GB,
 *   2 GB, 4 GB or 8 GB of address space, taken when the bytes are written and not before.
 *
 *   The stdio of the program is real: what it writes comes back as the output of the run,
 *   and the stdin of the sandbox is readable by the program.
 *
 *   The sandbox is a **guardrail, not a security boundary**. It keeps a careless program
 *   from touching the machine, and it keeps a runaway program from taking the parent with
 *   it. It is not a jail against a program that means harm.
 *
 *   The rule that keeps the realm a realm: **no object of the host is ever a property of
 *   the context**. A host function or a host object inside the context is an escape hatch
 *   — `hostFn.constructor.constructor('return process')()` walks straight out of the
 *   realm. The host reaches the program only through facades that return primitives, and
 *   the facades live in the closure of the install script, where the program cannot see
 *   them.
 *
 * @depends node:vm, node:worker_threads, node:path, node:url, shared/protocol, access/ramdisk
 * @usedBy agent/code-mode, client/interface
 * @exports CODE_MODE_VERSION, CODE_MODE_LIMITS, CodeModeError, createCodeModeSpec,
 *          normalizeCodeMode, runCodeMode, runCodeModeWorker, codeModeMain,
 *          startCodeModeWorker, codeModeEntry
 * @ai.tags house, code-mode, sandbox, vm, worker
 * @ai.hint io
 */

import { Worker, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrame, isFrame } from './protocol.js';
import { createRamdiskFileSystem, createSharedByteCache, allocateMemory, RAMDISK_LIMITS } from '../access/ramdisk.js';
import { createLibraryBridge } from './code-libraries.js';

/**
 * The version of the contract of Code Mode.
 */
export const CODE_MODE_VERSION = 1;

/**
 * The name of the file of the sandbox in this package.
 *
 * Every package of the house keeps its own name for the file, so the bin of one package
 * never runs the sandbox of another.
 */
const CODE_MODE_ENTRY_NAME = 'ai-image-code-mode-worker.js';

/**
 * The way from the module of the sandbox to the root of the package.
 *
 * The module of the package that owns the code lives in `src/shared/`, so the root is two
 * levels up. A package that keeps the module deeper says so here.
 */
const CODE_MODE_ENTRY_DEPTH = ['..', '..'];

/**
 * The header of the shared block of the house.
 *
 * The first word of the block holds the number of the bytes in it, so the data starts
 * after it: the view of the program starts there too, and the offsets of the program are
 * the offsets of the parent.
 */
const SHARED_HEADER_BYTES = 4;

/** The limits of Code Mode. */
export const CODE_MODE_LIMITS = Object.freeze({
    /** The time one program may run, in milliseconds. */
    timeoutMs: 60_000,
    /** The cap of the output of one program, in bytes. */
    outputBytes: 256 * 1024,
    /** The biggest block of memory a program may allocate, in bytes (8 GB). */
    maxBytes: RAMDISK_LIMITS.maxBytes,
    /** The biggest file of the RAM-FS, in bytes. */
    maxFileBytes: RAMDISK_LIMITS.maxFileBytes,
    /** The number of the calls of the tools one program may make. */
    maxCalls: 200,
    /** The cap of the stdin of the sandbox, in bytes. */
    stdinBytes: 64 * 1024,
});

/**
 * The error of Code Mode: the code did not run, or it did not finish.
 *
 * The error carries the reason of the failure in a stable word, so the caller may tell a
 * timeout from a syntax error from a refused tool call without reading the message.
 */
export class CodeModeError extends Error {
    /**
     * @param {string} message what happened
     * @param {{ reason?: string, code?: string|null, stack?: string|null }} [details]
     */
    constructor(message, { reason = 'failed', code = null, stack = null } = {}) {
        super(message);
        this.name = 'CodeModeError';
        this.reason = reason;
        this.code = code;
        this.stack = stack ?? null;
    }
}

/**
 * The entry of the sandbox of Code Mode.
 *
 * The path is resolved from this module: the sandbox lives in `bin/` of the package, and the
 * package is found from the module itself. A package of the house that keeps its own name
 * for the file passes it.
 *
 * @param {string} [name] the name of the file of the sandbox
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function codeModeEntry(name = CODE_MODE_ENTRY_NAME) {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        ...CODE_MODE_ENTRY_DEPTH,
        'bin',
        name,
    );
}

/**
 * The spec of one run of Code Mode.
 *
 * The spec says what the program may do: the code to run, the tools it may call, the
 * memory it may use and the time it may take.
 *
 * @param {{ code?: string, tools?: object[]|string[], timeoutMs?: number, outputBytes?: number,
 *   ramdiskBytes?: number, cacheBytes?: number, shared?: SharedArrayBuffer|null,
 *   allowAllocate?: boolean, stdin?: string }} [raw]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createCodeModeSpec(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const timeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0
        ? source.timeoutMs
        : CODE_MODE_LIMITS.timeoutMs;
    const outputBytes = Number.isSafeInteger(source.outputBytes) && source.outputBytes > 0
        ? source.outputBytes
        : CODE_MODE_LIMITS.outputBytes;
    return {
        version: CODE_MODE_VERSION,
        code: typeof source.code === 'string' ? source.code : '',
        // The catalogue of the tools: the names, and the description of every one of them.
        tools: Array.isArray(source.tools)
            ? source.tools.map((item) => (typeof item === 'string'
                ? { name: item.trim(), description: '', parameters: null }
                : {
                    name: String(item?.name ?? '').trim(),
                    description: String(item?.description ?? ''),
                    parameters: item?.parameters && typeof item.parameters === 'object' ? item.parameters : null,
                })).filter((item) => item.name)
            : [],
        timeoutMs,
        outputBytes,
        ramdiskBytes: Number.isSafeInteger(source.ramdiskBytes) && source.ramdiskBytes > 0
            ? source.ramdiskBytes
            : CODE_MODE_LIMITS.maxFileBytes,
        cacheBytes: Number.isSafeInteger(source.cacheBytes) && source.cacheBytes > 0
            ? source.cacheBytes
            : 64 * 1024 * 1024,
        // The shared block: the parent and the sandbox see the same bytes, and neither of
        // them copies them.
        shared: source.shared instanceof SharedArrayBuffer ? source.shared : null,
        // May the program allocate a block of memory? The block is virtual memory: the
        // pages are taken when the bytes are written.
        allowAllocate: source.allowAllocate !== false,
        // The stdin of the sandbox: the program reads it with `stdin.read()`.
        stdin: typeof source.stdin === 'string' ? source.stdin : '',
        // The libraries the program may use: canvas, the wasm of ImageMagick, openvector.
        // Null means all of them — the ones this package really has.
        libraries: Array.isArray(source.libraries)
            ? source.libraries.map((item) => String(item ?? '').trim()).filter(Boolean)
            : null,
        // The facilities of the host: the calls the house offers and the libraries do not.
        // They travel as names, and the host holds the functions behind them.
        facilities: Array.isArray(source.facilities)
            ? source.facilities.map((item) => String(item ?? '').trim()).filter(Boolean)
            : [],
    };
}

/**
 * Normalize the spec of Code Mode: every field has a default, and the wrong type never
 * throws — a spec that names nothing is a spec of nothing.
 *
 * @param {object} raw the spec as the parent wrote it
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function normalizeCodeMode(raw = {}) {
    return createCodeModeSpec(raw);
}

/**
 * The install script of the realm.
 *
 * The script runs inside the realm and takes the host bridge as its only argument. Its own
 * scope is script-local: the bridge, the views and the helpers stay out of the reach of
 * the program, and only the facades it installs are global.
 *
 * Every facade returns a primitive. A host object crossing the border would be an escape
 * hatch, so the bytes travel as base64 and the answers as JSON.
 *
 * @type {string}
 * @ai.hint pure
 */
const REALM_SCRIPT = `(function (host) {
    'use strict';

    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    const toBase64 = (bytes) => {
        const raw = String.fromCharCode.apply(null, Array.from(bytes ?? []));
        let out = '';
        for (let i = 0; i < raw.length; i += 3) {
            const a = raw.charCodeAt(i);
            const b = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
            const c = i + 2 < raw.length ? raw.charCodeAt(i + 2) : 0;
            const n = (a << 16) | (b << 8) | c;
            out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63];
            out += i + 1 < raw.length ? CHARS[(n >> 6) & 63] : '=';
            out += i + 2 < raw.length ? CHARS[n & 63] : '=';
        }
        return out;
    };

    const fromBase64 = (text) => {
        const raw = String(text ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
        const out = [];
        for (let i = 0; i < raw.length; i += 4) {
            const n = (CHARS.indexOf(raw[i]) << 18)
                | (CHARS.indexOf(raw[i + 1]) << 12)
                | ((raw[i + 2] === '=' ? 0 : CHARS.indexOf(raw[i + 2])) << 6)
                | (raw[i + 3] === '=' ? 0 : CHARS.indexOf(raw[i + 3]));
            out.push((n >> 16) & 255);
            if (raw[i + 2] !== '=') out.push((n >> 8) & 255);
            if (raw[i + 3] !== '=') out.push(n & 255);
        }
        return Uint8Array.from(out);
    };

    const text = (value) => {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.name + ': ' + value.message;
        try {
            const encoded = JSON.stringify(value);
            return encoded === undefined ? String(value) : encoded;
        } catch {
            return String(value);
        }
    };

    // The output of the program: it goes to the parent.
    const line = (...args) => host.log(args.map(text).join(' '));
    const errLine = (...args) => host.err(args.map(text).join(' '));
    globalThis.console = Object.freeze({
        log: line,
        info: line,
        debug: line,
        // The warnings and the errors of the program go to the error output: the parent
        // tells them apart from the ordinary output.
        warn: errLine,
        error: errLine,
    });
    globalThis.stdout = Object.freeze({ write: (value) => host.out(text(value)) });
    globalThis.stderr = Object.freeze({ write: (value) => host.err(text(value)) });
    globalThis.stdin = Object.freeze({
        read: () => host.in(),
        readAll: () => host.in(),
    });

    // The encoders of the realm: the globals of the host are not here.
    globalThis.TextEncoder = class TextEncoder {
        encode(input) {
            const s = String(input ?? '');
            const out = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
            return out;
        }
    };
    globalThis.TextDecoder = class TextDecoder {
        decode(input) {
            const bytes = Uint8Array.from(input ?? []);
            let out = '';
            for (const byte of bytes) out += String.fromCharCode(byte);
            return out;
        }
    };
    globalThis.btoa = (value) => toBase64(
        Uint8Array.from(String(value ?? ''), (c) => c.charCodeAt(0) & 0xff),
    );
    globalThis.atob = (value) => String.fromCharCode.apply(null, Array.from(fromBase64(value)));

    // The catalogue of the tools: the program may ask what it may call.
    const catalogue = JSON.parse(host.catalogue);
    const byName = new Map(catalogue.map((entry) => [entry.name, entry]));
    const proxies = {};
    for (const entry of catalogue) {
        proxies[entry.name] = async (...args) => {
            const first = args[0];
            const payload = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
            const envelope = JSON.parse(await host.call(entry.name, JSON.stringify(payload)));
            if (!envelope.ok) throw new Error(envelope.error || 'The tool failed.');
            return envelope.value;
        };
    }
    globalThis.tools = Object.freeze(proxies);
    globalThis.catalogue = Object.freeze({
        names: Object.freeze(catalogue.map((entry) => entry.name)),
        describe: (name) => byName.get(String(name ?? '')) ?? null,
    });

    // The libraries of the house: canvas, the wasm of ImageMagick, openvector.
    //
    // The realm cannot load a module at all, so the program names a call and the host
    // runs it. A native handle never leaves the host: it stays in a table there, and the
    // program holds an opaque id for it. Nothing of the host crosses the border — only
    // plain data, both ways.
    const library = {
        // The catalogue: the libraries that are here and the calls they offer.
        catalog: async () => JSON.parse(await host.libraryCatalog()),
        // One call: the library and its member, or the member of a handle.
        //
        // The answer of a call is the plain data of it. A native object — a canvas, a
        // document — comes back as an id, and that id is the beginning of the path of the
        // next call: the handle stays on the host side.
        call: async (path, args) => {
            const answer = JSON.parse(await host.libraryCall(
                String(path ?? ''),
                JSON.stringify(args ?? []),
            ));
            if (!answer || answer.ok !== true) {
                const error = new Error(answer?.error ?? 'the call failed');
                error.failed = true;
                throw error;
            }
            // The answer of a library is the value of the call. The answer of a facility
            // is data, and the worker has already read it back from the JSON.
            return answer.value ?? null;
        },
        // The bytes of an answer: the answer carries them as base64.
        bytes: (b64) => fromBase64(String(b64 ?? '')),
        base64: (bytes) => toBase64(Uint8Array.from(bytes ?? [])),
        text: (b64) => String.fromCharCode.apply(null, Array.from(fromBase64(String(b64 ?? '')))),
        // The bytes of an argument: a native module wants a Buffer, and the realm has
        // none — so the bytes travel as base64 and the host makes the Buffer.
        buffer: (bytes) => ({ bytes: toBase64(Uint8Array.from(bytes ?? [])) }),
    };
    globalThis.library = Object.freeze(library);

    // A block of memory: the pages are taken when the bytes are written, not before.
    // The block is made inside the realm, so it is a realm object and not a door back to
    // the host.
    globalThis.allocate = (bytes) => {
        const wanted = Math.max(0, Math.round(Number(bytes) || 0));
        const ceiling = Number(host.maxBytes());
        if (wanted > ceiling) {
            throw new Error('The block of ' + wanted + ' bytes is over the ceiling of ' + ceiling + '.');
        }
        const buffer = new SharedArrayBuffer(wanted);
        return { buffer, bytes: new Uint8Array(buffer), capacityBytes: wanted };
    };

    // The file system in the memory: the same shape as the file system of the access.
    const state = (info) => (info ? {
        size: info.size,
        isDirectory: info.isDirectory,
        isFile: info.isFile,
        isSymbolicLink: info.isSymbolicLink,
        mtimeMs: info.mtimeMs,
    } : null);
    globalThis.fs = Object.freeze({
        readFile: async (target) => fromBase64(await host.fsRead(String(target ?? ''))),
        writeFile: async (target, bytes) => {
            await host.fsWrite(String(target ?? ''), toBase64(Uint8Array.from(bytes ?? [])));
        },
        readdir: async (target) => JSON.parse(await host.fsReaddir(String(target ?? ''))),
        stat: async (target) => state(JSON.parse(await host.fsStat(String(target ?? '')))),
        lstat: async (target) => state(JSON.parse(await host.fsLstat(String(target ?? '')))),
        realpath: async (target) => await host.fsRealpath(String(target ?? '')),
        unlink: async (target) => { await host.fsUnlink(String(target ?? '')); },
        mkdir: async (target, options) => {
            await host.fsMkdir(String(target ?? ''), options?.recursive === true);
        },
        rename: async (from, to) => { await host.fsRename(String(from ?? ''), String(to ?? '')); },
        copy: async (from, to, options) => {
            await host.fsCopy(
                String(from ?? ''),
                String(to ?? ''),
                options?.recursive !== false,
                options?.force === true,
            );
        },
        used: async () => Number(await host.fsUsed()),
    });

    // The shared block: the parent and the program see the same bytes.
    //
    // The buffer of the house comes into the realm as an argument of the script, so the
    // realm makes its OWN typed arrays over the very same memory: one memory, no copy.
    // The data of the block starts after the word that holds its length, so the view of
    // the realm starts there too — the offsets of the program are the offsets of the
    // parent.
    //
    // The one door back to the host is the 'buffer' property, and it is shadowed — the
    // program sees no buffer at all, and the bytes it writes still land in the memory of
    // the house.
    const raw = host.sharedBuffer();
    const offset = Number(host.sharedOffset());
    const length = Number(host.sharedLength());
    const view = raw ? new Uint8Array(raw, offset, length) : null;
    const ints = raw ? new Int32Array(raw, offset, Math.floor(length / 4)) : null;
    if (view) {
        Object.defineProperty(view, 'buffer', { value: undefined, enumerable: false, configurable: false });
        Object.defineProperty(ints, 'buffer', { value: undefined, enumerable: false, configurable: false });
    }
    globalThis.shared = Object.freeze({
        view,
        ints,
        capacity: () => (view ? view.byteLength : 0),
        // The bytes travel as base64, so no host object crosses the border.
        read: async (offset, length) => fromBase64(await host.sharedRead(offset | 0, length | 0)),
        write: async (offset, bytes) => {
            await host.sharedWrite(offset | 0, toBase64(Uint8Array.from(bytes ?? [])));
        },
        release: async () => { await host.sharedRelease(); },
        available: async (count) => String(await host.sharedAvailable(count | 0)) === 'true',
    });
})`;

/**
 * The name of the tool that runs a program of Code Mode.
 *
 * The name is the same in every package of the house: the model learns it once.
 */
export const CODE_MODE_TOOL = 'code_mode';

/**
 * Run one program in the sandbox.
 *
 * The program runs in a fresh realm of `node:vm`, inside the thread that calls this
 * function. The parent must call it in the sandbox worker and not in its own thread: a
 * program that never yields cannot be stopped by anybody but the worker.
 *
 * The program is the body of an async function: it may `await`, and it may `return` the
 * answer of the step.
 *
 * @param {{ code?: string, tools?: object[], shared?: SharedArrayBuffer|null,
 *   allowAllocate?: boolean, ramdiskBytes?: number, cacheBytes?: number,
 *   timeoutMs?: number, outputBytes?: number, stdin?: string,
 *   onCall?: Function|null, onLog?: Function|null, onError?: Function|null }} request
 * @returns {Promise<{ ok: boolean, value: unknown, output: string, error: string|null,
 *   reason: string, calls: Array<{ name: string, arguments: object }> }>}
 * @exports
 * @ai.hint io
 */
export async function runCodeMode({
    code = '',
    tools = [],
    shared = null,
    allowAllocate = true,
    ramdiskBytes = CODE_MODE_LIMITS.maxFileBytes,
    cacheBytes = 64 * 1024 * 1024,
    timeoutMs = CODE_MODE_LIMITS.timeoutMs,
    outputBytes = CODE_MODE_LIMITS.outputBytes,
    stdin = '',
    libraryNames = null,
    onFacility = null,
    facilityNames = null,
    onCall = null,
    onLog = null,
    onError = null,
} = {}) {
    const source = typeof code === 'string' ? code : '';
    if (!source.trim()) {
        throw new CodeModeError('The program is empty.', { reason: 'no-code' });
    }

    const catalogue = (Array.isArray(tools) ? tools : [])
        .map((item) => (typeof item === 'string'
            ? { name: item.trim(), description: '', parameters: null }
            : {
                name: String(item?.name ?? '').trim(),
                description: String(item?.description ?? ''),
                parameters: item?.parameters && typeof item.parameters === 'object' ? item.parameters : null,
            }))
        .filter((item) => item.name);

    const ramdisk = createRamdiskFileSystem({ capacityBytes: ramdiskBytes });
    const cache = createSharedByteCache({
        capacityBytes: cacheBytes,
        shared: shared instanceof SharedArrayBuffer ? shared : null,
    });
    // The bridge to the libraries of the house. It lives on this side of the border, and
    // it keeps the native handles there: the program holds opaque ids, not objects.
    const bridge = createLibraryBridge({
        libraries: libraryNames,
        facilities: facilityNames,
        onFacility: async (path, args) => {
            if (typeof onFacility !== 'function') {
                throw new Error(`There is no facility named ${path}.`);
            }
            return await onFacility(path, args);
        },
    });

    /** @type {Array<{ name: string, arguments: object }>} */
    const calls = [];
    /** @type {string[]} */
    const logs = [];
    /** @type {string[]} */
    const errors = [];
    let closed = false;

    /**
     * Cut the output to the limit.
     * @param {string} value
     * @returns {string}
     */
    const cut = (value) => {
        const text = String(value ?? '');
        return text.length > outputBytes ? `${text.slice(0, outputBytes)}…` : text;
    };

    /**
     * One line of the output of the program.
     * @param {string} value
     * @returns {void}
     */
    const out = (value) => {
        if (closed) return;
        const line = cut(value);
        logs.push(line);
        onLog?.(line);
    };

    /**
     * One line of the error output of the program.
     * @param {string} value
     * @returns {void}
     */
    const err = (value) => {
        if (closed) return;
        const line = cut(value);
        errors.push(line);
        onError?.(line);
    };

    /**
     * The call of a tool: it travels to the parent, and the parent runs it.
     *
     * The answer travels back as JSON: the realm of the program never sees an object of
     * the host.
     *
     * @param {string} name the name of the tool
     * @param {string} argsJson the arguments of the call, as JSON
     * @returns {Promise<string>} the envelope of the answer, as JSON
     */
    const call = async (name, argsJson) => {
        if (closed) {
            return JSON.stringify({ ok: false, error: 'The sandbox is closed.' });
        }
        if (calls.length >= CODE_MODE_LIMITS.maxCalls) {
            return JSON.stringify({
                ok: false,
                error: `The program made more than ${CODE_MODE_LIMITS.maxCalls} calls of the tools.`,
            });
        }
        let args = {};
        try {
            args = JSON.parse(String(argsJson ?? '{}')) ?? {};
        } catch {
            args = {};
        }
        const tool = String(name ?? '');
        calls.push({ name: tool, arguments: args });
        try {
            const answer = await onCall?.({ name: tool, arguments: args });
            return JSON.stringify({ ok: true, value: answer ?? null });
        } catch (cause) {
            return JSON.stringify({
                ok: false,
                error: `The tool ${tool} failed: ${cause?.message ?? String(cause)}`,
            });
        }
    };

    const host = {
        catalogue: JSON.stringify(catalogue),
        log: out,
        out,
        err,
        in: () => String(stdin ?? '').slice(0, CODE_MODE_LIMITS.stdinBytes),
        maxBytes: () => String(CODE_MODE_LIMITS.maxBytes),
        call,
        fsRead: async (target) => Buffer.from(await ramdisk.readFile(target)).toString('base64'),
        fsWrite: async (target, b64) => {
            await ramdisk.writeFile(target, new Uint8Array(Buffer.from(String(b64), 'base64')));
        },
        fsReaddir: async (target) => JSON.stringify(await ramdisk.readdir(target)),
        fsStat: async (target) => JSON.stringify(await ramdisk.stat(target)),
        fsLstat: async (target) => JSON.stringify(await ramdisk.lstat(target)),
        fsRealpath: async (target) => String(await ramdisk.realpath(target)),
        fsUnlink: async (target) => { await ramdisk.unlink(target); },
        fsMkdir: async (target, recursive) => { await ramdisk.mkdir(target, { recursive: recursive === true }); },
        fsRename: async (from, to) => { await ramdisk.rename(from, to); },
        fsCopy: async (from, to, recursive, force) => {
            await ramdisk.copy(from, to, { recursive: recursive !== false, force: force === true });
        },
        fsUsed: async () => String(ramdisk.used()),
        // The buffer of the house: the realm makes its own view over it.
        sharedBuffer: () => cache.buffer,
        // The data of the block starts after the word that holds its length.
        sharedOffset: () => String(SHARED_HEADER_BYTES),
        sharedLength: () => String(cache.view().byteLength),
        sharedCapacity: async () => String(cache.capacityBytes),
        sharedSize: async () => String(cache.size()),
        sharedRead: async (offset, length) => {
            const view = cache.view();
            const from = Math.max(0, offset);
            const to = Math.max(from, Math.min(view.byteLength, offset + Math.max(0, length)));
            return Buffer.from(view.subarray(from, to)).toString('base64');
        },
        sharedWrite: async (offset, b64) => {
            const data = new Uint8Array(Buffer.from(String(b64), 'base64'));
            const view = cache.view();
            if (offset < 0 || offset + data.byteLength > view.byteLength) {
                throw new Error(`The bytes do not fit the shared block: ${offset} + ${data.byteLength}.`);
            }
            view.set(data, offset);
        },
        sharedRelease: async () => { cache.release(); },
        sharedAvailable: async (count) => String(cache.available(count)),
        // The libraries of the house: the catalogue and the calls. The bridge keeps the
        // native handles on this side of the border.
        libraryCatalog: async () => JSON.stringify(await bridge.catalog()),
        libraryCall: async (path, argsJson) => bridge.call(path, argsJson),
    };

    // The realm of the sandbox: it has no `process`, no `require`, no `Buffer` and no
    // `fetch` — only what the parent gave it.
    const context = vm.createContext(Object.create(null), {
        name: 'code-mode',
        codeGeneration: { strings: false, wasm: false },
    });

    // The globals of the realm are installed first: the program must find `tools` in its
    // scope. The script lives in the closure of the realm, and the host lives in the
    // closure of the script.
    const install = vm.runInContext(REALM_SCRIPT, context, { filename: 'code-mode:realm.js' });
    install(host);

    // The program is the body of an async function of the realm: it may `await`, and it
    // may `return` the answer of the step.
    let script;
    try {
        script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: 'code-mode:program.js' });
    } catch (error) {
        throw new CodeModeError(
            `The program is not valid: ${error?.message ?? String(error)}`,
            { reason: 'syntax', stack: error?.stack ?? null },
        );
    }

    let value = null;
    try {
        value = await script.runInContext(context, { timeout: timeoutMs });
    } catch (error) {
        closed = true;
        const reason = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'failed';
        throw new CodeModeError(
            reason === 'timeout'
                ? `The program did not finish in ${timeoutMs} ms.`
                : `The program failed: ${error?.message ?? String(error)}`,
            { reason, code: error?.code ?? null, stack: error?.stack ?? null },
        );
    }
    closed = true;

    return {
        ok: true,
        value: value ?? null,
        output: logs.join('\n'),
        error: errors.join('\n'),
        reason: 'completed',
        calls,
    };
}

/**
 * The entry of the sandbox: the worker that runs the program of the model.
 *
 * The spec comes with the thread. The worker runs the program, sends the calls of the
 * tools back to the parent, and answers with the report of the run.
 *
 * @param {{ data?: object|null, port?: object|null }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function codeModeMain({ data = null, port = null } = {}) {
    const payload = data ?? workerData ?? null;
    const spec = createCodeModeSpec(payload?.spec ?? payload ?? {});
    const channel = port ?? parentPort;
    if (!channel) throw new CodeModeError('The sandbox was started with no channel.', { reason: 'no-channel' });

    const pending = new Map();
    let counter = 0;
    let closed = false;

    /**
     * The call of a tool: it travels to the parent, and the parent runs it.
     *
     * A tool that failed is a failure of the call, not a value: the error travels with
     * the answer, and the program catches it like any other error.
     *
     * @param {{ name?: string, arguments?: object }} call
     * @returns {Promise<unknown>}
     */
    const onCall = async (call) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        channel.postMessage(createFrame('call', {
            id,
            name: call?.name,
            arguments: call?.arguments ?? {},
        }));
        const envelope = await answer;
        if (envelope?.error) throw new Error(String(envelope.error));
        return envelope?.value ?? null;
    };

    /**
     * The answer of the parent to a call of a tool.
     * @param {object} frame
     * @returns {void}
     */
    const onMessage = (frame) => {
        if (!isFrame(frame) || frame.type !== 'result') return;
        const key = String(frame.id ?? '');
        const resolve = pending.get(key);
        if (!resolve) return;
        pending.delete(key);
        resolve({ value: frame.output ?? null, error: frame.error ?? null });
    };
    channel.on('message', onMessage);

    /**
     * The line of the output of the program.
     * @param {string} line
     * @returns {void}
     */
    const onLog = (line) => {
        if (closed) return;
        channel.postMessage(createFrame('log', { line }));
    };

    /**
     * The line of the error output of the program.
     * @param {string} line
     * @returns {void}
     */
    const onError = (line) => {
        if (closed) return;
        channel.postMessage(createFrame('log', { line, stream: 'stderr' }));
    };

    /**
     * The call of a facility of the host: it travels to the parent, the same way a tool
     * call does, and the parent runs it.
     *
     * The facility cannot be run here: the worker is a thread of its own, and the function
     * behind the facility lives in the parent — the client of the pictures is there.
     *
     * @param {string} path the path of the call
     * @param {object} args the arguments of the call
     * @returns {Promise<unknown>}
     */
    const askFacility = async (path, args) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        channel.postMessage(createFrame('call', {
            id,
            name: path,
            arguments: args ?? {},
            facility: true,
        }));
        const envelope = await answer;
        if (envelope?.error) throw new Error(String(envelope.error));
        // The answer of the parent travels as JSON: it is read back here, so the bridge
        // gets the data of the answer and not the text of it.
        const raw = envelope?.value ?? null;
        if (typeof raw !== 'string') return raw;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    };

    let report;
    try {
        report = await runCodeMode({
            code: spec.code,
            tools: spec.tools,
            shared: spec.shared,
            allowAllocate: spec.allowAllocate,
            ramdiskBytes: spec.ramdiskBytes,
            cacheBytes: spec.cacheBytes,
            timeoutMs: spec.timeoutMs,
            outputBytes: spec.outputBytes,
            stdin: spec.stdin,
            libraryNames: spec.libraries,
            facilityNames: spec.facilities,
            // The facility of the host: the function behind it lives in the parent, so the
            // call travels back there over the frame protocol.
            onFacility: askFacility,
            onCall,
            onLog,
            onError,
        });
    } catch (error) {
        report = {
            ok: false,
            value: null,
            output: '',
            error: error?.message ?? String(error),
            reason: error?.reason ?? 'failed',
            calls: [],
        };
    }
    closed = true;
    channel.off?.('message', onMessage);
    channel.postMessage(createFrame('report', { report }));
    return report;
}

/**
 * Start the sandbox of Code Mode and give back one channel.
 *
 * The sandbox is a thread of the parent: it has the shared memory of the house, and the
 * program inside it can be stopped without touching the parent.
 *
 * The stdio of the sandbox is real: `stdin` is a writable stream the parent writes into,
 * and `stdout` and `stderr` are the streams of the worker.
 *
 * @param {{ spec?: object, env?: object, cwd?: string, entry?: string }} [options]
 * @returns {{ post: Function, postBytes: Function, on: Function, off: Function, stop: Function,
 *   alive: Function, pid: number|null, stdin: object|null, stdout: object|null, stderr: object|null }}
 * @exports
 * @ai.hint io
 */
export function startCodeModeWorker({ spec = null, env = null, cwd = null, entry = null } = {}) {
    const file = entry ?? codeModeEntry();
    const worker = new Worker(file, {
        workerData: { spec },
        env: env ?? process.env,
        cwd: cwd ?? undefined,
        stdout: true,
        stderr: true,
        stdin: true,
    });
    return {
        post: (frame) => worker.postMessage(frame),
        postBytes: (frame, transfer = []) => worker.postMessage(frame, transfer),
        on: (kind, fn) => worker.on(kind, fn),
        off: (kind, fn) => worker.off?.(kind, fn),
        stop: () => { worker.terminate?.(); },
        alive: () => true,
        pid: worker.threadId ?? null,
        stdin: worker.stdin ?? null,
        stdout: worker.stdout ?? null,
        stderr: worker.stderr ?? null,
    };
}

/**
 * Run one program of Code Mode in the sandbox, and wait for its report.
 *
 * This is the side of the parent: the program runs in the worker, every call of a tool
 * travels back here, and `onCall` runs it with the rights of the parent.
 *
 * A program that does not finish in its time is stopped: the worker is terminated, and the
 * run ends with the reason `timeout`.
 *
 * @param {{ spec?: object, onCall?: Function|null, onFacility?: Function|null,
 *   onEvent?: Function|null, signal?: AbortSignal|null, entry?: string, env?: object,
 *   cwd?: string }} request
 * @returns {Promise<{ ok: boolean, value: unknown, output: string, error: string|null,
 *   reason: string, calls: Array<{ name: string, arguments: object }> }>}
 * @exports
 * @ai.hint io
 */
export async function runCodeModeWorker({
    spec: rawSpec = null,
    onCall = null,
    onFacility = null,
    onEvent = null,
    signal = null,
    entry = null,
    env = null,
    cwd = null,
} = {}) {
    const spec = createCodeModeSpec(rawSpec ?? {});
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const worker = startCodeModeWorker({ spec, env, cwd, entry });

    return await new Promise((resolve) => {
        let settled = false;
        let timer = null;

        /**
         * The end of the run: the report of the program, or the reason it ended.
         * @param {object} report
         * @returns {void}
         */
        const finish = (report) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            worker.stop();
            resolve(report);
        };

        /**
         * The stop of the run: the worker is terminated, and the report says so.
         * @returns {void}
         */
        const onAbort = () => {
            finish({
                ok: false,
                value: null,
                output: '',
                error: 'The sandbox was stopped before it answered.',
                reason: 'aborted',
                calls: [],
            });
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        // The time of the program: the parent counts it, and the worker is the thing that
        // gets stopped. A program that never yields cannot be stopped from the inside.
        timer = setTimeout(() => {
            finish({
                ok: false,
                value: null,
                output: '',
                error: `The program did not finish in ${spec.timeoutMs} ms.`,
                reason: 'timeout',
                calls: [],
            });
        }, spec.timeoutMs);
        timer.unref?.();

        worker.on('message', async (frame) => {
            if (!isFrame(frame)) return;
            if (frame.type === 'call') {
                // The call of a tool of the program, or of a facility of the host: the
                // parent runs it either way.
                let output = '';
                let failure = null;
                try {
                    const name = String(frame.name ?? '');
                    const args = frame.arguments ?? {};
                    const answer = frame.facility === true
                        ? await onFacility?.(name, args)
                        : await onCall?.({ name, arguments: args });
                    // The answer of a tool is the text of the tool: the realm reads it as
                    // it is. The answer of a facility is data, and it travels as JSON.
                    output = frame.facility === true
                        ? JSON.stringify(answer ?? null)
                        : String(answer ?? '');
                } catch (error) {
                    // A tool that failed is a failure of the call: the program catches it.
                    failure = error?.message ?? String(error);
                    output = '';
                }
                worker.post(createFrame('result', { id: frame.id, output, error: failure }));
                return;
            }
            if (frame.type === 'log') {
                emit({ type: 'code.log', line: String(frame.line ?? ''), stream: frame.stream ?? 'stdout' });
                return;
            }
            if (frame.type === 'report') {
                finish(frame.report ?? {
                    ok: false,
                    value: null,
                    output: '',
                    error: 'No report.',
                    reason: 'no-report',
                    calls: [],
                });
            }
        });

        worker.on('error', (error) => {
            finish({
                ok: false,
                value: null,
                output: '',
                error: `The sandbox died: ${error?.message ?? String(error)}`,
                reason: 'failed',
                calls: [],
            });
        });

        worker.on('exit', () => {
            finish({
                ok: false,
                value: null,
                output: '',
                error: 'The sandbox ended without a report.',
                reason: 'no-report',
                calls: [],
            });
        });
    });
}
