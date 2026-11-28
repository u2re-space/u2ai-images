/**
 * @file src/image/svg-document.js
 * @module image/svg-document
 * @purpose The SVG document as text: its parts, its problems and the edits that change it.
 *
 *   The vectorizer draws a document with a picture model. The result is a document, not code
 *   anybody wrote: it may carry a hundred decimals in a path, a `<script>` nobody asked for, an
 *   `<image>` that points at a file that is not there, and no title for a meaningful picture.
 *
 *   This module is the code side of that document. It reads it, names what is wrong with it,
 *   and applies the changes that a text model asks for — as *edits*, not as a new document.
 *
 *   The edits are targeted on purpose: a whole rewritten document may be cut by the cap of
 *   the output of the model, and a cut document is a broken picture. An edit names a fragment
 *   of the source and its replacement, and the code checks that the fragment was found — an
 *   edit that does not apply is reported, not silently dropped.
 *
 * @depends none
 * @usedBy roles/svg-editor, stages/svg-edit, stages/svg-polish
 * @exports SVG_PROBLEMS, SVG_EDIT_KINDS, parseSvgDocument, findSvgProblems, applySvgEdits,
 *          tidySvgDocument, svgDocumentSummary
 * @ai.tags svg, vector, text
 * @ai.hint pure
 */

/**
 * The kinds of an edit.
 *
 * `replace` — a fragment of the source and its replacement. `insert` — a fragment and the
 * text that goes after it. `remove` — a fragment that goes away. `setAttribute` — an
 * attribute of a tag, named by the tag and the attribute.
 */
export const SVG_EDIT_KINDS = Object.freeze(['replace', 'insert', 'remove', 'setAttribute']);

/**
 * The problems the local check of a document names.
 *
 * The list is the vocabulary of the check: every problem has a word, and the words are what
 * the report and the text model speak about.
 */
export const SVG_PROBLEMS = Object.freeze([
    'no-root',
    'no-namespace',
    'no-viewbox',
    'no-size',
    'unbalanced',
    'script',
    'external-reference',
    'embedded-raster',
    'font',
    'no-title',
    'no-role',
    'empty',
]);

/**
 * The elements that carry the drawing.
 */
const DRAWING_TAGS = Object.freeze([
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'g', 'defs', 'use', 'symbol', 'title', 'desc', 'text', 'tspan', 'clipPath', 'mask',
]);

/**
 * The tags that are not self-closing in the SVG of the house.
 */
const VOID_TAGS = Object.freeze(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'stop']);

/**
 * The text of a document without its comments and its CDATA sections.
 *
 * The comment is prose, not markup: an element name inside it is not an element of the
 * drawing.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function withoutComments(text) {
    return String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
}

/**
 * The elements of a markup, in the order they appear.
 * @param {string} text
 * @returns {Array<{ name: string, closing: boolean, selfClosing: boolean, start: number, end: number }>}
 * @ai.hint pure
 */
function elementsOf(text) {
    const out = [];
    const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;
    let match = re.exec(text);
    while (match) {
        const closing = match[1] === '/';
        const selfClosing = match[4] === '/';
        const name = match[2];
        const start = match.index;
        const end = match.index + match[0].length;
        if (!closing && name.toLowerCase() === '!doctype') {
            match = re.exec(text);
            continue;
        }
        out.push({ name, closing, selfClosing, start, end });
        match = re.exec(text);
    }
    return out;
}

/**
 * The attributes of the root tag of a document.
 * @param {string} text
 * @returns {Record<string, string>}
 * @ai.hint pure
 */
function rootAttributes(text) {
    const source = String(text ?? '');
    const rootMatch = source.match(/<svg\b([^>]*)>/i);
    const attributes = {};
    if (!rootMatch) return attributes;
    const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
    let match = re.exec(rootMatch[1]);
    while (match) {
        const name = match[1] ?? match[3];
        const value = match[2] ?? match[4] ?? '';
        attributes[name] = value;
        match = re.exec(rootMatch[1]);
    }
    return attributes;
}

/**
 * Read the parts of an SVG document that matter.
 *
 * The root tag, its attributes, the elements of the drawing, the frame of the picture and
 * the problems the local check found. A document that cannot be parsed is still returned:
 * its problems are the answer.
 * @param {string} text the document
 * @returns {{ ok: boolean, root: string|null, attributes: object, viewBox: string|null,
 *   width: string|null, height: string|null, elements: object[], paths: number,
 *   bytes: number, problems: string[], notes: string[] }}
 * @exports
 * @ai.hint pure
 */
