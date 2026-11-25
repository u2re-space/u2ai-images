/**
 * @file src/shared/worker.js
 * @module shared/worker
 * @purpose The worker of a system: the thread or the process that runs the cycle of the model
 *          and asks the parent for the tools.
 *
 *   The worker takes the spec of the work, runs the cycle of the model and sends every
 *   call of a tool back to the parent. It never runs a tool itself: the tools of the
 *   parent are the tools of the worker, and the parent is the one that holds them.
 *
 *   The worker speaks over one protocol and two transports: as a **thread** of the parent
 *   (the spec comes with the thread) and as a **process** of its own (the spec comes with
 *   the first frame of the channel). The cycle is the same in both.
 *
 *   The answer of the parent comes back as the result of the call, and the cycle goes on
 *   until the model gives the final answer. The report closes the worker.
 *
 *   The bytes travel as frames of kind `bytes` — a buffer that moves without a copy — or
 *   as frames of kind `base64`, for the transport that cannot move a buffer. The picture
 *   never goes through the file system.
 *
 * @depends node:worker_threads, node:child_process, node:path, node:url, shared/protocol,
 *          shared/shared
 * @usedBy agent/worker, client/interface
 * @exports WORKER_ENTRY, DEFAULT_TRANSPORT, channelOf, startWorker, runWorker, workerMain,
 *          spawnWorker
 * @ai.tags house, worker, threads, processes
 * @ai.hint io
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { createFrame, isFrame, bytesFrame, bytesOfFrame } from './protocol.js';

/** The transport a worker runs in, when the parent names none. */
export const DEFAULT_TRANSPORT = 'thread';

/**
 * The entry of the worker of a package.
 *
 * The path is resolved from this module: the worker lives in `bin/` of the package, and
 * the package is found from the module itself.
 *
 * @param {string} name the name of the file of the worker, e.g. `ai-image-agent-worker.js`
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function workerEntry(name) {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'bin',
        name,
    );
}

/**
 * One channel to the parent, whatever the transport is.
 *
 * A thread speaks `postMessage`; a process speaks `send`. Both hear `on('message')`. The
 * cycle of the worker does not know the difference.
 *
 * @param {object|null} port a MessagePort-like, a process-like, or null for this process
 * @returns {{ post: Function, postBytes: Function, on: Function, off: Function, close: Function }|null}
 * @exports
 * @ai.hint pure
 */
export function channelOf(port = null) {
    const raw = port ?? (typeof process?.send === 'function' ? process : null);
    if (!raw) return null;
    if (typeof raw.postMessage === 'function') {
        // A thread: the port speaks postMessage, and it does not close by hand.
        return {
            post: (frame) => raw.postMessage(frame),
            // The bytes travel as a frame with its own buffer: the transfer moves the
            // memory, and the parent reads it without a copy.
            postBytes: (frame, transfer = []) => raw.postMessage(frame, transfer),
            on: (fn) => raw.on('message', fn),
            off: (fn) => raw.off?.('message', fn),
            close: () => {},
        };
    }
    // A process: the channel speaks send, and it closes with the process.
    return {
        post: (frame) => {
            if (typeof raw.send !== 'function' || raw.connected === false) return;
            try { raw.send(frame); } catch { /* The parent is gone. */ }
        },
        // A process cannot move a buffer: the bytes travel as base64 there.
        postBytes: (frame) => {
            if (typeof raw.send !== 'function' || raw.connected === false) return;
            try { raw.send(frame); } catch { /* The parent is gone. */ }
        },
        on: (fn) => raw.on('message', fn),
        off: (fn) => raw.off?.('message', fn),
        close: () => {
            try { raw.disconnect?.(); } catch { /* Already closed. */ }
        },
    };
}

/**
 * Start the worker in the transport the parent named, and give back one channel.
 *
 * The channel speaks the words of an EventEmitter — `on(kind, listener)`, `off`,
 * `post`, `stop` — whatever the transport is: a thread and a process are both
 * EventEmitters, and the cycle of the worker does not know which one carries it.
 * The kinds are `message`, `error` and `exit`.
 *
 * @param {object} spec the spec of the work
 * @param {{ transport?: 'thread'|'process', entry?: string, env?: object, cwd?: string,
 *   signal?: AbortSignal|null }} [options]
 * @returns {{ post: Function, postBytes: Function, on: Function, off: Function, stop: Function,
 *   alive: Function, pid: number|null }}
 * @exports
 * @ai.hint io
 */
