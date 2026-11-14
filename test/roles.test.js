/**
 * @file test/roles.test.js
 * @module test/roles
 * @purpose The roles and the stages of the agent layer: the planner builds a strategy, the
 *          corrector finds the mismatch of a frame, the learner reads the notes of the past
 *          runs, the decorator writes an SVG and a CSS rule.
 * @depends node:test, node:fs/promises, node:os, node:path, roles/*, agent/*, stages/*
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeRgba } from '../src/image/raster.js';
import { cloneDefaults } from '../src/config/defaults.js';
import { defaultHome, notesDir } from '../src/config/paths.js';
import { PLANNER_SCHEMA, CORRECTOR_SCHEMA, validateAgainst } from '../src/agent/schemas.js';
import { parseJsonAnswer } from '../src/agent/ask.js';
import {
    defaultStrategy,
    normalizeStrategy,
    planStrategy,
} from '../src/roles/planner.js';
import {
    checkResult,
    decideRetry,
    judgeResult,
} from '../src/roles/corrector.js';
import {
    readNotes,
    summarizeNotes,
    suggestStrategy,
    writeNote,
} from '../src/roles/learner.js';
import {
    buildDecoration,
    chooseDecorationKind,
    decorationName,
    decorationPath,
    parseDecoration,
} from '../src/roles/decorator.js';
import { assetUse, processAssets } from '../src/roles/processor.js';
import { checkDocument } from '../src/roles/vectorizer.js';
import { runCropStage } from '../src/stages/crop.js';
import { runPaddingStage, cutPadding } from '../src/stages/padding.js';
import { runAlignmentStage, targetFrame } from '../src/stages/alignment.js';
import { runPipeline, pipelineReport } from '../src/agent/pipeline.js';

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-roles-'));
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
 * A client that answers a role with the JSON it was promised.
 * @param {object} answer
 * @returns {object}
 */
function fakeClient(answer) {
    return {
        responses: {
            async create() {
                return { output_text: JSON.stringify(answer) };
            },
            text(response) {
                return response.output_text ?? '';
            },
        },
        images: {
            async generate() {
                throw new Error('the network is not there');
            },
            async edit() {
                throw new Error('the network is not there');
            },
        },
    };
}

test('the strategy of the planner holds the promised shape', () => {
    const strategy = {
        purpose: 'remove_background',
        size: '1024x1024',
        resolution: '2K',
        format: 'png',
        background: 'transparent',
        alphaMode: 'auto',
        crop: null,
        pad: null,
        vectorize: false,
        rationale: 'the subject has to be cut out',
    };
    const check = validateAgainst(PLANNER_SCHEMA, strategy);
    assert.equal(check.ok, true, check.errors.join('; '));
});

test('a broken answer of a role is named', () => {
    const check = validateAgainst(CORRECTOR_SCHEMA, { ok: true, issues: [], notes: [] });
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /retry/);
});

test('the answer of a model is read out of a fence', () => {
    assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonAnswer('Here it is: {"a":2} done'), { a: 2 });
    assert.equal(parseJsonAnswer('no json here'), null);
});

test('the planner builds a strategy out of the answer of the model', async () => {
    const client = fakeClient({
        purpose: 'edit',
        size: '800x600',
        resolution: null,
        format: 'png',
        background: 'opaque',
        alphaMode: 'off',
        crop: { x: 1, y: 2, width: 3, height: 4, trim: false },
        pad: null,
        vectorize: false,
        rationale: 'the picture has to keep its frame',
    });
    const result = await planStrategy({ client, config: cloneDefaults(), task: 'make a cover' });
    assert.equal(result.source, 'model');
    assert.equal(result.strategy.purpose, 'edit');
    assert.equal(result.strategy.size, '800x600');
    assert.equal(result.strategy.crop.width, 3);
});

test('a nonsense answer of the planner is repaired', () => {
    const strategy = normalizeStrategy({
        purpose: 'nonsense',
        size: 'huge',
        format: 'gif',
        background: 'sparkles',
        alphaMode: 'magic',
        crop: 'no',
    });
    const base = defaultStrategy();
    assert.equal(strategy.purpose, base.purpose);
    assert.equal(strategy.size, null);
    assert.equal(strategy.format, base.format);
    assert.equal(strategy.background, base.background);
    assert.equal(strategy.alphaMode, base.alphaMode);
    assert.equal(strategy.crop, null);
});

test('a run without a model still has a strategy', async () => {
    const result = await planStrategy({ client: null, config: cloneDefaults(), task: 'a cat' });
    assert.equal(result.source, 'default');
    assert.equal(result.strategy.purpose, 'generate');
    assert.ok(result.errors.length);
});

test('the planner does not swallow the answer of the batch', async () => {
    const client = {
        responses: {
            async create() {
                const error = new Error('The batch batch-1 was submitted.');
                error.code = 'BATCH_SUBMITTED';
                throw error;
            },
            text(response) {
                return response.output_text ?? '';
            },
        },
    };
    await assert.rejects(
        async () => await planStrategy({ client, config: cloneDefaults(), task: 'a cat' }),
        (error) => {
            assert.equal(error.code, 'BATCH_SUBMITTED');
            return true;
        },
    );
});

