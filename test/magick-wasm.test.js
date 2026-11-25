import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeRgba, decodeRgba } from '../src/image/raster.js';
import {
    wasmAvailable,
    wasmDecode,
    wasmEncode,
    wasmScale,
    wasmMetadata,
    wasmTrim,
    wasmPaletteStats,
    wasmColorCount,
    wasmCompare,
    wasmVersion,
} from '../src/image/magick-wasm.js';

/** A solid picture of one color. */
function solidPng(width, height, color = [255, 0, 0, 255]) {
    const data = Buffer.alloc(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = color[0];
        data[index + 1] = color[1];
        data[index + 2] = color[2];
        data[index + 3] = color[3];
    }
    return encodeRgba({ width, height, data }, { format: 'png' });
}

test('the wasm of ImageMagick answers with its version', async () => {
    const ready = await wasmAvailable();
    assert.equal(ready, true, 'the optional dependency of the package must be installed');
    const version = await wasmVersion();
    assert.match(version, /ImageMagick/);
});

test('the wasm decodes a picture into raw RGBA and encodes it back', async () => {
    const png = await solidPng(4, 3);
    const frame = await wasmDecode(png);
    assert.ok(frame, 'the wasm must decode the picture');
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 3);
    assert.equal(frame.data.byteLength, 4 * 3 * 4);
    // The pixels are the ones that were written.
    assert.deepEqual([...frame.data.subarray(0, 4)], [255, 0, 0, 255]);

    const back = await wasmEncode(frame, { format: 'png' });
    assert.ok(back, 'the wasm must encode the picture');
    assert.equal(back[0], 0x89, 'the result is a PNG');
    // The picture survives the round trip.
    const again = await wasmDecode(back);
    assert.equal(again.width, 4);
    assert.equal(again.height, 3);
    assert.deepEqual([...again.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test('the wasm reads the metadata of a picture', async () => {
    const png = await solidPng(8, 5);
    const meta = await wasmMetadata(png);
    assert.ok(meta);
    assert.equal(meta.width, 8);
    assert.equal(meta.height, 5);
    assert.equal(meta.format, 'png');
});

test('the wasm scales a frame', async () => {
    const png = await solidPng(4, 4);
    const frame = await wasmDecode(png);
    const scaled = await wasmScale(frame, 16, 16);
    assert.ok(scaled);
    assert.equal(scaled.width, 16);
    assert.equal(scaled.height, 16);
    assert.equal(scaled.data.byteLength, 16 * 16 * 4);
});

test('the wasm trims the uniform edges of a picture', async () => {
    // A picture with a border of one color and a block of another: the trim cuts the
    // border off and leaves the block.
    const width = 20;
    const height = 20;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const at = (y * width + x) * 4;
            const inside = x >= 5 && x < 15 && y >= 5 && y < 15;
            data[at] = inside ? 0 : 255;
            data[at + 1] = 0;
            data[at + 2] = inside ? 255 : 0;
            data[at + 3] = 255;
        }
    }
    const png = await encodeRgba({ width, height, data }, { format: 'png' });

    const trimmed = await wasmTrim(png);
    assert.ok(trimmed);
    // The block is ten pixels wide, and the border is gone.
    assert.equal(trimmed.width, 10);
    assert.equal(trimmed.height, 10);
});

test('the wasm counts the colors of a picture exactly', async () => {
    const png = await solidPng(4, 4);
    const palette = await wasmPaletteStats(png);
    assert.equal(palette.length, 1, 'a picture of one color has one color');
    assert.equal(palette[0].count, 16, 'the color covers every pixel');
    assert.match(palette[0].color, /^#ff0000/);
    assert.equal(await wasmColorCount(png), 1);
});

test('the wasm compares two pictures', async () => {
    const red = await solidPng(4, 4);
    const blue = await solidPng(4, 4, [0, 0, 255, 255]);
    const metrics = await wasmCompare(red, red);
    assert.ok(metrics);
    assert.equal(metrics.rmse, 0, 'a picture is the same as itself');
    const different = await wasmCompare(red, blue);
    assert.ok(different.rmse > 0, 'two different pictures differ');
});

test('the wasm is an engine of the raster layer: the frame it decodes is the frame of the package', async () => {
    const png = await solidPng(6, 4);
    const byWasm = await decodeRgba(png, 'wasm');
    assert.ok(byWasm, 'the wasm must be reachable as an engine');
    assert.equal(byWasm.width, 6);
    assert.equal(byWasm.height, 4);
    assert.equal(byWasm.data.byteLength, 6 * 4 * 4);
});
