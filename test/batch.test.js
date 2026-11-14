/**
 * @file test/batch.test.js
 * @module test/batch
 * @purpose The batch route: the journal of the answers, the first phase that submits the
 *          requests, and the second phase that takes the answers back.
 * @depends node:test, node:http, node:os, node:path, node:fs/promises, openai/journal,
 *          openai/batch, openai/client
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { createJournal } from '../src/openai/journal.js';
import { createClient } from '../src/openai/client.js';
import { parseBatchResults } from '../src/openai/batch.js';

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

/** The configuration of a test: one host that serves the batch route. */
const configFor = (baseURL, extra = {}) => ({
    model: 'test/model',
    timeoutMs: 5_000,
    backends: [{ baseURL, apiKey: 'test-key', supports: { batch: true } }],
    imagesBackends: [{ baseURL, apiKey: 'test-key', supports: { batch: true } }],
    image: { sizeHint: 'auto', div16: 'auto', padToMin: 'auto' },
    fallback: { enabled: true, models: {} },
    ...extra,
});

/** A temporary directory of the journal. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-batch-'));
}

test('the journal keeps the answer under the name of the request', async () => {
    const dir = await tempDir();
    try {
        const journal = createJournal({ dir });
        const hash = journal.hash({ model: 'test/model', input: 'hi' });
        assert.equal(await journal.read(hash), null, 'an unknown request has no answer');
        await journal.writeJson(hash, { output_text: 'hello' });
        const cached = await journal.read(hash);
        assert.equal(cached.kind, 'json');
        assert.equal(cached.value.output_text, 'hello');
        assert.equal(journal.hash({ input: 'hi', model: 'test/model' }), hash,
            'the name of a request does not depend on the order of the keys');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the first phase submits the request as a batch and stops', async () => {
    const dir = await tempDir();
    const host = await mockHost((req) => {
        if (req.url.endsWith('/files')) return { json: { id: 'file-1' } };
        if (req.url.endsWith('/batches')) return { json: { id: 'batch-1', status: 'in_progress' } };
        return { status: 404, json: { error: { message: 'not found' } } };
    });
    const journal = createJournal({ dir });
    const client = await createClient({
        config: configFor(host.baseURL),
        batch: { mode: 'submit', journal, collectMs: 50, minRequests: 1 },
    });
    try {
        await assert.rejects(
            async () => await client.responses.create({ input: 'hi', batchable: true }),
            (error) => {
                assert.equal(error.code, 'BATCH_SUBMITTED');
                assert.equal(error.details.batchId, 'batch-1');
                return true;
            },
        );
        const batches = await journal.listBatches();
        assert.equal(batches.length, 1);
        assert.equal(batches[0].id, 'batch-1');
        assert.equal(batches[0].requests.length, 1);
        // The file of the requests went out with the name of the request in it.
        const uploaded = host.requests.find((request) => request.url.endsWith('/files'));
        assert.ok(uploaded.body.includes(batches[0].requests[0].customId),
            'the file of the requests names the request');
    } finally {
        client.close();
        await host.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('the second phase takes the answers and the run goes on with them', async () => {
    const dir = await tempDir();
    const submitted = [];
    let customId = null;
    const host = await mockHost((req) => {
        if (req.url.endsWith('/files') && req.method === 'POST') return { json: { id: 'file-1' } };
        if (req.url.endsWith('/batches') && req.method === 'POST') return { json: { id: 'batch-1', status: 'in_progress' } };
        if (req.url.includes('/batches/batch-1')) {
            return { json: { id: 'batch-1', status: 'completed', output_file_id: 'out-1' } };
        }
        if (req.url.includes('/files/out-1/content')) {
            return {
                text: `${JSON.stringify({
                    custom_id: customId,
                    response: { status_code: 200, body: { output_text: 'the answer of the batch' } },
                })}\n`,
            };
        }
        return { status: 404, json: { error: { message: 'not found' } } };
    });
    const journal = createJournal({ dir });
    const first = await createClient({
        config: configFor(host.baseURL),
        batch: { mode: 'submit', journal, collectMs: 50, minRequests: 1 },
    });
    try {
        await assert.rejects(
            async () => await first.responses.create({ input: 'hi', batchable: true }),
            (error) => error.code === 'BATCH_SUBMITTED',
        );
    } finally {
        first.close();
    }
    const batches = await journal.listBatches();
    customId = batches[0].requests[0].customId;
    submitted.push(customId);

    // The second phase: the answers go into the journal, and the same question is answered
    // from it — the host is not asked a second time.
    const second = await createClient({
        config: configFor(host.baseURL),
        batch: { mode: 'fetch', journal, pollMs: 50 },
    });
    try {
        const fetched = await second.batches.fetch();
        assert.equal(fetched.ready, true);
        const answer = await second.responses.create({ input: 'hi', batchable: true });
        assert.equal(answer.output_text, 'the answer of the batch');
        assert.equal(host.requests.filter((request) => request.url === '/v1/responses').length, 0,
            'the answer of the journal is not paid for again');
    } finally {
        second.close();
        await host.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a request that failed in the batch is named by the file of the errors', () => {
    const results = parseBatchResults(`${JSON.stringify({
        custom_id: 'req-1',
        response: {
            status_code: 400,
            body: { error: { message: "Unknown parameter: 'text.type'." } },
        },
        error: null,
    })}\n`);
    const answer = results.get('req-1');
    assert.equal(answer.ok, false);
    assert.match(answer.error, /text\.type/);
});

test('a batch without a file of answers reads the file of the errors', async () => {
    const { fetchBatch } = await import('../src/openai/batch.js');
    const channel = {
        call: async (path) => {
            if (path === 'batches/batch-1') {
                return { id: 'batch-1', status: 'completed', output_file_id: null, error_file_id: 'err-1' };
            }
            if (path === 'files/err-1/content') {
                return `${JSON.stringify({
                    custom_id: 'req-1',
                    response: { status_code: 400, body: { error: { message: 'the model is not known' } } },
                })}\n`;
            }
            throw new Error(`unexpected path ${path}`);
        },
    };
    const result = await fetchBatch({ channel, id: 'batch-1', pollMs: 50 });
    assert.equal(result.ready, true);
    const answer = result.results.get('req-1');
    assert.equal(answer.ok, false);
    assert.match(answer.error, /not known/);
});

test('a picture is kept in the journal and is not paid for twice', async () => {
    const dir = await tempDir();
    const host = await mockHost(() => ({ json: { data: [{ b64_json: TINY_PNG }] } }));
    const journal = createJournal({ dir });
    const first = await createClient({
        config: configFor(host.baseURL),
        batch: { mode: 'submit', journal, collectMs: 50, minRequests: 1 },
    });
    try {
        const answer = await first.images.generate({ model: 'test/image', prompt: 'a lighthouse' });
        assert.equal(answer.payloads[0], TINY_PNG);
    } finally {
        first.close();
    }
    const second = await createClient({
        config: configFor(host.baseURL),
        batch: { mode: 'fetch', journal, pollMs: 50 },
    });
    try {
        const answer = await second.images.generate({ model: 'test/image', prompt: 'a lighthouse' });
        assert.equal(answer.route, 'journal');
        assert.equal(answer.payloads[0], TINY_PNG);
        assert.equal(host.requests.filter((request) => request.url.includes('/images/generations')).length, 1,
            'the picture is not paid for again');
    } finally {
        second.close();
        await host.close();
        await rm(dir, { recursive: true, force: true });
    }
});
