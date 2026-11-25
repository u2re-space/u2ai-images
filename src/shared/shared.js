/**
 * @file src/shared/shared.js
 * @module shared/shared
 * @purpose Shared memory between the parent and the thread of a worker.
 *
 *   The instructions of a role are the biggest text of a hand-over: the brief of the
 *   architect, the packs of the skills, the contracts — tens of kilobytes that the parent
 *   built and the worker has to read. A structured clone copies them into the thread a
 *   second time. Shared memory does not: the parent writes the text into one buffer, the
 *   thread reads it from there, and there is exactly one copy in the memory.
 *
 *   The text travels as UTF-8: `TextEncoder` writes it into the buffer, `TextDecoder`
 *   reads it back. Strings never cross the border as strings.
 *
 *   The buffer also holds the flag of cancellation: the parent sets it with an atomic
 *   store, and the thread sees it without a message round trip — a worker that was
 *   stopped winds down and still reports what it did.
 *
 *   Shared memory crosses threads, not processes: the transport `process` carries the
 *   strings inside the spec, and this module is not used there.
 *
 * @depends none
 * @usedBy client/interface, server/interface
 * @exports SHARED_MAGIC, SHARED_VERSION, SHARED_REGIONS, FLAG_CANCEL, sharedAvailable,
 *          createSharedBlock, readSharedBlock
 * @ai.tags house, shared-memory, threads
 * @ai.hint io
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** The mark of a shared block of the worker. */
export const SHARED_MAGIC = 0x53484231; // 'SHB1'

/** The version of the layout of a shared block. */
export const SHARED_VERSION = 1;

/**
 * The named regions of a shared block, in the order they lie in it.
 *
 * `instructions` — the instructions of the role the worker inherits. `notes` — the
 * notes of the context the parent shares. Both are the big texts of a hand-over.
 */
export const SHARED_REGIONS = Object.freeze(['instructions', 'notes']);

/** The parent asks the worker to stop after the current turn. */
export const FLAG_CANCEL = 1;

/** The index of the flag word inside the header. */
const FLAG_WORD = 2;

/** The words of the header before the table of the regions. */
const HEADER_WORDS = 4;
const BYTES_PER_WORD = 4;

/**
 * Is shared memory available in this runtime?
 *
 * In Node with worker threads it always is; the check keeps the fallback honest for a
 * runtime where it is not.
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function sharedAvailable() {
    try {
        new SharedArrayBuffer(8);
        return true;
    } catch {
        return false;
    }
}

/**
 * Create a shared block out of the texts of a hand-over.
 *
 * Every named region holds the UTF-8 bytes of its text. An absent text is an empty
 * region: the layout does not change with what the parent wrote.
 *
 * @param {{ instructions?: string, notes?: string }} [strings] the texts by region
 * @returns {{ buffer: SharedArrayBuffer, regions: string[] }}
 * @exports
 * @ai.hint io
 */
export function createSharedBlock(strings = {}) {
    if (!sharedAvailable()) {
        throw new Error('SharedArrayBuffer is not available in this runtime.');
    }
    const texts = SHARED_REGIONS.map((name) => (typeof strings?.[name] === 'string' ? strings[name] : ''));
    const encoded = texts.map((text) => (text ? ENCODER.encode(text) : null));

    const headerWords = HEADER_WORDS + SHARED_REGIONS.length * 2;
    const headerBytes = headerWords * BYTES_PER_WORD;
    let cursor = headerBytes;
    const offsets = encoded.map((bytes) => {
        const offset = cursor;
        cursor += bytes ? bytes.length : 0;
        return offset;
    });

    // The words of the header are read as Int32: the buffer must be a multiple of 4 bytes.
    const total = Math.ceil(cursor / BYTES_PER_WORD) * BYTES_PER_WORD;
    const buffer = new SharedArrayBuffer(total);
    const words = new Int32Array(buffer);
    words[0] = SHARED_MAGIC;
    words[1] = SHARED_VERSION;
    words[FLAG_WORD] = 0;
    words[3] = SHARED_REGIONS.length;
    SHARED_REGIONS.forEach((name, index) => {
        words[HEADER_WORDS + index * 2] = offsets[index];
        words[HEADER_WORDS + index * 2 + 1] = encoded[index]?.length ?? 0;
    });
    encoded.forEach((bytes, index) => {
        if (!bytes?.length) return;
        new Uint8Array(buffer, offsets[index], bytes.length).set(bytes);
    });
    return { buffer, regions: [...SHARED_REGIONS] };
}

/**
 * Read a shared block that the parent wrote.
 *
 * The text of a region is decoded on every read: a thread that reads the instructions
 * twice decodes them twice, and the bytes stay where they are.
 *
 * @param {SharedArrayBuffer} buffer the buffer the parent gave the thread
 * @returns {{ text: Function, cancelled: Function, cancel: Function, regions: string[] }}
 * @exports
 * @ai.hint pure
 */
export function readSharedBlock(buffer) {
    if (!(buffer instanceof SharedArrayBuffer)) {
        throw new Error('The shared block of a worker is not a SharedArrayBuffer.');
    }
    const words = new Int32Array(buffer);
    if (words[0] !== SHARED_MAGIC) throw new Error('The shared block of a worker has a wrong mark.');
    if (words[1] !== SHARED_VERSION) throw new Error('The shared block of a worker has a wrong version.');
    const count = words[3];
    if (count !== SHARED_REGIONS.length) throw new Error('The shared block of a worker has a wrong layout.');

    const table = SHARED_REGIONS.map((name, index) => ({
        name,
        offset: words[HEADER_WORDS + index * 2],
        length: words[HEADER_WORDS + index * 2 + 1],
    }));

    return {
        regions: [...SHARED_REGIONS],
        /**
         * The text of one region.
         * @param {string} name the name of the region
         * @returns {string}
         */
        text(name) {
            const region = table.find((item) => item.name === String(name ?? '').trim());
            if (!region || !region.length) return '';
            return DECODER.decode(new Uint8Array(buffer, region.offset, region.length));
        },
        /**
         * Did the parent ask the worker to stop?
         * @returns {boolean}
         */
        cancelled() {
            return Atomics.load(words, FLAG_WORD) === FLAG_CANCEL;
        },
        /**
         * Ask the worker to stop after the current turn.
         * @returns {void}
         */
        cancel() {
            Atomics.store(words, FLAG_WORD, FLAG_CANCEL);
        },
    };
}
