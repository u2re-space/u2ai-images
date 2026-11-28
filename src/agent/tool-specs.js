/**
 * @file src/agent/tool-specs.js
 * @module agent/tool-specs
 * @purpose The catalogue of the tools the roles may call: their names, their parameters and the
 *          config switch that turns each of them off.
 *
 *   The catalogue lives apart from the executor on purpose. The executor knows what a crop does;
 *   the catalogue knows what the model is told about it. The description the model reads is part
 *   of the behaviour of a tool: a vague description makes the model guess the arguments, and the
 *   guess is paid for in a failed call and a wasted turn.
 *
 *   The config switches are named after the domain (`image_crop`), not after the wire name
 *   (`crop_image`), because the switches describe what a user turns off, and a user thinks in
 *   domains. The mapping lives here, in one place.
 *
 *   The tools that mean the same thing in every package of the house — read a file, list a
 *   directory, look at a picture, cut one — come from `shared/tools.js`. The tools of the
 *   images win over them: a package that has its own `view_image` keeps its own.
 *
 * @exports TOOL_SPECS, TOOL_NAMES, CONFIG_KEYS, toolSpecs, enabledToolNames, configKeyFor,
 *          toolEnabled
 * @ai.tags tools, specs, config
 * @ai.hint keep
 */

import { mergeToolSpecs } from '../shared/tools.js';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

/**
 * Every tool the images know, with the schema of its arguments.
 *
 * `configKey` is the switch in `config.tools` that disables the tool; `roles` lists the roles the
 * tool belongs to (an empty list means every role may use it).
 * @type {Readonly<Record<string, {configKey: string, description: string, parameters: object, required: string[], roles: string[]}>>}
 */
const OWN_TOOL_SPECS = Object.freeze({
    generate_image: {
        configKey: 'image_generate',
        description: 'Make a picture from a prompt. The picture lands in the assets of the run unless '
            + 'the output names another path.',
        parameters: {
            type: 'object',
            properties: {
                prompt: str('What the picture shows.'),
                output: str('Path of the written file, relative to the working directory.'),
                model: str('The model of the picture. Empty = the model of the run.'),
                size: str('The frame of the picture, WIDTHxHEIGHT.'),
                format: str('The format of the file: png | jpeg | webp.'),
                background: str('The background of the picture: auto | opaque | transparent.'),
                count: int('How many pictures to make. Default 1.'),
            },
            required: ['prompt'],
            additionalProperties: false,
        },
        required: ['prompt'],
        roles: [],
    },
    edit_image: {
        configKey: 'image_edit',
        description: 'Change a picture with a prompt. The source keeps its frame and its content '
            + 'unless the prompt says otherwise.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture, relative to the working directory.'),
                prompt: str('What has to change.'),
                output: str('Path of the written file, relative to the working directory.'),
                model: str('The model of the picture. Empty = the model of the run.'),
                size: str('The frame of the picture, WIDTHxHEIGHT.'),
                format: str('The format of the file: png | jpeg | webp.'),
            },
            required: ['input', 'prompt'],
            additionalProperties: false,
        },
        required: ['input', 'prompt'],
        roles: [],
    },
    crop_image: {
        configKey: 'image_crop',
        description: 'Cut a box out of a picture, or cut its padding off.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture.'),
                output: str('Path of the written file. Empty = the source itself.'),
                x: int('Left edge of the box in pixels.'),
                y: int('Top edge of the box in pixels.'),
                width: int('Width of the box in pixels.'),
                height: int('Height of the box in pixels.'),
                trim: bool('1 to cut the uniform or transparent padding off.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    pad_image: {
        configKey: 'image_pad',
        description: 'Extend the canvas of a picture to a frame, without touching the picture.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture.'),
                output: str('Path of the written file. Empty = the source itself.'),
                width: int('Width of the canvas in pixels.'),
                height: int('Height of the canvas in pixels.'),
                color: str('The colour of the padding: transparent or a CSS colour.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    fit_image: {
        configKey: 'image_fit',
        description: 'Put a picture into a frame, keeping the ratio or filling it.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture.'),
                output: str('Path of the written file. Empty = the source itself.'),
                width: int('Width of the frame in pixels.'),
                height: int('Height of the frame in pixels.'),
                fit: str('How the picture sits in the frame: contain | cover | fill.'),
            },
            required: ['input', 'width', 'height'],
            additionalProperties: false,
        },
        required: ['input', 'width', 'height'],
        roles: [],
    },
    alpha_image: {
        configKey: 'image_alpha',
        description: 'Build a real alpha channel for a picture.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture.'),
                output: str('Path of the written file. Empty = the source itself.'),
                mode: str('How the alpha channel is built: auto | mask | contour | flat | key | off.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    vectorize_image: {
        configKey: 'image_vectorize',
        description: 'Trace a raster into an SVG document. The document keeps the shapes and the '
            + 'palette of the source, and it is a document a browser opens as it is.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the source picture.'),
                output: str('Path of the written document. Empty = next to the source.'),
                prompt: str('What the tracing has to keep.'),
                model: str('The model of the tracing. Empty = the vector model of the run.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    edit_svg: {
        configKey: 'image_vectorize',
        description: 'Edit a vector document with a text model: it reads the document as code and '
            + 'names the edits that bring it to a clean state. The picture is not redrawn.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the document, relative to the working directory.'),
                output: str('Path of the written document. Empty = the document itself.'),
                task: str('What has to change. Empty = bring the document to a clean state.'),
                model: str('The text model of the editor. Empty = the model of the run.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    polish_svg: {
        configKey: 'image_vectorize',
        description: 'Check and tidy a vector document, without a model: the frame, the namespace, '
            + 'the balance of the tags, the scripts and the whitespace.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the document, relative to the working directory.'),
                output: str('Path of the written document. Empty = the document itself.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    compare_images: {
        configKey: 'image_compare',
        description: 'Compare pictures: a sheet of them side by side and a map of the difference.',
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    description: 'The pictures of the sheet.',
                    items: str('Path of a picture, relative to the working directory.'),
                },
                output: str('Path of the written sheet. Empty = the assets of the run.'),
                layout: str('How the pictures lie in the sheet: row | column | grid.'),
                mode: str('What is made: sheet | difference | both.'),
                labels: bool('1 to write the name of every picture into the sheet.'),
            },
            required: ['files'],
            additionalProperties: false,
        },
        required: ['files'],
        roles: [],
    },
    view_image: {
        configKey: 'image_view',
        description: 'Look at a picture and describe it.',
        parameters: {
            type: 'object',
            properties: {
                input: str('Path of the picture, relative to the working directory.'),
                prompt: str('What to look for. Empty = describe the picture.'),
            },
            required: ['input'],
            additionalProperties: false,
        },
        required: ['input'],
        roles: [],
    },
    code_mode: {
        configKey: 'code_mode',
        description: 'Write a JavaScript program and run it in a sandbox, instead of calling the tools '
            + 'one by one. The program runs in its own worker with its own realm: it has no process, no '
            + 'require and no network, and it cannot touch the disk by itself — but it may call your '
            + 'tools, and every call travels back to this process, which runs it with your rights and '
            + 'your rules. Use it when the work is a sequence of many calls: generating a picture and '
            + 'cutting it into three is one program, not four round trips. The program may await, and it '
            + 'may return the answer of the step. Inside it: `await tools.<name>(args)` calls a tool; '
            + '`catalogue.names` lists the tools you may call; `fs` is a file system in the memory; '
            + '`shared` is the shared block of the run; `allocate(bytes)` gives a block of memory; '
            + '`library.call("magick.ImageMagick.read", ...)` reaches the libraries of the house; '
            + '`console.log` writes to the output of the run. The program is sandboxed: a loop that never '
            + 'ends is stopped, and a mistake is an error, not a crash of the run. This tool writes: it is '
            + 'behind the write gate, and it earns the budget of the write.',
        parameters: {
            type: 'object',
            properties: {
                code: str('The program. The body of an async function: it may await, and it may return '
                    + 'the answer of the step. The tools are called as `await tools.name({ ... })`.'),
                purpose: str('One sentence: what the program has to do. It is written into the report '
                    + 'of the run.'),
                timeoutMs: int('How long the program may run, in milliseconds. The default is 60000.'),
            },
            required: ['code'],
            additionalProperties: false,
        },
        required: ['code'],
        roles: [],
    },
});

