/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose Terminal renderer for the image commands: what is going to happen, what came back,
 *          and where the files landed.
 * @exports createRenderer, createPlainRenderer, detectMode
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
 * A renderer without colors, for a pipe.
 *
 * A run whose output is piped somewhere — a CI log, a file, another program — has to leave
 * something behind. The colored renderer is for a person at a terminal; this one is for the
 * reader on the other side of the pipe.
 * @param {{ verbose?: boolean }} [opts]
 * @returns {{ line: Function, json: Function, event: Function }}
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
    };
}

/**
 * Create the renderer for a terminal.
 * @param {{ verbose?: boolean }} [opts]
 * @returns {{ line: Function, json: Function, event: Function }}
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
    };
}
