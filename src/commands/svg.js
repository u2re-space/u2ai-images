/**
 * @file src/commands/svg.js
 * @module commands/svg
 * @purpose `ai-image svg`: edit a vector document with a text model, or tidy it locally.
 *
 *   The tracing draws a document with a picture model. The document it draws is the code of
 *   a picture that nobody wrote: it may carry a hundred decimals in a path, no title for a
 *   meaningful picture, and a `<script>` nobody asked for.
 *
 *   The command has two halves, and they answer different questions:
 *
 *   - `edit` — a **text** model reads the document as code and names the edits that bring
 *     it to a clean, usable state. The picture is not redrawn: the shapes stay the shapes.
 *   - `polish` — the local check and the local tidy: the frame, the namespace, the balance
 *     of the tags, the scripts, the references to the outside, and the whitespace.
 *
 * @depends roles/svg-editor, image/svg-document, commands/common, openai/client
 * @exports run
 * @ai.tags cli, svg, vector, text
 * @ai.hint keep
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { editSvgDocument, tidySvgAsset } from '../roles/svg-editor.js';
import { svgDocumentSummary } from '../image/svg-document.js';
import { sniffImage } from '../openai/images.js';
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

    // The mode is the first word when it names one; otherwise the first word is the
    // document and the mode is `edit`.
    const known = ['edit', 'polish', 'inspect'];
    const first = String(options.positionals[0] ?? '').trim().toLowerCase();
    const mode = known.includes(first) ? first : 'edit';
    const file = known.includes(first)
        ? String(options.positionals[1] ?? '').trim()
        : String(options.positionals[0] ?? '').trim();
    if (!file) {
        throw usageError(
            'Give the document: `ai-image svg edit logo.svg "add a title"`, '
            + '`ai-image svg polish logo.svg` or `ai-image svg inspect logo.svg`.',
        );
    }
    const task = mode === 'edit'
        ? options.positionals.slice(known.includes(first) ? 2 : 1).join(' ').trim()
        : '';

    const abs = path.resolve(cwd, file);
    const output = options.out ? path.resolve(cwd, options.out) : abs;

    if (mode === 'inspect') {
        const source = await readFile(abs, 'utf8').catch(() => null);
        if (source === null) throw new Error(`The document is not readable: ${file}`);
        const summary = svgDocumentSummary(source);
        if (options.json) {
            renderer.json({
                type: 'result',
                status: summary.problems.length ? 'issues' : 'ok',
                command: 'svg',
                mode,
                file: path.relative(cwd, abs).split(path.sep).join('/'),
                ...summary,
            });
            return summary.problems.length ? 1 : 0;
        }
        renderer.line('info', `${summary.frame}, ${summary.paths} path(s), ${summary.colors.length} colour(s).`);
        if (!summary.problems.length) {
            renderer.line('result', 'the document is clean.');
            return 0;
        }
        for (const problem of summary.problems) renderer.line('warn', problem);
        return 1;
    }

    const plan = {
        command: 'svg',
        mode,
        input: path.relative(cwd, abs).split(path.sep).join('/'),
        output: path.relative(cwd, output).split(path.sep).join('/'),
        task: task || null,
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    if (mode === 'polish') {
        const result = await tidySvgAsset({ input: abs, output, cwd });
        if (!result.ok) {
            renderer.line('warn', `The document was not tidied: ${result.reason}.`);
            return options.json
                ? (renderer.json({
                    type: 'result',
                    status: 'failed',
                    command: 'svg',
                    mode,
                    error: { message: result.reason },
                    problems: result.problems,
                }), 1)
                : 1;
        }
        return reportResult({ options, renderer }, {
            command: 'svg',
            mode,
            files: [result.path],
            text: result.changed ? 'the document was tidied.' : 'the document was already clean.',
            problems: result.problems,
        });
    }

    // The picture of the source may go with the document: the model knows what it edits.
    let reference = null;
    if (options.image) {
        const refAbs = path.resolve(cwd, options.image);
        const bytes = await readFile(refAbs).catch(() => null);
        if (!bytes) throw new Error(`The reference is not readable: ${options.image}`);
        const limit = config?.limits?.maxImageBytes ?? null;
        if (limit && bytes.length > limit) {
            throw new Error(`The reference is larger than the limit of ${limit} bytes: ${options.image}`);
        }
        const mime = sniffImage(bytes).mime;
        reference = { mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    }

    const client = await createCommandClient({ config, env, renderer, options, cwd });
    try {
        const result = await editSvgDocument({
            client,
            config,
            input: abs,
            output,
            cwd,
            task,
            reference,
            model: options.model ?? config?.roles?.svgEditor?.model ?? null,
        });
        if (!result.ok) {
            renderer.line('warn', `The document was not edited: ${result.reason}.`);
            return options.json
                ? (renderer.json({
                    type: 'result',
                    status: 'failed',
                    command: 'svg',
                    mode,
                    model: result.model,
                    error: { message: result.reason },
                    problems: result.problems,
                }), 1)
                : 1;
        }
        for (const note of result.notes) renderer.line('info', note);
        return reportResult({ options, renderer }, {
            command: 'svg',
            mode,
            model: result.model,
            files: [result.path],
            text: `${result.path}: ${result.applied} edit(s)`,
            problems: result.problems,
        });
    } finally {
        client.close();
    }
}
