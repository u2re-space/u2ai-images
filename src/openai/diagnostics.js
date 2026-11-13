/**
 * @file src/openai/diagnostics.js
 * @module openai/diagnostics
 * @purpose Keep every raw answer of the picture API on disk, so an answer that the built-in
 *          readers cannot parse can still be inspected afterwards.
 * @depends node:path, node:fs/promises
 * @usedBy openai/parser, openai/client
 * @exports setImageDiagnostics, imageDiagnosticsContext, saveImageResponse,
 *          saveImageParserScript, imageResponseDir
 * @ai.tags images, diagnostics, debug
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The archiver writes into the diagnostics directory of the home (`~/.ai-image/diagnostics/`).
 * The directory is announced once by the CLI: the client and the parser know nothing about the
 * layout of the project, so nobody threads a path through the call sites.
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

/** @type {{ dir: string }|null} */
let context = null;

/** One counter per process: two answers in the same second still get separate files. */
let sequence = 0;

/**
 * `20261113-141530` — sortable, filesystem-safe, without colons.
 * @returns {string}
 * @ai.hint pure
 */
function stamp() {
    const iso = new Date().toISOString();
    return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * A file name out of a route name: letters, digits and dashes only.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function slugOf(value) {
    return String(value ?? 'response')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'response';
}

/**
 * Announce where the answers of this run belong.
 * @param {{ dir: string }|null} next Absolute path of the diagnostics directory; `null` turns
 *   the archiving off.
 * @returns {{ dir: string }|null}
 * @exports
 * @ai.hint pure
 */
export function setImageDiagnostics(next) {
    context = next?.dir ? { dir: path.resolve(next.dir) } : null;
    return context;
}

/**
 * The active archive context, or `null` when nobody announced a run.
 * @returns {{ dir: string }|null}
 * @exports
 * @ai.hint pure
 */
export function imageDiagnosticsContext() {
    return context;
}

/**
 * The directory the answers are written into, or `null` when the archiving is off.
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function imageResponseDir() {
    return context?.dir ?? null;
}

/**
 * Archive one answer of the gateway in full — the base64 payloads included — before anything
 * parses it.
 *
 * A refused write is never the problem of the caller: the answer is already paid for, and a lost
 * debug file must not turn a good generation into a failed one.
 * @param {unknown} result The parsed JSON body as it came off the wire.
 * @param {{ route?: string, model?: string|null, host?: string|null, taskId?: string|null,
 *   provider?: string|null }} [meta] What produced the answer, for the name and the header.
 * @returns {Promise<string|null>} The path of the saved file, or `null` when nothing was written.
 * @exports
 * @ai.hint io
 */
export async function saveImageResponse(result, meta = {}) {
    if (!context) return null;
    try {
        sequence += 1;
        const slug = slugOf(meta.route);
        const file = `${stamp()}-${slug}-${String(sequence).padStart(3, '0')}.json`;
        const abs = path.join(context.dir, file);
        await mkdir(path.dirname(abs), { recursive: true });
        const record = {
            savedAt: new Date().toISOString(),
            route: meta.route ?? null,
            model: meta.model ?? null,
            host: meta.host ?? null,
            provider: meta.provider ?? null,
            taskId: meta.taskId ?? null,
            response: result ?? null,
        };
        await writeFile(abs, JSON.stringify(record, null, 2));
        return abs;
    } catch {
        return null;
    }
}

/**
 * Write one salvage script next to the answers, so the way a picture was pulled out of an unusual
 * answer survives the run that discovered it.
 * @param {string} script The function body the model wrote.
 * @param {{ route?: string, notes?: string }} [meta]
 * @returns {Promise<string|null>} The path of the saved file, or `null` when nothing was written.
 * @exports
 * @ai.hint io
 */
export async function saveImageParserScript(script, meta = {}) {
    if (!context) return null;
    try {
        sequence += 1;
        const slug = slugOf(meta.route);
        const file = `${stamp()}-${slug}-parser-${String(sequence).padStart(3, '0')}.js`;
        const abs = path.join(context.dir, file);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, `// salvage script · ${new Date().toISOString()} · ${slug}\n`
            + (meta.notes ? `// ${String(meta.notes).replace(/\r?\n/g, ' ')}\n` : '')
            + `${script}\n`);
        return abs;
    } catch {
        return null;
    }
}
