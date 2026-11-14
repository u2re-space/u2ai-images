/**
 * @file src/image/sizing.js
 * @module image/sizing
 * @purpose The ladder of the frames: what the caller asks for, what the model accepts, and the
 *          order of the attempts when the host refuses the frame.
 * @exports IMAGE_SIZES, VECTOR_RATIOS, RIVERFLOW_RATIOS, RIVERFLOW_RESOLUTIONS, IMAGE_TIER_LIMITS,
 *          IMAGE_SIZES_BY_RESOLUTION, parseImageSize, getOrientation, getAspectDifference,
 *          supportedAspectRatios, aspectRatioToken, aspectImageSize, inferResolution, tierFromToken,
 *          presetImageSize, fromMinimalSize, computeSize, normalizeImageSize, makePad16Size,
 *          imageRequestSize, imageSizeFields, sameAspectImageSize, isImageSizeError,
 *          nearestRiverflowRatio, imageSizeAttempts, needsDiv16Padding, needsMinPixelsPadding,
 *          paddedSizeToMinPixels, paddedSizeToMinPixelsByResolution, alignmentPlan
 * @ai.tags image, sizing
 * @ai.hint legacy-0.2
 */

import {
    GPT_IMAGE_25,
    GPT_IMAGE_26,
    MAX_IMAGE_EDGE,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_RATIO,
    MIN_IMAGE_PIXELS,
    RIVERFLOW,
    imageModelProfile,
} from '../model/profiles.js';
import {
    RATIO_CEIL_EPSILON,
    STANDARD_RATIOS,
    aspectFrame,
    nearestAspect,
    parseAspectToken,
    rationalAspect,
} from './aspect.js';
/** Frame presets POST /images/generations and /images/edits accept for the preset-only models. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024']);

/**
 * Shapes recraft vector models accept. A request may name any other shape (`2.39:1`, `a4`,
 * `cinemascope`); `nearestAspect` rounds it to the closest entry of this list, which is the only
 * one the gateway answers to.
 */
