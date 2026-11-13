/**
 * @file src/commands/compare.js
 * @module commands/compare
 * @purpose `ai-image compare`: a sheet of the pictures and a map of the difference.
 * @depends image/tools, commands/common
 * @exports run
 * @ai.tags cli, compare
 * @ai.hint keep
 */

import path from 'node:path';
import { comparePictures } from '../image/tools.js';
import {
    engineOf,
    numberOption,
    reportPlan,
    reportResult,
    usageError,
} from './common.js';

/** The layouts of a sheet. */
const LAYOUTS = Object.freeze(['row', 'column', 'grid']);

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const files = options.positionals.filter(Boolean);
    if (files.length < 2) {
        throw usageError('Give at least two pictures: `ai-image compare a.png b.png`.');
    }
    const layout = String(options.layout ?? 'row').trim().toLowerCase();
    if (!LAYOUTS.includes(layout)) {
        throw usageError(`The layout must be one of: ${LAYOUTS.join(', ')}. Got "${layout}".`);
    }
    const mode = String(options.mode ?? 'sheet').trim().toLowerCase();
    if (!['sheet', 'difference', 'both'].includes(mode)) {
        throw usageError('The mode must be one of: sheet, difference, both.');
    }
    const gap = numberOption(options.gap, '--gap', { min: 0, max: 256 }) ?? 8;
    const maxSide = numberOption(options.maxSide, '--max-side', { min: 64, max: 2048 }) ?? 768;
    const output = options.out
        ? path.resolve(cwd, options.out)
        : path.resolve(cwd, 'comparison.png');

    const plan = {
        command: 'compare',
        files,
        output: path.relative(cwd, output).split(path.sep).join('/'),
        layout,
        mode,
        labels: options.labels === true,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const result = await comparePictures({
        files,
        output,
        cwd,
        layout,
        frame: options.frame ?? '',
        gap,
        background: options.color ?? 'transparent',
        maxSide,
        labels: options.labels === true,
        mode,
        engine: engineOf({ options, config }),
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    const written = [result.rel, result.diff?.rel].filter(Boolean);
    return reportResult({ options, renderer }, {
        command: 'compare',
        layout,
        mode,
        engine: result.engine,
        width: result.width,
        height: result.height,
        items: result.items,
        diff: result.diff,
        files: written.map((file) => path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/')),
        text: result.diff
            ? `the sheet is ${result.width}x${result.height}, the difference is ${result.diff.similarity}% similar`
            : `the sheet is ${result.width}x${result.height}`,
    });
}
