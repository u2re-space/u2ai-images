/**
 * @file src/image/alpha.js
 * @module image/alpha
 * @purpose Build a real alpha channel for a picture: the background is cut off, and the edge of
 *          the object keeps an anti-aliased transition instead of a halo.
 * @depends node:path, node:fs/promises, image/raster, openai/images, model/profiles
 * @usedBy commands/alpha, commands/background, commands/generate, commands/edit
 * @exports ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, ALPHA_MODES, MIN_CLEARED_SHARE,
 *          MAX_SOFT_SHARE, MIN_SOFT_PIXELS, hasRealAlpha, localKeyAlpha, localMatte,
 *          flatAlphaFallback, isFakePlate, judgeAlphaShares, clearedShare, softShare, frameFor,
 *          maskPassModel, askModel, isRaster, applyGeneratedAlphaMask, alphaFormatWarning
 * @ai.tags images, alpha, background, matte
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The pipeline, in order:
 * 1. The picture already carries a real alpha channel — keep it.
 * 2. The model draws the matte (the geometry of the object) and, before that, paints the
 *    background with the color of the subject: over a white or a checkerboard plate the
 *    semi-transparent pixels of the edge keep the plate color and read as a halo, over the color
 *    of the subject they disappear.
 * 3. The local contour matte, when the model is not there or refused.
 * 4. The fill from the corners, then the key by the color of the border.
 *
 * The matte is always drawn from the clean source, never from the painted picture: the paint pass
 * may have moved or repainted the edge, and a matte taken from it would not match the artwork.
 */

import path from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { sniffImage } from '../openai/images.js';
import { imageModelProfile } from '../model/profiles.js';
import { IMAGE_SIZES } from './sizing.js';
import {
    rasterAlphaShare,
    rasterAlphaSoftShare,
    rasterApplyAlphaMask,
    rasterBorderKey,
    rasterColorKeyAlpha,
    rasterDetectFakeTransparency,
    rasterInfo,
    rasterIsOpaque,
    rasterLocalAlphaMask,
} from './raster.js';

/**
 * The prompt of the matte pass: a grayscale matte, not a transparent picture.
 *
 * Most vendors cannot emit alpha and paint a checkerboard or a flat plate instead, and a matte
 * converts cleanly into a real alpha channel. The transition must be one or two pixels wide: a
 * wide soft gradient makes the rim milky and eats into the artwork.
 */
export const ALPHA_MASK_PROMPT = 'Return an A-mask (matte) for the attached image that will be composited onto an RGB background to produce the final RGBA image. '
    + 'This is the alpha channel of a two-part composition: RGB + A-mask = RGBA. '
    + 'White (255) marks the subject that must stay visible — the artwork, logo, product, or person. '
    + 'Black (0) marks everything that must become transparent, including any checkerboard, grid, or flat plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, not a wide soft glow, and the interior of the subject pure white. '
    + 'The mask must trace the subject contour tightly: a one- or two-pixel gray transition exactly on the silhouette creates a clean anti-aliased edge in the final composite. '
    + 'Do not widen the transition into a soft glow — that makes the rim milky and eats into the artwork. Do not make alpha edges too blurry! '
    + 'The interior of the subject must be pure white; the transparent area must be pure black. '
    + 'Output the matte/mask only: grayscale, no colors, no text, no border, no shadow.';

/**
 * The prompt of the paint pass: the background takes the dominant color of the subject.
 */
export const BACKGROUND_PAINT_PROMPT = 'You are creating the RGB channel for a two-part RGBA composition (RGB + A-mask = RGBA). '
    + 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. '
    + 'This flat color will serve as the RGB base that the A-mask composites over: no gradients, no texture, no shadow, no new objects.';

/** The modes of the alpha pipeline. */
export const ALPHA_MODES = Object.freeze(['auto', 'mask', 'contour', 'flat', 'key', 'off']);

