#!/usr/bin/env node
/**
 * @file bin/ai-image.js
 * @module bin/ai-image
 * @purpose Process entry for the `ai-image` command. Forwards every argument to `cli.main`.
 * @depends cli
 * @usedBy package bin
 * @ai.tags cli
 * @ai.hint io
 */
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
