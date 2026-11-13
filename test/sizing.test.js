/**
 * @file test/sizing.test.js
 * @module test/sizing
 * @purpose The ladder of the frames: the tiers, the shapes, the 16-pixel grid, the limits of the
 *          profile, the order of the attempts and the reading of an answer.
 * @depends node:test, image/sizing, image/aspect, openai/images
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    IMAGE_SIZES_BY_RESOLUTION,
    IMAGE_TIER_LIMITS,
    aspectImageSize,
    aspectRatioToken,
    computeSize,
    fromMinimalSize,
    getAspectDifference,
    getOrientation,
    imageRequestSize,
    imageSizeAttempts,
    imageSizeFields,
    inferResolution,
    isImageSizeError,
    makePad16Size,
    nearestRiverflowRatio,
    needsDiv16Padding,
    needsMinPixelsPadding,
    normalizeImageSize,
    paddedSizeToMinPixels,
    parseImageSize,
    presetImageSize,
    sameAspectImageSize,
    supportedAspectRatios,
    tierFromToken,
} from '../src/image/sizing.js';
import {
    RATIO_MAX_TERM,
    aspectFrame,
    aspectOf,
    ceilAspect,
    nearestAspect,
    parseAspectToken,
    rationalAspect,
} from '../src/image/aspect.js';
import {
    backgroundValue,
    encodeMultipart,
    generationBody,
    imageComplexityValue,
    imageFormatField,
    imageModelFor,
    imagePayloads,
    imageSources,
    imageTransport,
    normalizeImageFormat,
    normalizeVectorRatio,
    pngHasAlphaChannel,
    readImageSize,
    resolveImageFormat,
    sniffImage,
    supportsTransparentBackground,
    svgConversionModel,
    withSizeHint,
} from '../src/openai/images.js';
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MAX_IMAGE_RATIO, MIN_IMAGE_PIXELS } from '../src/model/profiles.js';

const GPT = 'openai/gpt-image-2.6-sunburst';
const RIVERFLOW = 'sourceful/riverflow-v2.6-pro';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a shape token is read as a fraction', () => {
    assert.deepEqual(parseAspectToken('16:9'), { width: 16, height: 9, ratio: 16 / 9 });
    assert.equal(parseAspectToken('auto'), null);
    assert.equal(parseAspectToken('cinemascope').ratio, 2.39);
    assert.equal(parseAspectToken('1920x1080').ratio, 1920 / 1080);
    assert.equal(parseAspectToken('512'), null, 'a bare integer names a tier, not a shape');
    assert.equal(aspectOf({ width: 4, height: 2 }), 2);
    assert.equal(rationalAspect('2.39:1').width, 31, 'the cinema frame keeps small terms');
    assert.ok(rationalAspect('2.39:1').width <= RATIO_MAX_TERM);
    assert.equal(nearestAspect('2.39:1', ['16:9', '21:9']), '21:9');
});

test('a frame is built on the 16-pixel grid inside the limits', () => {
    const frame = aspectFrame('16:9', { step: 16, minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3, pixels: 1024 * 1024 });
    assert.ok(frame);
    assert.equal(frame.width % 16, 0);
    assert.equal(frame.height % 16, 0);
    assert.ok(frame.width * frame.height >= 1024 * 1024, 'the frame never lands under the budget');
    assert.equal(ceilAspect(15.998), 16, 'the float noise does not cost a whole step');
    assert.equal(ceilAspect(15.5), 16);
});

test('the tier of a frame and the tier of a token', () => {
    assert.equal(inferResolution({ width: 3072, height: 3072 }), '3k');
    assert.equal(inferResolution({ width: 2048, height: 1152 }), '2k');
    assert.equal(inferResolution({ width: 1024, height: 1024 }), '1k');
    assert.equal(tierFromToken('512'), '512');
    assert.equal(tierFromToken('1.5k'), '1.5k');
    assert.equal(tierFromToken('1K'), '1k');
    assert.equal(tierFromToken('3072'), '3k', 'a bare pixel number names the tier by its longest side');
    assert.equal(tierFromToken('nonsense'), null);
    assert.deepEqual(Object.keys(IMAGE_TIER_LIMITS), ['512', '1k', '1.5k', '2k', '3k', '4k']);
    assert.ok(IMAGE_SIZES_BY_RESOLUTION['1k'].length > 1, 'the catalogue has the native frames and the shapes');
});

test('the frame of a shape and the preset of an orientation', () => {
    assert.equal(getOrientation({ width: 10, height: 10 }), 'square');
    assert.equal(getOrientation({ width: 10, height: 20 }), 'portrait');
    assert.equal(getOrientation({ width: 20, height: 10 }), 'landscape');
    assert.ok(getAspectDifference({ width: 16, height: 9 }, { width: 16, height: 9 }) === 0);
    assert.equal(presetImageSize('1.5k', null, GPT), '1536x1536');
    assert.equal(presetImageSize('wide', null, GPT), '1024x768');
    assert.equal(presetImageSize('1024x1024', null, GPT), '1024x1024');
    assert.equal(aspectRatioToken('2.39:1', RIVERFLOW, 'image'), '21:9');
    assert.equal(aspectRatioToken('2.39:1', GPT, 'image'), '21:9');
    assert.ok(supportedAspectRatios(RIVERFLOW, 'image').includes('21:9'));
});

test('the size of a request is normalized inside the limits of the model', () => {
    assert.equal(normalizeImageSize('auto'), null);
    assert.equal(normalizeImageSize(''), null);
    assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
    assert.equal(normalizeImageSize('768x1024'), '768x1024');
    assert.equal(normalizeImageSize('portrait'), '573x1145');
    assert.equal(makePad16Size('810x810'), '816x816');
    assert.deepEqual(fromMinimalSize({ width: 100, height: 100 }, 655_360, 8_294_400, true), { width: 816, height: 816 });
    assert.deepEqual(computeSize('1:1', '1k', 655_360, 8_294_400, false), { width: 1024, height: 1024 });
});

test('the limits come from the profile of the model', () => {
    assert.equal(MIN_IMAGE_PIXELS(RIVERFLOW), 16_384);
    assert.equal(MAX_IMAGE_PIXELS(RIVERFLOW), 16_777_216);
    assert.equal(MAX_IMAGE_EDGE(RIVERFLOW), 4096);
    assert.equal(MAX_IMAGE_RATIO(RIVERFLOW), 16);
    assert.equal(MIN_IMAGE_PIXELS(GPT), 655_360);
    assert.equal(MAX_IMAGE_PIXELS(GPT), 8_294_400);
    assert.equal(MAX_IMAGE_EDGE(GPT), 3840);
    assert.equal(MAX_IMAGE_RATIO(GPT), 3);
    // 128x128 is legal riverflow and too small for gpt-image.
    assert.equal(sameAspectImageSize('128x128', RIVERFLOW), null);
    assert.notEqual(sameAspectImageSize('128x128', GPT), null);
    // riverflow takes a 16:1 frame; gpt-image refuses anything past 3:1.
    assert.equal(sameAspectImageSize('1600x100', GPT), null);
    assert.notEqual(sameAspectImageSize('1600x100', RIVERFLOW), null);
});

test('the frame of a request follows the family of the model', () => {
    assert.equal(imageRequestSize('2048x2048', GPT), '2048x2048');
    assert.equal(imageRequestSize('1024x1024', 'gpt-image-1'), '1024x1024');
    assert.equal(imageRequestSize('1.5k', GPT), '1536x1536');
    assert.equal(imageRequestSize('3k', GPT), '3072x3072');
    // A tier-based gateway keeps the tier in its own field.
    assert.deepEqual(imageSizeFields('2K', RIVERFLOW), { resolution: '2K' });
    assert.deepEqual(imageSizeFields('16:9', RIVERFLOW), { aspect_ratio: '16:9' });
    assert.deepEqual(imageSizeFields('1920x1080', RIVERFLOW), { size: '1920x1080' });
    assert.deepEqual(imageSizeFields('auto', RIVERFLOW, '4K'), { resolution: '4K' });
    assert.deepEqual(imageSizeFields('768x1024', GPT), { size: '768x1024' });
    assert.equal(nearestRiverflowRatio('1600x100'), '21:9');
    assert.equal(nearestRiverflowRatio('1024x1024'), null, 'a square frame has nothing to fix');
});

test('the order of the attempts: the frame, then the same shape, then the preset', () => {
    assert.deepEqual(imageSizeAttempts('1024x1024', GPT), ['1024x1024']);
    assert.deepEqual(imageSizeAttempts('2048x2048', GPT), ['2048x2048']);
    assert.deepEqual(imageSizeAttempts('100x100', GPT), ['100x100', '816x816', '1024x1024']);
    assert.deepEqual(imageSizeAttempts('3k', GPT), ['3072x3072', '2880x2880']);
    assert.deepEqual(imageSizeAttempts('2048x2048', GPT, '1.5k'), ['2048x2048', '1536x1536']);
    // A gateway that refuses the frame is asked once without it.
    assert.deepEqual(imageSizeAttempts('1600x100', RIVERFLOW), ['1600x100', '1600x96', '21:9', null]);
});

test('only a size error is retried', () => {
    assert.equal(isImageSizeError({ status: 400, param: 'size' }), true);
    assert.equal(isImageSizeError({ status: 422, message: 'Unsupported dimensions for this model' }), true);
    assert.equal(isImageSizeError({ status: 401, message: 'Invalid size' }), false);
    assert.equal(isImageSizeError({ status: 400, message: 'Invalid API key' }), false);
});

test('the padding of a small source and the 16-pixel grid', () => {
    assert.equal(needsDiv16Padding(GPT), true);
    assert.equal(needsDiv16Padding(RIVERFLOW), false);
    assert.equal(needsDiv16Padding(GPT, 'never'), false);
    assert.equal(needsMinPixelsPadding(GPT), true);
    assert.equal(needsMinPixelsPadding(GPT, 'never'), false);
    const padded = paddedSizeToMinPixels('100x100', GPT);
    assert.ok(padded);
    assert.equal(padded.originalWidth, 100);
    assert.equal(padded.width % 16, 0);
    assert.ok(padded.width * padded.height >= MIN_IMAGE_PIXELS(GPT));
    assert.equal(paddedSizeToMinPixels('1024x1024', GPT), null, 'a frame that clears the floor needs no padding');
});

test('the payload of a request', () => {
    assert.equal(normalizeImageFormat('auto'), null);
    assert.equal(normalizeImageFormat('jpg'), 'jpeg');
    assert.equal(normalizeImageFormat('PNG'), 'png');
    assert.equal(imageFormatField(GPT), 'output_format');
    assert.equal(imageFormatField('recraft/recraft-v4.1-utility'), 'image_format');
    assert.equal(resolveImageFormat({ model: GPT }), 'png');
    assert.equal(resolveImageFormat({ model: 'recraft/recraft-v4.1-utility' }), null);
    assert.equal(supportsTransparentBackground(GPT), true);
    assert.equal(supportsTransparentBackground('gpt-image-2'), false);
    assert.equal(backgroundValue({ model: GPT, format: 'png', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: GPT, format: 'jpeg', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: GPT, format: 'png', background: 'auto' }), null);
    assert.equal(imageComplexityValue({ model: GPT }), 'high');
    assert.equal(imageComplexityValue({ model: 'unknown/model' }), null);
    assert.deepEqual(normalizeVectorRatio('landscape'), '4:3');
    assert.deepEqual(svgConversionModel(GPT), { model: 'gpt-6.1-terra' });
    assert.equal(svgConversionModel('recraft/recraft-v4.1-pro-vector'), null);
});

test('the body of a generation', () => {
    const body = generationBody({ model: GPT, prompt: 'a lighthouse', size: '2048x2048', format: 'jpeg' });
    assert.equal(body.model, GPT);
    assert.equal(body.prompt, 'a lighthouse');
    assert.equal(body.size, '2048x2048');
    assert.equal(body.output_format, 'jpeg');
    assert.equal(body.complexity, 'high');
    assert.equal(generationBody({ model: GPT, prompt: 'p', size: 'auto' }).size, undefined);
    assert.equal(withSizeHint('a lighthouse', { size: '1024x1024' }, GPT), 'a lighthouse', 'a gpt-image keeps the fields');
    assert.match(withSizeHint('a lighthouse', { resolution: '2K' }, RIVERFLOW), /Requested output: resolution 2K/);
});

test('the answer of the API is read', () => {
    assert.deepEqual(imagePayloads({ data: [{ b64_json: TINY_PNG }, { b64_json: '' }] }), [TINY_PNG]);
    assert.deepEqual(imageSources({ data: [{ b64_json: ' abc ' }, { url: 'https://host/p.png' }] }), [
        { kind: 'b64', value: 'abc' },
        { kind: 'url', value: 'https://host/p.png' },
    ]);
    const png = Buffer.from(TINY_PNG, 'base64');
    assert.equal(sniffImage(png).mime, 'image/png');
    assert.equal(pngHasAlphaChannel(png), true);
    assert.deepEqual(readImageSize(png), { width: 1, height: 1 });
});

test('the multipart body of an edit', () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const form = encodeMultipart({
        fields: { model: GPT, prompt: 'morning', svg: { model: 'gpt-6.1-terra' }, empty: { skip: '' } },
        files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
    });
    assert.match(form.contentType, /multipart\/form-data; boundary=/);
    assert.ok(form.body.includes(png));
    const text = form.body.toString('latin1');
    assert.match(text, /filename="shot\.png"/);
    assert.match(text, /name="svg\[model\]"\r\n\r\ngpt-6\.1-terra\r\n/);
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.doesNotMatch(text, /name="empty/);
});

test('the transport of a request follows the configuration', () => {
    assert.equal(imageTransport({ image: { transport: 'responses' }, imagesBackends: [] }), 'responses');
    assert.equal(imageTransport({ image: {}, imagesBackends: [{ baseURL: 'https://api.proxyapi.ru/v1' }] }), 'images');
    assert.equal(imageTransport({ image: {}, imagesBackends: [], backends: [], baseURL: 'https://api.openai.com/v1' }), 'responses');
    assert.equal(imageModelFor({ imageModel: 'my/model' }), 'my/model');
    assert.equal(imageModelFor({ imageModel: null, image: {}, imagesBackends: [{ baseURL: 'x' }] }), 'openai/gpt-image-2.6-sunburst');
});
