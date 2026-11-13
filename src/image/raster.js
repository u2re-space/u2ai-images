/**
 * @file src/image/raster.js
 * @module image/raster
 * @purpose The local raster layer of the CLI: the order of the engines (sharp → canvas →
 *          ImageMagick), the frame-level operations (crop, pad, trim, split, fit) and the alpha
 *          helpers that the background removal is built on.
 * @depends node:path, node:fs/promises, image/sharp, image/canvas, image/magick, image/svg
 * @usedBy openai/client, commands/*, roles/*
 * @exports rasterEngine, rasterInfo, rasterIsOpaque, rasterAlphaShare, rasterAlphaSoftShare,
 *          decodeRgba, encodeRgba, rasterScale, rasterFitToFrame, rasterCrop, rasterPatch,
 *          rasterTrim, rasterSplit, rasterPadImageBytes, rasterRemoveImagePadding,
 *          rasterApplyAlphaMask, rasterColorKeyAlpha, rasterLocalAlphaMatte,
 *          rasterLocalAlphaMask, rasterBorderKey, rasterDetectFakeTransparency, rasterizeSvg,
 *          getRaster, fitBox
 * @ai.tags image, raster, crop, pad, trim, alpha
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * Every engine speaks one language: a frame is `{ width, height, data }` with `data` as a raw
 * RGBA buffer. The operations that decide something — the trim of the uniform edges, the key of
 * the background, the matte of the object — are computed here, on the pixels, so they give the
 * same answer on every engine. The engine only decodes, resamples and encodes.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
    canvasDecode,
    canvasEncode,
    canvasMetadata,
    canvasScale,
} from './canvas.js';
import {
    sharpDecode,
    sharpEncode,
    sharpMetadata,
    sharpScale,
} from './sharp.js';
import { isSvgBytes, svgToPng } from './svg.js';
import { detectMagick } from './magick.js';

/**
 * Resolve a path that may be relative to the working directory.
 * @param {string} cwd
 * @param {string} file
 * @returns {string}
 * @ai.hint pure
 */
function toAbs(cwd, file) {
    return path.isAbsolute(file) ? file : path.join(cwd, file);
}

/**
 * The order of the engines: sharp is the fastest and does not start a process, canvas covers the
 * installations without the sharp binary, ImageMagick is the last resort.
 * @param {'auto'|'sharp'|'canvas'|'magick'} preferred
 * @returns {Promise<'sharp'|'canvas'|'magick'|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterEngine(preferred = 'auto') {
    if (preferred === 'magick') {
        return (await detectMagick()) ? 'magick' : null;
    }
    if (preferred === 'canvas') {
        const canvas = await import('./canvas.js');
        return (await canvas.canvasAvailable()) ? 'canvas' : null;
    }
    const sharp = await import('./sharp.js');
    if (await sharp.sharpAvailable()) return 'sharp';
    const canvas = await import('./canvas.js');
    if (await canvas.canvasAvailable()) return 'canvas';
    return null;
}

/**
 * The box that fits a source proportionally into a cell: centered, never stretched.
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @returns {{ x: number, y: number, width: number, height: number, scale: number }}
 * @exports
 * @ai.hint pure
 */
export function fitBox(sourceWidth, sourceHeight, cellWidth, cellHeight) {
    if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(cellWidth > 0) || !(cellHeight > 0)) {
        return { x: 0, y: 0, width: Math.max(1, cellWidth), height: Math.max(1, cellHeight), scale: 1 };
    }
    const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    return {
        x: Math.round((cellWidth - width) / 2),
        y: Math.round((cellHeight - height) / 2),
        width,
        height,
        scale,
    };
}

/**
 * Decode a picture into raw RGBA.
 *
 * An SVG document is rendered first: a dedicated renderer keeps the gradients, the masks and the
 * text metrics of the document closer to the source than the SVG side of a raster library.
 * @param {Buffer} bytes
 * @param {'auto'|'sharp'|'canvas'|'magick'} [preferred='auto'] The engine of the caller.
 * @param {number|null} [maxSide=null] The cap of the longest side while decoding.
 * @returns {Promise<{ width: number, height: number, data: Buffer }>}
 * @exports
 * @ai.hint io
 */
export async function decodeRgba(bytes, preferred = 'auto', maxSide = null) {
    if (preferred !== 'canvas' && isSvgBytes(bytes)) {
        const rendered = await svgToPng(bytes, { width: maxSide, height: maxSide }).catch(() => null);
        if (rendered) return await decodeRgba(rendered.png, preferred, null);
    }
    const sharp = await import('./sharp.js');
    if (preferred !== 'canvas' && await sharp.sharpAvailable()) {
        const frame = await sharp.sharpDecode(bytes, { maxSide });
        if (frame) return frame;
    }
    const canvas = await import('./canvas.js');
    if (await canvas.canvasAvailable()) {
        const frame = await canvas.canvasDecode(bytes);
        if (frame) return frame;
    }
    throw new Error('No local raster engine is available: install sharp or canvas.');
}

