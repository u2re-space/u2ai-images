/**
 * @file src/model/profiles.js
 * @module model/profiles
 * @purpose What an image model is known to accept: the frame it takes, the fields
 *          it understands and the ways its gateway misbehaves.
 * @exports IMAGE_MODEL_PROFILES, DEFAULT_PROFILE, imageModelProfile, imageModelFamily,
 *          MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO,
 *          SEEDREAM, SEEDREAM_MODEL, DEFAULT_IMAGE_MODEL
 * @ai.tags model, images
 * @ai.hint keep
 */

/** The OpenAI gpt-image-2.5 family (sunburst, flare, …). */
export const GPT_IMAGE_25 = /^(?:openai\/)?gpt-image-2\.5(?:-|$)/i;
/** The OpenAI gpt-image-2.6 family (sunburst, flare, …). */
export const GPT_IMAGE_26 = /^(?:openai\/)?gpt-image-2\.6(?:-|$)/i;
/** The Sourceful Riverflow family — a Flux-based id such as sourceful/riverflow-v2.6-pro. */
export const RIVERFLOW = /(?:^|\/)riverflow-/i;
/** The Recraft vector family — a ratio-tuned model that draws the SVG itself. */
export const RECRAFT_VECTOR = /(?:^|\/)recraft[^/]*vector/i;
/** The ByteDance Seedream family — a model with free frames and a floor of 960×960 pixels. */
export const SEEDREAM = /(?:^|\/)seedream/i;

/** The default picture model of the CLI. */
export const DEFAULT_IMAGE_MODEL = 'bytedance-seed/seedream-5-5';
/** The Seedream model of ByteDance: the picture model of the default. */
export const SEEDREAM_MODEL = 'bytedance-seed/seedream-5-5';
/** The Riverflow model: an opt-in id, not every gateway serves it. */
export const RIVERFLOW_MODEL = 'sourceful/riverflow-v2.6-pro';

/**
 * The model the gateway runs behind `output_format: svg` for the gpt-image family. The raster
 * model paints the picture and this one writes the document, so the svg call carries both: without
 * the `svg.model` field the host refuses the request outright
 * (`output_format "svg" requires svg.model`).
 */
export const SVG_CONVERSION_MODEL = 'gpt-6.1-terra';

/**
 * What a model that the registry does not list is known to accept.
 *
 *   `customSizes`             — an arbitrary WIDTHxHEIGHT goes into `size` instead of a preset;
 *   `div16Padding`            — the inputs of /images/edits are padded to a multiple of 16 px first;
 *   `padToMinPixels`          — a source smaller than `minPixels` is padded up to the smallest
 *                               frame the model accepts, and the padding is cut off the reply again;
 *   `keepProSuffix`           — the `-pro` suffix survives a small frame;
 *   `omitSizeOnReject`        — when the host refuses the frame, the request is retried once
 *                               without the `size` field at all;
 *   `complexity`              — the complexity tier the model understands (e.g. 'high');
 *   `routeEditsThroughGeneration` — /images/edits drops the tuning fields of this family, so the
 *                               source travels as a reference on /images/generations instead;
 *   `resolutionTiers`         — the model is tuned by a tier (512 | 1K | 2K | 4K);
 *   `sizeHints`               — the frame is repeated in the prompt text for this family;
 *   `paintsFakeTransparency`  — the gateway answers `background: transparent` with a painted plate;
 *   `vectorRatios`            — the model is tuned by a shape, not by a pixel frame;
 *   `minPixels`/`maxPixels`   — the accepted frame area in pixels;
 *   `maxEdge`                 — the longest side the model accepts;
 *   `maxRatio`                — the widest shape (longest side over shortest).
 */
export const DEFAULT_PROFILE = Object.freeze({
    customSizes: false,
    div16Padding: false,
    padToMinPixels: true,
    keepProSuffix: false,
    omitSizeOnReject: false,
    complexity: null,
    routeEditsThroughGeneration: false,
    resolutionTiers: false,
    sizeHints: false,
    paintsFakeTransparency: false,
    vectorRatios: false,
    minPixels: 655_360,
    maxPixels: 8_294_400,
    maxEdge: 3840,
    maxRatio: 3,
});