export const VECTOR_RATIOS = Object.freeze(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', 'auto']);

/** Aspect ratios accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', 'auto']);

/** Resolution tiers accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RESOLUTIONS = Object.freeze(['512', '1K', '2K', '4K']);

/**
 * What one resolution tier stands for: the longest side it names and the pixel budget it implies.
 * A request that gives a shape but no pixel count (`2.39:1`, `wide`) gets its frame built from
 * these numbers, and no catalogue entry runs past the tier's own longest side.
 */
export const IMAGE_TIER_LIMITS = Object.freeze({
    '512': Object.freeze({ edge: 512, pixels: 512 * 512 }),
    '1k': Object.freeze({ edge: 1024, pixels: 1024 * 1024 }),
    '1.5k': Object.freeze({ edge: 1536, pixels: 1536 * 1536 }),
    '2k': Object.freeze({ edge: 2048, pixels: 2048 * 2048 }),
    '3k': Object.freeze({ edge: 3072, pixels: 3072 * 3072 }),
    '4k': Object.freeze({ edge: 4096, pixels: 4096 * 4096 }),
});

/**
 * Frames a family publishes for one tier. They stay first in the catalogue: a gateway that lists
 * `1024x1536` as its native 2K portrait answers it more faithfully than any computed frame.
 */
const NATIVE_TIER_SIZES = Object.freeze({
    '512': Object.freeze(['512x512']),
    '1k': Object.freeze(['1024x768', '768x1024', '1024x1024']),
    '1.5k': Object.freeze(['1536x1536', '1024x1536', '1536x1024', '1536x1152', '1152x1536']),
    '2k': Object.freeze(['1024x1536', '1536x1024', '2048x1536', '1536x2048', '2048x2048']),
    '3k': Object.freeze(['3072x3072', '3072x2048', '2048x3072', '3072x2304', '2304x3072']),
    '4k': Object.freeze(['4096x3072', '3072x4096', '4096x4096']),
});

/** Frames of one shape per resolution tier, for the families that serve no ratio field. */
export const PORTRAIT_SIZES = Object.freeze({
    '512': '384x512',
    '1k': '768x1024',
    '1.5k': '1152x1536',
    '2k': '1536x2048',
    '3k': '2304x3072',
    '4k': '3072x4096',
});

/** @see PORTRAIT_SIZES */
export const LANDSCAPE_SIZES = Object.freeze({
    '512': '512x384',
    '1k': '1024x768',
    '1.5k': '1536x1152',
    '2k': '2048x1536',
    '3k': '3072x2304',
    '4k': '4096x3072',
});

/** @see PORTRAIT_SIZES */
export const SQUARE_SIZES = Object.freeze({
    '512': '512x512',
    '1k': '1024x1024',
    '1.5k': '1536x1536',
    '2k': '2048x2048',
    '3k': '3072x3072',
    '4k': '4096x4096',
});

/**
 * One frame per standard shape inside one tier, built the same way a request is answered: the
 * shape as a fraction with terms within `RATIO_MAX_TERM`, scaled by a whole number of 16-pixel
 * increments up to the tier's pixel budget. This is what lets a tier-based model take `21:9` or
 * `5:4` at 2K instead of collapsing the request to the three frames the vendor happened to list.
 * @param {string} key a key of `IMAGE_TIER_LIMITS`
 * @returns {string[]}
 */
function tierCatalogue(key) {
    const limits = IMAGE_TIER_LIMITS[key];
    const frames = [...(NATIVE_TIER_SIZES[key] ?? [])];
    for (const ratio of STANDARD_RATIOS) {
        const frame = aspectFrame(ratio, { step: 16, pixels: limits.pixels, maxEdge: limits.edge });
        if (frame) {
            const token = `${frame.width}x${frame.height}`;
            if (!frames.includes(token)) frames.push(token);
        }
    }
    return Object.freeze(frames);
}

/**
 * Frames one tier offers, native presets first and then one per shape of `STANDARD_RATIOS`.
 * A tier-based model picks from this list; a model with free frames builds its own with
 * `aspectFrame` and only consults the catalogue when a gateway refuses the frame.
 */
export const IMAGE_SIZES_BY_RESOLUTION = Object.freeze(Object.fromEntries(
    Object.keys(IMAGE_TIER_LIMITS).map((key) => [key, tierCatalogue(key)]),
));

/**
 * Read a frame out of a `WIDTHxHEIGHT` token.
 * @param {string|null|undefined} value
 * @returns {{ width: number, height: number }|null}
 */
export function parseImageSize(value) {
    const match = /^(\d+)\s*x\s*(\d+)$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return null;
    return { width, height };
}

/**
 * The orientation of a frame.
 * @param {{ width: number, height: number }} frame
 * @returns {'square'|'portrait'|'landscape'}
 */
export function getOrientation({ width, height }) {
    if (width === height) return 'square';
    return height > width ? 'portrait' : 'landscape';
}

/**
 * How far two frames are from the same shape: the logarithmic distance, so a portrait and a
 * landscape are compared fairly.
 * @param {{ width: number, height: number }} a
 * @param {{ width: number, height: number }} b
 * @returns {number}
 */
export function getAspectDifference(a, b) {
    return Math.abs(Math.log((a.width / a.height) / (b.width / b.height)));
}

/**
 * The shapes one model is asked for by name: the ratio field of a tier-based gateway, the vector
 * ratio list, or the standard catalogue for a model that takes a literal frame.
 * @param {string|null|undefined} model
 * @param {'vector'|'image'|'auto'} [field] which field the ratio is headed for
 * @returns {readonly string[]}
 */
export function supportedAspectRatios(model, field = 'auto') {
    if (field === 'vector') return VECTOR_RATIOS;
    if (field === 'image' || imageModelProfile(model).resolutionTiers) return RIVERFLOW_RATIOS;
    return STANDARD_RATIOS;
}

/**
 * The shape a request names, rounded to a shape the model is asked about: `2.39:1` becomes `21:9`
 * for a riverflow ratio field and stays 31:13 for a model that draws the frame itself.
 * @param {string|number|{width: number, height: number}} value
 * @param {string|null|undefined} model
 * @param {'vector'|'image'|'auto'} [field]
 * @returns {string|null}
 */
export function aspectRatioToken(value, model = null, field = 'auto') {
    return nearestAspect(value, supportedAspectRatios(model, field));
}

/**
 * The pixel frame one shape names for one model at one tier: the shape as a fraction with terms
 * within `RATIO_MAX_TERM`, scaled by a whole number of 16-pixel increments up to the tier's pixel
 * budget and rounded up (with the `RATIO_CEIL_EPSILON` stickiness), then clamped to what the model
 * accepts. This is how `2.39:1`, `cinemascope`, or a `1919x1079` source reaches a free-frame model
 * as a real frame instead of a token the gateway would drop.
 * @param {string|number|null|undefined} value
 * @param {string|null|undefined} model
 * @param {string|null} [resolution] tier whose pixel budget the frame is built on
 * @returns {string|null} `WIDTHxHEIGHT`, or null when the token names no shape
 */
export function aspectImageSize(value, model = null, resolution = null) {
    const shape = parseAspectToken(value);
    if (!shape) return null;
    const caps = imageModelProfile(model);
    const tier = IMAGE_TIER_LIMITS[tierFromToken(resolution, model) || '1k'] || IMAGE_TIER_LIMITS['1k'];
    const frame = aspectFrame(shape.ratio, {
        step: 16,
        minPixels: caps.minPixels, maxPixels: caps.maxPixels,
        maxEdge: caps.maxEdge, maxRatio: caps.maxRatio,
        pixels: tier.pixels,
    });
    return frame ? `${frame.width}x${frame.height}` : null;
}

/**
 * The tier a frame belongs to: the longest side of the frame decides.
 * @param {{ width: number, height: number }} frame
 * @param {string|null} [model]
 * @returns {string} a key of `IMAGE_TIER_LIMITS`
 */
export function inferResolution({ width, height }, model = null) {
    const maxSide = Math.max(width, height);
    const profile = imageModelProfile(model);

    if (maxSide > 3072 && maxSide < 8192) return '4k';
    if (maxSide >= 3072) return '3k';
    if (maxSide >= 2048) return '2k';
    if (maxSide >= 1024) return '1k';
    if (maxSide >= 512 && (profile?.minPixels <= (512 * 512) || !profile?.minPixels)) return '512';

    // 4k — the highest level; a request past it lands in 4k.
    return maxSide > 2048 ? '4k' : '1k';
}

/**
 * Read a resolution tier out of a bare token: `512`, `1k`/`1.5k`/`2k`/`3k`/`4k`, or a plain pixel
 * number (`512`, `1024`, `2048`, `4096`) which names the tier by its longest side. This is what
 * lets a caller ask for `size: "2048"` and land on the 2K tier instead of leaking an unusable
 * token to the gateway (where it is dropped and the model answers with its default square).
 * @param {string|null|undefined} value
 * @param {string|null} [model]
 * @returns {string|null} a key of `IMAGE_SIZES_BY_RESOLUTION`, or null when the token names no tier
 */
export function tierFromToken(value, model = null) {
    const token = String(value ?? '').trim().toLowerCase();
    if (!token) return null;
    if (token === '512') return '512';
    if (/^\d+(\.\d+)?k$/.test(token)) return IMAGE_SIZES_BY_RESOLUTION[token] ? token : null;
    if (/^\d+$/.test(token)) return inferResolution({ width: Number(token), height: Number(token) }, model);
    return null;
}

/**
 * The frame a preset-only model gets when its family serves no resolution tiers: the frame of the
 * requested orientation, at the tier the request names. A preset model has three shapes — square,
 * portrait, landscape — so any shape asked for (`2.39:1`, `a4`, `wide`) resolves to the one of them
 * it can actually draw, and never to the token itself: leaking `2.39:1` into `size` makes a strict
 * gateway answer 400 and a lenient one fall back to its default square.
 * @param {string} value lowercased, non-empty size token
 * @param {string|null} [resolution]
 * @param {string|null} [model]
 * @returns {string|null}
 */
export function presetImageSize(value, resolution = null, model = null) {
    if (IMAGE_SIZES.includes(value)) return value;
    const shape = parseAspectToken(value);
    if (!shape) {
        const tier = tierFromToken(value, model);
        if (tier && IMAGE_SIZES_BY_RESOLUTION[tier]) return SQUARE_SIZES[tier] || SQUARE_SIZES['1k'];
        return value;
    }
    const parsed = parseImageSize(value);
    const resolutionKey = tierFromToken(resolution, model)
        || (parsed ? inferResolution(parsed, model) : null) || '1k';
    const tier = IMAGE_SIZES_BY_RESOLUTION[resolutionKey] ? resolutionKey : '1k';
    // A shape within half a percent of 1:1 is the square preset, not a leaning landscape one.
    if (Math.abs(Math.log(shape.ratio)) < RATIO_CEIL_EPSILON) return SQUARE_SIZES[tier] || SQUARE_SIZES['1k'];
    return shape.ratio < 1 ? (PORTRAIT_SIZES[tier] || PORTRAIT_SIZES['1k'])
        : (LANDSCAPE_SIZES[tier] || LANDSCAPE_SIZES['1k']);
}

/**
 * The frame a source is scaled to: the sides grow by the same factor, so the shape survives, and
 * every side lands on the 16-pixel grid the model draws on.
 * @param {{ width: number, height: number }} size
 * @param {number} [minPixels]
 * @param {number} [maxPixels]
 * @param {boolean} [needsToPad16]
 * @returns {{ width: number, height: number }}
 */
export function fromMinimalSize({ width, height }, minPixels = 16384, maxPixels = 16777216, needsToPad16 = true) {
    const paddedSize = { width, height };
    const originalSize = { width, height };

    const maxUpscaleRatio = Math.sqrt(Math.max(maxPixels / (originalSize.width * originalSize.height), 1));
    const upscaleRatio = Math.min(Math.sqrt(Math.max(minPixels / (originalSize.width * originalSize.height), 1)), maxUpscaleRatio);

    if (needsToPad16) {
        paddedSize.width = Math.ceil(Math.ceil(originalSize.width * upscaleRatio) / 16) * 16;
        paddedSize.height = Math.ceil(Math.ceil(originalSize.height * upscaleRatio) / 16) * 16;
    } else {
        paddedSize.width = Math.ceil(originalSize.width * upscaleRatio);
        paddedSize.height = Math.ceil(originalSize.height * upscaleRatio);
    }

    return paddedSize;
}

/**
 * The frame of one shape at one tier: the longest side of the tier decides, the shape decides the
 * other side, and the result lands on the 16-pixel grid inside the limits of the model.
 * @param {string} [aspect]
 * @param {string} [resolution]
 * @param {number} [minPixels]
 * @param {number} [maxPixels]
 * @param {boolean} [needsToPad16]
 * @returns {{ width: number, height: number }}
 */
export function computeSize(aspect = '1:1', resolution = '1k', minPixels = 16384, maxPixels = 16777216, needsToPad16 = true) {
    const aspectPair = aspect?.split?.(':');
    const aspectDiv = parseInt(aspectPair?.[0]) / parseInt(aspectPair?.[1]);
    const resolutionMap = {
        '512': 512,
        '1k': 1024,
        '1.5k': 1536,
        '2k': 2048,
        '3k': 3072,
        '4k': 4096,
    };
    const L_mapped = resolutionMap[resolution?.trim?.()?.toLowerCase?.() || '1k'];
    let width = L_mapped;
    let height = L_mapped;

    if (aspectDiv > 1) {
        width = L_mapped;
        height = (L_mapped * L_mapped) / width / aspectDiv;
    } else if (aspectDiv < 1) {
        height = L_mapped;
        width = (L_mapped * L_mapped) / height * aspectDiv;
    }

    return fromMinimalSize({ width, height }, minPixels, maxPixels, needsToPad16);
}

/**
 * Map a requested size to the nearest supported one.
 *
 * The resolution tier decides the pixel budget; the requested size only decides orientation and
 * aspect. The tier comes from the explicit `resolution` argument, from a tier token inside `size`
 * (`512`, `2K`), or — when the size names pixels — from its longest side, so `1280x720` is a 2K
 * request and stays a 2K frame rather than collapsing to the 1024 preset.
 * A shape named without pixels (`21:9`, `2.39:1`, `cinemascope`) takes the frame of its tier whose
 * own shape is closest, so a tier-based model answers a wide request with a wide frame instead of
 * the square the vendor happened to list. A bare orientation word or a bare tier asks for the
 * largest frame the tier offers in that shape.
 * `auto` and an empty value omit the field.
 * @param {string|null|undefined} size
 * @param {string|null} [resolution] one of `512`/`1K`/`1.5K`/`2K`/`3K`/`4K`
 * @param {string|null} [model]
 * @returns {string|null}
 */
export function normalizeImageSize(size, resolution = null, model = null) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;

    let requested;
    let isOrientationWord = true;
    let isShapeOnly = false;
    if (value === 'portrait') requested = { width: 1, height: 2 };
    else if (value === 'landscape') requested = { width: 2, height: 1 };
    else if (value === 'square') requested = { width: 1, height: 1 };
    else {
        isOrientationWord = false;
        const parsed = parseImageSize(value);
        requested = parsed
            || (tierFromToken(value, model) ? { width: 1, height: 1 } : null)
            || parseAspectToken(value);
        // An unknown value stays as it is.
        if (!requested) return value;
        isShapeOnly = !parsed && !tierFromToken(value, model);
    }

    const profile = imageModelProfile(model);
    const minPixels = profile?.minPixels || 16384;
    const maxPixels = profile?.maxPixels || 16777216;

    if (String(size ?? '').includes?.('x')) {
        const clamped = fromMinimalSize(requested, minPixels, maxPixels, profile.div16Padding);
        return `${clamped.width}x${clamped.height}`;
    }

    const resolutionKey = tierFromToken(resolution, model) || tierFromToken(value, model)
        || (isOrientationWord || isShapeOnly ? '1k' : inferResolution(requested, model));

    const computed = computeSize(`${requested.width}:${requested.height}` || value, resolutionKey, minPixels, maxPixels, profile.div16Padding);
    return `${computed.width}x${computed.height}`;
}