/**
 * Encode a raw RGBA frame into a picture.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {{ format?: string, quality?: number }} [options]
 * @param {'auto'|'sharp'|'canvas'} [preferred='auto']
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function encodeRgba(frame, { format = 'png', quality = 92 } = {}, preferred = 'auto') {
    const sharp = await import('./sharp.js');
    if (preferred !== 'canvas' && await sharp.sharpAvailable()) {
        const bytes = await sharp.sharpEncode(frame, { format, quality });
        if (bytes) return bytes;
    }
    const canvas = await import('./canvas.js');
    if (await canvas.canvasAvailable()) {
        const bytes = await canvas.canvasEncode(frame, { format, quality });
        if (bytes) return bytes;
    }
    throw new Error('No local raster engine is available: install sharp or canvas.');
}

/**
 * Scale a raw RGBA frame into another frame, keeping the pixels proportional.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} width
 * @param {number} height
 * @param {'auto'|'sharp'|'canvas'} [preferred='auto']
 * @returns {Promise<{ width: number, height: number, data: Buffer }>}
 * @exports
 * @ai.hint io
 */
export async function rasterScale(frame, width, height, preferred = 'auto') {
    if (frame.width === width && frame.height === height) return frame;
    const sharp = await import('./sharp.js');
    if (preferred !== 'canvas' && await sharp.sharpAvailable()) {
        const scaled = await sharp.sharpScale(frame, width, height);
        if (scaled) return scaled;
    }
    const canvas = await import('./canvas.js');
    if (await canvas.canvasAvailable()) {
        const scaled = await canvas.canvasScale(frame, width, height);
        if (scaled) return scaled;
    }
    throw new Error('No local raster engine is available: install sharp or canvas.');
}

/**
 * Paint one RGBA frame onto a sheet at an offset, honouring its alpha.
 * @param {{ width: number, height: number, data: Buffer }} sheet
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} x
 * @param {number} y
 * @returns {void}
 * @ai.hint pure
 */
function blit(sheet, frame, x, y) {
    for (let row = 0; row < frame.height; row++) {
        const targetY = y + row;
        if (targetY < 0 || targetY >= sheet.height) continue;
        for (let col = 0; col < frame.width; col++) {
            const targetX = x + col;
            if (targetX < 0 || targetX >= sheet.width) continue;
            const from = (row * frame.width + col) * 4;
            const alpha = frame.data[from + 3];
            if (alpha === 0) continue;
            const to = (targetY * sheet.width + targetX) * 4;
            if (alpha === 255 || sheet.data[to + 3] === 0) {
                sheet.data[to] = frame.data[from];
                sheet.data[to + 1] = frame.data[from + 1];
                sheet.data[to + 2] = frame.data[from + 2];
                sheet.data[to + 3] = Math.max(sheet.data[to + 3], alpha);
                continue;
            }
            // Source-over on an already painted pixel keeps the composite honest.
            const outAlpha = alpha + sheet.data[to + 3] * (1 - alpha / 255);
            for (let channel = 0; channel < 3; channel++) {
                const top = frame.data[from + channel] * alpha
                    + sheet.data[to + channel] * sheet.data[to + 3] * (1 - alpha / 255);
                sheet.data[to + channel] = Math.round(outAlpha > 0 ? top / outAlpha : 0);
            }
            sheet.data[to + 3] = Math.round(outAlpha);
        }
    }
}

/**
 * The metadata of one local picture.
 * @param {string} file The path of the picture.
 * @param {{ cwd?: string, engine?: 'auto'|'sharp'|'canvas'|'magick' }} [options]
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function rasterInfo(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    const bytes = await readFile(toAbs(cwd, file));
    if (engine !== 'canvas' && isSvgBytes(bytes)) {
        const rendered = await svgToPng(bytes).catch(() => null);
        if (rendered) return { width: rendered.width, height: rendered.height, format: 'svg', hasAlpha: true };
    }
    const sharp = await import('./sharp.js');
    if (engine !== 'canvas' && await sharp.sharpAvailable()) {
        const meta = await sharp.sharpMetadata(bytes);
        if (meta) return meta;
    }
    const canvas = await import('./canvas.js');
    if (await canvas.canvasAvailable()) {
        const meta = await canvas.canvasMetadata(bytes);
        if (meta) return meta;
    }
    const exe = await detectMagick();
    if (exe) {
        const { magickIdentify } = await import('./magick.js');
        const meta = await magickIdentify({ exe, input: toAbs(cwd, file), cwd });
        return { width: meta.width, height: meta.height, format: meta.format, hasAlpha: true };
    }
    throw new Error('No local raster engine is available: install sharp or canvas.');
}

/**
 * Is the picture fully opaque? An alpha-capable format alone is not enough.
 * @param {string} file The path of the picture.
 * @param {{ cwd?: string, engine?: string }} [options]
 * @returns {Promise<boolean|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterIsOpaque(file, { cwd = process.cwd(), engine = 'auto' } = {}) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, file)), engine);
        for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] < 255) return false;
        return true;
    } catch {
        return null;
    }
}

/**
 * The cleared share of the frame: `1 - mean(alpha)`.
 *
 * A real cut-out removes a large part of the picture; a painted transparency plate leaves only a
 * thin fringe along the silhouette, which this measure reports as near zero.
 * @param {{ input: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>} 0..1, or `null` when the picture cannot be decoded.
 * @exports
 * @ai.hint io
 */
