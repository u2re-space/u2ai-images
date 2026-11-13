/**
 * @file src/commands/purpose.js
 * @module commands/purpose
 * @purpose `ai-image purpose`: the purpose map and the model each purpose resolves to.
 * @depends model/purpose
 * @exports run
 * @ai.tags cli, purpose
 * @ai.hint keep
 */

import { PURPOSE_NAMES, purposeModels, resolvePurposeModel } from '../model/purpose.js';

/**
 * Run the command.
 * @param {{ options: object, renderer: object, config: object }} ctx
 * @returns {number} the exit code
 */
export async function run(ctx) {
    const { options, renderer, config } = ctx;

    const rows = PURPOSE_NAMES.map((purpose) => {
        const models = purposeModels(config, purpose);
        return { purpose, models, resolved: resolvePurposeModel(config, purpose) };
    });

    if (options.json) {
        renderer.json({ type: 'purpose', purposes: rows });
        return 0;
    }

    for (const row of rows) {
        const models = row.models.length ? row.models.join(', ') : '(none)';
        const resolved = row.resolved ?? 'no suitable provider';
        renderer.line('result', `${row.purpose}: ${models}`);
        renderer.line('info', `  → ${resolved}`);
    }
    if (config?.explicit?.top?.includes('imageModel')) {
        renderer.line('info', 'The picture model of the configuration is set by hand, so it wins over the purpose.');
    }
    return 0;
}
