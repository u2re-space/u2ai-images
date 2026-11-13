/**
 * @file src/stages/crop.js
 * @module stages/crop
 * @purpose The stage of the source: the box or the trim the planner asked for.
 * @depends image/tools, image/raster
 * @usedBy agent/pipeline, roles/processor
 * @exports runCropStage
 * @ai.tags stages, crop
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { cropPicture } from '../image/tools.js';
import { rasterInfo } from '../image/raster.js';

/**
 * Bring the source to the working form the planner asked for.
 *
 * The box is taken from the source, never from a scaled copy of it, and the trim is the crop
 * with `trim`: there is no separate tool for the padding of a picture.
 * @param {{ sources: string[], plan: object, cwd?: string, config?: object|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ sources: Array<{ path: string, width: number, height: number, cropped: boolean, reason: string }>,
 *   changed: boolean, notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runCropStage({ sources = [], plan = {}, cwd = process.cwd(), config = null, signal = null }) {
    const notes = [];
    const crop = plan?.crop ?? null;
    if (!crop || (!crop.trim && !(crop.width && crop.height))) {
        const untouched = [];
        for (const source of sources) {
            const info = await rasterInfo(path.resolve(cwd, source), { cwd, engine: config?.image?.rasterEngine ?? 'auto' })
                .catch(() => null);
            untouched.push({
                path: source,
                width: info?.width ?? 0,
                height: info?.height ?? 0,
                cropped: false,
                reason: 'not-needed',
            });
        }
        return { sources: untouched, changed: false, notes };
    }
    const engine = config?.image?.rasterEngine ?? 'auto';
    const maxBytes = config?.limits?.maxImageBytes ?? null;
    const prepared = [];
    for (const source of sources) {
        const abs = path.resolve(cwd, source);
        const output = path.join(path.dirname(abs), `${path.parse(abs).name}-crop${path.extname(abs) || '.png'}`);
        try {
            const result = await cropPicture({
                input: abs,
                output,
                x: crop.x ?? 0,
                y: crop.y ?? 0,
                width: crop.width ?? null,
                height: crop.height ?? null,
                trim: crop.trim === true,
                transparentOnly: crop.trim === true,
                cwd,
                engine,
                maxBytes,
                signal,
            });
            prepared.push({
                path: path.relative(cwd, output).split(path.sep).join('/'),
                width: result.width,
                height: result.height,
                cropped: result.changed !== false,
                reason: result.reason,
            });
            if (result.changed === false) notes.push(`${source}: nothing to crop (${result.reason}).`);
        } catch (error) {
            notes.push(`${source}: the crop failed (${error?.message ?? error}).`);
            const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
            prepared.push({
                path: source,
                width: info?.width ?? 0,
                height: info?.height ?? 0,
                cropped: false,
                reason: 'failed',
            });
        }
    }
    return { sources: prepared, changed: prepared.some((item) => item.cropped), notes };
}