/**
 * The frame on the 16-pixel grid: both sides rounded up.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function makePad16Size(value) {
    const size = parseImageSize(String(value ?? '').trim().replace(/\s+/g, ''));
    if (!size) return null;
    size.width = Math.ceil(size.width / 16) * 16;
    size.height = Math.ceil(size.height / 16) * 16;
    return `${size.width}x${size.height}`;
}

/**
 * Keep custom dimensions for the models that take them (GPT Image 2.6); turn a shape that names no
 * pixels (`21:9`, `2.39:1`, `cinemascope`) into the frame that shape gives the model at the asked
 * tier; a family that serves resolution tiers gets the frame of the tier its request names; every
 * other model gets its supported frame presets.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @param {string|null} [resolution]
 * @returns {string|null}
 */
export function imageRequestSize(size, model, resolution = null) {
    const value = String(size ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    // The gpt-image family takes the frame as it is: the gateway rounds it itself.
    if ((GPT_IMAGE_25.test(String(model ?? '')) || GPT_IMAGE_26.test(String(model ?? ''))) && /^\d+\s*x\s*\d+$/.test(value)) {
        return value.replace(/\s+/g, '');
    }
    const caps = imageModelProfile(model);
    if (caps.customSizes && /^\d+\s*x\s*\d+$/.test(value)) {
        if (needsDiv16Padding(model)) return makePad16Size(value);
        return value.replace(/\s+/g, '');
    }
    // A shape without pixels. A family tuned by a ratio field keeps it as a ratio of its own list:
    // the tier stays in `resolution`, and inventing a pixel frame would move the shape out of the
    // field the gateway is actually tuned by. A free-frame model has no ratio field, so the shape
    // is turned into the real frame it stands for at the asked tier.
    if ((caps.customSizes || caps.resolutionTiers) && !tierFromToken(value, model) && parseAspectToken(value)) {
        if (caps.resolutionTiers) return aspectRatioToken(value, model, 'image');
        const frame = aspectImageSize(value, model, resolution);
        if (frame) return frame;
    }
    // A family that serves tiers keeps the tier token: the gateway reads it as `resolution`, and
    // unfolding `2K` into `2048x2048` would move the request out of the field the model is tuned by.
    if (caps.resolutionTiers && tierFromToken(value, model)) return tierFromToken(value, model).toUpperCase();
    // A family without tiers must not be sent a tier frame it does not serve.
    if (!caps.resolutionTiers && !tierFromToken(resolution, model)) return presetImageSize(value, resolution, model);
    return normalizeImageSize(value, resolution, model);
}

/**
 * Split one requested frame into the fields the model actually takes. Riverflow and the other
 * tier-based gateways read three shapes, and the order is a priority, not a set:
 *   `WIDTHxHEIGHT`  → `size`   (the exact frame, the cheapest and most faithful — used first);
 *   `W:H` ratio      → `aspect_ratio` (a shape with no fixed pixel count);
 *   `512`/`1K`/`1.5K`/`2K`/`3K`/`4K` → `resolution` (a quality tier, alone or with an aspect_ratio).
 * A model that is not tier-based keeps the single `size` field, so a gpt-image or Recraft request
 * is unchanged. `auto` and an empty value return nothing, which leaves every field out.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @param {string|null} [resolution]
 * @returns {{ size?: string, resolution?: string, aspect_ratio?: string }}
 */
export function imageSizeFields(size, model, resolution = null) {
    const value = String(size ?? '').trim().toLowerCase();
    const caps = imageModelProfile(model);
    // An explicitly requested tier is the `resolution` field even when no frame was named.
    const explicitTier = caps.resolutionTiers ? tierFromToken(resolution, model) : null;
    if (!value || value === 'auto') return explicitTier ? { resolution: explicitTier.toUpperCase() } : {};
    if (caps.resolutionTiers) {
        if (/^\d+\s*x\s*\d+$/.test(value)) return { size: value.replace(/\s+/g, '') };
        // A tier named on its own — `512`, `2K`, or the pixel count `2048` — is the `resolution`
        // field, never `size`: a gateway that has no such frame drops the field and answers square.
        const tier = tierFromToken(value, model);
        if (tier) return { resolution: tier.toUpperCase() };
        // Any shape the caller names — `16:9`, `2.39`, `cinemascope`, `1920x1080` written as a
        // ratio — is rounded to the closest shape of the model's own list rather than dropped to
        // `auto`: a wide request must not come back square because 2.39:1 is not on the menu.
        const shape = parseAspectToken(value);
        if (shape) {
            return {
                aspect_ratio: nearestAspect(shape.ratio, RIVERFLOW_RATIOS) || 'auto',
                ...(explicitTier ? { resolution: explicitTier.toUpperCase() } : {}),
            };
        }
    }
    const frame = imageRequestSize(value, model, resolution);
    return frame ? { size: frame } : {};
}

/**
 * Custom dimensions are constrained to 16-pixel multiples, the model's max aspect ratio,
 * a maximum edge, and the supported pixel-count range. Return a nearby same-ratio frame
 * when possible.
 *
 * When the area and edge are already within limits, the function simply rounds each side
 * to the nearest 16-pixel multiple — no gcd-based rescaling. The gcd-path is used only when
 * the area is outside the supported range (too small or too large), in which case the frame
 * is rescaled to the nearest valid same-ratio size.
 * @param {string|null|undefined} size
 * @param {string|null} [model]
 * @returns {string|null}
 */
export function sameAspectImageSize(size, model = null) {
    const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size ?? '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height
        || Math.max(width, height) / Math.min(width, height) > MAX_IMAGE_RATIO(model)) return null;
    const area = width * height;
    const maxEdge = Math.max(width, height);
    // Already valid — nothing to do.
    if (width % 16 === 0 && height % 16 === 0 && area >= MIN_IMAGE_PIXELS(model) && area <= MAX_IMAGE_PIXELS(model)
        && maxEdge <= MAX_IMAGE_EDGE(model)) return null;

    // Fast path: area and edge are already in range, only 16-multiple rounding is needed.
    // This avoids the gcd-based rescaling that would wildly inflate a small source image.
    if (area >= MIN_IMAGE_PIXELS(model) && area <= MAX_IMAGE_PIXELS(model) && maxEdge <= MAX_IMAGE_EDGE(model)) {
        const rounded = `${Math.round(width / 16) * 16}x${Math.round(height / 16) * 16}`;
        return rounded === `${width}x${height}` ? null : rounded;
    }

    // Area out of range — rescale via gcd to the nearest valid same-ratio size.
    const gcd = (a, b) => {
        while (b) [a, b] = [b, a % b];
        return a;
    };
    let divisor = width;
    let remainder = height;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    const ratioWidth = width / divisor;
    const ratioHeight = height / divisor;
    const widthStep = 16 / gcd(ratioWidth, 16);
    const heightStep = 16 / gcd(ratioHeight, 16);
    const multiplierStep = (widthStep * heightStep) / gcd(widthStep, heightStep);
    const ratioArea = ratioWidth * ratioHeight;
    const minimum = Math.ceil(Math.sqrt(MIN_IMAGE_PIXELS(model) / ratioArea) / multiplierStep) * multiplierStep;
    const maximum = Math.floor(Math.min(MAX_IMAGE_EDGE(model) / Math.max(ratioWidth, ratioHeight), Math.sqrt(MAX_IMAGE_PIXELS(model) / ratioArea)) / multiplierStep) * multiplierStep;
    if (minimum > maximum) return null;
    const target = Math.max(minimum, Math.min(maximum, Math.round(divisor / multiplierStep) * multiplierStep));
    const result = `${ratioWidth * target}x${ratioHeight * target}`;
    return result === `${width}x${height}` ? null : result;
}