/**
 * The share of the frame that has to be cleared before the alpha counts as a real cut-out.
 * Below it the transparency is a fringe of a few pixels, not a background.
 */
export const MIN_CLEARED_SHARE = 0.03;

/**
 * The share of the frame that may sit in the soft band. Above it the edge is a wide glow, which
 * reads as a halo around the object.
 */
export const MAX_SOFT_SHARE = 0.05;

/**
 * The frame area below which the soft share is meaningless: a 10x10 picture has no edge to speak
 * of, and its ratio says nothing.
 */
export const MIN_SOFT_PIXELS = 100;

/** The formats that carry an alpha channel. */
const ALPHA_EXT = /\.(png|webp)$/i;

/** The formats a matte may be written in. */
const MASK_EXT = /\.(png|webp|jpe?g)$/i;

/** The models that draw the picture itself may also draw its matte. */
const SELF_MASK_MODELS = new Set(['self', 'same', 'generator']);

/**
 * Is the model a vector model? A vector model cannot draw a matte.
 * @param {string|null|undefined} model
 * @returns {boolean}
 * @ai.hint pure
 */
function isVectorModel(model) {
    const name = String(model ?? '').trim();
    return /recraft[^/]*vector/i.test(name) || /(?:^|\/)vector[^/]*$/i.test(name);
}

/**
 * The cleared share of the frame (`1 - mean(alpha)`), measured by the local engine.
 * @param {{ abs: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>}
 * @exports
 * @ai.hint io
 */
export async function clearedShare({ abs, cwd = path.dirname(abs), engine = 'auto' }) {
    return await rasterAlphaShare({ input: abs, cwd, engine }).catch(() => null);
}

/**
 * The share of the frame whose alpha sits in the soft band — the width of the edge transition.
 * @param {{ abs: string, cwd?: string, engine?: string }} options
 * @returns {Promise<number|null>}
 * @exports
 * @ai.hint io
 */
export async function softShare({ abs, cwd = path.dirname(abs), engine = 'auto' }) {
    return await rasterAlphaSoftShare({ input: abs, cwd, engine }).catch(() => null);
}

/**
 * Judge an alpha channel the picture already carries.
 *
 * Being "not opaque" is not enough: a single semi-transparent pixel passes that test, and it says
 * nothing about the quality of the edge. Two shares settle it — how much of the frame is cleared,
 * and how much of it sits in the soft band. A share that could not be measured leaves the alpha
 * at its word instead of forcing a rebuild.
 * @param {{ abs: string, cwd?: string, engine?: string, totalPixels?: number }} options
 * @returns {Promise<{ usable: boolean, cleared: number|null, soft: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function judgeAlphaShares({ abs, cwd = path.dirname(abs), engine = 'auto', totalPixels = Infinity }) {
    const [cleared, rawSoft] = await Promise.all([
        clearedShare({ abs, cwd, engine }),
        softShare({ abs, cwd, engine }),
    ]);
    const soft = totalPixels < MIN_SOFT_PIXELS ? null : rawSoft;
    const usable = (cleared === null || cleared >= MIN_CLEARED_SHARE)
        && (soft === null || soft <= MAX_SOFT_SHARE);
    return { usable, cleared, soft };
}

/**
 * Does the picture carry a usable alpha channel: a real cut-out, not a painted plate and not a
 * genuine channel whose soft edge would leave a halo.
 * @param {{ abs: string, cwd?: string, engine?: string }} options
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function hasRealAlpha({ abs, cwd = path.dirname(abs), engine = 'auto' }) {
    const opaque = await rasterIsOpaque(abs, { cwd, engine }).catch(() => null);
    if (opaque !== false) return false;
    const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
    const totalPixels = info?.width && info?.height ? info.width * info.height : Infinity;
    return (await judgeAlphaShares({ abs, cwd, engine, totalPixels })).usable;
}

/**
 * The frame of the technical pass, so the matte is not squeezed into a square.
 *
 * A model that takes an arbitrary frame gets the frame of the source exactly: the painted picture
 * this pass returns becomes the RGB base of the final file, so a preset frame here would rescale
 * the whole result and the caller would lose the dimensions of the source. A preset-only model
 * cannot take anything else, so the preset that keeps the aspect wins.
 * @param {{ width: number, height: number }|null} info
 * @param {string|null} [model]
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function frameFor(info, model = null) {
    if (!info?.width || !info?.height) return null;
    if (imageModelProfile(model).customSizes) return `${info.width}x${info.height}`;
    let best = IMAGE_SIZES[0];
    let bestDiff = Infinity;
    for (const preset of IMAGE_SIZES) {
        const [width, height] = preset.split('x').map(Number);
        const diff = Math.abs(info.width / info.height - width / height);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = preset;
        }
    }
    return best;
}

/**
 * The model the paint pass and the matte pass are charged to.
 *
 * - a name in `image.maskModel` → that model, whatever drew the picture;
 * - `self` → the model that drew the picture (the cleanest edge, billed as extra generations);
 * - `null` → the family default: the caller's model, then the picture model of the config.
 * @param {{ maskModel?: unknown, model?: string|null, imageModel?: string|null,
 *   preferGenerator?: boolean }} options
 * @returns {string|null} The model to use, or `null` when the caller decides its own default.
 * @exports
 * @ai.hint pure
 */
