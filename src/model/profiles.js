/**
 * @file src/model/profiles.js
 * @module model/profiles
 * @purpose What an image model is known to accept: the frame it takes, the fields
 *          it understands and the ways its gateway misbehaves.
 * @exports IMAGE_MODEL_PROFILES, DEFAULT_PROFILE, imageModelProfile, imageModelFamily,
 *          MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO,
 *          SEEDREAM, SEEDREAM_MODEL, DEFAULT_IMAGE_MODEL, GPT_IMAGE_RATIOS,
 *          SEEDREAM_RATIOS, RIVERFLOW_RATIOS, SEEDREAM_RESOLUTIONS, RIVERFLOW_RESOLUTIONS,
 *          QUALITY_LEVELS, snapQuality
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
/** The families whose picture is reproducible from a seed (the catalog says `image_seed: true`). */
export const SEEDED = /(?:^|\/)(?:flux[.-]|qwen-image|krea-|hy-image)/i;

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
 * The shapes the gpt-image family takes (the catalog of the gateway, November 2026).
 *
 * The field itself is coarse: the model rounds `4:3` and `21:9` to its own native frames
 * (1536x1024 and 1024x1536), so a shape that has to be kept exactly is asked for as a frame.
 */
export const GPT_IMAGE_RATIOS = Object.freeze([
    '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto',
]);

/**
 * The shapes the seedream family takes — a much wider list than the standard catalogue, with
 * the cinema shapes of the vendor (`9:19.5`, `9:20`, `9:21`) and the narrow ones (`1:2`).
 */
export const SEEDREAM_RATIOS = Object.freeze([
    '1:1', '1:2', '2:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9',
    '9:19.5', '19.5:9', '9:20', '20:9', '9:21', '21:9', 'auto',
]);

/** The shapes the riverflow family takes. */
export const RIVERFLOW_RATIOS = Object.freeze([
    '1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', 'auto',
]);

/** The resolution tiers the seedream family takes: the vendor refuses everything else. */
export const SEEDREAM_RESOLUTIONS = Object.freeze(['1K', '1.5K', '2K']);

/** The resolution tiers the riverflow family takes. */
export const RIVERFLOW_RESOLUTIONS = Object.freeze(['1K', '2K', '4K']);

/**
 * The quality levels of a picture, from the cheapest to the most expensive. The ladder is the
 * order the levels are pulled down in: a model that does not take a level is asked for the
 * closest one below it.
 */
export const QUALITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

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
 *   `quality`                 — the quality tier the model understands (e.g. 'high');
 *   `qualities`               — the ladder of the quality levels the model takes;
 *   `aspectRatios`            — the shapes the model is asked about;
 *   `resolutionTiers`         — the model is tuned by a tier (1K | 1.5K | 2K | 4K);
 *   `resolutions`             — the tiers the model really serves;
 *   `seed`                    — the model takes a seed and answers the same picture for it;
 *   `outputCompression`       — the model takes the degree of compression of a jpeg/webp;
 *   `gif`                     — the model answers an animated GIF;
 *   `mask`                    — the model takes a mask of the area to repaint;
 *   `maxImages`               — how many pictures one request may carry;
 *   `routeEditsThroughGeneration` — /images/edits drops the tuning fields of this family, so the
 *                               source travels as a reference on /images/generations instead;
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
    quality: null,
    qualities: null,
    aspectRatios: null,
    resolutionTiers: false,
    resolutions: null,
    seed: false,
    outputCompression: false,
    gif: false,
    mask: false,
    maxImages: 1,
    routeEditsThroughGeneration: false,
    sizeHints: false,
    paintsFakeTransparency: false,
    vectorRatios: false,
    minPixels: 655_360,
    maxPixels: 8_294_400,
    maxEdge: 3840,
    maxRatio: 3,
});

/**
 * The rules in match order; a model that matches several of them takes all of them, so a narrow
 * family adds to a broad one (a seeded family stays seeded when another rule matches it too).
 *
 * Riverflow keeps its `-pro` suffix at any frame — the suffix is the model, not
 * a size tier — and takes no 16-pixel padding. Its frame support differs
 * between the gateways, so a refused frame costs one retry without the field
 * rather than the whole request. It takes a far smaller frame than gpt-image
 * (128x128 is already legal) and a much wider shape.
 *
 * The quality, the shapes and the tiers are the ones the catalog of the gateway publishes for the
 * model (November 2026), checked against the live answers of the endpoint.
 */
