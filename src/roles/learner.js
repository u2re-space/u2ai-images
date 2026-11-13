/**
 * @file src/roles/learner.js
 * @module roles/learner
 * @purpose The learner: the runs of the past are read, and the strategy of the next run is
 *          suggested from what worked.
 * @depends node:path, node:fs/promises, config/paths
 * @usedBy agent/pipeline, roles/planner
 * @exports readNotes, writeNote, summarizeNotes, suggestStrategy
 * @ai.tags roles, learner, notes
 * @ai.hint keep
 *
 * The notes of a run are small: the task, the purpose, the frame, the model, the mode of the
 * alpha channel, and how it ended. The learner sums them up and says which combination gave a
 * result that could be used.
 */

import path from 'node:path';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { notesDir } from '../config/paths.js';

/**
 * The notes of the past runs.
 * @param {{ home: string }} options
 * @returns {Promise<object[]>} the entries, the newest first
 * @exports
 * @ai.hint io
 */
export async function readNotes({ home }) {
    const dir = notesDir(home);
    const names = await readdir(dir).catch(() => []);
    const entries = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort().reverse()) {
        try {
            const raw = await readFile(path.join(dir, name), 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') entries.push({ file: name, ...parsed });
        } catch {
            // A broken note must not break the learner: the others still count.
        }
    }
    return entries;
}

/**
 * Write the note of a run.
 * @param {{ home: string, entry: object }} options
 * @returns {Promise<string|null>} the path of the note, or null when it could not be written
 * @exports
 * @ai.hint io
 */
export async function writeNote({ home, entry }) {
    const dir = notesDir(home);
    const date = String(entry?.date ?? new Date().toISOString()).slice(0, 10);
    const stamp = String(entry?.date ?? new Date().toISOString()).slice(11, 19).replace(/:/g, '');
    const file = path.join(dir, `${date}-${stamp}.json`);
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    } catch {
        return null;
    }
    return file;
}

/**
 * Sum the notes up: which purpose, which frame and which mode of the alpha channel gave a
 * result that could be used.
 * @param {object[]} entries
 * @returns {{ total: number, byPurpose: object, bySize: object, byAlphaMode: object, byModel: object }}
 * @exports
 * @ai.hint pure
 */
export function summarizeNotes(entries = []) {
    const summary = {
        total: entries.length,
        byPurpose: {},
        bySize: {},
        byAlphaMode: {},
        byModel: {},
    };
    /**
     * Count one field of the notes.
     * @param {object} bucket
     * @param {string} key
     * @param {boolean} good
     * @returns {void}
     * @ai.hint pure
     */
    const count = (bucket, key, good) => {
        if (!key) return;
        const row = bucket[key] ?? { total: 0, good: 0 };
        row.total += 1;
        if (good) row.good += 1;
        bucket[key] = row;
    };
    for (const entry of entries) {
        const good = entry?.outcome === 'ok' || entry?.ok === true;
        count(summary.byPurpose, entry?.purpose, good);
        count(summary.bySize, entry?.size, good);
        count(summary.byAlphaMode, entry?.alphaMode, good);
        count(summary.byModel, entry?.model, good);
    }
    return summary;
}

/**
 * The strategy the past runs suggest.
 *
 * The combination with the best share of good results wins; a combination that never worked is
 * not suggested, however often it was tried.
 * @param {object} summary The sum of the notes.
 * @returns {{ purpose: string|null, size: string|null, alphaMode: string|null, confidence: number }}
 * @exports
 * @ai.hint pure
 */
export function suggestStrategy(summary) {
    /**
     * The best key of a bucket.
     * @param {object} bucket
     * @returns {string|null}
     * @ai.hint pure
     */
    const best = (bucket) => {
        let winner = null;
        let bestScore = 0;
        for (const [key, row] of Object.entries(bucket ?? {})) {
            if (!row?.total) continue;
            const score = row.good / row.total;
            if (row.good > 0 && score >= bestScore) {
                bestScore = score;
                winner = key;
            }
        }
        return winner;
    };
    const purpose = best(summary?.byPurpose);
    const size = best(summary?.bySize);
    const alphaMode = best(summary?.byAlphaMode);
    const confidence = purpose ? (summary.byPurpose[purpose]?.good / summary.byPurpose[purpose]?.total) ?? 0 : 0;
    return { purpose, size, alphaMode, confidence: Number(confidence.toFixed(2)) };
}
