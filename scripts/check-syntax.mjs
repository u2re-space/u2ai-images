/**
 * @file scripts/check-syntax.mjs
 * @module scripts/check-syntax
 * @purpose Parse every file of the package: a syntax error must not wait for the day somebody
 *          runs the command that holds it.
 * @depends node:child_process, node:fs/promises, node:path
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file of a directory, recursively.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesOf(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await filesOf(full));
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

const files = [
    ...await filesOf(path.join(root, 'src')),
    ...await filesOf(path.join(root, 'bin')),
    ...await filesOf(path.join(root, 'test')),
    ...await filesOf(path.join(root, 'scripts')),
];

let failed = 0;
for (const file of files) {
    const code = await new Promise((resolve) => {
        execFile(process.execPath, ['--check', file], (error) => resolve(error ? 1 : 0));
    });
    if (code !== 0) {
        failed += 1;
        console.error(`the file is not parsed: ${path.relative(root, file)}`);
    }
}

console.log(`${files.length - failed} of ${files.length} files are parsed.`);
process.exit(failed ? 1 : 0);
