/**
 * @file src/cli/compatibility.js
 * @module cli/compatibility
 * @purpose Node.js version, feature detection and the mapping of a failure to an exit code.
 * @exports checkNodeVersion, exitCodeFor
 * @ai.hint keep
 */

/**
 * Verify that the current Node.js version meets requirements.
 * @returns {{ ok: boolean, version: string, required: string }}
 */
export function checkNodeVersion() {
    const version = process.versions.node;
    const major = parseInt(version, 10);
    const required = 26;
    return { ok: major >= 26, version, required: `>=${required}` };
}

/**
 * The exit code of a failure.
 *
 * Three codes, and they mean the same everywhere in the package:
 * - 0 — the run succeeded;
 * - 1 — the run failed: the network, the model, the file;
 * - 2 — the arguments were wrong: nothing was tried.
 *
 * An interrupted run is 130, the code the shells already know.
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeFor(error) {
    if (!error) return 0;
    if (error?.name === 'AbortError') return 130;
    if (error?.usage) return 2;
    return 1;
}
