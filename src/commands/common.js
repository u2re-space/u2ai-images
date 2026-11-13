/**
 * @file src/commands/common.js
 * @module commands/common
 * @purpose The parts every command shares: the errors of the arguments, the output target, the
 *          format, the engine and the client.
 * @depends node:path, openai/client
 * @usedBy commands/*
 * @exports usageError, numberOption, pictureFormat, outputTarget, engineOf, localTarget,
 *          createCommandClient, describeEvent, reportPlan, reportResult
 * @ai.tags cli, commands
 * @ai.hint keep
 */

import path from 'node:path';
import { createClient } from '../openai/client.js';

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
 * The client of a command: the network is opened here and closed by the caller.
 * @param {{ config: object, env?: object, renderer?: object|null, signal?: AbortSignal|null }} ctx
 * @returns {object} the client
 * @exports
 * @ai.hint io
 */
export function createCommandClient({ config, env = process.env, renderer = null, signal = null }) {
    return createClient({
        config,
        env,
        signal,
        onEvent: renderer
            ? (event) => renderer.event({ type: 'verbose', kind: 'info', text: describeEvent(event) })
            : null,
    });
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
    for (const file of files) renderer.line('result', file);
    if (!files.length && result.text) renderer.line('result', result.text);
    return 0;
}
