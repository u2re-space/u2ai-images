/**
 * @file test/network.test.js
 * @module test/network
 * @purpose The calls to the real hosts: they cost money and they need the keys, so they run
 *          only when the flag `AI_IMAGE_NETWORK_TESTS=1` is set.
 * @depends node:test, config, openai/client
 *
 * The flag: `AI_IMAGE_NETWORK_TESTS=1 npm test`. Without it every test of this file is
 * skipped, and the suite stays offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config/index.js';
import { createClient } from '../src/openai/client.js';
import { resolvePurposeModel } from '../src/model/purpose.js';

const enabled = process.env.AI_IMAGE_NETWORK_TESTS === '1';
const skip = enabled ? false : 'the network tests are off: AI_IMAGE_NETWORK_TESTS=1';

test('a real host answers a generation', { skip }, async () => {
    const config = await loadConfig({ env: process.env, ensureHome: false });
    const client = createClient({ config, env: process.env });
    try {
        const model = resolvePurposeModel(config, 'generate') ?? config?.imageModel ?? null;
        assert.ok(model, 'there is a model to ask');
        const answer = await client.images.generate({
            model,
            purpose: 'generate',
            prompt: 'a red circle on a white ground',
            size: '1024x1024',
            format: 'png',
            n: 1,
        });
        assert.ok(Array.isArray(answer.payloads));
        assert.equal(answer.payloads.length, 1);
        const bytes = Buffer.from(answer.payloads[0], 'base64');
        assert.ok(bytes.length > 100, 'the answer carries a picture');
    } finally {
        client.close();
    }
});
