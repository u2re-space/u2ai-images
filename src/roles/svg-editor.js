/**
 * @file src/roles/svg-editor.js
 * @module roles/svg-editor
 * @purpose The editor of a vector document: a text model changes the document by naming the
 *          edits, and the code applies them.
 *
 *   The vectorizer draws a document with a picture model. The picture model knows nothing
 *   about the code of a document: it does not group the paths, it does not give them names,
 *   it does not add a title, and it leaves a decimal behind every number.
 *
 *   The editor is a **text** model, and it does not redraw the picture: it reads the document
 *   as code and names the changes. The changes are *edits* — a fragment of the source and its
 *   replacement — and the code applies them. A model that misremembers the source gets an
 *   edit that does not apply, and the edit is reported instead of corrupting the picture.
 *
 *   The picture stays the picture: the editor may not change the shapes of the drawing. It
 *   may name them, group them, give the document a frame and a title, make it accessible,
 *   recolor it and make it smaller — but the outline is the outline.
 *
 * @depends node:path, node:fs/promises, agent/ask, agent/schemas, agent/effort,
 *          image/svg-document, image/svg
 * @usedBy stages/svg-edit, roles/processor
 * @exports SVG_EDITOR_INSTRUCTIONS, SVG_EDITOR_SCHEMA, editSvgDocument, tidySvgAsset
 * @ai.tags roles, svg, vector, text
 * @ai.hint io
 */

