/**
 * @file src/config.js
 * @module config
 * @purpose The public face of the configuration system implemented in src/config/*.js.
 * @exports loadConfig, ensureConfigFile, redactConfig, resolveBackend, defaults, cloneDefaults, defaultConfigText, ENUMS, KiB, MiB, ENV_PREFIX, fromEnv, envConfigPath, deepMerge, isRecord, getPath, setPath, readConfigFile, writeConfigFile, expandPlaceholders, mergeSources, defaultHome, homeConfigFile, promptsDir, notesDir, diagnosticsDir, resolveConfigPath, ensureHomeDir, validateConfig
 * @ai.tags config
 * @ai.hint keep
 */

export { loadConfig, ensureConfigFile, redactConfig, resolveBackend } from './config/index.js';
export { defaults, cloneDefaults, defaultConfigText, ROLE_FIELDS } from './config/defaults.js';
export { ENUMS, KiB, MiB, ENV_PREFIX, BUILTIN_ROLE_NAMES } from './config/constants.js';
export { fromEnv, envConfigPath } from './config/env.js';
export { deepMerge, isRecord, getPath, setPath } from './config/merge.js';
export { readConfigFile, writeConfigFile, expandPlaceholders, mergeSources } from './config/parser.js';
export {
    defaultHome,
    homeConfigFile,
    promptsDir,
    notesDir,
    diagnosticsDir,
    resolveConfigPath,
    ensureHomeDir,
} from './config/paths.js';
export { validateConfig } from './config/validate.js';
