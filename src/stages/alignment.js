/**
 * @file src/stages/alignment.js
 * @module stages/alignment
 * @purpose The stage of the frame: the answer is brought to the frame of the source or to the
 *          frame that was asked for.
 * @depends image/tools, image/sizing
 * @usedBy agent/pipeline, roles/processor
 * @exports runAlignmentStage, fitPayloadsToFrame
 * @ai.tags stages, alignment, sizing
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The name of the stage comes from the monolith: the answer of a model rarely has the frame the
 * caller asked for, and the frame is the promise of the file.
 */

import path from 'node:path';
import { fitPicture, pictureInfo } from '../image/tools.js';
import { parseImageSize } from '../image/sizing.js';

/**
 * The frame the answer has to have.
 *
 * The frame that was asked for wins; without it the frame of the source is the promise.
 * @param {{ plan?: object|null, source?: { width: number, height: number }|null }} options
 * @returns {{ width: number, height: number }|null}
 * @exports
 * @ai.hint pure
 */
export function targetFrame({ plan = null, source = null }) {
    const asked = parseImageSize(plan?.size ?? '');
    if (asked) return asked;
    if (source?.width && source?.height) return { width: source.width, height: source.height };
    return null;
}

/**
 * Bring a file to a frame.
 *
 * The content is fitted, never stretched: the frame is filled and the overflow is cut off.
 * @param {{ file: string, frame: { width: number, height: number }|null, fit?: 'contain'|'cover'|'fill',
 *   cwd?: string, config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ file: string, width: number, height: number, changed: boolean, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function runAlignmentStage({
    file, frame, fit = 'cover', cwd = process.cwd(), config = null, signal = null,
}) {
    const abs = path.resolve(cwd, file);
    if (!frame?.width || !frame?.height) {
        const info = await pictureInfo({ input: abs, cwd, engine: config?.image?.rasterEngine ?? 'auto' })
            .catch(() => null);
        return {
            file: abs,
            width: info?.width ?? 0,
            height: info?.height ?? 0,
            changed: false,
            reason: 'no-frame',
        };
    }
    const before = await pictureInfo({ input: abs, cwd, engine: config?.image?.rasterEngine ?? 'auto' })
        .catch(() => null);
    if (before && before.width === frame.width && before.height === frame.height) {
        return { file: abs, width: before.width, height: before.height, changed: false, reason: 'already' };
    }
    try {
        const result = await fitPicture({
            input: abs,
            output: abs,
            width: frame.width,
            height: frame.height,
            fit,
            cwd,
            engine: config?.image?.rasterEngine ?? 'auto',
            maxBytes: config?.limits?.maxImageBytes ?? null,
            signal,
        });
        return { file: abs, width: result.width, height: result.height, changed: true, reason: fit };
    } catch (error) {
        return { file: abs, width: before?.width ?? 0, height: before?.height ?? 0, changed: false, reason: error?.message ?? String(error) };
    }
}

/**
 * Bring the payloads of an answer to a frame.
 *
 * The payloads are base64 pictures; they are fitted one by one, and the ones that cannot be
 * read are left alone — the caller reports them instead of losing them.
 * @param {{ payloads: string[], frame: { width: number, height: number }|null, fit?: string,
 *   cwd?: string, config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ payloads: string[], changed: boolean, failed: number }>}
 * @exports
 * @ai.hint io
 */
export async function fitPayloadsToFrame({
    payloads = [], frame, fit = 'cover', cwd = process.cwd(), config = null, signal = null,
}) {
    if (!frame?.width || !frame?.height || !payloads.length) {
        return { payloads, changed: false, failed: 0 };
    }
    const { rasterFitToFrame } = await import('../image/raster.js');
    const engine = config?.image?.rasterEngine ?? 'auto';
    const out = [];
    let changed = false;
    let failed = 0;
    for (const payload of payloads) {
        signal?.throwIfAborted();
        const bytes = Buffer.from(payload, 'base64');
        const fitted = await rasterFitToFrame({
            bytes,
            width: frame.width,
            height: frame.height,
            fit,
            engine,
        }).catch(() => null);
        if (!fitted) {
            failed += 1;
            out.push(payload);
            continue;
        }
        changed = true;
        out.push(fitted.toString('base64'));
    }
    return { payloads: out, changed, failed };
}
