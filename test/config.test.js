/**
 * @file test/config.test.js
 * @module test/config
 * @purpose The configuration system: the precedence of the sources, the placeholders,
 *          the refusal of a broken file, the redaction of the secrets and the
 *          `config` command.
 * @depends node:test, config, commands/config
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
    defaults,
    ensureConfigFile,
    loadConfig,
    redactConfig,
    validateConfig,
    diagnosticsDir,
    notesDir,
    promptsDir,
} from '../src/config.js';
import { run as runConfigCommand } from '../src/commands/config.js';

/** A home directory of its own, so the real one is never touched. */
const homeDir = async () => await mkdtemp(path.join(os.tmpdir(), 'ai-image-home-'));

/** Write a config file into the home directory. */
const writeHomeConfig = async (home, data) => {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'config.json'), JSON.stringify(data, null, 2));
};

const cleanEnv = (home, extra = {}) => ({ AI_IMAGE_HOME: home, ...extra });

/** A renderer that keeps the lines instead of printing them. */
const fakeRenderer = () => {
    const lines = [];
    const payloads = [];
    return {
        lines,
        payloads,
        line(kind, text) { lines.push({ kind, text }); },
        json(payload) { payloads.push(payload); },
        event() {},
    };
};

test('the defaults are a valid configuration', () => {
    assert.doesNotThrow(() => validateConfig(structuredClone(defaults)));
});

test('the config file overrides the defaults', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { model: 'file/model', image: { format: 'webp' } });
        const config = await loadConfig({ env: cleanEnv(home), ensureHome: false });
        assert.equal(config.model, 'file/model');
        assert.equal(config.image.format, 'webp');
        assert.equal(config.imageModel, defaults.imageModel, 'the rest of the defaults stay');
        assert.equal(config.image.size, defaults.image.size);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the environment overrides the file, and the flags override the environment', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { model: 'file/model' });
        const fromEnv = await loadConfig({
            env: cleanEnv(home, { AI_IMAGE_TEXT_MODEL: 'env/model' }),
            ensureHome: false,
        });
        assert.equal(fromEnv.model, 'env/model');

        const fromFlags = await loadConfig({
            env: cleanEnv(home, { AI_IMAGE_TEXT_MODEL: 'env/model' }),
            overrides: { model: 'cli/model' },
            ensureHome: false,
        });
        assert.equal(fromFlags.model, 'cli/model');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('AI_IMAGE_MODEL keeps the meaning of the monolith: the picture model', async () => {
    const home = await homeDir();
    try {
        const config = await loadConfig({
            env: cleanEnv(home, { AI_IMAGE_MODEL: 'env/picture' }),
            ensureHome: false,
        });
        assert.equal(config.imageModel, 'env/picture');
        assert.equal(config.model, defaults.model, 'the text model is untouched');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the picture knobs come from the environment', async () => {
    const home = await homeDir();
    try {
        const config = await loadConfig({
            env: cleanEnv(home, {
                AI_IMAGE_IMAGE_FORMAT: 'webp',
                AI_IMAGE_IMAGE_SIZE: '1536x1024',
                AI_IMAGE_ALPHA_MODE: 'mask',
                AI_IMAGE_RASTER_ENGINE: 'sharp',
                AI_IMAGE_OUTPUT_DIR: './pictures',
            }),
            ensureHome: false,
        });
        assert.equal(config.image.format, 'webp');
        assert.equal(config.image.size, '1536x1024');
        assert.equal(config.image.alphaMode, 'mask');
        assert.equal(config.image.rasterEngine, 'sharp');
        assert.equal(config.image.outputDir, './pictures');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a placeholder is expanded after the sources are merged', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { apiKey: '{{env:MY_OWN_KEY}}' });
        const config = await loadConfig({
            env: cleanEnv(home, { MY_OWN_KEY: 'the-secret' }),
            ensureHome: false,
        });
        assert.equal(config.apiKey, 'the-secret');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a file placeholder is read from the disk', async () => {
    const home = await homeDir();
    try {
        await writeFile(path.join(home, 'key.txt'), 'from-a-file');
        await writeHomeConfig(home, { apiKey: '{{file:./key.txt}}' });
        const config = await loadConfig({ env: cleanEnv(home), cwd: home, ensureHome: false });
        assert.equal(config.apiKey, 'from-a-file');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a broken config file is refused with a message that names it', async () => {
    const home = await homeDir();
    try {
        await mkdir(home, { recursive: true });
        await writeFile(path.join(home, 'config.json'), '{ this is not json');
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /некорректный JSON/,
        );

        await writeHomeConfig(home, { whatever: true });
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /неизвестный раздел/,
        );

        await writeHomeConfig(home, { image: { alphaMode: 'turbo' } });
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /image\.alphaMode/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the secret is shortened before the config is printed', () => {
    const printed = redactConfig({ ...defaults, apiKey: 'sk-very-secret-key' });
    assert.notEqual(printed.apiKey, 'sk-very-secret-key');
    assert.ok(!String(printed.apiKey).includes('secret'));
    assert.equal(printed.model, defaults.model, 'the rest of the config is printed as it is');
});

test('the home config is seeded when it does not exist yet', async () => {
    const home = await homeDir();
    try {
        const first = await ensureConfigFile(cleanEnv(home));
        assert.equal(first.created, true);
        const written = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
        assert.equal(written.model, defaults.model);
        // The starter is a partial config: it is valid on top of the defaults.
        const config = await loadConfig({ env: cleanEnv(home), ensureHome: false });
        assert.equal(config.model, defaults.model);
        assert.equal(config.imageModel, defaults.imageModel);
        const second = await ensureConfigFile(cleanEnv(home));
        assert.equal(second.created, false, 'an existing file is not overwritten');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the config command seeds the home and its directories', async () => {
    const home = await homeDir();
    try {
        const renderer = fakeRenderer();
        const code = await runConfigCommand({
            options: { positionals: ['init'], configPath: null },
            renderer,
            cwd: home,
            env: cleanEnv(home),
        });
        assert.equal(code, 0);
        assert.ok(renderer.lines.some((line) => line.kind === 'ok'), 'the file is reported');
        const { readdir } = await import('node:fs/promises');
        for (const dir of [promptsDir(home), notesDir(home), diagnosticsDir(home)]) {
            assert.ok(Array.isArray(await readdir(dir)), `${dir} exists`);
        }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the config command shows the redacted config and the path of the file', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { apiKey: 'sk-very-secret-key' });
        const renderer = fakeRenderer();
        const code = await runConfigCommand({
            options: { positionals: ['show'], configPath: null },
            renderer,
            cwd: home,
            env: cleanEnv(home),
        });
        assert.equal(code, 0);
        assert.equal(renderer.payloads.length, 1);
        assert.ok(!JSON.stringify(renderer.payloads[0]).includes('sk-very-secret-key'));

        const pathRenderer = fakeRenderer();
        await runConfigCommand({
            options: { positionals: ['path'], configPath: null },
            renderer: pathRenderer,
            cwd: home,
            env: cleanEnv(home),
        });
        assert.equal(pathRenderer.lines[0].text, path.join(home, 'config.json'));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
