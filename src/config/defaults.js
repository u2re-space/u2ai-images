/**
 * @file src/config/defaults.js
 * @module config/defaults
 * @purpose The default domain of the image CLI: models, backends, the picture
 *          knobs, the purposes, the limits and the roles.
 * @exports defaults, ROLE_FIELDS, cloneDefaults, defaultConfigText
 * @ai.tags config
 * @ai.hint keep
 */

import { MiB, KiB, GiB } from './constants.js';
import { PURPOSE_MODEL_MAP } from '../model/purpose.js';

/**
 * Every section listed here is also the allow-list of a user config file:
 * a section that is not listed is refused by name.
 */
export const defaults = {
    // --- models ---------------------------------------------------------------
    /** Text model: the agent roles and the AI parser talk through it. */
    model: 'openai/gpt-6.2-sol',//'minimax/minimax-m3.1-flash',
    /** Picture model: generate, edit and the technical alpha passes. */
    imageModel: 'bytedance-seed/seedream-5-5',
    /** Model of the AI parser; null keeps the text model. */
    parserModel: null,
    /** Vector model (SVG); null keeps the picture model. */
    vectorModel: null,

    // --- API -----------------------------------------------------------------
    /** Endpoint of the API; the backends below may override it per route. */
    baseURL: 'https://routerai.ru/api/v1',
    apiKey: null,
    organization: null,
    project: null,
    /** Send `store: true` on the API calls. */
    store: false,
    /** Retries per request. */
    retries: 3,
    /** Wall-clock budget of one request. */
    timeoutMs: 120_000,

    // --- reasoning ---------------------------------------------------------------
    /**
     * How the text model thinks.
     *
     * `effort` is the effort of the run: every text request works at this level. A role with
     * its own effort (`roles.<role>.effort`) works at its own level instead. The level is
     * pulled down to what the model of the request really takes (`src/model/text.js`).
     *
     * The tier of the planning (`quality`) is not a field of a text request: it belongs to
     * the picture models, and it lives in `image.quality`.
     */
    reasoning: {
        /** The reasoning effort of the text requests of the run. */
        effort: 'high',
        /** The summary of the reasoning of an answer; null sends no summary. */
        summary: 'auto',
    },

    // --- HTTP backends -------------------------------------------------------
    /**
     * Ordered hosts of the text API; the first usable one becomes the primary.
     * Entry: { baseURL, apiKey?, env?, prefix?, vendor?, headers?, body?, supports? }.
     * `env` is the name of the environment variable that holds the key.
     */
    backends: [
        { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
        // The host of the batch route: the requests of a round go out as one file.
        { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY', supports: { batch: true } },
        { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
        { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
    ],
    /** Ordered hosts of the picture API (the same entry shape). */
    imagesBackends: [
        { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
        { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY' },
        { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
        { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
    ],
    /** Fallback models: { "<model>": ["<fallback>", ...], "*": [...] }. */
    fallback: { enabled: true, models: {} },

    // --- batch ---------------------------------------------------------------------
    /**
     * The batch route of the hosts: a file of requests goes out as one batch, the host works
     * on it in the background, and the answers come back later.
     *
     * The route is two-phase: the first run submits the requests and stops, the second run
     * takes the answers and goes on. Only the hosts that carry the flag `supports: { batch: true }`
     * take part in it.
     */
    batch: {
        /** Use the batch route at all. */
        enabled: false,
        /** The phase of the run: 'off' | 'submit' | 'fetch'. */
        mode: 'off',
        /** The route of the batch; null means the route of the host. */
        endpoint: null,
        /** The window the host serves the batch in. */
        window: '24h',
        /** How long the queue of a round waits for the last request, ms. */
        collectMs: 1500,
        /** How often the state of a batch is asked for, ms. */
        pollMs: 5000,
        /** How long the fetch waits for a batch that is not done yet, ms. */
        waitMs: 0,
        /** Max requests in one batch. */
        maxRequests: 64,
        /** Min requests in one batch: one is enough, the run is a chain of single questions. */
        minRequests: 1,
        /** Where the journal of the answers is kept, relative to the working directory. */
        journalDir: '.ai-image/batch',
    },

    // --- picture knobs --------------------------------------------------------
    image: {
        /** Frame of the picture: a preset, a free WIDTHxHEIGHT or auto. */
        size: 'auto',
        /**
         * The quality tier of the picture.
         *
         * The field of the API is `quality` — the tier of the planning of the models of OpenAI
         * (`low`, `medium`, `high`, `xhigh`, `max`). `auto` means the tier of the model itself:
         * the tier is cut down to the ladder of the model, so a request for `max` on a model that
         * stops at `high` goes out as `high`.
         */
        quality: 'high',
        /**
         * The deprecated name of `quality`.
         *
         * The older builds wrote the tier of the planning into `image.complexity`; the field is
         * still read when `quality` is left at `auto`, so the old configuration keeps working.
         */
        complexity: 'high',
        /** Format of the written file. */
        format: 'png',
        /** Background of a generated picture. */
        background: 'auto',
        /** Resolution tier of the families that are tuned by one. */
        resolution: null,
        /** The seed that makes the answer repeatable; null asks for a fresh one. */
        seed: null,
        /** The degree of the compression of a jpeg or a webp, 0..100. */
        outputCompression: null,
        /** The frames of an animated GIF, 2..16. */
        frameCount: null,
        /** The duration of one frame of an animated GIF, in milliseconds. */
        frameDurationMs: null,
        /** The mask picture of an edit: the area of the source that is repainted. */
        mask: null,
        /**
         * Where the pictures are written, relative to the working directory.
         *
         * The pictures of the house live in the house: `.ai/assets/` is the default. The
         * config may move them, and then it wins.
         */
        outputDir: '.ai/assets',
        /** Route of the picture: null follows the model, 'images' or 'responses'. */
        transport: null,
        /** The default purpose of a request that names none. */
        purpose: null,
        /** 16-pixel padding of the /images/edits input. */
        div16: 'auto',
        /** Padding up to the frame floor of the model. */
        padToMin: 'auto',
        /** The frame hint repeated in the prompt text. */
        sizeHint: 'auto',
        /** How the alpha channel is built. */
        alphaMode: 'auto',
        /** Anti-aliasing on the edge of the matte, in pixels. */
        alphaFeather: 1,
        /** Raster engine of the local operations. */
        rasterEngine: 'auto',
        /** ImageMagick binary, when the engine is magick or auto. */
        magickPath: null,
        /** Model of the technical alpha passes: null follows the family. */
        maskModel: null,
        /** A PNG heavier than this is written as WebP. */
        pngMaxBytes: 4 * MiB,
        /** Unique-color ceiling of the vectorizer. */
        vectorMaxColors: 256,
        /** Ask for the SVG in the same answer as a cut-out. */
        autoVectorize: false,
        /** The AI parser of the payload: does it read the answer of the model? */
        parser: {
            enabled: true,
            /** Model of the parser; null keeps the text model. */
            model: null,
            /** Keep the raw answers in the diagnostics directory. */
            archive: true,
            /** Where the raw answers are kept; null keeps the home directory. */
            archiveDir: null,
        },
    },

    // --- purposes -------------------------------------------------------------
    /** The order of the models per purpose; a user list replaces the built-in one. */
    purpose: {
        models: {
            decompose: [...PURPOSE_MODEL_MAP.decompose],
            generate: [...PURPOSE_MODEL_MAP.generate],
            edit: [...PURPOSE_MODEL_MAP.edit],
            remove_background: [...PURPOSE_MODEL_MAP.remove_background],
            upscale: [...PURPOSE_MODEL_MAP.upscale],
            unrotate: [...PURPOSE_MODEL_MAP.unrotate],
        },
    },

    // --- limits ---------------------------------------------------------------
    limits: {
        /** Max bytes of a picture that is read into the process. */
        maxImageBytes: 8 * MiB,
        /** Max bytes read from stdin. */
        maxStdinBytes: 4 * MiB,
        /** Wall-clock budget of one request. */
        timeoutMs: 120_000,
        /** Retries per request. */
        retries: 3,
        /** Cap of a {{file:...}} substitution in the configuration. */
        maxFileReadBytes: 256 * KiB,
    },

    // --- memory ---------------------------------------------------------------
    /**
     * The memory of the run: the tmp cache in the memory and the biggest buffer that
     * may be allocated at once.
     *
     * The cache is the tmp of the house: the pictures of the work live in it, and they
     * never touch the disk. The block of the cache is one `SharedArrayBuffer`, so the
     * parent and the worker read the very same bytes — not a copy of them.
     *
     * The allocation is the ceiling of one buffer: 1 GB, 2 GB, 4 GB, 8 GB. The memory of
     * the machine is not taken when the block is made — the pages are taken when the
     * bytes are written — so a big ceiling costs nothing until it is used.
     */
    memory: {
        /** The size of the tmp cache of the run, in bytes. */
        cacheBytes: 256 * MiB,
        /** The biggest buffer that may be allocated at once, in bytes. */
        allocateBytes: 2 * GiB,
        /** Keep the tmp cache in the memory: the disk is never touched. */
        inMemory: true,
    },

    // --- roles ----------------------------------------------------------------
    /**
     * Per-role overrides. The resolution chain is
     * role -> roles.default -> the top level. `instructions` are appended to the
     * prompt of the role; `imageModel`/`vectorModel` travel with it.
     * The `effort` of a role is resolved as role -> roles.default -> reasoning.effort.
     */
    roles: {
        default: {
            model: null,
            /** null — the role works at the effort of the run (`reasoning.effort`). */
            effort: null,
            imageModel: null,
            vectorModel: null,
            instructions: null,
            maxTurns: null,
        },
        planner: {},
        processor: {},
        corrector: {},
        learner: {},
        decorator: {},
        vectorizer: {},
        /** The editor of a vector document: a text model that reads the SVG as code. */
        svgEditor: {},
    },
};

/** Allowed fields of one `roles.<name>` entry (null = inherited). */
export const ROLE_FIELDS = Object.freeze([
    'model', 'effort', 'imageModel', 'vectorModel', 'instructions', 'maxTurns',
]);

/**
 * A fresh copy of the defaults.
 * @returns {object}
 */
export function cloneDefaults() {
    return structuredClone(defaults);
}

/**
 * The starter file written to ~/.ai-image/config.json on the first run: only
 * the fields a user is expected to edit; everything else stays on the defaults.
 * @returns {string}
 */
export function defaultConfigText() {
    // The hosts that serve the batch route carry the flag that says so: the requests of a
    // round may go out as one batch there.
    const batchHosts = new Set(['https://api.proxyapi.ru/v1', 'https://sprutdock.ru/v1']);
    const withBatch = (list) => structuredClone(list).map((item) => (
        batchHosts.has(item.baseURL)
            ? { ...item, supports: { ...(item.supports ?? {}), batch: true } }
            : item
    ));
    const starter = {
        model: defaults.model,
        imageModel: defaults.imageModel,
        parserModel: defaults.parserModel,
        vectorModel: defaults.vectorModel,
        backends: withBatch(defaults.backends),
        imagesBackends: withBatch(defaults.imagesBackends),
        image: {
            size: defaults.image.size,
            format: defaults.image.format,
            background: defaults.image.background,
            outputDir: defaults.image.outputDir,
            alphaMode: defaults.image.alphaMode,
            quality: defaults.image.quality,
        },
        reasoning: {
            effort: defaults.reasoning.effort,
        },
        purpose: { models: structuredClone(defaults.purpose.models) },
        batch: { enabled: false },
    };
    return `${JSON.stringify(starter, null, 2)}\n`;
}
