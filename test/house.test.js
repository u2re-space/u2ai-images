/**
 * @file test/house.test.js
 * @purpose Tests of the law of the house: where the pictures of the house live, how the
 *          images system signs the contract of the project and how the model is kept inside
 *          the working directory.
 *
 * The house of a project is `.ai/`: the assets in `.ai/assets/`, the logs in `.ai/logs/`, the
 * contract in `.ai/manifest.json`. The pictures of a run land in the assets, the work of the
 * alpha pipeline lands in the temporary directory of the system, and the model may not write
 * outside the working directory.
 *
 * @depends node:test, node:fs/promises, node:os, node:path, shared/house, core/publish,
 *          agent/tools, image/alpha, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import {
    HOUSE_ASSETS,
    HOUSE_DIR,
    HOUSE_LOGS,
    HOUSE_SYSTEMS,
    HOUSE_TMP,
    HOUSE_WORK,
    MANIFEST_FILE,
    assetsDir,
    findGenerated,
    houseDir,
    logsDir,
    manifestPath,
    publish,
    readManifest,
    toProjectPath,
    writeFileAtomic,
    writeManifest,
} from '../src/shared/house.js';
import { assetsRel, publishPictures } from '../src/core/publish.js';
import { createImageTools } from '../src/agent/tools.js';
import { localMatte } from '../src/image/alpha.js';
import { encodeRgba } from '../src/image/raster.js';

/**
 * An empty project in a temporary directory.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-house-'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * A picture of a solid color.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function solidPng(width = 20, height = 20) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 200;
        data[i + 1] = 30;
        data[i + 2] = 40;
        data[i + 3] = 255;
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

// --- the law of the house ----------------------------------------------------

test('the house of a project is one directory', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(HOUSE_DIR, '.ai');
        assert.equal(HOUSE_TMP, 'tmp');
        assert.equal(HOUSE_ASSETS, 'assets');
        assert.equal(HOUSE_LOGS, 'logs');
        assert.equal(HOUSE_WORK, '.ai/tmp');
        assert.equal(houseDir(root), path.join(root, '.ai'));
        assert.equal(assetsDir(root), path.join(root, '.ai', 'assets'));
        assert.equal(logsDir(root), path.join(root, '.ai', 'logs'));
        assert.equal(manifestPath(root), path.join(root, '.ai', MANIFEST_FILE));
    } finally {
        await cleanup();
    }
});

test('the pictures of the house land in the assets', () => {
    assert.equal(assetsRel({}), '.ai/assets');
    assert.equal(assetsRel({ image: { outputDir: 'pictures' } }), 'pictures');
    assert.equal(assetsRel({ image: { outputDir: './pictures/' } }), 'pictures');
});

test('the path of a file of the project is relative, a foreign one is absolute', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(toProjectPath(root, path.join(root, '.ai', 'assets', 'a.png')), '.ai/assets/a.png');
        assert.equal(toProjectPath(root, path.resolve(root, '..', 'outside.png')), path.resolve(root, '..', 'outside.png'));
    } finally {
        await cleanup();
    }
});

// --- the contract of the project ---------------------------------------------

test('the contract of the project is written and read', async () => {
    const { root, cleanup } = await project();
    try {
        await writeManifest(root, { systems: { webdev: { delivery: '.' } } });
        const manifest = await readManifest(root);
        assert.equal(manifest.manifestVersion, 1);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.ok(manifest.updatedAt);
    } finally {
        await cleanup();
    }
});

test('a broken contract is read as an empty one, not as an error', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai'), { recursive: true });
        await writeFile(manifestPath(root), '{ this is not json', 'utf8');
        const manifest = await readManifest(root);
        assert.deepEqual(manifest.systems, {});
        assert.equal(manifest.manifestVersion, 1);
    } finally {
        await cleanup();
    }
});

test('a system signs only its own part of the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await publish(root, HOUSE_SYSTEMS.webdev, { delivery: '.', artifacts: { site: '.' } });
        await publish(root, HOUSE_SYSTEMS.images, { delivery: '.ai/assets/', artifacts: { assets: '.ai/assets' } });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.equal(manifest.systems.images.delivery, '.ai/assets/');
        assert.equal(manifest.systems.images.artifacts.assets, '.ai/assets');
    } finally {
        await cleanup();
    }
});

test('the images system signs the pictures it made', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai', 'assets'), { recursive: true });
        await writeFile(path.join(root, '.ai', 'assets', 'a.png'), 'x', 'utf8');
        await publishPictures({
            cwd: root,
            config: { image: { outputDir: '.ai/assets' } },
            files: [path.join(root, '.ai', 'assets', 'a.png')],
            extra: { command: 'generate' },
        });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.images.delivery, '.ai/assets/');
        assert.equal(manifest.systems.images.artifacts.assets, '.ai/assets');
        assert.deepEqual(manifest.systems.images.artifacts.pictures, ['.ai/assets/a.png']);
        assert.equal(manifest.systems.images.command, 'generate');
    } finally {
        await cleanup();
    }
});

test('the pictures of the images system are found through the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai', 'assets'), { recursive: true });
        await writeFile(path.join(root, '.ai', 'assets', 'a.png'), 'x', 'utf8');
        await publishPictures({
            cwd: root,
            config: { image: { outputDir: '.ai/assets' } },
            files: [path.join(root, '.ai', 'assets', 'a.png')],
        });
        const found = await findGenerated(root, 'pictures', ['nowhere/a.png']);
        assert.equal(found, '.ai/assets/a.png');
    } finally {
        await cleanup();
    }
});

// --- the atomic write --------------------------------------------------------

test('a file appears whole: no temporary file is left', async () => {
    const { root, cleanup } = await project();
    try {
        const file = path.join(root, '.ai', 'assets', 'a.png');
        await writeFileAtomic(file, 'bytes');
        assert.equal(await readFile(file, 'utf8'), 'bytes');
        assert.deepEqual(await readdir(path.dirname(file)), ['a.png']);
    } finally {
        await cleanup();
    }
});

test('a failed write leaves no temporary file', async () => {
    const { root, cleanup } = await project();
    try {
        const target = path.join(root, 'locked');
        await mkdir(target, { recursive: true });
        await assert.rejects(async () => writeFileAtomic(target, 'new'));
        const left = await readdir(root);
        assert.ok(!left.some((name) => name.includes('.tmp-')), 'the temporary file is left');
    } finally {
        await cleanup();
    }
});

// --- the lock of the model ----------------------------------------------------

test('the model may not write outside the working directory', async () => {
    const { root, cleanup } = await project();
    try {
        const client = {
            images: {
                generate: async () => ({ payloads: [(await solidPng()).toString('base64')], model: 'test' }),
            },
        };
        const tools = createImageTools({ client, config: { image: { outputDir: '.ai/assets' } }, cwd: root });
        await assert.rejects(
            () => tools.generate_image({ prompt: 'a cat', output: '../escape.png' }),
            /outside the working directory/,
        );
    } finally {
        await cleanup();
    }
});

test('the model may not write into a read-only directory', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.git'), { recursive: true });
        const client = {
            images: {
                generate: async () => ({ payloads: [(await solidPng()).toString('base64')], model: 'test' }),
            },
        };
        const tools = createImageTools({ client, config: { image: { outputDir: '.ai/assets' } }, cwd: root });
        await assert.rejects(
            () => tools.generate_image({ prompt: 'a cat', output: '.git/config.png' }),
            /denied/,
        );
    } finally {
        await cleanup();
    }
});

test('the pictures of the model land in the assets of the house', async () => {
    const { root, cleanup } = await project();
    try {
        const client = {
            images: {
                generate: async () => ({ payloads: [(await solidPng()).toString('base64')], model: 'test' }),
            },
        };
        const tools = createImageTools({ client, config: { image: { outputDir: '.ai/assets' } }, cwd: root });
        const answer = await tools.generate_image({ prompt: 'a cat' });
        assert.equal(answer.files.length, 1);
        assert.ok(answer.files[0].startsWith('.ai/assets/'), answer.files[0]);
        const files = await readdir(path.join(root, '.ai', 'assets'));
        assert.equal(files.length, 1);
    } finally {
        await cleanup();
    }
});

// --- the work of the alpha ----------------------------------------------------

test('the work of the alpha lives in the temporary directory of the system', async () => {
    const { root, cleanup } = await project();
    try {
        const file = path.join(root, 'a.png');
        await writeFile(file, await solidPng());
        const matte = await localMatte({ base: file, cwd: root, engine: 'sharp' });
        if (matte?.mask) {
            assert.ok(matte.mask.startsWith(os.tmpdir()), matte.mask);
        }
        // The project keeps the picture and nothing else.
        const left = await readdir(root);
        assert.ok(!left.some((name) => name.startsWith('.tmp-alpha')), 'the work is in the project');
    } finally {
        await cleanup();
    }
});
