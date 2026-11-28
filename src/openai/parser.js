/**
 * @file src/openai/parser.js
 * @module openai/parser
 * @purpose The second chance to read a picture out of an answer of an unusual shape: the model
 *          writes a small extraction script for the shape it sees, the script runs in a sandbox
 *          with fetch and file writing, and both the raw answer and the script stay on disk.
 * @depends node:path, node:fs/promises, openai/diagnostics, openai/images, openai/parser-sandbox
 * @usedBy openai/client
 * @exports describeShape, makeParserInvoke, parseImageResponseWithAI, extractScript, toSource,
 *          runParserScript
 * @ai.tags images, fallback, sandbox, diagnostics
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The built-in readers know two shapes: `data[].b64_json` and `data[].url`. A gateway that nests
 * the picture anywhere else — `data.result.images[].url[]` was the first, others keep appearing —
 * used to end the call with an error even though the bytes were in hand. Rather than grow another
 * hardcoded branch per vendor, the raw answer is described to the model (the long base64 strings
 * are elided, the paths are shown), and the model answers with the one thing that generalizes: a
 * function that walks this particular object and returns the payloads.
 *
 * The script runs in the sandbox of `openai/parser-sandbox`: a realm of `node:vm` inside a
 * worker thread of its own. The answer crosses as JSON, the helpers are facades that return
 * primitives, and the calls that need the host travel back to it. The script may pull a link the
 * answer only mentions, decode inline base64, and drop the result where the caller can find it —
 * and on top of that it may reach the libraries of the house and the memory of the house.
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { saveImageResponse, saveImageParserScript } from './diagnostics.js';
import { sniffImage } from './images.js';
import { runParserSandboxWorker } from './parser-sandbox.js';

/** Strings longer than this are elided in the shape sketch: a base64 picture is not worth its tokens. */
const SHAPE_STRING_MAX = 120;
/** Array entries the sketch shows before it switches to a count. */
const SHAPE_ARRAY_MAX = 3;
/** Nesting depth the sketch walks before it collapses the rest to a type name. */
const SHAPE_MAX_DEPTH = 7;
/** The sketch itself is capped; a megabyte of keys means the answer is not salvageable by reading. */
const SHAPE_MAX_BYTES = 24 * 1024;

/** Wall-clock cap for one salvage script, including its awaits. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** Bytes one `fetch` inside the script may return. */
const FETCH_MAX_BYTES = 64 * 1024 * 1024;
/** Payloads accepted from one script; a larger list is a runaway loop, not a batch. */
const MAX_PAYLOADS = 32;
/** How much of the script's own log is kept for the record. */
const LOG_MAX_LINES = 40;

/**
 * The one way the salvage route asks a model for text: a single non-streaming Responses call whose
 * answer is read as plain text. The client only needs `responses.create`, so a client object, a
 * fallback router, or a lazy wrapper over either works.
 *
 * The request is never batchable: the salvage script has to be written and run right now, in this
 * run — a batch that comes back tomorrow is of no use here.
 * @param {{ responses: { create: Function } }} client
 * @returns {({ model: string, prompt: string, signal?: AbortSignal }) => Promise<string>}
 * @exports
 * @ai.hint io
 */
export function makeParserInvoke(client) {
    return async ({ model, prompt, signal }) => {
        const answer = await client.responses.create({
            model,
            store: false,
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            signal,
            batchable: false,
        });
        return answer?.output_text ?? answer?.text ?? '';
    };
}

