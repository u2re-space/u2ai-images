/**
 * @file test/syntax.test.js
 * @module test/syntax
 * @purpose Every file of the package is parsed: a syntax error must not wait for the day
 *          somebody runs the command that holds it.
 * @depends node:test, node:child_process, node:fs/promises, node:path
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/**
 * Every file of a directory, recursively.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesOf(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await filesOf(full));
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

test('every file of src/ and bin/ is parsed', async () => {
    const files = [...await filesOf(path.join(root, 'src')), ...await filesOf(path.join(root, 'bin'))];
    assert.ok(files.length > 30, 'the package has files to check');
    for (const file of files) {
        await assert.doesNotReject(
            run(process.execPath, ['--check', file]),
            `${path.relative(root, file)} is parsed`,
        );
    }
});
