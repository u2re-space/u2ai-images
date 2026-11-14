/**
 * @file test/rotation.test.js
 * @module test/rotation
 * @purpose The rotation over the backends: the classification of a refusal, the memory of the
 *          pool about the hosts, and the answer of a run that every host refused.
 * @depends node:test, node:http, openai/rotation, openai/fallback, openai/client
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { FAILURE, aggregateFailure, classifyFailure, createBackendPool } from '../src/openai/rotation.js';
import { isModelUnknown, isRouteUnsupported } from '../src/openai/fallback.js';
import { createClient } from '../src/openai/client.js';

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
            requests.push({ method: req.method, url: req.url, body });
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

/** The configuration of a test: the hosts of the text route. */
const configFor = (backends, extra = {}) => ({
    model: 'test/model',
    apiKey: 'test-key',
    timeoutMs: 5_000,
    backends,
    imagesBackends: backends,
    image: { sizeHint: 'auto', div16: 'auto', padToMin: 'auto' },
    fallback: { enabled: true, models: {} },
    ...extra,
});

test('a refusal is classified by what it says', () => {
    assert.equal(classifyFailure({ status: 402, message: 'Insufficient balance' }).kind, FAILURE.NO_CREDIT);
    assert.equal(classifyFailure({ status: 400, message: 'Insufficient balance' }).kind, FAILURE.NO_CREDIT);
    assert.equal(classifyFailure({ status: 401, message: 'Invalid API key' }).kind, FAILURE.UNAUTHORIZED);
    assert.equal(classifyFailure({ status: 404, message: 'model not found' }).kind, FAILURE.MODEL);
    assert.equal(classifyFailure({ status: 404, message: 'not found in this api' }).kind, FAILURE.ROUTE);
    assert.equal(classifyFailure({ status: 429, message: 'too many requests' }).kind, FAILURE.RATE);
    assert.equal(classifyFailure({ status: 500, message: 'boom' }).kind, FAILURE.SERVER);
    assert.equal(classifyFailure({ status: 400, message: 'bad request' }).kind, FAILURE.REQUEST);
    assert.equal(classifyFailure({ code: 'NETWORK_ERROR', message: 'fetch failed' }).kind, FAILURE.NETWORK);
    assert.equal(classifyFailure({ name: 'AbortError', message: 'aborted' }).kind, FAILURE.ABORT);
});

test('the pool remembers the hosts without money and without a key', () => {
    const pool = createBackendPool({
        backends: [{ baseURL: 'https://a/v1' }, { baseURL: 'https://b/v1' }, { baseURL: 'https://c/v1' }],
    });
    pool.note({ backend: pool.all()[0], error: { status: 402, message: 'Insufficient balance' } });
    pool.note({ backend: pool.all()[1], error: { status: 401, message: 'Invalid API key' } });
    const left = pool.candidates().map((backend) => backend.baseURL);
    assert.deepEqual(left, ['https://c/v1'], 'the hosts that refused are not asked again');
});

test('the pool remembers the models and the routes a host does not know', () => {
    const pool = createBackendPool({ backends: [{ baseURL: 'https://a/v1' }] });
    const backend = pool.all()[0];
    pool.note({ backend, model: 'm/1', error: { status: 404, message: 'model not found' } });
    pool.note({ backend, route: 'images', error: { status: 404, message: 'not found in this api' } });
    assert.deepEqual(pool.candidates({ model: 'm/1' }), [], 'the host does not know the model');
    assert.deepEqual(pool.candidates({ route: 'images' }), [], 'the host does not serve the route');
    assert.equal(pool.candidates({ model: 'm/2' }).length, 1, 'another model is still asked');
});

test('the host that answered is asked first from then on', () => {
    const pool = createBackendPool({ backends: [{ baseURL: 'https://a/v1' }, { baseURL: 'https://b/v1' }] });
    const second = pool.all()[1];
    pool.promote(second);
    assert.equal(pool.all()[0].baseURL, 'https://b/v1');
});

test('the refusal of a whole rotation keeps the attempts', () => {
    const error = aggregateFailure([
        { backend: 'https://a/v1', kind: FAILURE.NO_CREDIT, status: 402, message: 'Insufficient balance' },
        { backend: 'https://b/v1', kind: FAILURE.MODEL, status: 404, message: 'model not found' },
    ]);
    assert.equal(error.code, 'ALL_BACKENDS_FAILED');
    assert.equal(error.details.attempts.length, 2);
    assert.match(error.message, /model not found/, 'the reason that matters comes first');
});

test('the decisions are made by all the attempts, not by the last one', () => {
    const error = aggregateFailure([
        { backend: 'https://a/v1', kind: FAILURE.MODEL, status: 404, message: 'model not found' },
        { backend: 'https://b/v1', kind: FAILURE.NO_CREDIT, status: 402, message: 'Insufficient balance' },
    ]);
    assert.equal(isModelUnknown(error), true, 'a host that does not know the model asks for the next one');
    assert.equal(isRouteUnsupported(error), false, 'a missing model is not a missing route');
});

test('a host without money is not asked again, and the next host answers', async () => {
    const poor = await mockHost(() => ({ status: 402, json: { error: { message: 'Insufficient balance' } } }));
    const rich = await mockHost(() => ({ json: { output_text: 'hello' } }));
    const client = await createClient({
        config: configFor([{ baseURL: poor.baseURL }, { baseURL: rich.baseURL }]),
    });
    try {
        const first = await client.responses.create({ input: 'hi' });
        assert.equal(first.output_text, 'hello');
        assert.equal(poor.requests.length, 1);
        const second = await client.responses.create({ input: 'hi again' });
        assert.equal(second.output_text, 'hello');
        assert.equal(poor.requests.length, 1, 'the host without money is not asked again');
        assert.equal(rich.requests.length, 2);
    } finally {
        client.close();
        await poor.close();
        await rich.close();
    }
});

test('the run that every host refused says what every host said', async () => {
    const poor = await mockHost(() => ({ status: 402, json: { error: { message: 'Insufficient balance' } } }));
    const rude = await mockHost(() => ({ status: 401, json: { error: { message: 'Invalid API key' } } }));
    const client = await createClient({
        config: configFor([{ baseURL: poor.baseURL }, { baseURL: rude.baseURL }]),
    });
    try {
        await assert.rejects(
            async () => await client.responses.create({ input: 'hi' }),
            (error) => {
                assert.equal(error.code, 'ALL_BACKENDS_FAILED');
                assert.equal(error.details.attempts.length, 2);
                assert.deepEqual(
                    error.details.attempts.map((item) => item.kind).sort(),
                    [FAILURE.NO_CREDIT, FAILURE.UNAUTHORIZED],
                );
                return true;
            },
        );
    } finally {
        client.close();
        await poor.close();
        await rude.close();
    }
});

test('a host that does not know the model is followed by the next model of the chain', async () => {
    const seen = [];
    const host = await mockHost((req, body) => {
        const model = JSON.parse(body).model;
        seen.push(model);
        if (model === 'test/model') {
            return { status: 404, json: { error: { message: 'model not found' } } };
        }
        return { json: { output_text: 'answered' } };
    });
    const client = await createClient({
        config: configFor([{ baseURL: host.baseURL }], {
            fallback: { enabled: true, models: { 'test/model': ['test/other'] } },
        }),
    });
    try {
        const answer = await client.responses.create({ input: 'hi' });
        assert.equal(answer.output_text, 'answered');
        assert.deepEqual(seen, ['test/model', 'test/other']);
    } finally {
        client.close();
        await host.close();
    }
});
