/**
 * @file src/shared/protocol.js
 * @module shared/protocol
 * @purpose The wire contract between a parent and a worker, and the shapes the data
 *          travels in.
 *
 *   A worker is a separate thread of the parent: the parent gives it a **spec** (the role
 *   it inherits, the goal, the files it may touch, the tools it may call, the budget of
 *   turns) and the worker answers with a **report** (what it did, which files are on the
 *   disk, whether the goal is reached).
 *
 *   Everything in between travels as frames: `spawn` goes down, `ready`/`status`/`log`/
 *   `file`/`error` come up, `report` closes the thread. The frames carry a protocol
 *   version, so an old parent refuses a new worker instead of guessing.
 *
 *   The worker carries no role of its own: the role, the rights and the tools come in
 *   the spec and belong to the parent. The worker only runs them.
 *
 *   The pictures travel as bytes or as base64, and never as a path: a frame of kind
 *   `bytes` carries a `Uint8Array` in its own buffer, and a frame of kind `base64`
 *   carries the same bytes as text — for the transport that cannot move a buffer.
 *
 * @depends none
 * @usedBy client/interface, server/interface
 * @exports PROTOCOL_VERSION, SPEC_VERSION, FRAME, createFrame, isFrame, bytesFrame,
 *          base64Frame, bytesOfFrame, base64Of, base64Bytes, bytesOf
 * @ai.tags house, protocol, ipc, bytes
 * @ai.hint pure
 */

/** The version of the protocol between a parent and a worker. */
export const PROTOCOL_VERSION = 1;

/** The version of the spec of a worker. */
export const SPEC_VERSION = 1;

/** The kinds of frame of the protocol. */
export const FRAME = Object.freeze({
    spawn: 'spawn',
    ready: 'ready',
    status: 'status',
    log: 'log',
    file: 'file',
    call: 'call',
    result: 'result',
    report: 'report',
    error: 'error',
    stop: 'stop',
    /** The bytes of a picture: a buffer that travels without a copy. */
    bytes: 'bytes',
    /** The bytes of a picture as text: for the transport that cannot move a buffer. */
    base64: 'base64',
});

/**
 * Create one frame of the protocol.
 * @param {string} type the kind of the frame
 * @param {object} [payload] the fields of the frame
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createFrame(type, payload = {}) {
    const kind = String(type ?? '').trim();
    if (!Object.hasOwn(FRAME, kind)) throw new Error(`Unknown frame: ${kind || '(empty)'}.`);
    return { v: PROTOCOL_VERSION, type: kind, ...payload };
}

/**
 * Whether a value is a frame of this protocol version.
 * @param {unknown} value
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isFrame(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Number(value.v) === PROTOCOL_VERSION
        && typeof value.type === 'string'
        && Object.hasOwn(FRAME, value.type);
}

/**
 * The bytes of a value: a buffer, an array of bytes, an `ArrayBuffer`, a shared buffer
 * or a base64 string.
 *
 * A `Buffer` of the pool of Node.js is copied: its `ArrayBuffer` belongs to the pool and
 * may not be transferred.
 *
 * @param {unknown} value
 * @returns {Uint8Array|null} the bytes, or null when there are none
 * @exports
 * @ai.hint pure
 */
export function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof SharedArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return base64Bytes(value);
    if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item) || 0));
    return null;
}

/**
 * The bytes of a base64 text.
 *
 * The text is decoded, not taken as it is: a base64 string is a way of writing bytes, and
 * the bytes are what it means.
 *
 * @param {string} text
 * @returns {Uint8Array}
 * @exports
 * @ai.hint pure
 */
export function base64Bytes(text) {
    const raw = String(text ?? '');
    if (!raw) return new Uint8Array(0);
    try {
        return new Uint8Array(Buffer.from(raw, 'base64'));
    } catch {
        return new Uint8Array(0);
    }
}

/**
 * The bytes of a value as base64.
 *
 * @param {unknown} value
 * @returns {string} the base64 text, or an empty string when there are no bytes
 * @exports
 * @ai.hint pure
 */
export function base64Of(value) {
    if (typeof value === 'string') return value;
    const bytes = bytesOf(value);
    if (!bytes) return '';
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * A frame that carries bytes.
 *
 * The bytes get their own buffer: a `Buffer` of the pool of Node.js cannot be
 * transferred, and a transferred buffer must own its `ArrayBuffer`.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} payload the bytes
 * @param {{ name?: string, mime?: string }} [meta] what the bytes are
 * @returns {{ frame: object, transfer: ArrayBuffer[] }} the frame and its transfer list
 * @exports
 * @ai.hint pure
 */
export function bytesFrame(payload, meta = {}) {
    const bytes = bytesOf(payload);
    if (!bytes) throw new Error('The frame needs bytes.');
    const own = Uint8Array.from(bytes);
    return {
        frame: createFrame('bytes', {
            ...meta,
            bytes: own,
            length: own.byteLength,
        }),
        transfer: [own.buffer],
    };
}

/**
 * A frame that carries bytes as base64.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer|string} payload the bytes
 * @param {{ name?: string, mime?: string }} [meta] what the bytes are
 * @returns {object} the frame
 * @exports
 * @ai.hint pure
 */
export function base64Frame(payload, meta = {}) {
    const bytes = bytesOf(payload);
    if (!bytes) throw new Error('The frame needs bytes.');
    return createFrame('base64', {
        ...meta,
        data: base64Of(bytes),
        length: bytes.byteLength,
    });
}

/**
 * The bytes of a frame: the bytes of a `bytes` frame, or the decoded text of a
 * `base64` frame.
 *
 * @param {unknown} frame the frame
 * @returns {Uint8Array|null} the bytes, or null when the frame carries none
 * @exports
 * @ai.hint pure
 */
export function bytesOfFrame(frame) {
    if (!isFrame(frame)) return null;
    if (frame.type === 'bytes') return bytesOf(frame.bytes);
    if (frame.type === 'base64') return base64Bytes(String(frame.data ?? ''));
    return null;
}
