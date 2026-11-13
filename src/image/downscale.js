/**
 * @file src/image/downscale.js
 * @module image/downscale
 * @purpose Make a picture smaller while it keeps its proportions.
 * @depends image/raster
 * @exports downscaleImage
 * @ai.tags image, downscale, resize
 * @ai.hint io
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeRgba, encodeRgba, rasterInfo, rasterScale } from './raster.js';

/**
 * Shrink a picture.
 *
 * The longest side is capped and the other side follows, so the proportions survive. A picture
 * that is already smaller than the cap is left alone: a downscale never enlarges.
 * @param {{ input: string, output: string, maxSide?: number|null, width?: number|null,
 *   height?: number|null, cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, scaled: boolean }>}
 * @ai.hint io
 */
export async function downscaleImage({
    input, output, maxSide = null, width = null, height = null,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const info = await rasterInfo(input, { cwd, engine });
    signal?.throwIfAborted();
    let targetWidth = width ? Math.round(width) : info.width;
    let targetHeight = height ? Math.round(height) : info.height;
    if (maxSide) {
        const scale = Math.min(1, Math.round(maxSide) / Math.max(info.width, info.height));
        targetWidth = Math.max(1, Math.round(info.width * scale));
        targetHeight = Math.max(1, Math.round(info.height * scale));
    }
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
