/**
 * @file test/vectorizer.test.js
 * @module test/vectorizer
 * @purpose Keep the full manual vectorization path offline and verify preparation and SVG checks.
 * @depends node:test, node:fs/promises, roles/vectorizer, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeRgba, encodeRgba } from '../src/image/raster.js';
import { vectorizeAsset } from '../src/roles/vectorizer.js';

async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-vectorizer-'));
}

async function paddedLogo() {
    const width = 8;
    const height = 8;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
            const i = (y * width + x) * 4;
            data[i] = 230;
            data[i + 1] = 40;
            data[i + 2] = 60;
            data[i + 3] = 255;
        }
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

function clientFor(svg, onImage = () => {}) {
    return {
        images: {
            async vectorize(request) {
                onImage(request.image);
                return { images: [{ bytes: Buffer.from(svg) }], model: 'offline-vector-model' };
            },
        },
    };
}

test('manual vectorization trims into temp storage, validates, then writes the SVG', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.png');
    const output = path.join(cwd, 'assets', 'logo.svg');
    const source = await paddedLogo();
    await writeFile(input, source);
    let uploaded = null;

    const result = await vectorizeAsset({
        client: clientFor(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#e6283c"/></svg>',
            (image) => { uploaded = image; },
        ),
        input,
        output,
        cwd,
    });

    assert.equal(result.ok, true);
    assert.equal(result.path, 'assets/logo.svg');
    assert.equal(result.model, 'offline-vector-model');
    assert.match(uploaded.filename, /-trim\.png$/);
    assert.notDeepEqual(uploaded.bytes, source, 'the trimmed raster is the image sent to the model');
    assert.equal((await decodeRgba(uploaded.bytes)).width, 4);
    assert.match((await readFile(output, 'utf8')), /^<svg/);
    assert.deepEqual((await readdir(cwd)).sort(), ['assets', 'logo.png']);
});

test('an invalid SVG is not saved and does not replace an existing document', async () => {
    const cwd = await tempDir();
    const input = path.join(cwd, 'logo.png');
    const output = path.join(cwd, 'logo.svg');
    await writeFile(input, await paddedLogo());
    await writeFile(output, 'keep the previous document');

    const result = await vectorizeAsset({
        client: clientFor('<svg><g></svg>'),
        input,
        output,
        cwd,
    });

    assert.equal(result.ok, false);
    assert.equal(result.path, null);
    assert.equal(result.reason, 'the document does not open');
    assert.equal(await readFile(output, 'utf8'), 'keep the previous document');
    assert.deepEqual((await readdir(cwd)).sort(), ['logo.png', 'logo.svg']);
});
