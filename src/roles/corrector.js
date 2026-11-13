/**
 * @file src/roles/corrector.js
 * @module roles/corrector
 * @purpose The corrector: the result is checked against what was asked for, and a second attempt
 *          is proposed when the first one does not hold.
 * @depends agent/ask, agent/schemas, image/alpha, image/raster
 * @usedBy stages/correction, agent/pipeline
 * @exports CORRECTOR_INSTRUCTIONS, checkResult, judgeResult, decideRetry
 * @ai.tags roles, corrector
 * @ai.hint keep
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { askRole } from '../agent/ask.js';
import { CORRECTOR_SCHEMA } from '../agent/schemas.js';
import { rasterInfo, rasterIsOpaque } from '../image/raster.js';
import { sniffImage } from '../openai/images.js';

/**
 * The instructions of the corrector.
 *
 * The corrector looks at the result and says what is wrong with it. It never rewrites the
 * picture itself: it says which frame, which mode of the alpha channel or which model has to
 * change, and the run decides whether to try again.
 */
export const CORRECTOR_INSTRUCTIONS = `You are the corrector. You look at the picture that was made and you check it against the request.

Check:
- the frame: is the picture of the frame that was asked for?
- the alpha: does the picture carry the transparency that was asked for?
- the artifacts: are there the defects a model leaves behind — a cut-off object, a warped line, a wrong detail, a watermark, a duplicated element, a smear?
- the content: is it the picture the task asked for?

Answer with the verdict alone. Name the trouble of every issue, and say what has to change on the next attempt: another frame, another mode of the alpha channel, another model, or nothing at all. Never ask for a repetition when the result may be used as it is.`;

