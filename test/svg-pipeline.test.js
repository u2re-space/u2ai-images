/**
 * @file test/svg-pipeline.test.js
 * @module test/svg-pipeline
 * @purpose The stages of the vector run in the pipeline: the tracing, the edit of the
 *          document and the polish of it.
 * @depends node:test, node:fs/promises, roles/processor, stages/svg-edit, stages/svg-polish
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processAssets } from '../src/roles/processor.js';

const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

const MESSY_SVG = '<svg xmlns="http://www.w3.org/2000/svg">\n'
    + '  <!-- a note -->\n'
    + '  <g>\n'
    + '  </g>\n'
    + '  <path d="M1 1 L2 2"/>\n'
    + '</svg>';

async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-svg-pipe-'));
}

/**
 * A client that draws the document and edits it as code.
 * @param {string[]} calls the calls the client saw
 * @returns {object}
 */
function pipelineClient(calls) {
    return {
        images: {
            async edit(request) {
                calls.push('image');
                return { payloads: [TINY_PNG.toString('base64')], model: 'offline-image-model' };
            },
            async vectorize(request) {
                calls.push('vectorize');
                return { images: [{ bytes: Buffer.from(MESSY_SVG) }], model: 'offline-vector-model' };
            },
        },
        responses: {
            async create(body) {
                calls.push('edit-svg');
                return {
                    status: 'completed',
                    output_text: JSON.stringify({
                        edits: [{
                            kind: 'replace',
                            find: '<svg xmlns="http://www.w3.org/2000/svg">',
                            replace: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img">',
                        }],
                        notes: [],
                    }),
                };
            },
            text(answer) { return answer?.output_text ?? ''; },
        },
    };
}

test('the vector runs the edit of the document and the polish of it', async () => {
    const cwd = await tempDir();
    const source = path.join(cwd, 'logo.png');
    await writeFile(source, TINY_PNG);
    const calls = [];

    const result = await processAssets({
        client: pipelineClient(calls),
        config: { image: { vectorMaxColors: 256 }, limits: {}, roles: {} },
        task: 'a logo',
        plan: { vectorize: true, size: '24x24', purpose: 'generate' },
        sources: [source],
        cwd,
        withModel: false,
        maxAttempts: 1,
    });

    // The picture is made, the document is drawn, and the document is edited.
    assert.deepEqual(calls, ['image', 'vectorize', 'edit-svg']);

    // The document is on the disk, and it is the edited and the tidied one.
    const assets = await readdir(path.join(cwd, '.ai', 'assets'));
    const svgName = assets.find((name) => name.endsWith('.svg'));
    assert.ok(svgName, 'the document was written');
    const document = await readFile(path.join(cwd, '.ai', 'assets', svgName), 'utf8');
    // The edit of the text model is in it: the frame and the role.
    assert.match(document, /viewBox="0 0 24 24"/);
    assert.match(document, /role="img"/);
    // The polish is in it: no comment, no empty group, no whitespace between the tags.
    assert.doesNotMatch(document, /<!-- a note -->/);
    assert.doesNotMatch(document, /<g><\/g>/);
    // The drawing is the drawing.
    assert.match(document, /d="M1 1 L2 2"/);
    assert.ok(result.assets.some((asset) => asset.format === 'svg'));
});
