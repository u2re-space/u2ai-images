# @u2ai/images

AI image processor: generation, editing, advanced sizing, cropping, padding, alpha channels
and background removal over OpenAI-compatible backends.

- Named CLI as `ai-image`.
- Config in `~/.ai-image/config.json`.
- Node.js 26+, ESM, no SDK (plain `fetch`).
- Local raster work through `sharp`, `canvas` and ImageMagick.

The package was split out of the `ai` monolith: the picture work lives here, with its own
configuration, its own purposes and its own tests. The monolith command `ai image` is a
bridge that forwards to this CLI and returns its exit code.

## Install

```bash
npm install -g @u2ai/images
```

From a checkout:

```bash
npm install
npm link        # puts `ai-image` into PATH
```

The native dependencies (`sharp`, `canvas`) are installed by npm; a working ImageMagick
binary is optional and only used as a fallback raster engine.

## Quick start

```bash
ai-image config init                 # write ~/.ai-image/config.json
export AI_IMAGE_API_KEY=sk-...       # or put the key into the config file

ai-image generate "a red bicycle leaning on a wall" --size 1024x1024
ai-image edit photo.png "make the sky stormy" --purpose edit --out stormy.png
ai-image background logo.png --out logo-cut.png
```

Every command accepts `--json` (one machine-readable object on stdout), `--dry-run` (the plan
without a single network call) and `--verbose`.

## Commands

| Command | What it does |
|---|---|
| `generate` | Generate a picture from a prompt. |
| `edit` | Edit a picture with a prompt, with optional reference pictures. |
| `vectorize` | Turn a raster into an SVG document. |
| `decorate` | Build a decorative layer: a CSS rule or an SVG file. |
| `crop` | Crop a box out of a picture, or cut its padding off (`--trim`). |
| `pad` | Extend the canvas to a frame without touching the picture. |
| `fit` | Fit a picture into a frame (`contain`, `cover`, `fill`). |
| `resize` | Change the size of a picture. |
| `trim` | Cut the uniform or transparent edges off. |
| `split` | Cut a picture into a grid of tiles. |
| `alpha` | Build a real alpha channel for a picture. |
| `background` | Remove the background of a picture. |
| `compare` | Compare pictures: a sheet and a difference map. |
| `info` | Tell what a picture is: format, frame, alpha, weight. |
| `purpose` | Show the purpose map and the model each purpose resolves to. |
| `process` | Run the agentic pipeline over a task (plan → make → check → note). |
| `config` | Create, show or locate the configuration. |

`ai-image --help` prints the same list with the flags of every group.

## Examples

```bash
# generation with an explicit frame and format
ai-image generate "a fox in the snow" --size 1536x1024 --format webp --count 2

# an edit: the first picture is the source, the rest are references
ai-image edit logo.png "make the background transparent" --reference mockup.png

# a cut-out with the model of the configuration (the seedream)
ai-image background product.png --out product-cut.png --alpha-mode mask

# a cut-out with the second model of the list
ai-image background product.png --out product-cut.png --image-model openai/gpt-image-2.6-sunburst

# a cut-out that keeps one object only: the fragments of the neighbours go away
ai-image background bishop.png --subject "chess bishop" --out bishop.png

# local work, no network
ai-image crop photo.png --x 10 --y 20 --width 640 --height 480 --out cut.png
ai-image trim photo.png --transparent-only --out tight.png
ai-image fit photo.png --width 1200 --height 800 --mode cover --out fitted.png
ai-image pad photo.png --width 2048 --height 2048 --color transparent
ai-image split sheet.png --rows 3 --cols 2 --out tiles

# a comparison sheet and a difference map
ai-image compare before.png after.png --mode both --labels

# a decorative layer: a CSS rule or a standalone SVG
ai-image decorate "a ribbon banner" --kind css

# what is this file?
ai-image info photo.png --json
```

Without `--out`, a local command writes a derived file next to the source and never overwrites
it (`photo-fit-contain.png`, `photo-trim.png`, `photo-pad.png`, …). `alpha` and `background`
copy the source to the derived PNG first, so the original stays untouched. `decorate` writes
`styles/decor/<name>.css` or `assets/decor/<name>.svg`.