/**
 * Retry only errors that explicitly identify an invalid or unsupported image size.
 *
 * The refusal of a whole rotation keeps the answers of every host in `details.attempts`, and the
 * size may be refused by one host while another one refused something else — the size is then
 * still the reason to try the next frame.
 * @param {Error & { status?: number, param?: string }} error
 * @returns {boolean}
 */
export function isImageSizeError(error) {
    if (error?.code === 'IMAGE_SIZE_ERROR') return true;
    const attempts = error?.details?.attempts;
    if (Array.isArray(attempts) && attempts.some((item) => item?.code === 'IMAGE_SIZE_ERROR')) {
        return true;
    }
    if (![400, 413, 422].includes(error?.status)) return false;
    if (/^(?:size|sizes|image_size|dimensions?)$/i.test(String(error?.param ?? ''))) return true;
    return /\b(sizes?|dimensions?|resolution|aspect ratio|pixel count)\b/i.test(String(error?.message ?? ''));
}

/**
 * Nearest aspect ratio from the riverflow set for a pixel size or any shape token. Returns a ratio
 * string like '4:5' that `imageSizeFields` can consume, or null when the shape is already square
 * (the gateway answers a square request with its default square frame, so there is nothing to fix).
 * @param {string} sizePixels
 * @returns {string|null}
 */
