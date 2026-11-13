/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch one command, and map failures to process exit codes.
 * @depends node:util, node:module, node:url, cli/compatibility, cli/renderer, help
 * @exports parseArgv, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { checkNodeVersion } from './cli/compatibility.js';
import { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
import { COMMANDS, HELP, commandNames } from './help.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/**
 * Parse the arguments of `ai-image`.
 *
 * The command is the first positional; everything after it belongs to the command. The flags
 * are the same for every command, so one parser serves them all — a command that does not know
 * a flag simply does not read it.
 * @param {string[]} argv
 * @returns {object} the normalized options
 */
export function parseArgv(argv) {
    const parsed = parseArgs({
        options: {
            config: { type: 'string', short: 'c' },
            out: { type: 'string', short: 'o' },
            'out-dir': { type: 'string' },
            model: { type: 'string', short: 'm' },
            'image-model': { type: 'string' },
            purpose: { type: 'string' },
            size: { type: 'string' },
            resolution: { type: 'string' },
            format: { type: 'string' },
            background: { type: 'string' },
            count: { type: 'string', short: 'n' },
            reference: { type: 'string', multiple: true },
            engine: { type: 'string' },
            'alpha-mode': { type: 'string' },
            x: { type: 'string' },
            y: { type: 'string' },
            width: { type: 'string' },
            height: { type: 'string' },
            trim: { type: 'boolean', default: false },
            rows: { type: 'string' },
            cols: { type: 'string' },
            mode: { type: 'string' },
            color: { type: 'string' },
            json: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            verbose: { type: 'boolean', short: 'v', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', default: false },
        },
        strict: false,
        allowPositionals: true,
        args: argv,
    });

    const positionals = parsed.positionals.map((value) => String(value));
    const command = positionals.shift() ?? '';
    const count = Number.parseInt(parsed.values.count ?? '1', 10);

    return {
        command,
        positionals,
        configPath: parsed.values.config ?? null,
        out: parsed.values.out ?? null,
        outDir: parsed.values['out-dir'] ?? null,
        model: parsed.values.model ?? null,
        imageModel: parsed.values['image-model'] ?? null,
        purpose: parsed.values.purpose ?? null,
        size: parsed.values.size ?? null,
        resolution: parsed.values.resolution ?? null,
        format: parsed.values.format ?? null,
        background: parsed.values.background ?? null,
        count: Number.isSafeInteger(count) && count > 0 ? count : 1,
        references: parsed.values.reference ?? [],
        engine: parsed.values.engine ?? null,
        alphaMode: parsed.values['alpha-mode'] ?? null,
        x: parsed.values.x ?? null,
        y: parsed.values.y ?? null,
        width: parsed.values.width ?? null,
        height: parsed.values.height ?? null,
        trim: parsed.values.trim === true,
        rows: parsed.values.rows ?? null,
        cols: parsed.values.cols ?? null,
        mode: parsed.values.mode ?? null,
        color: parsed.values.color ?? null,
        json: parsed.values.json === true,
        dryRun: parsed.values['dry-run'] === true,
        verbose: parsed.values.verbose === true,
        help: parsed.values.help === true,
        version: parsed.values.version === true,
    };
}

/**
 * Load the module that runs one command.
 * @param {string} name
 * @returns {Promise<Function>}
 */
async function loadCommand(name) {
    return await import(`./commands/${name}.js`);
}

/**
 * Main entry point: parse the arguments, run the command, map the failure to an exit code.
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(HELP);
        return 0;
    }
    if (argv.includes('--version')) {
        console.log(pkg.version);
        return 0;
    }

    const runtime = checkNodeVersion();
    if (!runtime.ok) {
        console.error(`Node.js ${runtime.required} is required, this is ${runtime.version}.`);
        return 1;
    }

    const options = parseArgv(argv);
    if (options.help) {
        console.log(HELP);
        return 0;
    }
    if (!options.command) {
        console.error('No command. Run `ai-image --help` for the list.');
        return 2;
    }
    if (!commandNames().includes(options.command)) {
        console.error(`Unknown command "${options.command}". Run \`ai-image --help\` for the list.`);
        return 2;
    }

    const renderer = detectMode() === 'tty'
        ? createRenderer({ verbose: options.verbose })
        : createPlainRenderer({ verbose: options.verbose });

    let command;
    try {
        command = await loadCommand(options.command);
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') {
            console.error(`The command "${options.command}" is not available in this build yet.`);
            return 2;
        }
        throw error;
    }

    try {
        return await command.run({ options, renderer, cwd: process.cwd(), command: options.command });
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.error('Aborted.');
            return 130;
        }
        const message = error?.message ?? String(error);
        if (options.json) {
            renderer.json({ type: 'result', status: 'failed', error: { message } });
        } else {
            renderer.line('fail', message);
        }
        return error?.usage ? 2 : 1;
    }
}
