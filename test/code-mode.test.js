/**
 * @file test/code-mode.test.js
 * @module test/code-mode
 * @purpose Tests of Code Mode in the images: the tool, the catalogue, the sandbox and the
 *          image API as a facility of the host.
 * @depends node:test, node:assert, agent/code-mode, agent/tool-specs, agent/tools,
 *          shared/code-mode, shared/code-libraries
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';

import { createCodeModeRunner, codeModeBudgetFor } from '../src/agent/code-mode.js';
import { runCodeModeWorker } from '../src/shared/code-mode.js';
import { libraryCatalog } from '../src/shared/code-libraries.js';
import { TOOL_SPECS, TOOL_NAMES, toolSpecs, configKeyFor, toolEnabled } from '../src/agent/tool-specs.js';
import { createImageTools } from '../src/agent/tools.js';
import { defaults } from '../src/config/defaults.js';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-code-mode-'));
}

/**
 * A client of the pictures: it answers every call with the same small PNG.
 * @param {object[]} [seen] the calls the client saw
 * @returns {object}
 */
function imageClient(seen = []) {
    return {
        images: {
            async generate(request) {
                seen.push({ kind: 'generate', request });
                return { payloads: [PNG.toString('base64')], model: 'test-image-model', route: 'images' };
            },
            async edit(request) {
                seen.push({ kind: 'edit', request });
                return { payloads: [PNG.toString('base64')], model: 'test-image-model', route: 'images' };
            },
        },
        responses: {
            async create() { return { status: 'completed', output_text: 'a picture' }; },
            text(answer) { return answer?.output_text ?? ''; },
        },
    };
}

test('the images have a catalogue of their tools', () => {
    assert.ok(TOOL_SPECS.generate_image);
    assert.ok(TOOL_SPECS.edit_image);
    assert.ok(TOOL_SPECS.code_mode);
    assert.ok(TOOL_NAMES.includes('generate_image'));
    assert.equal(configKeyFor('generate_image'), 'image_generate');
    // The catalogue of the house is merged in: the tools that mean the same thing
    // everywhere are here too.
    assert.ok(TOOL_SPECS.read_file, 'the tools of the house are merged in');
    assert.ok(TOOL_SPECS.list_files);
    // A tool that is not mentioned in the config is on.
    assert.equal(toolEnabled({}, 'generate_image'), true);
    assert.equal(toolEnabled({ image_generate: false }, 'generate_image'), false);
    // The specs go to the model in the shape of the Responses API.
    const specs = toolSpecs(defaults.tools, { names: ['generate_image'] });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].type, 'function');
    assert.ok(specs[0].description.length > 10);
});

test('the budget of a turn with a program is bigger than the budget of a read', () => {
    assert.equal(codeModeBudgetFor(1000, false), 125);
    assert.equal(codeModeBudgetFor(1000, true, { factor: 2, ceiling: 65_536 }), 2000);
    assert.equal(codeModeBudgetFor(null, true), null);
});

test('a program of the images calls the tools of the images', async () => {
    const calls = [];
    const runner = createCodeModeRunner({
        execute: async (name, args) => {
            calls.push({ name, args });
            return `the answer of ${name}`;
        },
        specs: [
            { name: 'generate_image', description: 'makes a picture', parameters: {} },
            { name: 'edit_image', description: 'changes a picture', parameters: {} },
        ],
    });
    const answer = await runner({
        code: `
            const made = await tools.generate_image({ prompt: 'a cat' });
            const edited = await tools.edit_image({ input: 'a.png', prompt: 'blue' });
            return { made, edited };
        `,
    });
    assert.match(answer, /The program ran/);
    assert.deepEqual(calls.map((call) => call.name), ['generate_image', 'edit_image']);
    assert.deepEqual(calls[0].args, { prompt: 'a cat' });
});