## The purpose system

A purpose says what the picture is for; the purpose decides which model serves the request.

| Purpose | Meaning |
|---|---|
| `decompose` | Layouts, templates, screen mockups: clean geometry, one style. |
| `generate` | Plain text-to-image or a restyle. The general-purpose default. |
| `edit` | A picture that is changed; the source keeps its frame and its content. |
| `remove_background` | A subject cut out of its background. |
| `upscale` | A picture that is enlarged while it keeps its quality. |
| `unrotate` | A picture that is straightened. |

Aliases are accepted everywhere: `isolate` and `isolate_object` name `remove_background`,
`rectify` names `unrotate`.

```bash
ai-image purpose                       # the map and the resolved models
ai-image generate "a landing hero" --purpose generate
```

An explicitly configured `imageModel` always wins over the purpose routing.

## Configuration

The configuration lives in `~/.ai-image/config.json` (`AI_IMAGE_HOME` moves the whole home
directory). The file is created by `ai-image config init`; the fields the user is expected to
edit are the only ones it holds — everything else stays on the defaults.

The default text model is `minimax/minimax-m3.1-flash` (the roles and the AI parser talk
through it) and the default picture model is `bytedance-seed/seedream-5-5`.

```json
{
  "model": "minimax/minimax-m3.1-flash",
  "imageModel": "bytedance-seed/seedream-5-5",
  "vectorModel": null,
  "backends": [
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" },
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY", "supports": { "batch": true } }
  ],
  "imagesBackends": [
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY" }
  ],
  "image": {
    "size": "auto",
    "format": "png",
    "background": "auto",
    "outputDir": ".ai/assets",
    "alphaMode": "auto",
    "quality": "auto"
  },
  "reasoning": {
    "effort": "high"
  },
  "purpose": {
    "models": {
      "generate": ["bytedance-seed/seedream-5-5"],
      "edit": ["bytedance-seed/seedream-5-5"]
    }
  },
  "batch": {
    "enabled": false,
    "journalDir": ".ai-image/batch"
  }
}
```

The precedence is: defaults → `~/.ai-image/config.json` → `--config <file>` → `AI_IMAGE_*`
environment → the flags of the command.

The defaults hold four hosts: `routerai` is asked first for a single request, `proxyapi`
serves the batch route (it carries the flag `supports: { batch: true }`), and `sprutdock`
and `gptunnel` follow as the spare hands of the rotation.

The home directory holds:

```
~/.ai-image/
  config.json      the configuration
  prompts/         custom prompts
  notes/           the notes of the agentic runs
  diagnostics/     the raw answers of the API
```

### Environment

| Variable | Meaning |
|---|---|
| `AI_IMAGE_HOME` | The home directory of the CLI (`~/.ai-image` by default). |
| `AI_IMAGE_CONFIG` | The path of the configuration file. |
| `AI_IMAGE_API_KEY` | The key of the API (`OPENAI_API_KEY` also works). |
| `AI_IMAGE_BASE_URL` | The endpoint of the API (`OPENAI_BASE_URL` also works). |
| `AI_IMAGE_TEXT_MODEL` | The text model of the roles and the parser. |
| `AI_IMAGE_IMAGE_MODEL` | The picture model. |
| `AI_IMAGE_VECTOR_MODEL` | The model that draws the SVG. |
| `AI_IMAGE_BACKENDS` | The JSON list of the text backends. |
| `AI_IMAGE_IMAGES_BACKENDS` | The JSON list of the picture backends. |
| `AI_IMAGE_IMAGE_SIZE`, `AI_IMAGE_IMAGE_FORMAT`, `AI_IMAGE_IMAGE_BACKGROUND`, `AI_IMAGE_IMAGE_RESOLUTION` | The picture knobs. |
| `AI_IMAGE_IMAGE_QUALITY` | The quality tier of the picture: `auto`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `AI_IMAGE_IMAGE_COMPLEXITY` | The deprecated name of the quality tier. |
| `AI_IMAGE_IMAGE_SEED` | The seed that makes the answer repeatable. |
| `AI_IMAGE_IMAGE_COMPRESSION` | The degree of the compression of a jpeg or a webp: 0..100. |
| `AI_IMAGE_IMAGE_FRAME_COUNT`, `AI_IMAGE_IMAGE_FRAME_DURATION_MS` | The frames of an animated GIF and the duration of one frame. |
| `AI_IMAGE_IMAGE_MASK` | The mask picture of an edit: the area that is repainted. |
| `AI_IMAGE_EFFORT`, `AI_IMAGE_SUMMARY` | The reasoning effort and the summary of the text requests. |
| `AI_IMAGE_PURPOSE` | The default purpose. |
| `AI_IMAGE_ALPHA_MODE` | The default alpha mode. |
| `AI_IMAGE_RASTER_ENGINE`, `AI_IMAGE_MAGICK_PATH` | The local raster engine. |
| `AI_IMAGE_TIMEOUT_MS`, `AI_IMAGE_RETRIES` | The limits of one request. |

