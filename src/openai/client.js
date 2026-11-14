/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose The API client of the picture CLI: the rotation over the backends, the images API
 *          (generation, editing, vectorizing), the Responses API as the fallback route, the
 *          alignment of an arbitrary frame and the fallbacks of the model.
 * @depends node:crypto, node:timers/promises, openai/errors, openai/http, openai/responses,
 *          openai/images, openai/fallback, image/sizing, model/profiles, model/purpose
 * @exports createClient, ApiError, retryDelayMs, resolveBackends
 * @ai.tags openai, client, api
 * @ai.hint io
 * @ai.hint legacy-0.2
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { createHttp, readBody } from './http.js';
import { setImageDiagnostics } from './diagnostics.js';
import { diagnosticsDir } from '../config/paths.js';
import {
    buildResponsesBody,
    imageGenerationTool,
    responsesError,
    responsesImagePayloads,
    responsesOutputText,
} from './responses.js';
import {
    backgroundValue,
    encodeMultipart,
    generationBody,
    imageComplexityValue,
    imageFormatField,
    imageSources,
    isSvgRequest,
    normalizeVectorRatio,
    readImageSize,
    resolveImageFormat,
    sniffImage,
    svgConversionModel,
    withSizeHint,
} from './images.js';
import {
    alignmentPlan,
    imageSizeAttempts,
    imageSizeFields,
    isImageSizeError,
    parseImageSize,
    paddedSizeToMinPixels,
    sameAspectImageSize,
} from '../image/sizing.js';
import { imageModelProfile } from '../model/profiles.js';
import { resolvePurposeModel } from '../model/purpose.js';
import { fallbackChain, isModelUnknown, isRouteUnsupported } from './fallback.js';
import { aggregateFailure, createBackendPool } from './rotation.js';

/** Statuses worth another try on the same backend. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const defaults = Object.freeze({
    retries: 3,
    maxErrorBytes: 64 * 1024,
    maxResponseBytes: 256 * 1024 * 1024,
});

/** Headers the client sets itself; a backend header must not replace them. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id']);

/** RFC 7230 token characters for header names. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const textOf = (value) => (typeof value === 'string' ? value : '');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Normalize a base URL and require a path that ends with `/`.
 * @param {string} value
 * @returns {URL}
 * @ai.hint pure
 */
function normalizeBaseURL(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
        throw new TypeError('The base URL must not contain credentials, a query or a fragment.');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

/**
 * Stringify and check per-backend headers. Reserved names are ignored: auth and content
 * headers belong to the client.
 * @param {object|null|undefined} headers
 * @returns {Record<string, string>}
 * @ai.hint pure
 */
function normalizeHeaders(headers) {
    if (!isRecord(headers)) return {};
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || value == null) continue;
        const text = String(value);
        if (/[\r\n]/.test(text)) throw new TypeError(`Header ${name} contains a line break.`);
        out[name] = text;
    }
    return out;
}

/**
 * Delay before a retry. A positive Retry-After wins, capped at 60 seconds; otherwise backoff
 * with jitter. HTTP 429 waits at least 3 seconds so a repeat does not look like a burst.
 * @param {number} attempt
 * @param {string|number|null} retryAfter
 * @param {number|null} [status]
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function retryDelayMs(attempt, retryAfter, status = null) {
    const header = Number(retryAfter);
    const fromHeader = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 60_000) : 0;
    const backoff = Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
    const delay = Math.max(fromHeader, backoff);
    if (status === 429) return Math.max(delay, 3000);
    return fromHeader > 0 ? fromHeader : backoff;
}

/**
 * The key of a backend entry: the inline key, then the named environment variable.
 * @param {object} entry
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 * @ai.hint pure
 */
function keyOf(entry, env) {
    if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) return entry.apiKey.trim();
    if (typeof entry?.env === 'string' && entry.env) {
        const value = env?.[entry.env];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The ordered backends of one route kind.
 *
 * `images` uses `imagesBackends` (and falls back to `backends`), `text` uses `backends`.
 * @param {object} config
 * @param {{ kind?: 'text'|'images', model?: string|null, env?: object }} [options]
 * @returns {Array<{ baseURL: string, apiKey: string|null, headers: object, body: object, supports: object }>}
 * @exports
 */
export function resolveBackends(config, { kind = 'text', model = null, env = process.env } = {}) {
    const general = kind === 'images'
        ? (Array.isArray(config?.imagesBackends) && config.imagesBackends.length ? config.imagesBackends : config?.backends)
        : config?.backends;
    const entries = Array.isArray(general) ? general : [];

    const chain = [];
    for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const baseURL = textOf(entry.baseURL ?? entry.baseUrl).trim();
        if (!baseURL) continue;
        chain.push({
            baseURL,
            apiKey: keyOf(entry, env),
            headers: normalizeHeaders(entry.headers),
            body: isRecord(entry.body) ? { ...entry.body } : {},
            supports: isRecord(entry.supports) ? { ...entry.supports } : {},
        });
    }
    if (chain.some((item) => item.apiKey)) return chain.filter((item) => item.apiKey);

    // No keyed backend: for the text route the primary URL and key of the config are the only
    // option left. The picture pool keeps its own order — the primary of the text route is not
    // necessarily a host that serves pictures.
    if (kind === 'images') return chain;
    const baseURL = textOf(config?.baseURL).trim();
    if (!baseURL) return chain;
    return [{
        baseURL,
        apiKey: textOf(config?.apiKey).trim() || null,
        headers: {},
        body: {},
        supports: {},
    }, ...chain.filter((item) => item.baseURL !== baseURL)];
}

