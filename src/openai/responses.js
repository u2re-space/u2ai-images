/**
 * @file src/openai/responses.js
 * @module openai/responses
 * @purpose The Responses API: the body of a request, the image_generation tool and the reading
 *          of an answer that carries pictures.
 * @exports buildResponsesBody, imageGenerationTool, responsesImagePayloads, responsesOutputText,
 *          responsesError
 * @ai.tags openai, responses
 * @ai.hint legacy-0.2
 */

import { ApiError } from './errors.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Build the body of a Responses API request.
 *
 * Only the fields the picture CLI needs are here: the model, the input, the tools and the
 * forced tool choice. The tool choice of the fallback path is
 * `{ type: 'image_generation' }` — the host must run the picture tool instead of answering
 * with text.
 * @param {{ model?: string|null, instructions?: string|null, input?: unknown, tools?: object[]|null,
 *   toolChoice?: unknown, store?: boolean, stream?: boolean, text?: object|null }} [params]
 * @returns {object}
 */
export function buildResponsesBody({
    model = null, instructions = null, input = null, tools = null, toolChoice = null,
    store = false, stream = false, text = null,
} = {}) {
    const body = { model };
    if (instructions) body.instructions = instructions;
    body.input = input ?? '';
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    if (store) body.store = true;
    if (stream) body.stream = true;
    // The strict answer of a role: the shape the model has to fill.
    if (text) body.text = text;
    return body;
}

/**
 * The built-in picture tool of the Responses API.
 *
 * The tool draws the picture itself, so the frame travels in the `size` field of the tool and
 * the format in `output_format`. `partial_images` asks the host for the intermediate frames,
 * which the caller may use as a progress hint.
 * @param {{ format?: string|null, size?: string|null, background?: string|null, quality?: string|null,
 *   partialImages?: number|null }} [params]
 * @returns {object}
 */
export function imageGenerationTool({ format = null, size = null, background = null, quality = null, partialImages = null } = {}) {
    const tool = { type: 'image_generation' };
    if (format) tool.output_format = format;
    if (size) tool.size = size;
    if (background) tool.background = background;
    if (quality) tool.quality = quality;
    if (Number.isInteger(partialImages) && partialImages > 0) tool.partial_images = partialImages;
    return tool;
}

/**
 * The base64 pictures of a Responses answer.
 *
 * The host puts a finished picture into `output[].result` of an `image_generation_call` item;
 * a partial frame (the intermediate images of a stream) is not a result and is skipped here.
 * @param {object} answer
 * @returns {string[]}
 */
export function responsesImagePayloads(answer) {
    const output = Array.isArray(answer?.output) ? answer.output : [];
    const payloads = [];
    for (const item of output) {
        if (item?.type !== 'image_generation_call') continue;
        if (item?.status === 'failed' || item?.error) continue;
        const result = item?.result;
        if (typeof result !== 'string' || !result.trim()) continue;
        payloads.push(result.trim());
    }
    return payloads;
}

/**
 * The text of a Responses answer: the `output_text` field, or the concatenation of the
 * `output_text` parts of the output items.
 * @param {object} answer
 * @returns {string}
 */
export function responsesOutputText(answer) {
    if (typeof answer?.output_text === 'string') return answer.output_text;
    const output = Array.isArray(answer?.output) ? answer.output : [];
    const parts = [];
    for (const item of output) {
        if (item?.type !== 'message') continue;
        for (const part of item?.content ?? []) {
            if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
    }
    return parts.join('\n');
}

/**
 * The error of a Responses answer, when the host answered with one instead of a picture.
 *
 * The Images API reports a refusal in the body of a 200 answer; the Responses API reports it
 * the same way, so the body has to be checked before the answer is read as a picture.
 * @param {object} answer
 * @param {string} [route] the route name for the message
 * @returns {import('./errors.js').ApiError|null}
 */
export function responsesError(answer, route = 'responses') {
    if (!isRecord(answer)) return null;
    if (answer.error == null && answer.status !== 'failed') return null;
    const payload = isRecord(answer.error) ? answer.error : {};
    const message = typeof answer.error === 'string'
        ? answer.error
        : (typeof payload.message === 'string' ? payload.message : 'The gateway returned an error answer.');
    const sizeError = /\b(?:invalid\s+size|minimum\s+(?:pixel|image)\s+budget|below the current minimum pixel budget)\b/i.test(message);
    return new ApiError(`${route}: ${message}`, {
        code: sizeError ? 'IMAGE_SIZE_ERROR' : 'HTTP_ERROR',
        status: Number.isInteger(payload.status) ? payload.status : null,
        apiCode: payload.code ?? null,
        apiType: payload.type ?? null,
        param: payload.param ?? null,
    });
}
