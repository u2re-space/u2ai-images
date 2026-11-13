/**
 * @file src/openai/fallback.js
 * @module openai/fallback
 * @purpose The fallbacks of a request: the next model of the chain, and the recognition of the
 *          failures that ask for another model, another route or another frame.
 * @depends model/fallback, image/sizing
 * @exports fallbackModels, fallbackChain, withModelFallback, isRouteUnsupported, isModelUnknown,
 *          isImageSizeError
 * @ai.tags openai, fallback
 * @ai.hint keep
 */

import { fallbackChain, fallbackModels, withModelFallback } from '../model/fallback.js';
import { isImageSizeError } from '../image/sizing.js';

export { fallbackChain, fallbackModels, withModelFallback, isImageSizeError };

/**
 * The host does not know the route.
 *
 * A gateway that serves only the Responses API answers 404 to `/images/generations`, and
 * some of them say so in words ("not found in this api", "does not support images"). Such an
 * answer is not a failure of the request: the same request goes to another route.
 * @param {import('./errors.js').ApiError|Error} error
 * @returns {boolean}
 */
export function isRouteUnsupported(error) {
    if (error?.code === 'ROUTE_UNAVAILABLE') return true;
    const message = String(error?.message ?? '');
    // A refusal that names a model is about the model, not about the route.
    if (/\bmodel\b/i.test(message)) return false;
    if (/not\s+found\s+in\s+this\s+api|does\s+not\s+support\s+(?:images|image)|no\s+such\s+(?:route|endpoint)|unknown\s+endpoint|unsupported\s+endpoint/i.test(message)) {
        return true;
    }
    const status = error?.status;
    return status === 404 || status === 405 || status === 501;
}

/**
 * The host does not know the model.
 *
 * A gateway that serves another family of models answers 404 (or 400) with "model not found";
 * such an answer asks for the next model of the chain, not for another host.
 * @param {import('./errors.js').ApiError|Error} error
 * @returns {boolean}
 */
export function isModelUnknown(error) {
    if (error?.code === 'MODEL_NOT_FOUND') return true;
    if (error?.apiCode === 'model_not_found') return true;
    const message = String(error?.message ?? '');
    if (!/model/i.test(message)) return false;
    return /not\s+found|does\s+not\s+exist|unknown|unavailable|no\s+such|no\s+model|not\s+supported/i.test(message);
}
