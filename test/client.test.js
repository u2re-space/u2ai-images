/**
 * @file test/client.test.js
 * @module test/client
 * @purpose The API client: the rotation over the backends, the images route, the fallback to the
 *          Responses API, the fallback to the next model, the retry with another frame and the
 *          alignment of an arbitrary size.
 * @depends node:test, node:http, openai/client, image/sizing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createClient, planEdit, alignToGrid, buildEditFields, resolveBackends } from '../src/openai/client.js';
import { alignmentPlan } from '../src/image/sizing.js';

const GPT = 'openai/gpt-image-2.6-sunburst';
const RIVERFLOW = 'sourceful/riverflow-v2.6-pro';

/** A 1x1 PNG, enough for the readers of the answers. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A mock host that answers every request with the same handler.
 * @param {(req: object, body: string) => { status?: number, json?: object, text?: string }} handler
 * @returns {Promise<{ baseURL: string, requests: object[], close: Function }>}
 */
async function mockHost(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ method: req.method, url: req.url, body, headers: req.headers });
            let answer;
            try {
                answer = handler(req, body);
            } catch (error) {
                answer = { status: 500, json: { error: { message: error.message } } };
            }
            const status = answer.status ?? 200;
            const payload = answer.text ?? JSON.stringify(answer.json ?? {});
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(payload);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/** The configuration of a test: one backend, no key needed. */
const configFor = (baseURL, extra = {}) => ({
    baseURL,
    apiKey: 'test-key',
    timeoutMs: 5_000,
    retries: 0,
    limits: { retries: 0 },
    backends: [{ baseURL }],
    imagesBackends: [{ baseURL }],
    image: { sizeHint: 'auto', div16: 'auto', padToMin: 'auto' },
    fallback: { enabled: true, models: {} },
    explicit: { top: [], image: [] },
    ...extra,
});

test('the backends of a kind are resolved from the pools', () => {
    const config = {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'k',
        backends: [{ baseURL: 'https://text.example/v1', env: 'TEXT_KEY' }],
        imagesBackends: [{ baseURL: 'https://image.example/v1', env: 'IMAGE_KEY' }],
    };
    const env = { TEXT_KEY: 'a', IMAGE_KEY: 'b' };
    assert.equal(resolveBackends(config, { kind: 'text', env })[0].baseURL, 'https://text.example/v1');
    assert.equal(resolveBackends(config, { kind: 'images', env })[0].baseURL, 'https://image.example/v1');
    assert.equal(resolveBackends(config, { kind: 'images', env: {} })[0].baseURL, 'https://image.example/v1',
        'a pool without a key stays usable');
});

test('a generation asks the images route and reads the payload', async () => {
    const host = await mockHost(() => ({ json: { data: [{ b64_json: TINY_PNG }] } }));
    const client = await createClient({ config: configFor(host.baseURL) });
    try {
        const answer = await client.images.generate({ model: GPT, prompt: 'a lighthouse', size: '1024x1024' });
        assert.equal(answer.route, 'images/generations');
        assert.equal(answer.payloads.length, 1);
        assert.equal(answer.images[0].mime, 'image/png');
        const request = host.requests.at(-1);
        assert.equal(request.url, '/v1/images/generations');
        const body = JSON.parse(request.body);
        assert.equal(body.model, GPT);
        assert.equal(body.prompt, 'a lighthouse');
        assert.equal(body.size, '1024x1024');
    } finally {
        client.close();
        await host.close();
    }
});

test('a host without the images route is asked through the Responses API', async () => {
    const host = await mockHost((req) => {
        if (req.url.endsWith('/images/generations')) {
            return { status: 404, json: { error: { message: 'not found in this api' } } };
        }
        return {
            json: {
                output: [{ type: 'image_generation_call', status: 'completed', result: TINY_PNG }],
            },
        };
    });
    const client = await createClient({ config: configFor(host.baseURL) });
    try {
        const answer = await client.images.generate({ model: GPT, prompt: 'a lighthouse' });
        assert.equal(answer.route, 'responses');
        assert.equal(answer.payloads[0], TINY_PNG);
        const request = host.requests.at(-1);
        assert.equal(request.url, '/v1/responses');
        const body = JSON.parse(request.body);
        assert.deepEqual(body.tool_choice, { type: 'image_generation' });
        assert.equal(body.tools[0].type, 'image_generation');
    } finally {
        client.close();
        await host.close();
    }
});

test('a model the host does not know is followed by the next model of the chain', async () => {
    let seen = [];
    const host = await mockHost((req, body) => {
        seen.push(JSON.parse(body).model);
        if (JSON.parse(body).model === 'broken/model') {
            return { status: 404, json: { error: { message: 'model not found' } } };
        }
        return { json: { data: [{ b64_json: TINY_PNG }] } };
    });
    const config = configFor(host.baseURL, {
        fallback: { enabled: true, models: { 'broken/model': ['good/model'] } },
    });
    const client = await createClient({ config });
    try {
        const answer = await client.images.generate({ model: 'broken/model', prompt: 'a lighthouse' });
        assert.equal(answer.model, 'good/model');
        assert.deepEqual(seen, ['broken/model', 'good/model']);
    } finally {
        client.close();
        await host.close();
    }
});

