/**
 * @file src/roles/planner.js
 * @module roles/planner
 * @purpose The planner of the strategy: what the picture is for, of what frame, with what
 *          background, and what has to happen to the source before the model sees it.
 * @depends agent/ask, agent/schemas, model/purpose
 * @usedBy agent/pipeline, commands/process
 * @exports PLANNER_INSTRUCTIONS, defaultStrategy, normalizeStrategy, planStrategy
 * @ai.tags roles, planner, strategy
 * @ai.hint keep
 */

import { askRole } from '../agent/ask.js';
import { PLANNER_SCHEMA } from '../agent/schemas.js';
import { canonicalPurpose, PURPOSE_NAMES } from '../model/purpose.js';
import { isBatchStop } from '../openai/batch.js';

/**
 * The instructions of the planner.
 *
 * The planner decides before anything is paid for: the purpose, the frame, the background and
 * the local work on the source. The rules it must not break are the rules of the image processor:
 * the source is never stretched, and a bigger canvas is made by extending it to the right and
 * to the bottom.
 */
export const PLANNER_INSTRUCTIONS = `You are the planner of a picture run. You decide how the picture is made before anything is generated, and you answer with the strategy alone.

Decide:
- purpose — what the picture is for: decompose (a layout, a template, a mockup), generate (a picture from a description), edit (a picture that is changed), remove_background (a subject cut out of its background), upscale (a picture that is enlarged), unrotate (a picture that is straightened).
- size — the frame of the picture as WIDTHxHEIGHT, or null to let the model choose. Ask for a frame the model really serves.
- resolution — the tier (512, 1K, 2K, 4K) or null.
- format — png, jpeg or webp.
- background — auto, opaque, or transparent when the picture has to carry a real alpha channel.
- alphaMode — how the alpha channel is built: auto, mask (the model draws the matte), contour (the local contour), flat (the fill from the corners), key (the color of the border), off (no alpha at all).
- crop — what to do with the source before the model sees it: a box (x, y, width, height), a trim (cut the uniform or transparent padding off), or null when the source is ready.
- pad — the canvas to extend the source to (width, height, color), or null. Never scale the source to fit a canvas: extend it to the right and to the bottom, and keep the content at its own scale at the canvas origin (0,0).
- vectorize — whether the result has to become an SVG document. Only for a flat mark, a logo or an icon; never for a photograph.

Answer with the strategy alone. Do not generate anything.`;

/**
 * The strategy of a run when nothing is known about it.
 * @param {object} [config]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function defaultStrategy(config = null) {
    return {
        purpose: 'generate',
        size: null,
        resolution: config?.image?.resolution ?? null,
        format: config?.image?.format ?? 'png',
        background: config?.image?.background ?? 'auto',
        alphaMode: config?.image?.alphaMode ?? 'auto',
        crop: null,
        pad: null,
        vectorize: false,
        rationale: 'The default strategy: a plain generation with the settings of the configuration.',
    };
}

/**
 * Make the strategy of the model fit the pipeline.
 *
 * A model may answer with a purpose it invented, a frame it made up, or a field it left out.
 * The strategy is repaired here: the purpose has to be one the CLI knows, the format has to be
 * one the file may have, and the sizes have to be numbers.
 * @param {object} raw The answer of the model.
 * @param {object} [config]
 * @returns {object} the strategy
 * @exports
 * @ai.hint pure
 */
export function normalizeStrategy(raw, config = null) {
    const base = defaultStrategy(config);
    if (!raw || typeof raw !== 'object') return base;
    const purpose = canonicalPurpose(raw.purpose);
    const format = String(raw.format ?? '').trim().toLowerCase();
    const background = String(raw.background ?? '').trim().toLowerCase();
    const alphaMode = String(raw.alphaMode ?? '').trim().toLowerCase();
    const size = typeof raw.size === 'string' && /^\d+\s*x\s*\d+$/i.test(raw.size.trim())
        ? raw.size.trim().replace(/\s+/g, '').toLowerCase()
        : null;
    /**
     * A number of the answer, or null.
     * @param {unknown} value
     * @returns {number|null}
     * @ai.hint pure
     */
    const number = (value) => (Number.isFinite(value) ? Math.round(value) : null);
    return {
        purpose: PURPOSE_NAMES.includes(purpose) ? purpose : base.purpose,
        size: size ?? base.size,
        resolution: typeof raw.resolution === 'string' && raw.resolution.trim()
            ? raw.resolution.trim().toUpperCase()
            : base.resolution,
        format: ['png', 'jpeg', 'webp'].includes(format) ? format : base.format,
        background: ['auto', 'opaque', 'transparent'].includes(background) ? background : base.background,
        alphaMode: ['auto', 'mask', 'contour', 'flat', 'key', 'off'].includes(alphaMode)
            ? alphaMode
            : base.alphaMode,
        crop: raw.crop && typeof raw.crop === 'object'
            ? {
                x: number(raw.crop.x),
                y: number(raw.crop.y),
                width: number(raw.crop.width),
                height: number(raw.crop.height),
                trim: raw.crop.trim === true,
            }
            : null,
        pad: raw.pad && typeof raw.pad === 'object'
            ? {
                width: number(raw.pad.width),
                height: number(raw.pad.height),
                color: typeof raw.pad.color === 'string' && raw.pad.color.trim()
                    ? raw.pad.color.trim()
                    : null,
            }
            : null,
        vectorize: raw.vectorize === true,
        rationale: typeof raw.rationale === 'string' && raw.rationale.trim()
            ? raw.rationale.trim()
            : base.rationale,
    };
}

/**
 * Ask the planner for the strategy of a run.
 *
 * When the model is not there, or answers with something the pipeline cannot use, the default
 * strategy is used: a run without a plan is better than no run at all.
 * @param {{ client: object|null, config?: object|null, task: string, references?: string[],
 *   model?: string|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ strategy: object, source: 'model'|'default', errors: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function planStrategy({
    client = null, config = null, task, references = [], model = null, signal = null,
}) {
    const fallback = defaultStrategy(config);
    if (!client?.responses) {
        return { strategy: fallback, source: 'default', errors: ['no text model is configured'] };
    }
    const input = [
        `The task: ${task}`,
        references.length ? `The references: ${references.join(', ')}` : 'There are no references.',
    ].join('\n');
    try {
        const answer = await askRole({
            client,
            model: model ?? config?.roles?.planner?.model ?? config?.model ?? null,
            instructions: PLANNER_INSTRUCTIONS,
            input,
            schema: PLANNER_SCHEMA,
            name: 'strategy',
            signal,
        });
        if (!answer.data) {
            return { strategy: fallback, source: 'default', errors: answer.errors };
        }
        return {
            strategy: normalizeStrategy(answer.data, config),
            source: 'model',
            errors: answer.valid ? [] : answer.errors,
        };
    } catch (error) {
        // The batch route stops the run: the answers of the planner are not here yet, and a run
        // without a plan would pay for the same work twice.
        if (isBatchStop(error)) throw error;
        return { strategy: fallback, source: 'default', errors: [error?.message ?? String(error)] };
    }
}
