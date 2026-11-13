/**
 * @file test/tools.test.js
 * @module test/tools
 * @purpose The local operations: crop, trim, pad, fit, resize, split, compare and the sink that
 *          writes the pictures of a run.
 * @depends node:test, node:fs/promises, node:os, node:path, image/tools, image/raster, core/sink
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    comparePictures,
    cropPicture,
    fitPicture,
    padPicture,
    pictureInfo,
    resizePicture,
    splitPicture,
    trimPicture,
} from '../src/image/tools.js';
import { decodeRgba, encodeRgba } from '../src/image/raster.js';
import { createImageSink } from '../src/core/sink.js';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-tools-'));
}

/**
 * A picture of a solid color.
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number, a: number }} color
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

test('the crop cuts the box out of the source', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(100, 80));
    const result = await cropPicture({
        input, output: path.join(dir, 'cut.png'), x: 10, y: 20, width: 30, height: 40, cwd: dir,
    });
    assert.equal(result.width, 30);
    assert.equal(result.height, 40);
    assert.deepEqual(result.source, { width: 100, height: 80 });
});

test('the crop without a box refuses', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(10, 10));
    await assert.rejects(
        cropPicture({ input, output: path.join(dir, 'b.png'), cwd: dir }),
        /width and the height/,
    );
});

test('the trim cuts the transparent border off', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await paddedPng(100));
    const result = await trimPicture({
        input, output: path.join(dir, 'trim.png'), transparentOnly: true, cwd: dir,
    });
    assert.equal(result.changed, true);
    assert.equal(result.after.width, 50);
});

test('the pad grows the canvas and keeps the content in place', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(20, 20));
    const result = await padPicture({
        input, output: path.join(dir, 'padded.png'), width: 40, height: 30, color: '#ffffff', cwd: dir,
    });
    assert.equal(result.width, 40);
    assert.equal(result.height, 30);
    const frame = await decodeRgba(await readFile(path.join(dir, 'padded.png')));
    assert.equal(frame.data[0], 200, 'the content stays in the corner');
    assert.equal(frame.data[(29 * 40 + 39) * 4], 255, 'the new space is filled');
});

test('the fit has three modes and the proportions survive', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(200, 100));
    const contain = await fitPicture({
        input, output: path.join(dir, 'contain.png'), width: 100, height: 100, fit: 'contain', cwd: dir,
    });
    assert.equal(contain.width, 100);
    const frame = await decodeRgba(await readFile(path.join(dir, 'contain.png')));
    assert.equal(frame.data[0], 0, 'the picture is whole inside the frame');
    assert.equal(frame.data[25 * 100 * 4 + 3], 255, 'the picture is centered');
    const cover = await fitPicture({
        input, output: path.join(dir, 'cover.png'), width: 100, height: 100, fit: 'cover', cwd: dir,
    });
    assert.equal(cover.width, 100);
    const fill = await fitPicture({
        input, output: path.join(dir, 'fill.png'), width: 100, height: 100, fit: 'fill', cwd: dir,
    });
    assert.equal(fill.width, 100);
    await assert.rejects(
        fitPicture({ input, output: path.join(dir, 'x.png'), width: 10, height: 10, fit: 'nope', cwd: dir }),
        /fit mode/,
    );
});

test('the resize keeps the proportions when one side is given', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(200, 100));
    const byWidth = await resizePicture({
        input, output: path.join(dir, 'w.png'), width: 100, cwd: dir,
    });
    assert.equal(byWidth.width, 100);
    assert.equal(byWidth.height, 50);
    const bySide = await resizePicture({
        input, output: path.join(dir, 's.png'), maxSide: 100, cwd: dir,
    });
    assert.equal(bySide.width, 100);
    assert.equal(bySide.height, 50);
    const byFactor = await resizePicture({
        input, output: path.join(dir, 'f.png'), factor: 2, cwd: dir,
    });
    assert.equal(byFactor.width, 400);
    assert.equal(byFactor.height, 200);
});

test('the split cuts the picture into tiles', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(100, 100));
    const result = await splitPicture({
        input, outputDir: path.join(dir, 'tiles'), rows: 2, cols: 2, cwd: dir,
    });
    assert.equal(result.tiles.length, 4);
    assert.equal(result.tiles[0].width, 50);
    assert.equal(result.tiles[3].height, 50);
    assert.deepEqual(result.source, { width: 100, height: 100 });
    const files = await readdir(path.join(dir, 'tiles'));
    assert.equal(files.length, 4);
});

test('the compare builds a sheet and a map of the difference', async () => {
    const dir = await tempDir();
    const first = path.join(dir, 'a.png');
    const second = path.join(dir, 'b.png');
    await writeFile(first, await solidPng(60, 40));
    await writeFile(second, await solidPng(60, 40, { r: 10, g: 200, b: 90, a: 255 }));
    const sheet = await comparePictures({
        files: [first, second], output: path.join(dir, 'sheet.png'), cwd: dir, labels: true,
    });
    assert.ok(sheet.rel.endsWith('sheet.png'));
    assert.equal(sheet.items.length, 2);
    assert.equal(sheet.engine, 'sharp');
    const info = await pictureInfo({ input: sheet.rel, cwd: dir });
    assert.equal(info.width, sheet.width);
    const both = await comparePictures({
        files: [first, second], output: path.join(dir, 'both.png'), mode: 'both', cwd: dir,
    });
    assert.ok(both.diff);
    assert.ok(both.diff.similarity < 100);
    assert.ok(both.diff.rel.endsWith('both-diff.png'));
});

test('the compare refuses a single picture', async () => {
    const dir = await tempDir();
    await assert.rejects(
        comparePictures({ files: ['a.png'], output: path.join(dir, 'sheet.png'), cwd: dir }),
        /from 2 to 12/,
    );
});

test('the info of a picture reads the frame and the weight', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'a.png');
    await writeFile(input, await solidPng(12, 8));
    const info = await pictureInfo({ input, cwd: dir });
    assert.equal(info.width, 12);
    assert.equal(info.height, 8);
    assert.equal(info.format, 'png');
    assert.ok(info.bytes > 0);
});

test('the sink writes one file per result', async () => {
    const dir = await tempDir();
    const sink = createImageSink({ target: dir, format: 'png', prefix: 'pic' });
    const first = await sink.saveFinal('one', Buffer.from('aaa'));
    const second = await sink.saveFinal('two', Buffer.from('bbb'));
    assert.ok(first.file.endsWith('.png'));
    assert.notEqual(first.file, second.file);
    assert.equal(sink.files.length, 2);
    assert.equal((await readdir(dir)).length, 2);
});

test('a late partial does not replace the final picture', async () => {
    const dir = await tempDir();
    const sink = createImageSink({ target: dir, format: 'png', prefix: 'pic' });
    const final = await sink.saveFinal('one', Buffer.from('final'));
    const late = await sink.savePartial('one', Buffer.from('partial'));
    assert.equal(late, null);
    assert.equal(await readFile(final.file, 'utf8'), 'final');
});

test('the sink takes an explicit file for the first picture', async () => {
    const dir = await tempDir();
    const sink = createImageSink({ target: path.join(dir, 'out.png'), format: 'png' });
    const first = await sink.saveFinal('one', Buffer.from('aaa'));
    const second = await sink.saveFinal('two', Buffer.from('bbb'));
    assert.equal(first.file, path.join(dir, 'out.png'));
    assert.ok(second.file.endsWith('out-2.png'));
});