test('the corrector finds the mismatch of a frame', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(40, 20));
    const check = await checkResult({
        file: 'a.png',
        plan: { size: '100x100', background: 'auto', alphaMode: 'off' },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.equal(check.issues.length, 1);
    assert.equal(check.issues[0].kind, 'frame');
    assert.match(check.issues[0].detail, /40x20/);
});

test('the corrector names the missing transparency', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(20, 20));
    const check = await checkResult({
        file: 'a.png',
        plan: { size: '20x20', background: 'transparent', alphaMode: 'auto' },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.ok(check.issues.some((issue) => issue.kind === 'alpha'));
});

test('the corrector keeps quiet about a result that holds', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(20, 20));
    const check = await checkResult({
        file: 'a.png',
        plan: { size: '20x20', background: 'auto', alphaMode: 'off' },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.equal(check.issues.length, 0);
});

test('the verdict of the model is read', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(20, 20));
    const client = fakeClient({
        ok: false,
        issues: [{ kind: 'artifact', detail: 'the hand has six fingers' }],
        retry: { purpose: null, size: null, alphaMode: null, model: null },
        notes: ['the subject is warped'],
    });
    const verdict = await judgeResult({ client, config: cloneDefaults(), file: 'a.png', cwd: dir });
    assert.equal(verdict.issues.length, 1);
    assert.equal(verdict.issues[0].kind, 'artifact');
});

test('the decision of the retry follows the trouble', () => {
    assert.equal(decideRetry({ issues: [] }).retry, false);
    const frame = decideRetry({
        issues: [{ kind: 'frame', detail: 'wrong' }],
        source: { width: 100, height: 50 },
        attempt: 1,
    });
    assert.equal(frame.retry, true);
    assert.equal(frame.changes.size, '100x50');
    const alpha = decideRetry({
        issues: [{ kind: 'alpha', detail: 'opaque' }],
        plan: { alphaMode: 'auto' },
        attempt: 1,
    });
    assert.equal(alpha.changes.alphaMode, 'key');
    const last = decideRetry({
        issues: [{ kind: 'frame', detail: 'wrong' }],
        source: { width: 100, height: 50 },
        attempt: 2,
        maxAttempts: 2,
    });
    assert.equal(last.retry, false, 'the attempts are over');
});

test('the learner reads the notes of the past runs', async () => {
    const home = await tempDir();
    await writeNote({
        home,
        entry: {
            date: '2026-01-02T10:00:00.000Z',
            task: 'a cover',
            purpose: 'decompose',
            size: '1024x1024',
            model: 'm1',
            alphaMode: 'auto',
            outcome: 'ok',
            notes: [],
        },
    });
    await writeNote({
        home,
        entry: {
            date: '2026-01-03T10:00:00.000Z',
            task: 'a logo',
            purpose: 'decompose',
            size: '1024x1024',
            model: 'm2',
            alphaMode: 'mask',
            outcome: 'issues',
            notes: [],
        },
    });
    const entries = await readNotes({ home });
    assert.equal(entries.length, 2);
    const summary = summarizeNotes(entries);
    assert.equal(summary.total, 2);
    assert.equal(summary.byPurpose.decompose.total, 2);
    assert.equal(summary.byPurpose.decompose.good, 1);
    const suggestion = suggestStrategy(summary);
    assert.equal(suggestion.purpose, 'decompose');
    assert.equal(suggestion.size, '1024x1024');
});

test('a broken note does not break the learner', async () => {
    const home = await tempDir();
    const dir = notesDir(home);
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');
    await writeNote({ home, entry: { date: '2026-01-01T00:00:00.000Z', purpose: 'edit', outcome: 'ok' } });
    const entries = await readNotes({ home });
    assert.equal(entries.length, 1);
});

test('the learner suggests nothing when nothing worked', () => {
    const summary = summarizeNotes([{ purpose: 'edit', outcome: 'issues' }]);
    const suggestion = suggestStrategy(summary);
    assert.equal(suggestion.purpose, null);
});

test('the decorator writes a CSS rule and an SVG file', async () => {
    const dir = await tempDir();
    const css = await buildDecoration({
        client: fakeClient({
            kind: 'css',
            name: 'ribbon',
            content: '.ribbon { color: red; }',
            snippet: '<div class="ribbon"></div>',
            notes: 'the form is geometry',
        }),
        config: cloneDefaults(),
        description: 'a ribbon banner',
    });
    assert.equal(css.kind, 'css');
    assert.equal(css.content, '.ribbon { color: red; }');

    const svg = await buildDecoration({
        client: fakeClient({
            kind: 'svg',
            name: 'emblem',
            content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
            snippet: '<img src="assets/decor/emblem.svg">',
            notes: 'the contour is complex',
        }),
        config: cloneDefaults(),
        description: 'a heraldic emblem',
    });
    assert.equal(svg.kind, 'svg');
    assert.match(svg.content, /<svg/);

    assert.equal(decorationPath('css', 'ribbon'), 'styles/decor/ribbon.css');
    assert.equal(decorationPath('svg', 'emblem'), 'assets/decor/emblem.svg');
    assert.equal(decorationName('a heraldic emblem'), 'a-heraldic-emblem');
});

