/**
 * @file src/core/prompt.js
 * @module core/prompt
 * @purpose Read the prompt of a command: from the arguments, or from stdin when the arguments
 *          carry none.
 * @depends node:fs/promises
 * @usedBy commands/generate, commands/edit, commands/decorate, commands/process
 * @exports readStdin, readPrompt
 * @ai.tags prompt, stdin
 * @ai.hint io
 */

import { MiB } from '../config/constants.js';

/**
 * Read the whole of stdin, but not more than the limit.
 *
 * A terminal is never read: a person at a terminal types the prompt as an argument, and reading
 * the keyboard would hang the run.
 * @param {{ maxBytes?: number, stream?: NodeJS.ReadableStream|null }} [options]
 * @returns {Promise<string>} the text, empty when there was nothing to read
 * @exports
 * @ai.hint io
 */
export async function readStdin({ maxBytes = 4 * MiB, stream = process.stdin } = {}) {
    if (!stream || stream.isTTY) return '';
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw new Error(`The text on stdin is larger than the limit of ${maxBytes} bytes.`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * The prompt of a command: the arguments first, stdin second.
 *
 * The arguments win: a person who typed a prompt and forgot to close the pipe must not have
 * their prompt replaced by the noise of the pipe.
 * @param {{ positionals?: string[], config?: object|null, stream?: NodeJS.ReadableStream|null }} options
 * @returns {Promise<string>} the prompt, empty when there is none
 * @exports
 * @ai.hint io
 */
export async function readPrompt({ positionals = [], config = null, stream = process.stdin } = {}) {
    const typed = positionals.map((value) => String(value)).join(' ').trim();
    if (typed) return typed;
    const limit = config?.limits?.maxStdinBytes ?? 4 * MiB;
    return (await readStdin({ maxBytes: limit, stream })).trim();
}
