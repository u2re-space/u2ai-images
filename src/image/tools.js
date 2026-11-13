/**
 * @file src/image/tools.js
 * @module image/tools
 * @purpose The local picture operations of the CLI: crop, pad, fit, resize, trim, split and
 *          compare.
 * @depends node:path, node:fs/promises, core/paths, image/raster, image/padding, image/downscale,
 *          image/upscale, image/trimmer
 * @usedBy commands/crop, commands/pad, commands/fit, commands/resize, commands/trim,
 *          commands/split, commands/compare
 * @exports FIT_MODES, cropPicture, padPicture, fitPicture, resizePicture, trimPicture,
 *          splitPicture, comparePictures, pictureInfo
 * @ai.tags images, tools, crop, pad, fit, resize, trim, split, compare
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * Every operation speaks the same contract: `{ input, output, cwd, signal, engine }`, the input is
 * read from the working directory, and the output is written inside it. The pixel work is done by
 * the raster layer, so every engine answers the same way; this module only decides what to ask
 * for and what to report.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveInside } from '../core/paths.js';
import {
    decodeRgba,
    encodeRgba,
    rasterCompare,
    rasterCrop,
    rasterFitToFrame,
    rasterInfo,
    rasterScale,
    rasterSplit,
    rasterTrim,
} from './raster.js';
import { padImage } from './padding.js';
import { downscaleImage } from './downscale.js';
import { upscaleImage } from './upscale.js';

/** The ways a picture is fitted into a frame. */
export const FIT_MODES = Object.freeze(['contain', 'cover', 'fill']);

/**
 * The absolute path of a file of the working directory.
 * @param {string} cwd
 * @param {string} file
 * @returns {string}
 * @ai.hint pure
 */
function toAbs(cwd, file) {
    return path.isAbsolute(file) ? file : path.join(cwd, file);
}

/**
 * Read a picture of the working directory, refusing the ones over the limit.
 * @param {{ input: string, cwd?: string, maxBytes?: number|null }} options
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
async function readPicture({ input, cwd = process.cwd(), maxBytes = null }) {
    const bytes = await readFile(toAbs(cwd, input));
    if (maxBytes && bytes.length > maxBytes) {
        throw new Error(`The picture is larger than the limit of ${maxBytes} bytes: ${input}`);
    }
    return bytes;
}

/**
 * The metadata of a picture: the frame, the format, the alpha and the weight.
 * @param {{ input: string, cwd?: string, engine?: string }} options
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function pictureInfo({ input, cwd = process.cwd(), engine = 'auto' }) {
    const abs = toAbs(cwd, input);
    const bytes = await readFile(abs);
    const info = await rasterInfo(abs, { cwd, engine });
    return { ...info, bytes: bytes.length };
}

/**
 * Cut a box out of a picture, or cut its padding off.
 *
 * The box is taken from the source: the coordinates of a crop are the coordinates of the original
 * picture, never of a scaled copy of it.
 * @param {{ input: string, output: string, x?: number, y?: number, width?: number, height?: number,
 *   trim?: boolean, fuzz?: number|null, transparentOnly?: boolean, cwd?: string, signal?: AbortSignal,
 *   engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, changed: boolean,
 *   reason: string, source: { width: number, height: number } }>}
 * @exports
 * @ai.hint io
 */
