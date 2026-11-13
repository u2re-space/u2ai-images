/**
 * @file src/stages/padding.js
 * @module stages/padding
 * @purpose The stage of the canvas: the source is extended to a bigger canvas without being
 *          scaled, and the padding is cut off the answer.
 * @depends image/tools, image/padding
 * @usedBy agent/pipeline, roles/processor
 * @exports runPaddingStage, cutPadding
 * @ai.tags stages, padding
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The rule of the house: the content keeps its scale and its place at the canvas origin (0,0).
 * A bigger canvas is made by adding empty space to the right and to the bottom — never by
 * scaling the picture, and never by moving it.
 */

import path from 'node:path';
import { padPicture } from '../image/tools.js';

/**
 * Extend the source to a bigger canvas.
 * @param {{ sources: string[], plan: object, cwd?: string, config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ sources: Array<{ path: string, width: number, height: number, padded: boolean }>,
 *   changed: boolean, notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runPaddingStage({ sources = [], plan = {}, cwd = process.cwd(), config = null, signal = null }) {
    const notes = [];
    const pad = plan?.pad ?? null;
    const engine = config?.image?.rasterEngine ?? 'auto';
    if (!pad || !(pad.width || pad.height)) {
        return {
            sources: sources.map((source) => ({ path: source, padded: false })),
            changed: false,
            notes,
        };
    }
    const prepared = [];
    for (const source of sources) {
        const abs = path.resolve(cwd, source);
        const output = path.join(path.dirname(abs), `${path.parse(abs).name}-pad${path.extname(abs) || '.png'}`);
        try {
            const result = await padPicture({
                input: abs,
                output,
                width: pad.width ?? null,
                height: pad.height ?? null,
                color: pad.color ?? 'transparent',
                cwd,
                engine,
                maxBytes: config?.limits?.maxImageBytes ?? null,
                signal,
            });
            prepared.push({
                path: path.relative(cwd, output).split(path.sep).join('/'),
                width: result.width,
                height: result.height,
                padded: true,
            });
        } catch (error) {
            notes.push(`${source}: the canvas could not be extended (${error?.message ?? error}).`);
            prepared.push({ path: source, padded: false });
        }
    }
    return { sources: prepared, changed: prepared.some((item) => item.padded), notes };
}

/**
 * Cut the padding off an answer.
 *
 * The answer of a model that was given a padded canvas comes back with the padding still on it.
 * The padding is cut off here, so the result has the frame the caller asked for.
 * @param {{ file: string, padding: { width: number, height: number }|null, cwd?: string,
 *   config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ file: string, cut: boolean, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function cutPadding({ file, padding, cwd = process.cwd(), config = null, signal = null }) {
    if (!padding || !(padding.width && padding.height)) {
        return { file, cut: false, reason: 'no-padding' };
    }
    const { rasterCrop, rasterInfo } = await import('../image/raster.js');
    const abs = path.resolve(cwd, file);
    const info = await rasterInfo(abs, { cwd, engine: config?.image?.rasterEngine ?? 'auto' }).catch(() => null);
    if (!info?.width || !info?.height) return { file, cut: false, reason: 'unreadable' };
    const width = Math.max(1, Math.round(info.width - padding.width));
    const height = Math.max(1, Math.round(info.height - padding.height));
    if (width >= info.width && height >= info.height) {
        return { file, cut: false, reason: 'no-padding' };
    }
    try {
        await rasterCrop({
            input: abs,
            output: abs,
            x: 0,
            y: 0,
            width,
            height,
            cwd,
            signal,
            engine: config?.image?.rasterEngine ?? 'auto',
        });
        return { file, cut: true, reason: 'cut' };
    } catch (error) {
        return { file, cut: false, reason: error?.message ?? String(error) };
    }
}
