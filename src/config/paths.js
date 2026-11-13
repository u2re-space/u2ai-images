/**
 * @file src/config/paths.js
 * @module config/paths
 * @purpose The home directory of the CLI and the files inside it.
 * @exports defaultHome, homeConfigFile, promptsDir, notesDir, diagnosticsDir, resolveConfigPath, ensureHomeDir
 * @ai.tags config
 * @ai.hint keep
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * The home directory of the CLI: AI_IMAGE_HOME, or ~/.ai-image.
 * @param {object} [env]
 * @returns {string}
 */
export function defaultHome(env = process.env) {
    return env.AI_IMAGE_HOME ? path.resolve(env.AI_IMAGE_HOME) : path.join(os.homedir(), '.ai-image');
}

/**
 * The absolute path of the home config file.
 * @param {string} home
 * @returns {string}
 */
export function homeConfigFile(home) {
    return path.join(home, 'config.json');
}

/**
 * The directory of the custom prompts.
 * @param {string} home
 * @returns {string}
 */
export function promptsDir(home) {
    return path.join(home, 'prompts');
}

/**
 * The directory of the notes of the agentic run.
 * @param {string} home
 * @returns {string}
 */
export function notesDir(home) {
    return path.join(home, 'notes');
}

/**
 * The directory of the raw answers of the API.
 * @param {string} home
 * @returns {string}
 */
export function diagnosticsDir(home) {
    return path.join(home, 'diagnostics');
}

/**
 * Resolve a --config argument to an absolute path.
 * @param {string|null|undefined} configPath
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveConfigPath(configPath, cwd = process.cwd()) {
    if (!configPath || typeof configPath !== 'string' || !configPath.trim()) return null;
    return path.resolve(cwd, configPath.trim());
}

/**
 * Create the home directory and its subdirectories when they are missing.
 *
 * Best effort: a read-only home must not break a run that works from the flags
 * alone, so a failure here is not an error.
 * @param {string} home
 * @returns {Promise<void>}
 */
export async function ensureHomeDir(home) {
    for (const dir of [home, promptsDir(home), notesDir(home), diagnosticsDir(home)]) {
        try {
            await mkdir(dir, { recursive: true });
        } catch { /* ignore */ }
    }
}