`AI_MODEL` and `AI_IMAGE_MODEL` keep the meaning they have in the monolith: the text model and
the picture model.

The messages of the configuration validator are in Russian, as in the sibling package
`@u2ai/decomposer`; every other message of the CLI is in English.

## Reasoning effort

The text model thinks at the level the run asks for. The level travels in the body of every
text request, under `reasoning.effort` — it is not a hint of the prompt and not a field of the
local settings.

The chain of the levels is short:

```
roles.<role>.effort  →  roles.default.effort  →  reasoning.effort
```

The first one that is set wins. The default of the run is `high`, and the default of the
default role is `null` — the role inherits the effort of the run until it is given its own.
The levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; `reasoning.summary`
(`auto`, `concise`, `detailed`) asks for the summary of the reasoning and is off by default.

Every request is pulled down to what the model of that request really takes, so a fallback
model is never asked for a level it refuses:

| Model | Context | Output | Ceiling | Ladder |
|---|---|---|---|---|
| `minimax/minimax-m3.1-flash` | 1M | 524K | `xhigh` | `low`, `medium`, `high`, `xhigh` |
| `google/gemini-4-hydrogen` | 1M | 1M | `xhigh` | `low`, `medium`, `high`, `xhigh` |
| `moonshotai/kimi-k3.1-pro` | 1M | 944K | `medium` | `none`, `low`, `medium` |

Two facts of the live gateway shape the table. MiniMax refuses to work without reasoning
("Reasoning is mandatory for this endpoint and cannot be disabled"), so a request for `none`
is raised to `low` instead of being refused. Kimi takes the reasoning off without a refusal
and answers in a fraction of the time (about 0.8 s against about 31 s at `medium` on the same
question), so `none` stays on its ladder — pass `--effort none` when the answer matters more
than the reasoning. Gemini 4 Hydrogen names the four levels of its card (`low`, `medium`,
`high`, `xhigh`) and decodes up to 1M tokens with the continuation, so `none` is raised to
`low` there as well.

The quality tier (`quality`) is a field of the *picture* request, not of a text one: it
belongs to the models that take it (`gpt-image-2.6` and `gpt-image-2.5`, where it is `high`),
and the models that know no such field (`seedream`, `riverflow`) are asked without it. The
knob is `image.quality` (`auto` by default — the tier of the model) and the flag `--quality`;
`--complexity` is the old name of the flag and still works.

```bash
ai-image process "a cover for the release" --effort medium
ai-image process "a cover for the release" --effort none --model moonshotai/kimi-k3.1-pro
```

## The picture knobs

The API of the pictures is not one API: every family of the models has its own fields, its
own menu of frames and its own menu of tiers. The package keeps that knowledge in the
profiles of the models (`src/model/profiles.js`) and sends only the fields the model of the
request really takes — the gateway drops what it does not serve, but a field that is there
and wrong costs the whole request.

