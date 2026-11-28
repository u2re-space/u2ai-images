/**
 * @file src/openai/parser-sandbox.js
 * @module openai/parser-sandbox
 * @purpose The sandbox of the salvage script: a realm of `node:vm` inside a worker thread.
 *
 *   The salvage script is written by a model that saw a strange answer of a picture API. It
 *   walks that answer and hands back the payloads. It is code, and code from a model is
 *   code from the internet as far as the machine is concerned.
 *
 *   The old sandbox was a realm of `node:vm` in the **parent's own thread**, and it was
 *   wide open. Every object it held was a door out:
 *
 *   ```js
 *   response.constructor.constructor('return typeof process')()   // → 'object'
 *   ```
 *
 *   `response`, `Buffer`, `TextEncoder`, `URL`, `atob`, `fetch`, `write` — every one of them
 *   was a constructor whose constructor compiled a string, and a compiled string reaches
 *   the process. The `timeout` of the realm did not help either: it stops a synchronous
 *   loop, but a loop that never yields — `for(;;){ await Promise.resolve(); }` — hung the
 *   whole run, and a script that awaited for ever did the same.
 *
 *   This sandbox is built on the same principles as Code Mode, because the same rules
 *   apply to the same thing:
 *
 *   - **No host object is ever a property of the context.** The answer crosses as JSON,
 *     and the helpers are facades that return primitives. The facades live in the closure
 *     of the install script, where the script cannot see them.
 *   - **`codeGeneration` is off.** No `eval`, no `new Function`, and no way back through
 *     the constructor of a constructor.
 *   - **The script runs in a worker thread.** A loop that never yields is stopped by
 *     `terminate()`, and the run of the picture lives.
 *
 *   The script may still do what it was written for: pull a link the answer only mentions,
 *   decode inline base64, and drop the result where the caller can find it. On top of that
 *   it may reach the libraries of the house and the memory of the house, through the same
 *   facade as Code Mode.
 *
 * @depends node:vm, node:worker_threads, node:path, node:url, shared/code-mode,
 *          shared/code-libraries, access/ramdisk
 * @usedBy openai/parser
 * @exports PARSER_SANDBOX_VERSION, PARSER_SANDBOX_LIMITS, ParserSandboxError,
 *          createParserSandboxSpec, runParserSandbox, parserSandboxEntry
 * @ai.tags images, fallback, sandbox, vm, worker
 * @ai.hint io
 */

import { Worker, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrame, isFrame } from '../shared/protocol.js';
import { createLibraryBridge } from '../shared/code-libraries.js';
import { createRamdiskFileSystem, createSharedByteCache } from '../access/ramdisk.js';
import { sniffImage } from './images.js';

/** The version of the contract of the sandbox of the parser. */
export const PARSER_SANDBOX_VERSION = 1;

/** The limits of the sandbox of the parser. */
export const PARSER_SANDBOX_LIMITS = Object.freeze({
    /** Wall-clock cap for one salvage script, including its awaits. */
    timeoutMs: 60_000,
    /** Bytes one `fetch` inside the script may return. */
    fetchMaxBytes: 64 * 1024 * 1024,
    /** Payloads accepted from one script; a larger list is a runaway loop, not a batch. */
    maxPayloads: 32,
    /** How much of the script's own log is kept for the record. */
    logMaxLines: 40,
    /** The biggest answer that crosses into the realm, in bytes. */
    answerMaxBytes: 8 * 1024 * 1024,
});

/**
 * The error of the sandbox of the parser.
 */
export class ParserSandboxError extends Error {
    /**
     * @param {string} message what happened
     * @param {{ reason?: string, code?: string|null }} [details]
     */
    constructor(message, { reason = 'failed', code = null } = {}) {
        super(message);
        this.name = 'ParserSandboxError';
        this.reason = reason;
        this.code = code;
    }
}

