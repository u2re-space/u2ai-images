/**
 * @file src/image/vectorize.js
 * @module image/vectorize
 * @purpose Turn a raster into an SVG document with the vector model of the picture API.
 * @depends node:path, node:fs/promises, image/raster, image/magick, openai/images
 * @usedBy commands/vectorize, roles/vectorizer
 * @exports DEFAULT_VECTOR_PROMPT, assessVectorSource, vectorizePicture
 * @ai.tags images, vector, svg
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The tracing is done by a model, not by a contour tracer: the model keeps the shapes and the
 * palette of the original, and a local tracer would turn a logo into a polygon soup. The price is
 * that the model has to be there — and when it is not, the command says so instead of writing a
 * raster under the name of an SVG.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sniffImage } from '../openai/images.js';
import { detectMagick } from './magick.js';
import { rasterColorCount } from './raster.js';

/** The prompt of the tracing, when the caller names none. */
export const DEFAULT_VECTOR_PROMPT = 'Trace this picture as a vector SVG document with the same shapes and colors.';

/**
 * Is the picture worth tracing as a vector?
 *
 * The number of the colors is the measure: a picture with a handful of flat colors is a drawing,
 * a photograph is not — tracing it produces a document nobody can edit.
 * @param {{ input: string, cwd?: string, engine?: string, maxColors?: number, magickPath?: string|null }} options
 * @returns {Promise<{ suitable: boolean, colors: number|null, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function assessVectorSource({
    input, cwd = process.cwd(), engine = 'auto', maxColors = 256, magickPath = null,
}) {
    const exe = await detectMagick({ magickPath });
    if (exe) {
        const { assessVectorSuitability } = await import('./magick.js');
        const verdict = await assessVectorSuitability({
            exe, input, maxColors, cwd,
        }).catch(() => null);
        if (verdict) return verdict;
    }
    const colors = await rasterColorCount({ input, cwd, engine }).catch(() => null);
    if (colors == null) return { suitable: false, colors: null, reason: 'unreadable' };
    if (colors > maxColors) {
        return { suitable: false, colors, reason: `too-many-colors (${colors} > ${maxColors})` };
    }
    return { suitable: true, colors, reason: 'ok' };
}

/**
 * Trace one raster into an SVG document.
 *
 * The source goes to the model as an ordinary picture: the tracing model works on the pixels, and
 * the answer has to be an SVG document — a raster under the name of a vector is worse than an
 * honest failure.
 * @param {{ client: object, config?: object|null, input: string, output: string, prompt?: string,
 *   model?: string|null, cwd?: string, signal?: AbortSignal, maxColors?: number,
 *   maxBytes?: number|null }} options
 * @returns {Promise<{ rel: string, bytes: number, model: string|null, colors: number|null,
 *   suitable: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function vectorizePicture({
    client, config = null, input, output, prompt = '', model = null, cwd = process.cwd(),
    signal = null, maxColors = null, maxBytes = null,
}) {
    if (!client?.images?.vectorize) {
        throw new Error('No vector model is configured: set vectorModel in the config.');
    }
    const abs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const bytes = await readFile(abs);
    if (maxBytes && bytes.length > maxBytes) {
        throw new Error(`The picture is larger than the limit of ${maxBytes} bytes: ${input}`);
    }
    const ceiling = maxColors ?? config?.image?.vectorMaxColors ?? 256;
    const assessment = await assessVectorSource({
        input: abs,
        cwd,
        engine: config?.image?.rasterEngine ?? 'auto',
        maxColors: ceiling,
        magickPath: config?.image?.magickPath ?? null,
    });
    const kind = sniffImage(bytes);
    const usedModel = model ?? config?.vectorModel ?? config?.imageModel ?? null;
    const answer = await client.images.vectorize({
        model: usedModel,
        prompt: prompt || DEFAULT_VECTOR_PROMPT,
        image: { filename: path.basename(abs), mime: kind.mime, bytes },
        signal,
    });
    const first = answer?.images?.[0];
    if (!first?.bytes?.length) {
        throw new Error('The model answered without a picture.');
    }
    const document = Buffer.from(first.bytes);
    const out = sniffImage(document);
    if (out.ext !== 'svg') {
        throw new Error(`The model returned not an SVG document (${out.ext}): the tracing did not work.`);
    }
    const outAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });
    await writeFile(outAbs, document);
    return {
        rel: path.relative(cwd, outAbs).split(path.sep).join('/'),
        bytes: document.length,
        model: answer.model ?? usedModel,
        colors: assessment.colors,
        suitable: assessment.suitable,
    };
}
