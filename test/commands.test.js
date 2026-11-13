/**
 * @file test/commands.test.js
 * @module test/commands
 * @purpose The commands of the CLI: the local operations, the report of `info`, the dry run of the
 *          generation, and the exit codes of the failures.
 * @depends node:test, node:fs/promises, node:os, node:path, commands/*, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeRgba } from '../src/image/raster.js';
import { cloneDefaults } from '../src/config/defaults.js';
import { run as runCrop } from '../src/commands/crop.js';
import { run as runFit } from '../src/commands/fit.js';
import { run as runInfo } from '../src/commands/info.js';
import { run as runGenerate } from '../src/commands/generate.js';
import { run as runCompare } from '../src/commands/compare.js';
import { run as runSplit } from '../src/commands/split.js';
import { run as runTrim } from '../src/commands/trim.js';
import { run as runPad } from '../src/commands/pad.js';
import { run as runResize } from '../src/commands/resize.js';
import {
    chooseDecorationKind,
    decorationName,
    parseDecoration,
} from '../src/roles/decorator.js';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-commands-'));
}

/**
 * A picture of a solid color.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function solidPng(width, height) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 200;
        data[i + 1] = 30;
        data[i + 2] = 40;
        data[i + 3] = 255;
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

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
            line(kind, text) {
                lines.push(`${kind}: ${text}`);
            },
            json(payload) {
                json.push(payload);
            },
            event() {},
        },
    };
}

/**
 * The options of a command, as the parser would build them.
 * @param {object} extra
 * @returns {object}
 */
function options(extra = {}) {
    return {
        command: '',
        positionals: [],
        configPath: null,
        out: null,
        outDir: null,
        model: null,
        imageModel: null,
        purpose: null,
        size: null,
        resolution: null,
        format: null,
        background: null,
        count: 1,
        references: [],
        image: null,
        engine: null,
        alphaMode: null,
        x: null,
        y: null,
        width: null,
        height: null,
        trim: false,
        fuzz: null,
        transparentOnly: false,
        rows: null,
        cols: null,
        mode: null,
        color: null,
        layout: null,
        frame: null,
        gap: null,
        labels: false,
        maxSide: null,
        factor: null,
        kind: null,
        json: false,
        dryRun: false,
        verbose: false,
        help: false,
        version: false,
        ...extra,
    };
}

test('the info command tells the frame, the weight and the purpose', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(40, 20));
    const { renderer, json } = fakeRenderer();
    const code = await runInfo({
        options: options({ positionals: ['a.png'], json: true }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json.length, 1);
    assert.equal(json[0].width, 40);
    assert.equal(json[0].height, 20);
    assert.equal(json[0].alpha.opaque, true);
    assert.ok(json[0].purpose.name);
});

test('the info command asks for the picture', async () => {
    const dir = await tempDir();
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runInfo({ options: options(), renderer, config: cloneDefaults(), cwd: dir }),
        /Give the picture/,
    );
});

test('the crop command cuts the box and writes the result', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(100, 80));
    const { renderer, json } = fakeRenderer();
    const code = await runCrop({
        options: options({
            positionals: ['a.png'], x: '10', y: '10', width: '30', height: '40', json: true,
        }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json[0].width, 30);
    assert.equal(json[0].files[0], 'a-crop.png');
    assert.ok((await readFile(path.join(dir, 'a-crop.png'))).length > 0);
});

test('the crop command refuses a box without a size', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(10, 10));
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runCrop({ options: options({ positionals: ['a.png'] }), renderer, config: cloneDefaults(), cwd: dir }),
        /width and the height/,
    );
});

test('the pad, fit and resize commands change the frame', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(200, 100));
    const { renderer, json } = fakeRenderer();
    const config = cloneDefaults();

    await runPad({
        options: options({ positionals: ['a.png'], width: '400', height: '300', json: true }),
        renderer, config, cwd: dir,
    });
    assert.equal(json.at(-1).width, 400);

    await runFit({
        options: options({ positionals: ['a.png'], width: '50', height: '50', mode: 'contain', json: true }),
        renderer, config, cwd: dir,
    });
    assert.equal(json.at(-1).width, 50);

    await runResize({
        options: options({ positionals: ['a.png'], width: '100', json: true }),
        renderer, config, cwd: dir,
    });
    assert.equal(json.at(-1).width, 100);
    assert.equal(json.at(-1).height, 50, 'the proportions survive');
});

