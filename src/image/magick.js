/**
 * @file src/image/magick.js
 * @module image/magick
 * @purpose The ImageMagick adapter of the local raster layer: the last engine of the order
 *          sharp → canvas → ImageMagick, and the only one that counts the colors of a picture.
 * @depends node:path, node:fs/promises, core/shell
 * @usedBy image/raster
 * @exports detectMagick, magickRun, magickIdentify, magickCrop, magickSplit, magickResize,
 *          magickConvert, magickPadImageBytes, magickRemoveImagePadding, magickIsOpaque,
 *          magickRemoveFlatBackground, magickColorCount, magickPaletteStats,
 *          magickApplyAlphaMask, magickDetectFakeTransparency, magickContourAlphaMask,
 *          magickSaturationAlphaMask, magickTrimImage, ensureTransparentBackground,
 *          assessVectorSuitability
 * @ai.tags imagemagick, image, raster, alpha
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * ImageMagick is the fallback, not the default: the sharp adapter is faster and does not start
 * a process. What ImageMagick has and sharp does not is the palette work — the number of the
 * colors of a picture is what tells a vectorizer whether a raster is worth tracing.
 */

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { runProgram } from '../core/shell.js';

/** Cached detection result. null = not checked, false = not available, string = the executable. */
let cachedPath = null;

/**
 * Find the ImageMagick executable (`magick` or `convert`).
 * @param {{ magickPath?: string|null }} [options]
 * @returns {Promise<string|null>} The path of the executable, or `null` when there is none.
 * @exports
 * @ai.hint io
 */
export async function detectMagick({ magickPath = null } = {}) {
    if (magickPath) {
        const res = await runProgram({
            file: magickPath, args: ['-version'], timeoutMs: 5_000, maxOutputBytes: 4096,
        }).catch(() => null);
        return res?.exitCode === 0 && /ImageMagick/i.test(res.stdout) ? magickPath : null;
    }
    if (cachedPath !== null) return cachedPath || null;
    const candidates = process.platform === 'win32'
        ? ['magick', 'convert']
        : ['magick', 'convert', '/usr/bin/magick', '/usr/local/bin/convert'];
    for (const exe of candidates) {
        const res = await runProgram({
            file: exe, args: ['-version'], timeoutMs: 5_000, maxOutputBytes: 4096,
        }).catch(() => null);
        if (res?.exitCode === 0 && /ImageMagick/i.test(res.stdout)) {
            cachedPath = exe;
            return exe;
        }
    }
    cachedPath = false;
    return null;
}

/**
 * Run one ImageMagick command.
 * @param {string} exe The executable.
 * @param {string[]} args The arguments.
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 * @exports
 * @ai.hint io
 */
