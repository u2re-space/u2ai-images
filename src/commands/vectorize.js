/**
 * @file src/commands/vectorize.js
 * @module commands/vectorize
 * @purpose `ai-image vectorize`: turn a raster into an SVG document.
 * @depends image/vectorize, commands/common, openai/client
 * @exports run
 * @ai.tags cli, vector, svg
 * @ai.hint keep
 */

import path from 'node:path';
import { vectorizePicture } from '../image/vectorize.js';
import {
    createCommandClient,
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
    if (!input) throw usageError('Give the picture: `ai-image vectorize logo.png --out logo.svg`.');

    const output = options.out
        ? path.resolve(cwd, options.out)
        : path.resolve(cwd, path.join(path.dirname(input), `${path.parse(input).name}.svg`));
    const model = options.imageModel ?? config?.vectorModel ?? null;

    const plan = {
        command: 'vectorize',
        input,
        model,
        output: path.relative(cwd, output).split(path.sep).join('/'),
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const client = createCommandClient({ config, env, renderer });
    try {
        const result = await vectorizePicture({
            client,
            config,
            input: path.resolve(cwd, input),
            output,
            prompt: options.positionals.slice(1).join(' ').trim(),
            model,
            cwd,
            maxBytes: config?.limits?.maxImageBytes ?? null,
        });
        if (!result.suitable) {
            renderer.line('warn', `The picture has ${result.colors} colors: the tracing may be heavy.`);
        }
        return reportResult({ options, renderer }, {
            command: 'vectorize',
            model: result.model,
            colors: result.colors,
            files: [result.rel],
            text: result.rel,
        });
    } finally {
        client.close();
    }
}
