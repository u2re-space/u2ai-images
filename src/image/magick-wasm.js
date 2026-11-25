/**
 * @file src/image/magick-wasm.js
 * @module image/magick-wasm
 * @purpose The ImageMagick of the wasm: the raster engine that works everywhere, even where
 *          nothing is installed.
 *
 *   The native ImageMagick is fast and it is on every desktop that has it installed. The
 *   wasm one is the fallback of the fallback: it is loaded only when the machine has no
 *   program, and it answers the same questions — decode, encode, resize, trim, count the
 *   colors, compare.
 *
 *   The adapter speaks the same language as every other adapter of the package: a frame
 *   is `{ width, height, data }` where `data` is a raw RGBA buffer. The rest of the
 *   package never touches a native type.
 *
 *   Three facts of the wasm shape the adapter, and they are the reasons it is a thin
 *   layer and not a direct port of the native commands:
 *
 *   - The pixels leave the wasm through the **raw formats**: `Rgba` for the pixels of a
 *     picture, and the read of the picture with the raw format is how a frame is built.
 *     The pixels are read **last** and **inside** the callback of the read: the picture is
 *     freed when the callback returns.
 *   - A frame goes **into** the wasm as the raw pixels of a picture of its own size: the
 *     settings of the read carry the width, the height and the format `Rgba`.
 *   - The PNG of the wasm is written as `Png32`: the plain `Png` of the wasm writes a
 *     palette of one bit, and the picture loses its colors. Every other format is
 *     written as it is.
 *
 *   The wasm is a big file, and it is loaded lazily and once.
 *
 * @depends @imagemagick/magick-wasm (optional)
 * @usedBy image/raster
 * @exports wasmAvailable, wasmDecode, wasmEncode, wasmScale, wasmMetadata, wasmTrim,
 *          wasmPaletteStats, wasmColorCount, wasmCompare, wasmVersion, wasmFormatOf
 * @ai.tags imagemagick, wasm, image, raster
 * @ai.hint io
 */

/** Cached module handle. null = not tried yet, false = unavailable, object = the module. */
let cached = null;

/**
 * The name of the format of a picture as the wasm knows it.
 *
 * The PNG is written as `Png32`: the plain `Png` of the wasm writes a palette of one bit,
 * and the picture loses its colors.
 */
const FORMAT_BY_NAME = Object.freeze({
    png: 'Png32',
    jpeg: 'Jpeg',
    jpg: 'Jpeg',
    webp: 'WebP',
    gif: 'Gif',
    bmp: 'Bmp',
    tiff: 'Tiff',
    tif: 'Tiff',
    avif: 'Avif',
    svg: 'Svg',
});

/**
 * The name of the format of a picture, as the wasm knows it.
 * @param {string} name
 * @returns {string|null} the name of the format, or null when the wasm does not know it
 * @exports
 * @ai.hint pure
 */
export function wasmFormatOf(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return FORMAT_BY_NAME[key] ?? null;
}

/**
 * The format of a picture, read off its first bytes.
 *
 * The wasm reads the bytes with the format named by the caller, and the caller often
 * does not know it: the magic of the file knows it better.
 * @param {Uint8Array} bytes
 * @returns {string|null} the name of the format
 * @ai.hint pure
 */
function sniffFormat(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (data.byteLength < 4) return null;
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'Png';
    if (data[0] === 0xff && data[1] === 0xd8) return 'Jpeg';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'Gif';
    if (data[0] === 0x42 && data[1] === 0x4d) return 'Bmp';
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'WebP';
    if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a) return 'Tiff';
    if (data[0] === 0x3c) return 'Svg';
    // The AVIF is an ISO-BMFF: the brand `avif` lies in the first bytes of the box.
    const head = String.fromCharCode(...data.subarray(4, 12));
    if (head.includes('ftypavif')) return 'Avif';
    return null;
}

/**
 * Load the wasm of ImageMagick once.
 *
 * The package is optional: a build without it still works through sharp and canvas.
 * @returns {Promise<object|null>} the module of the wasm, or null
 * @exports
 * @ai.hint io
 */