/**
 * The catalogue of the images: its own tools, and the tools of the house.
 *
 * The tools of the images win: a package that has its own `view_image` keeps it, and the
 * common one is not read twice.
 */
export const TOOL_SPECS = mergeToolSpecs(OWN_TOOL_SPECS);

/** The names of every tool, in catalogue order. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

/** The config switches of the tools, in catalogue order. */
export const CONFIG_KEYS = Object.freeze(TOOL_NAMES.map((name) => TOOL_SPECS[name].configKey));

/**
 * The config switch that belongs to a tool.
 * @param {string} name the name of the tool
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function configKeyFor(name) {
    return TOOL_SPECS[name]?.configKey ?? null;
}

/**
 * Whether a tool is switched on in the config.
 *
 * A tool that is not mentioned in `config.tools` is on: the config lists the exceptions, not the
 * permissions.
 * @param {object} tools the `tools` section of the config
 * @param {string} name the name of the tool
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function toolEnabled(tools, name) {
    const key = configKeyFor(name);
    if (!key) return false;
    return tools?.[key] !== false;
}

/**
 * Build the tool definitions in the Responses API shape.
 * @param {object} [tools] the `tools` section of the config; a false value switches the tool off
 * @param {{ names?: string[]|null, role?: string|null }} [options]
 *   `names` limits the list to these tools, `role` limits it to the tools of that role.
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function toolSpecs(tools = {}, { names = null, role = null } = {}) {
    const wanted = new Set(names ?? TOOL_NAMES);
    const out = [];
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
        if (!wanted.has(name)) continue;
        if (!toolEnabled(tools, name)) continue;
        if (spec.roles.length && role && !spec.roles.includes(role)) continue;
        out.push({
            type: 'function',
            name,
            description: spec.description,
            parameters: spec.parameters,
        });
    }
    return out;
}

/**
 * The names of the tools that are switched on for a role.
 * @param {object} tools the `tools` section of the config
 * @param {{ role?: string|null }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function enabledToolNames(tools = {}, { role = null } = {}) {
    return toolSpecs(tools, { role }).map((spec) => spec.name);
}
