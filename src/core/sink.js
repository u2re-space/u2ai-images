/**
 * @file src/core/sink.js
 * @module core/sink
 * @purpose Write the pictures of a run to disk: one file per result, the partial ones first and the
 *          final ones over them.
 * @depends node:path, node:fs/promises
 * @usedBy commands/generate, commands/edit, commands/decorate
 * @exports createImageSink, timestampSlug
 * @ai.tags images, output
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The writes of one result are serialized: a late partial picture must never overwrite the final
 * one, and the order of the calls is the order of the files.
 */

import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';

/** The extension of every output format. */
const EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif', svg: 'svg' };

/**
 * The stamp of the run: `20261113-141530`, sortable and safe on every filesystem.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function timestampSlug(date = new Date()) {
    const iso = date.toISOString();
    return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Collect the pictures of a run into files.
 *
 * `target` may be a directory or an explicit file path — the first picture takes it, the rest get
 * a suffix.
 * @param {{ target?: string, format?: string, prefix?: string }} [options]
 * @returns {{ savePartial: Function, saveFinal: Function, paths: Map<string, string>,
 *   files: string[] }}
 * @exports
 * @ai.hint io
 */
export function createImageSink({ target = '.', format = 'png', prefix = 'ai-image' } = {}) {
    const root = path.resolve(target);
    /** itemId → the absolute path of the file. */
    const paths = new Map();
    /** itemId → the promise chain of the writes. */
    const queues = new Map();
    /** The items whose final picture is already on disk: a late partial must not replace it. */
    const finals = new Set();
    let counter = 0;
    let targetIsFile = null;
    const stamp = timestampSlug();

    /**
     * Decide once whether `target` is a file path or a directory.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function resolveTarget() {
        if (targetIsFile !== null) return;
        const info = await stat(root).catch(() => null);
        targetIsFile = info ? !info.isDirectory() : /\.(png|jpe?g|webp|gif|svg)$/i.test(root);
    }

    /**
     * The path of one result. The same id always gets the path it got on the first call.
     * @param {string} itemId
     * @param {string} [outputFormat]
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function fileFor(itemId, outputFormat) {
        await resolveTarget();
        if (paths.has(itemId)) return paths.get(itemId);
        counter += 1;
        const ext = EXT[(outputFormat ?? format) || ''] ?? 'png';
        let file;
        if (targetIsFile) {
            const parsed = path.parse(root);
            file = counter === 1
                ? root
                : path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext || `.${ext}`}`);
        } else {
            file = path.join(root, `${prefix}-${stamp}-${counter}.${ext}`);
        }
        paths.set(itemId, file);
        await mkdir(path.dirname(file), { recursive: true });
        return file;
    }

    /**
     * Decode the payload and write it. The writes of one result run in order, so a late partial
     * cannot pass the final one — and a partial that arrives after the final is dropped.
     * @param {string|null} itemId
     * @param {string|Buffer} payload
     * @param {string} [outputFormat]
     * @param {'partial'|'final'} [kind]
     * @returns {Promise<{ file: string, bytes: number }|null>}
     * @ai.hint io
     */
    function write(itemId, payload, outputFormat, kind = 'final') {
        if (!payload) return Promise.resolve(null);
        const key = itemId ?? `#${counter + 1}`;
        if (kind === 'partial' && finals.has(key)) return Promise.resolve(null);
        const job = (queues.get(key) ?? Promise.resolve()).then(async () => {
            if (kind === 'partial' && finals.has(key)) return null;
            const file = await fileFor(key, outputFormat);
            const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'base64');
            await writeFile(file, buffer);
            if (kind === 'final') finals.add(key);
            return { file, bytes: buffer.length };
        });
        queues.set(key, job.catch(() => null));
        return job;
    }

    return {
        /**
         * Write the partial picture of a result.
         * @param {string|null} itemId
         * @param {string|Buffer} payload
         * @param {string} [outputFormat]
         * @returns {Promise<{ file: string, bytes: number }|null>}
         * @ai.hint io
         */
        savePartial: (itemId, payload, outputFormat) => write(itemId, payload, outputFormat, 'partial'),
        /**
         * Write the final picture of a result.
         * @param {string|null} itemId
         * @param {string|Buffer} payload
         * @param {string} [outputFormat]
         * @returns {Promise<{ file: string, bytes: number }|null>}
         * @ai.hint io
         */
        saveFinal: (itemId, payload, outputFormat) => write(itemId, payload, outputFormat, 'final'),
        /**
         * The copy of every id to its absolute path.
         * @returns {Map<string, string>}
         * @ai.hint pure
         */
        get paths() { return new Map(paths); },
        /**
         * The absolute paths written so far, in the order of the assignment.
         * @returns {string[]}
         * @ai.hint pure
         */
        get files() { return [...paths.values()]; },
    };
}
