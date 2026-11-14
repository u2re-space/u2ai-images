/**
 * @file src/openai/rotation.js
 * @module openai/rotation
 * @purpose The rotation over the backends: what kind of refusal an answer is, and what the pool
 *          of the hosts remembers about it.
 *
 *   The rotation of the earlier version asked every host in turn and kept the refusal of the
 *   last one. That loses the two facts a run needs most: which host refused and why. A host
 *   without money was asked again on the next request, a host that does not know the model was
 *   asked again for every picture of the run, and the refusal of the last host hid the reason
 *   the first one gave — so the run blamed the wrong thing.
 *
 *   The pool keeps both. Every refusal is classified (no money, no key, no route, no model,
 *   too many requests, a broken request, a dead network), the host is remembered, and the next
 *   request does not pay for the same refusal again. The host that answered is moved to the
 *   front: the one that works is asked first from then on.
 *
 * @depends openai/errors
 * @usedBy openai/client, openai/fallback
 * @exports FAILURE, classifyFailure, createBackendPool, aggregateFailure, attemptsOf
 * @ai.tags openai, fallback, backends
 * @ai.hint pure
 */

import { ApiError } from './errors.js';

/**
 * The kinds of a refusal.
 *
 * The kind says what the run may do next: another host of the same request, the next model, or
 * nothing at all.
 * @type {Readonly<Record<string, string>>}
 */
export const FAILURE = Object.freeze({
    /** The run was cancelled. */
    ABORT: 'abort',
    /** The host has no money left. */
    NO_CREDIT: 'no_credit',
    /** The host does not accept the key. */
    UNAUTHORIZED: 'unauthorized',
    /** The host does not know the model. */
    MODEL: 'model',
    /** The host does not serve the route. */
    ROUTE: 'route',
    /** The host is busy and asks for a pause. */
    RATE: 'rate',
    /** The host is broken. */
    SERVER: 'server',
    /** The request itself is wrong. */
    REQUEST: 'request',
    /** The network is broken. */
    NETWORK: 'network',
    /** Nothing is known about the refusal. */
    OTHER: 'other',
});

/** The words of a host that has no money left. */
const NO_CREDIT = /insufficient\s+balance|insufficient[_ ]quota|no\s+balance|not\s+enough\s+(?:money|credit|balance|funds)|quota\s+(?:is\s+)?exceeded|payment\s+required|balance\s+is\s+empty|не\s+достаточно\s+средств/i;

/** The words of a host that does not accept the key. */
const UNAUTHORIZED = /invalid\s+api\s*key|incorrect\s+api\s*key|unauthorized|authentication\s+(?:failed|error)|no\s+api\s*key|missing\s+api\s*key|forbidden/i;

/** The words that turn a refusal into a refusal of the model. */
const MODEL_MISSING = /not\s+found|does\s+not\s+exist|unknown|unavailable|no\s+such|no\s+model|not\s+supported|не\s+найден/i;

/** The words of a host that does not serve the route. */
const ROUTE_MISSING = /not\s+found\s+in\s+this\s+api|no\s+such\s+(?:route|endpoint)|unknown\s+endpoint|unsupported\s+endpoint|does\s+not\s+support\s+(?:images|image)/i;

/**
 * The kind of a refusal.
 *
 * The order of the checks matters: a refusal that names a model is about the model and not about
 * the route, and a refusal that names the balance is about the money and not about the key.
 * @param {object} error the error of the call
 * @returns {{ kind: string, status: number|null, message: string, retryable: boolean }}
 * @exports
 * @ai.hint pure
 */
export function classifyFailure(error) {
    const status = Number(error?.status ?? 0) || null;
    const message = String(error?.message ?? '');
    const apiCode = String(error?.apiCode ?? '').toLowerCase();

    let kind = FAILURE.OTHER;
    if (error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'ABORT_ERR') {
        kind = FAILURE.ABORT;
    } else if (status === 402 || apiCode === 'insufficient_quota' || apiCode === 'billing_hard_limit_reached'
        || NO_CREDIT.test(message)) {
        kind = FAILURE.NO_CREDIT;
    } else if (status === 401 || status === 403 || UNAUTHORIZED.test(message)) {
        kind = FAILURE.UNAUTHORIZED;
    } else if (apiCode === 'model_not_found'
        || (/\bmodel\b/i.test(message) && MODEL_MISSING.test(message))) {
        kind = FAILURE.MODEL;
    } else if (status === 404 || status === 405 || status === 501 || ROUTE_MISSING.test(message)) {
        kind = FAILURE.ROUTE;
    } else if (status === 429) {
        kind = FAILURE.RATE;
    } else if (status !== null && status >= 500) {
        kind = FAILURE.SERVER;
    } else if (status === 400 || status === 422) {
        kind = FAILURE.REQUEST;
    } else if (error?.code === 'NETWORK_ERROR'
        || /network|fetch failed|econnreset|etimedout|socket hang up/i.test(message)) {
        kind = FAILURE.NETWORK;
    }

    return {
        kind,
        status,
        message,
        retryable: kind === FAILURE.RATE || kind === FAILURE.SERVER,
    };
}

/**
 * The attempts of a refusal: every host that was asked, and what it answered.
 *
 * The aggregate error of a rotation carries them all, so the caller can tell "the model is
 * unknown everywhere" from "the hosts are out of money" without asking every host again.
 * @param {object} error
 * @returns {Array<{ backend: string, kind: string, status: number|null, message: string }>}
 * @exports
 * @ai.hint pure
 */
