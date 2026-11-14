/**
 * @file src/agent/tools.js
 * @module agent/tools
 * @purpose The tools of the agent: the pictures are made, cut, padded, fitted, cleaned and looked
 *          at through one interface.
 * @depends node:path, node:fs/promises, image/tools, image/alpha, image/vectorize, openai/client
 * @usedBy agent/pipeline, roles/processor
 * @exports TOOL_NAMES, createImageTools
 * @ai.tags agent, tools, images
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The names of the monolith are kept: the agent of the monolith calls `generate_image`,
 * `edit_image`, `crop_image`, `split_image` and `compare_images`, and the same names work here.
 * Every tool answers with a plain object: what it did, what it wrote, and what it could not do.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
    comparePictures,
    cropPicture,
    fitPicture,
    padPicture,
    pictureInfo,
    resizePicture,
    splitPicture,
    trimPicture,
} from '../image/tools.js';
import { applyGeneratedAlphaMask } from '../image/alpha.js';
import { vectorizePicture } from '../image/vectorize.js';
import { sniffImage } from '../openai/images.js';

/** The names of the tools. */
export const TOOL_NAMES = Object.freeze([
    'generate_image',
    'edit_image',
    'crop_image',
    'pad_image',
    'fit_image',
    'alpha_image',
    'vectorize_image',
    'compare_images',
    'view_image',
]);

/**
 * The tools of the agent.
 * @param {{ client: object, config?: object|null, cwd?: string, signal?: AbortSignal|null }} options
 * @returns {object} the tools, by name
 * @exports
 * @ai.hint io
 */