/**
 * The error of an Images API answer that carries a refusal in the body.
 *
 * Some gateways answer 200 with an `error` object instead of a picture; the refusal has to be
 * read before the answer is treated as a picture.
 * @param {object} result
 * @returns {ApiError|null}
 * @ai.hint pure
 */
export function imageErrorFromResult(result) {
    if (!isRecord(result) || result.error == null) return null;
    const payload = isRecord(result.error) ? result.error : {};
    const message = typeof result.error === 'string'
        ? result.error
        : (typeof payload.message === 'string' ? payload.message : 'The gateway returned an error answer.');
    const sizeError = /\b(?:invalid\s+size|minimum\s+(?:pixel|image)\s+budget|below the current minimum pixel budget)\b/i.test(message);
    return new ApiError(`Images API: ${message}`, {
        code: sizeError ? 'IMAGE_SIZE_ERROR' : 'HTTP_ERROR',
        status: Number.isInteger(payload.status) ? payload.status : null,
        apiCode: payload.code ?? null,
        apiType: payload.type ?? null,
        param: payload.param ?? null,
    });
}

/**
 * The frame of a source put on the 16-pixel grid the model draws on.
 *
 * The frame grows, the content does not: the source keeps its own scale in the corner of the
 * canvas, and the empty space is cut off the answer.
 * @param {{ width: number, height: number }} frame
 * @param {string|null} model
 * @returns {{ width: number, height: number }|null} null when the grid frame does not fit the model
 * @ai.hint pure
 */
export function alignToGrid(frame, model) {
    const profile = imageModelProfile(model);
    const width = Math.ceil(frame.width / 16) * 16;
    const height = Math.ceil(frame.height / 16) * 16;
    if (width === frame.width && height === frame.height) return null;
    const area = width * height;
    if (area > profile.maxPixels) return null;
    if (Math.max(width, height) > profile.maxEdge) return null;
    if (Math.max(width, height) / Math.min(width, height) > profile.maxRatio) return null;
    return { width, height };
}

/**
 * The plan of one edit: the canvas the source is padded into and the frame the model is asked
 * for.
 *
 * The rules of the configuration decide how far the canvas grows:
 *
 *   `div16`    — the frame is put on the 16-pixel grid (`auto` follows the model profile);
 *   `padToMin` — a source below the floor of the model is padded up to that floor
 *                (`auto` follows the model profile).
 *
 * The content never changes its scale: the canvas grows around it, and the padding is cut off
 * the answer.
 * @param {{ model: string|null, size?: string|null, resolution?: string|null,
 *   sourceFrame?: {width: number, height: number}|null, div16?: string, padToMin?: string }} params
 * @returns {{ mode: 'direct'|'align'|'downscale', frame: string|null, requested: {width:number,height:number}|null,
 *   pad: { width: number, height: number }|null }}
 * @ai.hint pure
 */
export function planEdit({ model = null, size = null, resolution = null, sourceFrame = null,
    div16 = 'auto', padToMin = 'auto' } = {}) {
    const profile = imageModelProfile(model);
    const wantsGrid = div16 === 'always' || (div16 !== 'never' && profile.div16Padding);
    const wantsFloor = padToMin === 'always' || (padToMin !== 'never' && profile.padToMinPixels);
    const token = size ? String(size).trim() : (sourceFrame ? `${sourceFrame.width}x${sourceFrame.height}` : null);
    const base = alignmentPlan({ model, size: token, resolution });

    if (base.requested) {
        // The canvas has to hold the frame of the request, the grid of the model and the floor
        // of the source at the same time: the content keeps its own scale in the corner of it.
        let canvas = base.pad;
        if (wantsGrid && (base.requested.width % 16 || base.requested.height % 16)) {
            const grid = alignToGrid(base.requested, model);
            if (grid) canvas = mergeFrames(canvas, grid);
        }
        if (wantsFloor && sourceFrame) {
            const floor = paddedSizeToMinPixels(`${sourceFrame.width}x${sourceFrame.height}`, model);
            if (floor) canvas = mergeFrames(canvas, { width: floor.width, height: floor.height });
        }
        // A canvas that already exists has to hold the frame of the request as well.
        if (canvas) {
            canvas = mergeFrames(canvas, { width: base.requested.width, height: base.requested.height });
            if (sameAspectImageSize(`${canvas.width}x${canvas.height}`, model) === null) {
                return {
                    mode: 'align',
                    frame: `${canvas.width}x${canvas.height}`,
                    requested: base.requested,
                    pad: canvas,
                };
            }
        }
        return base;
    }

    // No frame in the request: the frame of the source decides.
    if (sourceFrame) {
        const floor = wantsFloor ? paddedSizeToMinPixels(`${sourceFrame.width}x${sourceFrame.height}`, model) : null;
        const canvas = floor ?? (wantsGrid ? alignToGrid(sourceFrame, model) : null);
        if (canvas && (canvas.width > sourceFrame.width || canvas.height > sourceFrame.height)) {
            return {
                mode: 'align',
                frame: `${canvas.width}x${canvas.height}`,
                requested: null,
                pad: { width: canvas.width, height: canvas.height },
            };
        }
        return { mode: 'direct', frame: `${sourceFrame.width}x${sourceFrame.height}`, requested: null, pad: null };
    }

    return { mode: 'direct', frame: null, requested: null, pad: null };
}