export async function cropPicture({
    input, output, x = 0, y = 0, width = null, height = null, trim = false,
    fuzz = 6, transparentOnly = false, cwd = process.cwd(), signal = null, engine = 'auto',
    maxBytes = null,
}) {
    await readPicture({ input, cwd, maxBytes });
    const before = await rasterInfo(toAbs(cwd, input), { cwd, engine });
    if (trim) {
        const result = await rasterTrim({
            input: toAbs(cwd, input),
            output: toAbs(cwd, output),
            fuzz,
            transparentOnly,
            cwd,
            signal,
            engine,
        });
        if (!result.changed) {
            return {
                rel: path.basename(String(output)),
                bytes: 0,
                width: before.width,
                height: before.height,
                changed: false,
                reason: result.reason,
                source: { width: before.width, height: before.height },
            };
        }
        return {
            rel: String(output).split(path.sep).join('/'),
            bytes: (await readFile(toAbs(cwd, output))).length,
            width: result.after.width,
            height: result.after.height,
            changed: true,
            reason: result.reason,
            source: { width: before.width, height: before.height },
        };
    }
    if (!width || !height) {
        throw new Error('Give the width and the height of the box, or ask for a trim.');
    }
    const result = await rasterCrop({
        input: toAbs(cwd, input),
        output: toAbs(cwd, output),
        x,
        y,
        width,
        height,
        cwd,
        signal,
        engine,
    });
    return {
        rel: result.rel,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        changed: true,
        reason: 'cropped',
        source: { width: before.width, height: before.height },
    };
}

/**
 * Grow the canvas of a picture to a frame.
 *
 * The content stays in the top-left corner in its own scale: only empty space is added, so the
 * picture is never distorted.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null,
 *   color?: string, cwd?: string, signal?: AbortSignal, engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function padPicture({
    input, output, width = null, height = null, color = 'transparent',
    cwd = process.cwd(), signal = null, engine = 'auto', maxBytes = null,
}) {
    await readPicture({ input, cwd, maxBytes });
    return await padImage({
        input: toAbs(cwd, input),
        output: toAbs(cwd, output),
        width,
        height,
        color,
        cwd,
        signal,
        engine,
    });
}

/**
 * Fit a picture into a frame.
 *
 * `contain` puts the whole picture inside the frame and pads the rest with transparency, `cover`
 * fills the frame and cuts the overflow off, `fill` stretches the picture to the frame. The first
 * two keep the proportions.
 * @param {{ input: string, output: string, width: number, height: number, fit?: 'contain'|'cover'|'fill',
 *   cwd?: string, signal?: AbortSignal, engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, fit: string }>}
 * @exports
 * @ai.hint io
 */
export async function fitPicture({
    input, output, width, height, fit = 'cover', cwd = process.cwd(), signal = null,
    engine = 'auto', maxBytes = null,
}) {
    if (!FIT_MODES.includes(fit)) {
        throw new Error(`The fit mode must be one of: ${FIT_MODES.join(', ')}.`);
    }
    const bytes = await readPicture({ input, cwd, maxBytes });
    const fitted = await rasterFitToFrame({ bytes, width, height, fit, engine });
    if (!fitted) throw new Error(`The picture cannot be read: ${input}`);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, fitted);
    const frame = await decodeRgba(fitted, engine);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: fitted.length,
        width: frame.width,
        height: frame.height,
        fit,
    };
}

/**
 * Change the size of a picture.
 *
 * Both sides given — the picture is stretched to that frame. One side given — the other follows
 * the proportions. `maxSide` caps the longest side, `factor` multiplies it.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null,
 *   maxSide?: number|null, factor?: number|null, cwd?: string, signal?: AbortSignal,
 *   engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number, scaled: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function resizePicture({
    input, output, width = null, height = null, maxSide = null, factor = null,
    cwd = process.cwd(), signal = null, engine = 'auto', maxBytes = null,
}) {
    await readPicture({ input, cwd, maxBytes });
    if (maxSide) {
        return await downscaleImage({
            input: toAbs(cwd, input), output: toAbs(cwd, output), maxSide, cwd, signal, engine,
        });
    }
    if (factor) {
        return await upscaleImage({
            input: toAbs(cwd, input), output: toAbs(cwd, output), factor, cwd, signal, engine,
        });
    }
    if (!width && !height) {
        throw new Error('Give the width, the height, the longest side or the factor of the new size.');
    }
    const before = await rasterInfo(toAbs(cwd, input), { cwd, engine });
    let targetWidth = width ? Math.round(width) : before.width;
    let targetHeight = height ? Math.round(height) : before.height;
    if (width && !height) targetHeight = Math.max(1, Math.round(before.height * targetWidth / before.width));
    if (height && !width) targetWidth = Math.max(1, Math.round(before.width * targetHeight / before.height));
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    const scaled = targetWidth !== frame.width || targetHeight !== frame.height
        ? await rasterScale(frame, targetWidth, targetHeight, engine)
        : frame;
    const png = await encodeRgba(scaled, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
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

/**
 * Cut the uniform or transparent edges off a picture.
 * @param {{ input: string, output?: string, fuzz?: number|null, transparentOnly?: boolean,
 *   cwd?: string, signal?: AbortSignal, engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ changed: boolean, reason: string, before?: object, after?: object }>}
 * @exports
 * @ai.hint io
 */