/**
 * The rules in match order; the first match wins, so a narrow family comes
 * before a broad one.
 *
 * Riverflow keeps its `-pro` suffix at any frame — the suffix is the model, not
 * a size tier — and takes no 16-pixel padding. Its frame support differs
 * between the gateways, so a refused frame costs one retry without the field
 * rather than the whole request. It takes a far smaller frame than gpt-image
 * (128x128 is already legal) and a much wider shape.
 */
export const IMAGE_MODEL_PROFILES = Object.freeze([
    Object.freeze({ match: GPT_IMAGE_26, customSizes: true, div16Padding: true, complexity: 'high' }),
    Object.freeze({ match: GPT_IMAGE_25, customSizes: true, div16Padding: true }),
    // Seedream takes a free frame, but the host refuses a frame below 960×960 pixels: the
    // floor is the model's own, and it is what the small crops are padded up to.
    Object.freeze({
        match: SEEDREAM,
        customSizes: true,
        minPixels: 921_600,
        maxPixels: 16_777_216,
        maxEdge: 4096,
        maxRatio: 4,
    }),
    Object.freeze({
        match: RIVERFLOW,
        customSizes: true,
        keepProSuffix: true,
        omitSizeOnReject: true,
        complexity: 'high',
        routeEditsThroughGeneration: true,
        resolutionTiers: true,
        sizeHints: true,
        paintsFakeTransparency: true,
        minPixels: 16_384,
        maxPixels: 16_777_216,
        maxEdge: 4096,
        maxRatio: 16,
    }),
    Object.freeze({ match: RECRAFT_VECTOR, vectorRatios: true }),
]);

/**
 * The capabilities of one model id, merged over the defaults.
 * @param {string|null|undefined} model
 * @returns {object}
 */
export function imageModelProfile(model) {
    const name = String(model ?? '').trim();
    const rule = IMAGE_MODEL_PROFILES.find((profile) => profile.match.test(name));
    if (!rule) return { ...DEFAULT_PROFILE };
    const { match, ...caps } = rule;
    return { ...DEFAULT_PROFILE, ...caps };
}

/**
 * The family of one model id: the name the rules are written for.
 * @param {string|null|undefined} model
 * @returns {string} 'gpt-image-2.6' | 'gpt-image-2.5' | 'riverflow' | 'recraft-vector' | 'seedream' | 'generic'
 */
export function imageModelFamily(model) {
    const name = String(model ?? '').trim();
    if (GPT_IMAGE_26.test(name)) return 'gpt-image-2.6';
    if (GPT_IMAGE_25.test(name)) return 'gpt-image-2.5';
    if (RIVERFLOW.test(name)) return 'riverflow';
    if (RECRAFT_VECTOR.test(name)) return 'recraft-vector';
    if (SEEDREAM.test(name)) return 'seedream';
    return 'generic';
}

/**
 * The smallest frame area the model accepts.
 * @param {string|null|undefined} model
 * @returns {number}
 */
export const MIN_IMAGE_PIXELS = (model = null) => imageModelProfile(model).minPixels;

/**
 * The largest frame area the model accepts.
 * @param {string|null|undefined} model
 * @returns {number}
 */
export const MAX_IMAGE_PIXELS = (model = null) => imageModelProfile(model).maxPixels;

/**
 * The longest side the model accepts.
 * @param {string|null|undefined} model
 * @returns {number}
 */
export const MAX_IMAGE_EDGE = (model = null) => imageModelProfile(model).maxEdge;

/**
 * The widest shape the model accepts (longest side over shortest).
 * @param {string|null|undefined} model
 * @returns {number}
 */
export const MAX_IMAGE_RATIO = (model = null) => imageModelProfile(model).maxRatio;
