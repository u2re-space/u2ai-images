/**
 * @file test/model.test.js
 * @module test/model
 * @purpose The model profiles and the fallback of the models.
 * @depends node:test, model/profiles, model/fallback
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_PROFILE,
    MAX_IMAGE_EDGE,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_RATIO,
    MIN_IMAGE_PIXELS,
    imageModelFamily,
    imageModelProfile,
} from '../src/model/profiles.js';
import { fallbackChain, fallbackModels, modelFallback } from '../src/model/fallback.js';

test('the profile of a known family is merged over the default', () => {
    const gpt = imageModelProfile('openai/gpt-image-2.6-sunburst');
    assert.equal(gpt.customSizes, true);
    assert.equal(gpt.div16Padding, true);
    assert.equal(gpt.complexity, 'high');
    assert.equal(gpt.minPixels, DEFAULT_PROFILE.minPixels);

    const river = imageModelProfile('sourceful/riverflow-v2.6-pro');
    assert.equal(river.routeEditsThroughGeneration, true);
    assert.equal(river.resolutionTiers, true);
    assert.equal(river.maxRatio, 16);
    assert.equal(river.minPixels, 16_384);
});

test('an unknown model gets the plain profile', () => {
    const profile = imageModelProfile('some/unknown-model');
    assert.equal(profile.customSizes, DEFAULT_PROFILE.customSizes);
    assert.equal(profile.div16Padding, DEFAULT_PROFILE.div16Padding);
    assert.equal(MIN_IMAGE_PIXELS('some/unknown-model'), DEFAULT_PROFILE.minPixels);
    assert.equal(MAX_IMAGE_PIXELS(null), DEFAULT_PROFILE.maxPixels);
    assert.equal(MAX_IMAGE_EDGE('x'), DEFAULT_PROFILE.maxEdge);
    assert.equal(MAX_IMAGE_RATIO('x'), DEFAULT_PROFILE.maxRatio);
});

test('the family of a model is named', () => {
    assert.equal(imageModelFamily('openai/gpt-image-2.6-sunburst'), 'gpt-image-2.6');
    assert.equal(imageModelFamily('gpt-image-2.5-flare'), 'gpt-image-2.5');
    assert.equal(imageModelFamily('sourceful/riverflow-v2.6-pro'), 'riverflow');
    assert.equal(imageModelFamily('recraft/recraft-v4.1-pro-vector'), 'recraft-vector');
    assert.equal(imageModelFamily('who/knows'), 'generic');
});

test('the fallback of a model is the same model under its catalog name', () => {
    assert.equal(modelFallback('gpt-image-2.6-sunburst'), 'openai/gpt-image-2.6-sunburst');
    assert.equal(modelFallback('openai/gpt-image-2.6-sunburst'), null);
    assert.equal(modelFallback(null), null);
});

test('the chain of the models starts with the requested one', () => {
    const config = { fallback: { enabled: true, models: { '*': ['any/model'] } } };
    const chain = fallbackChain(config, 'gpt-image-2.6-sunburst');
    assert.equal(chain[0], 'gpt-image-2.6-sunburst');
    assert.ok(chain.includes('openai/gpt-image-2.6-sunburst'));
    assert.ok(chain.includes('any/model'));
    assert.deepEqual(fallbackModels({ fallback: { enabled: false } }, 'x'), []);
});
