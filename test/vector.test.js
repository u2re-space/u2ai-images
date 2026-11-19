/**
 * @file test/vector.test.js
 * @module test/vector
 * @purpose Tests of the vector work: the model of the house that draws a document, and the
 *          generation of a vector graphic.
 * @depends node:test, node:fs/promises, node:os, node:path, model/vector, commands/generate,
 *          commands/vectorize
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneDefaults } from '../src/config/defaults.js';
import { DEFAULT_VECTOR_MODEL } from '../src/model/profiles.js';
import { VECTOR_PROMPT, vectorModelFor } from '../src/model/vector.js';
import { run as runGenerate } from '../src/commands/generate.js';
import { run as runVectorize } from '../src/commands/vectorize.js';

/** A renderer that keeps what it was told. */
function fakeRenderer() {
    const json = [];
    return {
        json,
        renderer: {
            line() {},
            json(payload) { json.push(payload); },
            event() {},
            plan() {},
            progress() {},
            files() {},
        },
    };
}

/** The options of a command, as the parser would build them. */
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
        subject: null,
        attempts: null,
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
        batch: false,
        batchFetch: false,
        verbose: false,
        help: false,
        version: false,
        ...extra,
    };
}

test('the house draws a vector document with the Sunburst of OpenAI', () => {
    const config = cloneDefaults();
    assert.equal(vectorModelFor(config), DEFAULT_VECTOR_MODEL);
    assert.equal(DEFAULT_VECTOR_MODEL, 'openai/gpt-image-2.6-sunburst');
});

test('the pin of the config wins over the model of the house', () => {
    const config = cloneDefaults();
    config.vectorModel = 'vendor/other-vector';
    assert.equal(vectorModelFor(config), 'vendor/other-vector');
});

test('a house without a list of models still draws with the Sunburst', () => {
    assert.equal(vectorModelFor({}), DEFAULT_VECTOR_MODEL);
    assert.equal(vectorModelFor(null), DEFAULT_VECTOR_MODEL);
});

test('the generation of a vector graphic asks the vector model and asks for a document', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-vector-'));
    const { renderer, json } = fakeRenderer();
    const code = await runGenerate({
        options: options({ positionals: ['a fox badge'], format: 'svg', dryRun: true, json: true }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json[0].type, 'plan');
    assert.equal(json[0].model, DEFAULT_VECTOR_MODEL);
    assert.equal(json[0].format, 'svg');
    assert.match(json[0].prompt, /a fox badge/);
    assert.match(json[0].prompt, /vector SVG document/);
    assert.ok(json[0].prompt.includes(VECTOR_PROMPT));
});

test('the tracing of a picture asks the vector model too', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-vector-'));
    const { renderer, json } = fakeRenderer();
    const code = await runVectorize({
        options: options({ positionals: ['logo.png'], dryRun: true, json: true }),
        renderer,
        config: cloneDefaults(),
        cwd: dir,
    });
    assert.equal(code, 0);
    assert.equal(json[0].model, DEFAULT_VECTOR_MODEL);
});
