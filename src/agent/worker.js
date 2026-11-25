/**
 * @file src/agent/worker.js
 * @module agent/worker
 * @purpose The cycle of the worker of the images system: the model asks, the parent runs the
 *          tools, the model answers.
 *
 *   The worker is a separate thread of the parent. It never touches a file by itself: the
 *   tools of the parent are the tools of the worker, and the parent is the one that holds
 *   them. The pictures travel as frames of bytes, so the work of a run does not wait for
 *   the disk.
 *
 *   The cycle is the same as the cycle of the sub-agent: the model is asked, it may call
 *   a tool, the parent runs the tool and answers, and the loop goes on until the model
 *   gives the final answer.
 *
 *   The big texts of a hand-over — the instructions of the role and the notes of the
 *   context — travel in the shared memory when the transport is a thread: one buffer, one
 *   copy in the memory.
 *
 * @depends shared/protocol, shared/shared, openai/client
 * @usedBy agent/worker-runner, bin/ai-image-agent-worker
 * @exports normalizeImageSpec, imageSpecTexts, runImageCycle, IMAGE_TOOLS
 * @ai.tags house, images, worker, agent
 * @ai.hint io
 */

import { readSharedBlock } from '../shared/shared.js';

/**
 * The tools the worker of the images system may call.
 *
 * The tools of the parent are the tools of the worker: the parent holds the rights, the
 * worker only asks.
 */
export const IMAGE_TOOLS = Object.freeze([
    'generate_image',
    'edit_image',
    'crop_image',
    'pad_image',
    'fit_image',
    'alpha_image',
    'vectorize_image',
    'compare_images',
    'view_image',
    'info_image',
    'resize_image',
    'trim_image',
    'split_image',
]);

/**
 * The text of a value: a string is itself, everything else is an empty string.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function textOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Normalize the spec of the work.
 *
 * Every field has a default, and the wrong type never throws: a spec that names nothing
 * is a spec of nothing, and the caller finds out by the report.
 *
 * @param {object} raw the spec as the parent wrote it
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function normalizeImageSpec(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const role = source.role && typeof source.role === 'object' ? source.role : {};
    const context = source.context && typeof source.context === 'object' ? source.context : {};
    const model = source.model && typeof source.model === 'object' ? source.model : {};
    const budget = source.budget && typeof source.budget === 'object' ? source.budget : {};
    return {
        role: {
            name: textOf(role.name).trim(),
            instructions: textOf(role.instructions),
            tools: Array.isArray(role.tools) && role.tools.length
                ? role.tools.map((item) => textOf(item).trim()).filter(Boolean)
                : [...IMAGE_TOOLS],
        },
        goal: textOf(source.goal).trim(),
        reason: textOf(source.reason).trim(),
        files: Array.isArray(source.files) ? source.files.map((item) => textOf(item).trim()).filter(Boolean) : [],
        model: {
            model: textOf(model.model).trim(),
            baseURL: textOf(model.baseURL).trim(),
            apiKey: textOf(model.apiKey).trim(),
            effort: textOf(model.effort).trim() || null,
        },
        budget: {
            maxTurns: Math.max(1, Math.round(Number(budget.maxTurns) || 8)),
        },
        context: {
            memory: textOf(context.memory),
            notes: textOf(context.notes),
            parts: Array.isArray(context.parts) ? context.parts : [],
        },
        // The shared memory of the hand-over: the big texts of the spec live in one
        // buffer the parent wrote, and the thread reads them from there instead of a copy.
        shared: source.shared instanceof SharedArrayBuffer ? source.shared : null,
    };
}

/**
 * The texts of the spec: from the shared memory, when the parent gave a buffer, or from
 * the spec itself.
 *
 * The shared buffer holds the big texts of a hand-over — the instructions of the role and
 * the notes of the context. A thread reads them from there instead of a copy: one buffer,
 * one copy in the memory.
 *
 * @param {object} spec the spec of the work
 * @returns {{ instructions: string, notes: string }}
 * @exports
 * @ai.hint pure
 */
export function imageSpecTexts(spec) {
    const shared = spec?.shared instanceof SharedArrayBuffer ? readSharedBlock(spec.shared) : null;
    if (shared) {
        return {
            instructions: shared.text('instructions') || textOf(spec?.role?.instructions),
            notes: shared.text('notes') || textOf(spec?.context?.notes),
        };
    }
    return {
        instructions: textOf(spec?.role?.instructions),
        notes: textOf(spec?.context?.notes),
    };
}

/**
 * The client of the model of the worker: the API of the parent, inherited through the spec.
 *
 * The worker talks to the API on its own thread, so it needs the address of the API and
 * the key of it. The parent writes them into the spec.
 *
 * @param {object} spec the spec of the work
 * @returns {Promise<object|null>} the client, or null when there is no API
 * @ai.hint io
 */
async function makeClient(spec) {
    if (!spec.model.baseURL) return null;
    try {
        const { createClient } = await import('../openai/client.js');
        return await createClient({
            config: {
                model: spec.model.model,
                baseURL: spec.model.baseURL,
                apiKey: spec.model.apiKey,
                reasoning: { effort: spec.model.effort },
                limits: { retries: 1 },
            },
        });
    } catch {
        return null;
    }
}

/**
 * The tool of a turn as the model sees it.
 * @param {string} name
 * @returns {object}
 * @ai.hint pure
 */
function toolSpec(name) {
    return {
        type: 'function',
        name,
        description: `The tool ${name} of the images system.`,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
    };
}

