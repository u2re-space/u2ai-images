/**
 * @file src/commands/common.js
 * @module commands/common
 * @purpose The parts every command shares: the errors of the arguments, the output target, the
 *          format, the engine and the client.
 * @depends node:path, openai/client
 * @usedBy commands/*
 * @exports usageError, numberOption, pictureFormat, outputTarget, engineOf, localTarget,
 *          batchSetup, createCommandClient, describeEvent, reportPlan, reportResult
 * @ai.tags cli, commands
 * @ai.hint keep
 */

import path from 'node:path';
import { createClient } from '../openai/client.js';
import { createJournal } from '../openai/journal.js';
import { ApiError } from '../openai/errors.js';

/**
 * An error of the arguments: the command explains itself and the run ends with the code 2.
 * @param {string} message
 * @returns {Error}
 * @exports
 * @ai.hint pure
 */
export function usageError(message) {
    const error = new Error(message);
    error.usage = true;
    return error;
}

/**
 * Read a number of the command line.
 * @param {string|null|undefined} value
 * @param {string} name The name of the option, for the message.
 * @param {{ min?: number|null, max?: number|null, integer?: boolean }} [bounds]
 * @returns {number|null}
 * @exports
 * @ai.hint pure
 */
export function numberOption(value, name, { min = null, max = null, integer = true } = {}) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = integer ? Number.parseInt(String(value), 10) : Number(String(value));
    if (!Number.isFinite(parsed)) throw usageError(`The option ${name} must be a number, got "${value}".`);
    if (integer && !Number.isSafeInteger(parsed)) throw usageError(`The option ${name} must be a whole number, got "${value}".`);
    if (min !== null && parsed < min) throw usageError(`The option ${name} must not be less than ${min}.`);
    if (max !== null && parsed > max) throw usageError(`The option ${name} must not be more than ${max}.`);
    return parsed;
}

/**
 * The format of the written file.
 * @param {{ options: object, config?: object|null }} ctx
 * @returns {string} `png`, `jpeg`, `webp` or `svg`
 * @exports
 * @ai.hint pure
 */
export function pictureFormat({ options, config = null }) {
    const value = String(options.format ?? config?.image?.format ?? 'png').trim().toLowerCase();
    if (value === 'jpg') return 'jpeg';
    if (!['png', 'jpeg', 'webp', 'svg'].includes(value)) {
        throw usageError(`The format must be one of: png, jpeg, webp, svg. Got "${value}".`);
    }
    return value;
}

/**
 * Where the result is written.
 *
 * `--out` names a file or a directory; without it the result goes to the output directory of the
 * configuration. The path of the configuration is resolved against the working directory, so a
 * run writes where it was started.
 * @param {{ options: object, config?: object|null, cwd?: string }} ctx
 * @returns {{ target: string, dir: string, format: string }}
 * @exports
 * @ai.hint pure
 */
export function outputTarget({ options, config = null, cwd = process.cwd() }) {
    const format = pictureFormat({ options, config });
    if (options.out) {
        const target = path.resolve(cwd, options.out);
        return { target, dir: path.dirname(target), format };
    }
    const dir = path.resolve(cwd, options.outDir ?? config?.image?.outputDir ?? '.');
    return { target: dir, dir, format };
}

/**
 * The raster engine of the local operations.
 * @param {{ options: object, config?: object|null }} ctx
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function engineOf({ options, config = null }) {
    return String(options.engine ?? config?.image?.rasterEngine ?? 'auto');
}

/**
 * The file a local operation writes.
 *
 * `--out` names the file; without it the result lands next to the source under a derived name,
 * so the original is never overwritten by accident.
 * @param {{ options: object, cwd?: string, input: string, suffix: string, ext?: string|null }} ctx
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function localTarget({ options, cwd = process.cwd(), input, suffix, ext = null }) {
    if (options.out) return path.resolve(cwd, options.out);
    const source = path.resolve(cwd, input);
    const parsed = path.parse(source);
    return path.join(parsed.dir, `${parsed.name}-${suffix}${ext ?? parsed.ext}`);
}

/**
 * The batch route of a run: the phase and the journal the two phases share.
 *
 * The route is two-phase by nature: the first run submits the requests and stops, the second
 * one takes the answers and goes on. The journal is what the two phases share — the answer of
 * a request is found by the hash of the request, not by the order of the calls.
 * @param {{ config?: object|null, options?: object|null, cwd?: string }} ctx
 * @returns {{ mode: 'off'|'submit'|'fetch', journal: object|null }}
 * @exports
 * @ai.hint pure
 */
export function batchSetup({ config = null, options = null, cwd = process.cwd() } = {}) {
    const asked = options?.batchFetch
        ? 'fetch'
        : (options?.batch
            ? 'submit'
            : (config?.batch?.enabled === true
                ? (config?.batch?.mode === 'fetch' ? 'fetch' : 'submit')
                : 'off'));
    if (asked === 'off') return { mode: 'off', journal: null };
    const dir = path.resolve(cwd, String(config?.batch?.journalDir ?? '.ai-image/batch'));
    return { mode: asked, journal: createJournal({ dir }) };
}

