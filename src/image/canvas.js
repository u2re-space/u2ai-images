/**
 * @file src/image/canvas.js
 * @module image/canvas
 * @purpose The node-canvas adapter of the local raster layer: the same operations as the sharp
 *          adapter, for the installations where the sharp binary is not there.
 * @depends canvas (optional, native)
 * @usedBy image/raster
 * @exports canvasAvailable, canvasDecode, canvasEncode, canvasScale, canvasMetadata
 * @ai.tags canvas, image, raster
 * @ai.hint io
 *
 * The adapter speaks the same language as the sharp one: a frame is
 * `{ width, height, data }` where `data` is a raw RGBA buffer. The canvas is only a
 * drawing surface — everything the package computes itself stays engine-independent.
 */

/** Cached module handle. null = not tried yet, false = unavailable, object = the module. */
let cached = null;

/**
 * Load node-canvas once. Returns the module or `null` when the native build is missing.
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasLib() {
    if (cached === null) {
        try {
            cached = await import('canvas');
        } catch {
            cached = false;
        }
    }
    return cached || null;
}

/**
 * Is node-canvas usable in this installation?
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function canvasAvailable() {
    return Boolean(await canvasLib());
}

/**
 * Draw a picture into a canvas and read the pixels back.
 * @param {Buffer} bytes
 * @param {{ width?: number, height?: number }} [options] The size of the surface; the picture is
 *   stretched into it.
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasDecode(bytes, { width = null, height = null } = {}) {
    const canvas = await canvasLib();
    if (!canvas) return null;
    const image = await canvas.loadImage(bytes);
    const targetWidth = width ?? image.width;
    const targetHeight = height ?? image.height;
    if (!targetWidth || !targetHeight) return null;
    const surface = canvas.createCanvas(targetWidth, targetHeight);
    const ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    const frame = ctx.getImageData(0, 0, targetWidth, targetHeight);
    return {
        width: targetWidth,
        height: targetHeight,
        data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length),
    };
}

/**
 * Scale a raw RGBA frame into another frame, keeping the pixels proportional.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasScale(frame, width, height) {
    const canvas = await canvasLib();
    if (!canvas) return null;
    if (frame.width === width && frame.height === height) return frame;
    const source = canvas.createCanvas(frame.width, frame.height);
    const sourceCtx = source.getContext('2d');
    const image = sourceCtx.createImageData(frame.width, frame.height);
    image.data.set(frame.data);
    sourceCtx.putImageData(image, 0, 0);
    const surface = canvas.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    const out = ctx.getImageData(0, 0, width, height);
    return {
        width,
        height,
        data: Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length),
    };
}

/**
 * Encode a raw RGBA frame into a picture.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {{ format?: string, quality?: number }} [options] `png`, `jpeg` or `webp`.
 * @returns {Promise<Buffer|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasEncode(frame, { format = 'png', quality = 0.92 } = {}) {
    const canvas = await canvasLib();
    if (!canvas) return null;
    const surface = canvas.createCanvas(frame.width, frame.height);
    const ctx = surface.getContext('2d');
    const image = ctx.createImageData(frame.width, frame.height);
    image.data.set(frame.data);
    ctx.putImageData(image, 0, 0);
    if (format === 'jpeg' || format === 'jpg') return surface.toBuffer('image/jpeg', { quality });
    if (format === 'webp') return surface.toBuffer('image/webp', { quality });
    return surface.toBuffer('image/png');
}

/**
 * The frame of a picture. The format is not reported: the canvas does not know it, and the
 * callers that care about the format read the magic bytes themselves.
 * @param {Buffer} bytes
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }|null>}
 * @exports
 * @ai.hint io
 */
export async function canvasMetadata(bytes) {
    const canvas = await canvasLib();
    if (!canvas) return null;
    const image = await canvas.loadImage(bytes);
    return { width: image.width ?? 0, height: image.height ?? 0, format: '', hasAlpha: true };
}
