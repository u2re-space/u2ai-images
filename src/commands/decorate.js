/**
 * @file src/commands/decorate.js
 * @module commands/decorate
 * @purpose `ai-image decorate`: build the decorative layer of a picture — a CSS rule or an SVG
 *          file — and hand back the exact snippet.
 * @depends roles/decorator, commands/common, openai/client
 * @exports run
 * @ai.tags cli, decorate, css, svg
 * @ai.hint keep
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildDecoration, chooseDecorationKind, decorationPath } from '../roles/decorator.js';
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

    const description = options.positionals.join(' ').trim();
    if (!description) {
        throw usageError('Describe the decoration: `ai-image decorate "a ribbon banner with a gold edge"`.');
    }
    const kind = chooseDecorationKind(description, options.kind);
    const target = options.out
        ? path.resolve(cwd, options.out)
        : path.resolve(cwd, decorationPath(kind, 'decoration'));

    let reference = null;
    if (options.image) {
        const abs = path.resolve(cwd, options.image);
        const bytes = await readFile(abs).catch(() => null);
        if (!bytes) throw new Error(`The reference is not readable: ${options.image}`);
        const limit = config?.limits?.maxImageBytes ?? null;
        if (limit && bytes.length > limit) {
            throw new Error(`The reference is larger than the limit of ${limit} bytes: ${options.image}`);
        }
        const mime = sniffImage(bytes).mime;
        reference = { mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    }

    const plan = {
        command: 'decorate',
        description,
        kind,
        reference: options.image ?? null,
        output: path.relative(cwd, target).split(path.sep).join('/'),
    };
    if (options.dryRun) return reportPlan({ options, renderer }, plan);

    const client = createCommandClient({ config, env, renderer });
    try {
        const built = await buildDecoration({
            client,
            config,
            description,
            kind,
            reference,
            model: options.model ?? null,
        });
        if (!built.content.trim()) throw new Error('The model answered without a decoration.');
        // The file of the decoration keeps the place the project expects: a CSS rule in
        // `styles/decor/`, a picture in `assets/decor/`.
        const outAbs = options.out
            ? target
            : path.resolve(cwd, decorationPath(built.kind, built.name));
        await mkdir(path.dirname(outAbs), { recursive: true });
        await writeFile(outAbs, built.content, 'utf8');
        const rel = path.relative(cwd, outAbs).split(path.sep).join('/');
        return reportResult({ options, renderer }, {
            command: 'decorate',
            kind: built.kind,
            name: built.name,
            model: built.model,
            notes: built.notes,
            snippet: built.snippet,
            files: [rel],
            text: built.snippet ? `${rel}: ${built.snippet}` : rel,
        });
    } finally {
        client.close();
    }
}
