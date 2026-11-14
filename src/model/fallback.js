/**
 * @file src/model/fallback.js
 * @module model/fallback
 * @purpose The model fallback: the chain of models to try when one refuses a request.
 * @exports MODEL_FALLBACKS, fallbackModels, fallbackChain, withModelFallback
 * @ai.tags model, fallback
 * @ai.hint keep
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * The built-in fallback of a model: the same model under the name the gateways
 * know it by. The keys may be bare or prefixed with `openai/`.
 * @type {Readonly<Record<string, string>>}
 */
export const MODEL_FALLBACKS = Object.freeze({
    // the picture models, bare -> prefixed
    'seedream-5-5': 'bytedance-seed/seedream-5-5',
    'gpt-image-2.5': 'openai/gpt-image-2.5',
    'gpt-image-2.5-flare': 'openai/gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst': 'openai/gpt-image-2.5-sunburst',
    'gpt-image-2.6': 'openai/gpt-image-2.6',
    'gpt-image-2.6-flare': 'openai/gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst': 'openai/gpt-image-2.6-sunburst',

    // the text models of the parser and the agent roles, bare -> prefixed
    'gpt-6-luna': 'openai/gpt-6-luna',
    'gpt-6.1-terra': 'openai/gpt-6.1-terra',
    'gpt-6.1-sol': 'openai/gpt-6.1-sol',
    'gpt-6-luna-decisions': 'openai/gpt-6-luna-decisions',
    'gpt-6-astra': 'openai/gpt-6-astra',
});

/**
 * The built-in fallback of one model, if there is one.
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export function modelFallback(model) {
    const name = String(model ?? '').trim();
    if (!name) return null;
    return MODEL_FALLBACKS[name] ?? null;
}

/**
 * The models to try after the given one: the list under `fallback.models.<model>`,
 * then the list under `fallback.models.*` (the catch-all chain). The built-in
 * fallback of the model comes first.
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 */
export function fallbackModels(config, model) {
    if (config?.fallback?.enabled === false) return [];
    const map = config?.fallback?.models;
    const pick = (list) => (Array.isArray(list)
        ? list.map((item) => (typeof item === 'string' ? item : textOf(item?.model))).filter(Boolean)
        : []);
    const own = pick(isRecord(map) ? map[model] : null);
    const shared = pick(isRecord(map) ? map['*'] : null);
    const built = modelFallback(model);
    const chain = built ? [built, ...own] : own;
    return [...chain, ...shared.filter((item) => !chain.includes(item))];
}

/**
 * The full chain of models for a request: the requested model first, then its fallbacks.
 * @param {object} config
 * @param {string|null} model
 * @returns {string[]}
 */
export function fallbackChain(config, model) {
    const chain = [];
    if (model) chain.push(model);
    for (const item of fallbackModels(config, model)) if (!chain.includes(item)) chain.push(item);
    return chain;
}

/**
 * Run a call with the model chain: the next model is tried when the call fails
 * with an error another model may survive (a refused request, an overload, a
 * missing model).
 * @param {{ config: object, model: string|null, call: (model: string|null) => Promise<any>, onTry?: Function|null }} params
 * @returns {Promise<{ result: any, model: string|null, attempts: Array<{ model: string|null, error: string }> }>}
 */
export async function withModelFallback({ config, model, call, onTry = null }) {
    const chain = fallbackChain(config, model);
    const attempts = [];
    let lastError = null;
    for (const candidate of chain) {
        try {
            onTry?.({ model: candidate, attempt: attempts.length + 1 });
            const result = await call(candidate);
            return { result, model: candidate, attempts };
        } catch (error) {
            lastError = error;
            attempts.push({ model: candidate, error: error?.message ?? String(error) });
        }
    }
    throw lastError ?? new Error('No model answered the request.');
}