test('the decorator chooses the technique by the form', () => {
    assert.equal(chooseDecorationKind('a neon glow around a divider'), 'css');
    assert.equal(chooseDecorationKind('a heraldic emblem of a lion'), 'svg');
});

test('a document that does not open is not a document', async () => {
    assert.equal((await checkDocument({ bytes: Buffer.from('<svg viewBox="0 0 1 1"></svg>') })).ok, true);
    assert.equal((await checkDocument({ bytes: Buffer.from('not a picture') })).ok, false);
    assert.equal((await checkDocument({ bytes: Buffer.alloc(0) })).ok, false);
});

test('the stage of the crop brings the source to the working form', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(100, 80));
    const result = await runCropStage({
        sources: ['a.png'],
        plan: { crop: { x: 10, y: 10, width: 30, height: 20, trim: false } },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.equal(result.changed, true);
    assert.equal(result.sources[0].width, 30);
    assert.equal(result.sources[0].height, 20);
});

test('the stage of the padding extends the canvas without scaling', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(40, 30));
    const result = await runPaddingStage({
        sources: ['a.png'],
        plan: { pad: { width: 100, height: 80, color: 'transparent' } },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.equal(result.changed, true);
    assert.equal(result.sources[0].width, 100);
    assert.equal(result.sources[0].height, 80);
    const info = await import('../src/image/raster.js');
    const meta = await info.rasterInfo(path.join(dir, result.sources[0].path), { cwd: dir });
    assert.equal(meta.width, 100, 'the canvas grew');
    assert.equal(meta.height, 80);
});

test('the padding is cut off the answer', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(100, 80));
    const cut = await cutPadding({ file: 'a.png', padding: { width: 60, height: 40 }, cwd: dir });
    assert.equal(cut.cut, true);
    const info = await import('../src/image/raster.js');
    const meta = await info.rasterInfo(path.join(dir, 'a.png'), { cwd: dir });
    assert.equal(meta.width, 40);
    assert.equal(meta.height, 40);
});

test('the stage of the frame brings the answer to the frame that was asked for', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(40, 20));
    const result = await runAlignmentStage({
        file: 'a.png',
        frame: { width: 100, height: 50 },
        cwd: dir,
        config: cloneDefaults(),
    });
    assert.equal(result.changed, true);
    assert.equal(result.width, 100);
    assert.equal(result.height, 50);
});

test('the frame of the plan wins over the frame of the source', () => {
    assert.deepEqual(
        targetFrame({ plan: { size: '640x480' }, source: { width: 100, height: 50 } }),
        { width: 640, height: 480 },
    );
    assert.deepEqual(
        targetFrame({ plan: {}, source: { width: 100, height: 50 } }),
        { width: 100, height: 50 },
    );
    assert.equal(targetFrame({ plan: {}, source: null }), null);
});

test('the use of an asset is told by the purpose', () => {
    assert.match(assetUse({ purpose: 'remove_background' }, 'raster'), /alpha/);
    assert.match(assetUse({ purpose: 'decompose' }, 'raster'), /reference/);
    assert.match(assetUse({ purpose: 'generate' }, 'svg'), /text file/);
});

test('the processor reports honestly when the model answered nothing', async () => {
    const dir = await tempDir();
    const result = await processAssets({
        client: fakeClient({}),
        config: cloneDefaults(),
        task: 'a cat',
        plan: defaultStrategy(),
        sources: [],
        cwd: dir,
    });
    assert.equal(result.assets.length, 0);
    assert.match(result.summary, /not made/);
});

test('the report of a run holds the strategy and the files', () => {
    const report = pipelineReport({
        state: {
            task: 'a cat',
            strategy: { purpose: 'generate' },
            strategySource: 'model',
            assets: [],
            files: ['out\\a.png'],
            issues: [],
            notes: [],
            summary: 'done',
        },
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.files[0], 'out/a.png');
    assert.equal(report.strategy.purpose, 'generate');
});

test('a run without a network still writes a note', async () => {
    const home = await tempDir();
    const dir = await tempDir();
    const report = await runPipeline({
        client: null,
        config: { ...cloneDefaults(), home },
        task: 'a cat on a roof',
        cwd: dir,
        home,
    });
    assert.equal(report.status, 'failed');
    assert.ok(report.note, 'the note of the run is written');
    const notes = await readNotes({ home });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].task, 'a cat on a roof');
    assert.ok(notes[0].purpose);
});

test('the home of the configuration is the home of the CLI', () => {
    assert.match(defaultHome({ AI_IMAGE_HOME: 'C:\\tmp\\home' }), /home/);
});
