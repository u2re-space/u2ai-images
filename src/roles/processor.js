/**
 * @file src/roles/processor.js
 * @module roles/processor
 * @purpose The processor of the assets: the plan is carried out, and the report says what was
 *          made, in which format, and how it has to be used.
 * @depends stages/crop, stages/padding, stages/process, stages/alignment, stages/correction,
 *   image/alpha, roles/vectorizer
 * @usedBy agent/pipeline, commands/process
 * @exports PROCESSOR_INSTRUCTIONS, processAssets, assetUse
 * @ai.tags roles, processor, assets
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The port of the role of the monolith. The rules of that role are kept:
 * - the source is never scaled and never stretched; a bigger canvas is made by extending it to
 *   the right and to the bottom, without moving the content;
 * - the trimming of the padding is a crop with `trim`, never a separate tool;
 * - an SVG is a text file: it is edited as text, not redrawn by a model;
 * - an unavailable operation is reported as unavailable, and a file that was not written is
 *   never claimed.
 */

import path from 'node:path';
import { runCropStage } from '../stages/crop.js';
import { runPaddingStage } from '../stages/padding.js';
import { runProcessStage } from '../stages/process.js';
import { runAlignmentStage, targetFrame } from '../stages/alignment.js';
import { runCorrectionStage } from '../stages/correction.js';
import { applyGeneratedAlphaMask } from '../image/alpha.js';
import { vectorizeAsset } from './vectorizer.js';
import { pictureInfo } from '../image/tools.js';

/**
 * The instructions of the processor.
 *
 * The role itself is carried out by the stages of the pipeline; the text is here for the hosts
 * that ask a model to describe the work, and for the report of the run.
 */
export const PROCESSOR_INSTRUCTIONS = `You are the image processor. You prepare the pictures, the fragments and the visual assets of the plan before the work on them begins.

The rules:
- Never scale, stretch, move or recenter a source. If a bigger canvas is needed, extend the canvas to the right and to the bottom without scaling the content, and keep the content at the canvas origin (0,0).
- Trimming the padding is a crop with trim=true, never a separate operation.
- An SVG is a text file: change its paths, its viewBox, its colors or its metadata in place. Never redraw it with a model.
- Compare the candidates with the comparison tool: it builds a local PNG sheet and a map of the difference, without a model request.
- Keep the source references unchanged. Write the assets under assets/ unless the task names another path.
- Say plainly when an operation is unavailable or failed. Never claim a file you did not write.

Report the assets separately from the typography, and every file with its path, its format and how the work has to use it.`;

/**
 * How an asset has to be used.
 * @param {object} plan
 * @param {string} kind
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function assetUse(plan, kind) {
    const purpose = plan?.purpose ?? 'generate';
    if (kind === 'svg') return 'the vector source of the artwork: edit it as a text file.';
    if (purpose === 'remove_background') return 'the cut-out of the subject: it carries a real alpha channel.';
    if (purpose === 'decompose') return 'the visual reference of the layout.';
    if (purpose === 'upscale') return 'the enlarged picture: the content is the source, only bigger.';
    if (purpose === 'unrotate') return 'the straightened picture.';
    if (purpose === 'edit') return 'the edited picture: the content of the source, changed.';
    return 'the picture of the task.';
}

/**
 * Carry the plan out and report what was made.
 * @param {{ client: object, config?: object|null, task: string, plan: object, sources?: string[],
 *   cwd?: string, outputDir?: string, signal?: AbortSignal|null, withModel?: boolean,
 *   maxAttempts?: number }} options
 * @returns {Promise<{ summary: string, assets: Array<{ path: string, format: string, use: string }>,
 *   typography: object[], notes: string[], files: string[], strategy: object }>}
 * @exports
 * @ai.hint io
 */
