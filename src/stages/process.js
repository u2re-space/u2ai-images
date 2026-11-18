/**
 * @file src/stages/process.js
 * @module stages/process
 * @purpose The stage of the model: the picture is asked for and written to disk.
 * @depends core/sink, model/purpose
 * @usedBy agent/pipeline, roles/processor
 * @exports runProcessStage
 * @ai.tags stages, model
 * @ai.hint io
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createImageSink } from '../core/sink.js';
import { sniffImage } from '../openai/images.js';
import { resolvePurposeModel } from '../model/purpose.js';
import { withDesignDirection } from '../core/design.js';

/**
 * Ask the model for the picture and write it down.
 *
 * With a source the request is an edit, without one it is a generation. The task stays intact;
 * optional design notes and reference images guide only the visual style.
 * @param {{ client: object, config?: object|null, plan: object, task: string,
 *   sources?: string[], references?: string[], design?: string, cwd?: string,
 *   outputDir?: string, signal?: AbortSignal|null }} options
 * @returns {Promise<{ file: string|null, model: string|null, route: string|null, payload: string|null,
 *   notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runProcessStage({
    client, config = null, plan = {}, task, sources = [], references = [], design = '',
    cwd = process.cwd(), outputDir = null, signal = null,
}) {
    const notes = [];
    const purpose = plan?.purpose ?? (sources.length ? 'edit' : 'generate');
    const model = resolvePurposeModel(config, purpose) ?? config?.imageModel ?? null;
    const size = plan?.size ?? null;
    const resolution = plan?.resolution ?? null;
    const format = plan?.format ?? config?.image?.format ?? 'png';
    const background = plan?.background ?? config?.image?.background ?? 'auto';

    /**
     * The pictures of the sources, as the request takes them.
     * @returns {Promise<object[]>}
     * @ai.hint io
     */
    const readSources = async () => {
        const files = [];
        for (const source of sources) {
            const abs = path.resolve(cwd, source);
            const bytes = await readFile(abs).catch(() => null);
            if (!bytes) {
                notes.push(`${source}: the source is not readable.`);
                continue;
            }
            files.push({ filename: path.basename(abs), mime: sniffImage(bytes).mime, bytes });
        }
        return files;
    };

    const files = await readSources();
    const referenceFiles = [];
    for (const reference of references) {
        const abs = path.resolve(cwd, reference);
        const bytes = await readFile(abs).catch(() => null);
        if (bytes) referenceFiles.push({ filename: path.basename(abs), mime: sniffImage(bytes).mime, bytes });
        else notes.push(`${reference}: the reference is not readable.`);
    }
    const referenceNote = references.length
        ? `\n\nReference images for visual guidance (do not copy their subject unless the task asks): ${references.join(', ')}.`
        : '';
    const prompt = `${withDesignDirection(task, design)}${referenceNote}`;
    let answer;
    try {
        answer = files.length
            ? await client.images.edit({
                model,
                purpose,
                prompt,
                files: [...files, ...referenceFiles],
                size,
                resolution,
                format,
                background,
                signal,
            })
            : await client.images.generate({
                model,
                purpose,
                prompt,
                size,
                resolution,
                format,
                background,
                referenceFiles,
                signal,
            });
    } catch (error) {
        notes.push(error?.message ?? String(error));
        return { file: null, model, route: null, payload: null, notes };
    }

    const payload = answer.payloads?.[0] ?? null;
    if (!payload) {
        notes.push('the model answered without a picture.');
        return { file: null, model: answer.model ?? model, route: answer.route ?? null, payload: null, notes };
    }
    const bytes = Buffer.from(payload, 'base64');
    const kind = sniffImage(bytes);
    const target = outputDir
        ? path.resolve(cwd, outputDir)
        : path.resolve(cwd, config?.image?.outputDir ?? '.ai/assets');
    const sink = createImageSink({ target, format, prefix: 'ai-image' });
    const saved = await sink.saveFinal('result', bytes, kind.ext === 'jpg' ? 'jpeg' : kind.ext);
    return {
        file: saved?.file ?? null,
        model: answer.model ?? model,
        route: answer.route ?? null,
        payload,
        notes,
    };
}