export async function magickRun(exe, args, { cwd = process.cwd(), signal = null, timeoutMs = 30_000 } = {}) {
    const result = await runProgram({ file: exe, args, cwd, signal, timeoutMs, maxOutputBytes: 16 * 1024 });
    if (result.exitCode !== 0) {
        throw new Error(`ImageMagick (${args.join(' ')}): ${result.stderr || `exit code ${result.exitCode}`}`);
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The metadata of a picture: the frame, the format and the weight of the file.
 * @param {{ exe: string, input: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ width: number, height: number, format: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickIdentify({ exe, input, cwd = process.cwd(), signal = null }) {
    const res = await magickRun(exe, [input, '-format', '%w %h %m %B', 'info:'], { cwd, signal });
    const parts = res.stdout.trim().split(/\s+/);
    return {
        width: Number(parts[0]) || 0,
        height: Number(parts[1]) || 0,
        format: parts[2] ?? '',
        bytes: Number(parts[3]) || 0,
    };
}

/**
 * Cut a rectangle out of a picture.
 * @param {{ exe: string, input: string, output: string, x: number, y: number, width: number,
 *   height: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickCrop({ exe, input, output, x, y, width, height, cwd = process.cwd(), signal = null }) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [input, '-crop', `${width}x${height}+${x}+${y}`, '+repage', outPath], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Cut a picture into a grid of tiles.
 * @param {{ exe: string, input: string, outputDir: string, rows: number, cols: number,
 *   cwd?: string, signal?: AbortSignal, baseName?: string }} options
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number, width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function magickSplit({
    exe, input, outputDir, rows, cols, cwd = process.cwd(), signal = null, baseName = 'tile',
}) {
    const identify = await magickIdentify({ exe, input, cwd, signal });
    if (!identify.width || !identify.height) throw new Error(`Cannot read the frame of: ${input}`);
    const tileWidth = Math.floor(identify.width / cols);
    const tileHeight = Math.floor(identify.height / rows);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileWidth;
            const y = row * tileHeight;
            const width = col === cols - 1 ? identify.width - x : tileWidth;
            const height = row === rows - 1 ? identify.height - y : tileHeight;
            const rel = `${outputDir}/${baseName}_r${row + 1}c${col + 1}.png`;
            await magickRun(exe, [input, '-crop', `${width}x${height}+${x}+${y}`, '+repage', rel], { cwd, signal });
            const info = await stat(path.join(cwd, rel)).catch(() => null);
            tiles.push({ rel, row: row + 1, col: col + 1, x, y, width, height, bytes: info?.size ?? 0 });
        }
    }
    return tiles;
}

/**
 * Change the size of a picture.
 * @param {{ exe: string, input: string, output: string, width: number, height?: number|null,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickResize({
    exe, input, output, width, height = null, cwd = process.cwd(), signal = null,
}) {
    const size = height ? `${width}x${height}` : `${width}x`;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [input, '-resize', size, outPath], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Convert a picture into another format.
 * @param {{ exe: string, input: string, output: string, quality?: number|null, cwd?: string,
 *   signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickConvert({
    exe, input, output, quality = null, cwd = process.cwd(), signal = null,
}) {
    const args = [input];
    if (quality != null) args.push('-quality', String(quality));
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    args.push(outPath);
    await magickRun(exe, args, { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Add transparent pixels on the right and the bottom without resizing the source pixels.
 *
 * `targetWidth`/`targetHeight` raise the frame above the 16-pixel grid — up to the smallest
 * canvas a model accepts — and the source still sits in the top-left corner, so the reply is
 * cut back the same way.
 * @param {{ exe: string, bytes: Buffer, signal?: AbortSignal, targetWidth?: number|null,
 *   targetHeight?: number|null }} options
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, originalWidth: number, originalHeight: number, padded: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function magickPadImageBytes({
    exe, bytes, signal = null, targetWidth = null, targetHeight = null,
}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-'));
    const input = path.join(dir, 'input');
    const output = path.join(dir, 'padded.png');
    try {
        await writeFile(input, bytes);
        const info = await magickIdentify({ exe, input, cwd: dir, signal });
        if (!info.width || !info.height) throw new Error('Cannot read the frame of the input picture.');
        const width = Math.max(
            Math.ceil(info.width / 16) * 16,
            Math.ceil(Math.max(1, Number(targetWidth) || 1) / 16) * 16,
        );
        const height = Math.max(
            Math.ceil(info.height / 16) * 16,
            Math.ceil(Math.max(1, Number(targetHeight) || 1) / 16) * 16,
        );
        if (width === info.width && height === info.height) {
            return { bytes, width, height, originalWidth: width, originalHeight: height, padded: false };
        }
        await magickRun(exe, [
            input, '-background', 'none', '-gravity', 'northwest', '-extent', `${width}x${height}`, output,
        ], { cwd: dir, signal });
        return {
            bytes: await readFile(output),
            width,
            height,
            originalWidth: info.width,
            originalHeight: info.height,
            padded: true,
        };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Cut the known right/bottom padding off by its boundary; the generated pixels are never resized.
 * @param {{ exe: string, bytes: Buffer, width: number, height: number, originalWidth: number,
 *   originalHeight: number, signal?: AbortSignal, normalized?: boolean }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function magickRemoveImagePadding({
    exe, bytes, width, height, originalWidth, originalHeight, signal = null, normalized = false,
}) {
    if (width === originalWidth && height === originalHeight) return bytes;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-unpad-'));
    const input = path.join(dir, 'input');
    try {
        await writeFile(input, bytes);
        const info = await magickIdentify({ exe, input, cwd: dir, signal });
        if ((!normalized && (info.width !== width || info.height !== height))
            || !info.width || !info.height || originalWidth > width || originalHeight > height) {
            return bytes;
        }
        const cropWidth = normalized ? Math.round(info.width * originalWidth / width) : originalWidth;
        const cropHeight = normalized ? Math.round(info.height * originalHeight / height) : originalHeight;
        if (!cropWidth || !cropHeight || cropWidth > info.width || cropHeight > info.height) return bytes;
        const output = path.join(dir, `unpadded.${(info.format || 'png').toLowerCase()}`);
        await magickRun(exe, [input, '-crop', `${cropWidth}x${cropHeight}+0+0`, '+repage', output], { cwd: dir, signal });
        return await readFile(output);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Is the picture fully opaque?
 * @param {{ exe: string, input: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<boolean|null>}
 * @exports
 * @ai.hint io
 */
export async function magickIsOpaque({ exe, input, cwd = process.cwd(), signal = null }) {
    const res = await magickRun(exe, [input, '-format', '%[opaque]', 'info:'], { cwd, signal }).catch(() => null);
    if (!res) return null;
    return res.stdout.trim().toLowerCase() === 'true';
}

/**
 * The number of the colors of a picture.
 * @param {{ exe: string, input: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<number|null>}
 * @exports
 * @ai.hint io
 */
export async function magickColorCount({ exe, input, cwd = process.cwd(), signal = null }) {
    const res = await magickRun(exe, [input, '-format', '%k', 'info:'], { cwd, signal }).catch(() => null);
    if (!res) return null;
    const value = Number(res.stdout.trim());
    return Number.isFinite(value) ? value : null;
}

/**
 * The palette of a picture: the colors and how many pixels each of them covers.
 * @param {{ exe: string, input: string, limit?: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<Array<{ color: string, count: number }>>}
 * @exports
 * @ai.hint io
 */
export async function magickPaletteStats({
    exe, input, limit = 64, cwd = process.cwd(), signal = null,
}) {
    const res = await magickRun(exe, [
        input, '-format', '%c', '-depth', '8', 'histogram:info:-',
    ], { cwd, signal }).catch(() => null);
    if (!res) return [];
    const out = [];
    for (const line of res.stdout.split('\n')) {
        const match = /^\s*(\d+):\s*\((\d+)[,)]/.exec(line) ?? /^\s*(\d+):\s*(\S+)/.exec(line);
        if (!match) continue;
        const count = Number(match[1]);
        const color = match[2] ?? '';
        if (Number.isFinite(count)) out.push({ color, count });
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Is the picture worth tracing as a vector?
 *
 * The number of the colors is the measure: a picture with a handful of flat colors is a drawing,
 * a photograph is not — tracing it produces a document nobody can edit.
 * @param {{ exe: string, input: string, maxColors?: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ suitable: boolean, colors: number|null, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function assessVectorSuitability({
    exe, input, maxColors = 256, cwd = process.cwd(), signal = null,
}) {
    const colors = await magickColorCount({ exe, input, cwd, signal });
    if (colors == null) return { suitable: false, colors: null, reason: 'unreadable' };
    if (colors > maxColors) {
        return { suitable: false, colors, reason: `too-many-colors (${colors} > ${maxColors})` };
    }
    return { suitable: true, colors, reason: 'ok' };
}

/**
 * Remove a flat background by its color.
 * @param {{ exe: string, input: string, output: string, color: string, fuzz?: number,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickRemoveFlatBackground({
    exe, input, output, color, fuzz = 10, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [
        input, '-fuzz', `${fuzz}%`, '-transparent', color, outPath,
    ], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Build the alpha channel of a picture from a grayscale matte.
 * @param {{ exe: string, input: string, mask: string, output: string, invert?: boolean,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickApplyAlphaMask({
    exe, input, mask, output, invert = false, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    const args = [input, '(', mask, '-colorspace', 'gray', invert ? '-negate' : '+clone', '-alpha', 'off', ')', '-compose', 'CopyOpacity', '-composite', outPath];
    await magickRun(exe, args, { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Is the transparency of the picture a painted checkerboard instead of a real cut-out?
 * @param {{ exe: string, input: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function magickDetectFakeTransparency({ exe, input, cwd = process.cwd(), signal = null }) {
    const res = await magickRun(exe, [
        input, '-alpha', 'extract', '-colors', '8', '-format', '%c', 'histogram:info:-',
    ], { cwd, signal }).catch(() => null);
    if (!res) return false;
    // A real cut-out has one dominant alpha (the background) and one clear foreground.
    const counts = [];
    for (const line of res.stdout.split('\n')) {
        const match = /^\s*(\d+):/.exec(line);
        if (match) counts.push(Number(match[1]));
    }
    if (counts.length < 2) return false;
    const total = counts.reduce((sum, value) => sum + value, 0);
    if (!total) return false;
    const sorted = [...counts].sort((a, b) => b - a);
    // A checkerboard alternates two colors in equal parts: no single color dominates.
    return sorted[0] / total < 0.7 && sorted.length >= 3;
}

/**
 * Build the matte of a picture by the contour of its object.
 * @param {{ exe: string, input: string, output: string, fuzz?: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickContourAlphaMask({
    exe, input, output, fuzz = 10, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [
        input, '-colorspace', 'gray', '-negate', '-threshold', `${100 - fuzz}%`, outPath,
    ], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Build the matte of a picture by its saturation: the saturated pixels are the object.
 * @param {{ exe: string, input: string, output: string, threshold?: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickSaturationAlphaMask({
    exe, input, output, threshold = 20, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [
        input, '-colorspace', 'HSL', '-channel', 'G', '-separate', '-threshold', `${threshold}%`, outPath,
    ], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info ?? 0 ? (info.size ?? 0) : 0 };
}

/**
 * Cut the uniform edges off a picture.
 * @param {{ exe: string, input: string, output: string, fuzz?: number, transparentOnly?: boolean,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickTrimImage({
    exe, input, output, fuzz = 6, transparentOnly = false, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    const args = [input];
    if (transparentOnly) args.push('-trim');
    else args.push('-fuzz', `${Math.round(fuzz * 2.55)}`, '-trim');
    args.push(outPath);
    await magickRun(exe, args, { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Make the background of a picture transparent, so the alpha channel can be built on it.
 * @param {{ exe: string, input: string, output: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function ensureTransparentBackground({
    exe, input, output, cwd = process.cwd(), signal = null,
}) {
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await magickRun(exe, [input, '-background', 'none', '-alpha', 'set', outPath], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}
