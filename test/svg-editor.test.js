/**
 * @file test/svg-editor.test.js
 * @module test/svg-editor
 * @purpose Tests of the editor of a vector document: the analysis, the edits and the stages.
 * @depends node:test, node:fs/promises, image/svg-document, roles/svg-editor, stages/svg-edit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    SVG_EDIT_KINDS,
    SVG_PROBLEMS,
    applySvgEdits,
    findSvgProblems,
    parseSvgDocument,
    svgDocumentSummary,
    tidySvgDocument,
} from '../src/image/svg-document.js';
import { editSvgDocument, tidySvgAsset } from '../src/roles/svg-editor.js';
import { runSvgEditStage } from '../src/stages/svg-edit.js';
import { runSvgPolishStage } from '../src/stages/svg-polish.js';
import { run as runSvg } from '../src/commands/svg.js';
import { cloneDefaults } from '../src/config/defaults.js';

/**
 * A renderer that keeps what it was told.
 * @returns {{ renderer: object, lines: string[], json: object[] }}
 */
function fakeRenderer() {
    const lines = [];
    const json = [];
    return {
        lines,
        json,
        renderer: {
            line(kind, text) { lines.push(`${kind}: ${text}`); },
            json(payload) { json.push(payload); },
            event() {},
        },
    };
}

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img">'
    + '<title>A mark</title><path id="a" d="M2 2 L20 20"/></svg>';

const MESSY = '<svg xmlns="http://www.w3.org/2000/svg">\n'
    + '  <!-- a note -->\n'
    + '  <g>\n'
    + '  </g>\n'
    + '  <path d="M1.00000 1.00000 L2.5 2.5"/>\n'
    + '</svg>';

async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-svg-editor-'));
}

/**
 * A client that answers the edit request with the given edits.
 * @param {object[]} edits the edits of the model
 * @param {object[]} [seen] the requests the client saw
 * @returns {object}
 */
function editorClient(edits, seen = []) {
    return {
        responses: {
            async create(body) {
                seen.push(body);
                return {
                    status: 'completed',
                    output_text: JSON.stringify({ edits, notes: [] }),
                };
            },
            text(answer) {
                return answer?.output_text ?? '';
            },
        },
    };
}

test('the analysis of a document names what is wrong with it', () => {
    const parsed = parseSvgDocument(GOOD);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.viewBox, '0 0 24 24');
    assert.equal(parsed.paths, 1);
    assert.deepEqual(parsed.problems, []);

    const messy = parseSvgDocument(MESSY);
    assert.equal(messy.ok, true);
    // The frame is missing, the picture has no title and no role.
    assert.ok(messy.problems.includes('no-size'));
    assert.ok(messy.problems.includes('no-title'));
    assert.ok(messy.problems.includes('no-role'));

    // Every problem has a word.
    for (const problem of messy.problems) {
        assert.ok(SVG_PROBLEMS.includes(problem), `unknown problem: ${problem}`);
    }
});

test('the analysis names the dangerous parts of a document', () => {
    const dangerous = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">'
        + '<script>alert(1)</script>'
        + '<image href="https://example.com/a.png"/>'
        + '<text font-family="Arial">hi</text>'
        + '</svg>';
    const problems = findSvgProblems(dangerous);
    assert.ok(problems.includes('script'));
    assert.ok(problems.includes('external-reference'));
    assert.ok(problems.includes('embedded-raster'));
    assert.ok(problems.includes('font'));

    const broken = '<svg><g></svg>';
    assert.ok(findSvgProblems(broken).includes('unbalanced'));
    assert.ok(findSvgProblems('').includes('empty'));
});

test('the summary of a document is short enough for a prompt', () => {
    const summary = svgDocumentSummary(GOOD);
    assert.equal(summary.frame, 'viewBox 0 0 24 24');
    assert.equal(summary.paths, 1);
    assert.ok(summary.bytes > 0);
});

