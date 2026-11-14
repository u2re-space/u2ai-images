/**
 * @file src/config/validate.js
 * @module config/validate
 * @purpose Validation of the merged configuration against the enums and the
 *          allow-lists of the defaults. Every failure names the exact path of
 *          the field, so the CLI can print one actionable line.
 * @exports validateConfig
 * @ai.tags config
 * @ai.hint keep
 */

import { ENUMS, HEADER_NAME, SUPPORT_ALIASES } from './constants.js';
import { defaults, ROLE_FIELDS } from './defaults.js';
import { isRecord } from './merge.js';

/** The fields one backend entry may carry. */
const BACKEND_FIELDS = Object.freeze(['baseURL', 'apiKey', 'env', 'prefix', 'vendor', 'headers', 'body', 'supports']);

/**
 * Validate an optional header map: token names, single-line string values.
 * @param {unknown} headers
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateHeaders(headers, where, fail) {
    if (headers == null) return;
    if (!isRecord(headers)) fail(`${where} должен быть объектом`);
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name)) fail(`${where}.${name}: некорректное имя заголовка`);
        if (typeof value !== 'string' || /[\r\n]/.test(value)) fail(`${where}.${name}: строка без перевода строки`);
    }
}

/**
 * Normalize and validate a backend `supports` map through the alias table.
 * @param {unknown} supports
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateSupports(supports, where, fail) {
    if (supports == null) return;
    if (!isRecord(supports)) fail(`${where} должен быть объектом`);
    for (const [rawKey, value] of Object.entries(supports)) {
        const key = SUPPORT_ALIASES[rawKey.toLowerCase()] ?? rawKey;
        if (!ENUMS.backendRoutes.includes(key)) fail(`${where}.${rawKey}: ${ENUMS.backendRoutes.join(' | ')}`);
        if (typeof value !== 'boolean') fail(`${where}.${rawKey}: true | false`);
    }
}

/**
 * Validate one backend list (backends / imagesBackends).
 * @param {unknown} list
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateBackendList(list, where, fail) {
    if (!Array.isArray(list)) fail(`${where} должен быть массивом`);
    for (const [index, item] of list.entries()) {
        if (!isRecord(item)) fail(`${where}[${index}] должен быть объектом`);
        const entry = `${where}[${index}]`;
        for (const key of Object.keys(item)) {
            if (!BACKEND_FIELDS.includes(key)) fail(`${entry}.${key}: неизвестное поле`);
        }
        if (typeof item.baseURL !== 'string' || !item.baseURL.trim()) fail(`${entry}.baseURL должен быть URL`);
        try { new URL(item.baseURL); } catch { fail(`${entry}.baseURL должен быть URL`); }
        if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${entry}.apiKey: строка или null`);
        if (item.env != null && (typeof item.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.env))) fail(`${entry}.env: имя переменной или null`);
        if (item.prefix != null && typeof item.prefix !== 'string') fail(`${entry}.prefix: строка или null`);
        if (item.vendor != null && typeof item.vendor !== 'string') fail(`${entry}.vendor: строка или null`);
        validateHeaders(item.headers, `${entry}.headers`, fail);
        validateSupports(item.supports, `${entry}.supports`, fail);
    }
}

/**
 * Validate the fallback map: { "<model>": ["<fallback>", ...] }.
 * @param {unknown} map
 * @param {(message: string) => never} fail
 */
function validateFallbackModels(map, fail) {
    if (!isRecord(map)) fail('fallback.models должен быть объектом');
    for (const [model, list] of Object.entries(map)) {
        if (!model.trim()) fail('fallback.models: пустое имя модели');
        if (!Array.isArray(list) || !list.length) fail(`fallback.models.${model} должен быть непустым массивом`);
        for (const [index, item] of list.entries()) {
            if (typeof item !== 'string' || !item.trim()) fail(`fallback.models.${model}[${index}]: непустая строка`);
        }
    }
}

/**
 * Validate the purpose map: the order of the models per purpose.
 * @param {unknown} map
 * @param {(message: string) => never} fail
 */
function validatePurposeModels(map, fail) {
    if (!isRecord(map)) fail('purpose.models должен быть объектом');
    for (const [purpose, list] of Object.entries(map)) {
        const key = String(purpose).trim().toLowerCase();
        const canonical = ENUMS.purposeAliases[key] ?? key;
        if (!ENUMS.purposes.includes(canonical)) {
            fail(`purpose.models.${purpose}: неизвестный purpose (${ENUMS.purposes.join(' | ')})`);
        }
        if (!Array.isArray(list)) fail(`purpose.models.${purpose} должен быть массивом`);
        for (const [index, item] of list.entries()) {
            if (typeof item !== 'string' || !item.trim()) fail(`purpose.models.${purpose}[${index}]: непустая строка`);
        }
    }
}

/**
 * Throw when any merged value is outside the accepted enums and ranges.
 * @param {object} config
 * @returns {void}
 */
