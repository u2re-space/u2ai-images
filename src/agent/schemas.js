/**
 * @file src/agent/schemas.js
 * @module agent/schemas
 * @purpose The strict shapes of the answers of the roles: the planner, the processor, the
 *          corrector and the vectorizer.
 * @depends none
 * @usedBy roles/planner, roles/processor, roles/corrector, roles/vectorizer, agent/pipeline
 * @exports PLANNER_SCHEMA, PROCESSOR_SCHEMA, CORRECTOR_SCHEMA, VECTORIZER_SCHEMA,
 *          ROLE_SCHEMAS, schemaEnvelope, validateAgainst
 * @ai.tags schema, roles
 * @ai.hint keep
 *
 * The schemas are the same shape the Responses API takes in `text.format`: a JSON schema with
 * every property required and no extras. A role that answers with something else is answered
 * wrongly — and the check below says so before the answer is used.
 */

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };

/**
 * A strict object schema: every property is required and nothing else is allowed.
 * @param {object} properties
 * @returns {object}
 * @ai.hint pure
 */
function object(properties) {
    return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

/**
 * A strict object schema that may be `null`: the field is there, but it may carry nothing.
 * @param {object} properties
 * @param {string} [description]
 * @returns {object}
 * @ai.hint pure
 */
function nullableObject(properties, description = null) {
    return {
        ...object(properties),
        type: ['object', 'null'],
        ...(description ? { description } : {}),
    };
}

/**
 * The strategy of a run: what the picture is for and how it has to be made.
 *
 * The plan is the contract between the planner and the stages: every stage reads the plan and
 * nothing else, so the run is the same whatever order the roles answered in.
 */
export const PLANNER_SCHEMA = object({
    purpose: {
        type: 'string',
        enum: ['decompose', 'generate', 'edit', 'remove_background', 'upscale', 'unrotate'],
        description: 'What the picture is for.',
    },
    size: { ...nullableString, description: 'The frame of the picture, WIDTHxHEIGHT, or null to let the model choose.' },
    resolution: { ...nullableString, description: 'The resolution tier, or null.' },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'The format of the file.' },
    background: {
        type: 'string',
        enum: ['auto', 'opaque', 'transparent'],
        description: 'The background of the picture; transparent asks for a real alpha channel.',
    },
    alphaMode: {
        type: 'string',
        enum: ['auto', 'mask', 'contour', 'flat', 'key', 'off'],
        description: 'How the alpha channel is built.',
    },
    crop: nullableObject({
        x: { ...nullableInteger, description: 'The left edge of the box, or null to trim the padding off.' },
        y: { ...nullableInteger, description: 'The top edge of the box.' },
        width: { ...nullableInteger, description: 'The width of the box.' },
        height: { ...nullableInteger, description: 'The height of the box.' },
        trim: { ...nullableBoolean, description: 'Cut the uniform or transparent padding off instead.' },
    }, 'What to do with the source before the model sees it; null when nothing is needed.'),
    pad: nullableObject({
        width: { ...nullableInteger, description: 'The width of the canvas.' },
        height: { ...nullableInteger, description: 'The height of the canvas.' },
        color: { ...nullableString, description: 'The color of the padding, or null for transparency.' },
    }, 'The canvas to extend the source to, without scaling it; null when nothing is needed.'),
    vectorize: { ...nullableBoolean, description: 'Whether the result has to become an SVG document.' },
    rationale: { ...string, description: 'Why the strategy is this one.' },
});

/**
 * The answer of the processor: what was made and how it has to be used.
 */
export const PROCESSOR_SCHEMA = object({
    summary: { ...string, description: 'What was prepared, or what could not be prepared.' },
    assets: {
        type: 'array',
        description: 'Every file that was created or reused.',
        items: object({
            path: { ...string, description: 'The path of the file, relative to the working directory.' },
            format: { ...string, description: 'The format of the file: png, jpeg, webp or svg.' },
            use: { ...string, description: 'How the implementation has to use the asset.' },
        }),
    },
    typography: {
        type: 'array',
        description: 'The typefaces the task asked for; empty when it asked for none.',
        items: object({
            family: { ...string, description: 'The name of the family.' },
            role: { ...string, description: 'The role of the family: heading or body.' },
            cssFamily: { ...string, description: 'The CSS font-family value.' },
            cssUrl: { ...nullableString, description: 'The URL of the stylesheet, or null for a local family.' },
            weights: { ...strings, description: 'The useful weights.' },
            rationale: { ...string, description: 'Why this family.' },
            source: { ...nullableString, description: 'Where the family comes from.' },
            localPath: { ...nullableString, description: 'The local file of the family, or null.' },
        }),
    },
    notes: { ...strings, description: 'The limits of the run: what was unavailable, what failed.' },
});

