/**
 * @file src/commands/pad.js
 * @module commands/pad
 * @purpose `ai-image pad`: extend the canvas to a frame, without touching the picture.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, pad
 * @ai.hint keep
 */

import path from 'node:path';
import { padPicture } from '../image/tools.js';
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
        throw usageError('Give the picture: `ai-image pad picture.png --width 1200 --height 800`.');
    }
    const width = numberOption(options.width, '--width', { min: 1 });
    const height = numberOption(options.height, '--height', { min: 1 });
    if (!width && !height) {
        throw usageError('Give the width or the height of the new canvas.');
    }
    const color = options.color ?? 'transparent';
    const output = localTarget({ options, cwd, input, suffix: 'pad' });

    const plan = {
        command: 'pad',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        width,
        height,
        color,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await padPicture({
        input: path.resolve(cwd, input),
        output,
        width,
        height,
        color,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'pad',
        width: result.width,
        height: result.height,
        files: [path.relative(cwd, path.resolve(cwd, output)).split(path.sep).join('/')],
    });
}