export function validateConfig(config) {
    const fail = (message) => { throw new Error(`Конфигурация: ${message}`); };
    const c = config;

    // --- models ------------------------------------------------------------------
    if (typeof c.model !== 'string' || !c.model.trim()) fail('укажите model (или AI_IMAGE_TEXT_MODEL / --model).');
    if (c.imageModel !== null && (typeof c.imageModel !== 'string' || !c.imageModel.trim())) fail('imageModel должен быть строкой или null.');
    if (c.parserModel !== null && (typeof c.parserModel !== 'string' || !c.parserModel.trim())) fail('parserModel должен быть строкой или null.');
    if (c.vectorModel !== null && (typeof c.vectorModel !== 'string' || !c.vectorModel.trim())) fail('vectorModel должен быть строкой или null.');

    // --- API ----------------------------------------------------------------------
    if (typeof c.baseURL !== 'string' || !c.baseURL.trim()) fail('baseURL должен быть URL.');
    try { new URL(c.baseURL); } catch { fail('baseURL должен быть URL.'); }
    if (c.apiKey !== null && (typeof c.apiKey !== 'string' || /[\r\n]/.test(c.apiKey))) fail('apiKey: строка или null.');
    if (c.organization !== null && typeof c.organization !== 'string') fail('organization: строка или null.');
    if (c.project !== null && typeof c.project !== 'string') fail('project: строка или null.');
    if (typeof c.store !== 'boolean') fail('store: true | false');
    if (!Number.isSafeInteger(c.retries) || c.retries < 0 || c.retries > 10) fail('retries: 0..10');
    if (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 5_000 || c.timeoutMs > 600_000) fail('timeoutMs: 5000..600000');

    // --- backends ------------------------------------------------------------------
    validateBackendList(c.backends, 'backends', fail);
    validateBackendList(c.imagesBackends, 'imagesBackends', fail);
    if (!isRecord(c.fallback)) fail('fallback должен быть объектом');
    if (typeof c.fallback.enabled !== 'boolean') fail('fallback.enabled: true | false');
    validateFallbackModels(c.fallback.models, fail);

    // --- batch ---------------------------------------------------------------------
    if (!isRecord(c.batch)) fail('batch должен быть объектом');
    for (const key of Object.keys(c.batch)) if (!(key in defaults.batch)) fail(`batch.${key}: неизвестное поле`);
    if (typeof c.batch.enabled !== 'boolean') fail('batch.enabled: true | false');
    if (!['off', 'submit', 'fetch'].includes(c.batch.mode)) fail('batch.mode: off | submit | fetch');
    if (c.batch.endpoint !== null && (typeof c.batch.endpoint !== 'string' || !c.batch.endpoint.startsWith('/'))) {
        fail('batch.endpoint: путь, начинающийся с /, или null');
    }
    if (c.batch.window !== '24h') fail('batch.window: 24h');
    if (!(Number.isSafeInteger(c.batch.collectMs) && c.batch.collectMs >= 100 && c.batch.collectMs <= 60_000)) {
        fail('batch.collectMs: целое 100..60000');
    }
    if (!(Number.isSafeInteger(c.batch.pollMs) && c.batch.pollMs >= 1000 && c.batch.pollMs <= 600_000)) {
        fail('batch.pollMs: целое 1000..600000');
    }
    if (!(Number.isSafeInteger(c.batch.waitMs) && c.batch.waitMs >= 0 && c.batch.waitMs <= 86_400_000)) {
        fail('batch.waitMs: целое 0..86400000');
    }
    if (!(Number.isSafeInteger(c.batch.maxRequests) && c.batch.maxRequests >= 1 && c.batch.maxRequests <= 1000)) {
        fail('batch.maxRequests: целое 1..1000');
    }
    if (!(Number.isSafeInteger(c.batch.minRequests) && c.batch.minRequests >= 1 && c.batch.minRequests <= 1000)) {
        fail('batch.minRequests: целое 1..1000');
    }
    if (typeof c.batch.journalDir !== 'string' || !c.batch.journalDir.trim()) fail('batch.journalDir: непустая строка');

    // --- picture knobs --------------------------------------------------------------
    if (!isRecord(c.image)) fail('image должен быть объектом');
    for (const key of Object.keys(c.image)) {
        if (!(key in defaults.image)) fail(`image.${key}: неизвестное поле`);
    }
    if (!ENUMS.imageFormats.includes(c.image.format)) fail(`image.format: ${ENUMS.imageFormats.join(' | ')}`);
    if (!ENUMS.imageBackgrounds.includes(c.image.background)) fail(`image.background: ${ENUMS.imageBackgrounds.join(' | ')}`);
    if (!ENUMS.complexities.includes(c.image.complexity)) fail(`image.complexity: ${ENUMS.complexities.join(' | ')}`);
    if (c.image.resolution !== null && !ENUMS.resolutions.includes(String(c.image.resolution))) {
        fail(`image.resolution: ${ENUMS.resolutions.join(' | ')}`);
    }
    if (typeof c.image.size !== 'string' || !c.image.size.trim()) fail('image.size: непустая строка');
    if (typeof c.image.outputDir !== 'string' || !c.image.outputDir.trim()) fail('image.outputDir: непустая строка');
    if (c.image.transport !== null && !ENUMS.transports.includes(c.image.transport)) {
        fail(`image.transport: ${ENUMS.transports.join(' | ')}`);
    }
    if (c.image.purpose !== null && !ENUMS.purposes.includes(ENUMS.purposeAliases[c.image.purpose] ?? c.image.purpose)) {
        fail(`image.purpose: ${ENUMS.purposes.join(' | ')}`);
    }
    if (!ENUMS.div16Modes.includes(c.image.div16)) fail(`image.div16: ${ENUMS.div16Modes.join(' | ')}`);
    if (!ENUMS.padToMinModes.includes(c.image.padToMin)) fail(`image.padToMin: ${ENUMS.padToMinModes.join(' | ')}`);
    if (!ENUMS.sizeHintModes.includes(c.image.sizeHint)) fail(`image.sizeHint: ${ENUMS.sizeHintModes.join(' | ')}`);
    if (!ENUMS.alphaModes.includes(c.image.alphaMode)) fail(`image.alphaMode: ${ENUMS.alphaModes.join(' | ')}`);
    if (typeof c.image.paintBackground !== 'boolean') fail('image.paintBackground: true | false');
    if (!(Number.isFinite(c.image.alphaFeather) && c.image.alphaFeather >= 0 && c.image.alphaFeather <= 20)) {
        fail('image.alphaFeather: число 0..20');
    }
    if (!ENUMS.rasterEngines.includes(c.image.rasterEngine)) fail(`image.rasterEngine: ${ENUMS.rasterEngines.join(' | ')}`);
    if (c.image.magickPath !== null && (typeof c.image.magickPath !== 'string' || !c.image.magickPath.trim())) {
        fail('image.magickPath: непустая строка или null');
    }
    if (c.image.maskModel !== null && typeof c.image.maskModel !== 'string') fail('image.maskModel: строка или null');
    if (!(Number.isSafeInteger(c.image.pngMaxBytes) && c.image.pngMaxBytes > 0)) fail('image.pngMaxBytes: целое > 0');
    if (!(Number.isSafeInteger(c.image.vectorMaxColors) && c.image.vectorMaxColors > 0)) fail('image.vectorMaxColors: целое > 0');
    if (typeof c.image.autoVectorize !== 'boolean') fail('image.autoVectorize: true | false');
    if (!isRecord(c.image.parser)) fail('image.parser должен быть объектом');
    for (const key of Object.keys(c.image.parser)) {
        if (!(key in defaults.image.parser)) fail(`image.parser.${key}: неизвестное поле`);
    }
    if (typeof c.image.parser.enabled !== 'boolean') fail('image.parser.enabled: true | false');
    if (c.image.parser.model !== null && typeof c.image.parser.model !== 'string') fail('image.parser.model: строка или null');
    if (typeof c.image.parser.archive !== 'boolean') fail('image.parser.archive: true | false');
    if (c.image.parser.archiveDir !== null && typeof c.image.parser.archiveDir !== 'string') {
        fail('image.parser.archiveDir: строка или null');
    }

    // --- purposes --------------------------------------------------------------------
    if (!isRecord(c.purpose)) fail('purpose должен быть объектом');
    for (const key of Object.keys(c.purpose)) {
        if (!(key in defaults.purpose)) fail(`purpose.${key}: неизвестное поле`);
    }
    validatePurposeModels(c.purpose.models, fail);

    // --- limits ------------------------------------------------------------------------
    if (!isRecord(c.limits)) fail('limits должен быть объектом');
    for (const [key, value] of Object.entries(c.limits)) {
        if (!(key in defaults.limits)) fail(`неизвестный лимит limits.${key}`);
        if (!(Number.isSafeInteger(value) && value > 0)) fail(`limits.${key}: положительное целое`);
    }

    // --- roles --------------------------------------------------------------------------
    if (!isRecord(c.roles)) fail('roles должен быть объектом');
    for (const [name, role] of Object.entries(c.roles)) {
        if (!name.trim()) fail('roles: пустое имя роли');
        if (!isRecord(role)) fail(`roles.${name} должен быть объектом`);
        for (const key of Object.keys(role)) {
            if (!ROLE_FIELDS.includes(key)) fail(`roles.${name}.${key}: неизвестное поле`);
        }
        if (role.model != null && (typeof role.model !== 'string' || !role.model.trim())) fail(`roles.${name}.model: строка или null`);
        if (role.imageModel != null && (typeof role.imageModel !== 'string' || !role.imageModel.trim())) fail(`roles.${name}.imageModel: строка или null`);
        if (role.vectorModel != null && (typeof role.vectorModel !== 'string' || !role.vectorModel.trim())) fail(`roles.${name}.vectorModel: строка или null`);
        if (role.instructions != null && typeof role.instructions !== 'string') fail(`roles.${name}.instructions: строка или null`);
        if (role.maxTurns != null && !(Number.isSafeInteger(role.maxTurns) && role.maxTurns > 0)) fail(`roles.${name}.maxTurns: целое > 0`);
    }
}
