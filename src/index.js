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
export { TEXT_MODEL_PROFILES, textModelProfile, snapEffort } from './model/text.js';
export { effortFor } from './agent/effort.js';
export { publishPictures, assetsRel } from './core/publish.js';
export {
    HOUSE_DIR,
    HOUSE_TMP,
    HOUSE_ASSETS,
    HOUSE_LOGS,
    HOUSE_WORK,
    HOUSE_SYSTEMS,
    MANIFEST_FILE,
    MANIFEST_VERSION,
    houseDir,
    workRel,
    workDir,
    runStateDir,
    assetsDir,
    logsDir,
    manifestPath,
    toProjectPath,
    readManifest,
    writeManifest,
    publish,
    findGenerated,
    writeFileAtomic,
} from './shared/house.js';