export function createImageTools({ client, config = null, cwd = process.cwd(), signal = null }) {
    const engine = config?.image?.rasterEngine ?? 'auto';
    const maxBytes = config?.limits?.maxImageBytes ?? null;

    /**
     * The path of a file of the working directory.
     * @param {string} file
     * @returns {string}
     * @ai.hint pure
     */
    const abs = (file) => (path.isAbsolute(String(file ?? '')) ? String(file) : path.resolve(cwd, String(file ?? '')));

    /**
     * The path of the result, relative to the working directory.
     * @param {string} file
     * @returns {string}
     * @ai.hint pure
     */
    const rel = (file) => path.relative(cwd, abs(file)).split(path.sep).join('/');

    return {
        /**
         * Make a picture from a prompt.
         * @param {{ prompt: string, output?: string, model?: string|null, size?: string|null,
         *   format?: string|null, background?: string|null, count?: number|null }} args
         * @returns {Promise<object>}
         */
        async generate_image(args = {}) {
            const answer = await client.images.generate({
                model: args.model ?? config?.imageModel ?? null,
                prompt: args.prompt ?? '',
                size: args.size ?? config?.image?.size ?? null,
                format: args.format ?? config?.image?.format ?? 'png',
                background: args.background ?? config?.image?.background ?? 'auto',
                n: args.count ?? 1,
                signal,
            });
            const files = [];
            for (const payload of answer.payloads ?? []) {
                const bytes = Buffer.from(payload, 'base64');
                const kind = sniffImage(bytes);
                const target = args.output
                    ? abs(args.output)
                    : path.resolve(cwd, config?.image?.outputDir ?? '.', `ai-image-${files.length + 1}.${kind.ext}`);
                const { writeFile, mkdir } = await import('node:fs/promises');
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, bytes);
                files.push(rel(target));
            }
            return { files, model: answer.model ?? null, route: answer.route ?? null };
        },

        /**
         * Change a picture with a prompt.
         * @param {{ input: string, prompt: string, output?: string, model?: string|null,
         *   size?: string|null, format?: string|null }} args
         * @returns {Promise<object>}
         */
        async edit_image(args = {}) {
            const source = abs(args.input);
            const bytes = await readFile(source);
            const kind = sniffImage(bytes);
            const answer = await client.images.edit({
                model: args.model ?? config?.imageModel ?? null,
                prompt: args.prompt ?? '',
                files: [{ filename: path.basename(source), mime: kind.mime, bytes }],
                size: args.size ?? null,
                format: args.format ?? config?.image?.format ?? 'png',
                signal,
            });
            const files = [];
            for (const payload of answer.payloads ?? []) {
                const out = Buffer.from(payload, 'base64');
                const outKind = sniffImage(out);
                const target = args.output ? abs(args.output) : path.resolve(cwd, `ai-image-edit.${outKind.ext}`);
                const { writeFile, mkdir } = await import('node:fs/promises');
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, out);
                files.push(rel(target));
            }
            return { files, model: answer.model ?? null, route: answer.route ?? null };
        },

        /**
         * Cut a box out of a picture, or cut its padding off.
         * @param {{ input: string, output?: string, x?: number, y?: number, width?: number,
         *   height?: number, trim?: boolean }} args
         * @returns {Promise<object>}
         */
        async crop_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await cropPicture({
                input: abs(args.input),
                output,
                x: args.x ?? 0,
                y: args.y ?? 0,
                width: args.width ?? null,
                height: args.height ?? null,
                trim: args.trim === true,
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { file: rel(output), width: result.width, height: result.height, changed: result.changed };
        },

        /**
         * Extend the canvas of a picture, without touching the picture.
         * @param {{ input: string, output?: string, width?: number, height?: number, color?: string }} args
         * @returns {Promise<object>}
         */
        async pad_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await padPicture({
                input: abs(args.input),
                output,
                width: args.width ?? null,
                height: args.height ?? null,
                color: args.color ?? 'transparent',
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { file: rel(output), width: result.width, height: result.height };
        },

        /**
         * Put a picture into a frame.
         * @param {{ input: string, output?: string, width: number, height: number, fit?: string }} args
         * @returns {Promise<object>}
         */
        async fit_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await fitPicture({
                input: abs(args.input),
                output,
                width: args.width,
                height: args.height,
                fit: args.fit ?? 'cover',
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { file: rel(output), width: result.width, height: result.height, fit: result.fit };
        },

        /**
         * Build a real alpha channel for a picture.
         * @param {{ input: string, output?: string, mode?: string }} args
         * @returns {Promise<object>}
         */
        async alpha_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await applyGeneratedAlphaMask({
                client,
                config,
                file: output,
                signal,
                alphaMode: args.mode ?? config?.image?.alphaMode ?? 'auto',
            });
            return { file: rel(output), changed: result.changed, reason: result.reason };
        },

        /**
         * Trace a raster into an SVG document.
         * @param {{ input: string, output?: string, prompt?: string, model?: string|null }} args
         * @returns {Promise<object>}
         */
        async vectorize_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(`${args.input}.svg`);
            const result = await vectorizePicture({
                client,
                config,
                input: abs(args.input),
                output,
                prompt: args.prompt ?? '',
                model: args.model ?? config?.vectorModel ?? null,
                cwd,
                signal,
                maxBytes,
            });
            return { file: result.rel, model: result.model, colors: result.colors, suitable: result.suitable };
        },

        /**
         * Compare pictures: a sheet and a map of the difference.
         * @param {{ files: string[], output?: string, layout?: string, mode?: string, labels?: boolean }} args
         * @returns {Promise<object>}
         */
        async compare_images(args = {}) {
            const output = args.output ? abs(args.output) : path.resolve(cwd, 'comparison.png');
            const result = await comparePictures({
                files: (args.files ?? []).map((file) => abs(file)),
                output,
                cwd,
                layout: args.layout ?? 'row',
                frame: args.frame ?? '',
                gap: args.gap ?? 8,
                background: args.background ?? 'transparent',
                maxSide: args.maxSide ?? 768,
                labels: args.labels === true,
                mode: args.mode ?? 'sheet',
                engine,
                maxBytes,
                signal,
            });
            return {
                file: result.rel ? rel(result.rel) : null,
                diff: result.diff ? rel(result.diff.rel) : null,
                items: result.items,
                similarity: result.diff?.similarity ?? null,
            };
        },

        /**
         * Look at a picture and describe it.
         * @param {{ input: string, prompt?: string }} args
         * @returns {Promise<object>}
         */
        async view_image(args = {}) {
            const source = abs(args.input);
            const bytes = await readFile(source);
            const kind = sniffImage(bytes);
            const answer = await client.responses.create({
                model: config?.model ?? null,
                input: [
                    {
                        type: 'input_text',
                        text: args.prompt
                            ?? 'Describe this picture: what is in it, how it is composed, and what is wrong with it, if anything.',
                    },
                    { type: 'input_image', image_url: `data:${kind.mime};base64,${bytes.toString('base64')}` },
                ],
                signal,
                // The description is a text request of the run: it may go out as a part of a batch.
                batchable: true,
            });
            return { file: rel(source), description: client.responses.text(answer) };
        },

        /**
         * Tell what a picture is.
         * @param {{ input: string }} args
         * @returns {Promise<object>}
         */
        async info_image(args = {}) {
            const info = await pictureInfo({ input: abs(args.input), cwd, engine });
            return { file: rel(args.input), ...info };
        },

        /**
         * Change the size of a picture.
         * @param {{ input: string, output?: string, width?: number, height?: number,
         *   maxSide?: number, factor?: number }} args
         * @returns {Promise<object>}
         */
        async resize_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await resizePicture({
                input: abs(args.input),
                output,
                width: args.width ?? null,
                height: args.height ?? null,
                maxSide: args.maxSide ?? null,
                factor: args.factor ?? null,
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { file: rel(output), width: result.width, height: result.height };
        },

        /**
         * Cut the uniform or transparent edges off.
         * @param {{ input: string, output?: string, fuzz?: number, transparentOnly?: boolean }} args
         * @returns {Promise<object>}
         */
        async trim_image(args = {}) {
            const output = args.output ? abs(args.output) : abs(args.input);
            const result = await trimPicture({
                input: abs(args.input),
                output,
                fuzz: args.fuzz ?? 6,
                transparentOnly: args.transparentOnly === true,
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { file: rel(output), changed: result.changed, reason: result.reason };
        },

        /**
         * Cut a picture into a grid of tiles.
         * @param {{ input: string, outputDir?: string, rows?: number, cols?: number }} args
         * @returns {Promise<object>}
         */
        async split_image(args = {}) {
            const outputDir = args.outputDir ? abs(args.outputDir) : path.resolve(cwd, 'tiles');
            const result = await splitPicture({
                input: abs(args.input),
                outputDir,
                rows: args.rows ?? 1,
                cols: args.cols ?? 1,
                cwd,
                engine,
                maxBytes,
                signal,
            });
            return { source: result.source, tiles: result.tiles.map((tile) => rel(tile.rel)) };
        },
    };
}
