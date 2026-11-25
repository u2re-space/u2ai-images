import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { runImageWorker } from '../src/agent/worker-runner.js';
import { bytesOfFrame, createFrame, isFrame } from '../src/shared/protocol.js';

test('the bytes of a tool travel to the parent without the file system', async () => {
    // The worker is a thread of this process, and the tool of the worker answers with
    // the bytes of a picture: they travel in their own frame.
    const picture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const asked = [];

    // The API of the test: the worker talks to it over the network, exactly as it
    // talks to the API of the house.
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            asked.push(JSON.parse(body));
            const answer = asked.length === 1
                ? {
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        id: 'fc-1',
                        call_id: 'c-1',
                        name: 'view_image',
                        arguments: JSON.stringify({ input: 'logo.png' }),
                    }],
                }
                : { status: 'completed', output_text: 'The logo is seen.' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(answer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const report = await runImageWorker({
            spec: {
                role: { name: 'artist', instructions: 'You are the artist.' },
                goal: 'Look at the logo.',
                model: { model: 'test-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
            },
            onCall: async () => ({ bytes: picture, name: 'logo.png', mime: 'image/png' }),
        });
        // The worker read the picture from the frame: it never went to the disk.
        assert.equal(report.ok, true);
        assert.equal(report.turns, 2);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a frame of bytes carries the bytes and names them', () => {
    const picture = Buffer.from([1, 2, 3, 4]);
    const frame = createFrame('bytes', { bytes: new Uint8Array(picture), name: 'logo.png', length: 4 });
    assert.equal(isFrame(frame), true);
    assert.deepEqual([...bytesOfFrame(frame)], [1, 2, 3, 4]);
    assert.equal(frame.name, 'logo.png');
});