test('the fit command refuses an unknown mode', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(10, 10));
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runFit({
            options: options({ positionals: ['a.png'], width: '10', height: '10', mode: 'nope' }),
            renderer,
            config: cloneDefaults(),
            cwd: dir,
        }),
        /fit mode/,
    );
});

test('the trim and split commands report what they did', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(60, 60));
    const { renderer, json } = fakeRenderer();
    const config = cloneDefaults();
    await runTrim({
        options: options({ positionals: ['a.png'], json: true }), renderer, config, cwd: dir,
    });
    assert.equal(json.at(-1).command, 'trim');
    await runSplit({
        options: options({ positionals: ['a.png'], rows: '2', cols: '3', json: true }),
        renderer, config, cwd: dir,
    });
    assert.equal(json.at(-1).files.length, 6);
});

test('the compare command writes the sheet and the difference', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(30, 30));
    const other = Buffer.alloc(30 * 30 * 4);
    for (let i = 0; i < other.length; i += 4) {
        other[i] = 10;
        other[i + 1] = 200;
        other[i + 2] = 90;
        other[i + 3] = 255;
    }
    await writeFile(path.join(dir, 'b.png'), await encodeRgba({ width: 30, height: 30, data: other }, { format: 'png' }));
    const { renderer, json } = fakeRenderer();
    const code = await runCompare({
        options: options({ positionals: ['a.png', 'b.png'], mode: 'both', json: true }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json[0].files.length, 2);
    assert.ok(json[0].diff.similarity < 100);
});

test('the generation without a network call is a dry run', async () => {
    const dir = await tempDir();
    const { renderer, json } = fakeRenderer();
    const code = await runGenerate({
        options: options({ positionals: ['a red bicycle'], dryRun: true, json: true }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json[0].type, 'plan');
    assert.equal(json[0].prompt, 'a red bicycle');
    assert.ok(json[0].model);
});

test('the generation refuses an unknown purpose', async () => {
    const dir = await tempDir();
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runGenerate({
            options: options({ positionals: ['a cat'], purpose: 'nonsense' }),
            renderer,
            config: cloneDefaults(),
            cwd: dir,
        }),
        /Unknown purpose/,
    );
});

test('the generation without a prompt is an error of the arguments', async () => {
    const dir = await tempDir();
    const { renderer } = fakeRenderer();
    await assert.rejects(
        runGenerate({ options: options(), renderer, config: cloneDefaults(), cwd: dir }),
        /Give a prompt/,
    );
});

test('the decorator chooses the technique by the form', () => {
    assert.equal(chooseDecorationKind('a neon glow around a divider'), 'css');
    assert.equal(chooseDecorationKind('a heraldic emblem of a lion'), 'svg');
    assert.equal(chooseDecorationKind('a logo of the company'), 'svg');
    assert.equal(chooseDecorationKind('something of it'), 'css');
    assert.equal(chooseDecorationKind('a logo of the company', 'css'), 'css', 'the caller may insist');
});

test('the decorator names the file', () => {
    assert.equal(decorationName('a gold ribbon banner'), 'a-gold-ribbon-banner');
    assert.equal(decorationName('a gold ribbon banner', 'Ribbon Banner'), 'ribbon-banner');
    assert.equal(decorationName(''), 'decoration');
});

test('the decorator reads the answer of the model', () => {
    const parsed = parseDecoration('{"kind":"svg","name":"ornament","content":"<svg/>","snippet":"<img>","notes":"ok"}', 'svg');
    assert.equal(parsed.kind, 'svg');
    assert.equal(parsed.name, 'ornament');
    assert.equal(parsed.content, '<svg/>');
    const loose = parseDecoration('```\n<svg viewBox="0 0 1 1"></svg>\n```', 'svg');
    assert.match(loose.content, /<svg/);
    const css = parseDecoration('.a { color: red; }', 'css');
    assert.equal(css.content, '.a { color: red; }');
});
