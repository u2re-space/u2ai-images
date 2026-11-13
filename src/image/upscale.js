/**
 * @file src/image/upscale.js
 * @module image/upscale
 * @purpose Make a picture bigger while it keeps its proportions.
 * @depends image/raster
 * @exports upscaleImage
 * @ai.tags image, upscale, resize
 * @ai.hint io
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeRgba, encodeRgba, rasterInfo, rasterScale } from './raster.js';

/**
 * Enlarge a picture.
 *
 * The factor is the multiplier of the longest side; the other side follows, so the proportions
 * survive. A picture that is already bigger than the target is left alone.
 * @param {{ input: string, output: string, factor?: number, width?: number|null, height?: number|null,
 *   cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, scaled: boolean }>}
 * @ai.hint io
 */
export async function upscaleImage({
    input, output, factor = 2, width = null, height = null,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const info = await rasterInfo(input, { cwd, engine });
    signal?.throwIfAborted();
    const scale = Math.max(1, Number(factor) || 1);
    let targetWidth = width ? Math.round(width) : Math.max(1, Math.round(info.width * scale));
    let targetHeight = height ? Math.round(height) : Math.max(1, Math.round(info.height * scale));
    if (width && !height) targetHeight = Math.max(1, Math.round(info.height * targetWidth / info.width));
    if (height && !width) targetWidth = Math.max(1, Math.round(info.width * targetHeight / info.height));
    const frame = await decodeRgba(await readFile(path.isAbsolute(input) ? input : path.join(cwd, input)), engine);
    const scaled = targetWidth !== frame.width || targetHeight !== frame.height
        ? await rasterScale(frame, targetWidth, targetHeight, engine)
        : frame;
    const png = await encodeRgba(scaled, { format: 'png' }, engine);
    const outAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length,
        width: scaled.width,
        height: scaled.height,
        scaled: scaled !== frame,
    };
}