/**
 * The client of a command: the network is opened here and closed by the caller.
 *
 * With the batch route on, the client carries the journal: the answers of the first phase are
 * taken from it, and the requests of the second phase are looked up in it.
 * @param {{ config: object, env?: object, renderer?: object|null, signal?: AbortSignal|null,
 *   options?: object|null, cwd?: string }} ctx
 * @returns {Promise<object>} the client
 * @exports
 * @ai.hint io
 */
export async function createCommandClient({ config, env = process.env, renderer = null, signal = null,
    options = null, cwd = process.cwd() }) {
    const { mode, journal } = batchSetup({ config, options, cwd });
    if (journal) await journal.init().catch(() => {});
    const client = await createClient({
        config,
        env,
        signal,
        batch: journal ? {
            mode,
            journal,
            collectMs: config?.batch?.collectMs,
            pollMs: config?.batch?.pollMs,
            waitMs: config?.batch?.waitMs,
            maxRequests: config?.batch?.maxRequests,
            minRequests: config?.batch?.minRequests,
            window: config?.batch?.window,
            endpoint: config?.batch?.endpoint,
        } : null,
        onEvent: renderer
            ? (event) => {
                const text = describeEvent(event);
                if (!text) return;
                // The progress of the run is live: the request that is made, the parts that
                // came back. The rest of the events are details of a verbose run.
                if (typeof renderer.progress === 'function'
                    && (event.type === 'request.start' || event.type === 'response.payload')) {
                    renderer.progress(text);
                    return;
                }
                renderer.event({ type: 'verbose', kind: 'info', text });
            }
            : null,
    });
    if (journal) {
        // The batch route needs a host that serves it: a host without the flag is never asked.
        if (!client.batches.hosts().length) {
            throw new ApiError('No host serves the batch route: put "supports": { "batch": true } into a '
                + 'backend of the config, and give that backend a key.', { code: 'NO_BATCH_HOST' });
        }
        // The second phase: the answers of the submitted batches go into the journal, and the
        // run goes on with them.
        if (mode === 'fetch') {
            const fetched = await client.batches.fetch();
            if (!fetched.ready) {
                throw new ApiError('The batch is not ready yet. Run the same command with --batch-fetch '
                    + 'again later.', { code: 'BATCH_NOT_READY' });
            }
        }
    }
    return client;
}

/**
 * A line of text about an event of the client.
 * @param {object} event
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function describeEvent(event) {
    if (!event || typeof event !== 'object') return '';
    if (event.type === 'request.start') return `${event.backend} ${event.path}${event.model ? ` · ${event.model}` : ''}`;
    if (event.type === 'request.error') return `${event.backend}: ${event.error}`;
    if (event.type === 'transport.fallback') return String(event.reason ?? 'the route changed');
    if (event.type === 'response.payload') return `the answer carries ${event.count ?? 1} picture(s)`;
    if (event.type === 'host.broke') return `${event.backend} has no money left`;
    if (event.type === 'model.fallback') return `${event.from} → ${event.to ?? 'no model'}`;
    if (event.type === 'journal.hit') return 'the answer was already paid for';
    if (event.type === 'batch.submit') return `the batch ${event.id} is submitted to ${event.host} (${event.requests} requests)`;
    if (event.type === 'batch.fetched') return `the batch ${event.id} is done: ${event.answers} answers`;
    if (event.type === 'batch.pending') return `the batch ${event.id} is not ready yet (${event.status ?? 'in progress'})`;
    if (event.type === 'batch.poll') return `the batch ${event.id}: ${event.status ?? 'in progress'}`;
    if (event.type === 'batch.missing') return `the batch ${event.id} is not known here (${event.host ?? 'the host is unknown'})`;
    if (event.type === 'batch.failed') return `the batch did not work out: ${event.error}`;
    return event.message ?? event.type;
}

/**
 * Report the plan of a command, when nothing is to be done yet.
 * @param {{ options: object, renderer: object }} ctx
 * @param {object} plan The plan itself.
 * @returns {number} the exit code
 * @exports
 * @ai.hint pure
 */
export function reportPlan({ options, renderer }, plan) {
    if (options.json) {
        renderer.json({ type: 'plan', status: 'dry-run', ...plan });
        return 0;
    }
    renderer.line('info', `Dry run: ${plan.command} would do the following.`);
    for (const [key, value] of Object.entries(plan)) {
        if (key === 'command' || value === null || value === undefined || value === '') continue;
        renderer.line('info', `  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    return 0;
}

/**
 * Report the result of a command.
 * @param {{ options: object, renderer: object }} ctx
 * @param {object} result
 * @returns {number} the exit code
 * @exports
 * @ai.hint pure
 */
export function reportResult({ options, renderer }, result) {
    if (options.json) {
        renderer.json({ type: 'result', status: 'ok', ...result });
        return 0;
    }
    const files = result.files ?? [];
    if (typeof renderer.files === 'function') renderer.files(files);
    else for (const file of files) renderer.line('result', file);
    // The line of the report: what the command did, in one line a person can read.
    if (result.text) renderer.line('info', result.text);
    return 0;
}