export async function wasmLib() {
    if (cached === null) {
        cached = (async () => {
            try {
                const module = await import('@imagemagick/magick-wasm');
                const wasmUrl = import.meta.resolve(process.arch === 'x64'
                    ? '@imagemagick/magick-wasm/x64/magick.wasm'
                    : '@imagemagick/magick-wasm/magick.wasm');
                const init = process.arch === 'x64'
                    ? module.initializeImageMagickx64
                    : module.initializeImageMagick;
                if (typeof init !== 'function') return false;
                const { readFile } = await import('node:fs/promises');
                await init(await readFile(new URL(wasmUrl)));
                return module;
            } catch {
                return false;
            }
        })();
    }
    const module = await cached;
    return module || null;
}

/**
 * Is the wasm of ImageMagick usable in this installation?
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function wasmAvailable() {
    return Boolean(await wasmLib());
}

/**
 * The version of ImageMagick inside the wasm.
 * @returns {Promise<string|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmVersion() {
    const module = await wasmLib();
    if (!module) return null;
    return String(module.Magick?.imageMagickVersion ?? 'wasm');
}

/**
 * Read a picture with the wasm and do something with it.
 *
 * The format is taken from the magic of the bytes when the caller does not name it.
 * @param {Uint8Array} bytes
 * @param {string|null} format the name of the format, as the wasm knows it
 * @param {Function} body what to do with the picture inside the wasm
 * @returns {Promise<unknown>} whatever the body returned
 * @ai.hint io
 */
async function withImage(bytes, format, body) {
    const module = await wasmLib();
    if (!module) return null;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (!data.byteLength) return null;
    const name = format ?? sniffFormat(data);
    if (!name) return null;
    const magickFormat = module.MagickFormat?.[name];
    if (!magickFormat) return null;
    try {
        return await module.ImageMagick.read(data, magickFormat, body);
    } catch {
        return null;
    }
}

/**
 * The raw pixels of a picture, as they are.
 *
 * The pixels are read last and inside the callback: the picture is freed when the
 * callback returns, and the bytes of the raw format are the only thing that leaves it.
 * @param {object} img the picture inside the wasm
 * @param {object} module the module of the wasm
 * @returns {Buffer} the raw RGBA bytes
 * @ai.hint io
 */
function rawPixels(img, module) {
    const out = img.write(module.MagickFormat.Rgba, (bytes) => bytes);
    return Buffer.from(out);
}

/**
 * A picture of the wasm out of a raw RGBA frame.
 * @param {object} module the module of the wasm
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @returns {object|null} the picture, or null when it cannot be made
 * @ai.hint io
 */
function pictureOf(module, frame) {
    try {
        const settings = new module.MagickReadSettings();
        settings.width = frame.width;
        settings.height = frame.height;
        settings.format = module.MagickFormat.Rgba;
        return module.MagickImage.create(new Uint8Array(frame.data), settings);
    } catch {
        return null;
    }
}

