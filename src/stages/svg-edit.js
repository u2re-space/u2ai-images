/**
 * @file src/stages/svg-edit.js
 * @module stages/svg-edit
 * @purpose The stage of the edit of a vector document: a text model reads the document as
 *          code and names the edits that bring it to a clean state.
 *
 *   The stage comes right after the tracing: the document exists, and it is the code of a
 *   picture that nobody wrote. The editor of the stage is a **text** model — the picture
 *   model that drew the document cannot read code, and the text model cannot draw.
 *
 *   The editor does not redraw the picture: it names the edits, and the code applies them.
 *   An edit that does not apply is reported, and the picture that is on the disk stays.
 *
 * @depends roles/svg-editor, image/svg-document
 * @usedBy roles/processor, agent/pipeline
 * @exports runSvgEditStage
 * @ai.tags stages, svg, vector, text
 * @ai.hint io
 */

import { editSvgDocument } from '../roles/svg-editor.js';
import { parseSvgDocument } from '../image/svg-document.js';

/**
 * Edit a vector document with a text model.
 *
 * The stage answers with the document only when the document opens: a file that cannot be
 * rendered is not an asset, and the run has to know that.
 *
 * @param {{ client: object, config?: object|null, input: string, output?: string|null,
 *   cwd?: string, task?: string, reference?: { mime: string, dataUrl: string }|null,
 *   model?: string|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ path: string|null, ok: boolean, reason: string, applied: number,
 *   failed: object[], notes: string[], model: string|null, problems: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function runSvgEditStage({
    client, config = null, input, output = null, cwd = process.cwd(), task = '',
    reference = null, model = null, signal = null,
}) {
    const result = await editSvgDocument({
        client,
        config,
        input,
        output,
        cwd,
        task,
        reference,
        model,
        signal,
    });
    return {
        path: result.ok ? result.path : null,
        ok: result.ok,
        reason: result.reason,
        applied: result.applied,
        failed: result.failed,
        notes: result.notes,
        model: result.model,
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
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await readFile(path.resolve(cwd, input), 'utf8').catch(() => null);
    if (source === null) {
        return { problems: ['empty'], notes: ['the document cannot be read.'], ok: false };
    }
    const parsed = parseSvgDocument(source);
    return { problems: parsed.problems, notes: parsed.notes, ok: parsed.ok };
}
