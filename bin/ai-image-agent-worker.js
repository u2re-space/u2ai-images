#!/usr/bin/env node
/**
 * @file bin/ai-image-agent-worker.js
 * @module bin/ai-image-agent-worker
 * @purpose The worker of the images system: the thread or the process that runs the cycle.
 *
 *   As a thread of the parent, the spec comes with the thread. As a process of its own,
 *   the spec comes with the first frame of the channel. Both carry the same cycle of the
 *   model, and both send the calls of the tools back to the parent: the worker never
 *   touches a file by itself.
 *
 * @depends agent/worker-runner
 * @usedBy agent/worker-runner, package bin
 * @ai.tags house, images, worker
 * @ai.hint io
 */
import { parentPort } from 'node:worker_threads';
import { createImageWorker } from '../src/agent/worker-runner.js';

await createImageWorker({ port: parentPort });
