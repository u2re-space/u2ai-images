/**
 * @file src/agent/pipeline.js
 * @module agent/pipeline
 * @purpose The orchestrator of the run: the strategy is planned, the assets are made, the result
 *          is checked, and the note of the run is written.
 * @depends roles/planner, roles/processor, roles/corrector, roles/learner, agent/tools
 * @usedBy commands/process
 * @exports STAGE_ORDER, runPipeline, pipelineReport
 * @ai.tags agent, pipeline, stages
 * @ai.hint keep
 *
 * The order is fixed: a stage may only read what the earlier stages wrote. The state of the run
 * travels from one stage to the next as a plain object, so a stage that fails does not take the
 * others down — the run reports what it has and what it does not.
 */

import path from 'node:path';
import { planStrategy } from '../roles/planner.js';
import { processAssets } from '../roles/processor.js';
import { checkResult } from '../roles/corrector.js';
import { readNotes, summarizeNotes, suggestStrategy, writeNote } from '../roles/learner.js';
import { createImageTools } from './tools.js';

/**
 * The stages of the run, in the order they run.
 *
 * - `learn` — the notes of the past runs are read; they may suggest the strategy.
 * - `plan` — the strategy is chosen.
 * - `process` — the pictures are made.
 * - `check` — the result is measured against the request.
 * - `note` — the note of the run is written.
 *
 * @type {ReadonlyArray<{ id: string, label: string }>}
 */
export const STAGE_ORDER = Object.freeze([
    { id: 'learn', label: 'the notes of the past runs' },
    { id: 'plan', label: 'the strategy' },
    { id: 'process', label: 'the pictures' },
    { id: 'check', label: 'the check of the result' },
    { id: 'note', label: 'the note of the run' },
]);

/**
 * The report of a run.
 *
 * The report is what the `--json` answer carries and what the note of the run remembers.
 * @param {{ state: object }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function pipelineReport({ state }) {
    const made = (state.files ?? []).length > 0;
    return {
        type: 'result',
        status: state.error || !made ? 'failed' : 'ok',
        task: state.task ?? '',
        strategy: state.strategy ?? null,
        strategySource: state.strategySource ?? 'default',
        assets: state.assets ?? [],
        files: (state.files ?? []).map((file) => String(file).split(path.sep).join('/')),
        issues: state.issues ?? [],
        notes: state.notes ?? [],
        note: state.noteFile ?? null,
        summary: state.summary ?? '',
    };
}

/**
 * Run the pipeline over a task.
 *
 * The strategy comes from the planner, but the notes of the past runs have the first word: a
 * combination that worked before is tried before a new one. The planner decides the rest.
 * @param {{ client?: object|null, config?: object|null, task: string, references?: string[],
 *   sources?: string[], cwd?: string, outputDir?: string|null, home?: string|null,
 *   model?: string|null, signal?: AbortSignal|null, withModel?: boolean, maxAttempts?: number,
 *   onStage?: (stage: object) => void }} options
 * @returns {Promise<object>} the report of the run
 * @exports
 * @ai.hint io
 */
export async function runPipeline({
    client = null,
    config = null,
    task,
    references = [],
    sources = [],
    cwd = process.cwd(),
    outputDir = null,
    home = null,
    model = null,
    signal = null,
    withModel = false,
    maxAttempts = 2,
    onStage = null,
}) {
    const state = {
        task: task ?? '',
        strategy: null,
        strategySource: 'default',
        assets: [],
        files: [],
        issues: [],
        notes: [],
        noteFile: null,
        summary: '',
        error: null,
    };
    /** The stage that is running, for the report of the live output. */
    const stage = (id) => {
        const found = STAGE_ORDER.find((item) => item.id === id);
        onStage?.({ id, label: found?.label ?? id });
    };

    // 1. The notes of the past runs.
    stage('learn');
    const homeDir = home ?? config?.home ?? null;
    let learned = null;
    if (homeDir) {
        const entries = await readNotes({ home: homeDir });
        const summary = summarizeNotes(entries);
        learned = suggestStrategy(summary);
        if (entries.length) {
            state.notes.push(`${entries.length} note(s) of the past runs were read.`);
        }
    }

    // 2. The strategy.
    stage('plan');
    const planned = await planStrategy({
        client,
        config,
        task: state.task,
        references,
        model,
        signal,
    });
    state.strategy = planned.strategy;
    state.strategySource = planned.source;
    if (planned.errors.length) {
        state.notes.push(`the planner: ${planned.errors.join('; ')}`);
    }
    // What the past runs know is a hint, not a decision: it is used only when the planner
    // had nothing to say.
    if (learned?.purpose && planned.source === 'default') {
        state.strategy = { ...state.strategy, purpose: learned.purpose };
        state.strategySource = 'learned';
        state.notes.push(`the notes of the past runs suggested the purpose "${learned.purpose}".`);
    }

    // 3. The pictures.
    stage('process');
    const processed = await processAssets({
        client,
        config,
        task: state.task,
        plan: state.strategy,
        sources,
        cwd,
        outputDir,
        signal,
        withModel,
        maxAttempts,
    });
    state.assets = processed.assets;
    state.files = processed.files;
    state.notes.push(...processed.notes);
    state.summary = processed.summary;

    // 4. The check of the result.
    stage('check');
    const first = processed.files[0] ?? null;
    if (first) {
        const check = await checkResult({
            file: first,
            plan: state.strategy,
            source: null,
            cwd,
            config,
        });
        state.issues = check.issues;
        if (check.issues.length) {
            state.summary = `The picture was made, but ${check.issues.length} issue(s) remain.`;
        }
    } else {
        state.issues = [{ kind: 'format', detail: 'no picture was made.' }];
        state.summary = 'The picture was not made.';
    }

    // 5. The note of the run.
    stage('note');
    if (homeDir) {
        const written = await writeNote({
            home: homeDir,
            entry: {
                date: new Date().toISOString(),
                task: state.task,
                purpose: state.strategy?.purpose ?? null,
                size: state.strategy?.size ?? null,
                model: processed.strategy?.model ?? config?.imageModel ?? null,
                alphaMode: state.strategy?.alphaMode ?? null,
                outcome: state.issues.length ? 'issues' : 'ok',
                notes: state.notes.slice(0, 10),
            },
        });
        state.noteFile = written;
    }

    return pipelineReport({ state });
}

/**
 * The tools of the run, ready to be called.
 * @param {{ client: object, config?: object|null, cwd?: string, signal?: AbortSignal|null }} options
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function pipelineTools({ client, config = null, cwd = process.cwd(), signal = null }) {
    return createImageTools({ client, config, cwd, signal });
}