/**
 * The bigger of two frames, side by side.
 * @param {{width: number, height: number}|null} a
 * @param {{width: number, height: number}|null} b
 * @returns {{width: number, height: number}|null}
 * @ai.hint pure
 */
export function mergeFrames(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/**
 * Create an API client for the configured backends.
 *
 * The client owns the transport: it knows the routes, the retries, the rotation between hosts
 * and the fallbacks. What a picture means is decided by the caller.
 * @param {{ config: object, env?: object, signal?: AbortSignal|null, onEvent?: Function|null,
 *   raster?: object|null }} opts
 * @returns {Promise<object>}
 */
export async function createClient({ config, env = process.env, signal = null, onEvent = null, raster = null } = {}) {
    const transport = createHttp({
        idleTimeoutMs: Number.isSafeInteger(config?.timeoutMs) ? config.timeoutMs : 120_000,
        connectTimeoutMs: 30_000,
    });
    // The raw answers are archived in the diagnostics directory of the home, so an answer that
    // cannot be parsed can still be read afterwards.
    if (config?.image?.parser?.archive !== false && config?.home) {
        const configured = config.image.parser.archiveDir;
        const dir = configured ? path.resolve(config.home, configured) : diagnosticsDir(config.home);
        setImageDiagnostics({ dir });
    }
    const retries = Number.isSafeInteger(config?.limits?.retries)
        ? config.limits.retries
        : (Number.isSafeInteger(config?.retries) ? config.retries : defaults.retries);
    const announce = (event) => { try { onEvent?.(event); } catch { /* an observer never breaks a request */ } };
    const sizeHintMode = config?.image?.sizeHint ?? 'auto';
    const div16Mode = config?.image?.div16 ?? 'auto';
    const padToMinMode = config?.image?.padToMin ?? 'auto';

    /**
     * The pools of the hosts: one for the text route, one for the picture route.
     *
     * The pool remembers what every host said — no money, no key, no route, no model — so the
     * next request does not pay for the same refusal again. The host that answered is moved to
     * the front of its pool: the one that works is asked first.
     * @type {Map<string, object>}
     */
    const pools = new Map();

    /**
     * The pool of one route kind.
     * @param {'text'|'images'} kind
     * @returns {object}
     */
    function poolFor(kind) {
        if (!pools.has(kind)) {
            pools.set(kind, createBackendPool({
                backends: resolveBackends(config, { kind, env }),
            }));
        }
        return pools.get(kind);
    }

    /**
     * The local raster adapter: padding, cropping and scaling of the pictures.
     *
     * The client works without it (the local corrections are then skipped and reported), so a
     * build without the native engines still talks to the API.
     * @returns {Promise<object|null>}
     */
    async function rasterAdapter() {
        if (raster) return raster;
        try {
            const mod = await import('../image/raster.js');
            return await mod.getRaster({
                engine: config?.image?.rasterEngine ?? 'auto',
                magickPath: config?.image?.magickPath ?? null,
            });
        } catch {
            return null;
        }
    }

    /**
     * Build an ApiError out of a failed response.
     * @param {{ status: number, headers: object, body: AsyncGenerator<Buffer> }} res
     * @param {string|null} clientRequestId
     * @returns {Promise<ApiError>}
     * @ai.hint io
     */
    async function apiErrorFrom(res, clientRequestId) {
        const raw = await readBody(res.body, defaults.maxErrorBytes, { truncate: true }).catch(() => Buffer.alloc(0));
        const text = raw.toString('utf8').trim();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const err = isRecord(parsed) ? (parsed.error ?? parsed) : null;
        const details = isRecord(err) ? err : {};
        const fromBody = typeof err === 'string' ? err : textOf(details.message);
        const message = (fromBody || text).slice(0, 2000) || `HTTP ${res.status}`;
        return new ApiError(message, {
            code: 'API_ERROR',
            status: res.status,
            requestId: res.headers['x-request-id'] ?? null,
            clientRequestId,
            retryAfter: res.headers['retry-after'] ?? null,
            apiCode: details.code ?? null,
            apiType: details.type ?? null,
            param: details.param ?? null,
            retryable: RETRYABLE_STATUS.has(res.status),
        });
    }

    /**
     * Send one request to one backend, with the configured number of retries.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {{ method?: string, body?: object, rawBody?: Buffer|string, contentType?: string,
     *   signal?: AbortSignal|null }} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function send(backend, path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        signal: callSignal = null,
    } = {}) {
        const root = normalizeBaseURL(backend.baseURL);
        const url = new URL(path, root);
        let attempt = 0;
        for (;;) {
            const clientRequestId = randomUUID();
            const headers = {
                Authorization: `Bearer ${backend.apiKey ?? ''}`,
                'X-Client-Request-Id': clientRequestId,
                ...backend.headers,
            };
            if (rawBody !== null) headers['Content-Type'] = contentType;
            else if (body !== null) headers['Content-Type'] = 'application/json';

            let res;
            try {
                res = await transport.request({
                    url,
                    method,
                    headers,
                    body: rawBody !== null ? rawBody : (body !== null ? JSON.stringify(body) : undefined),
                    signal: callSignal ?? signal,
                });
            } catch (error) {
                const wrapped = error instanceof ApiError
                    ? error
                    : new ApiError(`Network error: ${error.message}`, { code: 'NETWORK_ERROR', retryable: true, cause: error });
                if (wrapped.code === 'ABORTED' || error?.name === 'AbortError') throw wrapped;
                if (attempt < retries && wrapped.retryable !== false) {
                    const delay = retryDelayMs(attempt, null, null);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: wrapped.message });
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                throw wrapped;
            }

            if (res.status >= 400) {
                const error = await apiErrorFrom(res, clientRequestId);
                if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
                    const delay = retryDelayMs(attempt, error.retryAfter, res.status);
                    announce({ type: 'request.retry', attempt: attempt + 1, delayMs: delay, error: error.message });
                    await sleep(delay);
                    attempt++;
                    continue;
                }
                throw error;
            }

            return { res, backend, root };
        }
    }

    /**
     * Read a JSON answer.
     * @param {AsyncGenerator<Buffer>} body
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function readJson(body) {
        const raw = await readBody(body, defaults.maxResponseBytes);
        const text = raw.toString('utf8');
        if (!text.trim()) return {};
        try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    /**
     * Call one route on one backend, without the rotation.
     * @param {object} backend
     * @param {string} path route relative to the base URL
     * @param {object} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function callBackend(backend, path, { method = 'POST', body = null, rawBody = null,
        contentType = 'application/json', signal: callSignal = null, model = null } = {}) {
        announce({ type: 'request.start', backend: backend.baseURL, path, model });
        const { res } = await send(backend, path, { method, body, rawBody, contentType, signal: callSignal });
        return readJson(res.body);
    }

    /**
     * Call a route, rotating over the backends of the kind.
     *
     * Every host is asked until one of them answers. The refusals are classified and remembered:
     * a host without money is not asked again, a host that does not know the model is not asked
     * that model again, and the reason of the whole rotation is the one a person can act on.
     * @param {string} path
     * @param {object} options
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function call(path, {
        method = 'POST', body = null, rawBody = null, contentType = 'application/json',
        kind = 'text', model = null, signal: callSignal = null, supports = null, route = null,
    } = {}) {
        const pool = poolFor(kind);
        const routeName = route ?? supports ?? null;
        let chain = pool.candidates({ model, route: routeName });
        if (supports) {
            const skipped = chain.filter((backend) => backend.supports?.[supports] === false);
            for (const backend of skipped) {
                announce({ type: 'request.skip', backend: backend.baseURL, reason: `no ${supports} route` });
            }
            chain = chain.filter((backend) => backend.supports?.[supports] !== false);
        }
        if (!chain.length) {
            // Every host of this pool is out of the game for this request.
            const remembered = pool.report().filter((item) => item.broke || item.unauthorized
                || (model && item.models.includes(model)) || (routeName && item.routes.includes(routeName)));
            throw new ApiError(
                `No host of the ${kind} route can serve this request${model ? ` (model ${model})` : ''}.`,
                { code: 'NO_BACKEND', details: { remembered } },
            );
        }
        const attempts = [];
        let lastError = null;
        for (const backend of chain) {
            try {
                const answer = await callBackend(backend, path, {
                    method, body, rawBody, contentType, signal: callSignal, model,
                });
                // The host that answered is asked first from now on.
                pool.promote(backend);
                return answer;
            } catch (error) {
                if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
                lastError = error;
                const failure = pool.note({ backend, model, route: routeName, error });
                attempts.push({
                    backend: backend.baseURL,
                    kind: failure.kind,
                    status: failure.status,
                    message: failure.message,
                });
                announce({
                    type: 'request.error',
                    backend: backend.baseURL,
                    status: failure.status,
                    error: failure.message,
                    kind: failure.kind,
                });
                if (failure.kind === 'no_credit') {
                    announce({
                        type: 'host.broke',
                        backend: backend.baseURL,
                        error: failure.message,
                    });
                }
            }
        }
        throw aggregateFailure(attempts, lastError);
    }

    /**
     * Download a picture the API answered with a URL.
     * @param {string} url
     * @param {AbortSignal|null} callSignal
     * @returns {Promise<Buffer>}
     * @ai.hint io
     */
    async function fetchImageBytes(url, callSignal) {
        const target = new URL(url);
        const res = await transport.request({
            url: target,
            method: 'GET',
            headers: { Accept: 'image/*' },
            signal: callSignal ?? signal,
        });
        if (res.status >= 400) throw await apiErrorFrom(res, null);
        const bytes = await readBody(res.body, defaults.maxResponseBytes);
        if (!bytes.length) throw new ApiError('The downloaded picture is empty.', { code: 'INVALID_RESPONSE' });
        return bytes;
    }

    /**
     * The base64 payloads of an answer, whatever route it came from.
     *
     * When the built-in readers find nothing, the answer is offered to the AI parser: the model
     * writes a script that walks the shape it sees and returns the payloads.
     * @param {object} result
     * @param {{ route: string, model?: string|null, signal?: AbortSignal|null }} meta
     * @returns {Promise<string[]>}
     * @ai.hint io
     */
    async function payloadList(result, { route, model = null, signal: callSignal = null }) {
        const failure = route === 'responses' ? responsesError(result, route) : imageErrorFromResult(result);
        if (failure) throw failure;
        let sources = route === 'responses'
            ? responsesImagePayloads(result).map((value) => ({ kind: 'b64', value }))
            : imageSources(result);
        if (!sources.length) {
            const salvaged = await salvage(result, { route, model, signal: callSignal });
            if (salvaged?.length) sources = salvaged;
        }
        if (!sources.length) {
            const keys = isRecord(result) ? Object.keys(result) : [];
            const rows = Array.isArray(result?.data) ? result.data : null;
            const rowKeys = rows?.[0] && isRecord(rows[0]) ? Object.keys(rows[0]) : [];
            throw new ApiError(
                `The answer of ${route} carries neither b64_json nor url (fields: ${keys.join(', ') || 'none'}; `
                + `data: ${rows ? `an array of ${rows.length}` : typeof result?.data}; `
                + `fields of the first result: ${rowKeys.join(', ') || 'none'}).`,
                {
                    code: 'INVALID_RESPONSE',
                    details: { responseKeys: keys, dataType: Array.isArray(result?.data) ? 'array' : typeof result?.data, dataCount: rows?.length ?? null, firstResultKeys: rowKeys },
                });
        }
        const out = [];
        for (const source of sources) {
            if (source.kind === 'b64') { out.push(source.value); continue; }
            out.push((await fetchImageBytes(source.value, callSignal)).toString('base64'));
        }
        return out;
    }

    /**
     * The second chance: the model writes a script that reads the picture out of an answer of an
     * unusual shape, and the script runs in a sandbox.
     *
     * The parser is opt-out (`image.parser.enabled`), and it needs a model: `image.parser.model`,
     * then `parserModel`, then the text model.
     * @param {object} result
     * @param {{ route: string, model?: string|null, signal?: AbortSignal|null }} meta
     * @returns {Promise<Array<{kind:'b64'|'url', value:string}>|null>}
     * @ai.hint io
     */
    async function salvage(result, { route, model = null, signal: callSignal = null }) {
        const parser = config?.image?.parser ?? {};
        if (parser.enabled === false) return null;
        const parserModel = parser.model || config?.parserModel || config?.model || null;
        if (!parserModel) return null;
        try {
            const { makeParserInvoke, parseImageResponseWithAI } = await import('./parser.js');
            return await parseImageResponseWithAI({
                result,
                route,
                model,
                invoke: makeParserInvoke(api),
                parserModel,
                root: parser.root ?? process.cwd(),
                signal: callSignal ?? signal,
                archive: parser.archive !== false,
                onWarn: (message) => announce({ type: 'warning', message }),
                onArchive: (file) => announce({ type: 'diagnostics.archived', file }),
            });
        } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
            announce({ type: 'warning', message: `Fallback parse failed (${error?.message ?? error}).` });
            return null;
        }
    }

    /**
     * Scale every payload to the frame the caller asked for.
     *
     * The alternative to the alignment path: a model that answers with a bigger frame than the
     * request named is scaled down to it, with the aspect ratio kept. A payload that is already
     * at or under the target is left alone.
     * @param {string[]} payloads
     * @param {string|null|undefined} target
     * @param {object|null} adapter
     * @returns {Promise<string[]>}
     * @ai.hint io
     */
    async function fitPayloads(payloads, target, adapter) {
        const frame = parseImageSize(String(target ?? '').trim());
        if (!frame || !adapter?.fitToFrame) return payloads;
        const out = [];
        for (const payload of payloads) {
            const bytes = Buffer.from(payload, 'base64');
            const got = readImageSizeSafe(bytes);
            if (!got || (got.width <= frame.width && got.height <= frame.height)) { out.push(payload); continue; }
            const resized = await adapter.fitToFrame({ bytes, width: frame.width, height: frame.height, fit: 'cover' }).catch(() => null);
            out.push(resized ? resized.toString('base64') : payload);
        }
        return out;
    }

    /**
     * Cut the padding off every payload.
     * @param {string[]} payloads
     * @param {{ width: number, height: number, originalWidth: number, originalHeight: number }} padding
     * @param {object|null} adapter
     * @returns {Promise<string[]>}
     * @ai.hint io
     */
    async function cropPayloads(payloads, padding, adapter) {
        if (!adapter?.removeImagePadding) return payloads;
        const out = [];
        for (const payload of payloads) {
            const bytes = Buffer.from(payload, 'base64');
            const cut = await adapter.removeImagePadding({ bytes, ...padding }).catch(() => null);
            out.push(cut ? cut.toString('base64') : payload);
        }
        return out;
    }

    /**
     * The frame of a source, read from the bytes themselves.
     * @param {Buffer} bytes
     * @returns {{width: number, height: number}|null}
     * @ai.hint pure
     */
    function readImageSizeSafe(bytes) {
        try {
            return readImageSize(bytes);
        } catch {
            return null;
        }
    }

    /**
     * The model of a request: the explicit one, then the model of the purpose, then the model
     * of the configuration.
     * @param {{ model?: string|null, purpose?: string|null }} params
     * @returns {string|null}
     * @ai.hint pure
     */
    function resolveModel({ model = null, purpose = null }) {
        if (model) return model;
        const routed = resolvePurposeModel(config, purpose);
        if (routed) return routed;
        return config?.imageModel ?? config?.model ?? null;
    }

    /**
     * The chain of the models of a request: the model of the request first, then its fallbacks.
     * @param {string|null} model
     * @returns {string[]}
     * @ai.hint pure
     */
    function modelChain(model) {
        const chain = fallbackChain(config, model);
        return chain.length ? chain : (model ? [model] : []);
    }

    /**
     * The Responses API with the built-in picture tool — the fallback route of a host that does
     * not know `/images/generations`.
     *
     * The source pictures of an edit travel with the request as data URIs: a host that has no
     * edit route still gets the picture it has to change, not only the words about it.
     * @param {{ model: string, prompt: string, size?: string|null, format?: string|null,
     *   background?: string|null, references?: string[], signal?: AbortSignal|null }} params
     * @returns {Promise<object>}
     * @ai.hint io
     */
    async function responsesImage({ model, prompt, size = null, format = null, background = null,
        references = [], signal: callSignal = null }) {
        const input = references.length
            ? [
                { type: 'input_text', text: String(prompt ?? '') },
                ...references.map((url) => ({ type: 'input_image', image_url: url })),
            ]
            : prompt;
        const body = buildResponsesBody({
            model,
            input,
            tools: [imageGenerationTool({ format, size, background })],
            toolChoice: { type: 'image_generation' },
        });
        announce({ type: 'transport.fallback', reason: 'the host has no images route; the request goes to the Responses API' });
        return await call('responses', {
            method: 'POST', body, kind: 'text', model, signal: callSignal,
            supports: 'responses', route: 'image-generation',
        });
    }

    /**
     * Generate a picture: one attempt of one model.
     * @param {object} params
     * @returns {Promise<{ payloads: string[], route: string, raw: object }>}
     * @ai.hint io
     */
    async function generateOnce({ model, prompt, size, complexity, n, format, background, references, resolution, signal: callSignal }) {
        const body = generationBody({
            model, prompt, size, complexity, n, format, background, references, resolution, sizeHint: sizeHintMode,
        });
        // A host that was asked before and did not serve the route is not asked again: the
        // request goes to the Responses API right away.
        const imageHosts = poolFor('images').candidates({ model, route: 'images' });
        if (imageHosts.length) {
            try {
                const result = await call('images/generations', {
                    method: 'POST', body, kind: 'images', model, signal: callSignal, supports: 'images',
                });
                const failure = imageErrorFromResult(result);
                if (failure) throw failure;
                return { payloads: await payloadList(result, { route: 'images/generations', model, signal: callSignal }), route: 'images/generations', raw: result };
            } catch (error) {
                if (!isRouteUnsupported(error)) throw error;
            }
        }
        const answer = await responsesImage({ model, prompt, size, format, background, signal: callSignal });
        return { payloads: await payloadList(answer, { route: 'responses', model, signal: callSignal }), route: 'responses', raw: answer };
    }

    /**
     * Edit a picture: one attempt of one model.
     * @param {object} params
     * @returns {Promise<{ payloads: string[], route: string, raw: object }>}
     * @ai.hint io
     */
    async function editOnce({ model, prompt, fields, files, signal: callSignal }) {
        const form = encodeMultipart({ fields, files });
        const imageHosts = poolFor('images').candidates({ model, route: 'images' });
        if (imageHosts.length) {
            try {
                const result = await call('images/edits', {
                    method: 'POST', rawBody: form.body, contentType: form.contentType,
                    kind: 'images', model, signal: callSignal, supports: 'images',
                });
                const failure = imageErrorFromResult(result);
                if (failure) throw failure;
                return { payloads: await payloadList(result, { route: 'images/edits', model, signal: callSignal }), route: 'images/edits', raw: result };
            } catch (error) {
                if (!isRouteUnsupported(error)) throw error;
            }
        }
        // A host without the edit route gets the edit as a generation with the source as a
        // reference: the picture travels as a data URI inside the request.
        const references = files.map((file) => `data:${file.mime || 'image/png'};base64,${Buffer.from(file.bytes).toString('base64')}`);
        const answer = await responsesImage({
            model, prompt, size: fields.size ?? null, format: fields[imageFormatField(model)] ?? null,
            background: fields.background ?? null, references, signal: callSignal,
        });
        return { payloads: await payloadList(answer, { route: 'responses', model, signal: callSignal }), route: 'responses', raw: answer };
    }

    const api = {
        /**
         * The Responses API: the text route of the CLI and the picture fallback route.
         */
        responses: {
            /**
             * The chain of the models of a text request: the asked model first, then its
             * fallbacks. A host that does not know the model asks for the next one — the same
             * way the picture route does.
             * @param {{ model?: string|null, instructions?: string|null, input?: unknown, tools?: object[]|null,
             *   toolChoice?: unknown, store?: boolean, text?: object|null, signal?: AbortSignal|null }} params
             * @returns {Promise<object>}
             */
            async create({ model = null, instructions = null, input = null, tools = null, toolChoice = null,
                store = false, text = null, signal: callSignal = null } = {}) {
                const wanted = model ?? config?.model ?? null;
                const chain = modelChain(wanted);
                let lastError = null;
                for (const [index, candidate] of chain.entries()) {
                    const body = buildResponsesBody({
                        model: candidate,
                        instructions, input, tools, toolChoice, store, text,
                    });
                    try {
                        const answer = await call('responses', {
                            method: 'POST', body, kind: 'text', model: candidate,
                            signal: callSignal, supports: 'responses',
                        });
                        const failure = responsesError(answer, 'responses');
                        if (failure) throw failure;
                        return answer;
                    } catch (error) {
                        if (error?.name === 'AbortError' || error?.code === 'ABORTED') throw error;
                        lastError = error;
                        // Only a host that does not know the model asks for the next one.
                        if (!isModelUnknown(error)) throw error;
                        const next = chain[index + 1] ?? null;
                        announce({
                            type: 'model.fallback',
                            from: candidate,
                            to: next,
                            error: error?.message ?? String(error),
                        });
                    }
                }
                throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
            },
            /**
             * The text of an answer of the Responses API.
             * @param {object} answer
             * @returns {string}
             */
            text: responsesOutputText,
        },

        /**
         * The pictures API.
         */
        images: {
            /**
             * Generate a picture.
             * @param {{ model?: string|null, purpose?: string|null, prompt: string, size?: string|null,
             *   complexity?: string|null, n?: number|null, format?: string|null, background?: string|null,
             *   references?: string[]|null, resolution?: string|null, signal?: AbortSignal|null }} params
             * @returns {Promise<{ images: Array<{bytes: Buffer, mime: string}>, payloads: string[], model: string, route: string }>}
             */
            async generate({
                model = null, purpose = null, prompt, size = null, complexity = null, n = null, format = null,
                background = null, references = null, resolution = null, signal: callSignal = null,
            } = {}) {
                const usedModel = resolveModel({ model, purpose });
                if (!usedModel) throw new ApiError('No image model is configured.', { code: 'NO_MODEL' });
                const vector = isSvgRequest({ model: usedModel, format });
                const attempts = vector ? [] : imageSizeAttempts(size, usedModel, resolution);
                const chain = modelChain(usedModel);
                let lastError = null;
                for (const candidate of chain) {
                    for (let index = 0; ; index++) {
                        const requestedSize = index < attempts.length ? attempts[index] : size;
                        try {
                            const answer = await generateOnce({
                                model: candidate, prompt, size: requestedSize, complexity, n, format,
                                background, references, resolution, signal: callSignal,
                            });
                            const adapter = await rasterAdapter();
                            // A vector answer is a document: it is never resampled to the asked frame.
                            const payloads = vector
                                ? answer.payloads
                                : await fitPayloads(answer.payloads, size, adapter);
                            return {
                                images: payloads.map((payload) => {
                                    const bytes = Buffer.from(payload, 'base64');
                                    return { bytes, mime: sniffImage(bytes).mime };
                                }),
                                payloads,
                                model: candidate,
                                route: answer.route,
                                raw: answer.raw,
                            };
                        } catch (error) {
                            lastError = error;
                            // Another frame is asked only when the host refused the frame.
                            if (isImageSizeError(error) && index < attempts.length - 1) continue;
                            // Another model is asked only when the host does not know this one.
                            if (isModelUnknown(error)) break;
                            throw error;
                        }
                    }
                }
                throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
            },

            /**
             * Edit a picture.
             *
             * The frame of the request is aligned with the model before it goes out: a frame the
             * model cannot take is padded into a canvas that can hold it (the content keeps its
             * scale and position), and the padding is cut off the answer. A frame the model
             * answers with a bigger picture than asked for is scaled down afterwards.
             * @param {{ model?: string|null, purpose?: string|null, prompt: string, files: object[], size?: string|null,
             *   complexity?: string|null, n?: number|null, format?: string|null, background?: string|null,
             *   resolution?: string|null, signal?: AbortSignal|null }} params
             * @returns {Promise<{ images: Array<{bytes: Buffer, mime: string}>, payloads: string[], model: string, route: string }>}
             */
            async edit({
                model = null, purpose = null, prompt, files = [], size = null, complexity = null, n = null,
                format = null, background = null, resolution = null, signal: callSignal = null,
            } = {}) {
                const usedModel = resolveModel({ model, purpose });
                if (!usedModel) throw new ApiError('No image model is configured.', { code: 'NO_MODEL' });
                if (!files.length) throw new ApiError('The edit needs at least one source picture.', { code: 'INVALID_REQUEST' });
                const vector = isSvgRequest({ model: usedModel, format });
                const adapter = await rasterAdapter();
                const profile = imageModelProfile(usedModel);

                // The frame of the request, or the frame of the source when the request names none.
                const sourceFrame = files[0]?.bytes ? readImageSizeSafe(Buffer.from(files[0].bytes)) : null;
                const plan = planEdit({
                    model: usedModel,
                    size,
                    resolution,
                    sourceFrame,
                    div16: div16Mode,
                    padToMin: padToMinMode,
                });
                let requestFiles = files;
                let padding = null;
                let frame = plan.frame;

                if (!vector && plan.mode === 'align' && plan.pad && adapter?.padImageBytes) {
                    const padded = await adapter.padImageBytes({
                        bytes: Buffer.from(files[0].bytes),
                        targetWidth: plan.pad.width,
                        targetHeight: plan.pad.height,
                    }).catch(() => null);
                    if (padded?.padded) {
                        requestFiles = files.map((file, index) => (index === 0
                            ? { ...file, filename: file.filename ?? 'image.png', mime: 'image/png', bytes: padded.bytes }
                            : file));
                        padding = {
                            width: padded.width,
                            height: padded.height,
                            originalWidth: padded.originalWidth,
                            originalHeight: padded.originalHeight,
                        };
                        frame = plan.frame;
                    }
                }

                // The prompt repeats the alignment: the content keeps its own scale in the corner
                // of the canvas, and the empty space is padding that is cut off afterwards.
                let text = String(prompt ?? '');
                if (padding) {
                    text += `\n\nKeep the source artwork at its original scale and position in the top-left corner `
                        + `(${padding.originalWidth}x${padding.originalHeight} of a ${padding.width}x${padding.height} canvas); `
                        + 'do not upscale, stretch, or recenter it. The empty area is padding and will be cropped away.';
                }

                const attempts = vector ? [] : imageSizeAttempts(frame, usedModel, resolution);
                const chain = modelChain(usedModel);
                let lastError = null;
                for (const candidate of chain) {
                    for (let index = 0; ; index++) {
                        const attemptSize = index < attempts.length ? attempts[index] : frame;
                        try {
                            const fields = buildEditFields({
                                model: candidate, prompt: text, size: attemptSize, format, background,
                                complexity, n, resolution, vector, sizeHint: sizeHintMode,
                            });
                            const answer = await editOnce({
                                model: candidate, prompt: text, fields,
                                files: requestFiles.map((file) => ({ ...file, field: 'image' })),
                                signal: callSignal,
                            });
                            let payloads = answer.payloads;
                            if (!vector) {
                                if (padding) payloads = await cropPayloads(payloads, padding, adapter);
                                payloads = await fitPayloads(payloads, plan.requested ? `${plan.requested.width}x${plan.requested.height}` : size, adapter);
                            }
                            return {
                                images: payloads.map((payload) => {
                                    const bytes = Buffer.from(payload, 'base64');
                                    return { bytes, mime: sniffImage(bytes).mime };
                                }),
                                payloads,
                                model: candidate,
                                route: answer.route,
                                raw: answer.raw,
                                padding,
                            };
                        } catch (error) {
                            lastError = error;
                            if (isImageSizeError(error) && index < attempts.length - 1) continue;
                            if (isModelUnknown(error)) break;
                            throw error;
                        }
                    }
                }
                throw lastError ?? new ApiError('No model answered the request.', { code: 'NO_MODEL' });
            },

            /**
             * Vectorize one raster into SVG.
             *
             * The source goes through the edit route as a multipart `image` field: the generation
             * route ignores an image reference for these models, while the edit route conditions
             * on the pixels and keeps the frame of the source.
             * @param {{ model?: string|null, prompt?: string, image: { filename?: string, mime?: string, bytes: Buffer },
             *   size?: string|null, signal?: AbortSignal|null }} params
             * @returns {Promise<{ images: Array<{bytes: Buffer, mime: string}>, payloads: string[], model: string, route: string }>}
             */
            async vectorize({ model = null, prompt = '', image, size = null, signal: callSignal = null } = {}) {
                if (!image?.bytes?.length) {
                    throw new ApiError('The vectorizing needs a source raster.', { code: 'INVALID_REQUEST' });
                }
                return await this.edit({
                    model,
                    prompt: prompt || 'Trace this picture as a vector SVG document with the same shapes and colors.',
                    files: [{ filename: image.filename || 'source.png', mime: image.mime, bytes: image.bytes }],
                    size,
                    format: 'svg',
                    signal: callSignal,
                });
            },
        },

        /**
         * The backends of one route kind as sticky channels.
         *
         * A channel talks to one host and never rotates: a task id belongs to the host that
         * created it, so the task is polled there.
         * @param {'text'|'images'} kind
         * @param {string|null} model
         * @returns {Array<{ label: string, baseURL: string, call: Function }>}
         */
        channels(kind = 'text', model = null) {
            return resolveBackends(config, { kind, model, env }).map((backend) => ({
                label: backend.baseURL,
                baseURL: backend.baseURL,
                call: (path, options = {}) => callBackend(backend, path, options),
            }));
        },

        /**
         * The backends in use, for the diagnostics and the dry run.
         * @param {{ kind?: 'text'|'images', model?: string|null }} [options]
         * @returns {Array<{ baseURL: string, apiKey: string|null, supports: object }>}
         */
        backends({ kind = 'text', model = null } = {}) {
            return resolveBackends(config, { kind, model, env });
        },

        /**
         * Close the transport.
         * @returns {void}
         * @ai.hint io
         */
        close() {
            transport.close();
        },
    };

    return api;
}

