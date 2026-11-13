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
    const output = localTarget({ options, cwd, input, suffix: 'alpha', ext: '.png' });

    const plan = {
        command: 'alpha',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        mode,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const warning = alphaFormatWarning(output);
    if (warning) throw usageError(warning);

    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.resolve(cwd, input), output);

    const client = createCommandClient({ config, env, renderer });
    try {
        const result = await applyGeneratedAlphaMask({
            client,
            config,
            file: output,
            signal: null,
            alphaMode: mode,
        });
        if (!result.changed && result.reason !== 'already') {
            renderer.line('warn', `The alpha channel was not built: ${result.reason}.`);
        }
        return reportResult({ options, renderer }, {
            command: 'alpha',
            mode,
            changed: result.changed,
            reason: result.reason,
            files: [path.relative(cwd, output).split(path.sep).join('/')],
        });
    } finally {
        client.close();
    }
}
