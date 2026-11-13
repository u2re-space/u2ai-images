/**
 * @file src/config/env.js
 * @module config/env
 * @purpose The configuration fields that come from the environment.
 * @exports fromEnv, envConfigPath
 * @ai.tags config
 * @ai.hint keep
 */

import { KiB, MiB } from './constants.js';

/**
 * Parse one env value as a bounded integer.
 * @param {string|undefined} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function intInRange(raw, min, max) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return null;
    return value;
}

/**
 * Parse one env value as a JSON array of backend entries; invalid input is ignored.
 * @param {string|undefined} raw
 * @returns {object[]|null}
 */
function backendList(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Build a partial config object from the environment variables.
 *
 * The namespaced names are AI_IMAGE_*. Two names keep the meaning they have in
 * the monolith, so a user moves over without touching the environment:
 * AI_MODEL is the text model and AI_IMAGE_MODEL is the picture model. The
 * namespaced counterparts are AI_IMAGE_TEXT_MODEL and AI_IMAGE_IMAGE_MODEL.
 *
 * @param {object} [env]
 * @returns {object}
 */
export function fromEnv(env = process.env) {
    const out = {};
    const set = (path, value) => {
        if (value === undefined || value === null || value === '') return;
        let owner = out;
        for (const step of path.slice(0, -1)) {
            owner[step] ??= {};
            owner = owner[step];
        }
        owner[path.at(-1)] = value;
    };

    // --- models ----------------------------------------------------------------
    set(['model'], env.AI_IMAGE_TEXT_MODEL ?? env.AI_MODEL ?? env.OPENAI_MODEL);
    set(['imageModel'], env.AI_IMAGE_IMAGE_MODEL ?? env.AI_IMAGE_MODEL);
    set(['parserModel'], env.AI_IMAGE_PARSER_MODEL);
    set(['vectorModel'], env.AI_IMAGE_VECTOR_MODEL);

    // --- API --------------------------------------------------------------------
    set(['baseURL'], env.AI_IMAGE_BASE_URL ?? env.OPENAI_BASE_URL);
    set(['apiKey'], env.AI_IMAGE_API_KEY ?? env.OPENAI_API_KEY);
    set(['organization'], env.AI_IMAGE_ORGANIZATION ?? env.OPENAI_ORG_ID);
    set(['project'], env.AI_IMAGE_PROJECT ?? env.OPENAI_PROJECT_ID);
    if (env.AI_IMAGE_STORE === '1' || env.AI_IMAGE_STORE === 'true') set(['store'], true);

    const retries = intInRange(env.AI_IMAGE_RETRIES, 0, 10);
    if (retries != null) set(['retries'], retries);
    const timeoutMs = intInRange(env.AI_IMAGE_TIMEOUT_MS, 5_000, 600_000);
    if (timeoutMs != null) set(['timeoutMs'], timeoutMs);

    // --- backends ---------------------------------------------------------------
    const backends = backendList(env.AI_IMAGE_BACKENDS);
    if (backends) set(['backends'], backends);
    const imagesBackends = backendList(env.AI_IMAGE_IMAGES_BACKENDS);
    if (imagesBackends) set(['imagesBackends'], imagesBackends);

    // --- picture knobs ----------------------------------------------------------
    set(['image', 'size'], env.AI_IMAGE_IMAGE_SIZE);
    set(['image', 'complexity'], env.AI_IMAGE_IMAGE_COMPLEXITY);
    set(['image', 'resolution'], env.AI_IMAGE_IMAGE_RESOLUTION);
    set(['image', 'format'], env.AI_IMAGE_IMAGE_FORMAT);
    set(['image', 'background'], env.AI_IMAGE_IMAGE_BACKGROUND);
    set(['image', 'purpose'], env.AI_IMAGE_PURPOSE);
    set(['image', 'transport'], env.AI_IMAGE_TRANSPORT);
    set(['image', 'outputDir'], env.AI_IMAGE_OUTPUT_DIR);
    set(['image', 'alphaMode'], env.AI_IMAGE_ALPHA_MODE);
    set(['image', 'rasterEngine'], env.AI_IMAGE_RASTER_ENGINE);
    set(['image', 'magickPath'], env.AI_IMAGE_MAGICK_PATH);

    // --- limits -----------------------------------------------------------------
    const maxImageBytes = intInRange(env.AI_IMAGE_MAX_IMAGE_BYTES, KiB, 256 * MiB);
    if (maxImageBytes != null) set(['limits', 'maxImageBytes'], maxImageBytes);
    const maxStdinBytes = intInRange(env.AI_IMAGE_MAX_STDIN_BYTES, KiB, 256 * MiB);
    if (maxStdinBytes != null) set(['limits', 'maxStdinBytes'], maxStdinBytes);

    return out;
}

/**
 * The config file named by the environment, if any.
 * @param {object} [env]
 * @returns {string|null}
 */
export function envConfigPath(env = process.env) {
    return env.AI_IMAGE_CONFIG || null;
}