/**
 * The fields of an edit request.
 *
 * A vector call carries its frame verbatim (there is no raster to pad and the document is cut
 * by its own geometry); a raster call carries the fields of the ladder of the model.
 * @param {{ model: string, prompt: string, size?: string|null, format?: string|null, background?: string|null,
 *   complexity?: string|null, n?: number|null, resolution?: string|null, vector?: boolean }} params
 * @returns {object}
 * @ai.hint pure
 */
export function buildEditFields({ model, prompt, size = null, format = null, background = null,
    complexity = null, n = null, resolution = null, vector = false, sizeHint = 'auto' } = {}) {
    const fields = { model, prompt };
    if (vector) {
        const asked = String(size ?? '').trim();
        if (imageModelProfile(model).customSizes && /^\d+\s*x\s*\d+$/.test(asked)) {
            fields.size = sameAspectImageSize(asked.replace(/\s+/g, ''), model) || asked.replace(/\s+/g, '');
        } else {
            const aspect = normalizeVectorRatio(asked);
            if (aspect) fields.aspect_ratio = aspect;
        }
        fields[imageFormatField(model)] = 'svg';
        const svgModel = svgConversionModel(model);
        if (svgModel) fields.svg = svgModel;
        return fields;
    }
    const sizeFields = imageSizeFields(size, model, resolution);
    if (sizeFields.size) fields.size = sizeFields.size;
    if (sizeFields.resolution) fields.resolution = sizeFields.resolution;
    if (sizeFields.aspect_ratio) fields.aspect_ratio = sizeFields.aspect_ratio;
    const fmt = resolveImageFormat({ model, format });
    if (fmt) fields[imageFormatField(model)] = fmt;
    const backgroundField = backgroundValue({ model, format: fmt, background });
    if (backgroundField) fields.background = backgroundField;
    const cx = imageComplexityValue({ model, complexity });
    if (cx) fields.complexity = cx;
    if (Number.isInteger(n) && n > 1) fields.n = n;
    fields.prompt = withSizeHint(prompt, fields, model, sizeHint);
    return fields;
}

export { ApiError };