export async function rasterAlphaShare({ input, cwd = process.cwd(), engine = 'auto' }) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
        const total = frame.width * frame.height;
        if (!total) return null;
        let sum = 0;
        for (let i = 3; i < frame.data.length; i += 4) sum += frame.data[i];
        return 1 - sum / (total * 255);
    } catch {
        return null;
    }
}

/**
 * The share of the frame whose alpha sits in the soft band (`4% <= alpha < 96%`).
 *
 * A tight anti-aliased cut-out scores a fraction of a percent; a matte drawn with a wide glow
 * scores a fifth of the frame, which reads as a halo.
 * @param {{ input: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>} 0..1, or `null` when the picture cannot be decoded.
 * @exports
 * @ai.hint io
 */
export async function rasterAlphaSoftShare({ input, cwd = process.cwd(), engine = 'auto' }) {
    try {
        const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
        const total = frame.width * frame.height;
        if (!total) return null;
        let opaque = 0;
        let nonEmpty = 0;
        for (let i = 3; i < frame.data.length; i += 4) {
            if (frame.data[i] >= 245) opaque++;
            if (frame.data[i] >= 10) nonEmpty++;
        }
        return (nonEmpty - opaque) / total;
    } catch {
        return null;
    }
}

/**
 * The box that holds the content of a frame inside the padding.
 *
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {{ left: number, top: number, width: number, height: number }} box
 * @returns {{ width: number, height: number, data: Buffer }}
 * @ai.hint pure
 */
function cutFrame(frame, box) {
    const data = Buffer.alloc(box.width * box.height * 4);
    for (let row = 0; row < box.height; row++) {
        const from = ((box.top + row) * frame.width + box.left) * 4;
        frame.data.copy(data, row * box.width * 4, from, from + box.width * 4);
    }
    return { width: box.width, height: box.height, data };
}

/**
 * Cut a rectangle out of a picture and write it.
 * @param {{ input: string, output: string, x?: number, y?: number, width?: number, height?: number,
 *   cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterCrop({
    input, output, x = 0, y = 0, width, height, cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const source = await decodeRgba(bytes, engine);
    const left = Math.min(Math.max(0, Math.round(x)), Math.max(0, source.width - 1));
    const top = Math.min(Math.max(0, Math.round(y)), Math.max(0, source.height - 1));
    const box = {
        left,
        top,
        width: Math.max(1, Math.min(Math.round(width ?? source.width - left), source.width - left)),
        height: Math.max(1, Math.min(Math.round(height ?? source.height - top), source.height - top)),
    };
    const cut = cutFrame(source, box);
    const png = await encodeRgba(cut, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length,
        width: box.width,
        height: box.height,
    };
}

/**
 * Stitch a repaired fragment back into its picture at the exact box it was cut from.
 *
 * The counterpart of `rasterCrop`: the model never sees the whole picture, only the box, and
 * every pixel outside that box is copied from the untouched source instead of being resampled.
 * @param {{ input: string, patch: string, output: string, x?: number, y?: number,
 *   width?: number|null, height?: number|null, cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   box: {x:number,y:number,width:number,height:number}, resized: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function rasterPatch({
    input, patch, output, x = 0, y = 0, width = null, height = null,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const base = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    let frame = await decodeRgba(await readFile(toAbs(cwd, patch)), engine);
    signal?.throwIfAborted();
    const box = {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.max(1, Math.round(width ?? frame.width)),
        height: Math.max(1, Math.round(height ?? frame.height)),
    };
    // A patch wider or taller than the frame cannot be placed honestly; refusing is better than
    // silently clipping the repair into a corner.
    if (box.x + box.width > base.width || box.y + box.height > base.height) {
        throw new Error(`rasterPatch: the patch ${box.width}x${box.height} at (${box.x},${box.y}) does not fit the frame ${base.width}x${base.height}.`);
    }
    const resized = frame.width !== box.width || frame.height !== box.height;
    if (resized) frame = await rasterScale(frame, box.width, box.height, engine);
    // Copy, not blit: the repair replaces what was there, and an alpha the model returned must
    // not let the damaged pixel show through underneath.
    for (let row = 0; row < box.height; row++) {
        const from = row * box.width * 4;
        frame.data.copy(base.data, ((box.y + row) * base.width + box.x) * 4, from, from + box.width * 4);
    }
    const png = await encodeRgba(base, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: png.length,
        width: base.width,
        height: base.height,
        box,
        resized,
    };
}

/**
 * Fit a picture into a frame.
 *
 * `contain` puts the whole picture inside the frame and pads the rest with transparency,
 * `cover` fills the frame and cuts the overflow off, `fill` stretches the picture to the frame.
 * The first two keep the proportions.
 * @param {{ bytes: Buffer, width: number, height: number, fit?: 'contain'|'cover'|'fill',
 *   engine?: 'auto'|'sharp'|'canvas' }} options
 * @returns {Promise<Buffer|null>} The picture as PNG, or `null` when no engine is available.
 * @exports
 * @ai.hint io
 */