export const IMAGE_MODEL_PROFILES = Object.freeze([
    Object.freeze({
        match: GPT_IMAGE_26,
        customSizes: true,
        div16Padding: true,
        quality: 'high',
        qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
        aspectRatios: GPT_IMAGE_RATIOS,
        outputCompression: true,
        gif: true,
        mask: true,
        maxImages: 10,
    }),
    Object.freeze({
        match: GPT_IMAGE_25,
        customSizes: true,
        div16Padding: true,
        quality: 'high',
        qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
        aspectRatios: GPT_IMAGE_RATIOS,
        outputCompression: true,
        mask: true,
        maxImages: 10,
    }),
    // Seedream takes a free frame, but the host refuses a frame below 960×960 pixels: the
    // floor is the model's own, and it is what the small crops are padded up to. The frame of the
    // vendor is a tier (`1K`, `1.5K`, `2K`) together with a shape, and the shapes are many more
    // than the standard catalogue: the cinema frames and the narrow ones are on the menu.
    Object.freeze({
        match: SEEDREAM,
        customSizes: true,
        minPixels: 921_600,
        maxPixels: 16_777_216,
        maxEdge: 4096,
        maxRatio: 4,
        resolutionTiers: true,
        resolutions: SEEDREAM_RESOLUTIONS,
        aspectRatios: SEEDREAM_RATIOS,
        seed: true,
    }),
    Object.freeze({
        match: RIVERFLOW,
        customSizes: true,
        keepProSuffix: true,
        omitSizeOnReject: true,
        routeEditsThroughGeneration: true,
        resolutionTiers: true,
        resolutions: RIVERFLOW_RESOLUTIONS,
        aspectRatios: RIVERFLOW_RATIOS,
        sizeHints: true,
        paintsFakeTransparency: true,
        minPixels: 16_384,
        maxPixels: 16_777_216,
        maxEdge: 4096,
        maxRatio: 16,
    }),
    Object.freeze({ match: SEEDED, seed: true }),
    Object.freeze({ match: RECRAFT_VECTOR, vectorRatios: true }),
]);

/**
 * The capabilities of one model id, merged over the defaults.
 * @param {string|null|undefined} model
 * @returns {object}
 */
export function imageModelProfile(model) {
    const name = String(model ?? '').trim();
    const rules = IMAGE_MODEL_PROFILES.filter((profile) => profile.match.test(name));
    if (!rules.length) return { ...DEFAULT_PROFILE };
    // The rules of a model are merged in order: a narrow family adds to a broad one.
    return rules.reduce((caps, rule) => {
        const { match, ...rest } = rule;
        return { ...caps, ...rest };
    }, { ...DEFAULT_PROFILE });
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

/**
 * Pull a quality level down to one the model really takes.
 *
 * A model without a quality field gets nothing: the field stays out of the request. A level the
 * model does not know is pulled down to the closest one below it, so a request for `max` on a
 * model that stops at `high` is sent as `high` and not refused.
 * @param {string|null|undefined} quality
 * @param {object} profile the profile of the model
 * @returns {string|null}
 */
export function snapQuality(quality, profile) {
    const ladder = Array.isArray(profile?.qualities) ? profile.qualities : null;
    if (!ladder || !ladder.length || !profile?.quality) return null;
    const value = String(quality ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return profile.quality;
    if (ladder.includes(value)) return value;
    const wanted = QUALITY_LEVELS.indexOf(value);
    if (wanted < 0) return profile.quality;
    let best = null;
    for (const level of ladder) {
        const index = QUALITY_LEVELS.indexOf(level);
        if (index < 0 || index > wanted) continue;
        if (best === null || index > QUALITY_LEVELS.indexOf(best)) best = level;
    }
    return best ?? ladder.find((level) => QUALITY_LEVELS.includes(level)) ?? profile.quality;
}
