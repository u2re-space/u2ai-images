/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */
export { main, parseArgv, configOverrides } from './cli.js';
export { mainTui } from './tui/cli.js';
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
export { DEFAULT_VECTOR_MODEL, imageModelProfile, imageModelFamily } from './model/profiles.js';
export { VECTOR_PROMPT, vectorModelFor } from './model/vector.js';
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

// --- the shared memory, the protocol and the worker of the house --------------------
export {
    SHARED_MAGIC,
    SHARED_VERSION,
    SHARED_REGIONS,
    FLAG_CANCEL,
    sharedAvailable,
    createSharedBlock,
    readSharedBlock,
} from './shared/shared.js';
export {
    PROTOCOL_VERSION,
    SPEC_VERSION,
    FRAME,
    createFrame,
    isFrame,
    bytesFrame,
    base64Frame,
    bytesOfFrame,
    bytesOf,
    base64Bytes,
    base64Of,
} from './shared/protocol.js';
export {
    channelOf,
    startWorker,
    runWorker,
    workerMain,
    spawnWorker,
    runWorkerCycle,
    workerEntry,
    DEFAULT_TRANSPORT,
} from './shared/worker.js';
export {
    IMAGE_WORKER_ENTRY,
    runImageWorker,
    spawnImageWorker,
    createImageWorker,
} from './agent/worker-runner.js';
export { IMAGE_TOOLS, normalizeImageSpec, imageSpecTexts, runImageCycle } from './agent/worker.js';

// --- the vector document: the analysis, the edits and the polish ----------------------
export {
    SVG_EDIT_KINDS,
    SVG_PROBLEMS,
    parseSvgDocument,
    findSvgProblems,
    applySvgEdits,
    tidySvgDocument,
    svgDocumentSummary,
} from './image/svg-document.js';
export {
    SVG_EDITOR_INSTRUCTIONS,
    editSvgDocument,
    askSvgEdits,
    tidySvgAsset,
} from './roles/svg-editor.js';
export { SVG_EDITOR_SCHEMA } from './agent/schemas.js';
export { runSvgEditStage } from './stages/svg-edit.js';
export { runSvgPolishStage } from './stages/svg-polish.js';

// --- the ramdisk: the tmp cache of the house ----------------------------------------
export {
    RAMDISK_LIMITS,
    createRamdisk,
    createRamdiskFileSystem,
    createSharedByteCache,
    allocateMemory,
} from './access/ramdisk.js';