export async function rasterFitToFrame({
    bytes, width, height, fit = 'cover', engine = 'auto',
}) {
    const source = await decodeRgba(bytes, engine).catch(() => null);
    if (!source?.width || !source?.height) return null;
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));
    if (fit === 'fill') {
        const scaled = await rasterScale(source, targetWidth, targetHeight, engine);
        return await encodeRgba(scaled, { format: 'png' }, engine);
    }
    if (fit === 'contain') {
        const box = fitBox(source.width, source.height, targetWidth, targetHeight);
        const scaled = await rasterScale(source, box.width, box.height, engine);
        const sheet = { width: targetWidth, height: targetHeight, data: Buffer.alloc(targetWidth * targetHeight * 4) };
        blit(sheet, scaled, box.x, box.y);
        return await encodeRgba(sheet, { format: 'png' }, engine);
    }
    // Cover: scale until the frame is full, then cut the overflow in the middle.
    const scale = Math.max(targetWidth / source.width, targetHeight / source.height);
    const scaledWidth = Math.max(targetWidth, Math.round(source.width * scale));
    const scaledHeight = Math.max(targetHeight, Math.round(source.height * scale));
    const scaled = await rasterScale(source, scaledWidth, scaledHeight, engine);
    const offsetX = Math.round((scaledWidth - targetWidth) / 2);
    const offsetY = Math.round((scaledHeight - targetHeight) / 2);
    return await encodeRgba(cutFrame(scaled, {
        left: offsetX,
        top: offsetY,
        width: targetWidth,
        height: targetHeight,
    }), { format: 'png' }, engine);
}

/**
 * Cut the uniform or transparent padding off all four edges.
 * @param {{ input: string, output?: string, cwd?: string, signal?: AbortSignal, fuzz?: number|null,
 *   engine?: string, transparentOnly?: boolean }} options
 * @returns {Promise<{ changed: boolean, reason: string, before?: object, after?: object }>}
 * @exports
 * @ai.hint io
 */
