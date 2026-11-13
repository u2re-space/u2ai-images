/**
 * @file src/commands/edit.js
 * @module commands/edit
 * @purpose `ai-image edit`: change a picture with a prompt.
 * @depends core/prompt, core/sink, commands/common, model/purpose, image/alpha, openai/client
 * @exports run
 * @ai.tags cli, edit
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
 * Read a picture of the working directory, refusing the ones over the limit.
 * @param {{ file: string, cwd: string, maxBytes: number|null }} options
 * @returns {Promise<{ filename: string, mime: string, bytes: Buffer }>}
 * @ai.hint io
 */
async function readSource({ file, cwd, maxBytes }) {
    const abs = path.resolve(cwd, file);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) throw new Error(`The file is not readable: ${file}`);
    if (maxBytes && bytes.length > maxBytes) {
        throw new Error(`The picture is larger than the limit of ${maxBytes} bytes: ${file}`);
    }
    const kind = sniffImage(bytes);
    return { filename: path.basename(abs), mime: kind.mime, bytes };
}

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object, cwd: string, env?: object }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config, cwd } = ctx;
    const env = ctx.env ?? process.env;

    const source = options.positionals[0];
    if (!source) {
        throw usageError('Give the picture: `ai-image edit picture.png "make the sky stormy"`.');
    }
    const prompt = await readPrompt({
        positionals: options.positionals.slice(1),
        config,
        stream: ctx.stdin ?? null,
    });
    if (!prompt) {
        throw usageError('Give the prompt: `ai-image edit picture.png "make the sky stormy"`.');
    }

    const asked = options.purpose ?? config?.image?.purpose ?? null;
    const purpose = canonicalPurpose(asked);
    if (asked && !PURPOSE_NAMES.includes(purpose)) {
        throw usageError(`Unknown purpose "${asked}". Known purposes: ${PURPOSE_NAMES.join(', ')}.`);
    }

    const model = options.imageModel ?? resolvePurposeModel(config, purpose) ?? config?.imageModel ?? null;
    const size = options.size ?? null;
    const format = pictureFormat({ options, config });
    const background = options.background ?? config?.image?.background ?? 'auto';
    const target = outputTarget({ options, config, cwd });

    const limit = config?.limits?.maxImageBytes ?? null;
    const references = [];
    for (const reference of options.references ?? []) {
        references.push(await readSource({ file: reference, cwd, maxBytes: limit }));
    }
    if (references.length > 10) {
        throw usageError('A vendor model takes at most 10 reference pictures.');
    }

    const plan = {
        command: 'edit',
        source,
        prompt,
        model,
        purpose,
        size: size ?? 'the frame of the source',
        format,
        background,
        references: references.map((item) => item.filename),
        output: target.target,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    // The line of the plan: what is asked of the model, and where the result lands.
    if (typeof renderer.plan === 'function') {
        renderer.plan({ model, size, format, purpose, output: target.target });
    }

    const sourceFile = await readSource({ file: source, cwd, maxBytes });
    const client = createCommandClient({ config, env, renderer });
    try {
        const answer = await client.images.edit({
            model,
            purpose,
            prompt,
            files: [sourceFile, ...references],
            size,
            format,
            background,
            signal: null,
        });
        const sink = createImageSink({ target: target.target, format, prefix: 'ai-image-edit' });
        const files = [];
        for (const [index, payload] of answer.payloads.entries()) {
            const bytes = Buffer.from(payload, 'base64');
            const kind = sniffImage(bytes);
            const saved = await sink.saveFinal(`item-${index + 1}`, bytes, kind.ext === 'jpg' ? 'jpeg' : kind.ext);
            if (saved) files.push(saved);
        }
        if (!files.length) throw new Error('The model answered without a picture.');

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
            }
        }

        return reportResult({ options, renderer }, {
            command: 'edit',
            model: answer.model,
            route: answer.route,
            purpose,
            source,
            alpha,
            files: files.map((file) => path.relative(cwd, file.file).split(path.sep).join('/')),
        });
    } finally {
        client.close();
    }
}
