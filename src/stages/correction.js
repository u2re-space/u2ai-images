/**
 * @file src/stages/correction.js
 * @module stages/correction
 * @purpose The stage of the correction: the result is checked, and a second attempt is made when
 *          the first one does not hold.
 * @depends roles/corrector, image/alpha
 * @usedBy agent/pipeline, roles/processor
 * @exports runCorrectionStage
 * @ai.tags stages, correction
 * @ai.hint io
 */

import { applyGeneratedAlphaMask } from '../image/alpha.js';
import { checkResult, decideRetry, judgeResult } from '../roles/corrector.js';

/**
 * Check the result and, when it does not hold, try once more.
 *
 * The alpha is the first thing that is repaired: a missing transparency can be built locally,
 * without asking the model again. The frame and the artifacts need the model, and the model is
 * asked only when there is a reason to.
 * @param {{ client?: object|null, config?: object|null, plan: object, task?: string,
 *   file: string, source?: { width: number, height: number }|null, cwd?: string,
 *   signal?: AbortSignal|null, attempt?: number, maxAttempts?: number, withModel?: boolean }} options
 * @returns {Promise<{ ok: boolean, issues: Array<object>, changed: boolean, retry: object|null,
 *   notes: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runCorrectionStage({
    client = null, config = null, plan = {}, task = '', file, source = null, cwd = process.cwd(),
    signal = null, attempt = 1, maxAttempts = 2, withModel = false,
}) {
    const notes = [];
    const local = await checkResult({ file, plan, source, cwd, config });
    let issues = local.issues;
    let changed = false;

    // The transparency is repaired locally: the model may not be able to deliver it, but the
    // file still can carry it.
    if (issues.some((issue) => issue.kind === 'alpha') && plan?.background === 'transparent') {
        const built = await applyGeneratedAlphaMask({
            client,
            config,
            file,
            signal,
            alphaMode: plan?.alphaMode ?? 'auto',
        });
        if (built.changed) {
            changed = true;
            notes.push('the transparency was built locally.');
            const again = await checkResult({ file, plan, source, cwd, config });
            issues = again.issues;
        }
    }

    if (withModel && client?.responses && issues.length) {
        const verdict = await judgeResult({ client, config, file, plan, task, cwd, signal });
        issues = [...issues, ...verdict.issues];
        notes.push(...verdict.notes);
    }

    const decision = decideRetry({ issues, plan, source, attempt, maxAttempts });
    return { ok: issues.length === 0, issues, changed, retry: decision.retry ? decision : null, notes };
}
