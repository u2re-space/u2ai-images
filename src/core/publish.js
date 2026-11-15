/**
 * @file src/core/publish.js
 * @module core/publish
 * @purpose Sign the contract of the project for the pictures the house made.
 *
 *   The contract of the project is `.ai/manifest.json`: one file that says what every system
 *   of the house made and where it lies. The images system signs its own part of it — the
 *   directory of the assets and the pictures it wrote — and never touches the part of another
 *   system.
 *
 *   The paths in the contract are relative to the project and with forward slashes: the
 *   systems of the house read the contract on another machine and another system, and the
 *   path has to mean the same thing there.
 *
 * @depends node:path, shared/house
 * @usedBy commands/generate, commands/edit, commands/process
 * @exports publishPictures, assetsRel
 * @ai.tags house, manifest, images
 * @ai.hint io
 */

import path from 'node:path';
import { HOUSE_SYSTEMS, publish, toProjectPath } from '../shared/house.js';

/** The directory of the assets of the house, as the config asks for it. */
const ASSETS_DIR = '.ai/assets';

/**
 * The path of the assets of the house, as the project sees it.
 *
 * The config may move the assets out of the house, and then it wins: the law gives the
 * default, the user gives the exception.
 * @param {object} [config] the config of the run
 * @returns {string} the path relative to the project, with forward slashes
 * @exports
 * @ai.hint pure
 */
export function assetsRel(config = {}) {
    const dir = String(config?.image?.outputDir ?? ASSETS_DIR).trim() || ASSETS_DIR;
    return dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The path of a directory, as the project sees it: relative, with forward slashes.
 * @param {string} root the project directory
 * @param {string} abs the absolute path of the directory
 * @returns {string}
 * @ai.hint pure
 */
function projectRel(root, abs) {
    const relative = path.relative(root, abs);
    if (relative === '') return '.';
    if (relative.startsWith('..') || path.isAbsolute(relative)) return toProjectPath(root, abs);
    return relative.split(path.sep).join('/').replace(/\/+$/, '');
}

/**
 * Sign the contract of the project for the pictures of the run.
 *
 * The contract is a hint, not a reason to fail: a run that cannot write it warns and goes
 * on.
 * @param {{ cwd?: string, config?: object|null, files?: string[], outputDir?: string|null,
 *   extra?: object }} options
 * @returns {Promise<object|null>} the contract after the change, or null
 * @exports
 * @ai.hint io
 */
export async function publishPictures({ cwd = process.cwd(), config = null, files = [], outputDir = null,
    extra = {} } = {}) {
    const root = path.resolve(String(cwd ?? process.cwd()));
    // The delivery of the images system: the directory the pictures land in.
    const delivery = outputDir
        ? path.resolve(root, outputDir)
        : path.resolve(root, config?.image?.outputDir ?? ASSETS_DIR);

    const artifacts = { assets: assetsRel(config) };
    const pictures = files
        .map((file) => String(file ?? '').trim())
        .filter(Boolean)
        .map((file) => toProjectPath(root, path.isAbsolute(file) ? file : path.resolve(root, file)));
    if (pictures.length) artifacts.pictures = pictures;

    return await publish(root, HOUSE_SYSTEMS.images, {
        delivery: `${projectRel(root, delivery)}/`,
        artifacts,
        extra,
    });
}
