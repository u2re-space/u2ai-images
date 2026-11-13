/**
 * @file test/parser.test.js
 * @module test/parser
 * @purpose The AI parser of an unusual answer: the sketch of the shape, the script the model
 *          writes, the sandbox it runs in and the archive of the raw answer.
 * @depends node:test, node:fs/promises, node:os, node:path, openai/parser, openai/diagnostics
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    describeShape,
    extractScript,
    makeParserInvoke,
    parseImageResponseWithAI,
    runParserScript,
    toSource,
} from '../src/openai/parser.js';
import { setImageDiagnostics, saveImageResponse, saveImageParserScript } from '../src/openai/diagnostics.js';

/** A 1x1 PNG, enough for the readers of the answers. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-parser-'));
}

test('the sketch of the shape names the keys and elides the long strings', () => {
    const long = 'A'.repeat(200);
    const shape = describeShape({ data: [{ b64: long }], count: 2, ok: true });
    assert.match(shape, /"b64": <string 200 chars:/);
    assert.match(shape, /"count": 2/);
    assert.match(shape, /"ok": true/);
});

test('the sketch counts the long arrays', () => {
    const shape = describeShape({ items: [1, 2, 3, 4, 5] });
    assert.match(shape, /5 items total/);
});

test('the script is taken out of the fence', () => {
    assert.equal(extractScript('```js\nreturn [];\n```'), 'return [];');
    assert.equal(extractScript('```\nreturn [];\n```'), 'return [];');
    assert.equal(extractScript('  return [];  '), 'return [];');
});

test('every form of a payload is normalized', () => {
    assert.deepEqual(toSource(TINY_PNG), { kind: 'b64', value: TINY_PNG });
    assert.deepEqual(toSource(`data:image/png;base64,${TINY_PNG}`), { kind: 'b64', value: TINY_PNG });
    assert.deepEqual(toSource('https://example.test/a.png'), { kind: 'url', value: 'https://example.test/a.png' });
    assert.deepEqual(toSource(Buffer.from(TINY_PNG, 'base64')), { kind: 'b64', value: TINY_PNG });
    assert.deepEqual(toSource({ b64_json: TINY_PNG }), { kind: 'b64', value: TINY_PNG });
    assert.equal(toSource('not a picture'), null);
    assert.equal(toSource(null), null);
});

test('the sandbox runs the script and gives it the response', async () => {
    const root = await tempDir();
    const result = await runParserScript(
        'return [response.pictures[0].payload];',
        { response: { pictures: [{ payload: TINY_PNG }] }, root },
    );
    assert.deepEqual(result.sources, [{ kind: 'b64', value: TINY_PNG }]);
});

test('the sandbox refuses to write out of the working directory', async () => {
    const root = await tempDir();
    await assert.rejects(
        runParserScript('await write("../escaped.png", "x"); return [];', { response: {}, root }),
        /escapes the working directory/,
    );
});

test('the sandbox has no require, process or filesystem', async () => {
    const root = await tempDir();
    const result = await runParserScript(
        'log(typeof require, typeof process, typeof setTimeout, typeof fetch); return [];',
        { response: {}, root },
    );
    assert.deepEqual(result.logs, ['undefined undefined undefined function']);
});

test('the raw answer is archived and the script runs', async () => {
    const dir = await tempDir();
    setImageDiagnostics({ dir });
    const archived = [];
    const asked = [];
    const sources = await parseImageResponseWithAI({
        result: { data: { result: { images: [{ url: TINY_PNG }] } } },
        route: 'images/generations',
        model: 'some/model',
        parserModel: 'text/model',
        invoke: async ({ model, prompt }) => {
            asked.push({ model, prompt });
            return '```js\nreturn [response.data.result.images[0].url];\n```';
        },
        onArchive: (file) => archived.push(file),
    });
    assert.deepEqual(sources, [{ kind: 'b64', value: TINY_PNG }]);
    assert.equal(asked[0].model, 'text/model');
    assert.match(asked[0].prompt, /"result": \{"images"/);
    assert.equal(archived.length, 1);
    const files = await readdir(dir);
    assert.ok(files.some((file) => file.endsWith('.json')), 'the raw answer is on disk');
    const saved = JSON.parse(await readFile(path.join(dir, files.find((file) => file.endsWith('.json'))), 'utf8'));
    assert.equal(saved.route, 'images/generations');
    assert.equal(saved.model, 'some/model');
    assert.ok(files.some((file) => /-parser-\d{3}\.js$/.test(file)), 'the script is on disk');
    setImageDiagnostics(null);
});

test('without a parser model nothing is salvaged', async () => {
    const dir = await tempDir();
    setImageDiagnostics({ dir });
    const sources = await parseImageResponseWithAI({
        result: { data: [] },
        parserModel: null,
        invoke: async () => 'return [];',
    });
    assert.equal(sources, null);
    setImageDiagnostics(null);
});

test('the archiver writes the answer and the script', async () => {
    const dir = await tempDir();
    setImageDiagnostics({ dir });
    const file = await saveImageResponse({ hello: 'world' }, { route: 'images/edits', model: 'm' });
    assert.ok(file.endsWith('.json'));
    const script = await saveImageParserScript('return [];', { route: 'images/edits', notes: 'n' });
    assert.ok(script.endsWith('.js'));
    const text = await readFile(script, 'utf8');
    assert.match(text, /salvage script/);
    assert.match(text, /return \[\];/);
    setImageDiagnostics(null);
});

test('the parser invoke asks the Responses API for text', async () => {
    const asked = [];
    const invoke = makeParserInvoke({
        responses: {
            async create(params) {
                asked.push(params);
                return { output_text: 'the script' };
            },
        },
    });
    const answer = await invoke({ model: 'm', prompt: 'p' });
    assert.equal(answer, 'the script');
    assert.equal(asked[0].model, 'm');
    assert.equal(asked[0].store, false);
    assert.match(asked[0].input[0].content[0].text, /p/);
});
