/**
 * @file src/agent/ask.js
 * @module agent/ask
 * @purpose Ask a role for its answer and check that the answer is the shape the role promised.
 * @depends agent/schemas
 * @usedBy roles/planner, roles/processor, roles/corrector, roles/vectorizer
 * @exports askRole, parseJsonAnswer
 * @ai.tags roles, agent
 * @ai.hint io
 */

import { schemaEnvelope, validateAgainst } from './schemas.js';

/**
 * Read the JSON out of an answer of a model.
 *
 * The strict schema makes the answer JSON, but a host that does not know `text.format` answers
 * with prose, and a model that ignores the schema wraps its JSON in a fence. The answer is found
 * in all three cases; when it is not there at all, the caller falls back.
 * @param {string} text
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function parseJsonAnswer(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        // The answer may be fenced.
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            // The answer may hold the JSON among the prose.
        }
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Ask a role for its answer.
 *
 * The role is asked with the strict schema of its answer, so the model has to fill a known
 * shape. The answer is checked anyway: a host that ignores the schema must not pass a broken
 * answer further into the pipeline.
 * @param {{ client: object, model?: string|null, instructions: string, input: unknown,
 *   schema: object, name?: string, signal?: AbortSignal|null }} options
 * @returns {Promise<{ data: object|null, text: string, valid: boolean, errors: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function askRole({
    client, model = null, instructions, input, schema, name = 'answer', signal = null,
}) {
    const answer = await client.responses.create({
        model,
        instructions,
        input,
        text: schemaEnvelope(name, schema),
        signal,
        // The answer of a role is a text request of the run: it may go out as a part of a batch.
        batchable: true,
    });
    const text = client.responses.text(answer);
    const data = parseJsonAnswer(text);
    if (!data) {
        return { data: null, text, valid: false, errors: ['the answer is not JSON'] };
    }
    const check = validateAgainst(schema, data);
    return { data, text, valid: check.ok, errors: check.errors };
}
