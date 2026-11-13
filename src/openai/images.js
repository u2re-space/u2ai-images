/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose The model-independent part of the picture API: the formats, the payload of a request,
 *          the reading of an answer and the multipart body of an edit.
 * @exports IMAGE_SIZES, VECTOR_RATIOS, normalizeImageFormat, imageFormatField, resolveImageFormat,
 *          supportsTransparentBackground, backgroundValue, acceptsResponseFormat, isVectorModel,
 *          isSvgRequest, normalizeVectorRatio, svgConversionModel, encodeMultipart, imagePayloads,
 *          imageSources, pngHasAlphaChannel, readImageSize, sniffImage, withSizeHint, generationBody,
 *          imageTransport, imageModelFor, imageComplexityValue
 * @ai.tags openai, images
 * @ai.hint legacy-0.2
 */

import { randomBytes } from 'node:crypto';
import {
    DEFAULT_IMAGE_MODEL,
    GPT_IMAGE_25,
    GPT_IMAGE_26,
    RIVERFLOW,
    SVG_CONVERSION_MODEL,
    imageModelProfile,
} from '../model/profiles.js';
import {
    VECTOR_RATIOS,
    imageRequestSize,
    imageSizeFields,
    sameAspectImageSize,
} from '../image/sizing.js';
import { nearestAspect, parseAspectToken } from '../image/aspect.js';

export { VECTOR_RATIOS };

/** True when the model id names a vector (SVG) variant of its family. */
export function isVectorModel(model) {
    return /(?:^|[-/])vector\b/i.test(String(model ?? '').trim());
}

/** Normalize an image format; auto and empty values omit the field. */
export function normalizeImageFormat(format) {
    const value = String(format ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (value === 'jpg') return 'jpeg';
    return value;
}

/**
 * Whether one request is a vector (SVG) call rather than a raster one: the caller asked for `svg`,
 * or the model is a vector variant that answers nothing else.
 *
 * This is the switch that keeps the raster-only corrections away from a vector reply. A document has
 * no pixels to pad or resample, so the 16-pixel grid, the frame-floor padding and the downscale of a
 * grown reply — all of them raster corrections — do not apply; the frame only travels to the model so
 * the artwork keeps the shape it was given.
 * @param {{ model?: string|null, format?: string|null }} request
 * @returns {boolean}
 */
export function isSvgRequest({ model = null, format = null } = {}) {
    return normalizeImageFormat(format) === 'svg' || isVectorModel(model);
}

/**
 * Form fields of a request, with nested objects flattened into the bracket notation the gateway
 * reads back as an object: `svg: { model: 'gpt-6.1-terra' }` travels as `svg[model]`. A form value
 * is a string, so a field that /images/generations sends as JSON has no other way through a
 * multipart body — interpolated as it is, it reaches the host as `[object Object]` and is refused.
 * @param {Record<string, unknown>} fields
 * @returns {Array<[string, string]>}
 */
function formFields(fields) {
    const pairs = [];
    const keep = (value) => value !== undefined && value !== null && value !== '';
    for (const [name, value] of Object.entries(fields)) {
        if (!keep(value)) continue;
        if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, nested] of Object.entries(value)) {
                if (!keep(nested)) continue;
                pairs.push([`${name}[${key}]`, String(nested)]);
            }
            continue;
        }
        pairs.push([name, String(value)]);
    }
    return pairs;
}

/**
 * Encode the fields and files for POST /images/edits as multipart form data.
 * @param {{ fields: Record<string, unknown>, files: Array<{ field?: string, filename: string, mime: string, bytes: Buffer }> }} request
 * @returns {{ body: Buffer, contentType: string }}
 */
