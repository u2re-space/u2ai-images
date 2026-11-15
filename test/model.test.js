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
import { TEXT_MODEL_PROFILES, textModelProfile, snapEffort } from '../src/model/text.js';
import { fallbackChain, fallbackModels, modelFallback } from '../src/model/fallback.js';
import { imageRequestSize, paddedSizeToMinPixels } from '../src/image/sizing.js';

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

test('the seedream takes a free frame above its own floor', () => {
    const seedream = imageModelProfile('bytedance-seed/seedream-5-5');
    assert.equal(seedream.customSizes, true);
    // The host refuses a frame below 960×960 pixels.
    assert.equal(seedream.minPixels, 921_600);
    assert.equal(imageModelFamily('bytedance-seed/seedream-5-5'), 'seedream');
    // A frame of its own is kept as it is.
    assert.equal(imageRequestSize('1200x800', 'bytedance-seed/seedream-5-5'), '1200x800');
    // A frame below the floor is padded up to it instead of being refused.
    const padded = paddedSizeToMinPixels('281x326', 'bytedance-seed/seedream-5-5');
    assert.ok(padded, 'the crop is padded');
    assert.ok(padded.width * padded.height >= 921_600, 'the canvas clears the floor');
});

test('the fallback of a model is the same model under its catalog name', () => {
    assert.equal(modelFallback('gpt-image-2.6-sunburst'), 'openai/gpt-image-2.6-sunburst');
    assert.equal(modelFallback('openai/gpt-image-2.6-sunburst'), null);
    assert.equal(modelFallback('seedream-5-5'), 'bytedance-seed/seedream-5-5');
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

test('a text model has a ceiling and a ladder of the efforts', () => {
    const minimax = textModelProfile('minimax/minimax-m3.1-flash');
    assert.equal(minimax.ceiling, 'xhigh');
    assert.ok(minimax.efforts.includes('high'));
    assert.equal(minimax.window, 1_000_000);
    assert.equal(minimax.maxOutput, 524_288);
    // Kimi is tuned for the speed of the answer: the ceiling is `medium`.
    const kimi = TEXT_MODEL_PROFILES['moonshotai/kimi-k3.1-pro'];
    assert.equal(kimi.ceiling, 'medium');
    assert.equal(kimi.window, 1_000_000);
    assert.equal(kimi.maxOutput, 944_000);
    assert.ok(kimi.efforts.includes('none'), 'kimi takes the reasoning off without a refusal');
    // A model the table does not know works in the middle of the ladder.
    const unknown = textModelProfile('who/knows');
    assert.equal(unknown.ceiling, 'medium');
    assert.deepEqual(unknown.efforts, ['low', 'medium', 'high']);
});

test('an effort is pulled down to what the model takes', () => {
    const luna = textModelProfile('openai/gpt-6-luna');
    assert.equal(snapEffort('high', luna), 'medium', 'the ceiling of the model wins');
    assert.equal(snapEffort('low', luna), 'low');
    const terra = textModelProfile('openai/gpt-6.1-terra');
    assert.equal(snapEffort('xhigh', terra), 'high');
    const minimax = textModelProfile('minimax/minimax-m3.1-flash');
    assert.equal(snapEffort('high', minimax), 'high');
    assert.equal(snapEffort('xhigh', minimax), 'xhigh');
    assert.equal(snapEffort('max', minimax), 'xhigh', 'the ceiling of the model wins');
    assert.equal(
        snapEffort('none', minimax),
        'low',
        'minimax refuses to work without reasoning, so the level is raised',
    );
    assert.equal(snapEffort('ultra', minimax), null, 'a level that is not on the ladder is not sent');
    assert.equal(snapEffort(null, minimax), null);
    // Kimi works at the ceiling of the run and keeps the reasoning off when it is asked to.
    const kimi = textModelProfile('moonshotai/kimi-k3.1-pro');
    assert.equal(snapEffort('high', kimi), 'medium');
    assert.equal(snapEffort('none', kimi), 'none');
});
