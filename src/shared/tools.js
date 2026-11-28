/**
 * @file src/shared/tools.js
 * @module shared/tools
 * @purpose The tools of the house: one catalogue that every package of the house reads.
 *
 *   Every package of the house has its own tools, and they grew apart: the measurer cuts
 *   pictures, the decomposer warps them, the webdev writes code. But the tools that every
 *   package needs — read a file, list a directory, look at a picture, cut one, write one —
 *   are the same tools, and they were written twice.
 *
 *   This module is the common core: the tools that mean the same thing everywhere, with one
 *   description, one schema and one name. A package reads the part of the catalogue it
 *   needs and adds its own tools beside it.
 *
 *   The shape of a tool of the house is the shape every package already uses:
 *
 *   ```js
 *   {
 *     configKey: 'read',                       // the switch in config.tools
 *     description: 'Read a text file.',       // what the model is told
 *     parameters: { type: 'object', ... },     // the schema of the arguments
 *     required: ['path'],                     // the arguments that must be there
 *     roles: [],                              // the roles that may call it
 *   }
 *   ```
 *
 *   A tool that is not mentioned in `config.tools` is on: the config lists the exceptions,
 *   not the permissions.
 *
 * @depends none
 * @usedBy agent/tool-specs, agent/tools, roles/index
 * @exports COMMON_TOOL_SPECS, COMMON_TOOL_NAMES, COMMON_CONFIG_KEYS, commonToolSpecs,
 *          commonToolEnabled, commonConfigKeyFor, mergeToolSpecs
 * @ai.tags house, tools, catalogue
 * @ai.hint pure
 */

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

/**
 * The tools of the house that mean the same thing in every package.
 *
 * The names are the names the packages already use, so nothing has to be renamed: the
 * measurer already has `read_file`, the decomposer already has `crop_image`, and the webdev
 * already has all of them.
 *
 * The `roles` list is empty in most of them: a tool of the house belongs to every role, and
 * the package that has its own narrower list cuts it down.
 */
export const COMMON_TOOL_SPECS = Object.freeze({
    list_files: {
        configKey: 'list',
        description: 'List the files and the directories of a path of the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the directory, relative to the working directory. Empty = the root.'),
                depth: int('How many levels deep to list. Default 2.'),
                includeHidden: bool('1 to include the files and directories whose name starts with a dot.'),
            },
            required: [],
            additionalProperties: false,
        },
        required: [],
        roles: [],
    },
    read_file: {
        configKey: 'read',
        description: 'Read a text file of the working directory and answer with its content.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
                startLine: int('First line to read, 1-based.'),
                endLine: int('Last line to read, inclusive.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: [],
    },
    write_file: {
        configKey: 'write',
        description: 'Write a text file into the working directory. The content replaces the file.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
                content: str('The whole text of the file.'),
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        required: ['path', 'content'],
        roles: [],
    },
    search_files: {
        configKey: 'search',
        description: 'Search the files of the working directory for a piece of text.',
        parameters: {
            type: 'object',
            properties: {
                query: str('The text to look for.'),
                path: str('The directory to search in, relative to the working directory. Empty = the whole root.'),
                regex: bool('1 to read the query as a regular expression.'),
            },
            required: ['query'],
            additionalProperties: false,
        },
        required: ['query'],
        roles: [],
    },
    read_skill: {
        configKey: 'skill',
        description: 'Read an installed Agent Skill by name.',
        parameters: {
            type: 'object',
            properties: {
                name: str('The name of the skill.'),
            },
            required: ['name'],
            additionalProperties: false,
        },
        required: ['name'],
        roles: [],
    },
    view_image: {
        configKey: 'image_view',
        description: 'Open an image file: the picture comes back into the conversation and its pixel size '
            + 'comes with it. Use it before cropping or projecting a picture.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the image file, relative to the working directory.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: [],
    },
    crop_image: {
        configKey: 'image_crop',
        description: 'Cut a rectangle out of an image and write it to a file.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                x: int('Left edge of the rectangle in pixels.'),
                y: int('Top edge of the rectangle in pixels.'),
                width: int('Width of the rectangle in pixels.'),
                height: int('Height of the rectangle in pixels.'),
                output: str('Path of the written file. Empty = next to the source with a -crop suffix.'),
            },
            required: ['path', 'x', 'y', 'width', 'height'],
            additionalProperties: false,
        },
        required: ['path', 'x', 'y', 'width', 'height'],
        roles: [],
    },
    split_image: {
        configKey: 'image_split',
        description: 'Cut an image into a grid of equal tiles.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                rows: int('Number of rows in the grid.'),
                cols: int('Number of columns in the grid.'),
                outputDir: str('Directory the tiles are written to. Empty = the working directory.'),
            },
            required: ['path', 'rows', 'cols'],
            additionalProperties: false,
        },
        required: ['path', 'rows', 'cols'],
        roles: [],
    },
    compare_images: {
        configKey: 'image_compare',
        description: 'Compare two images pixel by pixel and report how much of the picture changed.',
        parameters: {
            type: 'object',
            properties: {
                before: str('Path of the first image.'),
                after: str('Path of the second image.'),
            },
            required: ['before', 'after'],
            additionalProperties: false,
        },
        required: ['before', 'after'],
        roles: [],
    },
});

/** The names of the tools of the house, in catalogue order. */
export const COMMON_TOOL_NAMES = Object.freeze(Object.keys(COMMON_TOOL_SPECS));

/** The config switches of the tools of the house, in catalogue order. */
export const COMMON_CONFIG_KEYS = Object.freeze(
    COMMON_TOOL_NAMES.map((name) => COMMON_TOOL_SPECS[name].configKey),
);

/**
 * The config switch that belongs to a tool of the house.
 *
 * @param {string} name the name of the tool
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function commonConfigKeyFor(name) {
    return COMMON_TOOL_SPECS[name]?.configKey ?? null;
}

/**
 * Whether a tool of the house is switched on in the config.
 *
 * A tool that is not mentioned in `config.tools` is on: the config lists the exceptions,
 * not the permissions.
 *
 * @param {object} tools the `tools` section of the config
 * @param {string} name the name of the tool
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function commonToolEnabled(tools, name) {
    const key = commonConfigKeyFor(name);
    if (!key) return false;
    return tools?.[key] !== false;
}

/**
 * Build the tool definitions of the house in the Responses API shape.
 *
 * @param {object} [tools] the `tools` section of the config
 * @param {{ names?: string[]|null, role?: string|null }} [options]
 *   `names` limits the list to these tools, `role` limits it to the tools of that role.
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function commonToolSpecs(tools = {}, { names = null, role = null } = {}) {
    const wanted = new Set(names ?? COMMON_TOOL_NAMES);
    const out = [];
    for (const [name, spec] of Object.entries(COMMON_TOOL_SPECS)) {
        if (!wanted.has(name)) continue;
        if (!commonToolEnabled(tools, name)) continue;
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
 * Merge the tools of the house with the tools of a package.
 *
 * The tools of the package win: a package that has its own `read_file` keeps it, and the
 * common one is not read twice.
 *
 * @param {object} own the tools of the package
 * @returns {object} the merged catalogue
 * @exports
 * @ai.hint pure
 */
export function mergeToolSpecs(own = {}) {
    const out = {};
    for (const [name, spec] of Object.entries(COMMON_TOOL_SPECS)) {
        out[name] = spec;
    }
    for (const [name, spec] of Object.entries(own ?? {})) {
        out[name] = spec;
    }
    return Object.freeze(out);
}