export function nearestRiverflowRatio(sizePixels) {
    const shape = parseAspectToken(sizePixels);
    if (!shape) return null;
    const terms = rationalAspect(shape.ratio);
    if (terms && terms.width === terms.height) return null;
    return nearestAspect(shape.ratio, RIVERFLOW_RATIOS);
}

/**
 * Ordered image-size attempts: the exact request, a valid same-ratio size, then a nearest fallback.
 * @param {string|null|undefined} size
 * @param {string|null|undefined} model
 * @param {string|null} [resolution]
 * @returns {(string|null)[]}
 */
export function imageSizeAttempts(size, model, resolution = null) {
    const initial = imageRequestSize(size, model, resolution);
    if (!initial) return [];
    const profile = imageModelProfile(model);
    if (!profile.customSizes || !/^\d+x\d+$/.test(initial)) {
        const attempts = [initial];
        if (profile.omitSizeOnReject) attempts.push(null);
        return attempts;
    }
    const attempts = [initial];
    const sameRatio = sameAspectImageSize(initial, model);
    if (sameRatio && !attempts.includes(sameRatio)) attempts.push(sameRatio);
    if (RIVERFLOW.test(String(model ?? ''))) {
        const ratio = nearestRiverflowRatio(initial);
        if (ratio && !attempts.includes(ratio)) attempts.push(ratio);
    } else {
        const preset = presetImageSize(initial, resolution, model);
        if (preset && !attempts.includes(preset)) attempts.push(preset);
    }
    if (profile.omitSizeOnReject) attempts.push(null);
    return attempts;
}