/**
 * Check the result against the request, without a model.
 *
 * The checks that do not need eyes: the frame, the transparency, the format. A picture of the
 * wrong frame or without the asked transparency is wrong whatever it looks like.
 * @param {{ file: string, plan?: object|null, source?: { width: number, height: number }|null,
 *   cwd?: string, config?: object|null }} options
 * @returns {Promise<{ issues: Array<{ kind: string, detail: string }>, frame: object|null,
 *   alpha: object|null, format: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function checkResult({ file, plan = null, source = null, cwd = process.cwd(), config = null }) {
    const abs = path.resolve(cwd, file);
    const engine = config?.image?.rasterEngine ?? 'auto';
    const issues = [];
    const info = await rasterInfo(abs, { cwd, engine }).catch(() => null);
    if (!info?.width || !info?.height) {
        issues.push({ kind: 'format', detail: 'the picture cannot be read.' });
        return { issues, frame: null, alpha: null, format: null };
    }
    const frame = { width: info.width, height: info.height };

    const wanted = plan?.size ? String(plan.size) : null;
    if (wanted) {
        const [width, height] = wanted.split('x').map(Number);
        if (Number.isFinite(width) && Number.isFinite(height)
            && (width !== info.width || height !== info.height)) {
            issues.push({
                kind: 'frame',
                detail: `the frame is ${info.width}x${info.height}, ${wanted} was asked for.`,
            });
        }
    } else if (source?.width && source?.height
        && (source.width !== info.width || source.height !== info.height)) {
        issues.push({
            kind: 'frame',
            detail: `the frame is ${info.width}x${info.height}, the source is ${source.width}x${source.height}.`,
        });
    }

    const background = plan?.background ?? 'auto';
    const alphaMode = plan?.alphaMode ?? 'auto';
    let alpha = null;
    if (background === 'transparent' || alphaMode !== 'off') {
        const opaque = await rasterIsOpaque(abs, { cwd, engine }).catch(() => null);
        alpha = { opaque };
        if (background === 'transparent' && opaque === true) {
            issues.push({
                kind: 'alpha',
                detail: 'the transparency was asked for, but the picture is opaque.',
            });
        }
    }

    const bytes = await readFile(abs).catch(() => null);
    const format = bytes ? sniffImage(bytes).ext : null;
    if (background === 'transparent' && (format === 'jpg' || format === 'jpeg')) {
        issues.push({
            kind: 'format',
            detail: 'JPEG carries no alpha channel: the transparency would be lost.',
        });
    }
    return { issues, frame, alpha, format };
}

/**
 * Let the model look at the result.
 *
 * Only the artifacts need eyes: the frame and the transparency are checked locally, where the
 * answer is exact.
 * @param {{ client: object|null, config?: object|null, file: string, plan?: object|null,
 *   task?: string, cwd?: string, signal?: AbortSignal|null }} options
 * @returns {Promise<{ issues: Array<{ kind: string, detail: string }>, notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function judgeResult({
    client = null, config = null, file, plan = null, task = '', cwd = process.cwd(), signal = null,
}) {
    if (!client?.responses) return { issues: [], notes: [] };
    const abs = path.resolve(cwd, file);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) return { issues: [], notes: ['the picture cannot be read.'] };
    const mime = sniffImage(bytes).mime;
    const input = [
        {
            type: 'input_text',
            text: `The task: ${task || '(none)'}\n`
                + `The frame that was asked for: ${plan?.size ?? 'the frame of the source'}\n`
                + 'Look at the picture and name the defects a model leaves behind.',
        },
        { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` },
    ];
    try {
        const answer = await askRole({
            client,
            model: config?.roles?.corrector?.model ?? config?.model ?? null,
            instructions: CORRECTOR_INSTRUCTIONS,
            input,
            schema: CORRECTOR_SCHEMA,
            name: 'verdict',
            signal,
        });
        if (!answer.data) return { issues: [], notes: answer.errors };
        const issues = Array.isArray(answer.data.issues)
            ? answer.data.issues
                .filter((issue) => issue && typeof issue.detail === 'string')
                .map((issue) => ({
                    kind: ['frame', 'alpha', 'artifact', 'content', 'format'].includes(issue.kind)
                        ? issue.kind
                        : 'artifact',
                    detail: issue.detail,
                }))
            : [];
        return {
            issues,
            notes: Array.isArray(answer.data.notes) ? answer.data.notes : [],
            retry: answer.data.retry ?? null,
        };
    } catch (error) {
        return { issues: [], notes: [error?.message ?? String(error)] };
    }
}

/**
 * What has to change on the next attempt.
 *
 * The issues decide it: a wrong frame is answered with the frame of the source, a missing
 * transparency with another mode of the alpha channel, an artifact with the next model of the
 * chain. An issue that nothing can be done about is not a reason to try again.
 * @param {{ issues: Array<{ kind: string, detail: string }>, plan?: object|null,
 *   source?: { width: number, height: number }|null, attempt?: number, maxAttempts?: number }} options
 * @returns {{ retry: boolean, reason: string, changes: object|null }}
 * @exports
 * @ai.hint pure
 */
export function decideRetry({ issues = [], plan = null, source = null, attempt = 1, maxAttempts = 2 }) {
    if (!issues.length) return { retry: false, reason: 'nothing is wrong', changes: null };
    if (attempt >= maxAttempts) {
        return { retry: false, reason: 'the attempts are over', changes: null };
    }
    const kinds = new Set(issues.map((issue) => issue.kind));
    const changes = {};
    if (kinds.has('frame') && source?.width && source?.height) {
        changes.size = `${source.width}x${source.height}`;
    }
    if (kinds.has('alpha')) {
        const alphaMode = plan?.alphaMode ?? 'auto';
        changes.alphaMode = alphaMode === 'auto' ? 'key' : alphaMode === 'key' ? 'mask' : 'auto';
    }
    if (kinds.has('artifact') || kinds.has('content')) {
        changes.model = 'fallback';
    }
    const retry = Object.keys(changes).length > 0;
    return {
        retry,
        reason: retry ? 'the result does not hold' : 'nothing can be changed',
        changes: retry ? changes : null,
    };
}
