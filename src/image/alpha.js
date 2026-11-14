/**
 * @file src/image/alpha.js
 * @module image/alpha
 * @purpose Build a real alpha channel for a picture: the background is cut off, and the edge of
 *          the object keeps an anti-aliased transition instead of a halo.
 * @depends node:path, node:fs/promises, image/raster, openai/images, model/profiles
 * @usedBy commands/alpha, commands/background, commands/generate, commands/edit
 * @exports CUTOUT_PROMPT, ALPHA_MODES, MATTE_MODELS,
 *          MIN_CLEARED_SHARE, MAX_SOFT_SHARE, MIN_SOFT_PIXELS, hasRealAlpha, localKeyAlpha,
 *          localMatte, flatAlphaFallback, isFakePlate, judgeAlphaShares, clearedShare, softShare,
 *          frameFor, maskPassModel, alphaModels, askModel, isRaster, applyGeneratedAlphaMask,
 *          alphaFormatWarning
 * @ai.tags images, alpha, background, matte
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The pipeline, in order:
 * 1. The picture already carries a real alpha channel — keep it.
 * 2. The model cuts the subject out itself: the models of the cut-out carry transparency
 *    natively, so the picture is asked with a transparent background and the alpha of the answer
 *    is the answer.
 * 3. The local contour matte, when the model is not there or refused.
 * 4. The fill from the corners, then the key by the color of the border.
 */