test('a program of the images makes a picture with the tool and keeps it on the disk', async () => {
    const root = await tempDir();
    try {
        const seen = [];
        const tools = createImageTools({ client: imageClient(seen), config: defaults, cwd: root });
        const answer = await tools.code_mode({
            code: `
                const made = await tools.generate_image({ prompt: 'a red bicycle' });
                return { files: made.files };
            `,
        });
        assert.match(answer, /The program ran/);
        // The picture landed in the assets of the run.
        const assets = await readdir(path.join(root, '.ai', 'assets'));
        assert.equal(assets.length, 1);
        assert.equal(seen.filter((call) => call.kind === 'generate').length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a program of the images edits a picture with the tool', async () => {
    const root = await tempDir();
    try {
        await writeFile(path.join(root, 'source.png'), PNG);
        const seen = [];
        const tools = createImageTools({ client: imageClient(seen), config: defaults, cwd: root });
        const answer = await tools.code_mode({
            code: `
                const edited = await tools.edit_image({ input: 'source.png', prompt: 'make it blue' });
                return { files: edited.files };
            `,
        });
        assert.match(answer, /The program ran/);
        assert.equal(seen.filter((call) => call.kind === 'edit').length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the image API is a facility of the host, and the program reaches it', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const catalog = await library.catalog();
                const raw = await library.call('images.generate', [{ prompt: 'a cat' }]);
                return {
                    hasFacility: catalog.some((entry) => entry.facility && entry.name === 'images.generate'),
                    payloads: Array.isArray(raw.payloads) ? raw.payloads.length : 0,
                    model: raw.model,
                };
            `,
            tools: [],
            facilities: ['images.generate'],
        },
        onCall: async () => 'ok',
        onFacility: async (path, args) => {
            assert.equal(path, 'images.generate');
            assert.equal(args.prompt, 'a cat');
            return { payloads: ['AAA', 'BBB'], model: 'test-image-model', route: 'images' };
        },
    });
    assert.equal(report.ok, true);
    assert.equal(report.value.hasFacility, true);
    assert.equal(report.value.payloads, 2);
    assert.equal(report.value.model, 'test-image-model');
});

test('a facility that the host does not have is refused', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                let caught = null;
                try {
                    await library.call('images.nothing', [{}]);
                } catch (error) {
                    caught = error.message;
                }
                return { caught };
            `,
            tools: [],
            facilities: ['images.generate'],
        },
        onCall: async () => 'ok',
        onFacility: async () => ({ payloads: [] }),
    });
    assert.equal(report.ok, true);
    assert.match(report.value.caught, /not available here|not installed/);
});

test('the program of the images has no process, no require and no import', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: 'return { process: typeof process, require: typeof require, module: typeof module };',
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.value, {
        process: 'undefined',
        require: 'undefined',
        module: 'undefined',
    });
});

test('the libraries of the house are reachable from the program of the images', async () => {
    const catalog = await libraryCatalog();
    const names = catalog.map((entry) => entry.name);
    assert.ok(names.includes('canvas'));
    assert.ok(names.includes('magick'));

    const report = await runCodeModeWorker({
        spec: {
            code: `
                const catalog = await library.catalog();
                const here = catalog.filter((item) => item.available).map((item) => item.name);
                const version = here.includes('magick')
                    ? String(await library.call('magick.Magick.imageMagickVersion', []))
                    : 'no magick';
                return { here, version: version.slice(0, 40) };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.ok(report.value.here.includes('canvas'));
    assert.match(report.value.version, /ImageMagick|no magick/);
});

test('the facade of the libraries is not a way out of the sandbox', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const probe = (fn) => {
                    try { return String(fn()); } catch (error) { return 'BLOCKED:' + error.constructor.name; }
                };
                return {
                    viaCall: probe(() => library.call.constructor('return typeof process')()),
                    viaCatalog: probe(() => library.catalog.constructor('return typeof process')()),
                    viaBytes: probe(() => library.bytes.constructor('return typeof process')()),
                };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    for (const [name, value] of Object.entries(report.value)) {
        assert.ok(
            value === 'BLOCKED' || value.startsWith('BLOCKED:') || value === 'undefined',
            `the program walked out through ${name}: ${value}`,
        );
    }
});
