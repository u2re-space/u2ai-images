/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose Terminal renderer for the image commands: what is going to happen, what came back,
 *          and where the files landed.
 * @exports createRenderer, createPlainRenderer, detectMode, planLine
 * @ai.hint keep
 */
import { COLORS, paint } from './colors.js';

/**
 * Detect terminal output mode.
 * @returns {'tty'|'pipe'}
 */
export function detectMode() {
    return process.stdout.isTTY ? 'tty' : 'pipe';
}

/**
 * The line of a plan: the model, the frame, the format and where the result goes.
 *
 * One line says everything the caller wants to know before the money is spent: which model
 * serves the request, of what frame, in what format, and into which directory.
 * @param {{ model?: string|null, size?: string|null, resolution?: string|null,
 *   format?: string|null, output?: string|null, purpose?: string|null }} details
 * @returns {string}
 */
export function planLine({ model, size, resolution, format, output, purpose } = {}) {
    const parts = [];
    if (model) parts.push(model);
    if (purpose) parts.push(purpose);
    if (size && size !== 'auto') parts.push(size);
    if (resolution) parts.push(resolution);
    if (format) parts.push(format);
    const head = parts.join(' · ');
    return output ? `${head} → ${output}` : head;
}

/**
 * A renderer without colors, for a pipe.
 *
 * A run whose output is piped somewhere — a CI log, a file, another program — has to leave
 * something behind. The colored renderer is for a person at a terminal; this one is for the
 * reader on the other side of the pipe.
 * @param {{ verbose?: boolean }} [opts]
 * @returns {{ line: Function, json: Function, event: Function, plan: Function, progress: Function, files: Function }}
 */
export function createPlainRenderer({ verbose = false } = {}) {
    return {
        line(kind, text) {
            if (kind === 'fail') console.error(text);
            else if (kind === 'warn') console.warn(text);
            else console.log(text);
        },
        json(payload) {
            console.log(JSON.stringify(payload));
        },
        event(event) {
            if (!event || !event.type) return;
            if (event.type === 'verbose' && !verbose) return;
            this.line(event.kind ?? 'info', event.text ?? JSON.stringify(event));
        },
        plan(details) {
            const text = planLine(details);
            if (text) console.log(text);
        },
        progress(text) {
            console.log(`· ${text}`);
        },
        files(list) {
            for (const file of list ?? []) console.log(file);
        },
    };
}

/**
 * Create the renderer for a terminal.
 * @param {{ verbose?: boolean }} [opts]
 * @returns {{ line: Function, json: Function, event: Function, plan: Function, progress: Function, files: Function }}
 */
export function createRenderer({ verbose = false } = {}) {
    const colorOf = {
        info: COLORS.dim,
        ok: COLORS.green,
        warn: COLORS.yellow,
        fail: COLORS.red,
        step: COLORS.cyan,
        result: COLORS.bold,
    };
    const prefixOf = {
        info: '',
        ok: '✓ ',
        warn: '⚠ ',
        fail: '✗ ',
        step: '▶ ',
        result: '',
    };
    return {
        line(kind, text) {
            const color = colorOf[kind] ?? '';
            const prefix = prefixOf[kind] ?? '';
            const line = `${prefix}${text}`;
            if (kind === 'fail') console.error(paint(line, color));
            else if (kind === 'warn') console.warn(paint(line, color));
            else console.log(paint(line, color));
        },
        json(payload) {
            console.log(JSON.stringify(payload));
        },
        event(event) {
            if (!event || !event.type) return;
            if (event.type === 'verbose' && !verbose) return;
            this.line(event.kind ?? 'info', event.text ?? JSON.stringify(event));
        },
        plan(details) {
            const text = planLine(details);
            if (text) this.line('step', text);
        },
        progress(text) {
            this.line('info', `· ${text}`);
        },
        files(list) {
            for (const file of list ?? []) this.line('result', file);
        },
    };
}