import path from 'node:path';
import { readFile, rename, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { askRole } from '../agent/ask.js';
import { effortFor } from '../agent/effort.js';
import { SVG_EDITOR_SCHEMA } from '../agent/schemas.js';
import { applySvgEdits, parseSvgDocument, svgDocumentSummary, tidySvgDocument } from '../image/svg-document.js';
import { svgToPng } from '../image/svg.js';

/**
 * The instructions of the editor of a vector document.
 *
 * The editor is a code reader, not a drawer. The rules of the house of the document are in
 * here: the frame, the accessibility, the names, the palette, the size — and the one rule
 * that matters most, the drawing itself.
 */
export const SVG_EDITOR_INSTRUCTIONS = `You are the editor of a vector SVG document. You read the document as code and you name the edits that bring it to a clean, usable state.

The document is already the picture. You do not redraw it: you do not change the shape of a path, you do not move a point, you do not add or remove a shape. Your edits are about the code around the drawing:

- the frame: a viewBox that matches the drawing, a width and a height that follow it, no width="100%" that makes the picture jump;
- the accessibility: a title for a meaningful picture, role="img" on the root, aria-hidden when the picture is purely decorative, and a title element that says what the picture is;
- the names: ids on the groups and on the paths that carry meaning, so the picture can be restyled and animated from the outside; classes when the same part appears twice;
- the structure: groups that hold the parts of one thing, a defs for the gradients and the masks, a use for a shape that appears twice;
- the palette: the colours as they are, named by a variable or a class when the recoloring matters, currentColor where the colour is the caller's business;
- the size: the decimals nobody needs, the empty groups, the comments that say nothing, the duplicated whitespace.

Answer with the edits only. Every edit names a fragment of the source — the exact text as it is in the document — and what has to happen to it:

{ "edits": [ { "kind": "replace" | "insert" | "remove" | "setAttribute", "find": "the exact fragment", "replace": "the new text", "tag": "<only for setAttribute>", "attribute": "<only for setAttribute>", "value": "<only for setAttribute>" } ] }

The fragment is matched literally, so copy it from the document. An edit whose fragment is not there is refused and changes nothing: read the document again and name the fragment exactly.

Answer with an empty list when the document is already clean. Never claim an edit you did not name.`;

/**
 * The edits the editor may ask for.
 *
 * The list is the vocabulary of the edit: a model that names another kind is told, and the
 * edit is refused.
 */
const EDIT_KINDS = Object.freeze(['replace', 'insert', 'remove', 'setAttribute']);

/**
 * Ask a text model for the edits of a document.
 *
 * The document goes to the model as text — it is code, and the model that edits code reads
 * code. The picture of the source may go with it, so the model knows what the document
 * draws.
 *
 * @param {{ client: object, config?: object|null, document: string, task?: string,
 *   reference?: { mime: string, dataUrl: string }|null, model?: string|null,
 *   signal?: AbortSignal|null }} options
 * @returns {Promise<{ edits: object[], notes: string[], model: string|null, errors: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function askSvgEdits({
    client, config = null, document, task = '', reference = null, model = null, signal = null,
}) {
    const source = String(document ?? '');
    const summary = svgDocumentSummary(source);
    const usedModel = model ?? config?.roles?.svgEditor?.model ?? config?.model ?? null;
    const instruction = [
        `The document: ${summary.frame}, ${summary.paths} path(s), ${summary.colors.length} colour(s).`,
        summary.problems.length ? `The problems of the document: ${summary.problems.join(', ')}.` : '',
        task ? `What has to change: ${task}` : 'Bring the document to a clean, usable state.',
        'The document itself:',
        '```svg',
        source,
        '```',
    ].filter(Boolean).join('\n');

    const input = reference
        ? [
            { type: 'input_text', text: instruction },
            { type: 'input_image', image_url: reference.dataUrl },
        ]
        : instruction;

    const answer = await askRole({
        client,
        model: usedModel,
        instructions: SVG_EDITOR_INSTRUCTIONS,
        input,
        schema: SVG_EDITOR_SCHEMA,
        name: 'edits',
        signal,
        effort: effortFor({ config, role: 'svgEditor' }),
    });
    if (!answer.data) {
        return { edits: [], notes: answer.errors, model: usedModel, errors: answer.errors };
    }
    const edits = Array.isArray(answer.data.edits)
        ? answer.data.edits
            .filter((edit) => edit && typeof edit === 'object')
            .map((edit) => ({
                kind: EDIT_KINDS.includes(edit.kind) ? edit.kind : 'replace',
                find: typeof edit.find === 'string' ? edit.find : '',
                replace: typeof edit.replace === 'string' ? edit.replace : '',
                tag: typeof edit.tag === 'string' ? edit.tag : '',
                attribute: typeof edit.attribute === 'string' ? edit.attribute : '',
                value: typeof edit.value === 'string' ? edit.value : '',
            }))
        : [];
    return {
        edits,
        notes: Array.isArray(answer.data.notes) ? answer.data.notes : [],
        model: usedModel,
        errors: answer.valid ? [] : answer.errors,
    };
}

/**
 * Edit a document with a text model and write the result.
 *
 * The edits are applied to the text of the document, and the result is checked the way every
 * document of the house is checked: it has to open. A document that does not open is not
 * written — the old one stays.
 *
 * @param {{ client: object, config?: object|null, input: string, output?: string|null,
 *   cwd?: string, task?: string, reference?: { mime: string, dataUrl: string }|null,
 *   model?: string|null, signal?: AbortSignal|null }} options
 * @returns {Promise<{ path: string|null, ok: boolean, reason: string, applied: number,
 *   failed: object[], notes: string[], model: string|null, problems: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function editSvgDocument({
    client, config = null, input, output = null, cwd = process.cwd(), task = '',
    reference = null, model = null, signal = null,
}) {
    const notes = [];
    const inputAbs = path.resolve(cwd, input);
    const source = await readFile(inputAbs, 'utf8');
    const outputAbs = output
        ? path.resolve(cwd, output)
        : path.join(path.dirname(inputAbs), `${path.parse(inputAbs).name}.svg`);

    const before = parseSvgDocument(source);
    if (!before.ok) {
        return {
            path: null,
            ok: false,
            reason: 'the document is not an SVG document that opens',
            applied: 0,
            failed: [],
            notes: [...notes, ...before.notes],
            model: null,
            problems: before.problems,
        };
    }

    const asked = await askSvgEdits({
        client,
        config,
        document: source,
        task,
        reference,
        model,
        signal,
    });
    notes.push(...asked.notes);
    if (asked.errors.length) notes.push(...asked.errors);
    if (!asked.edits.length) {
        return {
            path: path.relative(cwd, outputAbs).split(path.sep).join('/'),
            ok: true,
            reason: 'the document needs no change',
            applied: 0,
            failed: [],
            notes,
            model: asked.model,
            problems: before.problems,
        };
    }

    const applied = applySvgEdits(source, asked.edits);
    notes.push(...applied.notes);
    for (const failure of applied.failed) {
        notes.push(`the edit ${failure.index + 1} (${failure.kind}) did not apply: ${failure.reason}.`);
    }

    // The result has to open: a document that does not open is not written.
    const after = parseSvgDocument(applied.text);
    if (!after.ok) {
        return {
            path: null,
            ok: false,
            reason: 'the edited document does not open',
            applied: applied.applied,
            failed: applied.failed,
            notes: [...notes, ...after.notes],
            model: asked.model,
            problems: after.problems,
        };
    }
    const rendered = await svgToPng(Buffer.from(applied.text, 'utf8')).catch(() => null);
    if (!rendered) {
        return {
            path: null,
            ok: false,
            reason: 'the edited document does not render',
            applied: applied.applied,
            failed: applied.failed,
            notes,
            model: asked.model,
            problems: after.problems,
        };
    }

    await mkdir(path.dirname(outputAbs), { recursive: true });
    await writeFile(outputAbs, applied.text, 'utf8');
    return {
        path: path.relative(cwd, outputAbs).split(path.sep).join('/'),
        ok: true,
        reason: 'the document was edited',
        applied: applied.applied,
        failed: applied.failed,
        notes,
        model: asked.model,
        problems: after.problems,
    };
}

/**
 * Bring a document to a clean state, locally.
 *
 * The tidy needs no model: the whitespace, the empty groups and the comments that say
 * nothing are cleaned by the code. The document is written only when it still opens.
 *
 * @param {{ input: string, output?: string|null, cwd?: string }} options
 * @returns {Promise<{ path: string|null, ok: boolean, reason: string, changed: boolean,
 *   notes: string[], problems: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function tidySvgAsset({ input, output = null, cwd = process.cwd() }) {
    const notes = [];
    const inputAbs = path.resolve(cwd, input);
    const source = await readFile(inputAbs, 'utf8');
    const outputAbs = output
        ? path.resolve(cwd, output)
        : path.join(path.dirname(inputAbs), `${path.parse(inputAbs).name}.svg`);

    const before = parseSvgDocument(source);
    if (!before.ok) {
        return {
            path: null,
            ok: false,
            reason: 'the document is not an SVG document that opens',
            changed: false,
            notes: [...notes, ...before.notes],
            problems: before.problems,
        };
    }

    const tidied = tidySvgDocument(source);
    notes.push(...tidied.notes);
    if (!tidied.changed) {
        return {
            path: path.relative(cwd, outputAbs).split(path.sep).join('/'),
            ok: true,
            reason: 'the document is already clean',
            changed: false,
            notes,
            problems: before.problems,
        };
    }

    const after = parseSvgDocument(tidied.text);
    const rendered = await svgToPng(Buffer.from(tidied.text, 'utf8')).catch(() => null);
    if (!after.ok || !rendered) {
        return {
            path: null,
            ok: false,
            reason: 'the tidied document does not open',
            changed: false,
            notes,
            problems: after.problems,
        };
    }

    await mkdir(path.dirname(outputAbs), { recursive: true });
    const temporary = path.join(path.dirname(outputAbs), `.${path.parse(outputAbs).name}.tidy.svg`);
    await writeFile(temporary, tidied.text, 'utf8');
    await rename(temporary, outputAbs);
    return {
        path: path.relative(cwd, outputAbs).split(path.sep).join('/'),
        ok: true,
        reason: 'the document was tidied',
        changed: true,
        notes,
        problems: after.problems,
    };
}