export function encodeMultipart({ fields, files }) {
    const boundary = `ai${randomBytes(12).toString('hex')}`;
    const chunks = [];
    for (const [name, value] of formFields(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    for (const file of files) {
        const filename = String(file.filename).replace(/["\r\n]/g, '');
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'image'}"; filename="${filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
        chunks.push(file.bytes);
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Return base64 image payloads from an images API response. */
export function imagePayloads(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => row?.b64_json).filter((value) => typeof value === 'string' && value);
}

/** Return image payloads as inline base64 or URL, in response order. */
export function imageSources(body) {
    const rows = Array.isArray(body?.data) ? body.data : [];
    const out = [];
    for (const row of rows) {
        if (typeof row?.b64_json === 'string' && row.b64_json.trim()) out.push({ kind: 'b64', value: row.b64_json.trim() });
        else if (typeof row?.url === 'string' && row.url.trim()) out.push({ kind: 'url', value: row.url.trim() });
    }
    return out;
}

/** True when a PNG carries an alpha channel or a transparency chunk. */
export function pngHasAlphaChannel(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return false;
    if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return false;
    const colorType = buffer[25];
    if (colorType === 4 || colorType === 6) return true;
    if (colorType !== 3) return false;
    for (let offset = 8; offset + 8 <= buffer.length;) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (type === 'tRNS') return true;
        offset += 12 + length;
    }
    return false;
}

/** Read a raster frame from PNG, JPEG, WebP, or GIF bytes without a raster engine. */
export function readImageSize(buffer) {
    if (!buffer || buffer.length < 10) return null;
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const tag = (at) => b.length >= at + 4 && String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    const u16be = (at) => (b[at] << 8) | b[at + 1];
    const u32be = (at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
    const u32le = (at) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + (b[at + 3] << 24);
    const frame = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24 || tag(12) !== 'IHDR') return null;
        return frame(u32be(16), u32be(20));
    }
    if (tag(0) === 'GIF8') return frame(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
        for (let offset = 12; offset + 8 <= b.length;) {
            const chunk = tag(offset);
            const size = u32le(offset + 4);
            const data = offset + 8;
            if (chunk === 'VP8X' && size >= 10 && data + 10 <= b.length) {
                return frame(1 + b[data + 4] + (b[data + 5] << 8) + (b[data + 6] << 16),
                    1 + b[data + 7] + (b[data + 8] << 8) + (b[data + 9] << 16));
            }
            if (chunk === 'VP8L' && size >= 5 && data + 5 <= b.length && b[data] === 0x2f) {
                const bits = u32le(data + 1);
                return frame(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
            }
            if (chunk === 'VP8 ' && size >= 10 && data + 10 <= b.length
                && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
                return frame(((b[data + 7] & 0x3f) << 8) | b[data + 6], ((b[data + 9] & 0x3f) << 8) | b[data + 8]);
            }
            offset = data + size + (size & 1);
        }
        return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i + 9 < b.length;) {
            if (b[i] !== 0xff) { i += 1; continue; }
            let marker = b[i + 1];
            while (marker === 0xff && i + 2 < b.length) { i += 1; marker = b[i + 1]; }
            if (marker === 0xda || marker === 0xd9) return null;
            if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return frame(u16be(i + 7), u16be(i + 5));
            }
            const length = u16be(i + 2);
            if (length < 2) return null;
            i += 2 + length;
        }
    }
    return null;
}

/** Detect common raster formats and SVG text from magic bytes. */
export function sniffImage(buffer) {
    if (!Buffer.isBuffer(buffer)) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (buffer.length >= 6 && (buffer.toString('latin1', 0, 6) === 'GIF87a' || buffer.toString('latin1', 0, 6) === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
    const head = buffer.subarray(0, 64).toString('utf8', 0, 64).replace(/^\s+/, '');
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return { ext: 'svg', mime: 'image/svg+xml' };
    return { ext: 'png', mime: 'image/png' };
}

/**
 * Resolve an image complexity tier: the caller's value when it names one, otherwise the
 * model's own default from the profile. `auto` and empty strings return null so the field is
 * omitted. Accepted values: `low`, `medium`, `high` — the default for models that support it is
 * `high`. Replaces the former `reasoning` and `quality` fields in the images API.
 * @param {{ model: string, complexity?: string|null }} request
 * @returns {string|null}
 */
export function imageComplexityValue({ model, complexity = null }) {
    const value = String(complexity ?? imageModelProfile(model).complexity ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    return value;
}

/** Select whether image requests use the Images API or Responses image_generation tool. */
export function imageTransport(config) {
    const chosen = config?.image?.transport;
    if (chosen === 'images' || chosen === 'responses') return chosen;
    if (Array.isArray(config?.imagesBackends) && config.imagesBackends.length) return 'images';
    const declared = Array.isArray(config?.backends) ? config.backends : [];
    const primary = String(config?.baseURL ?? '').replace(/\/+$/, '');
    const entry = declared.find((item) => String(item?.baseURL ?? '').replace(/\/+$/, '') === primary);
    const wants = (supports) => supports?.images === true || supports?.imageAPI === true;
    if (wants(entry?.supports)) return 'images';
    try {
        const host = new URL(config?.baseURL ?? '').hostname;
        if (host === 'proxyapi.ru' || host.endsWith('.proxyapi.ru')) return 'images';
    } catch { /* an unusable base URL stays on the Responses tool */ }
    if (primary.startsWith('https://api.openai.com')) return 'responses';
    return 'images';
}

/** Resolve an explicit or default model id for an Images API request. */
export function imageModelFor(config, { hasImage = false } = {}) {
    if (config?.imageModel) return config.imageModel;
    if (imageTransport(config) !== 'images') return null;
    return hasImage ? DEFAULT_IMAGE_MODEL : DEFAULT_IMAGE_MODEL;
}

/** Field name used by a model for its requested image format. */
export function imageFormatField(model) {
    const name = String(model ?? '').trim();
    if (/^(?:openai\/)?gpt-image-/i.test(name) || RIVERFLOW.test(name)) return 'output_format';
    return 'image_format';
}

/** Resolve the requested format, defaulting OpenAI image models to PNG. */
export function resolveImageFormat({ model, format = null }) {
    const normalized = normalizeImageFormat(format);
    if (normalized) return normalized;
    return imageFormatField(model) === 'output_format' ? 'png' : null;
}

/**
 * OpenAI gpt-image models accept `background: transparent`; gpt-image-2 is the exception and
 * rejects the field, so it is treated as an opaque-only model. Recraft and most other vendors
 * render an opaque background. The caller uses this to decide whether native alpha is possible
 * or a local background removal is needed.
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function supportsTransparentBackground(model) {
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(String(model ?? '').trim())?.[1];
    return (Boolean(version) && version !== '2')
        || /riverflow-v2\.6-pro$/i.test(String(model ?? '').trim());
}

/**
 * Value for the `background` field, or null to omit it. Transparent output needs a model that
 * accepts the field and a format that can store alpha: the API rejects transparent JPEG, so that
 * combination falls back to a local background removal (reported by the caller).
 * @param {{ model: string, format?: string|null, background?: string|null }} request
 * @returns {'transparent'|'opaque'|null}
 */
export function backgroundValue({ model, format = null, background = null }) {
    if (background !== 'transparent' && background !== 'opaque') return null;
    if (!supportsTransparentBackground(model)) return null;
    if (background === 'transparent' && normalizeImageFormat(format) === 'jpeg') return null;
    return background;
}

/**
 * Whether a model accepts the optional response_format parameter. `gpt-image-1` rejects it and always
 * answers in base64, and vendor models that take `image_format` do not document it at all, so a
 * strict gateway answers 400 for the whole request. Only the newer OpenAI image models are asked
 * for it.
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function acceptsResponseFormat(model) {
    const name = String(model ?? '').trim();
    if (!/^(?:openai\/)?gpt-image-/i.test(name)) return false;
    const version = /^(?:openai\/)?gpt-image-(\d+(?:\.\d+)?)/i.exec(name)?.[1];
    return Boolean(version) && version !== '1';
}

function isSizeFinicky(caps) {
    return caps.resolutionTiers || caps.routeEditsThroughGeneration || caps.omitSizeOnReject;
}

/**
 * Add a size instruction only for image families whose gateway is known to discard size fields.
 * @param {string} prompt
 * @param {object} [fields]
 * @param {string|null} [model]
 * @param {'auto'|'always'|'never'} [mode]
 * @returns {string}
 */
export function withSizeHint(prompt, fields = {}, model = null, mode = 'auto') {
    const text = String(prompt ?? '');
    const parts = [];
    if (fields.size) parts.push(`size ${fields.size}`);
    if (fields.resolution) parts.push(`resolution ${fields.resolution}`);
    if (fields.aspect_ratio && fields.aspect_ratio !== 'auto') parts.push(`aspect ratio ${fields.aspect_ratio}`);
    if (!parts.length || mode === 'never' || /Requested output:/i.test(text)) return text;
    if (mode === 'auto' && !isSizeFinicky(imageModelProfile(model))) return text;
    return `${text}\n\nRequested output: ${parts.join(', ')}. Keep this exact frame and aspect ratio.`;
}

/**
 * The `svg` field the host demands next to `output_format: svg` for the gpt-image family:
 * the raster model paints the picture and this model writes the document. Without it the host
 * refuses the whole call (`output_format "svg" requires svg.model`). A family that answers
 * `image_format: svg` — recraft — draws the document itself and knows no such field, so it stays out.
 * @param {string|null|undefined} model
 * @returns {{model: string}|null}
 */
export function svgConversionModel(model) {
    return imageFormatField(model) === 'output_format' ? { model: SVG_CONVERSION_MODEL } : null;
}

/**
 * Map a requested vector aspect ratio to the nearest supported ratio. The request may name the
 * shape any way a caller does it: `4:3`, `1024x768`, `1.33`, `landscape`, `a4`. The vector gateway
 * only answers to its own list, so the shape is rounded to the closest ratio there.
 * @param {string|null|undefined} ratio
 * @returns {string|null}
 */
export function normalizeVectorRatio(ratio) {
    const value = String(ratio ?? '').trim().toLowerCase();
    if (!value || value === 'auto') return null;
    if (VECTOR_RATIOS.includes(value)) return value;
    return nearestAspect(value, VECTOR_RATIOS);
}

/**
 * Build the JSON body accepted by /images/generations for the selected model family.
 * @param {{ model: string, prompt: string, size?: string|null, complexity?: string|null,
 *   n?: number|null, format?: string|null, background?: string|null, references?: string[]|null,
 *   resolution?: string|null, sizeHint?: 'auto'|'always'|'never' }} request
 * @returns {object}
 */
export function generationBody({ model, prompt, size = null, complexity = null, n = null, format = null,
    background = null, references = null, resolution = null, sizeHint = 'auto' }) {
    const body = { model, prompt };
    if (Array.isArray(references) && references.length) {
        body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
    }
    if (isSvgRequest({ model, format })) {
        // A free-frame family draws the vector on the frame it is handed, so a pixel frame stays a
        // pixel frame. A ratio-only vector model (recraft) knows no such field and is tuned by
        // `aspect_ratio` alone; collapsing a frame into a ratio there would drop information it has
        // no field for, and inventing a `size` it rejects costs the whole request.
        const asked = String(size ?? '').trim();
        const frame = /^\d+\s*x\s*\d+$/.test(asked) && imageModelProfile(model).customSizes
            ? asked.replace(/\s+/g, '')
            : null;
        // The frame is still the model's own frame: a vector call is validated like any other, so
        // a source that names 810x810 is asked as 816x816. The document answers by its own geometry.
        if (frame) body.size = sameAspectImageSize(frame, model) || frame;
        else {
            const aspect = normalizeVectorRatio(size);
            if (aspect) body.aspect_ratio = aspect;
        }
        if (Number.isInteger(n) && n > 1) body.n = n;
        body[imageFormatField(model)] = 'svg';
        const svgModel = svgConversionModel(model);
        if (svgModel) body.svg = svgModel;
        body.prompt = withSizeHint(prompt, body, model, sizeHint);
        return body;
    }
    const fields = imageSizeFields(size, model, resolution);
    if (fields.size) body.size = fields.size;
    else if (!fields.resolution && !fields.aspect_ratio) {
        const frame = imageRequestSize(size, model, resolution);
        if (frame) body.size = frame;
    }
    if (fields.resolution) body.resolution = fields.resolution;
    if (fields.aspect_ratio) body.aspect_ratio = fields.aspect_ratio;
    body.prompt = withSizeHint(prompt, body, model, sizeHint);
    const profile = imageModelProfile(model);
    if (!profile.keepProSuffix) {
        const sizePair = body.size?.split('x').map((part) => parseInt(part || '0', 10));
        if (sizePair?.[0] <= 1024 && sizePair?.[1] <= 1024) body.model = body.model?.replace(/\-pro$/, '') || body.model;
    }
    const cx = imageComplexityValue({ model, complexity });
    if (cx) body.complexity = cx;
    if (Number.isInteger(n) && n > 1) body.n = n;
    const fmt = resolveImageFormat({ model, format });
    if (fmt) body[imageFormatField(model)] = fmt;
    const backgroundField = backgroundValue({ model, format: fmt, background });
    if (backgroundField) body.background = backgroundField;
    return body;
}

export { parseAspectToken };
