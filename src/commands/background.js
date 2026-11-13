/**
 * @file src/commands/background.js
 * @module commands/background
 * @purpose `ai-image background`: remove the background of a picture.
 * @depends image/alpha, commands/common, openai/client
 * @exports run
 * @ai.tags cli, alpha, background
 * @ai.hint keep
 */

import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { alphaFormatWarning, applyGeneratedAlphaMask } from '../image/alpha.js';
import {
    createCommandClient,
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
        throw usageError('Give the picture: `ai-image background picture.png`.');
    }
    // The background of a picture is removed by building an alpha channel: `auto` is the mode
    // that tries every way of cutting it out.
    const mode = String(options.alphaMode ?? 'auto').trim().toLowerCase();
    const output = localTarget({ options, cwd, input, suffix: 'background', ext: '.png' });

    const plan = {
        command: 'background',
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
            renderer.line('warn', `The background was not removed: ${result.reason}.`);
        }
        return reportResult({ options, renderer }, {
            command: 'background',
            mode,
            changed: result.changed,
            reason: result.reason,
            files: [path.relative(cwd, output).split(path.sep).join('/')],
        });
    } finally {
        client.close();
    }
}
