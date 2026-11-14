/**
 * @file src/commands/alpha.js
 * @module commands/alpha
 * @purpose `ai-image alpha`: build a real alpha channel for a picture.
 * @depends image/alpha, commands/common, openai/client
 * @exports run
 * @ai.tags cli, alpha
 * @ai.hint keep
 */

import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { alphaFormatWarning, applyGeneratedAlphaMask } from '../image/alpha.js';
import {
    createCommandClient,
    engineOf,
    localTarget,
    reportPlan,
    reportResult,
    usageError,
} from './common.js';

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string, env?: object }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const env = ctx.env ?? process.env;

    const input = options.positionals[0];
    if (!input) {
        throw usageError('Give the picture: `ai-image alpha picture.png --alpha-mode key`.');
    }
    const mode = String(options.alphaMode ?? config?.image?.alphaMode ?? 'auto').trim().toLowerCase();
    // The subject is what the model has to keep: the name of the object of the picture.
    const subject = String(options.subject ?? '').trim() || null;
    // The model is asked more than once: it draws the picture a little differently every time,
    // and the answers are taken together, so a detail that one of them lost comes back.
    const asked = Number.parseInt(String(options.attempts ?? '').trim(), 10);
    const attempts = Number.isSafeInteger(asked) && asked > 0 ? asked : 3;
    const output = localTarget({ options, cwd, input, suffix: 'alpha', ext: '.png' });

    const plan = {
        command: 'alpha',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        mode,
        attempts,
        ...(subject ? { subject } : {}),
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const warning = alphaFormatWarning(output);
    if (warning) throw usageError(warning);

    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.resolve(cwd, input), output);

    const client = await createCommandClient({ config, env, renderer, options, cwd });
    try {
        const result = await applyGeneratedAlphaMask({
            client,
            config,
            file: output,
            signal: null,
            model: options.imageModel ?? null,
            alphaMode: mode,
            subject,
            attempts,
        });
        if (!result.changed && result.reason !== 'already') {
            renderer.line('warn', `The alpha channel was not built: ${result.reason}.`);
        }
        return reportResult({ options, renderer }, {
            command: 'alpha',
            mode,
            attempts,
            changed: result.changed,
            reason: result.reason,
            ...(result.model ? { model: result.model } : {}),
            files: [path.relative(cwd, output).split(path.sep).join('/')],
            text: result.changed
                ? `the alpha channel is built (${result.reason})${result.model ? ` by ${result.model}` : ''}`
                : `the alpha channel was not built: ${result.reason}`,
        });
    } finally {
        client.close();
    }
}
