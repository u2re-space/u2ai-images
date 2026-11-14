/**
 * @file test/alpha.test.js
 * @module test/alpha
 * @purpose The alpha pipeline: a native alpha channel, the key by the color of the border, the
 *          fill from the corners, the refusal of a painted plate and the modes `auto` and `off`.
 * @depends node:test, node:fs/promises, node:os, node:path, image/alpha, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    alphaFormatWarning,
    alphaModels,
    applyGeneratedAlphaMask,
    clearedShare,
    cutoutPrompt,
    frameFor,
    hasRealAlpha,
    isFakePlate,
    judgeAlphaShares,
    localKeyAlpha,
    maskPassModel,
    softShare,
} from '../src/image/alpha.js';
import { cloneDefaults } from '../src/config/defaults.js';
import { decodeRgba, encodeRgba } from '../src/image/raster.js';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-alpha-'));
}

/**
 * A picture of a solid color.
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number, a: number }} color
 * @returns {Promise<Buffer>}
 */
async function solidPng(width, height, color) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = color.r;
        data[i + 1] = color.g;
        data[i + 2] = color.b;
        data[i + 3] = color.a;
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

/**
 * A picture with an opaque object in the middle of a white background.
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function objectOnPlate(size) {
    const data = Buffer.alloc(size * size * 4);
    const inset = Math.floor(size / 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const at = (y * size + x) * 4;
            const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
            data[at] = inside ? 30 : 255;
            data[at + 1] = inside ? 90 : 255;
            data[at + 2] = inside ? 200 : 255;
            data[at + 3] = 255;
        }
    }
    return await encodeRgba({ width: size, height: size, data }, { format: 'png' });
}

/**
 * A picture that imitates transparency with a checkerboard.
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function checkerPlate(size) {
    const data = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const at = (y * size + x) * 4;
            const light = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
            data[at] = light ? 255 : 204;
            data[at + 1] = light ? 255 : 204;
            data[at + 2] = light ? 255 : 204;
            data[at + 3] = 255;
        }
    }
    return await encodeRgba({ width: size, height: size, data }, { format: 'png' });
}

/**
 * The alpha of one pixel of a picture.
 * @param {Buffer} bytes
 * @param {number} x
 * @param {number} y
 * @returns {Promise<number>}
 */
async function alphaAt(bytes, x, y) {
    const frame = await decodeRgba(bytes);
    return frame.data[(y * frame.width + x) * 4 + 3];
}

test('a picture with a real alpha is kept as it is', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'cut.png');
    const size = 64;
    const data = Buffer.alloc(size * size * 4);
    const inset = 16;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const at = (y * size + x) * 4;
            const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
            data[at] = 20;
            data[at + 1] = 40;
            data[at + 2] = 60;
            data[at + 3] = inside ? 255 : 0;
        }
    }
    await writeFile(file, await encodeRgba({ width: size, height: size, data }, { format: 'png' }));
    assert.equal(await hasRealAlpha({ abs: file, cwd: dir }), true);
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'auto' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already');
});

test('the shares of the alpha are measured', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await solidPng(32, 32, { r: 10, g: 20, b: 30, a: 0 }));
    assert.equal(await clearedShare({ abs: file, cwd: dir }), 1);
    const verdict = await judgeAlphaShares({ abs: file, cwd: dir, totalPixels: 32 * 32 });
    assert.equal(verdict.usable, true);
    assert.equal(typeof verdict.soft, 'number');
});

test('the key by the color of the border cuts the plate off', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await objectOnPlate(64));
    const result = await localKeyAlpha({
        engine: 'auto', base: file, abs: file, cwd: dir, feather: 0,
    });
    assert.equal(result.changed, true);
    const bytes = await readFile(file);
    assert.equal(await alphaAt(bytes, 0, 0), 0, 'the corner of the plate is transparent');
    assert.equal(await alphaAt(bytes, 32, 32), 255, 'the object is opaque');
});

test('the mode `key` cuts the background off', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await objectOnPlate(64));
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'key', feather: 0 });
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'key');
    const bytes = await readFile(file);
    assert.equal(await alphaAt(bytes, 0, 0), 0);
    assert.equal(await alphaAt(bytes, 32, 32), 255);
});

test('the mode `flat` fills the background from the corners', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await objectOnPlate(64));
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'flat', feather: 0 });
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'flat');
    const bytes = await readFile(file);
    assert.equal(await alphaAt(bytes, 0, 0), 0);
    assert.equal(await alphaAt(bytes, 32, 32), 255);
});

test('the mode `contour` draws the matte locally', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await objectOnPlate(64));
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'contour', feather: 0 });
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'contour');
    const bytes = await readFile(file);
    assert.equal(await alphaAt(bytes, 0, 0), 0);
    assert.equal(await alphaAt(bytes, 32, 32), 255);
});

