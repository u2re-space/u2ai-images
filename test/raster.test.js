/**
 * @file test/raster.test.js
 * @module test/raster
 * @purpose The local raster layer: the engines, the frame of a picture, the crop, the trim, the
 *          padding and the cut of that padding, the split and the fit.
 * @depends node:test, node:fs/promises, node:os, node:path, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    decodeRgba,
    encodeRgba,
    getRaster,
    rasterAlphaShare,
    rasterAlphaSoftShare,
    rasterCrop,
    rasterDetectFakeTransparency,
    rasterEngine,
    rasterFitToFrame,
    rasterInfo,
    rasterIsOpaque,
    rasterPadImageBytes,
    rasterRemoveImagePadding,
    rasterSplit,
    rasterTrim,
} from '../src/image/raster.js';
import { padImage, parsePadColor } from '../src/image/padding.js';
import { downscaleImage } from '../src/image/downscale.js';
import { upscaleImage } from '../src/image/upscale.js';
import { trimImage } from '../src/image/trimmer.js';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-raster-'));
}

/**
 * A picture of a solid color with a given frame.
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number, a: number }} [color]
 * @returns {Promise<Buffer>}
 */
async function solidPng(width, height, color = { r: 200, g: 30, b: 40, a: 255 }) {
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
 * A picture with a transparent border and an opaque square in the middle.
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function paddedPng(size) {
    const data = Buffer.alloc(size * size * 4);
    const inset = Math.floor(size / 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const at = (y * size + x) * 4;
            const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
            data[at] = inside ? 10 : 0;
            data[at + 1] = inside ? 120 : 0;
            data[at + 2] = inside ? 200 : 0;
            data[at + 3] = inside ? 255 : 0;
        }
    }
    return await encodeRgba({ width: size, height: size, data }, { format: 'png' });
}

test('the engine of the process is sharp or canvas', async () => {
    const engine = await rasterEngine();
    assert.ok(['sharp', 'canvas'].includes(engine), `the engine is ${engine}`);
});

test('every engine decodes the same picture the same way', async () => {
    const bytes = await solidPng(24, 16);
    const engines = ['sharp', 'canvas'];
    const frames = [];
    for (const engine of engines) {
        const frame = await decodeRgba(bytes, engine);
        frames.push(frame);
        assert.equal(frame.width, 24);
        assert.equal(frame.height, 16);
        assert.equal(frame.data[0], 200);
    }
    assert.deepEqual(frames[0].data, frames[1].data, 'both engines see the same pixels');
});

test('the frame and the format of a picture are read', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.png');
    await writeFile(file, await solidPng(40, 30));
    const info = await rasterInfo(file);
    assert.equal(info.width, 40);
    assert.equal(info.height, 30);
    assert.equal(info.format, 'png');
});

test('an opaque picture is opaque and an empty one is not', async () => {
    const dir = await tempDir();
    const solid = path.join(dir, 'solid.png');
    const empty = path.join(dir, 'empty.png');
    await writeFile(solid, await solidPng(10, 10));
    await writeFile(empty, await solidPng(10, 10, { r: 0, g: 0, b: 0, a: 0 }));
    assert.equal(await rasterIsOpaque(solid), true);
    assert.equal(await rasterIsOpaque(empty), false);
    assert.equal(await rasterAlphaShare({ input: empty }), 1);
    assert.ok((await rasterAlphaShare({ input: solid })) < 0.001);
});

test('the crop cuts the rectangle out', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(100, 80));
    const cut = await rasterCrop({
        input, output: path.join(dir, 'cut.png'), x: 10, y: 20, width: 30, height: 40, cwd: dir,
    });
    assert.equal(cut.width, 30);
    assert.equal(cut.height, 40);
    const info = await rasterInfo(path.join(dir, 'cut.png'));
    assert.equal(info.width, 30);
    assert.equal(info.height, 40);
});

test('the trim cuts the transparent border off', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await paddedPng(100));
    const result = await trimImage({ input, output: path.join(dir, 'trim.png'), cwd: dir, transparentOnly: true });
    assert.equal(result.changed, true);
    assert.equal(result.after.width, 50);
    assert.equal(result.after.height, 50);
});

test('the padding keeps the content and the cut restores the frame', async () => {
    const bytes = await solidPng(100, 90);
    const padded = await rasterPadImageBytes({ bytes, targetWidth: 128, targetHeight: 128 });
    assert.equal(padded.padded, true);
    assert.equal(padded.width, 128);
    assert.equal(padded.height, 128);
    assert.equal(padded.originalWidth, 100);
    assert.equal(padded.originalHeight, 90);
    const info = await decodeRgba(padded.bytes);
    assert.equal(info.width, 128);
    assert.equal(info.height, 128);
    // The content sits in the top-left corner in its own scale.
    assert.equal(info.data[0], 200);
    assert.equal(info.data[3], 255);
    const cut = await rasterRemoveImagePadding({
        bytes: padded.bytes,
        width: padded.width,
        height: padded.height,
        originalWidth: padded.originalWidth,
        originalHeight: padded.originalHeight,
    });
    const back = await decodeRgba(cut);
    assert.equal(back.width, 100);
    assert.equal(back.height, 90);
});

