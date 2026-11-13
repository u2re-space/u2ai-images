/**
 * @file src/image/sharp.js
 * @module image/sharp
 * @purpose The sharp adapter of the local raster layer: decoding to raw RGBA, encoding back,
 *          resampling and reading the metadata.
 * @depends sharp (optional, native)
 * @usedBy image/raster
 * @exports sharpAvailable, sharpDecode, sharpEncode, sharpScale, sharpMetadata
 * @ai.tags sharp, image, raster
 * @ai.hint io
 *
 * Every adapter of the package speaks the same language: a frame is
 * `{ width, height, data }` where `data` is a raw RGBA buffer. The rest of the package
 * never touches a native type, so a build without sharp still works through canvas.
 */

/** Cached module handle. null = not tried yet, false = unavailable, object = the module. */
let cached = null;

/**
 * Load sharp once. Returns the module or `null` when the native binary is missing.
 * @returns {Promise<object|null>}
 * @exports
 * @ai.hint io
 */
export async function sharpLib() {
    if (cached === null) {
        try {
            const module = await import('sharp');
            cached = module.default ?? module;
        } catch {
            cached = false;
        }
    }
    return cached || null;
}

/**
 * Is sharp usable in this installation?
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function sharpAvailable() {
    return Boolean(await sharpLib());
}

/**
 * The metadata of a picture: the frame, the format and the presence of an alpha channel.
 * @param {Buffer} bytes
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }|null>}
 * @exports
 * @ai.hint io
 */
export async function sharpMetadata(bytes) {
    const sharp = await sharpLib();
    if (!sharp) return null;
    const meta = await sharp(bytes).metadata();
    // The EXIF orientation 5..8 swaps the sides: the picture is shown turned.
    const swap = [5, 6, 7, 8].includes(meta.orientation);
    return {
        width: (swap ? meta.height : meta.width) ?? 0,
        height: (swap ? meta.width : meta.height) ?? 0,
        format: meta.format ?? '',
        hasAlpha: Boolean(meta.hasAlpha),
    };
}

/**
 * Decode a picture into raw RGBA.
 * @param {Buffer} bytes
 * @param {{ maxSide?: number|null }} [options] Cap of the longest side while decoding.
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @exports
 * @ai.hint io
 */
export async function sharpDecode(bytes, { maxSide = null } = {}) {
    const sharp = await sharpLib();
    if (!sharp) return null;
    let pipe = sharp(bytes).rotate();
    if (maxSide) pipe = pipe.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
    const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
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
export async function sharpScale(frame, width, height) {
    const sharp = await sharpLib();
    if (!sharp) return null;
    if (frame.width === width && frame.height === height) return frame;
    const { data } = await sharp(frame.data, {
        raw: { width: frame.width, height: frame.height, channels: 4 },
    })
        .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { width, height, data };
}

/**
 * Encode a raw RGBA frame into a picture.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {{ format?: string, quality?: number }} [options] `png`, `jpeg` or `webp`.
 * @returns {Promise<Buffer|null>}
 * @exports
 * @ai.hint io
 */
export async function sharpEncode(frame, { format = 'png', quality = 92 } = {}) {
    const sharp = await sharpLib();
    if (!sharp) return null;
    const pipe = sharp(frame.data, {
        raw: { width: frame.width, height: frame.height, channels: 4 },
    });
    if (format === 'jpeg' || format === 'jpg') return await pipe.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
    if (format === 'webp') return await pipe.webp({ quality }).toBuffer();
    return await pipe.png().toBuffer();
}
