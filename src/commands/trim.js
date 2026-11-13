/**
 * @file src/commands/trim.js
 * @module commands/trim
 * @purpose `ai-image trim`: cut the uniform or transparent edges off a picture.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, trim
 * @ai.hint keep
 */

import path from 'node:path';
import { trimPicture } from '../image/tools.js';
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
        throw usageError('Give the picture: `ai-image trim picture.png`.');
    }
    const fuzz = numberOption(options.fuzz, '--fuzz', { min: 0, max: 255 }) ?? 6;
    const transparentOnly = options.transparentOnly === true;
    const output = localTarget({ options, cwd, input, suffix: 'trim' });

    const plan = {
        command: 'trim',
        input,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        fuzz,
        transparentOnly,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await trimPicture({
        input: path.resolve(cwd, input),
        output,
        fuzz,
        transparentOnly,
        cwd,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    return reportResult({ options, renderer }, {
        command: 'trim',
        changed: result.changed,
        reason: result.reason,
        before: result.before,
        after: result.after,
        files: [path.relative(cwd, path.resolve(cwd, output)).split(path.sep).join('/')],
    });
}