export function startWorker(spec, options = {}) {
    const transport = String(options.transport ?? DEFAULT_TRANSPORT).trim().toLowerCase() === 'process'
        ? 'process'
        : 'thread';
    const entry = options.entry ?? workerEntry('ai-worker.js');
    if (transport === 'process') {
        const child = fork(entry, [], {
            cwd: options.cwd ?? process.cwd(),
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            windowsHide: true,
        });
        // The spec comes with the first frame: the process has no `workerData`.
        try { child.send(createFrame('spawn', { spec })); } catch { /* The child is gone. */ }
        return {
            post: (frame) => {
                if (!child.connected) return;
                try { child.send(frame); } catch { /* The worker is gone. */ }
            },
            postBytes: (frame) => {
                if (!child.connected) return;
                try { child.send(frame); } catch { /* The worker is gone. */ }
            },
            on: (kind, fn) => child.on(kind, fn),
            off: (kind, fn) => child.off?.(kind, fn),
            stop: () => {
                if (child.connected) {
                    try { child.disconnect(); } catch { /* Already gone. */ }
                }
                if (child.exitCode === null && !child.signalCode) child.kill();
            },
            alive: () => child.exitCode === null && !child.signalCode,
            pid: child.pid ?? null,
        };
    }
    const worker = new Worker(entry, {
        workerData: { spec },
        env: process.env,
        stdout: false,
        stderr: false,
    });
    return {
        post: (frame) => worker.postMessage(frame),
        postBytes: (frame, transfer = []) => worker.postMessage(frame, transfer),
        on: (kind, fn) => worker.on(kind, fn),
        off: (kind, fn) => worker.off?.(kind, fn),
        stop: () => { worker.terminate?.(); },
        alive: () => true,
        pid: worker.threadId ?? null,
    };
}

/**
 * Run the worker of a system.
 *
 * The worker sends the calls of the tools to the parent and waits for their answers: a
 * call without an answer would break the cycle, so a call that nobody answers is
 * answered with the failure of the tool.
 *
 * @param {{ spec: object, port?: object|null, client?: object|null, signal?: AbortSignal|null,
 *   run?: Function }} request
 * @returns {Promise<object>} the report of the work
 * @exports
 * @ai.hint io
 */
export async function runWorker({ spec, port = null, client = null, signal = null, run = null } = {}) {
    const channel = channelOf(port);
    if (!channel) throw new Error('The worker has no channel to the parent.');
    const pending = new Map();
    let counter = 0;
    let closed = false;

    const send = (frame) => {
        if (closed) return;
        channel.post(frame);
    };

    const onCall = async (call) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        send(createFrame('call', { id, name: call?.name, arguments: call?.arguments ?? {} }));
        return await answer;
    };

    /**
     * The bytes of a tool: they travel in their own frame, so a picture never goes
     * through the file system.
     *
     * @param {Uint8Array|Buffer} payload the bytes
     * @param {{ name?: string, mime?: string }} [meta] what the bytes are
     * @returns {void}
     * @ai.hint io
     */
    const onBytes = (payload, meta = {}) => {
        if (closed) return;
        const { frame, transfer } = bytesFrame(payload, meta);
        channel.postBytes?.(frame, transfer);
    };

    const onMessage = (frame) => {
        if (!frame || frame.type !== 'result') return;
        const resolve = pending.get(String(frame.id ?? ''));
        if (!resolve) return;
        pending.delete(String(frame.id ?? ''));
        resolve(frame.output);
    };
    channel.on(onMessage);

    const onEvent = (event) => {
        send(createFrame('status', { event }));
    };

    let report;
    try {
        if (typeof run !== 'function') throw new Error('The worker has no cycle to run.');
        report = await run({ spec, client, onCall, onBytes, onEvent, signal });
    } catch (error) {
        report = {
            ok: false,
            role: String(spec?.role?.name ?? ''),
            name: String(spec?.name ?? ''),
            turns: 0,
            files: [],
            report: `The worker died: ${error?.message ?? String(error)}`,
            error: error?.message ?? String(error),
            stopped: 'failed',
        };
    }
    channel.off(onMessage);
    send(createFrame('report', { report }));
    closed = true;
    channel.close();
    return report;
}

/**
 * The entry of the worker.
 *
 * As a thread, the spec comes with the thread (`workerData`). As a process, the spec
 * comes with the first frame of the channel (`spawn`). The cycle is the same.
 *
 * @param {{ data?: object|null, port?: object|null, run?: Function }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function workerMain({ data = null, port = null, run = null } = {}) {
    const payload = data ?? workerData ?? null;
    if (payload && typeof payload === 'object' && payload.spec) {
        // The thread of the parent: the spec came with the thread.
        return await runWorker({ spec: payload.spec, port: port ?? parentPort, run });
    }
    // The process of its own: the spec comes with the first frame of the channel.
    const channel = port ?? (typeof process?.send === 'function' ? process : null);
    if (!channel) throw new Error('The worker was started with no channel and no spec.');
    const adapter = channelOf(channel);
    const spec = await new Promise((resolve) => {
        const onMessage = (frame) => {
            if (!frame || frame.type !== 'spawn') return;
            adapter.off(onMessage);
            resolve(frame.spec ?? {});
        };
        adapter.on(onMessage);
    });
    return await runWorker({ spec, port: channel, run });
}

/**
 * Start a worker without waiting for it.
 *
 * The parent gets the handle of the worker right away and listens to its events. The
 * report comes with the `report` event of the handle.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string, run?: Function }} request
 * @returns {{ handle: object, done: Promise<object> }}
 * @exports
 * @ai.hint io
 */