export async function trimPicture({
    input, output = input, fuzz = 6, transparentOnly = false,
    cwd = process.cwd(), signal = null, engine = 'auto', maxBytes = null,
}) {
    await readPicture({ input, cwd, maxBytes });
    return await rasterTrim({
        input: toAbs(cwd, input),
        output: toAbs(cwd, output),
        fuzz,
        transparentOnly,
        cwd,
        signal,
        engine,
    });
}

/**
 * Cut a picture into a grid of tiles.
 * @param {{ input: string, outputDir: string, rows?: number, cols?: number, baseName?: string,
 *   cwd?: string, signal?: AbortSignal, engine?: string, maxBytes?: number|null }} options
 * @returns {Promise<{ source: { width: number, height: number }, tiles: Array<object> }>}
 * @exports
 * @ai.hint io
 */
export async function splitPicture({
    input, outputDir, rows = 1, cols = 1, baseName = 'tile', cwd = process.cwd(),
    signal = null, engine = 'auto', maxBytes = null,
}) {
    await readPicture({ input, cwd, maxBytes });
    const gridRows = Math.max(1, Math.min(20, Math.round(rows)));
    const gridCols = Math.max(1, Math.min(20, Math.round(cols)));
    if (gridRows === 1 && gridCols === 1) {
        throw new Error('Ask for more than one row or more than one column.');
    }
    const info = await rasterInfo(toAbs(cwd, input), { cwd, engine });
    const tiles = await rasterSplit({
        input: toAbs(cwd, input),
        outputDir,
        rows: gridRows,
        cols: gridCols,
        baseName,
        cwd,
        signal,
        engine,
    });
    return { source: { width: info.width, height: info.height }, tiles };
}

/**
 * Compare pictures: a labelled sheet, a map of the difference, or both.
 * @param {{ files: string[], output: string, cwd?: string, layout?: 'row'|'column'|'grid',
 *   frame?: string, gap?: number, background?: string, maxSide?: number, labels?: boolean,
 *   mode?: 'sheet'|'difference'|'both', signal?: AbortSignal, engine?: string,
 *   maxBytes?: number|null }} options
 * @returns {Promise<object>} The report of the comparison.
 * @exports
 * @ai.hint io
 */
export async function comparePictures({
    files, output, cwd = process.cwd(), layout = 'row', frame = '', gap = 8,
    background = 'transparent', maxSide = 768, labels = false, mode = 'sheet',
    signal = null, engine = 'auto', maxBytes = null,
}) {
    if (!Array.isArray(files) || files.length < 2 || files.length > 12) {
        throw new Error('A comparison needs from 2 to 12 pictures.');
    }
    const located = [];
    for (const file of files) {
        const inside = await resolveInside(cwd, file, { allowRoot: false });
        const bytes = await readPicture({ input: inside.abs, cwd, maxBytes });
        located.push({ abs: inside.abs, rel: inside.rel, bytes: bytes.length });
    }
    const result = await rasterCompare({
        files: located,
        output,
        cwd,
        layout,
        frame,
        gap,
        background,
        maxSide,
        labels,
        mode,
        signal,
        engine,
    });
    return { ...result, files: located.map((item) => item.rel) };
}
