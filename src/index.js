/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */
export { main, parseArgv, configOverrides } from './cli.js';
export { COMMANDS, HELP, commandNames } from './help.js';
export { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
export { COLORS, paint } from './cli/colors.js';
export { checkNodeVersion } from './cli/compatibility.js';
export {
    loadConfig,
    ensureConfigFile,
    redactConfig,
    resolveBackend,
    defaults,
    cloneDefaults,
    defaultConfigText,
    ENUMS,
    KiB,
    MiB,
    ENV_PREFIX,
    validateConfig,
} from './config.js';
export { PURPOSE_NAMES, PURPOSE_MODEL_MAP } from './model/purpose.js';
