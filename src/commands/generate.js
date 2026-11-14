/**
 * @file src/commands/generate.js
 * @module commands/generate
 * @purpose `ai-image generate`: make pictures from a prompt.
 * @depends core/prompt, core/sink, commands/common, model/purpose, image/alpha, openai/client
 * @exports run
 * @ai.tags cli, generate
 * @ai.hint keep
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readPrompt } from '../core/prompt.js';
import { createImageSink } from '../core/sink.js';
import { canonicalPurpose, PURPOSE_NAMES, resolvePurposeModel } from '../model/purpose.js';
import { applyGeneratedAlphaMask, alphaFormatWarning } from '../image/alpha.js';
import { sniffImage } from '../openai/images.js';
import {
    createCommandClient,
    outputTarget,
    pictureFormat,
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

    const prompt = await readPrompt({ positionals: options.positionals, config, stream: ctx.stdin ?? null });
    if (!prompt) {
        throw usageError('Give a prompt: `ai-image generate "a red bicycle on the snow", or pipe it into stdin.');
    }

    const asked = options.purpose ?? config?.image?.purpose ?? null;
    const purpose = canonicalPurpose(asked);
    if (asked && !PURPOSE_NAMES.includes(purpose)) {
        throw usageError(`Unknown purpose "${asked}". Known purposes: ${PURPOSE_NAMES.join(', ')}.`);
    }

    const model = options.imageModel ?? resolvePurposeModel(config, purpose) ?? config?.imageModel ?? null;
    const size = options.size ?? config?.image?.size ?? null;
    const resolution = options.resolution ?? config?.image?.resolution ?? null;
    const format = pictureFormat({ options, config });
    const background = options.background ?? config?.image?.background ?? 'auto';
    const count = options.count ?? 1;
    const target = outputTarget({ options, config, cwd });

    // A reference of the generation: the picture travels with the request as a data URI.
    const references = [];
    if (options.image) {
        const abs = path.resolve(cwd, options.image);
        const bytes = await readFile(abs).catch(() => null);
        if (!bytes) throw new Error(`The reference is not readable: ${options.image}`);
        const limit = config?.limits?.maxImageBytes ?? null;
        if (limit && bytes.length > limit) {
            throw new Error(`The reference is larger than the limit of ${limit} bytes: ${options.image}`);
        }
        const kind = sniffImage(bytes);
        references.push(`data:${kind.mime};base64,${bytes.toString('base64')}`);
    }

    const plan = {
        command: 'generate',
        prompt,
        model,
        purpose,
        size,
        resolution,
        format,
        background,
        count,
        reference: options.image ?? null,
        output: target.target,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    // The line of the plan: what is asked of the model, and where the result lands.
    if (typeof renderer.plan === 'function') {
        renderer.plan({ model, size, resolution, format, purpose, output: target.target });
    }

    const client = await createCommandClient({ config, env, renderer, options, cwd });
    try {
        const answer = await client.images.generate({
            model,
            purpose,
            prompt,
            size,
            resolution,
            n: count,
            format,
            background,
            references: references.length ? references : null,
            signal: null,
        });
        const sink = createImageSink({ target: target.target, format, prefix: 'ai-image' });
        const files = [];
        for (const [index, payload] of answer.payloads.entries()) {
            const bytes = Buffer.from(payload, 'base64');
            const kind = sniffImage(bytes);
            const saved = await sink.saveFinal(`item-${index + 1}`, bytes, kind.ext === 'jpg' ? 'jpeg' : kind.ext);
            if (saved) files.push(saved);
        }
        if (!files.length) throw new Error('The model answered without a picture.');

        // A picture that was asked to be transparent but came back opaque gets its alpha channel
        // built locally: the model could not deliver it, but the file can still carry it.
        const alpha = [];
        if (background === 'transparent') {
            for (const saved of files) {
                const warning = alphaFormatWarning(saved.file);
                if (warning) {
                    renderer.line('warn', warning);
                    continue;
                }
                const built = await applyGeneratedAlphaMask({
                    client,
                    config,
                    file: saved.file,
                    model: answer.model,
                });
                alpha.push({ file: saved.file, changed: built.changed, reason: built.reason });
                if (!built.changed && built.reason !== 'already') {
                    renderer.line('warn', `The alpha of ${path.basename(saved.file)} was not built: ${built.reason}.`);
                }
            }
        }

        return reportResult({ options, renderer }, {
            command: 'generate',
            model: answer.model,
            route: answer.route,
            purpose,
            size,
            format,
            alpha,
            files: files.map((file) => path.relative(cwd, file.file).split(path.sep).join('/')),
        });
    } finally {
        client.close();
    }
}
