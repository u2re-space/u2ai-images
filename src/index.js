/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */
export { main, parseArgv } from './cli.js';
export { COMMANDS, HELP, commandNames } from './help.js';
export { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
export { COLORS, paint } from './cli/colors.js';
export { checkNodeVersion } from './cli/compatibility.js';
