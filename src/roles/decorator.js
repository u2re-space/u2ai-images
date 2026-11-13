/**
 * @file src/roles/decorator.js
 * @module roles/decorator
 * @purpose The decorator: the complex decorative layer of a picture — ornaments, ribbons,
 *          dividers, frames, patterns, badges — as a CSS rule or as a standalone SVG.
 * @depends node:path
 * @usedBy commands/decorate
 * @exports DECORATOR_INSTRUCTIONS, DECORATION_KINDS, chooseDecorationKind, decorationName,
 *          parseDecoration, buildDecoration
 * @ai.tags roles, design, svg, css
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * The port of the decorator of the monolith. The monolith gave the decorator a page to work on;
 * here the decorator gets a description of one element and an optional reference crop, and
 * answers with the file and the exact snippet that puts the element on a page.
 */

import path from 'node:path';

/**
 * The instructions of the decorator.
 *
 * The choice of the technique is the heart of the role: CSS when the browser can draw the form
 * natively, SVG when the contour is too complex for hand-written CSS or when the artwork is
 * self-contained. The file is a text file either way.
 */
export const DECORATOR_INSTRUCTIONS = `You are the decorator. You build one decorative element — an ornament, a flourish, a vine, a ribbon, a divider, a frame, a pattern, a badge, a decorative heading — for a page or a picture.

Choose the cheapest technique that keeps the requested form:
- css — when the form is geometry, a gradient, a mask, or motion that the browser draws natively: clip-path, mask-image with mask-composite, conic-gradient and radial-gradient, @property, transform, filter, mix-blend-mode, offset-path with offset-distance and offset-rotate, scroll-driven animation-timeline, view-transition-name. Use CSS when the element must scale, recolor through currentColor or a custom property, or animate. Guard a newer feature with @supports and keep a simpler shape as the fallback. Respect prefers-reduced-motion for every animation and keep purely decorative markup aria-hidden.
- svg — when the contour is too complex for hand-written CSS, when the artwork is self-contained, or when the task asks for a picture file. A standalone document with a viewBox, no external references, currentColor where the recoloring matters, role="img" with a title when the element is meaningful, or aria-hidden when it is purely decorative.

Answer with JSON only:
{ "kind": "css" | "svg", "name": "kebab-case-name", "content": "the whole file", "snippet": "the exact HTML to paste", "notes": "what was chosen and why" }
The content is the whole file, nothing else: the CSS rule of a stylesheet, or the SVG document.
Never claim a file you did not write, and say plainly in the notes when an element could not be built.`;

/** The techniques of the decorator. */
export const DECORATION_KINDS = Object.freeze(['css', 'svg']);

/**
 * The words that ask for a CSS rule.
 *
 * A form the browser draws natively is cheaper than a picture: it scales, it recolors, it
 * animates, and it weighs nothing.
 */
const CSS_WORDS = [
    'gradient', 'mask', 'clip', 'blur', 'glow', 'shadow', 'border', 'divider', 'separator',
    'frame', 'pattern', 'grid', 'stripe', 'ray', 'beam', 'halo', 'motion', 'animation',
    'pulse', 'wave', 'shine', 'sheen', 'frosted', 'glass', 'neon', 'ribbon banner',
];

/** The words that ask for a picture. */
const SVG_WORDS = [
    'logo', 'emblem', 'icon', 'illustration', 'ornament', 'flourish', 'vine', 'heraldic',
    'mascot', 'coat of arms', 'crest', 'medallion', 'seal', 'filigree', 'monogram',
    'lettering', 'calligraphy', 'drawing', 'sketch', 'portrait',
];

/**
 * Choose the technique of a decoration.
 *
 * The words of the description decide: a form the browser draws natively is CSS, a contour that
 * has to be drawn is an SVG. When the description says nothing, CSS is the answer — it is the
 * cheaper of the two.
 * @param {string} description
 * @param {string|null} [asked] The kind the caller insists on.
 * @returns {'css'|'svg'}
 * @exports
 * @ai.hint pure
 */