| Knob | Field of the API | Who takes it |
|---|---|---|
| `--quality` | `quality` | `gpt-image-2.5`, `gpt-image-2.6` (`auto`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `--resolution` | `resolution` | `seedream` (`1K`, `1.5K`, `2K`), `riverflow` (`1K`, `2K`, `4K`) |
| `--size` | `size` | every family with a free frame; a shape (`16:9`) becomes `aspect_ratio` |
| `--seed` | `seed` | `seedream`, `flux`, `qwen-image`, `krea`, `hy-image` |
| `--compression` | `output_compression` | `gpt-image-2.6` (a jpeg or a webp, 0..100) |
| `--frames`, `--frame-duration` | `frame_count`, `frame_duration_ms` | `gpt-image-2.6` (a GIF, 2..16 frames, 20..2000 ms) |
| `--mask` | `mask` | `gpt-image-*` (a PNG with an alpha channel; it needs a source picture) |

The quality is pulled down to the ladder of the model, the tier is pulled down to the menu of
the model (`4K` on the seedream becomes `2K`, or the request is refused by the vendor), and
the shape is pulled down to the closest shape of the menu of the model (the seedream takes
the cinema frames `9:19.5`, `9:20` and `9:21`, the gpt-image stops at `21:9`).

The count of the pictures is cut to the ceiling of the model as well: a model that takes one
picture per request (`seedream`, `riverflow`) is asked as many times as there are pictures
wanted, and the answers are put together.

```bash
ai-image generate "a fox in the snow" --quality max --size 2048x2048
ai-image generate "a spinning coin" --format gif --frames 8 --frame-duration 120
ai-image generate "a lighthouse" --seed 42
ai-image edit photo.png "make the sky stormy" --mask mask.png
```

## The providers

The package speaks the OpenAI-compatible API: `/images/generations`, `/images/edits`
(multipart) and, when a host has no images route, the `image_generation` tool of the
Responses API as a fallback.

- A host that serves `/images/*` is asked there first.
- A host without that route is asked through the Responses API; the error names the real
  reason, not "the picture did not arrive".
- A model that the host refuses is followed by the next model of the chain
  (`fallback.models`), and the next backend of the pool.
- `openai/*` models are served by `api.openai.com` or by a proxy host; a model of another
  vendor needs a proxy host — the purpose map resolves the model only to a host that is
  actually configured.

The built-in purpose map starts with `bytedance-seed/seedream-5-5`: it draws the picture, it
cuts the subject out with a native alpha and it keeps the frame of the source.
`openai/gpt-image-2.6-sunburst` and `sourceful/riverflow-v2.6-pro` follow as the fallbacks —
they are asked when the seedream is unknown to a host or refuses the request. The cut-out has
its own short list: only the seedream and the sunburst are asked for a background removal,
through the OpenAI-compatible route of the gateway — the asynchronous task API of the monolith
is not ported.

The seedream takes a free frame, but the host refuses a frame below 960×960 pixels: a crop
smaller than that is padded up to the floor, and the padding is cut off the answer.

### The cut-out

`background` and `alpha` do not draw a matte and do not paint the background: the models
that serve a cut-out carry an alpha channel natively, so the picture is asked for a
transparent background and the alpha of the answer is the answer.

| Model | Role |
|---|---|
| `bytedance-seed/seedream-5-5` | The first one that is asked: the picture model of the default. |
| `openai/gpt-image-2.6-sunburst` | The second one: the fallback of the cut-out. |

The answer is judged before it is accepted: a picture without a real alpha, or one that
leaves a wide halo around the edge, is not a cut-out — the next model of the list is asked.
A cut-out of a padded source names the zone of the content in the prompt, so the model cuts
the object out of the picture and does not take the empty canvas for the background.

A crop of a screenshot often holds more than one object: the piece of the board that fell
into the cut of the bishop, the edge of a neighbour in the cut of the board. The flag
`--subject <text>` names the object that has to stay — the fragments of the neighbours and
everything else are told to disappear. The same text goes into the prompt of the command
`edit` when the caller builds one.

```bash
ai-image background bishop.png --subject "chess bishop" --out bishop-cut.png
```

A model that redraws the picture draws it a little differently every time: a detail of the
edge may be lost in one answer and kept in the next. The commands `background` and `alpha`
therefore ask the model three times and take the answers together — the median of their alpha
is the cut-out the attempts agree on. A detail that half of the answers keep stays, a detail
that one answer keeps alone goes, and the soft edge of the object stays soft. The flag
`--attempts <n>` says how many times the model is asked; the library default of
`applyGeneratedAlphaMask` is one answer.

```bash
ai-image background board.png --subject "chess board" --attempts 3 --out board-cut.png
```

A user who wants a technical override names it: `image.maskModel` (`self` means the model
that drew the picture) takes the place of the list.

### The rotation over the backends

The pool of the hosts remembers what every host said, so the same refusal is not paid for
twice:

| What the host said | What the pool remembers |
|---|---|
| `402`, "Insufficient balance" | the host is out of money — it is not asked again |
| `401`/`403`, "Invalid API key" | the host does not accept the key — it is not asked again |
| "model not found" | the host does not know that model — it is not asked that model again |
| "not found in this api" | the host does not serve that route — the request goes another way |
| `429`, `5xx` | the host is busy or broken — the request is retried and then goes on |

The host that answered is moved to the front of the pool: the one that works is asked first
from then on. When every host refuses, the run fails with one error that carries the reason
of every attempt (`ALL_BACKENDS_FAILED`), and the decision about the next model or the next
route is made by all the attempts, not by the last one.

## The batch route

Some hosts serve the OpenAI batch API: the requests go out as one file, the host works on
them in the background (up to a day), and the answers come back in another run. A batch
costs half the price of the same requests one by one.

The route is two-phase by nature, and the CLI says so:

```bash
ai-image process "cut the background of logo.png" --batch        # submits, exits with 2
ai-image process "cut the background of logo.png" --batch-fetch  # takes the answers, goes on
```

- `--batch` collects the requests of the run, uploads the file of the requests, creates the
  batch and stops. The exit code is **2**: the answers are not here yet.
- `--batch-fetch` asks the host how the batch is doing, downloads the file of the answers and
  goes on with them. While the batch is not ready the exit code is **3**.
- The journal (`.ai-image/batch` by default) is what the two phases share: the answer of a
  request is found by the hash of the request, so nothing is paid for twice.
- Only the hosts that carry the flag `"supports": { "batch": true }` take part in it. The
  default host of the batch route is `proxyapi`.
- The pictures are not part of a batch, but their payloads are kept in the journal too: the
  second phase does not draw them again.
- A batch whose requests failed keeps the reasons in the file of the errors of the host, and
  the run says which request failed and why.

## The local raster layer

One language for every engine: a frame is `{ width, height, data }` with raw RGBA. The
engines are tried in this order: `sharp` → `canvas` → ImageMagick. The engine can be pinned
with `--engine auto|sharp|canvas|magick` or `image.rasterEngine`.

- `sharp` is the fastest and the default when it is installed.
- `canvas` is the fallback that needs no binary on the PATH.
- ImageMagick is the last resort; it is the only engine that counts the palette colors, so
  the vectorizer uses it when it is there.

Alpha modes: `auto` (native alpha → the model cuts the subject out → `contour` → `flat` →
`key`), `mask` (the model cuts the subject out, nothing else), `contour`, `flat`, `key`,
`off`. A forced mode runs only its own step.

The frames of a request are made in three ways: `direct` (the frame as it is), `align` (the
canvas is padded, the content keeps its scale and its position, and the padding is cut off
the answer) and `downscale` (the answer is scaled down, the proportions are kept).

The padding is cut off by the share of the answer: a model that answers with a frame of its
own still put the content where the padding put it, so the share of the canvas is the way back
to the content. The answer of a different frame does not break the zone.

## The agentic pipeline

```bash
ai-image process "a hero picture for the landing page" --image mockup.png
```

The run is a pipeline of five stages: the notes of the past runs are read, the strategy is
planned, the pictures are made, the result is checked and the note of the run is written to
`~/.ai-image/notes/<date>.json`. Every role answers with a strict JSON of its own schema, and
the answer is checked before it is used.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The run succeeded. |
| 1 | The run failed: the network, the model, the file. |
| 2 | The arguments were wrong; nothing was tried. Or the batch was submitted and the answers are not here yet. |
| 3 | The batch is not ready yet: run the same command with `--batch-fetch` later. |
| 130 | The run was interrupted. |

## Library API

```js
import { main, loadConfig, PURPOSE_NAMES } from '@u2ai/images';

const exitCode = await main(['generate', 'a red bicycle', '--size', '1024x1024']);
```

`main` is the whole CLI. `loadConfig` returns the merged configuration, and
`createClient` (from `src/openai/client.js`) returns the HTTP client for the generation and
the editing calls.

## The access layer

`src/access` is the door between the model and the machine: the files and the commands under one
root. Both halves work through a backend, so the same rules hold on a native disk, in the memory,
or over a remote one.

```js
import { createAccess } from './src/access/index.js';

const access = createAccess({ root: process.cwd() });

await access.fs.writeText('notes/todo.md', '# todo');
const found = await access.fs.search({ query: 'todo' });

const listing = await access.fs.listFiles('src', { depth: 2, limit: 400 });
const copied = await access.fs.copy('src/app.js', 'lib/app.js');
const answer = await access.exec.run('node', ['--version']);
```

The rules of the paths live in one place and are never optional: a path may not leave the root —
neither through `..` nor through a symbolic link — the secret files and the secret directories are
never accessible, and the read-only directories may be read, but never written.

`listFiles` returns the tree of a path as the model reads it: the noisy folders are marked and
not opened, the dot-files are hidden unless they are asked for, the sizes are in the text, and a
path that does not exist yet answers with the nearest existing parent. `copy` copies a file or a
tree under the same rules: no secret, no symbolic link, no directory into itself, and the
destination must not exist unless `overwrite` is asked for.

## The house of the project

Every project has one directory of its own: `.ai/`. Everything a run makes that is not the
product itself lives there, and nowhere else.

```
.ai/
  assets/           the pictures the house makes
  tmp/<run-id>/     the state of a run
  logs/             the logs of the API calls
  manifest.json     the contract of the project: what every system made and where it lies
```

The pictures of a run land in `.ai/assets/` — that is what `image.outputDir` says by default,
and the config may move them elsewhere. The work of the alpha pipeline — the matte, the answer
of the model, the merged alpha — is temporary: it lives in the temporary directory of the
system and not in the project, so the project gets the picture and nothing else.

The contract is how the systems of the house find each other. The images system signs its own
part of `.ai/manifest.json` and never touches the part of another one:

```json
{
  "manifestVersion": 1,
  "updatedAt": "2026-11-15T03:41:02.113Z",
  "systems": {
    "images": {
      "delivery": ".ai/assets/",
      "artifacts": {
        "assets": ".ai/assets",
        "pictures": [".ai/assets/ai-image-20261115-141530-1.png"]
      },
      "command": "generate",
      "updatedAt": "2026-11-15T03:40:58.002Z"
    }
  }
}
```

The paths are relative to the project and with forward slashes: the contract is read on another
machine and another system, and the path has to mean the same thing there. A run reads the
contract first and only then the old paths of the config, so a delivery that moved is still
found.

The files of the house are written whole: the bytes go to a file next to the target and the
target is replaced by a rename. A reader never sees half of a picture, and a run that dies in
the middle leaves the old file and not a broken one.

The model of the run is kept inside the working directory: every path it names is resolved
first, so a path that leaves the directory, a secret file or a read-only directory is refused
and the reason is named.

## Limits

- The vectorizer needs a provider that can answer with an SVG document; a raster-only
  provider cannot vectorize.
- The SVG of `decorate` is a text file: it is written and checked as text, not redrawn.
- The picture size is bounded by the model family (`maxPixels`, `maxEdge`, `maxRatio`); a
  request that does not fit is padded, scaled down or refused with the reason named.
- ImageMagick may be absent; the command says which engines are missing instead of failing
  with `ENOENT`.
- The package never overwrites the source of a local operation.

## Development

```bash
npm test          # the whole suite, offline
npm run check     # node --check over every file of the package
npm run test:network   # the calls to the real hosts (needs the keys)
```

The network tests are behind `AI_IMAGE_NETWORK_TESTS=1` and are skipped by default.
  The rest of the suite is guarded: `test/offline-guard.js` refuses every address outside
  the machine, so a test that reaches the outside fails fast instead of spending money.

## License

MIT
