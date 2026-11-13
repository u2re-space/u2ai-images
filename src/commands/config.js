/**
 * @file src/commands/config.js
 * @module commands/config
 * @purpose `ai-image config init|show|path`: the configuration of the CLI.
 * @depends config
 * @exports run
 * @ai.tags cli, config
 * @ai.hint keep
 */

import {
    defaultHome,
    diagnosticsDir,
    ensureConfigFile,
    ensureHomeDir,
    homeConfigFile,
    loadConfig,
    notesDir,
    promptsDir,
    redactConfig,
} from '../config.js';

/**
 * Run the command.
 * @param {{ options: object, renderer: object, cwd: string, env?: object }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function run(ctx) {
    const { options, renderer, cwd } = ctx;
    const env = ctx.env ?? process.env;
    const action = (options.positionals[0] ?? 'show').trim();

    if (action === 'init') {
        const home = defaultHome(env);
        const { created, file } = await ensureConfigFile(env);
        await ensureHomeDir(home);
        renderer.line(created ? 'ok' : 'info', created ? `Created ${file}` : `${file} already exists, kept as it is.`);
        renderer.line('info', `Home: ${home}`);
        renderer.line('info', `Prompts: ${promptsDir(home)}`);
        renderer.line('info', `Notes: ${notesDir(home)}`);
        renderer.line('info', `Diagnostics: ${diagnosticsDir(home)}`);
        return 0;
    }

    if (action === 'path') {
        const home = defaultHome(env);
        renderer.line('info', homeConfigFile(home));
        return 0;
    }

    if (action !== 'show') {
        const error = new Error(`Unknown action "${action}". Use init, show or path.`);
        error.usage = true;
        throw error;
    }

    const config = await loadConfig({ configPath: options.configPath, env, cwd });
    const redacted = redactConfig(config);
    renderer.json(redacted);
    return 0;
}