export async function processAssets({
    client, config = null, task, plan = {}, sources = [], cwd = process.cwd(), outputDir = null,
    signal = null, withModel = false, maxAttempts = 2,
}) {
    const notes = [];
    const assets = [];
    const files = [];

    // 1. The source is brought to the working form the planner asked for.
    const cropped = await runCropStage({ sources, plan, cwd, config, signal });
    notes.push(...cropped.notes);
    let prepared = cropped.sources.map((item) => item.path);

    // 2. The canvas is extended, without scaling anything.
    const padded = await runPaddingStage({ sources: prepared, plan, cwd, config, signal });
    notes.push(...padded.notes);
    prepared = padded.sources.map((item) => item.path);

    // 3. The model is asked for the picture.
    let processed = await runProcessStage({
        client, config, plan, task, sources: prepared, cwd, outputDir, signal,
    });
    notes.push(...processed.notes);
    if (!processed.file) {
        return {
            summary: 'The picture was not made: the model answered nothing.',
            assets,
            typography: [],
            notes,
            files,
            strategy: plan,
        };
    }
    files.push(processed.file);

    // 4. The transparency, when it was asked for.
    if (plan?.background === 'transparent' && plan?.alphaMode !== 'off') {
        const built = await applyGeneratedAlphaMask({
            client,
            config,
            file: processed.file,
            signal,
            alphaMode: plan?.alphaMode ?? 'auto',
        });
        if (built.changed) {
            notes.push(`the transparency was built (${built.reason}).`);
        } else if (built.reason !== 'already') {
            notes.push(`the transparency was not built: ${built.reason}.`);
        }
    }

    // 5. The frame of the answer.
    const source = prepared.length ? await pictureInfo({
        input: path.resolve(cwd, prepared[0]),
        cwd,
        engine: config?.image?.rasterEngine ?? 'auto',
    }).catch(() => null) : null;
    const frame = targetFrame({ plan, source });
    if (frame) {
        const aligned = await runAlignmentStage({
            file: processed.file,
            frame,
            cwd,
            config,
            signal,
        });
        if (aligned.changed) {
            notes.push(`the answer was brought to the frame ${aligned.width}x${aligned.height}.`);
        }
    }

    // 6. The check of the result, and a second attempt when it does not hold.
    let attempt = 1;
    let correction = await runCorrectionStage({
        client,
        config,
        plan,
        task,
        file: processed.file,
        source,
        cwd,
        signal,
        attempt,
        maxAttempts,
        withModel,
    });
    notes.push(...correction.notes);
    while (correction.retry?.retry && attempt < maxAttempts) {
        attempt += 1;
        const nextPlan = {
            ...plan,
            ...(correction.retry.changes?.size ? { size: correction.retry.changes.size } : {}),
            ...(correction.retry.changes?.alphaMode ? { alphaMode: correction.retry.changes.alphaMode } : {}),
        };
        notes.push(`the attempt ${attempt} is made with another strategy.`);
        const again = await runProcessStage({
            client, config, plan: nextPlan, task, sources: prepared, cwd, outputDir, signal,
        });
        if (!again.file) {
            notes.push(...again.notes);
            break;
        }
        processed = again;
        correction = await runCorrectionStage({
            client,
            config,
            plan: nextPlan,
            task,
            file: processed.file,
            source,
            cwd,
            signal,
            attempt,
            maxAttempts,
            withModel,
        });
        notes.push(...correction.notes);
    }

    // 7. The vector document, when it was asked for.
    if (plan?.vectorize) {
        const svg = path.join(path.dirname(processed.file), `${path.parse(processed.file).name}.svg`);
        const vector = await vectorizeAsset({
            client,
            config,
            input: processed.file,
            output: svg,
            cwd,
            signal,
            model: config?.vectorModel ?? null,
        });
        notes.push(...vector.notes);
        if (vector.ok) {
            files.push(path.resolve(cwd, vector.path));
            assets.push({
                path: vector.path,
                format: 'svg',
                use: assetUse(plan, 'svg'),
            });
        }
    }

    // 8. The report.
    const format = path.extname(processed.file).replace(/^\./, '').toLowerCase() || 'png';
    assets.unshift({
        path: path.relative(cwd, processed.file).split(path.sep).join('/'),
        format,
        use: assetUse(plan, 'raster'),
    });
    const issues = correction.issues.map((issue) => `${issue.kind}: ${issue.detail}`);
    return {
        summary: issues.length
            ? `The picture was made, but ${issues.length} issue(s) remain.`
            : 'The picture was made and holds the request.',
        assets,
        typography: [],
        notes: [...notes, ...issues],
        files,
        strategy: plan,
    };
}