/**
 * The entry of the sandbox of the parser.
 *
 * @param {string} [name] the name of the file of the sandbox
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function parserSandboxEntry(name = 'ai-image-parser-worker.js') {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'bin',
        name,
    );
}

/**
 * The spec of one run of the salvage script.
 *
 * @param {{ script?: string, response?: unknown, root?: string, timeoutMs?: number,
 *   libraries?: string[]|null, facilities?: string[]|null }} [raw]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createParserSandboxSpec(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const timeoutMs = Number.isSafeInteger(source.timeoutMs) && source.timeoutMs > 0
        ? source.timeoutMs
        : PARSER_SANDBOX_LIMITS.timeoutMs;
    return {
        version: PARSER_SANDBOX_VERSION,
        script: typeof source.script === 'string' ? source.script : '',
        // The answer crosses as JSON: the realm never sees an object of the host.
        response: JSON.stringify(source.response ?? null),
        root: typeof source.root === 'string' ? source.root : process.cwd(),
        timeoutMs,
        libraries: Array.isArray(source.libraries)
            ? source.libraries.map((item) => String(item ?? '').trim()).filter(Boolean)
            : null,
        facilities: Array.isArray(source.facilities)
            ? source.facilities.map((item) => String(item ?? '').trim()).filter(Boolean)
            : [],
    };
}

/**
 * The install script of the realm of the parser.
 *
 * Every facade it installs returns a primitive: a string, a number, an array of numbers.
 * The answer of the host crosses as JSON, and the script parses it — it is data, not an
 * object of the host.
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
        const raw = String(text ?? '').replace(/^data:[^,]*,/, '').replace(/\\s+/g, '');
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

    const line = (...args) => host.log(args.map(text).join(' '));

    globalThis.console = Object.freeze({
        log: line, info: line, debug: line, warn: line, error: line,
    });
    globalThis.stdout = Object.freeze({ write: (value) => host.out(text(value)) });
    globalThis.stderr = Object.freeze({ write: (value) => host.err(text(value)) });

    // The answer of the picture API: data, and not an object of the host.
    globalThis.response = host.response();
    globalThis.decodeBase64 = (value) => fromBase64(value);
    globalThis.encodeBase64 = (bytes) => toBase64(Uint8Array.from(bytes ?? []));
    globalThis.imageDataUrl = (bytes, mime) => 'data:' + (mime || 'image/png') + ';base64,' + toBase64(
        typeof bytes === 'string' ? fromBase64(bytes) : Uint8Array.from(bytes ?? []),
    );
    globalThis.sniff = (bytes) => host.sniff(Array.from(bytes ?? []));
    globalThis.write = (rel, data) => host.write(String(rel ?? ''), data);
    globalThis.log = line;
    globalThis.fetchBytes = (url) => host.fetchBytes(String(url ?? ''));
    globalThis.fetch = (url, init) => host.fetch(String(url ?? ''), init);

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

    // The file system in the memory: the same shape as the file system of the access.
    globalThis.fs = Object.freeze({
        readFile: async (target) => fromBase64(await host.fsRead(String(target ?? ''))),
        writeFile: async (target, bytes) => {
            await host.fsWrite(String(target ?? ''), toBase64(Uint8Array.from(bytes ?? [])));
        },
        readdir: async (target) => JSON.parse(await host.fsReaddir(String(target ?? ''))),
        stat: async (target) => JSON.parse(await host.fsStat(String(target ?? ''))),
        unlink: async (target) => { await host.fsUnlink(String(target ?? '')); },
        mkdir: async (target) => { await host.fsMkdir(String(target ?? '')); },
    });

    // The shared block of the run: one memory with the parent.
    const view = host.sharedBuffer() ? new Uint8Array(host.sharedBuffer()) : null;
    const ints = view ? new Int32Array(host.sharedBuffer()) : null;
    if (view) {
        Object.defineProperty(view, 'buffer', { value: undefined, enumerable: false, configurable: false });
        Object.defineProperty(ints, 'buffer', { value: undefined, enumerable: false, configurable: false });
    }
    globalThis.shared = Object.freeze({
        view,
        ints,
        capacity: () => (view ? view.byteLength : 0),
    });

    // The libraries of the house, through the same facade as Code Mode.
    globalThis.library = Object.freeze({
        catalog: async () => JSON.parse(await host.libraryCatalog()),
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
            return answer.value ?? null;
        },
        bytes: (b64) => fromBase64(String(b64 ?? '')),
        base64: (bytes) => toBase64(Uint8Array.from(bytes ?? [])),
    });
})`;

/**
 * Run one salvage script in the sandbox.
 *
 * This is the worker side: the realm lives here, in the thread of the sandbox, and the
 * answer crosses as JSON.
 *
 * @param {{ script?: string, response?: unknown, root?: string, timeoutMs?: number,
 *   libraries?: string[]|null, onLog?: Function|null, onError?: Function|null,
 *   onWrite?: Function|null, onFetch?: Function|null }} options
 * @returns {Promise<{ sources: object[], writes: string[], logs: string[], value: unknown }>}
 * @exports
 * @ai.hint io
 */