test('a painted plate is told apart from a real cut-out', async () => {
    const dir = await tempDir();
    const plate = path.join(dir, 'plate.png');
    await writeFile(plate, await checkerPlate(64));
    assert.equal(await isFakePlate({ engine: 'auto', base: plate, cwd: dir }), true);
    assert.equal(await hasRealAlpha({ abs: plate, cwd: dir }), false);
});

test('the mode `off` leaves the picture alone', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    const bytes = await objectOnPlate(64);
    await writeFile(file, bytes);
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'off' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'off');
    assert.deepEqual(await readFile(file), bytes);
});

test('the mode `auto` cuts a picture without an alpha', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await objectOnPlate(64));
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'auto', feather: 0 });
    assert.equal(result.changed, true);
    const bytes = await readFile(file);
    assert.equal(await alphaAt(bytes, 0, 0), 0);
});

test('JPEG carries no alpha and the command says so', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.jpg');
    await writeFile(file, await solidPng(16, 16, { r: 1, g: 2, b: 3, a: 255 }));
    const result = await applyGeneratedAlphaMask({ file, alphaMode: 'auto' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'format');
    assert.match(alphaFormatWarning(file), /JPEG/);
    assert.equal(alphaFormatWarning('a.png'), null);
});

test('the frame of the technical pass keeps the aspect', () => {
    assert.equal(frameFor({ width: 800, height: 600 }), '1536x1024');
    assert.equal(frameFor({ width: 600, height: 800 }), '1024x1536');
    assert.equal(frameFor({ width: 500, height: 500 }), '1024x1024');
    assert.equal(frameFor({ width: 640, height: 480 }), '1536x1024');
    assert.equal(frameFor(null), null);
});

test('the model of the technical passes is chosen by the config', () => {
    assert.equal(maskPassModel({ maskModel: 'self', model: 'a/model' }), 'a/model');
    assert.equal(maskPassModel({ maskModel: 'other/model', model: 'a/model' }), 'other/model');
    assert.equal(maskPassModel({ model: 'a/model', preferGenerator: true }), 'a/model');
    assert.equal(maskPassModel({ model: 'a/model' }), null);
});

test('the soft share tells a halo from a clean edge', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await solidPng(64, 64, { r: 10, g: 10, b: 10, a: 128 }));
    const share = await softShare({ abs: file, cwd: dir });
    assert.ok(share > 0.9, `the share is ${share}`);
});

test('the cut-out is asked of the two models that carry an alpha natively', () => {
    const config = cloneDefaults();
    assert.deepEqual(alphaModels({ config }),
        ['bytedance-seed/seedream-5-5', 'openai/gpt-image-2.6-sunburst']);
    // The model of the caller goes first when it is one of them.
    assert.deepEqual(alphaModels({ config, model: 'bytedance-seed/seedream-5-5' }),
        ['bytedance-seed/seedream-5-5', 'openai/gpt-image-2.6-sunburst']);
    assert.deepEqual(alphaModels({ config, model: 'openai/gpt-image-2.6-sunburst' }),
        ['openai/gpt-image-2.6-sunburst', 'bytedance-seed/seedream-5-5']);
    // A model that cannot cut out is not asked for a cut-out.
    assert.deepEqual(alphaModels({ config, model: 'sourceful/riverflow-v2.6-pro' }),
        ['bytedance-seed/seedream-5-5', 'openai/gpt-image-2.6-sunburst']);
});

test('the prompt of the cut-out names the subject when it is given', () => {
    assert.equal(cutoutPrompt(null), cutoutPrompt(''));
    assert.match(cutoutPrompt(null), /make everything around it fully transparent/);

    const named = cutoutPrompt('chess bishop');
    assert.match(named, /keep only the chess bishop/);
    // The fragments of the neighbours have to go too.
    assert.match(named, /fragment of a neighbouring object/);
});

test('the next model is asked when the answer is not a cut-out', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await solidPng(64, 64, { r: 10, g: 10, b: 10, a: 255 }));
    const asked = [];
    const client = {
        images: {
            async edit(params) {
                asked.push(params.model);
                // The first model answers with a picture that has no transparency at all.
                return {
                    model: params.model,
                    images: [{ bytes: await solidPng(64, 64, { r: 10, g: 10, b: 10, a: 255 }) }],
                };
            },
        },
    };
    const result = await applyGeneratedAlphaMask({
        client,
        config: cloneDefaults(),
        file,
        alphaMode: 'auto',
    });
    assert.equal(asked.length, 2, 'the second model was asked');
    assert.equal(asked[0], 'bytedance-seed/seedream-5-5');
    assert.equal(asked[1], 'openai/gpt-image-2.6-sunburst');
    assert.equal(result.changed, true, 'the local fallback finished the work');
});
