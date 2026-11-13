/**
 * @file src/cli/colors.js
 * @module cli/colors
 * @purpose ANSI color constants and the paint helper.
 * @exports COLORS, paint, colorsEnabled
 * @ai.hint keep
 */

/** ANSI codes used by the renderer. */
export const COLORS = Object.freeze({
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
});

/**
 * Are colors wanted at all?
 *
 * A pipe is not a terminal, and `NO_COLOR` is the convention everybody already follows.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function colorsEnabled(env = process.env) {
    if (env.NO_COLOR) return false;
    if (env.AI_IMAGE_NO_COLOR) return false;
    return Boolean(process.stdout.isTTY);
}

/**
 * Wrap text in ANSI color codes.
 * @param {string} text
 * @param {string} color
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function paint(text, color, env = process.env) {
    if (!colorsEnabled(env)) return text;
    return `${color}${text}${COLORS.reset}`;
}
