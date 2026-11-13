/**
 * @file src/core/shell.js
 * @module core/shell
 * @purpose Run a program and collect its output: the ImageMagick adapter is the only place of the
 *          package that starts a process.
 * @depends node:child_process
 * @exports runProgram
 * @ai.tags shell, process
 * @ai.hint io
 */

import { spawn } from 'node:child_process';

/**
 * Run a program and wait for it to finish.
 *
 * The output is capped: a program that writes more than the cap is stopped, so a runaway
 * command cannot fill the memory of the CLI.
 * @param {{ file: string, args?: string[], cwd?: string, env?: object, timeoutMs?: number,
 *   maxOutputBytes?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>}
 * @ai.hint io
 */
export function runProgram({
    file, args = [], cwd = process.cwd(), env = process.env,
    timeoutMs = 30_000, maxOutputBytes = 64 * 1024, signal = null,
} = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(file, args, { cwd, env, windowsHide: true });
        } catch (error) {
            reject(error);
            return;
        }
        const stdout = [];
        const stderr = [];
        let outBytes = 0;
        let errBytes = 0;
        let timedOut = false;
        let settled = false;

        /**
         * Finish the call once, with the collected output.
         * @param {{ exitCode: number }} result
         * @returns {void}
         * @ai.hint io
         */
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve({
                exitCode: result.exitCode,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                timedOut,
            });
        };

        /**
         * Stop the program when the caller cancels.
         * @returns {void}
         * @ai.hint io
         */
        const onAbort = () => {
            try { child.kill(); } catch { /* the process is already gone */ }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill(); } catch { /* the process is already gone */ }
        }, timeoutMs);

        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (chunk) => {
            if (outBytes >= maxOutputBytes) return;
            outBytes += chunk.length;
            stdout.push(chunk);
        });
        child.stderr?.on('data', (chunk) => {
            if (errBytes >= maxOutputBytes) return;
            errBytes += chunk.length;
            stderr.push(chunk);
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        child.on('close', (code) => finish({ exitCode: code ?? (timedOut ? 124 : 1) }));
    });
}