/**
 * The verdict of the corrector: whether the result is what was asked for.
 */
export const CORRECTOR_SCHEMA = object({
    ok: { type: 'boolean', description: 'Whether the result may be used as it is.' },
    issues: {
        type: 'array',
        description: 'What is wrong with the result.',
        items: object({
            kind: {
                type: 'string',
                enum: ['frame', 'alpha', 'artifact', 'content', 'format'],
                description: 'What kind of trouble it is.',
            },
            detail: { ...string, description: 'What exactly is wrong.' },
        }),
    },
    retry: {
        ...object({
            purpose: { ...nullableString, description: 'Another purpose, or null.' },
            size: { ...nullableString, description: 'Another frame, or null.' },
            alphaMode: { ...nullableString, description: 'Another mode of the alpha channel, or null.' },
            model: { ...nullableString, description: 'Another model, or null.' },
        }),
        description: 'What to change on the next attempt; null when nothing has to be repeated.',
    },
    notes: { ...strings, description: 'The observations of the corrector.' },
});

/**
 * The answer of the vectorizer: the document that was written.
 */
export const VECTORIZER_SCHEMA = object({
    path: { ...string, description: 'The path of the SVG document, relative to the working directory.' },
    colors: { ...nullableInteger, description: 'The number of the colors of the source.' },
    suitable: { type: 'boolean', description: 'Whether the source was worth tracing.' },
    notes: { ...strings, description: 'What the tracing kept and what it lost.' },
});

/** Every schema of a role, by the name of the role. */
export const ROLE_SCHEMAS = Object.freeze({
    planner: PLANNER_SCHEMA,
    processor: PROCESSOR_SCHEMA,
    corrector: CORRECTOR_SCHEMA,
    vectorizer: VECTORIZER_SCHEMA,
});

/**
 * The envelope of a schema for the Responses API.
 * @param {string} name
 * @param {object} schema
 * @returns {{ type: 'json_schema', name: string, strict: true, schema: object }}
 * @exports
 * @ai.hint pure
 */
export function schemaEnvelope(name, schema) {
    return { type: 'json_schema', name, strict: true, schema };
}

/**
 * Check a value against a schema.
 *
 * The check is local and strict: the types, the required properties, the enums and the extras.
 * A model that answers with a field nobody asked for is a model that misunderstood the task, and
 * the check has to say so before the answer is used.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path] The place of the value in the answer, for the message.
 * @returns {{ ok: boolean, errors: string[] }}
 * @exports
 * @ai.hint pure
 */
export function validateAgainst(schema, value, path = '') {
    const errors = [];
    /**
     * The type of a value as the schema names it.
     * @param {unknown} item
     * @returns {string}
     * @ai.hint pure
     */
    const typeOf = (item) => {
        if (item === null) return 'null';
        if (Array.isArray(item)) return 'array';
        if (Number.isInteger(item)) return 'integer';
        return typeof item;
    };
    /**
     * Check one value.
     * @param {object} node
     * @param {unknown} item
     * @param {string} where
     * @returns {void}
     * @ai.hint pure
     */
    const check = (node, item, where) => {
        if (!node || typeof node !== 'object') return;
        // The type of the node: a list of types means the field may be null, and the check of
        // the object below still applies when it is not.
        const types = Array.isArray(node.type) ? node.type : (node.type ? [node.type] : []);
        if (types.length) {
            const got = typeOf(item);
            if (!types.includes(got)) {
                errors.push(`${where || 'the answer'}: expected ${types.join(' or ')}, got ${got}`);
                return;
            }
        }
        if (node.enum && !node.enum.includes(item)) {
            errors.push(`${where || 'the answer'}: "${item}" is not one of ${node.enum.join(', ')}`);
            return;
        }
        const isObject = types.includes('object') && item !== null && typeof item === 'object' && !Array.isArray(item);
        const isArray = types.includes('array') && Array.isArray(item);
        if (isObject) {
            for (const key of node.required ?? []) {
                if (!(key in item)) errors.push(`${where || 'the answer'}: the field "${key}" is missing`);
            }
            if (node.additionalProperties === false) {
                for (const key of Object.keys(item)) {
                    if (!node.properties || !(key in node.properties)) {
                        errors.push(`${where || 'the answer'}: the field "${key}" was not asked for`);
                    }
                }
            }
            for (const [key, child] of Object.entries(node.properties ?? {})) {
                if (key in item) check(child, item[key], `${where ? `${where}.` : ''}${key}`);
            }
        }
        if (isArray && node.items) {
            item.forEach((child, index) => check(node.items, child, `${where}[${index}]`));
        }
    };
    check(schema, value, path);
    return { ok: errors.length === 0, errors };
}
