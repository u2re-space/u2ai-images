/**
 * @file src/model/purpose.js
 * @module model/purpose
 * @purpose The purpose system: what a picture is for, and which model serves it.
 * @exports PURPOSE_NAMES, PURPOSE_MODEL_MAP
 * @ai.tags model, purpose
 * @ai.hint keep
 */

/**
 * The purposes the CLI knows.
 *
 * - `decompose` — layouts, templates, screen mockups; needs clean geometry and a consistent style.
 * - `isolate`   — cut a subject out of its background (alpha or matte).
 * - `upscale`   — enlarge a picture while keeping its quality.
 * - `generate`  — plain text-to-image or a restyle; the general-purpose default.
 */
export const PURPOSE_NAMES = Object.freeze(['decompose', 'isolate', 'upscale', 'generate']);

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
    isolate: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
    upscale: Object.freeze([
        'openai/gpt-image-2.6-sunburst',
        'sourceful/riverflow-v2.6-pro',
    ]),
    generate: Object.freeze([
        'sourceful/riverflow-v2.6-pro',
        'openai/gpt-image-2.6-sunburst',
    ]),
});