export function parseSvgDocument(text) {
    const source = String(text ?? '');
    const notes = [];
    const attributes = rootAttributes(source);
    const elements = elementsOf(withoutComments(source));
    const problems = [];
    const bytes = Buffer.byteLength(source, 'utf8');

    if (!source.trim()) {
        return {
            ok: false,
            root: null,
            attributes: {},
            viewBox: null,
            width: null,
            height: null,
            elements: [],
            paths: 0,
            bytes,
            problems: ['empty'],
            notes: ['The document is empty.'],
        };
    }

    const rootMatch = source.match(/<svg\b/i);
    if (!rootMatch) problems.push('no-root');
    if (!attributes.xmlns) problems.push('no-namespace');

    const viewBox = attributes.viewBox ?? null;
    const width = attributes.width ?? null;
    const height = attributes.height ?? null;
    if (!viewBox && !(width && height)) problems.push('no-size');

    // The balance of the tags: a document that closes what it did not open does not open.
    const stack = [];
    let balanced = true;
    for (const element of elements) {
        const name = element.name.toLowerCase();
        if (element.closing) {
            const open = stack.pop();
            if (open !== name) {
                balanced = false;
                break;
            }
            continue;
        }
        if (element.selfClosing || VOID_TAGS.includes(name)) continue;
        stack.push(name);
    }
    if (balanced && stack.length) balanced = false;
    if (!balanced) problems.push('unbalanced');

    // The dangerous parts: a script, a reference to the outside, a raster inside.
    if (/<script[\s>]/i.test(source)) problems.push('script');
    if (/(?:xlink:href|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(source)) {
        problems.push('external-reference');
    }
    if (/<image[\s>]/i.test(source)) problems.push('embedded-raster');
    if (/<text[\s>]/i.test(source) && /font-family/i.test(source)) problems.push('font');

    // The accessibility of a meaningful picture: a title and a role. A picture that draws
    // nothing is not meaningful, and it needs no title.
    const meaningful = /<(?:path|rect|circle|ellipse|polygon|polyline)\b/i.test(source);
    if (meaningful && !/<title[\s>]/i.test(source)) problems.push('no-title');
    if (meaningful && !/\brole\s*=\s*["']/i.test(source)) problems.push('no-role');

    if (problems.length) {
        notes.push(`${problems.length} problem(s): ${problems.join(', ')}.`);
    }

    return {
        ok: !problems.includes('no-root') && !problems.includes('unbalanced') && !problems.includes('empty'),
        root: rootMatch ? '<svg>' : null,
        attributes,
        viewBox,
        width,
        height,
        elements,
        paths: (source.match(/<path\b/gi) ?? []).length,
        bytes,
        problems: [...new Set(problems)],
        notes,
    };
}

/**
 * Name the problems of a document.
 *
 * The same list as `parseSvgDocument`, but the function stands alone: the caller wants the
 * problems and nothing else.
 * @param {string} text the document
 * @returns {string[]} the words of the problems
 * @exports
 * @ai.hint pure
 */
export function findSvgProblems(text) {
    return parseSvgDocument(text).problems;
}

/**
 * Apply the edits of a text model to a document.
 *
 * Every edit names a fragment of the source. The code finds that fragment and replaces it.
 * An edit whose fragment is not there is reported and does not change the document — a model
 * that misremembers the source must not be able to corrupt the picture.
 *
 * The edits are applied in the order they came, and the search starts after the place of the
 * previous edit: two edits of the same fragment are two different places.
 *
 * @param {string} text the document
 * @param {Array<{ kind?: string, find?: string, replace?: string, tag?: string,
 *   attribute?: string, value?: string }>} edits the edits of the model
 * @returns {{ ok: boolean, text: string, applied: number, failed: Array<{ index: number,
 *   kind: string, reason: string }>, notes: string[] }}
 * @exports
 * @ai.hint pure
 */
export function applySvgEdits(text, edits) {
    let out = String(text ?? '');
    const applied = [];
    const failed = [];
    const notes = [];
    const list = Array.isArray(edits) ? edits : [];

    list.forEach((edit, index) => {
        const kind = String(edit?.kind ?? 'replace').trim();
        if (!SVG_EDIT_KINDS.includes(kind)) {
            failed.push({ index, kind, reason: `unknown kind of an edit: ${kind}` });
            return;
        }
        if (kind === 'setAttribute') {
            const result = setAttribute(out, edit);
            if (result.ok) {
                out = result.text;
                applied.push(index);
            } else {
                failed.push({ index, kind, reason: result.reason });
            }
            return;
        }
        const find = String(edit?.find ?? '');
        if (!find.trim()) {
            failed.push({ index, kind, reason: 'the edit names no fragment' });
            return;
        }
        const at = out.indexOf(find);
        if (at < 0) {
            failed.push({ index, kind, reason: 'the fragment was not found in the document' });
            return;
        }
        if (kind === 'replace') {
            out = out.slice(0, at) + String(edit?.replace ?? '') + out.slice(at + find.length);
        } else if (kind === 'remove') {
            out = out.slice(0, at) + out.slice(at + find.length);
        } else {
            // `insert`: the text goes after the fragment. The fragment is a whole tag, and
            // the text goes after it: inside the `<svg>` tag, a text would break it.
            const after = at + find.length;
            const trimmed = find.trimEnd();
            if (!trimmed.endsWith('>')) {
                failed.push({ index, kind, reason: 'the fragment of an insert has to be a whole tag' });
                return;
            }
            out = out.slice(0, after) + String(edit?.replace ?? '') + out.slice(after);
        }
        applied.push(index);
    });

    if (failed.length) {
        notes.push(`${failed.length} edit(s) did not apply.`);
    }
    return {
        ok: failed.length === 0,
        text: out,
        applied: applied.length,
        failed,
        notes,
    };
}

/**
 * Set an attribute of a tag of a document.
 *
 * The tag is named by its own name and, when it is needed, by the fragment that leads to
 * it: the first `<path` of the document, or the one that carries the given id.
 * @param {string} text the document
 * @param {{ tag?: string, attribute?: string, value?: string }} edit the edit
 * @returns {{ ok: boolean, text: string, reason: string }}
 * @ai.hint pure
 */
function setAttribute(text, edit) {
    const tag = String(edit?.tag ?? '').trim();
    const attribute = String(edit?.attribute ?? '').trim();
    if (!tag) return { ok: false, text, reason: 'the edit names no tag' };
    if (!attribute) return { ok: false, text, reason: 'the edit names no attribute' };
    const re = new RegExp(`<(${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b([^>]*?)(/?)>`, 'i');
    const match = re.exec(text);
    if (!match) return { ok: false, text, reason: `the tag <${tag}> was not found` };
    const body = match[2] ?? '';
    const value = String(edit?.value ?? '');
    const has = new RegExp(`\\s${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i').test(body);
    let next;
    if (has) {
        next = body.replace(
            new RegExp(`(\\s${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)(["'])([^"']*)\\2`, 'i'),
            `$1$2${value.replace(/\$/g, '$$$$')}$2`,
        );
    } else {
        next = `${body} ${attribute}="${value.replace(/"/g, '&quot;')}"`;
    }
    const replaced = text.slice(0, match.index) + `<${match[1]}${next}${match[3]}>` + text.slice(match.index + match[0].length);
    return { ok: true, text: replaced, reason: '' };
}

/**
 * Bring a document to a clean state, without changing the drawing.
 *
 * The tidy is local and safe, and it follows the law of the house: no declaration of the
 * XML, no comments, no metadata, no empty groups, no whitespace between the tags. The
 * drawing itself is never touched: a path that is one point shorter is a different picture.
 *
 * @param {string} text the document
 * @returns {{ ok: boolean, text: string, changed: boolean, notes: string[] }}
 * @exports
 * @ai.hint pure
 */
export function tidySvgDocument(text) {
    const source = String(text ?? '');
    const notes = [];
    let out = source;

    // The declaration of the XML and the metadata: neither is needed for a standalone
    // document, and the metadata breaks the copy of the markup into a page.
    out = out.replace(/<\?xml[\s\S]*?\?>/gi, '');
    out = out.replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/gi, '');
    out = out.replace(/<metadata\b[^>]*\/>/gi, '');

    // The comments: the law of the house removes them all, and a comment is never part of
    // the drawing.
    out = out.replace(/<!--[\s\S]*?-->/g, '');

    // The empty groups.
    out = out.replace(/<g\b([^>]*)\>\s*<\/g>/gi, '<g$1/>');

    // The whitespace between the tags, and the newlines that follow nothing.
    out = out.replace(/>\s+</g, '><');
    out = out.replace(/\n{2,}/g, '\n');
    out = out.replace(/^\s+|\s+$/g, '');

    // The space before the slash of a self-closing tag.
    out = out.replace(/\s+\/>/g, '/>');

    if (out !== source) {
        notes.push('The document was tidied.');
    }
    return { ok: true, text: out, changed: out !== source, notes };
}

/**
 * A short description of a document, for the report and for the prompt of the model.
 *
 * The model needs to know what it is looking at: the frame, the number of the paths, the
 * palette, and the problems. The description is short enough to go into a prompt.
 *
 * @param {string} text the document
 * @returns {{ frame: string, paths: number, bytes: number, colors: string[], problems: string[] }}
 * @exports
 * @ai.hint pure
 */
export function svgDocumentSummary(text) {
    const parsed = parseSvgDocument(text);
    const source = String(text ?? '');
    const colors = [...new Set(
        (source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])
            .map((item) => item.toLowerCase())
            .slice(0, 32),
    )];
    const frame = parsed.viewBox
        ? `viewBox ${parsed.viewBox}`
        : (parsed.width && parsed.height ? `${parsed.width}x${parsed.height}` : 'unknown');
    return {
        frame,
        paths: parsed.paths,
        bytes: parsed.bytes,
        colors,
        problems: parsed.problems,
    };
}