/**
 * Compact sketch of a parsed JSON answer: keys, types, counts, and short sample values.
 *
 * The long strings — the base64 payloads themselves — become `<string N chars: head…>`, which is
 * what tells the model both where the picture lives and that it must extract rather than echo it.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function describeShape(value, depth = 0) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') {
        const text = value;
        if (text.length <= SHAPE_STRING_MAX) return JSON.stringify(text);
        return `<string ${text.length} chars: ${JSON.stringify(text.slice(0, 48))}…>`;
    }
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'bigint') return `${value}n`;
    if (type === 'function' || type === 'symbol') return `<${type}>`;
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const shown = value.slice(0, SHAPE_ARRAY_MAX)
            .map((item) => (depth >= SHAPE_MAX_DEPTH ? '<…>' : describeShape(item, depth + 1)));
        const rest = value.length > SHAPE_ARRAY_MAX ? `, … ${value.length} items total` : '';
        return `[${shown.join(', ')}${rest}]`;
    }
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    if (depth >= SHAPE_MAX_DEPTH) return `<object ${entries.length} keys>`;
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${describeShape(item, depth + 1)}`).join(', ')}}`;
}

/**
 * The request to the model: here is the answer, here are the helpers, return the payloads.
 * @param {string} shape The sketch of the answer.
 * @param {{ route?: string|null, model?: string|null, taskId?: string|null }} [meta]
 * @returns {string}
 * @ai.hint pure
 */
function parserPrompt(shape, meta = {}) {
    return `A picture API answered with a JSON body whose shape is not the usual OpenAI one, so the built-in reader found no image in it.
Write the body of one async JavaScript function that extracts the picture payloads from this exact response.

Response metadata: route ${meta.route ?? 'unknown'}; model ${meta.model ?? 'unknown'}; task id ${meta.taskId ?? 'none'}.

The response object, with long strings elided (a path shown as <string N chars> is available in full at runtime):
${shape}

Inside the function these names are defined:
- response — the full parsed JSON answer, exactly as shown above but with the elided strings intact. It is a JSON **string**: read it with JSON.parse(response).
- fetchBytes(url) → Promise<Uint8Array|null> — downloads an http(s) URL; null when it fails.
- decodeBase64(text) → Uint8Array — decodes base64, tolerating a data: prefix and URL-safe alphabet.
- encodeBase64(bytes) → string.
- imageDataUrl(bytesOrString, mime?) → string.
- sniff(bytes) → 'png' | 'jpg' | 'webp' | 'gif' | 'svg' | null — format from magic bytes.
- write(relPath, data) → Promise<string> — writes a string or bytes under the working directory (path escapes are refused); use it for the extracted picture or any sidecar you must produce.
- log(...args) — records a diagnostic line.
- fetch(url, init) → a small response with ok, status, arrayBuffer() and text().
- fs — a file system in the memory: readFile, writeFile, readdir, stat, unlink, mkdir.
- shared — the shared block of the run: shared.view is a byte view of it.
- library.call(path, args) → Promise<any> — the libraries of the house: canvas, the wasm of ImageMagick, openvector. library.catalog() names them and their calls.
- TextEncoder, TextDecoder, JSON, Math, Date, atob, btoa.
There is no require, import, process, __dirname, setTimeout, or filesystem access.

Return an array whose items are any of: base64 string, data: URL, http(s) URL, Uint8Array, ArrayBuffer.
Return [] when the response truly carries no picture (an error answer is not a picture).
Extract the real values by path; never retype or truncate a base64 string.
Answer with the function body only, in one \`\`\`js fence, no wrapper function signature, no commentary.`;
}

/**
 * First `js`/untagged fenced block, or the whole text when the model skipped the fence.
 * @param {string} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function extractScript(text) {
    const source = String(text ?? '');
    const fenced = source.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
    return (fenced ? fenced[1] : source).trim();
}

/**
 * One picture payload out of whatever the script returned.
 * @param {unknown} item
 * @returns {{ kind: 'b64'|'url', value: string }|null}
 * @exports
 * @ai.hint pure
 */
