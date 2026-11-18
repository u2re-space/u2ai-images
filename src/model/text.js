/**
 * @file src/model/text.js
 * @module model/text
 * @purpose What a text model is known to accept: the ceiling of the reasoning effort and the
 *          ladder of the levels it really takes.
 * @exports TEXT_MODEL_PROFILES, textModelProfile, snapEffort
 * @ai.tags model, text
 * @ai.hint pure
 */

import { ENUMS } from '../config/constants.js';

/**
 * @typedef {{ window: number, maxOutput: number, ceiling: string|null, efforts: string[] }} TextProfile
 */

/**
 * The built-in text profiles: what a text model is known to take.
 *
 * `window` is the context the model reads, `maxOutput` is the longest answer it writes, `ceiling`
 * is the highest effort it takes and `efforts` is the ladder of the levels it really understands —
 * a level that is not on the ladder is pulled down to the closest level below it.
 *
 * The numbers come from the RouterAI model cards (November 2026) and from the live answers of
 * the gateway:
 *
 *   - MiniMax M3.1 Flash — 1M of context, 524K of output. The endpoint refuses to work without
 *     reasoning ("Reasoning is mandatory for this endpoint and cannot be disabled"), so `none`
 *     is not on its ladder: a request for `none` is raised to `low`.
 *   - Kimi K3.1 Pro — 1M of context, 944K of output. It takes the reasoning off without a refusal
 *     and answers in a fraction of the time, so `none` stays on its ladder; the ceiling is
 *     `medium`, because the levels above it cost the same seconds and give nothing back.
 *   - Gemini 4 Hydrogen — 1M of context and up to 1M of output with the continuation. The card of
 *     the vendor names the levels of the effort `low`, `medium`, `high` and `xhigh` — there is no
 *     `none`, so the reasoning off is raised to `low`.
 */
export const TEXT_MODEL_PROFILES = Object.freeze({
    'minimax/minimax-m3.1-flash': {
        window: 1_000_000,
        maxOutput: 524_288,
        ceiling: 'xhigh',
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    'google/gemini-4-hydrogen': {
        window: 1_048_576,
        maxOutput: 1_048_576,
        ceiling: 'xhigh',
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    'moonshotai/kimi-k3.1-pro': {
        window: 1_000_000,
        maxOutput: 944_000,
        ceiling: 'high',
        efforts: ['low', 'medium', 'high'],
    },
    'openai/gpt-6.1-sol': {
        window: 400_000,
        maxOutput: 128_000,
        ceiling: 'xhigh',
        efforts: ['low', 'medium', 'high', 'xhigh'],
    }, 
    'openai/gpt-6.2-sol': {
        window: 400_000,
        maxOutput: 128_000,
        ceiling: 'xhigh',
        efforts: ['low', 'medium', 'high', 'xhigh'],
    },
    'openai/gpt-6.1-terra': {
        window: 400_000,
        maxOutput: 128_000,
        ceiling: 'high',
        efforts: ['low', 'medium', 'high'],
    },
    'openai/gpt-6-luna': {
        window: 400_000,
        maxOutput: 128_000,
        ceiling: 'medium',
        efforts: ['low', 'medium'],
    },
});

/** The profile of a model that the table does not know: the middle of the ladder. */
const DEFAULT_PROFILE = Object.freeze({
    window: 131_072,
    maxOutput: 16_384,
    ceiling: 'medium',
    efforts: ['low', 'medium', 'high'],
});

/**
 * The profile of a text model.
 * @param {string|null|undefined} model
 * @returns {TextProfile}
 * @exports
 * @ai.hint pure
 */
export function textModelProfile(model) {
    const name = String(model ?? '').trim();
    const found = TEXT_MODEL_PROFILES[name];
    return found ? { ...found } : { ...DEFAULT_PROFILE };
}

/** The order of the effort levels, from the cheapest to the most expensive. */
const EFFORT_ORDER = Object.freeze([...ENUMS.reasoningEfforts]);

/**
 * Clamp an effort to what the model accepts.
 *
 * The ceiling is a hard limit. The ladder is the set of levels the model really understands:
 * a level that is not on the ladder is pulled down to the closest level below it.
 * @param {string|null} effort
 * @param {TextProfile} profile
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function snapEffort(effort, profile) {
    if (!effort) return null;
    const wanted = String(effort);
    if (!EFFORT_ORDER.includes(wanted)) return null;

    const ceiling = profile?.ceiling ?? null;
    if (ceiling && EFFORT_ORDER.includes(ceiling)) {
        const ceilingIndex = EFFORT_ORDER.indexOf(ceiling);
        if (EFFORT_ORDER.indexOf(wanted) > ceilingIndex) return ceiling;
    }

    const ladder = Array.isArray(profile?.efforts)
        ? profile.efforts.filter((item) => EFFORT_ORDER.includes(item))
        : null;
    if (!ladder || !ladder.length) return wanted;
    if (ladder.includes(wanted)) return wanted;

    const wantedIndex = EFFORT_ORDER.indexOf(wanted);
    let best = null;
    for (const item of ladder) {
        const index = EFFORT_ORDER.indexOf(item);
        if (index <= wantedIndex && (best === null || index > EFFORT_ORDER.indexOf(best))) best = item;
    }
    return best ?? ladder[0];
}
