/**
 * @file src/core/paths.js
 * @module core/paths
 * @purpose Keep every path of the tools inside the working directory: a picture may be read from
 *          anywhere, but a picture may only be written inside the directory of the run.
 * @depends node:path, node:fs/promises
 * @exports isInside, resolveInside, toPosix
 * @ai.tags paths, safety
 * @ai.hint io
 */

import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/**
 * True when `candidate` is `root` or a path beneath it.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === ''
        || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * The path in the POSIX form: the reports and the JSON answers use slashes on every platform.
 * @param {string} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toPosix(value) {
    return String(value ?? '').split(path.sep).join('/');
}

/**
 * Resolve a path against the working directory and refuse everything that leaves it.
 *
 * The check is done twice: once on the path itself and once on the deepest existing component
 * after `realpath`, so a symlink cannot carry a write out of the directory.
 * @param {string} root The working directory of the run.
 * @param {string} relative The path of the caller.
 * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
 * @returns {Promise<{ abs: string, rel: string }>} The absolute path and the path relative to
 *   the working directory, in the POSIX form.
 * @exports
 * @ai.hint io
 */
export async function resolveInside(root, relative, { forWrite = false, allowRoot = true } = {}) {
    if (typeof relative !== 'string') throw new Error('The path must be a string.');
    if (relative.includes('\0')) throw new Error('The path contains NUL.');
    const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
    const base = path.resolve(root);
    const abs = path.resolve(base, cleaned);
    if (!isInside(base, abs)) throw new Error(`The path is outside the working directory: ${relative}`);
    const rel = toPosix(path.relative(base, abs));
    if (rel === '' && !allowRoot) throw new Error('A file is needed, not the root of the directory.');
    // The deepest existing component decides whether the real path is still inside.
    let probe = abs;
    for (;;) {
        const info = await lstat(probe).catch(() => null);
        if (info) {
            const real = await realpath(probe).catch(() => probe);
            const realRoot = await realpath(base).catch(() => base);
            if (!isInside(realRoot, real)) {
                throw new Error(`The path leaves the working directory through a symlink: ${rel}`);
            }
            break;
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    return { abs, rel: rel || '.' };
}
