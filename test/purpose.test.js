/**
 * @file test/purpose.test.js
 * @module test/purpose
 * @purpose The purpose system: the map of the purposes, the aliases, the resolution of the
 *          model by the backends and the priority of the model of the user.
 * @depends node:test, model/purpose
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PURPOSE_NAMES,
    PURPOSE_ALIASES,
    canonicalPurpose,
    purposeModels,
    resolvePurposeModel,
} from '../src/model/purpose.js';

test('the purpose map has the purposes of the CLI', () => {
    assert.deepEqual([...PURPOSE_NAMES], ['decompose', 'generate', 'edit', 'remove_background', 'upscale', 'unrotate']);
    for (const purpose of PURPOSE_NAMES) {
        assert.ok(purposeModels({}, purpose).length > 0, `${purpose} has models`);
    }
});

test('the aliases name the same purpose', () => {
    assert.equal(canonicalPurpose('isolate_object'), 'remove_background');
    assert.equal(canonicalPurpose('isolate'), 'remove_background');
    assert.equal(canonicalPurpose('rectify'), 'unrotate');
    assert.equal(canonicalPurpose('unrotate'), 'unrotate');
    assert.equal(canonicalPurpose('nonsense'), 'nonsense');
    assert.deepEqual(purposeModels({}, 'isolate_object'), purposeModels({}, 'remove_background'));
    assert.deepEqual(purposeModels({}, 'rectify'), purposeModels({}, 'unrotate'));
    assert.deepEqual(Object.keys(PURPOSE_ALIASES).sort(), ['isolate', 'isolate_object', 'rectify']);
});

test('the cut-out is drawn only by the sunburst and the seedream', () => {
    for (const purpose of PURPOSE_NAMES) {
        const models = purposeModels({}, purpose);
        if (purpose === 'remove_background') continue;
        assert.ok(!models.some((model) => model.includes('seedream')), `${purpose} has no seedream`);
    }
    assert.deepEqual(purposeModels({}, 'remove_background'), [
        'openai/gpt-image-2.6-sunburst',
        'bytedance-seed/seedream-5-5',
    ]);
});

test('a purpose resolves to the first model the backends serve', () => {
    const config = {
        baseURL: 'https://routerai.ru/api/v1',
        backendUrls: ['https://routerai.ru/api/v1'],
        purpose: { models: { decompose: ['vendor/one', 'vendor/two'] } },
        explicit: { top: [], image: [] },
    };
    assert.equal(resolvePurposeModel(config, 'decompose'), 'vendor/one');
});

test('a model of another vendor needs a proxy host', () => {
    const config = {
        baseURL: 'https://api.openai.com/v1',
        backendUrls: ['https://api.openai.com/v1'],
        purpose: { models: { decompose: ['sourceful/riverflow-v2.6-pro'] } },
        explicit: { top: [], image: [] },
    };
    assert.equal(resolvePurposeModel(config, 'decompose'), null);

    config.backendUrls = ['https://api.proxyapi.ru/v1'];
    assert.equal(resolvePurposeModel(config, 'decompose'), 'sourceful/riverflow-v2.6-pro');
});

test('a picture model of the user wins over the purpose', () => {
    const config = {
        imageModel: 'my/model',
        backendUrls: ['https://routerai.ru/api/v1'],
        purpose: { models: { decompose: ['vendor/one'] } },
        explicit: { top: ['imageModel'], image: [] },
    };
    assert.equal(resolvePurposeModel(config, 'decompose'), null);
});

test('an empty or unknown purpose resolves to nothing', () => {
    const config = { backendUrls: ['https://routerai.ru/api/v1'], explicit: { top: [], image: [] } };
    assert.equal(resolvePurposeModel(config, ''), null);
    assert.equal(resolvePurposeModel(config, null), null);
    assert.equal(resolvePurposeModel(config, 'nosuchpurpose'), null);
});

test('the list of the user replaces the built-in list of the purpose', () => {
    const config = {
        backendUrls: ['https://routerai.ru/api/v1'],
        purpose: { models: { isolate: ['only/this'] } },
        explicit: { top: [], image: [] },
    };
    assert.deepEqual(purposeModels(config, 'isolate'), ['only/this']);
    assert.equal(resolvePurposeModel(config, 'isolate'), 'only/this');
});
