/**
 * @file src/image/crop.js
 * @module image/crop
 * @purpose Cut a rectangle out of a picture.
 * @depends image/raster
 * @exports cropImage
 * @ai.tags image, crop
 * @ai.hint io
 */

import { rasterCrop } from './raster.js';

/**
 * Cut a rectangle out of a picture and write it.
 * @param {{ input: string, output: string, x?: number, y?: number, width?: number, height?: number,
 *   cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @ai.hint io
 */
export async function cropImage({
    input, output, x = 0, y = 0, width = null, height = null,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    return await rasterCrop({
        input, output, x, y, width, height, cwd, signal, engine,
    });
}