/**
 * Whether /images/edits inputs for this model need the 16-pixel padding. `auto` follows the model
 * profile; `always` and `never` are the operator override for a gateway whose behaviour the profile
 * does not describe — padding is a crutch, and a model that accepts the frame as-is gets it as-is.
 * @param {string|null|undefined} model
 * @param {'auto'|'always'|'never'|null|undefined} setting
 * @returns {boolean}
 */
export function needsDiv16Padding(model, setting = 'auto') {
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return imageModelProfile(model).div16Padding;
}

/**
 * Whether a source smaller than the model's floor should be padded up to that floor instead of being
 * sent at its own size for the model to upscale. `auto` follows the model profile; `always` and
 * `never` are the operator override for a gateway whose behaviour the profile does not describe.
 * Padding is the fallback path for a model that answers a bigger frame by keeping the object at its
 * own scale in the corner rather than drawing it larger.
 * @param {string|null|undefined} model
 * @param {'auto'|'always'|'never'|null|undefined} setting
 * @returns {boolean}
 */
export function needsMinPixelsPadding(model, setting = 'auto') {
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return imageModelProfile(model).padToMinPixels;
}

/**
 * The frame a source has to sit in for a model whose floor is `minPixels`: both sides grow by the
 * same factor — so the source ratio survives and the object keeps its own scale — and each side is
 * rounded up to the 16-pixel grid the model draws on. The empty space is added on the right and at
 * the bottom, which is where the padding is cut off again after the answer comes back.
 * Null means nothing to do (the frame already clears the floor) and null also means the padding
 * would not fit the model limits (edge, ratio, pixel ceiling): the caller keeps the upscale path.
 * @param {string|{width:number,height:number}|null|undefined} size the source frame
 * @param {string|null|undefined} model
 * @returns {{width:number,height:number,originalWidth:number,originalHeight:number}|null}
 */