export function spawnWorker({ spec, onCall = null, onEvent = null, onCancel = null, signal = null,
    transport = null, entry = null, env = null, cwd = null, run = null } = {}) {
    const worker = startWorker(spec, { transport, entry, env, cwd, signal });
    const handle = {
        role: String(spec?.role?.name ?? ''),
        name: String(spec?.name ?? '') || String(spec?.role?.name ?? '') || 'worker',
        files: Array.isArray(spec?.files) ? spec.files : [],
        tools: Array.isArray(spec?.role?.tools) ? spec.role.tools : [],
        worker,
        /**
         * Is the worker still alive?
         * @returns {boolean}
         */
        alive() {
            if (typeof worker.alive === 'function') return worker.alive();
            return true;
        },
        /**
         * Stop the worker.
         * @returns {void}
         */
        stop() {
            worker.stop();
        },
    };
    const done = runWorkerCycle({ spec, onCall, onEvent, onCancel, signal, worker, run });
    return { handle, done };
}

/**
 * Run one worker to its report: the parent side of the cycle.
 *
 * The cycle of the model runs in the worker; every call of a tool travels back to the
 * parent, and `onCall` runs it. A call that the parent refuses is answered as the failure
 * of the tool, and the model reads that answer — a refusal is a fact of the work, not the
 * end of the cycle.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string, worker?: object|null, run?: Function }} request
 * @returns {Promise<object>} the report of the work
 * @exports
 * @ai.hint io
 */
export async function runWorkerCycle({ spec, onCall = null, onEvent = null, onCancel = null,
    signal = null, transport = null, entry = null, env = null, cwd = null, worker: given = null,
    run = null } = {}) {
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const role = String(spec?.role?.name ?? '');
    const name = String(spec?.name ?? '') || role || 'worker';

    const worker = given ?? startWorker(spec, { transport, entry, env, cwd, signal });

    return await new Promise((resolve) => {
        let settled = false;
        let keepAlive = null;
        const finish = (report) => {
            if (settled) return;
            settled = true;
            if (keepAlive) clearInterval(keepAlive);
            resolve(report);
        };
        const onAbort = () => {
            // The flag of cancellation goes into the shared memory first: the thread sees
            // it between its turns, without a message round trip.
            try { onCancel?.(); } catch { /* The buffer is gone with the thread. */ }
            emit({ type: 'status', role, name, status: 'aborted' });
            worker.stop();
            finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: 'The worker was stopped before it answered.',
                error: 'aborted',
                stopped: 'aborted',
            });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // The heart of a worker that is not the parent: a parent that dies leaves the
        // orphan no sign of it. The beat is cheap, and the child checks it.
        keepAlive = setInterval(() => {
            if (!worker.alive?.()) finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: 'The worker ended without a report.',
                error: 'no-report',
                stopped: 'failed',
            });
        }, 2000);
        keepAlive.unref?.();
        worker.on('message', async (frame) => {
            if (!isFrame(frame)) return;
            if (frame.type === 'call') {
                // The call of a tool of the worker: the parent runs it.
                let output = '';
                try {
                    const answer = await onCall?.({
                        name: String(frame.name ?? ''),
                        arguments: frame.arguments ?? {},
                    });
                    // The tool may answer with bytes as well as with text: the bytes
                    // travel in their own frame, and the text names them.
                    const bytes = answer?.bytes ?? null;
                    if (bytes) {
                        const { frame: bytesFrameOf, transfer } = bytesFrame(bytes, {
                            name: answer?.name ?? '',
                            mime: answer?.mime ?? '',
                        });
                        worker.postBytes?.(bytesFrameOf, transfer);
                        output = String(answer?.text ?? '');
                    } else {
                        output = String(answer ?? '');
                    }
                } catch (error) {
                    output = `The tool failed: ${error?.message ?? String(error)}`;
                }
                worker.post(createFrame('result', { id: frame.id, output }));
                return;
            }
            if (frame.type === 'bytes') {
                // The bytes of a tool of the worker: they travel without a copy.
                emit({ type: 'bytes', bytes: bytesOfFrame(frame), name: frame.name ?? '', mime: frame.mime ?? '' });
                return;
            }
            if (frame.type === 'status') {
                emit(frame.event ?? {});
                return;
            }
            if (frame.type === 'report') {
                signal?.removeEventListener('abort', onAbort);
                finish(frame.report ?? {
                    ok: false, role, name, turns: 0, files: [],
                    report: 'No report.', error: 'no-report', stopped: 'failed',
                });
                worker.stop();
            }
        });
        worker.on('error', (error) => {
            signal?.removeEventListener('abort', onAbort);
            finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: `The worker died: ${error?.message ?? String(error)}`,
                error: error?.message ?? String(error),
                stopped: 'failed',
            });
        });
        worker.on('exit', () => {
            signal?.removeEventListener('abort', onAbort);
            if (!settled) {
                finish({
                    ok: false,
                    role,
                    name,
                    turns: 0,
                    files: [],
                    report: 'The worker ended without a report.',
                    error: 'no-report',
                    stopped: 'failed',
                });
            }
        });
    });
}
