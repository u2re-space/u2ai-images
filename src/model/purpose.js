/**
 * @file src/model/purpose.js
 * @module model/purpose
 * @purpose The purpose system: what a picture is for, and which model serves it.
 * @exports PURPOSE_NAMES, PURPOSE_ALIASES, PURPOSE_MODEL_MAP, purposeModels, resolvePurposeModel,
 *          canonicalPurpose
 * @ai.tags model, purpose
 * @ai.hint keep
 */

/**
 * The purposes the CLI knows.
 *
 * - `decompose`         — layouts, templates, screen mockups; clean geometry and a consistent style.
 * - `generate`          — plain text-to-image or a restyle; the general-purpose default.
 * - `edit`              — a picture that is changed; the source keeps its frame and its content.
 * - `remove_background` — a subject cut out of its background (native alpha or a matte).
 * - `upscale`           — a picture that is enlarged while it keeps its quality.
 * - `unrotate`          — a picture that is straightened (the `rectify` of the decomposer).
 */
export const PURPOSE_NAMES = Object.freeze([
    'decompose', 'generate', 'edit', 'remove_background', 'upscale', 'unrotate',
]);

/**
 * The spellings that name the same purpose.
 *
 * `isolate` and `isolate_object` are the names of the cut-out in the monolith and in the tool
 * specs, `rectify` is the name of the straightening in the decomposer. They are accepted
 * everywhere a purpose is named and resolve to the canonical purpose.
 */
export const PURPOSE_ALIASES = Object.freeze({
    isolate: 'remove_background',
    isolate_object: 'remove_background',
    rectify: 'unrotate',
});

/**
 * The canonical name of a purpose.
 * @param {string|null|undefined} purpose
 * @returns {string|null} null when the purpose names nothing
 */
export function canonicalPurpose(purpose) {
    const key = String(purpose ?? '').trim().toLowerCase();
    if (!key) return null;
    return PURPOSE_ALIASES[key] ?? key;
}

/**
 * The built-in order of models per purpose: the first model that the gateway
 * serves wins.
 *
 * The seedream entry of the monolith is not here: its asynchronous route is
 * not ported. A user who serves it may add it back through
 * `purpose.models.<purpose>` in the configuration.
 */
export const PURPOSE_MODEL_MAP = Object.freeze({
    decompose: Object.freeze([
        'sourceful/riverflow-v2.6-pro',
        'openai/gpt-image-2.6-sunburst',
    ]),
    generate: Object.freeze([
        'sourceful/riverflow-v2.6-pro',
        'openai/gpt-image-2.6-sunburst',
    ]),
    edit: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
    remove_background: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
    upscale: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
    unrotate: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
});

/**
 * The URLs of the hosts that serve the requests: the ones that have a key,
 * or all of them when the whole pool is keyless.
 * @param {object} config
 * @returns {Set<string>}
 */
function activeUrls(config) {
    if (Array.isArray(config?.backendUrls)) return new Set(config.backendUrls);
    const pools = [...(config?.backends ?? []), ...(config?.imagesBackends ?? [])];
    return new Set(pools.filter((pool) => pool?.baseURL).map((pool) => String(pool.baseURL).replace(/\/+$/, '')));
}

/**
 * Is the picture model of the configuration a choice of the user?
 *
 * An explicitly set `imageModel` is the choice of the user and the purpose
 * routing must not override it. The loader records the fields the user set, so
 * the default value of the model does not pass for a choice.
 * @param {object} config
 * @returns {boolean}
 */
function imageModelIsExplicit(config) {
    const explicit = config?.explicit?.top;
    if (Array.isArray(explicit)) return explicit.includes('imageModel');
    return Boolean(config?.imageModel);
}

/**
 * Can this host serve the model?
 * @param {string} model
 * @param {object} config
 * @returns {boolean}
 */
function modelAvailable(model, config) {
    const urls = activeUrls(config);
    if (urls.size === 0) return true;
    const primary = String(config?.baseURL ?? '').replace(/\/+$/, '');
    if (/^openai\//i.test(model)) {
        if (urls.has('https://api.openai.com/v1')) return true;
        return primary ? urls.has(primary) : false;
    }
    // A model of another vendor is served by the proxy pools, not by api.openai.com.
    return [...urls].some((url) => !/^https:\/\/api\.openai\.com/i.test(url));
}

/**
 * The models of one purpose: the list of the user replaces the built-in one
 * completely, an empty list means that the purpose has no model.
 * @param {object} config
 * @param {string|null|undefined} purpose
 * @returns {string[]}
 */
export function purposeModels(config, purpose) {
    const key = canonicalPurpose(purpose);
    if (!key) return [];
    const map = config?.purpose?.models ?? {};
    // Every spelling of the purpose names the same list: a user who writes `isolate_object`
    // configures the `remove_background` purpose.
    const keys = [
        key,
        ...Object.entries(PURPOSE_ALIASES).filter(([, canonical]) => canonical === key).map(([alias]) => alias),
    ];
    for (const name of keys) {
        const own = map[name];
        if (Array.isArray(own)) return own.filter((model) => typeof model === 'string' && model.trim());
    }
    const list = PURPOSE_MODEL_MAP[key] ?? [];
    return list.filter((model) => typeof model === 'string' && model.trim());
}

/**
 * The model that serves a purpose: the first model of the list whose host is
 * among the configured backends.
 *
 * An empty purpose, an unknown purpose or an explicitly configured picture
 * model give `null`: the caller keeps the model of the configuration.
 * @param {object} config
 * @param {string|null|undefined} purpose
 * @returns {string|null}
 */
export function resolvePurposeModel(config, purpose) {
    const key = canonicalPurpose(purpose);
    if (!key) return null;
    if (!PURPOSE_NAMES.includes(key)) return null;
    if (imageModelIsExplicit(config)) return null;
    for (const model of purposeModels(config, key)) {
        if (modelAvailable(model, config)) return model;
    }
    return null;
}