export function maskPassModel({ maskModel = null, model = null, imageModel = null, preferGenerator = false } = {}) {
    const requested = typeof maskModel === 'string' ? maskModel.trim() : '';
    const configured = imageModel && !isVectorModel(imageModel) ? imageModel : null;
    if (SELF_MASK_MODELS.has(requested.toLowerCase())) return model || configured || null;
    if (requested) return requested;
    return preferGenerator ? (model || configured || null) : null;
}

/**
 * Is the reply a picture, rather than a failed pass?
 * @param {{ bytes?: Buffer }|{ error?: Error }|null} reply
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isRaster(reply) {
    return Boolean(reply?.bytes?.length);
}

/**
 * Send one picture to the technical edit model and return the decoded reply when it is a readable
 * raster. Both the paint pass and the matte pass use this: they are technical requests, so they go
 * to `image.maskModel` (`self` = the model that drew the picture), then to the picture model of
 * the caller.
 * @param {{ client: object, config?: object|null, file: string, prompt: string,
 *   signal?: AbortSignal, model?: string|null }} options
 * @returns {Promise<{ bytes: Buffer, ext: string, mime: string, model: string|null }|{ error: Error }|null>}
 * @exports
 * @ai.hint io
 */
export async function askModel({ client, config = null, file, prompt, signal, model = null }) {
    const abs = path.resolve(file);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) return null;
    const kind = sniffImage(bytes);
    const engine = config?.image?.rasterEngine ?? 'auto';
    const info = await rasterInfo(abs, { cwd: path.dirname(abs), engine }).catch(() => null);
    const techModel = maskPassModel({
        maskModel: config?.image?.maskModel,
        model,
        imageModel: config?.imageModel,
        preferGenerator: true,
    });
    try {
        const answer = await client.images.edit({
            model: techModel,
            prompt,
            size: frameFor(info, techModel),
            format: 'png',
            signal,
            files: [{ filename: path.basename(abs), mime: kind.mime, bytes }],
        });
        const first = answer?.images?.[0];
        if (!first?.bytes?.length) return { error: new Error('The model answered without a picture.') };
        const reply = Buffer.from(first.bytes);
        const out = sniffImage(reply);
        if (!MASK_EXT.test(`.${out.ext}`)) {
            return { error: new Error(`The model returned not a raster (${out.ext}).`) };
        }
        return { bytes: reply, ext: out.ext, mime: out.mime, model: answer.model ?? techModel };
    } catch (error) {
        return { error };
    }
}

