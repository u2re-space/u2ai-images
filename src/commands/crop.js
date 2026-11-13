/**
 * @file src/commands/crop.js
 * @module commands/crop
 * @purpose `ai-image crop`: cut a box out of a picture, or cut its padding off.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, crop
 * @ai.hint keep
 */

import path from 'node:path';
import { cropPicture } from '../image/tools.js';
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
        throw usageError('Give the picture: `ai-image crop picture.png --x 10 --y 20 --width 100 --height 50`.');
    }
    const x = numberOption(options.x, '--x', { min: 0 }) ?? 0;
    const y = numberOption(options.y, '--y', { min: 0 }) ?? 0;
    const width = numberOption(options.width, '--width', { min: 1 });
    const height = numberOption(options.height, '--height', { min: 1 });
    const trim = options.trim === true;
    const fuzz = numberOption(options.fuzz, '--fuzz', { min: 0, max: 255 }) ?? 6;
    if (!trim && (!width || !height)) {
        throw usageError('Give the width and the height of the box, or ask for a trim.');
    }
    const output = localTarget({ options, cwd, input, suffix: trim ? 'trim' : 'crop' });

    const plan = {
        command: 'crop',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        box: trim ? null : { x, y, width, height },
        trim,
        fuzz,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await cropPicture({
        input: path.resolve(cwd, input),
        output,
        x,
        y,
        width,
        height,
        trim,
        fuzz,
        transparentOnly: options.transparentOnly === true,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'crop',
        source: result.source,
        width: result.width,
        height: result.height,
        changed: result.changed,
        reason: result.reason,
        files: [path.relative(cwd, path.resolve(cwd, output)).split(path.sep).join('/')],
    });
}
