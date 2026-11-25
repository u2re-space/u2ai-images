import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import { runImageWorker, spawnImageWorker } from '../src/agent/worker-runner.js';
import { normalizeImageSpec, runImageCycle, IMAGE_TOOLS } from '../src/agent/worker.js';
import { createSharedBlock, readSharedBlock } from '../src/shared/shared.js';

/**
 * The API of the test: the worker of the images system talks to it over the network,
 * exactly as it talks to the API of the house.
 * @param {object[]} seen the answers the fake API gave
 * @returns {Promise<{ server: object, port: number }>}
 */
async function fakeApi(seen) {
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            seen.push(JSON.parse(body));
            const answer = seen.length === 1
                ? {
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        id: 'fc-1',
                        call_id: 'c-1',
                        name: 'crop_image',
                        arguments: JSON.stringify({ input: 'logo.png', output: 'logo-cut.png' }),
                    }],
                }
                : { status: 'completed', output_text: 'The picture is cut.' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(answer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

test('the spec of the images worker has every field', () => {
    const spec = normalizeImageSpec({
        role: { name: 'artist', instructions: 'You are the artist.', tools: ['crop_image'] },
        goal: 'Cut the logo.',
        files: ['logo-cut.png'],
        budget: { maxTurns: 4 },
    });
    assert.equal(spec.role.name, 'artist');
    assert.equal(spec.role.instructions, 'You are the artist.');
    assert.deepEqual(spec.role.tools, ['crop_image']);
    assert.equal(spec.goal, 'Cut the logo.');
    assert.deepEqual(spec.files, ['logo-cut.png']);
    assert.equal(spec.budget.maxTurns, 4);
    // The tools of the parent are the tools of the worker: without a list, it has them all.
    const bare = normalizeImageSpec({ role: { name: 'artist' } });
    assert.deepEqual(bare.role.tools, [...IMAGE_TOOLS]);
});

test('the worker runs in a thread of the parent and calls its tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-worker-'));
    const seen = [];
    const { server, port } = await fakeApi(seen);
    const calls = [];
    const events = [];
    try {
        const report = await runImageWorker({
            spec: {
                name: 'artist-1',
                role: { name: 'artist', instructions: 'You are the artist.', tools: ['crop_image'] },
                goal: 'Cut the logo.',
                files: ['logo-cut.png'],
                model: { model: 'test-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            },
            onCall: async (call) => {
                calls.push(call.name);
                return 'The picture is cut.';
            },
            onEvent: (event) => events.push(event),
        });
        assert.equal(report.ok, true);
        assert.equal(report.turns, 2);
        assert.deepEqual(calls, ['crop_image']);
        assert.ok(events.some((event) => event?.status === 'working'));
        // The thread asked the API of the house with its own model.
        assert.equal(seen[0].model, 'test-model');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test('the instructions of the worker travel in the shared memory', async () => {
    const { buffer } = createSharedBlock({
        instructions: 'You are the artist of the shared buffer.',
        notes: 'The notes of the shared buffer.',
    });
    const bodies = [];
    const client = {
        responses: {
            async create(body) {
                bodies.push(body);
                return { status: 'completed', output_text: 'The picture is cut.' };
            },
        },
    };
    const report = await runImageCycle({
        spec: {
            role: { name: 'artist', instructions: 'The instructions of the spec.' },
            goal: 'Cut the logo.',
            context: { notes: 'The notes of the spec.' },
            shared: buffer,
        },
        client,
    });
    assert.equal(report.ok, true);
    // The instructions came from the shared buffer, not from the spec.
    assert.equal(bodies[0].instructions, 'You are the artist of the shared buffer.');
});

test('the worker stops when the parent sets the flag of the shared memory', async () => {
    const { buffer } = createSharedBlock({ instructions: 'You are the artist.', notes: '' });
    const client = {
        responses: {
            async create() {
                // The parent asks the worker to stop while the turn runs.
                readSharedBlock(buffer).cancel();
                return { status: 'completed', output_text: 'The picture is cut.' };
            },
        },
    };
    const report = await runImageCycle({
        spec: { role: { name: 'artist' }, goal: 'Cut the logo.', shared: buffer },
        client,
    });
    assert.equal(report.stopped, 'aborted');
    assert.equal(report.ok, false);
});

test('a worker without a goal or without a role says so', async () => {
    const noGoal = await runImageCycle({ spec: { role: { name: 'artist' } }, client: null });
    assert.equal(noGoal.error, 'no-goal');
    assert.equal(noGoal.stopped, 'failed');

    const noRole = await runImageCycle({ spec: { goal: 'Cut the logo.' }, client: null });
    assert.equal(noRole.error, 'no-role');

    const noClient = await runImageCycle({ spec: { role: { name: 'artist' }, goal: 'Cut.' }, client: null });
    assert.equal(noClient.error, 'no-client');
});

test('the worker may be started without waiting for it', async () => {
    const { server, port } = await fakeApi([]);
    try {
        const { handle, done } = spawnImageWorker({
            spec: {
                role: { name: 'artist', instructions: 'You are the artist.' },
                goal: 'Cut the logo.',
                model: { model: 'test-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            },
            onCall: async () => 'ok',
        });
        assert.equal(handle.role, 'artist');
        assert.equal(handle.alive(), true);
        const report = await done;
        assert.equal(report.ok, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