export function attemptsOf(error) {
    const attempts = error?.details?.attempts;
    return Array.isArray(attempts) ? attempts : [];
}

/**
 * The refusal of a whole rotation: the reason that matters most, and the list of the hosts.
 *
 * The reason that matters most is the one a person can act on: a broken request is broken for
 * every host, a missing model is a missing model, and a host without money is a host without
 * money. The rest of the refusals are appended, so nothing is lost.
 * @param {Array<{ backend: string, kind: string, status: number|null, message: string }>} attempts
 * @param {object|null} lastError the error of the last host
 * @returns {ApiError}
 * @exports
 * @ai.hint pure
 */
export function aggregateFailure(attempts, lastError = null) {
    if (!attempts?.length) {
        return lastError ?? new ApiError('No backend answered the request.', { code: 'NO_BACKEND' });
    }
    // The order of the reasons: what a person can act on comes first.
    const order = [
        FAILURE.REQUEST, FAILURE.MODEL, FAILURE.NO_CREDIT, FAILURE.UNAUTHORIZED,
        FAILURE.OTHER, FAILURE.ROUTE, FAILURE.RATE, FAILURE.SERVER, FAILURE.NETWORK, FAILURE.ABORT,
    ];
    const rank = (kind) => {
        const index = order.indexOf(kind);
        return index === -1 ? order.length : index;
    };
    const first = [...attempts].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
    const others = attempts.filter((item) => item !== first);
    const message = others.length
        ? `${first.message} (${others.map((item) => `${item.backend}: ${item.message}`).join('; ')})`
        : first.message;
    return new ApiError(message, {
        code: 'ALL_BACKENDS_FAILED',
        status: first.status ?? null,
        details: { attempts },
        cause: lastError ?? undefined,
    });
}

/**
 * The pool of the hosts of one route kind.
 *
 * The pool holds the hosts in the order of the configuration and remembers what each of them
 * said: a host without money and a host with a bad key are asked no more, a host that does not
 * know a model is not asked that model again, and a host that does not serve a route is not
 * asked for it again.
 * @param {{ backends?: Array<object> }} options
 * @returns {{ all: Function, candidates: Function, note: Function, promote: Function,
 *   report: Function, forgotten: Function }}
 * @exports
 * @ai.hint pure
 */
export function createBackendPool({ backends = [] } = {}) {
    const list = Array.isArray(backends) ? [...backends] : [];
    /** What the pool remembers about every host. */
    const memory = new Map();

    /**
     * The memory of one host.
     * @param {object} backend
     * @returns {{ broke: boolean, unauthorized: boolean, models: Set<string>, routes: Set<string> }}
     */
    function stateOf(backend) {
        const key = String(backend?.baseURL ?? '');
        if (!memory.has(key)) {
            memory.set(key, { broke: false, unauthorized: false, models: new Set(), routes: new Set() });
        }
        return memory.get(key);
    }

    /**
     * The hosts that may serve this request.
     *
     * A host that is out of money, that does not accept the key, that does not know the model or
     * that does not serve the route is not asked: the run already knows the answer.
     * @param {{ model?: string|null, route?: string|null }} [options]
     * @returns {Array<object>}
     */
    function candidates({ model = null, route = null } = {}) {
        const out = [];
        for (const backend of list) {
            const state = stateOf(backend);
            if (state.broke || state.unauthorized) continue;
            if (model && state.models.has(model)) continue;
            if (route && state.routes.has(route)) continue;
            if (route && backend?.supports?.[route] === false) continue;
            out.push(backend);
        }
        return out;
    }

    /**
     * Remember what a host said.
     * @param {{ backend: object, model?: string|null, route?: string|null, error: object }} options
     * @returns {{ kind: string, status: number|null, message: string, retryable: boolean }}
     */
    function note({ backend, model = null, route = null, error }) {
        const failure = classifyFailure(error);
        const state = stateOf(backend);
        if (failure.kind === FAILURE.NO_CREDIT) state.broke = true;
        else if (failure.kind === FAILURE.UNAUTHORIZED) state.unauthorized = true;
        else if (failure.kind === FAILURE.MODEL && model) state.models.add(String(model));
        else if (failure.kind === FAILURE.ROUTE && route) state.routes.add(String(route));
        return failure;
    }

    /**
     * Move the host that answered to the front: the one that works is asked first.
     * @param {object} backend
     * @returns {void}
     */
    function promote(backend) {
        const index = list.indexOf(backend);
        if (index > 0) {
            list.splice(index, 1);
            list.unshift(backend);
        }
    }

    /**
     * What the pool remembers about every host.
     * @returns {Array<{ baseURL: string, broke: boolean, unauthorized: boolean, models: string[], routes: string[] }>}
     */
    function report() {
        return list.map((backend) => {
            const state = stateOf(backend);
            return {
                baseURL: String(backend?.baseURL ?? ''),
                broke: state.broke,
                unauthorized: state.unauthorized,
                models: [...state.models],
                routes: [...state.routes],
            };
        });
    }

    /**
     * Forget everything: the hosts are asked from the start again.
     * @returns {void}
     */
    function forgotten() {
        memory.clear();
    }

    return { all: () => [...list], candidates, note, promote, report, forgotten };
}
