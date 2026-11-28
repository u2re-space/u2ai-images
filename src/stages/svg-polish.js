/**
 * @file src/stages/svg-polish.js
 * @module stages/svg-polish
 * @purpose The stage of the polish of a vector document: the local check and the local tidy.
 *
 *   The stage needs no model. It checks the document the way a browser cares about it —
 *   the frame, the namespace, the balance of the tags, the scripts and the references to
 *   the outside — and it tidies what may be tidied without touching the drawing: the
 *   whitespace, the empty groups, the comments that say nothing.
 *
 *   The polish is the last stage of the vector: the document that leaves it is the one that
 *   goes into the project.
 *
 * @depends roles/svg-editor, image/svg-document
 * @usedBy roles/processor, agent/pipeline
 * @exports runSvgPolishStage
 * @ai.tags stages, svg, vector
 * @ai.hint io
 */

import { tidySvgAsset } from '../roles/svg-editor.js';
import { parseSvgDocument } from '../image/svg-document.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Check and tidy a vector document.
 *
 * @param {{ input: string, output?: string|null, cwd?: string }} options
 * @returns {Promise<{ path: string|null, ok: boolean, reason: string, changed: boolean,
 *   notes: string[], problems: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runSvgPolishStage({ input, output = null, cwd = process.cwd() }) {
    const result = await tidySvgAsset({ input, output, cwd });
    return {
        path: result.ok ? result.path : null,
        ok: result.ok,
        reason: result.reason,
        changed: result.changed,
        notes: result.notes,
        problems: result.problems ?? [],
    };
}

/**
 * The problems of a document, without a model.
 *
 * The stage reports what is wrong with a document even when nobody edited it: a picture
 * that carries a script is a fact the run has to know about.
 *
 * @param {{ input: string, cwd?: string }} options
 * @returns {Promise<{ problems: string[], notes: string[], ok: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function inspectSvgDocument({ input, cwd = process.cwd() }) {
    const source = await readFile(path.resolve(cwd, input), 'utf8').catch(() => null);
    if (source === null) {
        return { problems: ['empty'], notes: ['the document cannot be read.'], ok: false };
    }
    const parsed = parseSvgDocument(source);
    return { problems: parsed.problems, notes: parsed.notes, ok: parsed.ok };
}