import path from 'node:path';
import { readFile, unlink, writeFile, copyFile } from 'node:fs/promises';
import { sniffImage } from '../openai/images.js';
import { imageModelProfile } from '../model/profiles.js';
import { purposeModels } from '../model/purpose.js';
import { isModelUnknown } from '../openai/fallback.js';
import { IMAGE_SIZES } from './sizing.js';
import {
    decodeRgba,
    encodeRgba,
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
 * The prompt of the cut-out: the model takes the subject out itself.
 *
 * The models of the cut-out carry transparency natively, so nothing has to be painted and no
 * matte has to be drawn: the picture is asked for its subject on a transparent background, and
 * the alpha that comes back is the answer.
 */
export const CUTOUT_PROMPT = 'Cut the subject out of the attached picture: keep the subject, its colors, its details, '
    + 'its proportions and its position exactly as they are, and make everything around it fully transparent. '
    + 'Do not crop, move, resize or repaint the subject, do not add anything, and keep the frame of the picture.';

/** The modes of the alpha pipeline. */
export const ALPHA_MODES = Object.freeze(['auto', 'mask', 'contour', 'flat', 'key', 'off']);

/**
 * The models that draw a matte.
 *
 * A cut-out is a technical task, and only two of the picture models do it well: the sunburst of
 * OpenAI and the seedream of ByteDance. The other models answer with a picture of a picture, and
 * the matte that comes out of it is a wide glow instead of an edge — so they are never asked for
 * a matte.
 */
export const MATTE_MODELS = Object.freeze([
    'openai/gpt-image-2.6-sunburst',
    'bytedance-seed/seedream-5-5',
]);

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
 * The models that draw the matte, in the order they are tried.
 *
 * The list is short on purpose: only `gpt-image-2.6-sunburst` and `seedream-5-5` are asked for a
 * cut-out. A model named by the user is honoured when it is one of them — it goes first, and the
 * other one is the fallback. `image.maskModel` is the technical override: it is taken as it is,
 * and `self` means the model that drew the picture.
 * @param {{ config?: object|null, model?: string|null }} options
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function alphaModels({ config = null, model = null } = {}) {
    const mask = String(config?.image?.maskModel ?? '').trim();
    if (mask) {
        if (SELF_MASK_MODELS.has(mask.toLowerCase())) {
            const own = String(model ?? config?.imageModel ?? '').trim();
            return own ? [own] : [];
        }
        return [mask];
    }
    const chain = [];
    const own = String(model ?? '').trim();
    if (own && MATTE_MODELS.includes(own)) chain.push(own);
    const configured = purposeModels(config, 'remove_background')
        .filter((name) => MATTE_MODELS.includes(name));
    for (const name of [...configured, ...MATTE_MODELS]) {
        if (!chain.includes(name)) chain.push(name);
    }
    return chain;
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
 * raster. The cut-out is a technical request, so it goes to `image.maskModel` (`self` = the model
 * that drew the picture), then to the picture model of the caller.
 * @param {{ client: object, config?: object|null, file: string, prompt: string,
 *   signal?: AbortSignal, model?: string|null, background?: string|null }} options
 * @returns {Promise<{ bytes: Buffer, ext: string, mime: string, model: string|null }|{ error: Error }|null>}
 * @exports
 * @ai.hint io
 */
export async function askModel({ client, config = null, file, prompt, signal, model = null, background = null }) {
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
            background,
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
 * The model pass of the alpha pipeline: the model cuts the subject out itself.
 *
 * The models of the cut-out carry transparency natively, so the picture is asked with a
 * transparent background and the alpha of the answer is the answer — no matte, no painted
 * background, no second generation. The answer is judged before it is accepted: a picture
 * without a real alpha, or one that leaves a wide halo around the edge, is not a cut-out.
 * @param {{ client: object, config?: object|null, base: string, abs: string, cwd: string,
 *   signal?: AbortSignal, model?: string|null, engine?: string, totalPixels?: number }} options
 * @returns {Promise<{ applied: boolean, error?: Error, model?: string|null, verdict?: object }>}
 * @ai.hint io
 */
async function modelAlphaPass({ client, config, base, abs, cwd, signal, model, engine, totalPixels }) {
    const answer = await askModel({
        client, config, file: base, prompt: CUTOUT_PROMPT, signal, model, background: 'transparent',
    });
    if (!isRaster(answer)) {
        return { applied: false, error: answer?.error ?? new Error('The model answered without a picture.') };
    }
    // The answer is built aside: a picture that is not a cut-out must not reach the file.
    const outPath = path.join(cwd, `.tmp-alpha-out-${process.pid}-${Date.now()}.png`);
    try {
        // The file of the result is a PNG: a host that answered with another format is converted.
        const bytes = answer.ext === 'png'
            ? answer.bytes
            : await encodeRgba(await decodeRgba(answer.bytes, engine), { format: 'png' }, engine);
        await writeFile(outPath, bytes);
        const verdict = await judgeAlphaShares({ abs: outPath, cwd, engine, totalPixels });
        if (!verdict.usable) {
            return {
                applied: false,
                error: new Error(`The alpha of the model is not a cut-out (cleared ${verdict.cleared ?? 0}, `
                    + `soft ${verdict.soft ?? 0}).`),
                verdict,
            };
        }
        await copyFile(outPath, abs);
        return { applied: true, model: answer.model, verdict };
    } finally {
        await unlink(outPath).catch(() => {});
    }
}

/**
 * Build a real alpha channel for a saved picture.
 *
 * The order of `auto`: a native alpha channel, then the model that cuts the subject out, then the
 * local contour matte, then the fill from the corners, then the key by the color of the border.
 * The forced modes run only their own step; `off` leaves the picture alone.
 *
 * `alphaSource` names the clean RGB base — the reference, the measurement crop, or the file
 * before the upscale — so the alpha is never derived from a picture that already carries a painted
 * transparency plate.
 * @param {{ client?: object|null, config?: object|null, file: string, signal?: AbortSignal,
 *   model?: string|null, alphaSource?: string|null, feather?: number,
 *   alphaMode?: string }} options
 * @returns {Promise<{ changed: boolean, reason: string, model?: string|null,
 *   source?: string|null, softEdge?: boolean, error?: Error }>}
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
        source: base === abs ? null : path.relative(process.cwd(), base).split(path.sep).join('/'),
        ...(softEdge ? { softEdge: true } : {}),
    };
    /** Why the model did not deliver a cut-out; reported with the local fallback. */
    let lastError = null;

    // 1. The model cuts the subject out itself: it is asked for a transparent background.
    if ((mode === 'auto' || mode === 'mask') && client?.images) {
        for (const candidate of alphaModels({ config, model })) {
            const result = await modelAlphaPass({
                client, config, base, abs, cwd, signal, model: candidate, engine, totalPixels,
            });
            if (result.applied) {
                return {
                    ...merged,
                    changed: true,
                    reason: 'model',
                    model: result.model,
                };
            }
            lastError = result.error ?? lastError;
            // The next model is asked when this one is not known to the hosts, or when its answer
            // is not a cut-out: another model may cut the same subject properly.
            if (!result.verdict && !isModelUnknown(result.error)) break;
        }
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
