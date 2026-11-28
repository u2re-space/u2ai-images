#!/usr/bin/env node
/**
 * @file bin/ai-image-parser-worker.js
 * @module bin/ai-image-parser-worker
 * @purpose The sandbox of the salvage script: the worker that runs the script of the model.
 *
 *   The script runs in a realm of `node:vm` inside this thread. The thread is a crash
 *   domain of its own: a script that hangs in an endless loop is stopped by the parent
 *   with `terminate()`, and the run of the picture lives.
 *
 *   The calls that need the host travel back to the parent: the writing of a file and the
 *   download of a link.
 *
 * @depends openai/parser-sandbox
 * @usedBy openai/parser, package bin
 * @ai.tags images, fallback, sandbox, worker
 * @ai.hint io
 */
import { parentPort } from 'node:worker_threads';
import { parserSandboxMain } from '../src/openai/parser-sandbox.js';

await parserSandboxMain({ port: parentPort });
