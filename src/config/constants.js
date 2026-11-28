/**
 * @file src/config/constants.js
 * @module config/constants
 * @purpose Allowed values and shared literals of the configuration system.
 * @exports KiB, MiB, ENV_PREFIX, ENUMS, BUILTIN_ROLE_NAMES, SUPPORT_ALIASES, HEADER_NAME
 * @ai.tags config
 * @ai.hint keep
 */

/** A kibibyte. */
export const KiB = 1024;
/** A mebibyte. */
export const MiB = 1024 * KiB;
/** A gibibyte. */
export const GiB = 1024 * MiB;

/** Env prefix of this CLI (the monolith uses AI_*, ours is namespaced). */
export const ENV_PREFIX = 'AI_IMAGE_';

/**
 * The contract between the parser, the validator and the commands: a value
 * outside these lists is a user error and fails the load.
 */
export const ENUMS = Object.freeze({
    /** Formats the CLI writes. */
    imageFormats: Object.freeze(['png', 'jpeg', 'webp', 'gif', 'svg']),
    /** Background of a generated picture. */
    imageBackgrounds: Object.freeze(['auto', 'transparent', 'opaque']),
    /** The frame presets the image API knows; a free WIDTHxHEIGHT is allowed too. */
    imageSizes: Object.freeze(['auto', '1024x1024', '1536x1024', '1024x1536']),
    /** Resolution tiers of the families that are tuned by one. */
    resolutions: Object.freeze(['512', '1K', '1.5K', '2K', '3K', '4K']),
    /** The quality tiers of a picture model. */
    qualities: Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
    /** The deprecated tiers of `image.complexity` — the old name of `image.quality`. */
    complexities: Object.freeze(['auto', 'low', 'medium', 'high']),
    /** Reasoning effort levels a text model may take. */
    reasoningEfforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    /** The summary of the reasoning of a text answer. */
    reasoningSummaries: Object.freeze(['auto', 'concise', 'detailed']),
    /** Raster engines the local operations may use. */
    rasterEngines: Object.freeze(['auto', 'sharp', 'canvas', 'magick', 'wasm']),
    /** How the alpha channel of a picture is built. */
    alphaModes: Object.freeze(['auto', 'mask', 'contour', 'flat', 'key', 'off']),
    /** The purposes of the purpose system. */
    purposes: Object.freeze(['decompose', 'generate', 'edit', 'remove_background', 'upscale', 'unrotate']),
    /** The spellings that name the same purpose. */
    purposeAliases: Object.freeze({ isolate: 'remove_background', isolate_object: 'remove_background', rectify: 'unrotate' }),
    /** The route the picture travels: the images API or the responses API. */
    transports: Object.freeze(['images', 'responses']),
    /** How the edges of a picture are cut off. */
    trimModes: Object.freeze(['auto', 'uniform', 'transparent']),
    /** The 16-pixel padding of /images/edits inputs. */
    div16Modes: Object.freeze(['auto', 'always', 'never']),
    /** The padding up to the frame floor of the model. */
    padToMinModes: Object.freeze(['auto', 'always', 'never']),
    /** The frame hint repeated in the prompt text. */
    sizeHintModes: Object.freeze(['auto', 'always', 'never']),
    /** The ways a picture fits into a frame. */
    fitModes: Object.freeze(['contain', 'cover', 'fill']),
    /** Backend entries may declare which API routes the host serves. */
    backendRoutes: Object.freeze(['responses', 'chat', 'images', 'batch']),
});

/** Role names that always exist; user roles are validated against the schema only. */
export const BUILTIN_ROLE_NAMES = Object.freeze([
    'default', 'planner', 'processor', 'corrector', 'learner', 'decorator', 'vectorizer',
    'svgEditor',
]);

/** Alias spellings accepted in backend `supports` maps. */
export const SUPPORT_ALIASES = Object.freeze({
    responseapi: 'responses', responses: 'responses',
    chatapi: 'chat', chat: 'chat', chatcompletions: 'chat', completions: 'chat',
    imageapi: 'images', images: 'images',
    batchapi: 'batch', batches: 'batch',
});

/** RFC 7230 token characters for header names in backend entries. */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