export function paddedSizeToMinPixels(size, model = null) {
    const source = typeof size === 'object' && size ? { width: Number(size.width), height: Number(size.height) }
        : parseImageSize(String(size ?? '').trim().replace(/\s+/g, ''));
    if (!source || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
        || !source.width || !source.height) return null;
    const caps = imageModelProfile(model);
    const area = source.width * source.height;
    if (!Number.isFinite(caps.minPixels) || caps.minPixels <= 0 || area >= caps.minPixels) return null;
    const ratio = Math.sqrt(caps.minPixels / area);
    const width = Math.ceil(source.width * ratio / 16) * 16;
    const height = Math.ceil(source.height * ratio / 16) * 16;
    if (Math.max(width, height) > caps.maxEdge
        || Math.max(width, height) / Math.min(width, height) > caps.maxRatio
        || width * height > caps.maxPixels) return null;
    return { width, height, originalWidth: source.width, originalHeight: source.height };
}

const PAD_RESOLUTIONS = ['512', '1k', '1.5k', '2k', '3k', '4k'];
const PAD_ASPECT_RATIOS = [
    '1:1',
    '4:3',
    '3:4',
    '16:9',
    '9:16',
    '3:2',
    '2:3',
    '21:9',
    '2:1',
    '1:2',
];

/**
 * The frame a source has to sit in for a model whose floor is `minPixels`, chosen from the frames
 * the tier offers: the source goes into the frame without a rescale, and the frame whose own shape
 * is closest to the source wins among the frames of the same area.
 *
 * null means: no padding is needed, the input is broken, or no frame fits.
 *
 * @param {string|{width:number,height:number}|null|undefined} size
 * @param {string|null} [model]
 * @param {string|null} [resolution] a tier or "auto"
 * @returns {{
 *   width:number,
 *   height:number,
 *   originalWidth:number,
 *   originalHeight:number,
 *   aspectRatio:string,
 *   resolution:string
 * }|null}
 */
