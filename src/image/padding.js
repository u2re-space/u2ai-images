/**
 * @file src/image/padding.js
 * @module image/padding
 * @purpose Grow the canvas of a picture: the content keeps its place and its scale, the new space
 *          is filled with a color or with transparency.
 * @depends image/raster
 * @exports padImage, parsePadColor
 * @ai.tags image, pad, canvas
 * @ai.hint io
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeRgba, encodeRgba, rasterInfo } from './raster.js';

/**
 * Parse a padding color: `transparent`, a named color, or `#rgb`/`#rrggbb`.
 * @param {string} value
 * @returns {{ r: number, g: number, b: number, alpha: number }}
 * @exports
 * @ai.hint pure
 */
export function parsePadColor(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text || text === 'transparent' || text === 'none') return { r: 0, g: 0, b: 0, alpha: 0 };
    const named = { white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080' };
    const hex = named[text] ?? text;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
    if (short) {
        return {
            r: parseInt(short[1] + short[1], 16),
            g: parseInt(short[2] + short[2], 16),
            b: parseInt(short[3] + short[3], 16),
            alpha: 1,
        };
    }
    const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
    if (long) {
        return {
            r: parseInt(long[1], 16),
            g: parseInt(long[2], 16),
            b: parseInt(long[3], 16),
            alpha: 1,
        };
    }
    return { r: 0, g: 0, b: 0, alpha: 0 };
}

/**
 * Grow the canvas of a picture to a frame.
 *
 * The content is placed in the top-left corner in its own scale: only empty space is added, so
 * the picture is never distorted.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null,
 *   color?: string, cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @ai.hint io
 */
export async function padImage({
    input, output, width = null, height = null, color = 'transparent',
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const abs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const bytes = await readFile(abs);
    const frame = await decodeRgba(bytes, engine);
    signal?.throwIfAborted();
    const info = await rasterInfo(input, { cwd, engine });
    const targetWidth = Math.max(info.width, Math.round(width ?? info.width));
    const targetHeight = Math.max(info.height, Math.round(height ?? info.height));
    const fill = parsePadColor(color);
    const sheet = {
        width: targetWidth,
        height: targetHeight,
        data: Buffer.alloc(targetWidth * targetHeight * 4),
    };
    for (let i = 0; i < sheet.data.length; i += 4) {
        sheet.data[i] = fill.r;
        sheet.data[i + 1] = fill.g;
        sheet.data[i + 2] = fill.b;
        sheet.data[i + 3] = Math.round(fill.alpha * 255);
    }
    for (let row = 0; row < frame.height; row++) {
        const from = row * frame.width * 4;
        frame.data.copy(sheet.data, row * targetWidth * 4, from, from + frame.width * 4);
    }
    const png = await encodeRgba(sheet, { format: 'png' }, engine);
    const outAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length,
        width: targetWidth,
        height: targetHeight,
    };
}
