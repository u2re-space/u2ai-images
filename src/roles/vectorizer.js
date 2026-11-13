/**
 * @file src/roles/vectorizer.js
 * @module roles/vectorizer
 * @purpose The vectorizer: a raster is prepared, traced by the vector model, checked, and written
 *          as an SVG document.
 * @depends image/vectorize, image/raster, image/svg
 * @usedBy roles/processor, agent/pipeline, commands/vectorize
 * @exports VECTORIZER_INSTRUCTIONS, prepareRaster, checkDocument, vectorizeAsset
 * @ai.tags roles, vector, svg
 * @ai.hint keep
 */

import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { assessVectorSource, vectorizePicture } from '../image/vectorize.js';
import { rasterColorCount, rasterInfo } from '../image/raster.js';
import { svgToPng } from '../image/svg.js';

/**
 * The instructions of the vectorizer.
 */
export const VECTORIZER_INSTRUCTIONS = `You are the vectorizer. You trace a raster into a vector SVG document.

Keep the shapes, the proportions and the palette of the source. A standalone document: a viewBox, no external references, no embedded raster, no font that is not embedded. currentColor where the recoloring matters, role="img" with a title when the picture is meaningful, or aria-hidden when it is purely decorative.

A document that does not open is worse than no document: check the XML before you answer.`;

/**
 * Prepare the raster for the tracing.
 *
 * The transparent padding around a logo is noise for the tracing and noise in the document: it
 * is cut off first. The palette is counted, so a photograph is not traced into a document nobody
 * can edit.
 * @param {{ input: string, cwd?: string, config?: object|null, maxColors?: number|null }} options
 * @returns {Promise<{ file: string, colors: number|null, suitable: boolean, reason: string,
 *   trimmed: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function prepareRaster({ input, cwd = process.cwd(), config = null, maxColors = null }) {
    const abs = path.resolve(cwd, input);
    const ceiling = maxColors ?? config?.image?.vectorMaxColors ?? 256;
    const engine = config?.image?.rasterEngine ?? 'auto';
    const assessment = await assessVectorSource({ input: abs, cwd, engine, maxColors: ceiling });
    let trimmed = false;
    let file = abs;
    // The transparent border of a logo is cut off before the tracing: it would end up in the
    // document as an empty rectangle.
    try {
        const { trimPicture } = await import('../image/tools.js');
        const trimmedTo = path.join(path.dirname(abs), `${path.parse(abs).name}-trim.png`);
        const result = await trimPicture({
            input: abs,
            output: trimmedTo,
            transparentOnly: true,
            cwd,
            engine,
        });
        if (result.changed) {
            trimmed = true;
            file = trimmedTo;
        }
    } catch {
        // The trimming is a preparation, not a requirement: the tracing may go on without it.
    }
    const colors = assessment.colors ?? await rasterColorCount({ input: file, cwd, engine }).catch(() => null);
    return {
        file,
        colors,
        suitable: assessment.suitable,
        reason: assessment.reason,
        trimmed,
    };
}

/**
 * Check that the document of the model opens.
 *
 * A document that cannot be rendered is not a document: it is a piece of text that looks like
 * one. The rendering is the check — the XML is parsed by the renderer itself.
 * @param {{ bytes: Buffer }} options
 * @returns {Promise<{ ok: boolean, reason: string, width: number|null, height: number|null }>}
 * @exports
 * @ai.hint io
 */
export async function checkDocument({ bytes }) {
    const text = Buffer.from(bytes ?? Buffer.alloc(0)).toString('utf8');
    if (!text.trim()) return { ok: false, reason: 'the document is empty', width: null, height: null };
    if (!/<svg[\s>]/i.test(text)) {
        return { ok: false, reason: 'the answer is not an SVG document', width: null, height: null };
    }
    const rendered = await svgToPng(Buffer.from(bytes)).catch(() => null);
    if (!rendered) {
        return { ok: false, reason: 'the document does not open', width: null, height: null };
    }
    return { ok: true, reason: 'opened', width: rendered.width, height: rendered.height };
}

/**
 * Trace a raster into an SVG document and write it.
 * @param {{ client: object, config?: object|null, input: string, output: string,
 *   cwd?: string, signal?: AbortSignal|null, model?: string|null, prompt?: string }} options
 * @returns {Promise<{ path: string, colors: number|null, suitable: boolean, ok: boolean,
 *   reason: string, notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function vectorizeAsset({
    client, config = null, input, output, cwd = process.cwd(), signal = null, model = null, prompt = '',
}) {
    const notes = [];
    const prepared = await prepareRaster({ input, cwd, config });
    if (!prepared.suitable) {
        notes.push(`the source has ${prepared.colors} colors: the tracing may be heavy.`);
    }
    const result = await vectorizePicture({
        client,
        config,
        input: prepared.file,
        output,
        prompt,
        model,
        cwd,
        signal,
        maxBytes: config?.limits?.maxImageBytes ?? null,
    });
    const bytes = await readFile(path.resolve(cwd, result.rel)).catch(() => null);
    const check = bytes
        ? await checkDocument({ bytes })
        : { ok: false, reason: 'the document was not written', width: null, height: null };
    if (!check.ok) {
        notes.push(check.reason);
    }
    return {
        path: result.rel,
        colors: prepared.colors,
        suitable: prepared.suitable,
        ok: check.ok,
        reason: check.reason,
        notes,
    };
}

/**
 * Write a document of the model to a file.
 * @param {{ bytes: Buffer, file: string, cwd?: string }} options
 * @returns {Promise<string>} the path relative to the working directory
 * @exports
 * @ai.hint io
 */
export async function writeDocument({ bytes, file, cwd = process.cwd() }) {
    const abs = path.resolve(cwd, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return path.relative(cwd, abs).split(path.sep).join('/');
}

/**
 * The frame of a raster, for the report.
 * @param {{ input: string, cwd?: string, config?: object|null }} options
 * @returns {Promise<{ width: number, height: number }|null>}
 * @exports
 * @ai.hint io
 */
export async function rasterFrame({ input, cwd = process.cwd(), config = null }) {
    const info = await rasterInfo(path.resolve(cwd, input), {
        cwd,
        engine: config?.image?.rasterEngine ?? 'auto',
    }).catch(() => null);
    return info?.width ? { width: info.width, height: info.height } : null;
}