export async function rasterTrim({
    input, output = input, cwd = process.cwd(), signal = null, fuzz = 6,
    engine = 'auto', transparentOnly = false,
}) {
    const before = await rasterInfo(input, { cwd, engine }).catch(() => null);
    if (!before?.width || !before.height) return { changed: false, reason: 'unreadable' };
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine);
    signal?.throwIfAborted();
    const tolerance = Math.max(0, Math.min(255, Math.round((Number.isFinite(fuzz) ? fuzz : 6) * 2.55)));
    const edge = { r: frame.data[0], g: frame.data[1], b: frame.data[2], a: frame.data[3] };
    /**
     * Does the pixel belong to the uniform edge?
     * @param {number} index The offset of the pixel in the RGBA buffer.
     * @returns {boolean}
     * @ai.hint pure
     */
    const matches = (index) => {
        const alpha = frame.data[index + 3];
        if (transparentOnly) return alpha === 0;
        if (edge.a === 0 || alpha === 0) return alpha === edge.a || (alpha <= tolerance && edge.a <= tolerance);
        return Math.abs(frame.data[index] - edge.r) <= tolerance
            && Math.abs(frame.data[index + 1] - edge.g) <= tolerance
            && Math.abs(frame.data[index + 2] - edge.b) <= tolerance;
    };
    /**
     * Is the whole row the uniform edge?
     * @param {number} y
     * @returns {boolean}
     * @ai.hint pure
     */
    const rowUniform = (y) => {
        for (let x = 0; x < frame.width; x++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    /**
     * Is the whole column the uniform edge?
     * @param {number} x
     * @returns {boolean}
     * @ai.hint pure
     */
    const columnUniform = (x) => {
        for (let y = 0; y < frame.height; y++) if (!matches((y * frame.width + x) * 4)) return false;
        return true;
    };
    let top = 0;
    let bottom = frame.height - 1;
    let left = 0;
    let right = frame.width - 1;
    while (top < bottom && rowUniform(top)) top++;
    while (bottom > top && rowUniform(bottom)) bottom--;
    while (left < right && columnUniform(left)) left++;
    while (right > left && columnUniform(right)) right--;
    const box = { width: right - left + 1, height: bottom - top + 1 };
    if (box.width === frame.width && box.height === frame.height) {
        return { changed: false, reason: 'no-padding', before, after: before };
    }
    if (box.width < frame.width * 0.1 || box.height < frame.height * 0.1) {
        return { changed: false, reason: 'too-small', before, after: box };
    }
    const result = await rasterCrop({
        input, output, x: left, y: top, width: box.width, height: box.height, cwd, signal, engine,
    });
    return { changed: true, reason: 'trimmed', before, after: { width: result.width, height: result.height } };
}

/**
 * Cut a picture into a grid of tiles.
 * @param {{ input: string, outputDir: string, rows: number, cols: number, cwd?: string,
 *   signal?: AbortSignal, baseName?: string, engine?: string }} options
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number, width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function rasterSplit({
    input, outputDir, rows, cols, cwd = process.cwd(), signal = null, baseName = 'tile', engine = 'auto',
}) {
    const info = await rasterInfo(input, { cwd, engine });
    if (!info.width || !info.height) throw new Error(`Cannot read the frame of: ${input}`);
    const tileWidth = Math.floor(info.width / cols);
    const tileHeight = Math.floor(info.height / rows);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileWidth;
            const y = row * tileHeight;
            const width = col === cols - 1 ? info.width - x : tileWidth;
            const height = row === rows - 1 ? info.height - y : tileHeight;
            const rel = `${outputDir}/${baseName}_r${row + 1}c${col + 1}.png`;
            const cut = await rasterCrop({
                input, output: rel, x, y, width, height, cwd, signal, engine,
            });
            tiles.push({
                rel, row: row + 1, col: col + 1, x, y, width, height, bytes: cut.bytes,
            });
        }
    }
    return tiles;
}

/**
 * Pad a picture with transparent pixels on the right and the bottom, without scaling the source.
 *
 * The source pixels stay in the top-left corner in their own scale, so the same box cuts the
 * padding back off the answer of the model. `targetWidth`/`targetHeight` raise the frame above
 * the 16-pixel grid — up to the smallest canvas the model accepts.
 * @param {{ bytes: Buffer, engine?: string, targetWidth?: number|null, targetHeight?: number|null }} options
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, originalWidth: number,
 *   originalHeight: number, padded: boolean, engine: string }|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterPadImageBytes({
    bytes, engine = 'auto', targetWidth = null, targetHeight = null,
}) {
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame?.height) return null;
    const width = Math.max(
        Math.ceil(frame.width / 16) * 16,
        Math.ceil(Math.max(1, Number(targetWidth) || 1) / 16) * 16,
    );
    const height = Math.max(
        Math.ceil(frame.height / 16) * 16,
        Math.ceil(Math.max(1, Number(targetHeight) || 1) / 16) * 16,
    );
    if (width === frame.width && height === frame.height) {
        return {
            bytes, width, height, originalWidth: frame.width, originalHeight: frame.height, padded: false, engine,
        };
    }
    const sheet = { width, height, data: Buffer.alloc(width * height * 4) };
    blit(sheet, frame, 0, 0);
    return {
        bytes: await encodeRgba(sheet, { format: 'png' }, engine),
        width,
        height,
        originalWidth: frame.width,
        originalHeight: frame.height,
        padded: true,
        engine,
    };
}

/**
 * Cut the padding off the answer of the model and restore the original frame.
 * @param {{ bytes: Buffer, width?: number, height?: number, originalWidth: number,
 *   originalHeight: number, engine?: string, normalized?: boolean }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function rasterRemoveImagePadding({
    bytes, width = null, height = null, originalWidth, originalHeight,
    engine = 'auto', normalized = false,
}) {
    if (width && height && width === originalWidth && height === originalHeight) return bytes;
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame?.height) return bytes;
    if (originalWidth > frame.width || originalHeight > frame.height) return bytes;
    const cropWidth = normalized && width
        ? Math.round(frame.width * originalWidth / width)
        : originalWidth;
    const cropHeight = normalized && height
        ? Math.round(frame.height * originalHeight / height)
        : originalHeight;
    if (!cropWidth || !cropHeight || cropWidth > frame.width || cropHeight > frame.height) return bytes;
    return await encodeRgba(cutFrame(frame, {
        left: 0, top: 0, width: cropWidth, height: cropHeight,
    }), { format: 'png' }, engine);
}

/**
 * The mean gray level of a matte and the gray level of its top-left corner.
 * @param {{ width: number, height: number, data: Buffer }} matte
 * @returns {{ mean: number, corner: number }}
 * @ai.hint pure
 */
function matteProbe(matte) {
    let sum = 0;
    let seen = 0;
    const step = matte.width > 256 || matte.height > 256 ? 4 : 1;
    for (let y = 0; y < matte.height; y += step) {
        for (let x = 0; x < matte.width; x += step) {
            const at = (y * matte.width + x) * 4;
            sum += 0.2126 * matte.data[at] + 0.7152 * matte.data[at + 1] + 0.0722 * matte.data[at + 2];
            seen++;
        }
    }
    const corner = 0.2126 * matte.data[0] + 0.7152 * matte.data[1] + 0.0722 * matte.data[2];
    return { mean: seen ? sum / seen / 255 : 0, corner: corner / 255 };
}

/**
 * Blur a one-channel buffer with a box filter.
 * @param {Buffer} alpha
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Buffer}
 * @ai.hint pure
 */
function boxBlur(alpha, width, height, radius) {
    if (radius < 1) return alpha;
    const out = Buffer.alloc(alpha.length);
    const window = radius * 2 + 1;
    for (let y = 0; y < height; y++) {
        let sum = 0;
        for (let x = -radius; x <= radius; x++) {
            sum += alpha[y * width + Math.min(width - 1, Math.max(0, x))];
        }
        for (let x = 0; x < width; x++) {
            out[y * width + x] = Math.round(sum / window);
            const leave = y * width + Math.min(width - 1, Math.max(0, x - radius));
            const enter = y * width + Math.min(width - 1, Math.max(0, x + radius + 1));
            sum += alpha[enter] - alpha[leave];
        }
    }
    const blurred = Buffer.alloc(alpha.length);
    for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = -radius; y <= radius; y++) {
            sum += out[Math.min(height - 1, Math.max(0, y)) * width + x];
        }
        for (let y = 0; y < height; y++) {
            blurred[y * width + x] = Math.round(sum / window);
            const leave = Math.min(height - 1, Math.max(0, y - radius)) * width + x;
            const enter = Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x;
            sum += out[enter] - out[leave];
        }
    }
    return blurred;
}