/**
 * Cut a flat background locally, by the color the frame is resting on, with no model call at all.
 *
 * The plate color is read off the border of the frame, so nothing has to be told to the model and
 * nothing has to be asked of it. It cannot recover an edge the model blended into that plate —
 * that is what the paint pass exists for — which is why `auto` keeps the two-pass pipeline and
 * this is the `key` mode.
 * @param {{ engine?: string, base: string, abs: string, cwd: string, signal?: AbortSignal,
 *   feather?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string, key?: { r: number, g: number, b: number } }>}
 * @exports
 * @ai.hint io
 */
export async function localKeyAlpha({ engine = 'auto', base, abs, cwd, signal, feather = 1 }) {
    const key = await rasterBorderKey({ input: base, cwd, engine }).catch(() => null);
    if (!key) return { changed: false, reason: 'no-plate-color' };
    const result = await rasterColorKeyAlpha({
        input: base, output: abs, key, cwd, signal, low: 16, high: 56, feather, engine,
    });
    return { ...result, key };
}

/**
 * True when the picture imitates transparency with a neutral checkerboard or a gray plate instead
 * of carrying an alpha channel. Such a file must never be used as the RGB base, and its matte has
 * to be drawn from saturation rather than from a corner color.
 * @param {{ engine?: string, base: string, cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function isFakePlate({ engine = 'auto', base, cwd, signal }) {
    return await rasterDetectFakeTransparency({ input: base, cwd, engine, signal }).catch(() => false);
}

/**
 * Draw a matte without a model.
 *
 * A painted checkerboard is separated by saturation (the plate is neutral, the artwork is not);
 * any other flat plate is separated by its own contour. When the first choice covers nothing, the
 * other one is tried.
 * @param {{ engine?: string, base: string, cwd: string, signal?: AbortSignal, fake?: boolean }} options
 * @returns {Promise<{ mask: string, reason: string }|null>}
 * @exports
 * @ai.hint io
 */
export async function localMatte({ engine = 'auto', base, cwd, signal, fake = false }) {
    const order = fake ? ['saturation', 'contour'] : ['contour', 'saturation'];
    for (const mode of order) {
        const mask = path.join(cwd, `.tmp-alpha-${mode}-${process.pid}-${Date.now()}.png`);
        try {
            const built = await rasterLocalAlphaMask({ input: base, output: mask, mode, cwd, signal, engine });
            if (built.changed) return { mask, reason: mode };
            await unlink(mask).catch(() => {});
        } catch {
            await unlink(mask).catch(() => {});
        }
    }
    return null;
}

/**
 * Remove a flat background without a model: the matte of the corners is written to a temporary
 * file, merged as alpha, and removed again.
 * @param {{ engine?: string, file: string, output?: string, cwd: string, signal?: AbortSignal,
 *   feather?: number }} options
 * @returns {Promise<{ changed: boolean, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function flatAlphaFallback({ engine = 'auto', file, output = file, cwd, signal, feather = 1 }) {
    const mask = path.join(cwd, `.tmp-alpha-flat-${process.pid}-${Date.now()}.png`);
    try {
        const built = await rasterLocalAlphaMask({
            input: file, output: mask, mode: 'corners', cwd, signal, engine,
        });
        if (!built.changed) return { changed: false, reason: built.reason };
        const applied = await rasterApplyAlphaMask({
            input: file, mask, output, cwd, signal, feather, engine,
        });
        return { changed: applied.changed, reason: applied.reason };
    } catch {
        return { changed: false, reason: 'failed' };
    } finally {
        await unlink(mask).catch(() => {});
    }
}

/**
 * The warning about a format that cannot carry an alpha channel.
 * @param {string} file
 * @returns {string|null} The message, or `null` when the format is fine.
 * @exports
 * @ai.hint pure
 */
