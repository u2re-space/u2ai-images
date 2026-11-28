/**
 * @file test/code-libraries.test.js
 * @module test/code-libraries
 * @purpose Tests of the libraries of the house inside the sandbox of Code Mode.
 * @depends node:test, node:assert, shared/code-libraries, shared/code-mode, image/raster
 * @ai.tags test, code-mode, libraries, canvas, magick, openvector
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createLibraryBridge, libraryCatalog, LIBRARY_NAMES } from '../src/shared/code-libraries.js';
import { runCodeModeWorker } from '../src/shared/code-mode.js';
import { encodeRgba } from '../src/image/raster.js';

/**
 * A temporary directory that cleans itself up.
 * @returns {Promise<string>}
 */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-code-libs-'));
}

/**
 * A picture of one solid colour, as the tracer wants it.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function solidPng(width, height) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        data[i * 4] = 200; data[i * 4 + 1] = 30; data[i * 4 + 2] = 40; data[i * 4 + 3] = 255;
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

test('the catalogue names the libraries of the house', async () => {
    const catalog = await libraryCatalog();
    assert.equal(catalog.length, LIBRARY_NAMES.length);
    const names = catalog.map((entry) => entry.name);
    assert.ok(names.includes('canvas'));
    assert.ok(names.includes('magick'));
    assert.ok(names.includes('openvector'));
    for (const entry of catalog) {
        assert.equal(typeof entry.available, 'boolean');
        assert.ok(Array.isArray(entry.operations));
    }
});

test('a native handle never leaves the host', async () => {
    const bridge = createLibraryBridge({});
    const made = JSON.parse(await bridge.call('canvas.createCanvas', JSON.stringify([8, 8])));
    assert.equal(made.ok, true);
    // The answer is an id, not an object.
    assert.equal(typeof made.value, 'string');
    assert.match(made.value, /^h\d+$/);
    assert.equal(bridge.handles(), 1);
});

test('the canvas of the house draws a picture from the program', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const surface = await library.call('canvas.createCanvas', [16, 8]);
                const ctx = await library.call(surface + '.getContext', ['2d']);
                await library.call(ctx + '.fillRect', [0, 0, 16, 8]);
                const url = await library.call(surface + '.toDataURL', ['image/png']);
                return { url: String(url), length: String(url).length };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    // A real PNG came out of the program.
    assert.match(report.value.url, /^data:image\/png;base64,/);
    assert.ok(report.value.length > 100);
});

test('the wasm of ImageMagick works from the program', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const version = await library.call('magick.Magick.imageMagickVersion', []);
                return { version: String(version).slice(0, 40) };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.match(report.value.version, /ImageMagick/);
});

test('openvector traces a raster into a vector from the program', async () => {
    const png = await solidPng(16, 16);
    const bytes = [...png].join(',');
    // The trace lands in a temporary directory: the tracer never overwrites, and a file
    // that is already there is a refusal with a status of its own.
    const dir = await tempDir();
    try {
        const target = path.join(dir, 'traced.svg');
        const report = await runCodeModeWorker({
            spec: {
                code: `
                    const session = await library.call('openvector.CoreSession', []);
                    const doc = await library.call(session + '.createDocument', []);
                    const picture = new Uint8Array([${bytes}]);
                    await library.call(doc + '.setSource', [library.buffer(picture), 'square.png']);
                    await library.call(doc + '.runAutomatic', [{ extension: '.png' }]);
                    const saved = await library.call(doc + '.saveVector', [${JSON.stringify(target)}, { layout: 'cutouts' }]);
                    return { saved: typeof saved, status: saved.status };
                `,
                tools: [],
            },
            onCall: async () => 'ok',
        });
        assert.equal(report.ok, true);
        // The answer of the library is data, and the program reads it as an object: the
        // status of the save is the status of the save.
        assert.equal(report.value.saved, 'object');
        assert.equal(report.value.status, 0);
        // The trace is a real document.
        const traced = await readFile(target, 'utf8');
        assert.match(traced, /<svg/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
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
                    viaBuffer: probe(() => library.buffer.constructor('return typeof process')()),
                    viaBase64: probe(() => library.base64.constructor('return typeof process')()),
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

test('the program reaches the libraries without an import', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const catalog = await library.catalog();
                return {
                    here: catalog.filter((item) => item.available).map((item) => item.name),
                    hasRequire: typeof require,
                    hasProcess: typeof process,
                    hasModule: typeof module,
                };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.equal(report.value.hasRequire, 'undefined');
    assert.equal(report.value.hasProcess, 'undefined');
    assert.equal(report.value.hasModule, 'undefined');
    // The package has all three: the canvas, the wasm and the tracer.
    assert.ok(report.value.here.includes('canvas'));
    assert.ok(report.value.here.includes('magick'));
    assert.ok(report.value.here.includes('openvector'));
});

test('a failed call throws into the program, and the program goes on', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                let caught = null;
                try {
                    await library.call('no.such.library', []);
                } catch (error) {
                    caught = error.message;
                }
                return { caught };
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.match(report.value.caught, /not available here/);
});