test('the padding of a legal frame changes nothing', async () => {
    const bytes = await solidPng(128, 128);
    const padded = await rasterPadImageBytes({ bytes, targetWidth: 128, targetHeight: 128 });
    assert.equal(padded.padded, false);
    assert.equal(padded.bytes, bytes);
});

test('the canvas grows with a color and the content keeps its place', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(20, 20));
    const result = await padImage({
        input, output: path.join(dir, 'padded.png'), width: 40, height: 30, color: '#ffffff', cwd: dir,
    });
    assert.equal(result.width, 40);
    assert.equal(result.height, 30);
    const frame = await decodeRgba(await readFile(path.join(dir, 'padded.png')));
    assert.equal(frame.data[0], 200, 'the content is in the corner');
    const at = (29 * 40 + 39) * 4;
    assert.equal(frame.data[at], 255, 'the new space is filled with the color');
    assert.deepEqual(parsePadColor('transparent'), { r: 0, g: 0, b: 0, alpha: 0 });
    assert.deepEqual(parsePadColor('#ff0000'), { r: 255, g: 0, b: 0, alpha: 1 });
});

test('the fit keeps the proportions', async () => {
    const bytes = await solidPng(200, 100);
    const cover = await rasterFitToFrame({ bytes, width: 100, height: 100, fit: 'cover' });
    const frame = await decodeRgba(cover);
    assert.equal(frame.width, 100);
    assert.equal(frame.height, 100);
    const contain = await rasterFitToFrame({ bytes, width: 100, height: 100, fit: 'contain' });
    const inside = await decodeRgba(contain);
    assert.equal(inside.width, 100);
    assert.equal(inside.height, 100);
    // The picture is 2:1, so in the contain mode it is 100 wide and 50 high, centered.
    const row = 25 * 100 * 4;
    assert.equal(inside.data[row + 3], 255);
    assert.equal(inside.data[0], 0, 'the space above the picture is empty');
});

test('the split cuts the picture into tiles', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(100, 100));
    const tiles = await rasterSplit({
        input, outputDir: path.join(dir, 'tiles'), rows: 2, cols: 2, cwd: dir,
    });
    assert.equal(tiles.length, 4);
    assert.equal(tiles[0].width, 50);
    assert.equal(tiles[3].height, 50);
});

test('the downscale and the upscale keep the proportions', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(200, 100));
    const small = await downscaleImage({
        input, output: path.join(dir, 'small.png'), maxSide: 100, cwd: dir,
    });
    assert.equal(small.width, 100);
    assert.equal(small.height, 50);
    const big = await upscaleImage({
        input, output: path.join(dir, 'big.png'), factor: 2, cwd: dir,
    });
    assert.equal(big.width, 400);
    assert.equal(big.height, 200);
});

test('a painted checkerboard is told apart from a real cut-out', async () => {
    const dir = await tempDir();
    const plate = path.join(dir, 'plate.png');
    const size = 64;
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
    await writeFile(plate, await encodeRgba({ width: size, height: size, data }, { format: 'png' }));
    assert.equal(await rasterDetectFakeTransparency({ input: plate, cwd: dir }), true);
    const real = path.join(dir, 'real.png');
    await writeFile(real, await paddedPng(64));
    assert.equal(await rasterDetectFakeTransparency({ input: real, cwd: dir }), false);
});

test('the adapter of the client pads, crops and fits', async () => {
    const raster = await getRaster({ engine: 'auto' });
    assert.ok(raster.engine);
    const padded = await raster.padImageBytes({
        bytes: await solidPng(30, 30), targetWidth: 64, targetHeight: 64,
    });
    assert.equal(padded.width, 64);
    const cut = await raster.removeImagePadding({
        bytes: padded.bytes,
        width: padded.width,
        height: padded.height,
        originalWidth: padded.originalWidth,
        originalHeight: padded.originalHeight,
    });
    const frame = await decodeRgba(cut);
    assert.equal(frame.width, 30);
    const fitted = await raster.fitToFrame({ bytes: await solidPng(80, 40), width: 40, height: 40, fit: 'cover' });
    assert.equal((await decodeRgba(fitted)).width, 40);
});

test('the soft share of the alpha tells a halo from a clean cut-out', async () => {
    const dir = await tempDir();
    const clean = path.join(dir, 'clean.png');
    await writeFile(clean, await paddedPng(64));
    const share = await rasterAlphaSoftShare({ input: clean, cwd: dir });
    assert.ok(share >= 0 && share < 0.2, `the share is ${share}`);
});
