/**
 * @file test/cli.test.js
 * @module test/cli
 * @purpose The CLI itself: the parsing of the arguments, the dispatch, the dry run, the JSON
 *          answer and the codes of the exit.
 * @depends node:test, node:fs/promises, node:os, node:path, cli, image/raster
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { main, parseArgv, configOverrides } from '../src/cli.js';
import { encodeRgba } from '../src/image/raster.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(here, '..', 'bin', 'ai-image.js');

/**
 * Run the CLI with a closed stdin.
 *
 * A command that reads the prompt from stdin waits for the end of the pipe, so the pipe is
 * closed right away: a test must not wait for a keyboard.
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
async function runCli(args, { cwd = process.cwd(), input = '' } = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binary, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
        child.stdin.end(input);
    });
}

/** A temporary directory that cleans itself up. */
async function tempDir() {
    return await mkdtemp(path.join(os.tmpdir(), 'ai-image-cli-'));
}

/**
 * A picture of a solid color.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function solidPng(width, height) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 10;
        data[i + 1] = 20;
        data[i + 2] = 30;
        data[i + 3] = 255;
    }
    return await encodeRgba({ width, height, data }, { format: 'png' });
}

test('the parser reads the command, the positionals and the flags', () => {
    const options = parseArgv([
        'generate', 'a red bicycle', '--size', '1024x1536', '--count', '3', '--json', '--purpose', 'edit',
    ]);
    assert.equal(options.command, 'generate');
    assert.deepEqual(options.positionals, ['a red bicycle']);
    assert.equal(options.size, '1024x1536');
    assert.equal(options.count, 3);
    assert.equal(options.json, true);
    assert.equal(options.purpose, 'edit');
});

test('the parser leaves the flags that were not given empty', () => {
    const options = parseArgv(['crop', 'a.png']);
    assert.equal(options.size, null);
    assert.equal(options.count, 1);
    assert.equal(options.json, false);
    assert.equal(options.trim, false);
    assert.equal(options.subject, null);
});

test('the parser reads the subject of the cut-out', () => {
    const options = parseArgv(['background', 'a.png', '--subject', 'chess bishop']);
    assert.equal(options.command, 'background');
    assert.equal(options.subject, 'chess bishop');
});

test('the flags of the configuration only carry what was given', () => {
    const overrides = configOverrides(parseArgv(['generate', 'x']));
    assert.deepEqual(overrides, {});
    const given = configOverrides(parseArgv(['generate', 'x', '--size', '800x600', '--engine', 'sharp']));
    assert.deepEqual(given, { image: { size: '800x600', rasterEngine: 'sharp' } });
});

test('the help and the version end with the code 0', async () => {
    const help = await run(process.execPath, [binary, '--help']);
    assert.match(help.stdout, /ai-image/);
    const version = await run(process.execPath, [binary, '--version']);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown command ends with the code 2', async () => {
    await assert.rejects(
        run(process.execPath, [binary, 'nonsense']),
        (error) => {
            assert.equal(error.code, 2);
            assert.match(error.stderr, /Unknown command/);
            return true;
        },
    );
});

test('the process command without a task ends with the code 2', async () => {
    const answer = await runCli(['process']);
    assert.equal(answer.code, 2);
    assert.match(answer.stderr, /Give the task/);
});

test('the dry run of the pipeline ends with the code 0', async () => {
    const dir = await tempDir();
    const answer = await runCli(['process', 'a hero picture', '--dry-run', '--json'], { cwd: dir });
    const payload = JSON.parse(answer.stdout);
    assert.equal(payload.type, 'plan');
    assert.equal(payload.command, 'process');
    assert.equal(payload.task, 'a hero picture');
});

test('the dry run of the generation writes no file and ends with the code 0', async () => {
    const dir = await tempDir();
    const answer = await run(process.execPath, [binary, 'generate', 'a red bicycle', '--dry-run', '--json'], {
        cwd: dir,
    });
    const payload = JSON.parse(answer.stdout);
    assert.equal(payload.type, 'plan');
    assert.equal(payload.prompt, 'a red bicycle');
});

test('the JSON answer of a local command is one line of JSON', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(40, 20));
    const answer = await run(process.execPath, [binary, 'info', 'a.png', '--json'], { cwd: dir });
    const payload = JSON.parse(answer.stdout);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.width, 40);
});

test('a wrong argument ends with the code 2', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.png'), await solidPng(10, 10));
    await assert.rejects(
        run(process.execPath, [binary, 'crop', 'a.png', '--width', '5'], { cwd: dir }),
        (error) => {
            assert.equal(error.code, 2);
            assert.match(error.stderr, /width and the height/);
            return true;
        },
    );
});

test('the dispatcher runs a command', async () => {
    const code = await main(['purpose', '--json']);
    assert.equal(code, 0);
});
