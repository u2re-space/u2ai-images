/**
 * @file src/agent/code-mode.js
 * @module agent/code-mode
 * @purpose Code Mode from the side of the parent: the tool that runs a program of the model.
 *
 *   The model asks for Code Mode with one call: it writes a program, and the program does
 *   the work. The parent runs the program in the sandbox and gives the model the answer.
 *
 *   The parent keeps everything that matters: the rights of the tools, the rules of the
 *   access, the map of the run and the log of the work. The sandbox gets a catalogue of
 *   the tools the model may call, and every call travels back here to be run by the
 *   executor of the parent — with the same rules and the same rights as a direct call.
 *
 *   The tools the program may call are the tools the model was given in this turn, minus
 *   the ones that would call the model again: a program that starts a role of its own
 *   would nest a loop inside a loop.
 *
 *   Code Mode is a **write**: the program may change the project through the tools of the
 *   parent. It is therefore behind the write gate of the role, and the turn that carries
 *   it earns the budget of the write.
 *
 * @depends shared/code-mode, agent/tools
 * @usedBy agent/tool-specs, roles/index
 * @exports CODE_MODE_TOOL, codeModeToolSpec, codeModeInstruction, createCodeModeRunner,
 *          codeModeBudgetFor
 * @ai.tags house, code-mode, agent, sandbox
 * @ai.hint io
 */

import { CODE_MODE_LIMITS, runCodeModeWorker, createCodeModeSpec } from '../shared/code-mode.js';

/** The name of the tool that runs a program of the model. */
export const CODE_MODE_TOOL = 'code_mode';

/**
 * The tools the program may not call.
 *
 * A program that starts a role of its own nests a loop inside a loop: the sandbox calls
 * the parent, the parent calls the model, the model calls the sandbox again. The run ends
 * in a budget nobody set.
 */
const FORBIDDEN_IN_CODE = Object.freeze(['subagent', 'code_mode', 'ask_user']);

/**
 * The spec of the tool of Code Mode, as the model sees it.
 *
 * @returns {object} the tool in the shape of the Responses API
 * @exports
 * @ai.hint pure
 */
export function codeModeToolSpec() {
    return {
        type: 'function',
        name: CODE_MODE_TOOL,
        description: 'Write a JavaScript program and run it in a sandbox, instead of calling the '
            + 'tools one by one. The program runs in its own worker with its own realm: it has no '
            + 'process, no require and no network, and it cannot touch the disk by itself — but it '
            + 'may call your tools, and every call travels back to this process, which runs it with '
            + 'your rights and your rules. Use it when the work is a sequence of many calls: reading '
            + 'five files and merging them is one program, not six round trips. The program may '
            + 'await, and it may return the answer of the step. Inside it: `await tools.<name>(args)` '
            + 'calls a tool; `catalogue.names` lists the tools you may call; `fs` is a file system '
            + 'in the memory; `shared` is the shared block of the run; `allocate(bytes)` gives a '
            + 'block of memory; `console.log` writes to the output of the run. The libraries of the '
            + 'house are there too: `await library.catalog()` names them, and '
            + '`await library.call("canvas.createCanvas", [800, 600])` calls them — the sandbox '
            + 'has no import, so a library is reached by its name and its member. A native object '
            + 'comes back as an id, and the id is the beginning of the path of the next call. The '
            + 'program runs sandboxed: a loop that never ends is stopped, and a mistake is an '
            + 'error, not a crash of the run. This tool writes: it is behind the write gate, and '
            + 'it earns the budget of the write.',
        parameters: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The program. The body of an async function: it may await, and it '
                        + 'may return the answer of the step. The tools are called as '
                        + '`await tools.name({ ... })`.',
                },
                purpose: {
                    type: 'string',
                    description: 'One sentence: what the program has to do. It is written into the '
                        + 'report of the run.',
                },
                timeoutMs: {
                    type: 'integer',
                    description: `How long the program may run, in milliseconds. The default is ${CODE_MODE_LIMITS.timeoutMs}.`,
                },
            },
            required: ['code'],
            additionalProperties: false,
        },
    };
}