/**
 * The metadata of a picture: the frame, the format and the presence of an alpha channel.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number, format: string, hasAlpha: boolean }|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmMetadata(bytes) {
    const module = await wasmLib();
    if (!module) return null;
    return await withImage(bytes, null, (img) => ({
        width: img.width,
        height: img.height,
        format: String(sniffFormat(bytes) ?? '').toLowerCase(),
        hasAlpha: Boolean(img.hasAlpha),
    }));
}

/**
 * Decode a picture into raw RGBA.
 *
 * The pixels come out of the wasm through the raw format `Rgba`: the same four channels
 * the rest of the package speaks.
 *
 * @param {Uint8Array} bytes
 * @param {{ maxSide?: number|null }} [options] Cap of the longest side while decoding.
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmDecode(bytes, { maxSide = null } = {}) {
    const module = await wasmLib();
    if (!module) return null;
    return await withImage(bytes, null, (img) => {
        if (maxSide) {
            const longest = Math.max(img.width, img.height);
            if (longest > maxSide) {
                const geometry = new module.MagickGeometry(maxSide, maxSide);
                geometry.ignoreAspectRatio = true;
                geometry.fillArea = false;
                img.resize(geometry);
            }
        }
        const data = rawPixels(img, module);
        return { width: img.width, height: img.height, data };
    });
}

/**
 * Encode a raw RGBA frame into a picture.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {{ format?: string, quality?: number }} [options] `png`, `jpeg` or `webp`.
 * @returns {Promise<Buffer|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmEncode(frame, { format = 'png', quality = 92 } = {}) {
    const module = await wasmLib();
    if (!module) return null;
    const name = wasmFormatOf(format);
    if (!name) return null;
    const magickFormat = module.MagickFormat?.[name];
    if (!magickFormat) return null;
    try {
        const image = pictureOf(module, frame);
        if (!image) return null;
        const bytes = image.write(magickFormat, (data) => data);
        return Buffer.from(bytes);
    } catch {
        return null;
    }
}

/**
 * Scale a raw RGBA frame into another frame.
 *
 * The frame goes through a picture of the wasm: the pixels are written in, the picture is
 * resized, and the pixels are read back out.
 * @param {{ width: number, height: number, data: Buffer }} frame
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmScale(frame, width, height) {
    const module = await wasmLib();
    if (!module) return null;
    if (frame.width === width && frame.height === height) return frame;
    try {
        const image = pictureOf(module, frame);
        if (!image) return null;
        const geometry = new module.MagickGeometry(width, height);
        geometry.ignoreAspectRatio = true;
        geometry.fillArea = true;
        image.resize(geometry);
        const data = rawPixels(image, module);
        return { width: image.width, height: image.height, data };
    } catch {
        return null;
    }
}

/**
 * Cut the uniform edges off a picture.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number }|null>} the frame after the trim
 * @exports
 * @ai.hint io
 */
export async function wasmTrim(bytes) {
    const module = await wasmLib();
    if (!module) return null;
    return await withImage(bytes, null, (img) => {
        img.trim();
        const data = rawPixels(img, module);
        return { width: img.width, height: img.height, bytes: data.byteLength };
    });
}

/**
 * The palette of a picture: the colors and how many pixels each of them covers.
 *
 * The histogram of the wasm is exact: the number of the colors of a picture is the
 * number of the entries of the map, and the count of a color is the number of the pixels
 * it covers.
 *
 * @param {Uint8Array} bytes
 * @param {{ limit?: number }} [options] The number of the colors reported.
 * @returns {Promise<Array<{ color: string, count: number }>>}
 * @exports
 * @ai.hint io
 */
export async function wasmPaletteStats(bytes, { limit = 64 } = {}) {
    const module = await wasmLib();
    if (!module) return [];
    return await withImage(bytes, null, (img) => {
        const map = img.histogram();
        const out = [];
        for (const [color, count] of map) {
            out.push({ color: String(color), count: Number(count) });
            if (out.length >= limit) break;
        }
        return out;
    });
}

/**
 * The number of the colors of a picture.
 * @param {Uint8Array} bytes
 * @returns {Promise<number|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmColorCount(bytes) {
    const palette = await wasmPaletteStats(bytes, { limit: 100_000 });
    return palette.length ? palette.length : null;
}

/**
 * Compare two pictures and report the numbers of the difference.
 * @param {Uint8Array} reference
 * @param {Uint8Array} result
 * @returns {Promise<{ rmse: number|null, ssim: number|null, ncc: number|null, psnr: number|null }|null>}
 * @exports
 * @ai.hint io
 */
export async function wasmCompare(reference, result) {
    const module = await wasmLib();
    if (!module) return null;
    const { ErrorMetric } = module;
    const name = sniffFormat(reference) ?? sniffFormat(result);
    if (!name) return null;
    const magickFormat = module.MagickFormat?.[name];
    try {
        return await module.ImageMagick.read(reference, magickFormat, (a) => (
            module.ImageMagick.read(result, magickFormat, (b) => ({
                rmse: a.compare(b, ErrorMetric.RootMeanSquared),
                ssim: a.compare(b, ErrorMetric.StructuralSimilarity),
                ncc: a.compare(b, ErrorMetric.NormalizedCrossCorrelation),
                psnr: a.compare(b, ErrorMetric.PeakSignalToNoiseRatio),
            }))
        ));
    } catch {
        return null;
    }
}
