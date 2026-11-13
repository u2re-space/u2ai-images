/**
 * @file src/commands/split.js
 * @module commands/split
 * @purpose `ai-image split`: cut a picture into a grid of tiles.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, split
 * @ai.hint keep
 */

import path from 'node:path';
import { splitPicture } from '../image/tools.js';
import {
    engineOf,
    numberOption,
    reportPlan,
    reportResult,
    usageError,
} from './common.js';

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const input = options.positionals[0];
    if (!input) {
        throw usageError('Give the picture: `ai-image split picture.png --rows 2 --cols 3`.');
    }
    const rows = numberOption(options.rows, '--rows', { min: 1, max: 20 }) ?? 1;
    const cols = numberOption(options.cols, '--cols', { min: 1, max: 20 }) ?? 1;
    if (rows === 1 && cols === 1) {
        throw usageError('Ask for more than one row or more than one column.');
    }
    const outputDir = options.out
        ? path.resolve(cwd, options.out)
        : path.resolve(cwd, path.join(path.dirname(input), `${path.parse(input).name}-tiles`));

    const plan = {
        command: 'split',
        input,
        output: path.relative(cwd, outputDir).split(path.sep).join('/'),
        rows,
        cols,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await splitPicture({
        input: path.resolve(cwd, input),
        outputDir,
        rows,
        cols,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'split',
        source: result.source,
        rows,
        cols,
        files: result.tiles.map((tile) => path.relative(cwd, path.resolve(cwd, tile.abs ?? tile.rel)).split(path.sep).join('/')),
    });
}