export function alphaFormatWarning(file) {
    const ext = path.extname(String(file ?? '')).toLowerCase();
    if (ext !== '.jpg' && ext !== '.jpeg') return null;
    return 'JPEG carries no alpha channel: the transparency would be lost. Save the picture as PNG or WebP.';
}

/**
 * The two model passes of the alpha pipeline: the paint pass and the matte pass.
 * @param {{ client: object, config?: object|null, base: string, abs: string, cwd: string,
 *   signal?: AbortSignal, model?: string|null, paintBackground?: boolean, feather?: number,
 *   engine?: string }} options
 * @returns {Promise<{ applied: boolean, error?: Error, model?: string|null, painted?: boolean,
 *   inverted?: boolean, feathered?: number }>}
 * @ai.hint io
 */
async function modelAlphaPass({
    client, config, base, abs, cwd, signal, model, paintBackground, feather, engine,
}) {
    let paintedPath = null;
    let error = null;
    try {
        if (paintBackground) {
            const painted = await askModel({
                client, config, file: base, prompt: BACKGROUND_PAINT_PROMPT, signal, model,
            });
            if (isRaster(painted)) {
                paintedPath = path.join(cwd, `.tmp-alpha-painted-${process.pid}-${Date.now()}.png`);
                await writeFile(paintedPath, painted.bytes);
            } else {
                error = painted?.error ?? error;
            }
        }
        // The matte is the geometry of the subject: it is drawn from `base`, never from the painted
        // picture, whose edge the paint pass may have moved or repainted.
        const matteBase = paintedPath || base;
        const matte = await askModel({
            client, config, file: base, prompt: ALPHA_MASK_PROMPT, signal, model,
        });
        if (!isRaster(matte)) return { applied: false, error: matte?.error ?? error };
        const maskPath = path.join(cwd, `.tmp-alpha-mask-${process.pid}-${Date.now()}.${matte.ext}`);
        await writeFile(maskPath, matte.bytes);
        try {
            const applied = await rasterApplyAlphaMask({
                input: matteBase, mask: maskPath, output: abs, cwd, signal, feather, engine,
            });
            // A fully white matte means the model found nothing to cut: keep the picture as it is
            // instead of letting the fill eat a corner of the subject.
            if (applied.reason === 'full-mask') {
                return { applied: false, error: new Error('The model found nothing to cut out.') };
            }
            if (!applied.changed) {
                return { applied: false, error: new Error(`The matte could not be applied (${applied.reason}).`) };
            }
            return {
                applied: true,
                model: matte.model,
                painted: Boolean(paintedPath),
                inverted: applied.inverted,
                feathered: applied.feathered,
            };
        } finally {
            await unlink(maskPath).catch(() => {});
        }
    } finally {
        if (paintedPath) await unlink(paintedPath).catch(() => {});
    }
}

/**
 * Build a real alpha channel for a saved picture.
 *
 * The order of `auto`: a native alpha channel, then the model mask, then the local contour matte,
 * then the fill from the corners, then the key by the color of the border. The forced modes run
 * only their own step; `off` leaves the picture alone.
 *
 * `alphaSource` names the clean RGB base — the reference, the measurement crop, or the file
 * before the upscale — so the alpha is never derived from a picture that already carries a painted
 * transparency plate.
 * @param {{ client?: object|null, config?: object|null, file: string, signal?: AbortSignal,
 *   model?: string|null, alphaSource?: string|null, paintBackground?: boolean, feather?: number,
 *   alphaMode?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, model?: string|null, painted?: boolean,
 *   source?: string|null, softEdge?: boolean, inverted?: boolean, feathered?: number,
 *   error?: Error }>}
 * @exports
 * @ai.hint io
 */