test('an edit is applied only when its fragment is there', () => {
    const result = applySvgEdits(GOOD, [
        { kind: 'replace', find: 'width="24"', replace: 'width="48"' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.applied, 1);
    assert.match(result.text, /width="48"/);

    // A fragment that is not there changes nothing and is reported.
    const missed = applySvgEdits(GOOD, [
        { kind: 'replace', find: 'fill="red"', replace: 'fill="blue"' },
    ]);
    assert.equal(missed.ok, false);
    assert.equal(missed.applied, 0);
    assert.equal(missed.failed.length, 1);
    assert.match(missed.failed[0].reason, /not found/);
    assert.equal(missed.text, GOOD);
});

test('every kind of an edit does what it says', () => {
    const replace = applySvgEdits(GOOD, [{ kind: 'replace', find: '<title>A mark</title>', replace: '<title>Another</title>' }]);
    assert.match(replace.text, /Another/);

    // `insert` puts the text after the fragment it names.
    const insert = applySvgEdits(GOOD, [{ kind: 'insert', find: '<title>', replace: '<!-- a note -->' }]);
    assert.match(insert.text, /<title><!-- a note -->A mark<\/title>/);

    const remove = applySvgEdits(GOOD, [{ kind: 'remove', find: '<title>A mark</title>' }]);
    assert.doesNotMatch(remove.text, /A mark/);

    const attribute = applySvgEdits(GOOD, [{ kind: 'setAttribute', tag: 'path', attribute: 'stroke', value: '#f00' }]);
    assert.match(attribute.text, /stroke="#f00"/);
});

test('an unknown kind of an edit is refused', () => {
    const result = applySvgEdits(GOOD, [{ kind: 'destroy', find: 'x', replace: 'y' }]);
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.match(result.failed[0].reason, /unknown kind/);
    for (const kind of SVG_EDIT_KINDS) {
        assert.ok(typeof kind === 'string');
    }
});

test('the tidy cleans the document and leaves the drawing alone', () => {
    const tidied = tidySvgDocument(MESSY);
    assert.equal(tidied.changed, true);
    assert.doesNotMatch(tidied.text, /<!-- a note -->/);
    assert.doesNotMatch(tidied.text, /<g>\s*<\/g>/);
    // The path is the same path.
    assert.match(tidied.text, /d="M1\.00000 1\.00000 L2\.5 2\.5"/);

    // A clean document is not touched.
    const clean = tidySvgDocument(GOOD);
    assert.equal(clean.changed, false);
    assert.equal(clean.text, GOOD);
});

test('the editor applies the edits of the model and writes the document', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.svg');
    await writeFile(input, MESSY, 'utf8');
    const seen = [];

    const result = await editSvgDocument({
        client: editorClient([
            { kind: 'replace', find: '<svg xmlns="http://www.w3.org/2000/svg">', replace: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img">' },
            { kind: 'insert', find: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img">', replace: '<title>A mark</title>' },
        ], seen),
        input,
        cwd,
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, 2);
    assert.equal(result.path, 'logo.svg');
    const written = await readFile(input, 'utf8');
    assert.match(written, /viewBox="0 0 24 24"/);
    assert.match(written, /<title>A mark<\/title>/);
    // The model was asked with the document as text.
    assert.match(String(seen[0].instructions), /svg-editor|SVG document/);
});

test('an edit that does not apply leaves the document on the disk', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.svg');
    await writeFile(input, GOOD, 'utf8');

    const result = await editSvgDocument({
        client: editorClient([{ kind: 'replace', find: 'nothing like this', replace: 'x' }]),
        input,
        cwd,
    });

    // The edit was refused: the document did not change.
    assert.equal(await readFile(input, 'utf8'), GOOD);
    assert.equal(result.failed.length, 1);
});

test('a model that needs no change leaves the document alone', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.svg');
    await writeFile(input, GOOD, 'utf8');

    const result = await editSvgDocument({
        client: editorClient([]),
        input,
        cwd,
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, 0);
    assert.equal(result.reason, 'the document needs no change');
    assert.equal(await readFile(input, 'utf8'), GOOD);
});

test('the stage of the edit and the stage of the polish work together', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.svg');
    await writeFile(input, MESSY, 'utf8');

    const edited = await runSvgEditStage({
        client: editorClient([
            {
                kind: 'replace',
                find: '<svg xmlns="http://www.w3.org/2000/svg">',
                replace: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img">',
            },
        ]),
        input,
        cwd,
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.applied, 1);

    const polished = await runSvgPolishStage({ input: edited.path, cwd });
    assert.equal(polished.ok, true);
    assert.equal(polished.changed, true);
    // The frame is there now, and the problems are gone.
    assert.doesNotMatch(polished.problems.join(','), /no-size/);
});

test('the polish of a document that does not open is refused', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'broken.svg');
    await writeFile(input, '<svg><g></svg>', 'utf8');

    const result = await tidySvgAsset({ input, cwd });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(await readFile(input, 'utf8'), '<svg><g></svg>');
});

test('the command inspects a document and names its problems', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'logo.svg'), MESSY, 'utf8');
    const { renderer, json } = fakeRenderer();

    const code = await runSvg({
        options: { positionals: ['inspect', 'logo.svg'], json: true, out: null, image: null, model: null, dryRun: false },
        renderer,
        config: cloneDefaults(),
        cwd,
    });
    // The document has problems: the command says so with the exit code.
    assert.equal(code, 1);
    assert.equal(json.length, 1);
    assert.equal(json[0].mode, 'inspect');
    assert.ok(json[0].problems.includes('no-title'));
});

test('the command polishes a document', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'logo.svg'), MESSY, 'utf8');
    const { renderer, json } = fakeRenderer();

    const code = await runSvg({
        options: { positionals: ['polish', 'logo.svg'], json: true, out: null, image: null, model: null, dryRun: false },
        renderer,
        config: cloneDefaults(),
        cwd,
    });
    assert.equal(code, 0);
    assert.equal(json[0].mode, 'polish');
    const written = await readFile(path.join(cwd, 'logo.svg'), 'utf8');
    assert.doesNotMatch(written, /<!-- a note -->/);
    assert.match(written, /d="M1\.00000 1\.00000 L2\.5 2\.5"/);
});

test('the command asks for the document', async () => {
    const cwd = await tempDir();
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runSvg({
            options: { positionals: [], json: false, out: null, image: null, model: null, dryRun: false },
            renderer,
            config: cloneDefaults(),
            cwd,
        }),
        /Give the document/,
    );
});
