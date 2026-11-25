/**
 * @file src/agent/worker-runner.js
 * @module agent/worker-runner
 * @purpose The API of the worker of the images system: how a parent starts a worker that
 *          runs an inherited role.
 *
 *   A parent — the pipeline of the CLI, or another system of the house — starts a worker
 *   with one call:
 *
 *   ```js
 *   const report = await runImageWorker({
 *       spec: { role: { name: 'artist', instructions }, goal, files },
 *       onCall: (call) => tools.execute(call.name, call.arguments),
 *   });
 *   ```
 *
 *   The worker is **separate** from the parent: it has its own conversation and its own
 *   budget of turns. Two transports carry that separation:
 *
 *   - `'thread'` (default) — a worker thread of the parent process. The project, the env
 *     and the tools are shared by nature; the conversation is not. The shared memory
 *     crosses here, and the pictures travel as buffers.
 *   - `'process'` — a child process of the parent. The worker lives in its own process
 *     (`bin/ai-image-agent-worker.js`), the spec and the calls of the tools travel over
 *     IPC. A parent that wants its runs apart names this transport.
 *
 *   In both, the tools of the worker are the tools of the parent: the worker asks, the
 *   parent runs.
 *
 * @depends shared/worker, agent/worker, shared/shared
 * @usedBy commands/process, agent/pipeline, src/index.js
 * @exports IMAGE_WORKER_ENTRY, DEFAULT_TRANSPORT, runImageWorker, spawnImageWorker,
 *          createImageWorker
 * @ai.tags house, images, worker, client
 * @ai.hint io
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker, runWorkerCycle, spawnWorker, workerMain, workerEntry } from '../shared/worker.js';
import { normalizeImageSpec, runImageCycle } from './worker.js';
import { createSharedBlock, sharedAvailable } from '../shared/shared.js';

/** The entry of the worker of the images system. */
export const IMAGE_WORKER_ENTRY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bin',
    'ai-image-agent-worker.js',
);

/** The transport a worker runs in, when the parent names none. */
export const DEFAULT_TRANSPORT = 'thread';

/**
 * Run one worker of the images system to its report.
 *
 * The cycle of the model runs in the worker; every call of a tool travels back to the
 * parent, and `onCall` runs it. A call that the parent refuses is answered as the failure
 * of the tool, and the model reads that answer — a refusal is a fact of the work, not the
 * end of the cycle.
 *
 * The shared memory of the hand-over is used when the transport is a thread: the parent
 * writes the instructions of the role and the notes of the context into one buffer, and
 * the worker reads them from there — one copy in the memory, not two.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string, client?: object|null, worker?: object|null }} request
 * @returns {Promise<object>} the report of the work
 * @exports
 * @ai.hint io
 */
export async function runImageWorker({
    spec: rawSpec,
    onCall = null,
    onEvent = null,
    onCancel = null,
    signal = null,
    transport = null,
    entry = null,
    env = null,
    cwd = null,
    client = null,
    worker: given = null,
} = {}) {
    const spec = normalizeImageSpec(rawSpec);
    const useShared = String(transport ?? DEFAULT_TRANSPORT).trim().toLowerCase() !== 'process'
        && sharedAvailable();
    const shared = useShared
        ? createSharedBlock({
            instructions: spec.role.instructions,
            notes: spec.context.notes,
        })
        : null;
    const withShared = shared
        ? { ...spec, shared: shared.buffer, role: { ...spec.role, instructions: '' }, context: { ...spec.context, notes: '' } }
        : spec;

    return await runWorkerCycle({
        spec: withShared,
        onCall,
        onEvent,
        // The stop of the run travels into the shared memory: the thread sees the flag
        // between its turns, without a message round trip.
        onCancel: shared ? () => shared.cancel() : onCancel,
        signal,
        transport,
        entry: entry ?? IMAGE_WORKER_ENTRY,
        env,
        cwd,
        worker: given,
        run: runImageCycle,
    });
}

/**
 * Start a worker of the images system without waiting for it.
 *
 * The parent gets the handle of the worker right away and listens to its events. The
 * report comes with the `done` promise.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string }} request
 * @returns {{ handle: object, done: Promise<object> }}
 * @exports
 * @ai.hint io
 */
export function spawnImageWorker({ spec: rawSpec, onCall = null, onEvent = null, onCancel = null,
    signal = null, transport = null, entry = null, env = null, cwd = null } = {}) {
    const spec = normalizeImageSpec(rawSpec);
    const worker = spawnWorker({
        spec,
        onCall,
        onEvent,
        onCancel,
        signal,
        transport,
        entry: entry ?? IMAGE_WORKER_ENTRY,
        env,
        cwd,
        run: runImageCycle,
    });
    return worker;
}

/**
 * The worker of the images system, as a child process of the parent.
 *
 * The entry of the worker: as a thread the spec comes with the thread, as a process it
 * comes with the first frame of the channel.
 *
 * @param {{ data?: object|null, port?: object|null }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function createImageWorker({ data = null, port = null } = {}) {
    return await workerMain({ data, port, run: runImageCycle });
}

export { runWorker, workerEntry } from '../shared/worker.js';
export { IMAGE_TOOLS, normalizeImageSpec, runImageCycle } from './worker.js';