/**
 * The color of the background, read off the border of the frame.
 *
 * The border is the part of the picture the object does not touch, so the median of its pixels is
 * the plate color. The median, not the mean: a picture whose subject reaches the border has a few
 * stray samples, and one stray sample must not move the key.
 * @param {{ input: string, cwd?: string, engine?: string, ring?: number }} options
 * @returns {Promise<{ r: number, g: number, b: number }|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterBorderKey({ input, cwd = process.cwd(), engine = 'auto', ring = 2 }) {
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)).catch(() => null), engine).catch(() => null);
    if (!frame?.width || !frame?.height) return null;
    const depth = Math.max(1, Math.min(Math.floor(Math.min(frame.width, frame.height) / 4), Math.round(ring) || 1));
    const reds = [];
    const greens = [];
    const blues = [];
    /**
     * Take one pixel into the samples.
     * @param {number} index The offset of the pixel in the RGBA buffer.
     * @returns {void}
     * @ai.hint pure
     */
    const sample = (index) => {
        if (frame.data[index + 3] < 128) return;
        reds.push(frame.data[index]);
        greens.push(frame.data[index + 1]);
        blues.push(frame.data[index + 2]);
    };
    for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
            if (x >= depth && x < frame.width - depth && y >= depth && y < frame.height - depth) continue;
            sample((y * frame.width + x) * 4);
        }
    }
    if (!reds.length) return null;
    /**
     * The middle of the sorted samples.
     * @param {number[]} values
     * @returns {number}
     * @ai.hint pure
     */
    const median = (values) => {
        values.sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)];
    };
    return { r: median(reds), g: median(greens), b: median(blues) };
}

