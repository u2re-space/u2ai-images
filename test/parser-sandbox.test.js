/**
 * @file test/parser-sandbox.test.js
 * @module test/parser-sandbox
 * @purpose Tests of the sandbox of the salvage script: the isolation, the helpers and the
 *          libraries of the house.
 * @depends node:test, node:assert, openai/parser-sandbox, openai/parser
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

import {
    PARSER_SANDBOX_LIMITS,
    PARSER_SANDBOX_VERSION,
    ParserSandboxError,
    createParserSandboxSpec,
    runParserSandbox,
    runParserSandboxWorker,
} from '../src/openai/parser-sandbox.js';
import { extractScript, runParserScript, toSource } from '../src/openai/parser.js';

async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-parser-'));
}

/** A real PNG, as base64: the reader wants a picture, not a short word. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ANSWER = {
    data: {
        result: {
            images: [{ payload: PNG_B64, other: 'ignored' }],
        },
    },
};

test('the spec of the sandbox carries the script and the answer', () => {
    const spec = createParserSandboxSpec({
        script: 'return [];',
        response: ANSWER,
        root: '/tmp/x',
        timeoutMs: 1000,
    });
    assert.equal(spec.version, PARSER_SANDBOX_VERSION);
    assert.equal(spec.script, 'return [];');
    assert.equal(spec.timeoutMs, 1000);
    // The answer crosses as JSON: the realm never sees an object of the host.
    assert.equal(typeof spec.response, 'string');
    assert.deepEqual(JSON.parse(spec.response), ANSWER);
    assert.ok(PARSER_SANDBOX_LIMITS.timeoutMs > 0);
});

test('the script of the model may not walk out of the sandbox', async () => {
    const report = await runParserSandboxWorker({
        spec: {
            script: `
                const probe = (fn) => {
                    try { return String(fn()); } catch (error) { return 'BLOCKED:' + error.constructor.name; }
                };
                return {
                    viaResponse: probe(() => JSON.parse(response).constructor.constructor('return typeof process')()),
                    viaDecode: probe(() => decodeBase64.constructor('return typeof process')()),
                    viaEncode: probe(() => encodeBase64.constructor('return typeof process')()),
                    viaSniff: probe(() => sniff.constructor('return typeof process')()),
                    viaWrite: probe(() => write.constructor('return typeof process')()),
                    viaLog: probe(() => log.constructor('return typeof process')()),
                    viaFetch: probe(() => fetch.constructor('return typeof process')()),
                    viaGlobal: probe(() => globalThis.constructor.constructor('return typeof process')()),
                    viaObject: probe(() => Object.constructor.constructor('return typeof process')()),
                    viaFunction: probe(() => (function () {}).constructor('return typeof process')()),
                    viaEval: probe(() => eval('1')),
                    viaNewFunction: probe(() => new Function('return 1')()),
                };
            `,
            response: ANSWER,
        },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.equal(report.error, null);
    for (const [name, value] of Object.entries(report.value)) {
        assert.ok(
            value === 'BLOCKED' || value.startsWith('BLOCKED:') || value === 'undefined',
            `the script walked out through ${name}: ${value}`,
        );
    }
});

test('the script reads the answer and hands back the payloads', async () => {
    const report = await runParserSandboxWorker({
        spec: {
            script: `
                const parsed = JSON.parse(response);
                const payload = parsed.data.result.images[0].payload;
                return [payload, 'data:image/png;base64,AAAA'];
            `,
            response: ANSWER,
        },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.equal(report.error, null);
    const list = Array.isArray(report.value) ? report.value : [report.value];
    assert.equal(list[0], PNG_B64);
    assert.equal(list[1], 'data:image/png;base64,AAAA');
});

test('the helpers of the script work inside the sandbox', async () => {
    const report = await runParserSandboxWorker({
        spec: {
            script: `
                const bytes = decodeBase64('AAAA');
                return {
                    len: bytes.length,
                    first: bytes[0],
                    encoded: encodeBase64(bytes),
                    sniffed: sniff(decodeBase64('iVBORw0KGgo=')),
                    url: imageDataUrl(decodeBase64('AAAA'), 'image/png'),
                    text: new TextDecoder().decode(new TextEncoder().encode('hello')),
                    b64: btoa('hi'),
                    unb64: atob(btoa('hi')),
                };
            `,
            response: ANSWER,
        },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.equal(report.error, null);
    assert.equal(report.value.len, 3);
    assert.equal(report.value.first, 0);
    assert.equal(report.value.encoded, 'AAAA');
    assert.equal(report.value.sniffed, 'png');
    assert.match(report.value.url, /^data:image\/png;base64,/);
    assert.equal(report.value.text, 'hello');
    assert.equal(report.value.b64, 'aGk=');
    assert.equal(report.value.unb64, 'hi');
});

test('the script writes through the host, inside the working directory', async () => {
    const root = await tempDir();
    try {
        const written = [];
        const report = await runParserSandboxWorker({
            spec: {
                script: `
                    const parsed = JSON.parse(response);
                    await write('out/picture.png', parsed.data.result.images[0].payload);
                    return [];
                `,
                response: ANSWER,
                root,
            },
            onWrite: async (rel, data) => {
                written.push(rel);
                const abs = path.join(root, rel);
                await mkdir(path.dirname(abs), { recursive: true });
                await writeFile(abs, String(data), 'utf8');
                return rel;
            },
            onFetch: async () => null,
        });
        assert.equal(report.error, null);
        assert.deepEqual(written, ['out/picture.png']);
        // The file is there, and the host wrote it.
        assert.equal(await readFile(path.join(root, 'out', 'picture.png'), 'utf8'), PNG_B64);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the script reaches the libraries of the house', async () => {
    const report = await runParserSandboxWorker({
        spec: {
            script: `
                const catalog = await library.catalog();
                const here = catalog.filter((entry) => entry.available).map((entry) => entry.name);
                const version = here.includes('magick')
                    ? String(await library.call('magick.Magick.imageMagickVersion', []))
                    : 'no magick';
                return { here, version: version.slice(0, 30) };
            `,
            response: ANSWER,
        },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.equal(report.error, null);
    assert.ok(report.value.here.includes('canvas'));
    assert.match(report.value.version, /ImageMagick|no magick/);
});

test('a script that never ends is stopped, and the run lives', async () => {
    const report = await runParserSandboxWorker({
        spec: {
            // A loop that never yields: the realm alone cannot stop it.
            script: 'for (;;) { await Promise.resolve(); }',
            response: ANSWER,
            timeoutMs: 1200,
        },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    // The script was stopped, and the reason is named.
    assert.equal(report.reason, 'timeout');
    assert.match(report.error, /did not finish/);
});

test('a script that is not valid says so', async () => {
    const report = await runParserSandboxWorker({
        spec: { script: 'const = ;', response: ANSWER },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.match(report.error, /not valid/);
    assert.equal(report.reason, 'syntax');
});

test('an empty script is refused', async () => {
    const report = await runParserSandboxWorker({
        spec: { script: '   ', response: ANSWER },
        onWrite: async () => 'ok',
        onFetch: async () => null,
    });
    assert.match(report.error, /empty/);
});

test('the parser reads the answer through the sandbox', async () => {
    const root = await tempDir();
    try {
        const result = await runParserScript(
            'const parsed = JSON.parse(response); return [parsed.data.result.images[0].payload];',
            { response: ANSWER, root },
        );
        assert.equal(result.sources.length, 1);
        assert.equal(result.sources[0].kind, 'b64');
        // The reader wants a picture, not a short word: the payload of the test is one.
        assert.equal(result.sources[0].value, PNG_B64);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the script of the model is taken out of its fence', () => {
    const fenced = '```js\nreturn [1];\n```';
    assert.equal(extractScript(fenced), 'return [1];');
    assert.equal(extractScript('return [2];'), 'return [2];');
});

test('a payload is read out of whatever the script returned', () => {
    // A long enough base64: the reader wants a picture, not a short word.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    assert.deepEqual(toSource(b64), { kind: 'b64', value: b64 });
    assert.deepEqual(toSource(`data:image/png;base64,${b64}`), { kind: 'b64', value: b64 });
    assert.deepEqual(toSource('https://example.com/a.png'), { kind: 'url', value: 'https://example.com/a.png' });
    assert.equal(toSource('not a picture'), null);
    assert.equal(toSource(null), null);
});

test('the error of the sandbox carries the reason of the failure', () => {
    const error = new ParserSandboxError('the script is empty.', { reason: 'no-script' });
    assert.equal(error.name, 'ParserSandboxError');
    assert.equal(error.reason, 'no-script');
});

test('the sandbox runs in the realm of the house and writes nothing by itself', async () => {
    const root = await tempDir();
    try {
        // The script tries to write outside the working directory: the host refuses it.
        const result = await runParserScript(
            'await write("../escape.png", "AAAA"); return [];',
            { response: ANSWER, root },
        );
        assert.equal(result.sources.length, 0);
        // The file is not there.
        const escaped = path.join(path.dirname(root), 'escape.png');
        const exists = await readFile(escaped, 'utf8').catch(() => null);
        assert.equal(exists, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
