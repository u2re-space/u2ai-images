#!/usr/bin/env node
/**
 * @file bin/ai-image-code-mode-worker.js
 * @module bin/ai-image-code-mode-worker
 * @purpose The sandbox of Code Mode: the worker that runs the program of the model.
 *
 *   The program runs in a realm of `node:vm` inside this thread. The thread is a crash
 *   domain of its own: a program that hangs in an endless loop is stopped by the parent
 *   with `terminate()`, and the parent lives.
 *
 *   The calls of the tools travel back to the parent: the sandbox never runs a tool
 *   itself, and it never touches a file by itself.
 *
 * @depends shared/code-mode
 * @usedBy shared/code-mode, package bin
 * @ai.tags house, code-mode, sandbox, worker
 * @ai.hint io
 */
import { parentPort } from 'node:worker_threads';
import { codeModeMain } from '../src/shared/code-mode.js';

await codeModeMain({ port: parentPort });