export async function runParserSandbox({
    script = '',
    response = null,
    root = process.cwd(),
    timeoutMs = PARSER_SANDBOX_LIMITS.timeoutMs,
    libraries = null,
    onLog = null,
    onError = null,
    onWrite = null,
    onFetch = null,
} = {}) {
    const source = String(script ?? '');
    if (!source.trim()) {
        throw new ParserSandboxError('The salvage script is empty.', { reason: 'no-script' });
    }

    const logs = [];
    const writes = [];
    const ramdisk = createRamdiskFileSystem({});
    const cache = createSharedByteCache({ capacityBytes: 64 * 1024 * 1024 });

    /**
     * Cut a line of the log to the limit.
     * @param {string} value
     * @returns {string}
     */
    const cut = (value) => {
        const text = String(value ?? '');
        return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    };

    const bridge = createLibraryBridge({ libraries });

    const host = {
        // The answer crosses as JSON: the realm gets data, not an object of the host.
        response: () => JSON.stringify(response ?? null),
        log: (value) => {
            if (logs.length >= PARSER_SANDBOX_LIMITS.logMaxLines) return;
            const line = cut(value);
            logs.push(line);
            onLog?.(line);
        },
        out: (value) => {
            if (logs.length >= PARSER_SANDBOX_LIMITS.logMaxLines) return;
            const line = cut(value);
            logs.push(line);
            onLog?.(line);
        },
        err: (value) => {
            const line = cut(value);
            onError?.(line);
        },
        sniff: (bytes) => {
            const buffer = Buffer.from(Array.isArray(bytes) ? bytes : []);
            return buffer.length ? sniffImage(buffer).ext : null;
        },
        write: async (rel, data) => {
            const target = String(rel ?? '');
            const written = await onWrite?.(target, data);
            writes.push(target);
            return typeof written === 'string' ? written : target;
        },
        fetchBytes: async (url) => {
            const bytes = await onFetch?.(url);
            if (!bytes) return [];
            return [...Uint8Array.from(bytes)];
        },
        fetch: async (url, init) => {
            const bytes = await onFetch?.(url);
            if (!bytes) throw new Error('The link could not be read.');
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => {
                    const copy = Uint8Array.from(bytes);
                    return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
                },
                text: async () => Buffer.from(bytes).toString('utf8'),
            };
        },
        fsRead: async (target) => {
            const bytes = await ramdisk.readFile(target);
            return Buffer.from(bytes).toString('base64');
        },
        fsWrite: async (target, b64) => {
            await ramdisk.writeFile(target, new Uint8Array(Buffer.from(String(b64), 'base64')));
        },
        fsReaddir: async (target) => JSON.stringify(await ramdisk.readdir(target)),
        fsStat: async (target) => JSON.stringify(await ramdisk.stat(target)),
        fsUnlink: async (target) => { await ramdisk.unlink(target); },
        fsMkdir: async (target) => { await ramdisk.mkdir(target, { recursive: true }); },
        sharedBuffer: () => cache.buffer,
        libraryCatalog: async () => JSON.stringify(await bridge.catalog()),
        libraryCall: async (path, argsJson) => bridge.call(path, argsJson),
    };

    // The realm has no host object in it: the facades live in the closure of the script.
    const context = vm.createContext(Object.create(null), {
        name: 'parser-sandbox',
        codeGeneration: { strings: false, wasm: false },
    });
    const install = vm.runInContext(REALM_SCRIPT, context, { filename: 'parser:realm.js' });
    install(host);

    // The script is the body of an async function: it may await, and it may return the
    // payloads.
    let compiled;
    try {
        compiled = new vm.Script(`(async () => {\n${source}\n})()`, { filename: 'parser:script.js' });
    } catch (error) {
        throw new ParserSandboxError(
            `The salvage script is not valid: ${error?.message ?? String(error)}`,
            { reason: 'syntax' },
        );
    }

    let value = null;
    try {
        value = await compiled.runInContext(context, { timeout: timeoutMs });
    } catch (error) {
        const reason = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'failed';
        throw new ParserSandboxError(
            reason === 'timeout'
                ? `The salvage script did not finish in ${timeoutMs} ms.`
                : `The salvage script failed: ${error?.message ?? String(error)}`,
            { reason, code: error?.code ?? null },
        );
    }

    return { sources: Array.isArray(value) ? value : [value], writes, logs, value, error: null, reason: 'completed' };
}