export async function applyGeneratedAlphaMask({
    client = null,
    config = null,
    file,
    signal,
    model = null,
    alphaSource = null,
    paintBackground = config?.image?.paintBackground !== false,
    feather = config?.image?.alphaFeather ?? 1,
    alphaMode = config?.image?.alphaMode ?? 'auto',
} = {}) {
    const mode = String(alphaMode || 'auto').toLowerCase();
    if (mode === 'off') return { changed: false, reason: 'off' };
    const abs = path.resolve(file);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return { changed: false, reason: 'format' };
    const engine = config?.image?.rasterEngine ?? 'auto';
    const cwd = path.dirname(abs);
    const opaque = await rasterIsOpaque(abs, { cwd, engine }).catch(() => null);
    if (opaque === null) return { changed: false, reason: 'unknown' };
    const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
    const totalPixels = info?.width && info?.height ? info.width * info.height : Infinity;

    let softEdge = false;
    if (opaque === false) {
        const verdict = await judgeAlphaShares({ abs, cwd, engine, totalPixels });
        if (verdict.usable) return { changed: false, reason: 'already' };
        // A frame the model already cleared may still be unusable: a plate leaves only a fringe, and
        // a matte drawn with a wide glow leaves a halo. Both go through the pipeline.
        softEdge = (verdict.cleared ?? 0) >= MIN_CLEARED_SHARE;
    }

    // The base for the matte: a clean RGB file when the caller named one, otherwise the picture.
    const base = alphaSource && ALPHA_EXT.test(path.extname(alphaSource))
        ? path.resolve(cwd, alphaSource)
        : abs;
    const merged = {
        model: null,
        painted: false,
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
        ...(softEdge ? { softEdge: true } : {}),
    };
    /** Why the model passes did not deliver a matte; reported with the local fallback. */
    let lastError = null;

    // 1. The model: the background takes the color of the subject, the matte comes from the source.
    if ((mode === 'auto' || mode === 'mask') && client?.images) {
        const result = await modelAlphaPass({
            client, config, base, abs, cwd, signal, model, paintBackground, feather, engine,
        });
        if (result.applied) {
            return {
                ...merged,
                changed: true,
                reason: 'mask',
                model: result.model,
                painted: result.painted,
                inverted: result.inverted,
                feathered: result.feathered,
            };
        }
        lastError = result.error ?? lastError;
        if (mode === 'mask') return { ...merged, changed: false, reason: 'failed', error: lastError };
    }

    // 2. The local contour matte, then the fill from the corners.
    if (mode === 'auto' || mode === 'contour') {
        const fake = await isFakePlate({ engine, base, cwd, signal });
        const local = await localMatte({ engine, base, cwd, signal, fake });
        if (local) {
            const applied = await rasterApplyAlphaMask({
                input: base, mask: local.mask, output: abs, cwd, signal, feather, engine,
            });
            await unlink(local.mask).catch(() => {});
            if (applied.changed) {
                return { ...merged, ...applied, reason: local.reason, error: lastError };
            }
            lastError = new Error(`The local matte could not be applied (${applied.reason}).`);
        }
        if (mode === 'contour') return { ...merged, changed: false, reason: 'failed', error: lastError };
    }

    if (mode === 'auto' || mode === 'flat') {
        const flat = await flatAlphaFallback({ engine, file: base, output: abs, cwd, signal, feather });
        if (flat.changed) return { ...merged, ...flat, reason: 'flat', error: lastError };
        if (mode === 'flat') return { ...merged, changed: false, reason: flat.reason, error: lastError };
    }

    // 3. The key by the color of the border: the cheapest cut of all.
    if (mode === 'auto' || mode === 'key') {
        const keyed = await localKeyAlpha({ engine, base, abs, cwd, signal, feather });
        if (keyed.changed) return { ...merged, ...keyed, reason: 'key', error: lastError };
        if (mode === 'key') return { ...merged, changed: false, reason: keyed.reason, error: lastError };
    }

    return { ...merged, changed: false, reason: 'failed', error: lastError };
}
