/**
 * @file src/image/trimmer.js
 * @module image/trimmer
 * @purpose Cut the uniform or transparent edges off a picture.
 * @depends image/raster
 * @exports trimImage
 * @ai.tags image, trim
 * @ai.hint io
 */

import { rasterTrim } from './raster.js';

/**
 * Cut the uniform or transparent padding off all four edges.
 * @param {{ input: string, output?: string, fuzz?: number|null, transparentOnly?: boolean,
 *   cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, before?: object, after?: object }>}
 * @ai.hint io
 */
export async function trimImage({
    input, output = input, fuzz = 6, transparentOnly = false,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    return await rasterTrim({
        input, output, fuzz, transparentOnly, cwd, signal, engine,
    });
}