/**
 * The calls of the tools out of an answer of the model.
 * @param {object} answer the answer of the model
 * @returns {Array<{ id: string, callId: string, name: string, arguments: object }>}
 * @ai.hint pure
 */
function modelCalls(answer) {
    const output = Array.isArray(answer?.output) ? answer.output : [];
    const calls = [];
    for (const item of output) {
        if (item?.type !== 'function_call') continue;
        let args = {};
        try {
            args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {});
        } catch {
            args = {};
        }
        calls.push({
            id: textOf(item.id),
            callId: textOf(item.call_id) || textOf(item.id),
            name: textOf(item.name),
            arguments: args,
        });
    }
    return calls;
}

/**
 * The text of an answer of the model.
 * @param {object} answer
 * @returns {string}
 * @ai.hint pure
 */
function modelText(answer) {
    if (typeof answer?.output_text === 'string') return answer.output_text;
    const output = Array.isArray(answer?.output) ? answer.output : [];
    const parts = [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
    }
    return parts.join('');
}

/**
 * Run the cycle of the worker of the images system.
 *
 * The model is asked with the tools of the parent. Every call of a tool travels back to
 * the parent, and the parent runs it. The pictures of the work travel as frames of bytes:
 * the worker writes them into the shared cache, and the parent reads them from there.
 *
 * @param {{ spec: object, client?: object|null, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null }} request
 * @returns {Promise<object>} the report of the work
 * @exports
 * @ai.hint io
 */
export async function runImageCycle({ spec: rawSpec, client = null, onCall = null, onEvent = null, signal = null } = {}) {
    const spec = normalizeImageSpec(rawSpec);
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const role = spec.role.name;
    const goal = spec.goal;
    const name = textOf(rawSpec?.name) || role || 'worker';
    const texts = imageSpecTexts(spec);

    if (!goal) {
        return {
            ok: false,
            role,
            name,
            turns: 0,
            files: [],
            report: 'The worker was given no goal.',
            error: 'no-goal',
            stopped: 'failed',
        };
    }
    if (!role) {
        return {
            ok: false,
            role,
            name,
            turns: 0,
            files: [],
            report: 'The worker was given no role to inherit.',
            error: 'no-role',
            stopped: 'failed',
        };
    }
    if (!client?.responses?.create) {
        // The worker talks to the API on its own thread, so it needs the address of the
        // API and the key of it. The parent writes them into the spec: the worker
        // inherits the API of the parent instead of looking for one of its own.
        const made = await makeClient(spec);
        if (!made) {
            return {
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: 'The worker has no model to talk to.',
                error: 'no-client',
                stopped: 'failed',
            };
        }
        client = made;
    }

    const items = [{
        role: 'user',
        content: [
            { type: 'input_text', text: `The task: ${goal}` },
            ...(texts.notes ? [{ type: 'input_text', text: texts.notes }] : []),
            ...(spec.context.parts ?? []),
        ],
    }];

    let turns = 0;
    let stopped = 'working';
    let answer = null;
    let error = null;
    const written = [];

    try {
        // The flag of cancellation lives in the shared memory, when the parent gave a
        // buffer: the parent sets it with an atomic store, and the thread sees it here
        // without a message round trip.
        const shared = spec.shared instanceof SharedArrayBuffer ? readSharedBlock(spec.shared) : null;
        while (turns < spec.budget.maxTurns) {
            if (signal?.aborted) {
                stopped = 'aborted';
                break;
            }
            if (shared?.cancelled()) {
                // The parent asked the worker to stop: it winds down and still reports
                // what it did.
                stopped = 'aborted';
                break;
            }
            turns += 1;
            emit({ type: 'status', role, name, turn: turns, status: 'working' });

            const answerOfTurn = await client.responses.create({
                model: spec.model.model || null,
                instructions: texts.instructions || null,
                input: items,
                tools: spec.role.tools.map(toolSpec),
                store: false,
                signal,
                effort: spec.model.effort,
            });

            const calls = modelCalls(answerOfTurn);
            for (const call of calls) {
                // The call travels to the parent, and the parent runs it.
                let output = '';
                try {
                    output = textOf(await onCall?.({ name: call.name, arguments: call.arguments ?? {} }));
                } catch (cause) {
                    output = `The tool failed: ${cause?.message ?? String(cause)}`;
                }
                items.push({
                    type: 'function_call',
                    call_id: call.callId,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                });
                items.push({ type: 'function_call_output', call_id: call.callId, output });
                if (output && written.length < 200) written.push(output);
            }
            if (shared?.cancelled()) {
                // The parent asked the worker to stop while the turn was running: it
                // winds down and still reports what it did.
                stopped = 'aborted';
                break;
            }
            if (calls.length) {
                emit({
                    type: 'status',
                    role,
                    name,
                    turn: turns,
                    status: 'tools',
                    tools: calls.map((call) => call.name),
                });
                continue;
            }
            // The model answered with text and without a call of a tool: the turn is over.
            answer = answerOfTurn;
            stopped = 'completed';
            break;
        }
    } catch (cause) {
        error = cause?.message ?? String(cause);
        stopped = 'failed';
    }

    if (turns >= spec.budget.maxTurns && stopped === 'working') stopped = 'out-of-turns';
    const report = textOf(modelText(answer)).trim()
        || (stopped === 'failed' ? `The worker stopped: ${error}` : 'The worker gave no answer.');
    emit({ type: 'status', role, name, turn: turns, status: stopped, files: spec.files });

    return {
        ok: stopped === 'completed' && !error,
        role,
        name,
        turns,
        files: spec.files,
        report,
        error,
        stopped,
        notes: written,
    };
}