export function paddedSizeToMinPixelsByResolution(size, model = null, resolution = '1k') {
    const source = typeof size === 'object' && size
        ? { width: Number(size.width), height: Number(size.height) }
        : parseImageSize(String(size ?? '').trim().replace(/\s+/g, ''));

    if (
        !source
        || !Number.isSafeInteger(source.width)
        || !Number.isSafeInteger(source.height)
        || source.width <= 0
        || source.height <= 0
        || !Number.isSafeInteger(source.width * source.height)
    ) {
        return null;
    }

    const caps = imageModelProfile(model);
    const sourceArea = source.width * source.height;

    // The semantics of paddedSizeToMinPixels.
    if (
        !caps
        || !Number.isFinite(caps.minPixels)
        || caps.minPixels <= 0
        || sourceArea >= caps.minPixels
    ) {
        return null;
    }

    const requestedResolution = String(resolution ?? '').trim().toLowerCase();
    const isAuto = !requestedResolution || requestedResolution === 'auto';

    if (!isAuto && !PAD_RESOLUTIONS.includes(requestedResolution)) return null;

    // Do not let normalizeImageSize quietly swap an unsupported tier for its fallback on 1k.
    const resolutions = (isAuto ? PAD_RESOLUTIONS : [requestedResolution])
        .filter((tier) => tierFromToken(tier, model));

    if (!resolutions.length) return null;

    const sourceRatio = source.width / source.height;
    let best = null;

    for (const tier of resolutions) {
        for (const aspectRatio of PAD_ASPECT_RATIOS) {
            const normalized = normalizeImageSize(aspectRatio, tier, model);
            const frame = normalized ? parseImageSize(normalized) : null;

            if (
                !frame
                || !Number.isSafeInteger(frame.width)
                || !Number.isSafeInteger(frame.height)
                || frame.width <= 0
                || frame.height <= 0
            ) {
                continue;
            }

            const area = frame.width * frame.height;

            if (
                !Number.isSafeInteger(area)
                || frame.width < source.width
                || frame.height < source.height
                || area < caps.minPixels
                || area > caps.maxPixels
                || Math.max(frame.width, frame.height) > caps.maxEdge
                || Math.max(frame.width, frame.height)
                    / Math.min(frame.width, frame.height) > caps.maxRatio
            ) {
                continue;
            }

            // The logarithm gives a symmetric measure of the difference of the shapes.
            const ratioDistance = Math.abs(
                Math.log((frame.width / frame.height) / sourceRatio),
            );

            if (
                !best
                || area < best.area
                || (area === best.area && ratioDistance < best.ratioDistance)
            ) {
                best = {
                    width: frame.width,
                    height: frame.height,
                    originalWidth: source.width,
                    originalHeight: source.height,
                    aspectRatio,
                    resolution: tier,
                    area,
                    ratioDistance,
                };
            }
        }
    }

    if (!best) return null;

    const { area, ratioDistance, ...result } = best;
    return result;
}

/**
 * The plan of one frame: how a request of this frame reaches the model.
 *
 * A frame is not always legal for the model: it may be off the 16-pixel grid, below the floor of
 * the model, or wider than the model accepts. There are two ways out, and the plan names the one
 * that applies:
 *
 *   `direct`   — the model takes the frame as it is; the request goes out unchanged;
 *   `align`    — the frame is padded into a legal canvas that contains it (the content keeps its
 *                own scale and position, the empty space is cut off the answer);
 *   `downscale`— the frame does not fit the model at all; the request asks for the frame as it
 *                is and the answer is scaled down to it afterwards, with the aspect ratio kept.
 *
 * The align path is the one that makes an arbitrary size work: the canvas grows, the content
 * does not.
 * @param {{ model?: string|null, size?: string|null, resolution?: string|null }} params
 * @returns {{ mode: 'direct'|'align'|'downscale', frame: string|null, requested: {width:number,height:number}|null,
 *   pad: { width: number, height: number }|null }}
 */
export function alignmentPlan({ model = null, size = null, resolution = null } = {}) {
    const token = String(size ?? '').trim();
    const requested = parseImageSize(token);
    const profile = imageModelProfile(model);
    if (!requested) {
        return { mode: 'direct', frame: token && token !== 'auto' ? token : null, requested: null, pad: null };
    }
    const requestedToken = `${requested.width}x${requested.height}`;
    // A model that takes any frame: the request is legal when the frame fits the profile.
    if (profile.customSizes && sameAspectImageSize(requestedToken, model) === null) {
        return { mode: 'direct', frame: requestedToken, requested, pad: null };
    }
    // The frame is not legal: pad it into a legal canvas that contains it.
    const frame = aspectFrame(requested, {
        step: profile.div16Padding ? 16 : 1,
        minPixels: profile.minPixels,
        maxPixels: profile.maxPixels,
        maxEdge: profile.maxEdge,
        maxRatio: profile.maxRatio,
        pixels: requested.width * requested.height,
    });
    if (frame && frame.width >= requested.width && frame.height >= requested.height) {
        return {
            mode: 'align',
            frame: `${frame.width}x${frame.height}`,
            requested,
            pad: { width: frame.width, height: frame.height },
        };
    }
    // The frame does not fit the model at all: ask for it and scale the answer down afterwards.
    return { mode: 'downscale', frame: requestedToken, requested, pad: null };
}
