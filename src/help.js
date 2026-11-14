/**
 * @file src/help.js
 * @module help
 * @purpose The command table and the help text of `ai-image`.
 * @exports COMMANDS, HELP, commandNames
 * @ai.hint keep
 */

/**
 * Every command of the CLI: the name, what it does, and how it is called.
 *
 * The table is the single source of truth: the help text is built from it, and the dispatcher
 * looks the command up here before it loads the module that runs it.
 * @type {ReadonlyArray<{ name: string, summary: string, usage: string }>}
 */
export const COMMANDS = Object.freeze([
    { name: 'generate', summary: 'Generate a picture from a prompt.', usage: 'ai-image generate "<prompt>" [--image <file>] [--purpose <name>] [--size <WxH>]' },
    { name: 'edit', summary: 'Edit a picture with a prompt.', usage: 'ai-image edit <file> "<prompt>" [--reference <file>] [--purpose <name>]' },
    { name: 'vectorize', summary: 'Turn a raster into SVG.', usage: 'ai-image vectorize <file> [--out <file.svg>]' },
    { name: 'decorate', summary: 'Build a decorative layer: a CSS rule or an SVG file.', usage: 'ai-image decorate "<description>" [--kind css|svg] [--out <file>]' },
    { name: 'crop', summary: 'Crop a box out of a picture, or cut its padding off.', usage: 'ai-image crop <file> [--x <n> --y <n> --width <n> --height <n>] [--trim]' },
    { name: 'pad', summary: 'Extend the canvas to a frame, without touching the picture.', usage: 'ai-image pad <file> --width <n> --height <n> [--color <css>]' },
    { name: 'fit', summary: 'Fit a picture into a frame.', usage: 'ai-image fit <file> --width <n> --height <n> [--mode contain|cover|fill]' },
    { name: 'resize', summary: 'Change the size of a picture.', usage: 'ai-image resize <file> [--width <n>] [--height <n>]' },
    { name: 'trim', summary: 'Cut the uniform or transparent edges off.', usage: 'ai-image trim <file> [--fuzz <n>]' },
    { name: 'split', summary: 'Cut a picture into a grid of tiles.', usage: 'ai-image split <file> --rows <n> --cols <n>' },
    { name: 'alpha', summary: 'Build a real alpha channel for a picture.', usage: 'ai-image alpha <file> [--alpha-mode auto|mask|contour|flat|key|off]' },
    { name: 'background', summary: 'Remove the background of a picture.', usage: 'ai-image background <file> [--alpha-mode auto|mask|contour|flat|key|off]' },
    { name: 'compare', summary: 'Compare pictures: a sheet and a difference map.', usage: 'ai-image compare <file> <file> [--mode sheet|difference|both]' },
    { name: 'info', summary: 'Tell what a picture is: format, frame, alpha, weight.', usage: 'ai-image info <file>' },
    { name: 'purpose', summary: 'Show the purpose map and the model each purpose resolves to.', usage: 'ai-image purpose [--list]' },
    { name: 'process', summary: 'Run the agentic pipeline over a task.', usage: 'ai-image process "<task>" [--image <file>]' },
    { name: 'config', summary: 'Create, show or locate the configuration.', usage: 'ai-image config [init|show|path]' },
]);

/**
 * The names of every command, in the order of the table.
 * @returns {string[]}
 */
export function commandNames() {
    return COMMANDS.map((command) => command.name);
}

/**
 * The help text of `ai-image`.
 * @type {string}
 */
export const HELP = `ai-image — AI image processor: generate, edit, size, crop, pad and clean up pictures

Usage:
  ai-image <command> [options]

Commands:
${COMMANDS.map((command) => `  ${command.name.padEnd(11)} ${command.summary}`).join('\n')}

Common options:
  -c, --config <path>   Path to ~/.ai-image/config.json.
  -o, --out <path>      Output file or directory (the command decides which).
      --json            Machine-readable answer on stdout.
      --dry-run         Show what would be done, without calling the API.
  -v, --verbose         More detail about what happens.
  -h, --help            This text.
      --version         The version of the package.

Batch options:
      --batch           Submit the requests of the run as one batch and stop (exit code 2).
      --batch-fetch     Take the answers of the submitted batches and go on (exit code 3 while
                        the batch is not ready yet).
                        Only the hosts with "supports": { "batch": true } take part in it.

Generation options:
  -m, --model <name>    Model override.
      --image-model <name>  Image model override.
      --purpose <name>  Purpose: decompose | generate | edit | remove_background | upscale |
                        unrotate (aliases: isolate, isolate_object, rectify).
      --size <WxH>      Frame of the picture.
      --resolution <tier>  Resolution tier: 512 | 1K | 1.5K | 2K | 3K | 4K.
      --format <fmt>    Output format: png | jpeg | webp | svg.
      --background <b>  Background: auto | opaque | transparent.
  -n, --count <n>       How many pictures to make.
      --reference <file>  An extra reference for an edit (repeatable).
      --image <file>    A reference picture for a generation or a decoration.

Local options:
      --engine <name>   Raster engine: auto | sharp | canvas | magick.
      --x <n> --y <n>  Corner of the crop.
      --width <n> --height <n>  Frame of the result.
      --max-side <n>    The longest side of the result.
      --factor <n>      How many times bigger the result is.
      --trim            Cut the uniform or transparent edges off.
      --fuzz <n>        How far a color may differ and still be the same edge (0-255).
      --transparent-only  Trim only the transparent edges.
      --rows <n> --cols <n>  Grid of the split.
      --mode <name>     Mode of the command (fit, compare, alpha).
      --alpha-mode <name>  Alpha mode: auto | mask | contour | flat | key | off.
      --layout <name>   Layout of the comparison: row | column | grid.
      --frame <shape>   Frame of the comparison: 16:9, 2.39:1, 800x600.
      --gap <n>         The gap between the cells of the comparison.
      --labels          Write the name of every picture on the sheet.
      --kind <css|svg>  The technique of a decoration.

Configuration:
  ~/.ai-image/config.json  The configuration file.
  AI_IMAGE_*              Environment overrides (AI_IMAGE_HOME changes the directory).

Examples:
  ai-image generate "a red bicycle leaning on a wall" --size 1024x1024
  ai-image edit photo.png "make the sky stormy" --purpose edit
  ai-image crop photo.png --x 10 --y 20 --width 640 --height 480 --out cut.png
  ai-image trim photo.png --transparent-only --out tight.png
  ai-image fit photo.png --width 1200 --height 800 --mode cover
  ai-image background logo.png --out logo-cut.png
  ai-image compare before.png after.png --mode both --labels
  ai-image info photo.png --json
  ai-image purpose
  ai-image process "cut the background of logo.png" --batch
  ai-image process "cut the background of logo.png" --batch-fetch
`;