export function toSource(item) {
    const push = (value) => (value ? { kind: 'b64', value } : null);
    if (item == null) return null;
    if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return null;
        if (/^data:/i.test(text)) {
            const comma = text.indexOf(',');
            if (comma < 0 || !/;base64/i.test(text.slice(0, comma))) return null;
            return push(text.slice(comma + 1).trim());
        }
        if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text };
        const compact = text.replace(/\s+/g, '');
        return /^[A-Za-z0-9+/=]{16,}$/.test(compact) ? push(compact) : null;
    }
    if (item instanceof Uint8Array) return push(Buffer.from(item).toString('base64'));
    if (item instanceof ArrayBuffer) return push(Buffer.from(new Uint8Array(item)).toString('base64'));
    if (Array.isArray(item)) {
        for (const nested of item.map(toSource).filter(Boolean)) return nested;
        return null;
    }
    if (typeof item === 'object') {
        for (const key of ['b64_json', 'b64', 'base64', 'data', 'url', 'image', 'value', 'src']) {
            const found = toSource(item[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Bytes of a base64 string, but only when those bytes start with a picture signature.
 *
 * `write` gets strings from the script, and a script is equally likely to hand over an SVG
 * document as a base64 PNG; the magic bytes are the only honest way to tell the two apart.
 * @param {string} text
 * @returns {Buffer|null}
 * @ai.hint pure
 */
function base64ImageBytes(text) {
    const compact = String(text ?? '').trim().replace(/\s+/g, '');
    if (compact.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
    const bytes = Buffer.from(compact, 'base64');
    if (!bytes.length) return null;
    const ext = sniffImage(bytes).ext;
    return (ext === 'png' && bytes.subarray(0, 4).toString('hex') === '89504e47')
        || (ext === 'jpg' && bytes[0] === 0xff && bytes[1] === 0xd8)
        || (ext === 'webp') || (ext === 'gif') || (ext === 'svg')
        ? bytes : null;
}

/**
 * Run one salvage script over the answer.
 *
 * The script runs in the sandbox of the parser: a realm of `node:vm` inside a worker
 * thread of its own. The answer crosses as JSON, the helpers are facades that return
 * primitives, and the calls that need the host travel back here.
 *
 * @param {string} script The function body the model wrote.
 * @param {{ response: unknown, root: string, signal?: AbortSignal|null,
 *   timeoutMs?: number|null, libraries?: string[]|null }} options
 * @returns {Promise<{ sources: Array<{kind:'b64'|'url', value:string}>, writes: string[], logs: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runParserScript(script, {
    response,
    root,
    signal = null,
    timeoutMs = null,
    libraries = null,
}) {
    const logs = [];
    const writes = [];
    const workspace = path.resolve(root ?? process.cwd());

    /**
     * Download a link the answer only mentions.
     * @param {unknown} url
     * @returns {Promise<Uint8Array|null>}
     */
    const fetchBytes = async (url) => {
        let target;
        try { target = new URL(String(url)); } catch { return null; }
        if (!['http:', 'https:'].includes(target.protocol)) return null;
        const res = await fetch(target.href, { signal, redirect: 'follow' });
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        return bytes.length > FETCH_MAX_BYTES ? null : bytes;
    };

    /**
     * Write a file inside the working directory; the paths out of it are refused.
     * @param {unknown} rel
     * @param {unknown} data
     * @returns {Promise<string>}
     */
    const write = async (rel, data) => {
        const requested = String(rel ?? '').trim();
        if (!requested) throw new Error('write: path is required');
        if (path.isAbsolute(requested)) throw new Error(`write: absolute path refused: ${requested}`);
        const abs = path.resolve(workspace, requested);
        if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
            throw new Error(`write: path escapes the working directory: ${requested}`);
        }
        const bytes = typeof data === 'string'
            ? (base64ImageBytes(data) ?? Buffer.from(data, 'utf8'))
            : data instanceof Uint8Array ? Buffer.from(data)
                : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
                    : Buffer.from(String(data), 'utf8');
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
        const posix = requested.split(path.sep).join('/');
        writes.push(posix);
        return posix;
    };

    const report = await runParserSandboxWorker({
        spec: {
            script,
            response,
            root: workspace,
            timeoutMs: timeoutMs ?? SCRIPT_TIMEOUT_MS,
            libraries,
        },
        onWrite: async (rel, data) => await write(rel, data),
        onFetch: async (url) => await fetchBytes(url),
        onLog: (line) => {
            if (logs.length < LOG_MAX_LINES) logs.push(line);
        },
        signal,
    });

    const sources = [];
    const list = Array.isArray(report.value) ? report.value : [report.value];
    for (const item of list.slice(0, MAX_PAYLOADS)) {
        const source = toSource(item);
        if (source) sources.push(source);
    }
    // A refusal of the host is part of the record: a script that was told «no» must not
    // look like a script that found nothing.
    const refusals = Array.isArray(report.refusals) ? report.refusals : [];
    for (const refusal of refusals) {
        if (logs.length < LOG_MAX_LINES) logs.push(`refused: ${refusal}`);
    }
    return { sources, writes, logs };
}

/**
 * Second-chance parse of an answer of the picture API through a model-written extraction script.
 * @param {{ result: unknown, route?: string, model?: string|null, host?: string|null, taskId?: string|null,
 *   invoke?: (({ model: string, prompt: string, signal?: AbortSignal }) => Promise<string>)|null,
 *   parserModel?: string|null, root?: string|null, signal?: AbortSignal,
 *   onWarn?: ((message: string) => void)|null, onArchive?: ((file: string|null) => void)|null,
 *   archive?: boolean }} options
 *   `invoke` asks a model for text; without it (or without `parserModel`) only the raw answer is
 *   archived and `null` comes back, so a client that never opted in keeps its old behaviour.
 *   `archive: false` skips the save for a caller that already wrote the answer itself.
 * @returns {Promise<Array<{kind:'b64'|'url', value:string}>|null>} The sources, or `null` when
 *   nothing was salvaged.
 * @exports
 * @ai.hint io
 */
export async function parseImageResponseWithAI({
    result, route = 'images', model = null, host = null, taskId = null,
    invoke = null, parserModel = null, root = null, signal, onWarn = null, onArchive = null, archive = true,
    libraries = null, timeoutMs = null,
}) {
    const savedFile = archive ? await saveImageResponse(result, { route, model, host, taskId }) : null;
    try { onArchive?.(savedFile); } catch { /* an observer never breaks the request */ }
    if (!invoke || !parserModel) return null;
    const warn = (message) => { try { onWarn?.(message); } catch { /* an observer never breaks the request */ } };
    const workspace = path.resolve(root ?? process.cwd());
    try {
        signal?.throwIfAborted();
        const shape = describeShape(result).slice(0, SHAPE_MAX_BYTES);
        const answer = await invoke({
            model: parserModel,
            prompt: parserPrompt(shape, { route, model, taskId }),
            signal,
        });
        const script = extractScript(answer);
        if (!script || script.length < 16) {
            warn(`Fallback parse: the model ${parserModel} returned no salvage script.`);
            return null;
        }
        const { sources, writes, logs } = await runParserScript(script, {
            response: result,
            root: workspace,
            signal,
            timeoutMs,
            libraries,
        });
        if (!sources.length) {
            warn(`Fallback parse: the script from ${parserModel} found no picture`
                + `${logs.length ? `; log: ${logs.join(' | ').slice(0, 400)}` : ''}.`);
        }
        // The script itself is part of the evidence: the raw answer alone does not explain how the
        // pictures were pulled out of it, and a future change of this gateway shape starts here.
        await saveImageParserScript(script, {
            route,
            notes: `payloads: ${sources.length}; files written: ${writes.join(', ') || 'none'}`
                + `${logs.length ? `; log: ${logs.join(' | ').slice(0, 400)}` : ''}`,
        });
        return sources.length ? sources : null;
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        warn(`Fallback parse failed (${error?.message ?? error}).`);
        return null;
    }
}