export function chooseDecorationKind(description, asked = null) {
    const wanted = String(asked ?? '').trim().toLowerCase();
    if (DECORATION_KINDS.includes(wanted)) return wanted;
    const text = String(description ?? '').toLowerCase();
    const svg = SVG_WORDS.some((word) => text.includes(word));
    const css = CSS_WORDS.some((word) => text.includes(word));
    if (svg && !css) return 'svg';
    return 'css';
}

/**
 * The name of the file of a decoration.
 * @param {string} description
 * @param {string|null} [asked] The name the model gave.
 * @returns {string} a kebab-case name
 * @exports
 * @ai.hint pure
 */
export function decorationName(description, asked = null) {
    const given = String(asked ?? '').trim().toLowerCase();
    const source = given || String(description ?? '').toLowerCase();
    const slug = source
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .split('-')
        .filter(Boolean)
        .slice(0, 4)
        .join('-');
    return slug || 'decoration';
}

/**
 * Read the answer of the decorator.
 *
 * The model is asked for JSON, but a model that wraps its answer in a fence, or that forgets the
 * braces, must not break the run: the raw text is used then, and for an SVG the document is cut
 * out of it.
 * @param {string} text
 * @param {'css'|'svg'} kind
 * @returns {{ kind: string, name: string|null, content: string, snippet: string, notes: string }}
 * @exports
 * @ai.hint pure
 */
export function parseDecoration(text, kind) {
    const raw = String(text ?? '');
    const fenced = /```(?:json|svg|css)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1].trim() : raw.trim();
    let parsed = null;
    try {
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start >= 0 && end > start) parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
        parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
        return {
            kind: DECORATION_KINDS.includes(parsed.kind) ? parsed.kind : kind,
            name: typeof parsed.name === 'string' ? parsed.name : null,
            content: typeof parsed.content === 'string' ? parsed.content : '',
            snippet: typeof parsed.snippet === 'string' ? parsed.snippet : '',
            notes: typeof parsed.notes === 'string' ? parsed.notes : '',
        };
    }
    if (kind === 'svg') {
        const document = /<svg[\s\S]*<\/svg>/i.exec(body);
        return {
            kind: 'svg',
            name: null,
            content: document ? document[0] : body,
            snippet: '',
            notes: 'The answer was not JSON: the SVG document was taken out of it.',
        };
    }
    return {
        kind: 'css',
        name: null,
        content: body,
        snippet: '',
        notes: 'The answer was not JSON: the text was taken as the stylesheet.',
    };
}

/**
 * Ask the model for a decoration.
 * @param {{ client: object, config?: object|null, description: string, kind?: string|null,
 *   reference?: { mime: string, dataUrl: string }|null, model?: string|null }} options
 * @returns {Promise<{ kind: string, name: string, content: string, snippet: string, notes: string,
 *   model: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function buildDecoration({
    client, config = null, description, kind = null, reference = null, model = null,
}) {
    const chosen = chooseDecorationKind(description, kind);
    const usedModel = model ?? config?.roles?.decorator?.model ?? config?.model ?? null;
    const input = reference
        ? [
            { type: 'input_text', text: `Build the decoration: ${description}` },
            { type: 'input_image', image_url: reference.dataUrl },
        ]
        : `Build the decoration: ${description}`;
    const answer = await client.responses.create({
        model: usedModel,
        instructions: DECORATOR_INSTRUCTIONS,
        input,
    });
    const text = client.responses.text(answer);
    const parsed = parseDecoration(text, chosen);
    return {
        ...parsed,
        kind: parsed.kind === 'svg' ? 'svg' : 'css',
        name: decorationName(description, parsed.name),
        model: usedModel,
    };
}

/**
 * The path of the file of a decoration, relative to the working directory.
 * @param {string} kind
 * @param {string} name
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function decorationPath(kind, name) {
    return kind === 'svg'
        ? path.posix.join('assets', 'decor', `${name}.svg`)
        : path.posix.join('styles', 'decor', `${name}.css`);
}
