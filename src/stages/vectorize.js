/**
 * @file src/stages/vectorize.js
 * @module stages/vectorize
 * @purpose The stage of the vector: the raster is prepared, traced, checked and written as an
 *          SVG document.
 * @depends roles/vectorizer
 * @usedBy roles/processor, agent/pipeline
 * @exports runVectorizeStage
 * @ai.tags stages, vector, svg
 * @ai.hint io
 */

import path from 'node:path';
import { vectorizeAsset } from '../roles/vectorizer.js';

/**
 * Turn a raster into a vector document.
 *
 * The stage answers with the document only when the document opens: a file that cannot be
 * rendered is not an asset, and the run has to know that.
 * @param {{ client: object, config?: object|null, input: string, output?: string|null,
 *   cwd?: string, prompt?: string, model?: string|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ path: string|null, colors: number|null, suitable: boolean, ok: boolean,
 *   reason: string, notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runVectorizeStage({
    client, config = null, input, output = null, cwd = process.cwd(), prompt = '', model = null, signal = null,
}) {
    const abs = path.resolve(cwd, input);
    const target = output
        ? path.resolve(cwd, output)
        : path.join(path.dirname(abs), `${path.parse(abs).name}.svg`);
    const result = await vectorizeAsset({
        client,
        config,
        input: abs,
        output: target,
        cwd,
        signal,
        model: model ?? config?.vectorModel ?? null,
        prompt,
    });
    return {
        path: result.ok ? result.path : null,
        colors: result.colors,
        suitable: result.suitable,
        ok: result.ok,
        reason: result.reason,
        notes: result.notes,
    };
}
