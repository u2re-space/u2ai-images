/**
 * @file src/model/vector.js
 * @module model/vector
 * @purpose The model that draws a vector document, and the prompt it draws it with.
 *
 *   The house picks the model: the pin of the config (`vectorModel`) wins, then the first
 *   model of the house's own lists that knows how to write a document, then the Sunburst of
 *   OpenAI — the model that takes `output_format: svg`.
 *
 * @depends model/profiles
 * @usedBy commands/generate, commands/vectorize, image/vectorize, stages/vectorize,
 *          roles/processor, agent/tools
 * @exports DEFAULT_VECTOR_MODEL, VECTOR_PROMPT, vectorModelFor
 * @ai.tags model, vector
 * @ai.hint pure
 */

import { DEFAULT_VECTOR_MODEL, imageModelProfile } from './profiles.js';

/**
 * The instruction that turns a picture into a vector document.
 *
 * The model behind `output_format: svg` paints the picture and the conversion model writes
 * the document, so the prompt has to ask for a document and not for a picture.
 */
export const VECTOR_PROMPT = 'Draw this as a vector SVG document: the same shapes, the same '
    + 'colours, the same proportions, and no raster parts. The result is an SVG file that a '
    + 'browser opens as it is.';

/**
 * The model that draws a vector document for the house.
 *
 * @param {object|null} config the configuration of the run
 * @returns {string} the id of the model
 * @exports
 * @ai.hint pure
 */
export function vectorModelFor(config = null) {
    const pinned = String(config?.vectorModel ?? '').trim();
    if (pinned) return pinned;
    const groups = config?.purpose?.models ?? {};
    for (const list of Object.values(groups)) {
        if (!Array.isArray(list)) continue;
        for (const model of list) {
            const name = String(model ?? '').trim();
            if (name && imageModelProfile(name).vector) return name;
        }
    }
    return DEFAULT_VECTOR_MODEL;
}
