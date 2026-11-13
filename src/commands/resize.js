/**
 * @file src/commands/resize.js
 * @module commands/resize
 * @purpose `ai-image resize`: change the size of a picture.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, resize
 * @ai.hint keep
 */

import path from 'node:path';
import { resizePicture } from '../image/tools.js';
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
        throw usageError('Give the picture: `ai-image resize picture.png --width 800`.');
    }
    const width = numberOption(options.width, '--width', { min: 1 });
    const height = numberOption(options.height, '--height', { min: 1 });
    const maxSide = numberOption(options.maxSide, '--max-side', { min: 1 });
    const factor = numberOption(options.factor, '--factor', { min: 1 });
    if (!width && !height && !maxSide && !factor) {
        throw usageError('Give the width, the height, the longest side or the factor of the new size.');
    }
    const output = localTarget({ options, cwd, input, suffix: 'resize' });

    const plan = {
        command: 'resize',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        width,
        height,
        maxSide,
        factor,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await resizePicture({
        input: path.resolve(cwd, input),
        output,
        width,
        height,
        maxSide,
        factor,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'resize',
        width: result.width,
        height: result.height,
        files: [path.relative(cwd, path.resolve(cwd, output)).split(path.sep).join('/')],
    });
}
