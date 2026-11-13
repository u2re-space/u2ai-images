/**
 * @file src/commands/info.js
 * @module commands/info
 * @purpose `ai-image info`: what a picture is — the format, the frame, the alpha, the weight — and
 *          what may be done with it.
 * @depends image/tools, image/alpha, model/purpose
 * @exports run, suggestPurpose
 * @ai.tags cli, info
 * @ai.hint keep
 */

import path from 'node:path';
import { pictureInfo } from '../image/tools.js';
import { clearedShare, hasRealAlpha, softShare } from '../image/alpha.js';
import { rasterIsOpaque } from '../image/raster.js';
import { purposeModels, resolvePurposeModel } from '../model/purpose.js';
import { engineOf, reportResult, usageError } from './common.js';

/**
 * The purpose that fits a picture.
 *
 * The picture itself tells: an opaque one can be cut out, a small one can be enlarged, a ready one
 * can be edited. The answer is a suggestion — the model of the purpose is the one the
 * configuration resolves.
 * @param {{ width: number, height: number }} frame
 * @param {{ opaque: boolean|null }} alpha
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function suggestPurpose(frame, alpha) {
    const long = Math.max(frame?.width ?? 0, frame?.height ?? 0);
    if (alpha?.opaque === false) return 'edit';
    if (alpha?.opaque === true) return 'remove_background';
    if (long && long < 1024) return 'upscale';
    return 'edit';
}

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const file = options.positionals[0];
    if (!file) throw usageError('Give the picture: `ai-image info picture.png`.');

    const abs = path.resolve(cwd, file);
    const engine = engineOf({ options, config });
    const info = await pictureInfo({ input: abs, cwd, engine });
    // The format that can carry alpha is not the same as a picture that has transparent pixels:
    // a PNG may be fully opaque, and the picture is only opaque when every pixel says so.
    const opaque = await rasterIsOpaque(abs, { cwd, engine }).catch(() => null);
    const alpha = {
        opaque,
        cleared: await clearedShare({ abs, cwd, engine }).catch(() => null),
        soft: await softShare({ abs, cwd, engine }).catch(() => null),
        real: await hasRealAlpha({ abs, cwd, engine }).catch(() => false),
    };
    const purpose = suggestPurpose(info, alpha);
    const models = purposeModels(config, purpose);
    const resolved = resolvePurposeModel(config, purpose);
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    const transparency = alpha.opaque === null
        ? 'unknown'
        : (alpha.opaque ? 'opaque' : 'transparent');
    const text = [
        `${rel}`,
        `${info.width}x${info.height} ${info.format}`,
        `${info.bytes} bytes`,
        `alpha: ${transparency}`,
        `purpose: ${purpose} → ${resolved ?? config?.imageModel ?? 'no model'}`,
    ].join(' · ');

    return reportResult({ options, renderer }, {
        command: 'info',
        file: rel,
        path: abs,
        format: info.format,
        width: info.width,
        height: info.height,
        bytes: info.bytes,
        alpha,
        purpose: {
            name: purpose,
            models,
            resolved: resolved ?? config?.imageModel ?? null,
        },
        text,
    });
}
