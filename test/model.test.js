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
    snapQuality,
} from '../src/model/profiles.js';
import { TEXT_MODEL_PROFILES, textModelProfile, snapEffort } from '../src/model/text.js';
import { fallbackChain, fallbackModels, modelFallback } from '../src/model/fallback.js';
import { imageRequestSize, paddedSizeToMinPixels } from '../src/image/sizing.js';

test('the profile of a known family is merged over the default', () => {
    const gpt = imageModelProfile('openai/gpt-image-2.6-sunburst');
    assert.equal(gpt.customSizes, true);
    assert.equal(gpt.div16Padding, true);
    assert.equal(gpt.quality, 'high');
    assert.equal(gpt.minPixels, DEFAULT_PROFILE.minPixels);

    const river = imageModelProfile('sourceful/riverflow-v2.6-pro');
    assert.equal(river.routeEditsThroughGeneration, true);
    assert.equal(river.resolutionTiers, true);
    assert.equal(river.maxRatio, 16);
    assert.equal(river.minPixels, 16_384);
});

test('the capabilities of the models are the ones of the catalog of the gateway', () => {
    const gpt = imageModelProfile('openai/gpt-image-2.6-sunburst');
    assert.equal(gpt.maxImages, 10, 'gpt-image carries up to ten pictures in one request');
    assert.equal(gpt.gif, true, 'the animated GIF is the field of gpt-image-2.6');
    assert.equal(gpt.outputCompression, true);
    assert.equal(gpt.mask, true, 'the mask of the area to repaint');
    assert.equal(gpt.seed, false, 'the catalog says gpt-image-2.6 keeps no seed');

    const seedream = imageModelProfile('bytedance-seed/seedream-5-5');
    assert.equal(seedream.seed, true, 'the catalog says seedream keeps the seed');
    assert.equal(seedream.maxImages, 1, 'seedream answers with one picture');
    assert.equal(seedream.quality, null, 'seedream knows no quality field');
    assert.deepEqual(seedream.resolutions, ['1K', '1.5K', '2K']);
    assert.ok(seedream.aspectRatios.includes('9:19.5'), 'the cinema shapes of the vendor');
});

test('a quality is pulled down to the ladder of the model', () => {
    const gpt = imageModelProfile('openai/gpt-image-2.6-sunburst');
    assert.equal(snapQuality('high', gpt), 'high');
    assert.equal(snapQuality('max', gpt), 'max');
    assert.equal(snapQuality('auto', gpt), 'high', 'auto means the tier of the model');
    assert.equal(snapQuality('ultra', gpt), 'high', 'a level that is not on the ladder is not sent');
    const seedream = imageModelProfile('bytedance-seed/seedream-5-5');
    assert.equal(snapQuality('high', seedream), null, 'the model knows no quality field');
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
    // Gemini 4 Hydrogen: the levels of the effort are the four of the card of the vendor.
    const gemini = TEXT_MODEL_PROFILES['google/gemini-4-hydrogen'];
    assert.equal(gemini.ceiling, 'xhigh');
    assert.equal(gemini.window, 1_048_576);
    assert.equal(gemini.maxOutput, 1_048_576);
    assert.deepEqual(gemini.efforts, ['low', 'medium', 'high', 'xhigh']);
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
    // Gemini takes the four levels of its card; the reasoning off is raised to `low`.
    const gemini = textModelProfile('google/gemini-4-hydrogen');
    assert.equal(snapEffort('xhigh', gemini), 'xhigh');
    assert.equal(snapEffort('max', gemini), 'xhigh', 'the ceiling of the model wins');
    assert.equal(snapEffort('none', gemini), 'low');
});