test('a refused frame is asked again with another frame', async () => {
    const sizes = [];
    const host = await mockHost((req, body) => {
        const parsed = JSON.parse(body);
        sizes.push(parsed.size);
        if (parsed.size === '100x100') {
            return { status: 400, json: { error: { message: 'Invalid size for this model', param: 'size' } } };
        }
        return { json: { data: [{ b64_json: TINY_PNG }] } };
    });
    const client = await createClient({ config: configFor(host.baseURL) });
    try {
        await client.images.generate({ model: GPT, prompt: 'a lighthouse', size: '100x100' });
        assert.deepEqual(sizes, ['100x100', '816x816']);
    } finally {
        client.close();
        await host.close();
    }
});

test('an edit sends a multipart body and the fields of the model', async () => {
    const host = await mockHost(() => ({ json: { data: [{ b64_json: TINY_PNG }] } }));
    const client = await createClient({ config: configFor(host.baseURL) });
    try {
        const bytes = Buffer.from(TINY_PNG, 'base64');
        const answer = await client.images.edit({
            model: GPT,
            prompt: 'make it evening',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes }],
            size: '1024x1024',
        });
        assert.equal(answer.route, 'images/edits');
        const request = host.requests.at(-1);
        assert.match(request.headers['content-type'], /multipart\/form-data/);
        assert.match(request.body, /name="image"; filename="shot\.png"/);
        assert.match(request.body, /name="prompt"\r\n\r\nmake it evening/);
    } finally {
        client.close();
        await host.close();
    }
});

test('the plan of an edit: a legal frame goes as it is', () => {
    const plan = planEdit({ model: GPT, size: '1024x1024', sourceFrame: { width: 1024, height: 1024 } });
    assert.equal(plan.mode, 'direct');
    assert.equal(plan.frame, '1024x1024');
    assert.equal(plan.pad, null);
});

test('the plan of an edit: a frame off the grid is padded into a canvas', () => {
    const plan = planEdit({ model: GPT, size: '1010x1010', sourceFrame: { width: 1010, height: 1010 } });
    assert.equal(plan.mode, 'align');
    assert.equal(plan.pad.width % 16, 0);
    assert.equal(plan.pad.height % 16, 0);
    assert.ok(plan.pad.width >= 1010 && plan.pad.height >= 1010);
});

test('the plan of an edit: a source below the floor of the model is padded up to it', () => {
    const plan = planEdit({ model: GPT, size: null, sourceFrame: { width: 100, height: 100 } });
    assert.equal(plan.mode, 'align');
    assert.ok(plan.pad.width * plan.pad.height >= 655_360, 'the canvas clears the floor of the model');
    assert.ok(plan.pad.width >= 100 && plan.pad.height >= 100);
});

test('the plan of an edit: the padding keeps the content and the answer is cropped back', async () => {
    const calls = [];
    const fakeRaster = {
        padImageBytes: async ({ bytes, targetWidth, targetHeight }) => {
            calls.push({ op: 'pad', targetWidth, targetHeight });
            return { bytes, width: targetWidth, height: targetHeight, originalWidth: 100, originalHeight: 100, padded: true };
        },
        removeImagePadding: async ({ bytes, originalWidth, originalHeight }) => {
            calls.push({ op: 'crop', originalWidth, originalHeight });
            return bytes;
        },
        fitToFrame: async ({ bytes }) => bytes,
    };
    const host = await mockHost(() => ({ json: { data: [{ b64_json: TINY_PNG }] } }));
    const client = await createClient({ config: configFor(host.baseURL), raster: fakeRaster });
    try {
        const bytes = Buffer.from(TINY_PNG, 'base64');
        await client.images.edit({
            model: GPT,
            prompt: 'make it evening',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes }],
        });
        assert.equal(calls[0].op, 'pad');
        assert.equal(calls[1].op, 'crop');
        assert.equal(calls[1].originalWidth, 100);
        const request = host.requests.at(-1);
        assert.match(request.body, /Keep the source artwork at its original scale/);
    } finally {
        client.close();
        await host.close();
    }
});

test('the alignment plan names the three ways of a frame', () => {
    assert.equal(alignmentPlan({ model: GPT, size: '1024x1024' }).mode, 'direct');
    assert.equal(alignmentPlan({ model: GPT, size: '100x100' }).mode, 'align');
    assert.equal(alignmentPlan({ model: GPT, size: '8000x8000' }).mode, 'downscale');
    assert.equal(alignmentPlan({ model: GPT, size: 'auto' }).mode, 'direct');
    assert.equal(alignToGrid({ width: 16, height: 16 }, GPT), null);
    assert.deepEqual(alignToGrid({ width: 17, height: 17 }, GPT), { width: 32, height: 32 });
});

test('the fields of an edit follow the family of the model', () => {
    const raster = buildEditFields({ model: GPT, prompt: 'p', size: '1024x1024', format: 'png' });
    assert.equal(raster.size, '1024x1024');
    assert.equal(raster.output_format, 'png');
    const vector = buildEditFields({ model: GPT, prompt: 'p', size: '1024x1024', vector: true });
    assert.equal(vector.output_format, 'svg');
    assert.deepEqual(vector.svg, { model: 'gpt-6.1-terra' });
    const tier = buildEditFields({ model: RIVERFLOW, prompt: 'p', size: '2K' });
    assert.equal(tier.resolution, '2K');
    assert.equal(tier.size, undefined);
});