/**
 * The entry of the sandbox: the worker that runs the salvage script.
 *
 * @param {{ data?: object|null, port?: object|null, onWrite?: Function|null,
 *   onFetch?: Function|null, onLog?: Function|null, onError?: Function|null }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function parserSandboxMain({
    data = null,
    port = null,
    onWrite = null,
    onFetch = null,
    onLog = null,
    onError = null,
} = {}) {
    const payload = data ?? workerData ?? null;
    const given = payload?.spec ?? payload ?? {};
    // The spec arrives already built: the answer in it is a JSON string, and building it
    // again would encode it twice.
    const spec = typeof given.response === 'string'
        ? given
        : createParserSandboxSpec(given);
    const channel = port ?? parentPort;
    if (!channel) {
        throw new ParserSandboxError('The sandbox was started with no channel.', { reason: 'no-channel' });
    }

    const pending = new Map();
    let counter = 0;
    let closed = false;
    /** The refusals of the host: the script may catch them, and the report keeps them. */
    const refusals = [];

    /**
     * A call of the script that needs the host: it travels back to the parent.
     * @param {string} name the name of the call
     * @param {object} args the arguments of the call
     * @returns {Promise<unknown>}
     */
    const ask = async (name, args) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        channel.postMessage(createFrame('call', { id, name, arguments: args ?? {} }));
        const envelope = await answer;
        if (envelope?.error) {
            refusals.push(envelope.error);
            throw new Error(String(envelope.error));
        }
        return envelope?.value ?? null;
    };

    /**
     * The answer of the parent to a call.
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

    let report;
    try {
        report = await runParserSandbox({
            script: spec.script,
            response: JSON.parse(spec.response),
            root: spec.root,
            timeoutMs: spec.timeoutMs,
            libraries: spec.libraries,
            onLog: (line) => {
                if (closed) return;
                channel.postMessage(createFrame('log', { line }));
            },
            onError: (line) => {
                if (closed) return;
                channel.postMessage(createFrame('log', { line, stream: 'stderr' }));
            },
            onWrite: async (rel, data) => await ask('write', { rel, data }),
            onFetch: async (url) => {
                const value = await ask('fetch', { url });
                if (!value) return null;
                const bytes = Buffer.from(String(value), 'base64');
                return bytes.length ? bytes : null;
            },
        });
    } catch (error) {
        report = {
            sources: [],
            writes: [],
            logs: [],
            value: null,
            error: error?.message ?? String(error),
            reason: error?.reason ?? 'failed',
            refusals,
        };
    }
    // The refusals of the host are part of the report: a script that was told «no» must
    // not look like a script that found nothing.
    if (report && Array.isArray(refusals) && refusals.length) {
        report.refusals = refusals;
    }
    closed = true;
    channel.off?.('message', onMessage);
    channel.postMessage(createFrame('report', { report }));
    return report;
}

/**
 * Run one salvage script in the sandbox worker, and wait for its report.
 *
 * This is the side of the parent: the script runs in the worker, every call that needs
 * the host travels back here, and a script that hangs is stopped with `terminate()`.
 *
 * @param {{ spec?: object, onWrite?: Function|null, onFetch?: Function|null,
 *   onLog?: Function|null, onError?: Function|null, signal?: AbortSignal|null,
 *   entry?: string, env?: object }} options
 * @returns {Promise<{ sources: object[], writes: string[], logs: string[], value: unknown,
 *   error: string|null, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function runParserSandboxWorker({
    spec: rawSpec = null,
    onWrite = null,
    onFetch = null,
    onLog = null,
    onError = null,
    signal = null,
    entry = null,
    env = null,
} = {}) {
    // The spec is already a spec: it was built by the caller and it travels as it is.
    // Building it again would encode the answer twice, and the realm would read a string
    // inside a string.
    const spec = rawSpec && typeof rawSpec === 'object' && typeof rawSpec.response === 'string'
        ? rawSpec
        : createParserSandboxSpec(rawSpec ?? {});
    const file = entry ?? parserSandboxEntry();
    const worker = new Worker(file, {
        workerData: { spec },
        env: env ?? process.env,
        stdout: false,
        stderr: false,
    });

    return await new Promise((resolve) => {
        let settled = false;
        let timer = null;

        /**
         * The end of the run.
         * @param {object} report
         * @returns {void}
         */
        const finish = (report) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            worker.terminate?.();
            resolve(report);
        };

        /**
         * The stop of the run.
         * @returns {void}
         */
        const onAbort = () => {
            finish({
                sources: [],
                writes: [],
                logs: [],
                value: null,
                error: 'The salvage was stopped before it answered.',
                reason: 'aborted',
            });
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        // The time of the script: the parent counts it, and the worker is stopped when it
        // is over. A script that never yields cannot be stopped from the inside.
        timer = setTimeout(() => {
            finish({
                sources: [],
                writes: [],
                logs: [],
                value: null,
                error: `The salvage script did not finish in ${spec.timeoutMs} ms.`,
                reason: 'timeout',
            });
        }, spec.timeoutMs);
        timer.unref?.();

        worker.on('message', async (frame) => {
            if (!isFrame(frame)) return;
            if (frame.type === 'call') {
                let output = '';
                let failure = null;
                try {
                    const name = String(frame.name ?? '');
                    const args = frame.arguments ?? {};
                    if (name === 'write') {
                        const written = await onWrite?.(String(args.rel ?? ''), args.data);
                        output = typeof written === 'string' ? written : String(args.rel ?? '');
                    } else if (name === 'fetch') {
                        const bytes = await onFetch?.(String(args.url ?? ''));
                        output = bytes ? Buffer.from(bytes).toString('base64') : '';
                    } else {
                        throw new Error(`There is no call named ${name}.`);
                    }
                } catch (error) {
                    failure = error?.message ?? String(error);
                    output = '';
                }
                worker.postMessage(createFrame('result', { id: frame.id, output, error: failure }));
                return;            }
            if (frame.type === 'log') {
                const line = String(frame.line ?? '');
                if (frame.stream === 'stderr') onError?.(line);
                else onLog?.(line);
                return;
            }
            if (frame.type === 'report') {
                finish(frame.report ?? {
                    sources: [], writes: [], logs: [], value: null, error: 'No report.', reason: 'no-report',
                });
            }
        });

        worker.on('error', (error) => {
            finish({
                sources: [],
                writes: [],
                logs: [],
                value: null,
                error: `The sandbox died: ${error?.message ?? String(error)}`,
                reason: 'failed',
            });
        });

        worker.on('exit', () => {
            finish({
                sources: [],
                writes: [],
                logs: [],
                value: null,
                error: 'The sandbox ended without a report.',
                reason: 'no-report',
            });
        });
    });
}