/**
 * Build a grayscale matte of the object of a picture, without a model.
 *
 * Three ways to tell the object from the background:
 * - `corners` — the background is the color of the corners;
 * - `contour` — the background is the color of the border, and the object is everything that
 *   differs from it;
 * - `saturation` — the background is a neutral plate, and the object is the colored part.
 *
 * The matte is white where the object is and black where the background is, with a soft band
 * between: a one-pixel gray transition is what keeps the edge of the cut clean.
 * @param {{ input: string, output: string, mode?: 'corners'|'contour'|'saturation', fuzz?: number,
 *   threshold?: number, cwd?: string, signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterLocalAlphaMask({
    input, output, mode = 'contour', fuzz = 10, threshold = 15,
    cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)).catch(() => null), engine).catch(() => null);
    if (!frame?.width || !frame?.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    const corners = [
        0,
        (frame.width - 1) * 4,
        (frame.height - 1) * frame.width * 4,
        (frame.height * frame.width - 1) * 4,
    ];
    const cornerKey = { r: 0, g: 0, b: 0 };
    for (const index of corners) {
        cornerKey.r += frame.data[index] / 4;
        cornerKey.g += frame.data[index + 1] / 4;
        cornerKey.b += frame.data[index + 2] / 4;
    }
    cornerKey.r = Math.round(cornerKey.r);
    cornerKey.g = Math.round(cornerKey.g);
    cornerKey.b = Math.round(cornerKey.b);
    const borderKey = mode === 'contour'
        ? await rasterBorderKey({ input, cwd, engine }).catch(() => null)
        : null;
    const key = borderKey ?? cornerKey;
    const tolerance = Math.max(0, Math.round((Number.isFinite(fuzz) ? fuzz : 10) * 2.55));
    const band = Math.max(4, Math.round((Number.isFinite(threshold) ? threshold : 15) * 2.55));
    const data = Buffer.alloc(frame.width * frame.height * 4);
    let subject = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
        let value = 0;
        if (mode === 'saturation') {
            const max = Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
            const min = Math.min(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
            const saturation = max - min;
            const low = Math.max(4, Math.round(threshold));
            value = Math.max(0, Math.min(255, Math.round((saturation - low) / low * 255)));
        } else {
            const distance = Math.max(
                Math.abs(frame.data[i] - key.r),
                Math.abs(frame.data[i + 1] - key.g),
                Math.abs(frame.data[i + 2] - key.b),
            );
            const low = mode === 'contour' ? Math.round(tolerance / 2) : tolerance;
            value = Math.max(0, Math.min(255, Math.round((distance - low) / band * 255)));
        }
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
        if (value > 128) subject++;
    }
    if (subject === 0 || subject === frame.width * frame.height) {
        return { changed: false, reason: subject === 0 ? 'empty-mask' : 'full-mask' };
    }
    const png = await encodeRgba({ width: frame.width, height: frame.height, data }, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return { changed: true, reason: mode, width: frame.width, height: frame.height };
}

/**
 * Turn a grayscale matte into an alpha channel and write the RGBA picture.
 *
 * An all-white or all-black matte is refused, a matte whose corner is white is inverted, and
 * `feather` smooths the transition band.
 * @param {{ input: string, mask: string, output?: string, cwd?: string, signal?: AbortSignal,
 *   feather?: number, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, inverted?: boolean, feathered?: number,
 *   width?: number, height?: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterApplyAlphaMask({
    input, mask, output = input, cwd = process.cwd(), signal = null, feather = 1, engine = 'auto',
}) {
    const base = await decodeRgba(await readFile(toAbs(cwd, input)).catch(() => null), engine).catch(() => null);
    if (!base?.width || !base.height) return { changed: false, reason: 'unreadable' };
    signal?.throwIfAborted();
    const matteSource = await decodeRgba(await readFile(toAbs(cwd, mask)).catch(() => null), engine).catch(() => null);
    if (!matteSource?.width || !matteSource.height) return { changed: false, reason: 'unreadable' };
    const matte = await rasterScale(matteSource, base.width, base.height, engine);
    const probe = matteProbe(matte);
    if (probe.mean <= 0.005) return { changed: false, reason: 'empty-mask' };
    if (probe.mean >= 0.995) return { changed: false, reason: 'full-mask' };
    const inverted = probe.corner > 0.5;
    const alpha = Buffer.alloc(matte.width * matte.height);
    for (let i = 0, p = 0; i < matte.data.length; i += 4, p++) {
        alpha[p] = inverted ? 255 - matte.data[i] : matte.data[i];
    }
    const smooth = Number.isFinite(feather) ? Math.max(0, Math.min(8, feather)) : 1;
    const blurred = smooth > 0
        ? boxBlur(alpha, matte.width, matte.height, Math.max(1, Math.round(smooth)))
        : alpha;
    const rgba = Buffer.alloc(base.width * base.height * 4);
    for (let p = 0, i = 0; p < blurred.length; p++, i += 4) {
        rgba[i] = base.data[i];
        rgba[i + 1] = base.data[i + 1];
        rgba[i + 2] = base.data[i + 2];
        rgba[i + 3] = blurred[p];
    }
    const png = await encodeRgba({ width: base.width, height: base.height, data: rgba }, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return {
        changed: true,
        reason: 'masked',
        inverted,
        feathered: smooth,
        width: base.width,
        height: base.height,
    };
}

/**
 * Remove the background by its color.
 * @param {{ input: string, output?: string, key: {r:number,g:number,b:number}, cwd?: string,
 *   signal?: AbortSignal, low?: number, high?: number, feather?: number, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, removed: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterColorKeyAlpha({
    input, output = input, key, cwd = process.cwd(), signal = null,
    low = 16, high = 56, feather = 0, engine = 'auto',
}) {
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine).catch(() => null);
    if (!frame?.width || !frame?.height) return { changed: false, reason: 'unreadable', removed: 0 };
    signal?.throwIfAborted();
    const distance = (index) => Math.max(
        Math.abs(frame.data[index] - key.r),
        Math.abs(frame.data[index + 1] - key.g),
        Math.abs(frame.data[index + 2] - key.b),
    );
    let removed = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
        const d = distance(i);
        if (d <= low) {
            frame.data[i + 3] = 0;
            removed++;
        } else if (d < high) {
            // The band between the two thresholds is smoothed out.
            frame.data[i + 3] = Math.round(255 * (d - low) / (high - low));
        }
    }
    if (feather > 0) {
        const alpha = Buffer.alloc(frame.width * frame.height);
        for (let p = 0, i = 3; p < alpha.length; p++, i += 4) alpha[p] = frame.data[i];
        const blurred = boxBlur(alpha, frame.width, frame.height, Math.max(1, Math.round(feather)));
        for (let p = 0, i = 3; p < blurred.length; p++, i += 4) frame.data[i] = blurred[p];
    }
    const png = await encodeRgba(frame, { format: 'png' }, engine);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, png);
    return { changed: removed > 0, reason: removed > 0 ? 'keyed' : 'no-match', removed };
}

/**
 * Build a matte of the picture by the color of its background, measured on the frame.
 * @param {{ input: string, output?: string, cwd?: string, signal?: AbortSignal, mode?: string,
 *   fuzz?: number, threshold?: number, engine?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, key: object|null }>}
 * @exports
 * @ai.hint io
 */
