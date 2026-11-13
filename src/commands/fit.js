/**
 * @file src/commands/fit.js
 * @module commands/fit
 * @purpose `ai-image fit`: put a picture into a frame.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, fit
 * @ai.hint keep
 */

import path from 'node:path';
import { FIT_MODES, fitPicture } from '../image/tools.js';
import {
    engineOf,
    localTarget,
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
        throw usageError('Give the picture: `ai-image fit picture.png --width 1200 --height 800 --mode cover`.');
    }
    const width = numberOption(options.width, '--width', { min: 1 });
    const height = numberOption(options.height, '--height', { min: 1 });
    if (!width || !height) {
        throw usageError('Give the width and the height of the frame.');
    }
    const fit = String(options.mode ?? 'cover').trim().toLowerCase();
    if (!FIT_MODES.includes(fit)) {
        throw usageError(`The fit mode must be one of: ${FIT_MODES.join(', ')}. Got "${fit}".`);
    }
    const output = localTarget({ options, cwd, input, suffix: `fit-${fit}` });

    const plan = {
        command: 'fit',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        width,
        height,
        mode: fit,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await fitPicture({
        input: path.resolve(cwd, input),
        output,
        width,
        height,
        fit,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'fit',
        mode: fit,
        width: result.width,
        height: result.height,
        files: [path.relative(cwd, path.resolve(cwd, output)).split(path.sep).join('/')],
    });
}