/**
 * The note that tells a role how Code Mode works.
 *
 * The note goes into the instructions of the role, so the model knows the tool before it
 * spends a turn on it.
 *
 * @param {string[]} names the tools the program may call
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function codeModeInstruction(names = []) {
    const list = Array.isArray(names) ? names.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
    return [
        '## Code Mode',
        'You may write a program instead of calling the tools one by one. Call `code_mode` with the',
        'body of an async function; the program runs in a sandbox of its own, and every tool it calls',
        'travels back to this process, which runs it with your rights and your rules.',
        '',
        '```js',
        'const a = await tools.read_file({ path: "a.txt" });',
        'const b = await tools.read_file({ path: "b.txt" });',
        'return { merged: a + b };',
        '```',
        '',
        'Inside the program:',
        '- `await tools.<name>({ ... })` — calls a tool of this step. The answer is the text the tool returned.',
        '- `catalogue.names` — the tools you may call. `catalogue.describe(name)` — what one of them does.',
        '- `fs` — a file system in the memory: `readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `unlink`.',
        '- `shared` — the shared block of the run: `shared.view` is a byte view of it.',
        '- `allocate(bytes)` — a block of memory; the pages are taken when the bytes are written.',
        '- `console.log` — the output of the program, which comes back to you with the answer.',
        '',
        'The libraries of the house are there as well. The sandbox has no `import`, so a library is',
        'reached by its name and its member:',
        '',
        '```js',
        'const catalog = await library.catalog();   // what is installed here',
        'const surface = await library.call("canvas.createCanvas", [800, 600]);',
        'const ctx = await library.call(surface + ".getContext", ["2d"]);',
        'await library.call(ctx + ".fillRect", [0, 0, 800, 600]);',
        'const png = await library.call(surface + ".toDataURL", ["image/png"]);',
        '```',
        '',
        '- `library.catalog()` — the libraries that are installed, and the calls each of them offers.',
        '- `library.call(path, args)` — one call. The path is the library and its member, or the id of',
        '  a handle and its member.',
        '- `library.buffer(bytes)` — the bytes of an argument, when a library wants a binary one.',
        '- `library.base64(bytes)` / `library.bytes(text)` / `library.text(bytes)` — the bytes.',
        '',
        'A native object — a canvas, a document — comes back as an id, and the id is the beginning of',
        'the path of the next call. A call that fails throws, and the program may catch it.',
        '',
        'The program is sandboxed: it has no `process`, no `require` and no network, a loop that never',
        'ends is stopped, and a mistake is an error you can read. It writes through your tools, so it',
        'is behind the write gate like any other write.',
        list.length ? `The tools of this program: ${list.join(', ')}.` : '',
    ].filter(Boolean).join('\n');
}

/**
 * The budget of the turn that carries a program.
 *
 * A program is a write: it may change the project through the tools of the parent. The turn
 * that carries it earns the budget of the write and not the reduced one of the
 * inspection.
 *
 * A program is text too: the model writes the program, and the program writes the files.
 * The budget of the write is often not enough for the program itself, so the turn that
 * carries a program gets more room — the factor of the config, clamped by the ceiling of
 * the config and by the cap of the model.
 *
 * @param {number|null} cap the cap of the model
 * @param {boolean} writing is the turn a write
 * @param {{ factor?: number, ceiling?: number }} [options] the knobs of the config
 * @returns {number|null} the budget of the turn
 * @exports
 * @ai.hint pure
 */
export function codeModeBudgetFor(cap = null, writing = false, { factor = 2, ceiling = 65_536 } = {}) {
    if (!Number.isSafeInteger(cap) || cap <= 0) return null;
    // The inspection turn has the reduced budget of the read.
    if (!writing) return Math.max(4, Math.floor(cap / 8));
    const mult = Number.isSafeInteger(factor) && factor > 0 ? factor : 1;
    const room = Math.min(Math.floor(cap * mult), ceiling);
    // The budget of the write is never smaller than what the model would take anyway.
    return Math.max(cap, room);
}