export async function rasterLocalAlphaMatte({
    input, output = input, cwd = process.cwd(), signal = null,
    mode = 'corners', fuzz = 10, threshold = 15, engine = 'auto',
}) {
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine).catch(() => null);
    if (!frame?.width || !frame?.height) return { changed: false, reason: 'unreadable', key: null };
    signal?.throwIfAborted();
    // The background is the color of the corners: the subject is what is left.
    const corners = [
        0,
        (frame.width - 1) * 4,
        (frame.height - 1) * frame.width * 4,
        (frame.height * frame.width - 1) * 4,
    ];
    const key = { r: 0, g: 0, b: 0 };
    for (const index of corners) {
        key.r += frame.data[index] / 4;
        key.g += frame.data[index + 1] / 4;
        key.b += frame.data[index + 2] / 4;
    }
    key.r = Math.round(key.r);
    key.g = Math.round(key.g);
    key.b = Math.round(key.b);
    const low = Math.max(4, Math.round(fuzz * 2.55));
    const high = low + Math.max(4, Math.round(threshold * 2.55));
    const result = await rasterColorKeyAlpha({
        input, output, key, cwd, signal, low, high, feather: 0, engine,
    });
    return { ...result, reason: result.reason === 'no-match' ? 'no-match' : 'matted', key, mode };
}

/**
 * Is the transparency of the picture a painted checkerboard instead of a real cut-out?
 *
 * A real cut-out has one dominant alpha — the background — and a clear foreground. A painted
 * plate alternates two grays in equal parts, and no color dominates.
 * @param {{ input: string, cwd?: string, signal?: AbortSignal, patch?: number, engine?: string }} options
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function rasterDetectFakeTransparency({
    input, cwd = process.cwd(), signal = null, patch = 16, engine = 'auto',
}) {
    const frame = await decodeRgba(await readFile(toAbs(cwd, input)), engine).catch(() => null);
    if (!frame?.width || !frame?.height) return false;
    signal?.throwIfAborted();
    // The corners of a painted plate carry the two grays of the checkerboard.
    const step = Math.max(1, Math.floor(Math.min(frame.width, frame.height) / patch) || 1);
    const tones = new Map();
    for (let y = 0; y < frame.height; y += step) {
        for (let x = 0; x < frame.width; x += step) {
            const index = (y * frame.width + x) * 4;
            if (frame.data[index + 3] < 16) continue;
            const tone = Math.round(
                (0.2126 * frame.data[index] + 0.7152 * frame.data[index + 1] + 0.0722 * frame.data[index + 2]) / 16,
            );
            tones.set(tone, (tones.get(tone) ?? 0) + 1);
        }
    }
    if (tones.size < 2) return false;
    const counts = [...tones.values()].sort((a, b) => b - a);
    const total = counts.reduce((sum, value) => sum + value, 0);
    if (!total) return false;
    // Two grays in equal parts and nothing else: that is a checkerboard, not an object.
    if (counts.length === 2 && Math.abs(counts[0] - counts[1]) / total < 0.2) return true;
    return counts[0] / total < 0.7 && counts.length >= 3;
}

/**
 * Rasterize an SVG document locally. No browser is started.
 * @param {{ input: string, output: string, width?: number|null, height?: number|null, cwd?: string,
 *   signal?: AbortSignal, engine?: string }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number }>}
 * @exports
 * @ai.hint io
 */
export async function rasterizeSvg({
    input, output, width = null, height = null, cwd = process.cwd(), signal = null, engine = 'auto',
}) {
    const bytes = await readFile(toAbs(cwd, input));
    signal?.throwIfAborted();
    const rendered = await svgToPng(bytes, { width, height });
    if (!rendered) throw new Error(`Cannot rasterize the SVG document: ${input}`);
    const outAbs = toAbs(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, rendered.png);
    return {
        rel: String(output).split(path.sep).join('/'),
        bytes: rendered.png.length,
        width: rendered.width,
        height: rendered.height,
    };
}

/**
 * The adapter of the local raster layer: the three operations the client needs to align a frame
 * and to scale an answer down.
 *
 * The adapter is created once and reused; a build without a native engine still gets an object,
 * but its methods report the failure instead of pretending the work was done.
 * @param {{ engine?: 'auto'|'sharp'|'canvas'|'magick', magickPath?: string|null }} [options]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function getRaster({ engine = 'auto', magickPath = null } = {}) {
    const active = await rasterEngine(engine);
    return {
        engine: active,
        /**
         * Pad a picture into a bigger canvas; the content keeps its scale in the corner.
         * @param {{ bytes: Buffer, targetWidth?: number|null, targetHeight?: number|null }} options
         * @returns {Promise<object|null>}
         */
        async padImageBytes({ bytes, targetWidth = null, targetHeight = null }) {
            return await rasterPadImageBytes({ bytes, engine: active ?? 'auto', targetWidth, targetHeight });
        },
        /**
         * Cut the padding off an answer and restore the original frame.
         * @param {{ bytes: Buffer, width?: number, height?: number, originalWidth: number, originalHeight: number }} options
         * @returns {Promise<Buffer>}
         */
        async removeImagePadding({ bytes, width = null, height = null, originalWidth, originalHeight }) {
            return await rasterRemoveImagePadding({
                bytes, width, height, originalWidth, originalHeight, engine: active ?? 'auto',
            });
        },
        /**
         * Fit a picture into a frame, keeping the proportions.
         * @param {{ bytes: Buffer, width: number, height: number, fit?: string }} options
         * @returns {Promise<Buffer|null>}
         */
        async fitToFrame({ bytes, width, height, fit = 'cover' }) {
            return await rasterFitToFrame({ bytes, width, height, fit, engine: active ?? 'auto' });
        },
    };
}
