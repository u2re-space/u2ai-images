/**
 * @file src/commands/process.js
 * @module commands/process
 * @purpose `ai-image process`: run the agentic pipeline over a task — plan, make, check, note.
 * @depends core/prompt, agent/pipeline, commands/common, model/purpose
 * @exports run
 * @ai.tags cli, process, agent
 * @ai.hint keep
 */

import path from 'node:path';
import { readPrompt } from '../core/prompt.js';
import { runPipeline } from '../agent/pipeline.js';
import { canonicalPurpose, PURPOSE_NAMES, resolvePurposeModel } from '../model/purpose.js';
import {
    createCommandClient,
    reportPlan,
    reportResult,
    usageError,
} from './common.js';

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string, env?: object }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const env = ctx.env ?? process.env;

    const task = await readPrompt({
        positionals: options.positionals,
        config,
        stream: ctx.stdin ?? null,
    });
    if (!task) {
        throw usageError('Give the task: `ai-image process "a hero picture for the landing page"`.');
    }

    const asked = options.purpose ?? config?.image?.purpose ?? null;
    const purpose = canonicalPurpose(asked);
    if (asked && !PURPOSE_NAMES.includes(purpose)) {
        throw usageError(`Unknown purpose "${asked}". Known purposes: ${PURPOSE_NAMES.join(', ')}.`);
    }

    const references = (options.references ?? []).map((file) => path.resolve(cwd, file));
    const sources = options.image ? [path.resolve(cwd, options.image)] : [];
    const model = options.imageModel ?? resolvePurposeModel(config, purpose) ?? config?.imageModel ?? null;

    const plan = {
        command: 'process',
        task,
        purpose,
        model,
        references: references.map((file) => path.relative(cwd, file).split(path.sep).join('/')),
        source: options.image ?? null,
        output: options.outDir ?? config?.image?.outputDir ?? '.',
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    // The line of the plan: which model serves the run, and where the result lands.
    if (typeof renderer.plan === 'function') {
        renderer.plan({ model, size: options.size ?? null, format: options.format ?? null, purpose, output: plan.output });
    }

    const client = createCommandClient({ config, env, renderer });
    try {
        const report = await runPipeline({
            client,
            config,
            task,
            references: plan.references,
            sources,
            cwd,
            outputDir: options.outDir ?? null,
            home: config?.home ?? null,
            model: options.model ?? null,
            withModel: true,
            maxAttempts: 2,
            onStage: (stage) => renderer.line('info', `· ${stage.label}`),
        });
        if (options.json) {
            renderer.json(report);
            return report.status === 'ok' ? 0 : 1;
        }
        if (report.summary) renderer.line('result', report.summary);
        for (const file of report.files) renderer.line('result', file);
        for (const note of report.notes) renderer.line('info', note);
        for (const issue of report.issues) renderer.line('warn', `${issue.kind}: ${issue.detail}`);
        return report.status === 'ok' ? 0 : 1;
    } finally {
        client.close();
    }
}

/**
 * The report of a run, for the callers that need it.
 * @param {{ options: object, renderer: object, config: object, cwd: string, env?: object }} ctx
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function processReport(ctx) {
    const { options, config, cwd } = ctx;
    const env = ctx.env ?? process.env;
    const task = await readPrompt({
        positionals: options.positionals,
        config,
        stream: ctx.stdin ?? null,
    });
    const client = createCommandClient({ config, env, renderer: ctx.renderer });
    try {
        return await runPipeline({
            client,
            config,
            task,
            references: options.references ?? [],
            cwd,
            home: config?.home ?? null,
        });
    } finally {
        client.close();
    }
}