/**
 * The runner of Code Mode: the tool that runs a program of the model.
 *
 * The runner holds the executor of the parent and the catalogue of the tools the program
 * may call. Every call of the program travels back here and is run by the executor.
 *
 * @param {{ execute?: Function|null, specs?: object[], tools?: string[],
 *   timeoutMs?: number, onEvent?: Function|null, signal?: AbortSignal|null,
 *   shared?: SharedArrayBuffer|null }} options
 *   `execute` runs a tool of the parent: `async (name, args) => text`.
 * @returns {(args: object) => Promise<string>}
 * @exports
 * @ai.hint io
 */
export function createCodeModeRunner({
    execute = null,
    specs = [],
    tools = null,
    timeoutMs = CODE_MODE_LIMITS.timeoutMs,
    onEvent = null,
    signal = null,
    shared = null,
    facilities = null,
} = {}) {
    /**
     * The catalogue of the tools the program may call.
     *
     * The tools of the turn are the tools of the model: a program may not call more than
     * the model itself may call. The tools that would call the model again are not in the
     * catalogue at all.
     *
     * @returns {Array<{ name: string, description: string, parameters: object }>}
     */
    const catalogue = () => {
        const named = Array.isArray(tools) ? new Set(tools) : null;
        const out = [];
        for (const spec of Array.isArray(specs) ? specs : []) {
            const name = String(spec?.name ?? '').trim();
            if (!name) continue;
            if (FORBIDDEN_IN_CODE.includes(name)) continue;
            if (named && !named.has(name)) continue;
            out.push({
                name,
                description: String(spec?.description ?? ''),
                parameters: spec?.parameters ?? null,
            });
        }
        return out;
    };

    return async function run(args = {}) {
        const code = String(args?.code ?? '');
        const wanted = Number.isSafeInteger(Number(args?.timeoutMs)) && Number(args.timeoutMs) > 0
            ? Number(args.timeoutMs)
            : timeoutMs;
        if (!code.trim()) {
            return 'The program is empty: write the code of the program, or call the tools directly.';
        }
        // The facilities of the host: the calls the house offers and the libraries do not —
        // the API of the pictures, for one. The functions behind them live in the parent,
        // so the call travels back there over the frame protocol.
        const facilityMap = facilities && typeof facilities === 'object' ? facilities : null;
        const facilityNames = facilityMap
            ? Object.keys(facilityMap).map((item) => String(item).trim()).filter(Boolean)
            : [];
        const report = await runCodeModeWorker({
            spec: createCodeModeSpec({
                code,
                tools: catalogue(),
                timeoutMs: wanted,
                shared: shared ?? null,
                facilities: facilityNames,
            }),
            onCall: async (call) => {
                if (typeof execute !== 'function') {
                    throw new Error('This run has no executor for the tools.');
                }
                return await execute(call.name, call.arguments ?? {});
            },
            onFacility: async (path, args) => {
                const facility = facilityMap?.[path];
                if (typeof facility !== 'function') {
                    throw new Error(`There is no facility named ${path}.`);
                }
                return await facility(args ?? {});
            },
            onEvent,
            signal,
        });

        if (!report.ok) {
            const reason = report.reason === 'timeout'
                ? `The program did not finish in ${wanted} ms. It was stopped.`
                : (report.error || 'The program failed.');
            return [
                `The program did not run: ${reason}`,
                report.output ? `The output before the failure:\n${report.output}` : '',
                'Fix the program and call it again.',
            ].filter(Boolean).join('\n');
        }

        const answer = report.value;
        const text = answer === null || answer === undefined
            ? ''
            : (typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
        const used = report.calls.map((call) => call.name);
        return [
            'The program ran.',
            used.length ? `The tools it called: ${used.join(', ')}.` : 'It called no tool.',
            report.output ? `The output of the program:\n${report.output}` : '',
            report.error ? `The errors of the program:\n${report.error}` : '',
            text ? `The answer:\n${text}` : 'It returned nothing.',
        ].filter(Boolean).join('\n');
    };
}
