# План перехода: Universal-AI (монолит 0.2.xx) → @u2ai/images (0.3.xx)

> Актуальный статус: **план написан, реализация не начата**.
> Рабочий дом переносимого кода: `submodules/u2ai-images/`.
> Репозиторий: <https://github.com/u2re-space/u2ai-images> (remote ещё не настроен).
>
> Наследник предыдущего шага: `submodules/u2ai-decomposer/` (`@u2ai/decomposer`, CLI
> `ai-decompose`) — из него берутся каркас CLI, конфиг-система и openai-слой, чтобы
> два пакета не расходились по стилю.

---

## 0. Цели и рамки

**Цель:** выделить подсистему работы с изображениями из монолитного CLI `ai`
(`@u2ai/universal-ai`) — роль `image-processor`, команду `ai image`, локальные
image-инструменты (`generate_image`, `edit_image`, `crop_image`, `split_image`,
`compare_images`, `vectorize_image`), альфа-пайплайн и роль `decorator` — в
самостоятельный CLI `ai-image` (`@u2ai/images`) со своим конфигом `~/.ai-image/*`.

**Рамки нового пакета:**

| Параметр | Значение |
|---|---|
| Имя пакета | `@u2ai/images` |
| Бинарь | `ai-image` (`bin/ai-image.{js,cmd,ps1,sh}`) |
| Репозиторий | <https://github.com/u2re-space/u2ai-images> |
| Версия | 0.3.xx (монолит остаётся на 0.2.xx и угасает по шагу 14) |
| Конфиг | `~/.ai-image/` — каталог: `config.json`, `prompts/`, `notes/` (оверрайд `AI_IMAGE_HOME`) |
| Префикс env | `AI_IMAGE_*` (совместимость с `OPENAI_*`, `AI_MODEL`, `AI_IMAGE_MODEL`) |
| Runtime | Node.js >= 26, ESM, без SDK (чистый `fetch`) |
| Зависимости | `sharp`, `canvas`, `@resvg/resvg-js` |

**Что переносим, а что — нет:**

| Переносим | Не переносим |
|---|---|
| Продвинутая система размеров (тиры, `minPixels`/`maxPixels`, div16, `padToMin`, `size`/`resolution`/`aspect_ratio`, попытки кадра) | `seedream-5-5` API целиком (асинхронная задача, разложение на слои) — нужен был только декомпозитору |
| OpenAI-совместимый клиент картинок (`/images/generations`, `/images/edits`, multipart) | Team/loop агента монолита, MCP, jobs, channels, serve |
| Fallback'и: бэкенды, цепочка моделей, fallback на generate-эндпоинт (Responses `image_generation`) | Пайплайн декомпозиции — он живёт в `@u2ai/decomposer` |
| ИИ-парсер payload/result (модель пишет скрипт-извлекатель, `node:vm`-песочница) | `correct_perspective` / `image-distort` / `image-skew` / `image-edge-snapping` — прямоугольная коррекция уже в декомпозиторе |
| Локальные операции: crop, trim, pad, fit, resize, split, compare, upscale/downscale | Команды монолита, кроме `ai image` (она станет мостом) |
| Альфа-канал и удаление фона (`mask`, `contour`, `flat`, `key`, native) | Виджеты монолита, `generate_svg`/`download_font`/`download_icons` |
| Система purpose (`decompose`/`isolate`/`upscale`/`generate` → выбор модели) | Задачи `src/channels/*` (там purpose — другое понятие: support/smm/community) |
| Роль `decorator` (орнаменты, ленты, разделители, рамки — CSS/SVG) | Модельные профили текстовых моделей — остаются в декомпозиторе/монолите |

**Карта источников монолита:**

| Файл монолита | Файл нового пакета | Что забираем |
|---|---|---|
| `src/shared/images.js` | `src/openai/images.js` + `src/image/sizing.js` | форматы, multipart, чтение payload'ов, вся лестница кадров |
| `src/shared/aspect-ratio.js` | `src/image/aspect.js` | пропорции как дроби, ближайшая пропорция, построение кадра |
| `src/shared/constants.js` (часть image) | `src/config/constants.js`, `src/model/profiles.js` | тиры, лимиты кадра, профили моделей |
| `src/shared/model-profiles.js` | `src/model/profiles.js`, `src/model/purpose.js` | профили, `PURPOSE_MODEL_MAP`, `resolvePurposeModel` |
| `src/openai/client.js` (ветка images) | `src/openai/client.js` | `images.generate/edit/vectorize`, ротация бэкендов, fit-to-frame |
| `src/openai/image-response-fallback.js` | `src/openai/parser.js` | ИИ-парсер payload/result, `node:vm`-песочница |
| `src/openai/image-diagnostics.js` | `src/openai/diagnostics.js` | архив сырого ответа и скрипта парсера |
| `src/shared/image-raster.js` | `src/image/raster.js`, `src/image/sharp.js`, `src/image/canvas.js` | sharp → canvas → ImageMagick, все локальные операции |
| `src/shared/image-magick.js` | `src/image/magick.js` | обёртка над бинарём ImageMagick |
| `src/shared/image-alpha.js` | `src/image/alpha.js` | альфа-пайплайн и снятие фона |
| `src/shared/image-tools.js` | `src/image/tools.js` | обработчики `generate/edit/vectorize` |
| `src/agent/tools.js` (image-инструменты) | `src/image/tools.js`, `src/commands/*` | `crop_image`, `split_image`, `compare_images` |
| `src/core/images.js` | `src/core/sink.js` | запись картинок на диск (частичные → финальные) |
| `src/commands/image.js` | `src/commands/generate.js`, `src/cli.js` | команда генерации/редактирования |
| `src/roles/image-processor.js` | `src/roles/processor.js` (+ `planner`, `corrector`) | промпт подготовки картинок |
| `src/roles/decorator.js` | `src/roles/decorator.js` | промпт декоративного слоя |

**Поверхность CLI `ai-image`:**

| Команда | Что делает |
|---|---|
| `ai-image generate "<prompt>"` | генерация (`/images/generations`, fallback — Responses `image_generation`) |
| `ai-image edit <file> "<prompt>"` | редактирование (`/images/edits`, fallback — генерация с референсами) |
| `ai-image vectorize <file>` | растр → SVG векторной моделью |
| `ai-image decorate "<описание>"` | декоративный слой: CSS-правило или SVG-файл |
| `ai-image crop <file>` | обрезка коробки или снятие padding (`--trim`) |
| `ai-image pad <file>` | расширение холста до кадра (`--width/--height`, прозрачность) |
| `ai-image fit <file>` | подгонка под размер (`contain`/`cover`/`fill`) |
| `ai-image resize <file>` | изменение размера с сохранением пропорций или по кадру |
| `ai-image trim <file>` | снятие однородных/прозрачных краёв |
| `ai-image split <file>` | нарезка на сетку `rows × cols` |
| `ai-image alpha <file>` | построение альфа-канала (`auto|mask|contour|flat|key|off`) |
| `ai-image background <file>` | удаление фона (алиас `alpha` с `--mode auto`) |
| `ai-image compare <a> <b>` | таблица сравнения и карта разницы |
| `ai-image info <file>` | формат, кадр, наличие альфы, вес |
| `ai-image purpose` | карта purpose и модель, разрешённая для текущих бэкендов |
| `ai-image process "<задача>"` | агентный прогон: planner → processor → corrector → learner |
| `ai-image config init\|show\|path` | конфиг |

**Соглашения:**

- Пользовательские тексты нового пакета — **английские**; сообщения валидатора
  конфига — **русские** (как в `@u2ai/decomposer` и в монолите).
- Портированные из монолита файлы помечаются header-тегом `@ai.hint legacy-0.2`;
  написанные для пакета — тега не имеют.
- Коммиты — `step-N`, без пуша.

---

## 1. Каркас пакета + зависимости

- [x] `package.json`: `@u2ai/images`, `bin: { "ai-image": "bin/ai-image.js" }`,
      `engines: { node: ">=26" }`, `type: "module"`, deps `sharp`, `canvas`,
      `@resvg/resvg-js`, scripts: `test` = `node --test --test-timeout=60000 "test/*.test.js"`,
      `lint` = `node --check` по всем файлам `src/`.
- [x] `index.js` — публичный API пакета (ре-экспорт `src/index.js`), `src/index.js` —
      barrel по всем модулям.
- [x] `bin/ai-image.{js,cmd,ps1,sh}` — обёртки под Windows/POSIX (формат как у
      `ai-decompose`).
- [x] `src/cli.js`: `parseArgv` на `node:util.parseArgs` — общие флаги
      (`-c/--config`, `-o/--out`, `-v/--verbose`, `--json`, `--dry-run`, `--help`,
      `--version`) и флаги команд (`--model`, `--image-model`, `--purpose`, `--size`,
      `--resolution`, `--format`, `--background`, `--count`, `--engine`, `--alpha-mode`).
- [x] `src/help.js` — справка по всем командам с примерами.
- [x] `src/cli/colors.js`, `src/cli/renderer.js` (TTY/плоский рендерер, события),
      `src/cli/compatibility.js` (проверка версии Node, коды выхода).
- [x] Переименовать пустой `src/stages/aligment.js` → `src/stages/alignment.js`
      (опечатка в скелете; файл пока пуст, истории нет).
- [x] Скелет каталогов, который уже есть, приводится к плану: `src/config/`,
      `src/openai/`, `src/image/`, `src/model/`, `src/roles/`, `src/stages/`,
      `src/agent/`, `src/core/`, `src/commands/`, `src/cli/`, `test/`, `examples/`.
- [x] `git remote add origin https://github.com/u2re-space/u2ai-images` (пуш не делаем).
- [x] Проверка: `node --check` по всем файлам; `--help`, `--version`, `--dry-run` → exit 0.

---

## 2. Система конфигурации (`~/.ai-image/*`)

Модули — по образцу `@u2ai/decomposer` (`src/config/*`), с собственным префиксом:

- [x] `constants.js` — `ENUMS` (`imageFormats`, `imageBackgrounds`, `imageSizes`,
      `resolutions`, `complexities`, `rasterEngines`, `alphaModes`, `purposes`,
      `transport`, `trimModes`), `ENV_PREFIX = 'AI_IMAGE_'`, KiB/MiB.
- [x] `defaults.js` — домен по умолчанию:
      `model`, `imageModel`, `parserModel`, `vectorModel`, `baseURL`, `apiKey`,
      `backends[]` и `imagesBackends[]` (у каждого — `baseURL`, `apiKey`/`env`,
      `prefix`, `vendor`, `supports: {responses, chat, images}`),
      `fallback: { enabled, models: { "<model>": [...] , "*": [...] } }`,
      `image: { size, complexity, format, background, resolution, outputDir, transport,
      div16, padToMin, sizeHint, alphaMode, paintBackground, alphaFeather,
      rasterEngine, maskModel, pngMaxBytes, vectorMaxColors, autoVectorize,
      parser: { enabled, model, archive, archiveDir } }`,
      `purpose: { models: { decompose: [...], isolate: [...], upscale: [...], generate: [...] } }`,
      `limits` (maxImageBytes, maxStdinBytes, timeoutMs, retries),
      `roles` (planner/processor/corrector/learner/decorator/vectorizer),
      `defaultConfigText()` — стартовый `config.json`.
- [x] `env.js` — `fromEnv()`: `AI_IMAGE_HOME`, `AI_IMAGE_CONFIG`, `AI_IMAGE_API_KEY`,
      `AI_IMAGE_BASE_URL`, `AI_IMAGE_MODEL`, `AI_IMAGE_IMAGE_MODEL`,
      `AI_IMAGE_PARSER_MODEL`, `AI_IMAGE_VECTOR_MODEL`, `AI_IMAGE_IMAGE_SIZE`,
      `AI_IMAGE_IMAGE_RESOLUTION`, `AI_IMAGE_IMAGE_FORMAT`, `AI_IMAGE_IMAGE_BACKGROUND`,
      `AI_IMAGE_PURPOSE`, `AI_IMAGE_ALPHA_MODE`, `AI_IMAGE_RASTER_ENGINE`,
      `AI_IMAGE_MAGICK_PATH`, `AI_IMAGE_OUTPUT_DIR`, `AI_IMAGE_BACKENDS`,
      `AI_IMAGE_IMAGES_BACKENDS`, `AI_IMAGE_RETRIES`, `AI_IMAGE_TIMEOUT_MS`;
      совместимость с `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_MODEL`, `AI_IMAGE_MODEL`.
- [x] `merge.js` — `deepMerge`, `isRecord`, `getPath`, `setPath`.
- [x] `parser.js` — `readConfigFile` (BOM, ≤256 KiB, строгий JSON, отсев неизвестных
      разделов), `writeConfigFile`, плейсхолдеры `{{env:NAME}}`/`{{file:path}}`/`{{fs:path}}`.
- [x] `paths.js` — `defaultHome()` = `AI_IMAGE_HOME` или `~/.ai-image`; подкаталоги
      `config.json`, `prompts/`, `notes/`, `diagnostics/`.
- [x] `validate.js` — `validateConfig()`: enums, бэкенды (URL/ключ/`supports`),
      `image.*`, `purpose.models`, `fallback.models`, `limits`, `roles`;
      сообщения — по точному пути поля, на русском («некорректный JSON»,
      «неизвестный раздел»).
- [x] `index.js` — `loadConfig()`: defaults < `config.json` < `--config` < env < флаги
      → плейсхолдеры → primary-backend → валидация; `ensureConfigFile()`, `redactConfig()`.
- [x] `config init` создаёт `~/.ai-image/config.json` из `defaultConfigText()` и
      каталоги `prompts/`, `notes/`, `diagnostics/`.

> **Имена переменных.** `AI_IMAGE_MODEL` сохраняет смысл монолита — это модель
> картинок; текстовая модель берётся из `AI_IMAGE_TEXT_MODEL` (или `AI_MODEL`,
> `OPENAI_MODEL`). Явное имя `AI_IMAGE_IMAGE_MODEL` важнее, когда заданы обе.

---

## 3. Модельные профили и система purpose

- [ ] `src/model/profiles.js` — порт image-части `src/shared/model-profiles.js`:
      `IMAGE_MODEL_PROFILES` (gpt-image 2.5/2.6, riverflow, recraft и общий
      `DEFAULT_PROFILE`), поля профиля: `minPixels`, `maxPixels`, `maxEdge`,
      `maxRatio`, `div16Padding`, `padToMinPixels`, `resolutionTiers`,
      `customSizes`, `keepProSuffix`, `omitSizeOnReject`, `routeEditsThroughGeneration`,
      `complexity`, `paintsFakeTransparency`, `sizeHints`.
- [ ] `src/model/profiles.js` — `imageModelProfile(model)`, `imageModelFamily(model)`,
      `MAX_IMAGE_PIXELS/EDGE/RATIO`, `MIN_IMAGE_PIXELS`.
- [ ] `src/model/fallback.js` — `MODEL_FALLBACKS` (карта «модель → запасная»), рядом
      с `src/openai/fallback.js` из декомпозитора: `fallbackChain`, `withModelFallback`,
      `fallbackModels(config, model)`.
- [ ] `src/model/purpose.js` — **система purpose**:
      - `PURPOSE_NAMES = ['decompose', 'isolate', 'upscale', 'generate']`;
      - `PURPOSE_MODEL_MAP` — встроенный порядок моделей на purpose (в монолите
        `decompose`/`isolate`/`upscale`/`generate`);
      - `resolvePurposeModel(config, purpose)` — возвращает первую модель, чей
        провайдер есть среди `backends`/`imagesBackends`; явно заданный
        `config.imageModel` всегда побеждает (это выбор пользователя);
      - перекрытие пользователем: `config.purpose.models.<purpose>` полностью
        заменяет встроенный список для этого purpose;
      - пустой purpose → `null` (остаётся `config.imageModel`).
- [ ] **Отличие от монолита:** из встроенной карты purpose убраны модели
      `seedream-5-5` — их асинхронный маршрут (`data[0].task_id`, разложение на
      слои) в этот пакет не портируется. Любую другую модель можно вернуть через
      `purpose.models` в конфиге: purpose — это про *выбор модели*, а не про API.
- [ ] `ai-image purpose` печатает карту и, для каждого purpose, модель,
      разрешённую текущими бэкендами (или пометку «нет подходящего провайдера»).

---

## 4. Продвинутая система размеров

Порядок: сначала чистые функции (шаг 4), потом клиент (шаг 5) и локальный слой (шаг 7),
которые их используют.

- [ ] `src/image/aspect.js` — порт `src/shared/aspect-ratio.js`: `parseAspectToken`,
      `aspectOf`, `aspectFrame`, `ceilAspect`, `nearestAspect`, `rationalAspect`,
      константы `STANDARD_RATIOS`, `RATIO_MAX_TERM`, `RATIO_CEIL_EPSILON`, `RATIO_WORDS`.
- [ ] `src/openai/images.js` — порт `src/shared/images.js` (форматы и payload):
      `normalizeImageFormat`, `imageFormatField`, `resolveImageFormat`,
      `supportsTransparentBackground`, `backgroundValue`, `acceptsResponseFormat`,
      `isVectorModel`, `isSvgRequest`, `normalizeVectorRatio`, `svgConversionModel`,
      `encodeMultipart` (с bracket-нотацией вложенных объектов), `imagePayloads`,
      `imageSources`, `pngHasAlphaChannel`, `readImageSize`, `sniffImage`,
      `withSizeHint`, `generationBody`.
- [ ] `src/image/sizing.js` — **лестница кадров**:
      `parseImageSize`, `getOrientation`, `getAspectDifference`,
      `supportedAspectRatios`, `aspectRatioToken`, `aspectImageSize`,
      `inferResolution`, `tierFromToken`, `presetImageSize`, `fromMinimalSize`,
      `computeSize`, `normalizeImageSize`, `makePad16Size`, `imageRequestSize`,
      `imageSizeFields`, `sameAspectImageSize`, `isImageSizeError`,
      `nearestRiverflowRatio`, `imageSizeAttempts`, `needsDiv16Padding`,
      `needsMinPixelsPadding`, `paddedSizeToMinPixels`,
      `paddedSizeToMinPixelsByResolution`.
- [ ] Семантика, которую нельзя потерять при порте:
      - тир (`512`/`1K`/`1.5K`/`2K`/`3K`/`4K`) задаёт бюджет пикселей, а `size` —
        только ориентацию и пропорцию;
      - `size` у tier-based шлюза уходит в поле `resolution`, `W×H` — в `size`,
        пропорция — в `aspect_ratio`; приоритет именно такой;
      - кадр всегда кратен 16 (`div16Padding`) и укладывается в `minPixels`/
        `maxPixels`/`maxEdge`/`maxRatio` профиля;
      - `padToMin` — холст растёт вправо и вниз, объект остаётся в своём масштабе
        в левом верхнем углу, padding срезается с ответа;
      - `imageSizeAttempts` — порядок попыток: точный кадр → допустимый кадр той же
        пропорции → ближайший пресет → (для «капризных» шлюзов) запрос без размера;
        повтор делается только на `isImageSizeError`;
      - `withSizeHint` дублирует требование кадра в текст только для семей,
        которые гарантированно выбрасывают поля размера (`sizeHint: auto|always|never`).
- [ ] Тесты: `test/sizing.test.js` — тиры, пропорции, 16-пиксельная сетка,
      лимиты профиля, порядок попыток, разбор формы ответа (по одному тесту на
      каждое правило выше).

---

## 5. OpenAI-совместимый клиент: бэкенды, fallback'и, generate-endpoint fallback

Каркас openai-слоя берётся из `@u2ai/decomposer` (`src/openai/{http,errors,sse,stream,chat,responses,client,fallback}.js`)
и дорабатывается под картинки.

- [ ] `src/openai/client.js` — ротация бэкендов:
      - пул `imagesBackends` для картинок, `backends` для текста;
      - перебор при 4xx/5xx с backoff (`limits.retries`, `retryDelayMs`);
      - липкие каналы `client.channels('images', model)` — тот же приём, что в
        декомпозиторе: хост, создавший задачу, и опрашивает её сам;
      - `client.backends({ kind, model })` — для диагностики и `--dry-run`.
- [ ] `src/openai/client.js` — **fallback на generate-эндпоинт**:
      1. основной маршрут — `POST /images/generations` (и `/images/edits` для
         редактирования);
      2. если хост не знает маршрута (404/405, «not found in this api»,
         «does not support images») — тот же запрос уходит в **Responses API** с
         инструментом `image_generation` (`tool_choice: { type: 'image_generation' }`),
         а картинка читается из потока (partial → final);
      3. если и `/responses` нет — остаётся `/chat/completions` (текстовый транспорт),
         и картинки он не даёт: это честная ошибка с указанием, что делать;
      4. цепочка `fallback.models.<model>` (плюс `fallback.models.*`) — следующая
         модель пробуется, когда хост её не знает.
- [ ] `src/openai/client.js` — `images.generate({ model, prompt, size, complexity, n,
      format, background, references, resolution, signal })`:
      - тело — `generationBody` из шага 4;
      - `imageSizeAttempts` — повтор с другим кадром только на ошибке размера;
      - ответ читается `imagePayloads`/`imageSources`, при неудаче — ИИ-парсер
        из шага 6;
      - результат подгоняется под запрошенный кадр (`fitPayloadsToFrame`), кроме
        векторного ответа (SVG не ресемплится).
- [ ] `src/openai/client.js` — `images.edit({ model, prompt, files, size, format,
      background, resolution, signal })`:
      - multipart через `encodeMultipart` (`svg[model]` — bracket-нотация);
      - `padToMin`/`div16` — вход подготавливается локально (шаг 7), padding срезается
        с ответа;
      - семейства, у которых правка идёт через генерацию
        (`routeEditsThroughGeneration`), переключаются на `images.generate` с
        референсами в data-URI;
      - если в запросе нет кадра — он берётся из кадра исходника (чтобы правка
        не превратилась в квадрат по умолчанию).
- [ ] `src/openai/client.js` — `images.vectorize({ model, prompt, image })`:
      исходник идёт полем `image` в `/images/edits` (модель работает по пикселям),
      формат — `svg`.
- [ ] `src/openai/client.js` — `responses.create` с `tool_choice: image_generation`
      как запасной путь шага 2; картинки собираются из `image_generation_call`
      (partial и final).
- [ ] `src/openai/responses.js` — тело с `tools: [{ type: 'image_generation', ... }]`,
      разбор ответа с картинками (`outputText`, `imagePart`, `partial`).
- [ ] `src/openai/fallback.js` — `fallbackModels`, `withModelFallback` (порядок:
      модель из запроса → `fallback.models.<model>` → `fallback.models.*`).
- [ ] Тесты: `test/client.test.js` — mock-хосты: успех на `/images/generations`,
      404 на маршруте → уход в Responses, отказ модели → следующая модель, ошибка
      размера → вторая попытка с другим кадром, multipart-тело правки.

---

## 6. ИИ-парсер payload/result + диагностика сырого ответа

Это второй шанс вытащить картинку из ответа нестандартной формы: встроенные
читатели знают `data[].b64_json`, `data[].url` и `b64_json`/`url` в массиве.

- [ ] `src/openai/parser.js` — порт `src/openai/image-response-fallback.js`:
      - `describeShape(value)` — компактный эскиз ответа (ключи, типы, счётчики,
        длинные строки свёрнуты в `<string N chars: head…>`);
      - `parserPrompt(shape, meta)` — промпт модели: «напиши тело одной async-функции,
        которая вытащит полезную нагрузку из этого ответа»;
      - `extractScript(text)` — первый блок ```` ```js ```` или весь текст;
      - `toSource(item)` — нормализация того, что вернул скрипт (base64, data-URI,
        http(s)-URL, `Uint8Array`, `ArrayBuffer`, объект с `b64_json`/`url`/…);
      - `runParserScript(script, { response, root, signal })` — исполнение в
        `node:vm`: нет `require`/`process`/`fs`/`setTimeout`, наружу только
        `fetchBytes` (http/https, потолок 64 MiB), `decodeBase64`, `encodeBase64`,
        `imageDataUrl`, `sniff`, `write` (только внутрь рабочего каталога), `log`;
        потолок 60 с, не больше 32 payload'ов;
      - `parseImageResponseWithAI({ result, route, model, host, taskId, invoke,
        parserModel, root, signal, onWarn, onArchive, archive })` — архивирует сырой
        ответ, спрашивает модель, запускает скрипт, архивирует сам скрипт,
        возвращает список источников или `null`.
- [ ] `src/openai/parser.js` — `makeParserInvoke(client)`: единственный способ узнать
      текст — один нестриминговый вызов Responses; клиенту достаточно
      `responses.create`.
- [ ] Модель-парсер: `image.parser.model` (или `image.parserModel`), флаг
      `image.parser.enabled` (по умолчанию `true`), `image.parser.archive`
      (по умолчанию `true`).
- [ ] `src/openai/diagnostics.js` — порт `src/openai/image-diagnostics.js`:
      `saveImageResponse(result, { route, model, host, taskId })` и
      `saveImageParserScript(script, { route, notes })` — пишутся в
      `~/.ai-image/diagnostics/` (или в `image.parser.archiveDir`), имя —
      с меткой времени; путь возвращается в лог и в `--json`-ответ.
- [ ] Тесты: `test/parser.test.js` — эскиз формы, извлечение скрипта из ответа
      модели, нормализация всех форм payload'а, запуск скрипта в песочнице
      (в том числе отказ писать за пределы каталога), архивирование.

---

## 7. Локальный image-слой: sharp → canvas → ImageMagick

Порядок движков: `sharp` → `node-canvas` → ImageMagick (`image.rasterEngine: auto|sharp|canvas|magick`).

- [ ] `src/image/sharp.js` — адаптер над `sharp`: декод RGBA, кадрирование, изменение
      размера, вставка (композит), альфа-маска, trim, encode PNG/JPEG/WebP.
- [ ] `src/image/canvas.js` — адаптер над `node-canvas`: то же самое, когда `sharp`
      недоступен (в частности — подписи на таблице сравнения).
- [ ] `src/image/raster.js` — порт `src/shared/image-raster.js` (без таблицы из
      монолита она нужна, но без строителя сравнительной карты он не нужен — он
      остаётся в `compare` шага 9):
      `rasterEngine`, `rasterInfo`, `rasterIsOpaque`, `rasterAlphaShare`,
      `rasterAlphaSoftShare`, `decodeRgba`, `encodeRgba`, `rasterApplyAlphaMask`,
      `rasterColorKeyAlpha`, `rasterLocalAlphaMatte`, `rasterDetectFakeTransparency`,
      `rasterCrop`, `rasterPatch`, `rasterFitToSourceFrame`, `rasterTrim`,
      `rasterSplit`, `rasterPadImageBytes`, `rasterRemoveImagePadding`,
      `rasterScale`, `rasterizeSvg`.
- [ ] `src/image/magick.js` — порт `src/shared/image-magick.js`: `detectMagick`,
      `magickCrop`, `magickSplit`, `magickResize`, `magickConvert`, `magickIdentify`,
      `magickPadImageBytes`, `magickRemoveImagePadding`, `magickIsOpaque`,
      `magickRemoveFlatBackground`, `magickColorCount`, `magickPaletteStats`,
      `assessVectorSuitability`, `magickApplyAlphaMask`, `magickDetectFakeTransparency`,
      `magickAlphaShare`, `magickAlphaSoftShare`, `magickContourAlphaMask`,
      `magickSaturationAlphaMask`, `magickTrimImage`, `ensureTransparentBackground`.
- [ ] `src/image/sizing.js` (дополнительно) — `downscaleToMaxSide`, `fitToFrame`
      (contain/cover/fill), `upscaleToMinPixels` — локальные операции подгонки,
      отдельные от сетевой лестницы кадров шага 4.
- [ ] `src/image/downscale.js`, `src/image/upscale.js`, `src/image/padding.js`,
      `src/image/crop.js`, `src/image/trimmer.js` — тонкие обёртки над `raster.js`
      с единым контрактом `{ input, output, cwd, signal, engine }` и внятным
      сообщением, если ни один движок недоступен.
- [ ] Тесты: `test/raster.test.js` — круговое преобразование PNG (sharp → canvas →
      magick), кроп, trim, pad + обратное срезание padding, split, scale,
      определение формата/кадра/альфы; каждый движок — отдельный прогон там, где
      он установлен.

---

## 8. Альфа-канал и удаление фона

- [ ] `src/image/alpha.js` — порт `src/shared/image-alpha.js`:
      `hasRealAlpha` (настоящий альфа-канал, а не бахрома в несколько пикселей),
      `localKeyAlpha` (снятие фона по цвету с рамки), `localMatte` (локальный matte),
      `flatAlphaFallback` (заливка от углов), `isFakePlate` (похоже на «шахматку»),
      `judgeAlphaShares`, `clearedShare`, `softShare`, `frameFor`,
      `maskPassModel`, `askModel`, `applyGeneratedAlphaMask`.
- [ ] Порядок режимов (`image.alphaMode`):
      `auto` → нативная альфа → `mask` (модель рисует маску) → `contour` → `flat`
      (заливка от углов) → `key` (цвет с рамки);
      `mask`/`contour`/`flat`/`key` — принудительный режим; `off` — без альфы.
- [ ] `image.paintBackground` — перед построением маски фон заливается цветом
      объекта (убивает ореол); `image.alphaFeather` — сглаживание края маски.
- [ ] `image.maskModel` — модель, которой оплачивается техническая работа по альфе
      (`null` → семейство по умолчанию, `self` → та же, что нарисовала картинку).
- [ ] Прозрачность требует формата, который её хранит: JPEG альфу не несёт —
      команда предупреждает и предлагает PNG.
- [ ] Тесты: `test/alpha.test.js` — нативная альфа, ключ по цвету, заливка от углов,
      отказ от «фальшивой» альфы, режимы `auto`/`off`.

---

## 9. Локальные операции: crop, pad, fit, resize, trim, split, compare

- [ ] `src/image/tools.js` — порт `src/shared/image-tools.js` (обработчики
      `generate_image`, `edit_image`, `vectorize_image`) **и** локальных инструментов
      монолита (`crop_image`, `split_image`, `compare_images` из `src/agent/tools.js`):
      единый контракт `{ input, output, cwd, signal, engine }`, запись только внутрь
      рабочего каталога (`resolveInside`), лимит `limits.maxImageBytes`.
- [ ] `crop`:
      - коробка `x/y/width/height` — снимок кадра, координаты берутся из исходника;
      - `--trim` — снятие однородного или прозрачного padding по всем краям;
      - результат сообщает исходный и итоговый кадр и движок.
- [ ] `pad` — расширение холста до кадра с прозрачностью (или заданным цветом);
      исходник остаётся в левом верхнем углу, масштаб не меняется.
- [ ] `fit` — подгонка под размер: `contain` (вписывает целиком), `cover` (заполняет
      с обрезкой), `fill` (растягивает).
- [ ] `resize` — изменение размера: по кадру или с сохранением пропорций.
- [ ] `trim` — снятие краёв; `split` — нарезка на `rows × cols` с координатами
      каждой плитки.
- [ ] `compare` — таблица сравнения (`row`/`column`/`grid`), карта разницы
      (средняя разница и сходство), подписи через `node-canvas`.
- [ ] `src/image/vectorize.js` — растр → SVG: оценка пригодности
      (`assessVectorSuitability`, потолок `image.vectorMaxColors`), вызов векторной
      модели через `images.vectorize`, запись `.svg`; при недоступности модели —
      понятная ошибка, а не молчаливый PNG.
- [ ] `src/core/sink.js` — порт `src/core/images.js`: `createImageSink` — запись
      картинок (частичные и финальные) по одному файлу на результат, суффикс при
      нескольких, очередь записей (поздняя частичная картинка не затирает финальную).
- [ ] Тесты: `test/tools.test.js` — кроп, trim, pad, fit (три режима), resize,
      split, compare, запись через sink.

---

## 10. Генерация и редактирование (команды)

- [ ] `src/commands/generate.js` — `ai-image generate`:
      - промпт из аргумента или stdin (`limits.maxStdinBytes`);
      - `--purpose` выбирает модель через `resolvePurposeModel`;
      - `--size`/`--resolution`/`--format`/`--background`/`--count` → конфиг и
        лестница кадров шага 4;
      - результат пишется через `sink`, в `--json` — список файлов;
      - при `--background transparent` и непрозрачном ответе запускается
        альфа-пайплайн шага 8 (если модель не умеет прозрачность сама).
- [ ] `src/commands/edit.js` — `ai-image edit`:
      - исходник читается и проверяется по формату и весу;
      - модель без `padToMin` получает исходник в своём масштабе, а ответ
        приводится к кадру исходника;
      - `--reference` — дополнительные референсы (до 10 для vendor-моделей).
- [ ] `src/commands/decorate.js` — `ai-image decorate`: слой декоративных элементов
      (орнаменты, ленты, разделители, рамки, паттерны, бейджи) — либо готовый
      SVG-файл, либо CSS-правило; выбор техники — по форме (геометрия/градиент/маска/
      движение → CSS, сложный контур или самодостаточная картинка → SVG).
- [ ] `src/commands/info.js` — `ai-image info`: формат, кадр, альфа, вес, путь
      к файлу, разрешённый purpose для этой картинки.
- [ ] `src/commands/config.js` — `ai-image config init|show|path` (show — с
      редактированием секретов: ключи маскируются).
- [ ] Все команды: `--json` (машиночитаемый ответ), `--dry-run` (план без
      сетевых вызовов), коды выхода: 0 — успех, 1 — ошибка, 2 — неверные аргументы.

---

## 11. Агентный слой: роли и стадии

Роль `image-processor` монолита («подготовь картинки и визуальные ассеты до
начала реализации») разворачивается в прогон из нескольких ролей, каждая из
которых делает одну работу.

- [ ] `src/roles/planner.js` — **планировщик стратегии**: по задаче и референсам
      выбирает purpose, размер, режим фона/альфы, нужны ли кроп и padding, нужен
      ли вектор. Ответ — строгий JSON: `{ purpose, size, resolution, format,
      background, alphaMode, crop, pad, vectorize, rationale }`.
- [ ] `src/roles/processor.js` — **порядок роли `image-processor`**: готовит
      запрошенные картинки, фрагменты и визуальные ассеты; правила из монолита
      сохраняются:
      - не масштабировать и не растягивать исходник; если нужен bigger-холст —
        расширять вправо и вниз, не меняя масштаб и положение;
      - обрезка padding'а — это `crop --trim`, а не отдельный инструмент;
      - SVG — текстовый файл: правится как текст, а не перерисовывается моделью;
      - готовый SVG писать в `assets/decor/`, правила CSS — в `styles/decor/`;
      - честно сообщать, что операция недоступна, а не «файл существует».
      Ответ — JSON: `{ summary, assets[{path, format, use}], typography[], notes[] }`.
- [ ] `src/roles/corrector.js` — **корректор**: проверяет результат (кадр против
      запрошенного, альфа против намерения, артефакты) и предлагает/делает
      повторную попытку: другой кадр, другой режим альфы, другая модель.
- [ ] `src/roles/learner.js` — **накопитель опыта**: читает прошлые прогоны
      (`~/.ai-image/notes/*.json`), суммирует, какой purpose/размер/режим альфы
      давал результат, и предлагает стратегию следующего прогона. Файл прогона:
      `{ date, task, purpose, size, model, alphaMode, outcome, notes }`.
- [ ] `src/roles/vectorizer.js` — **векторизатор**: готовит растр к векторизации
      (снимает шум, оценивает палитру), просит векторную модель, проверяет, что
      документ открывается, и пишет `.svg`.
- [ ] `src/roles/decorator.js` — **декоратор**: порт `src/roles/decorator.js`
      монолита (CSS или SVG на элемент), но в самостоятельной роли: на вход —
      описание элемента и опорный кроп, на выход — файл и точный сниппет.
- [ ] Стадии (`src/stages/`):
      - `crop.js` — приведение исходника к рабочему виду (кроп/trim по решению
        планировщика);
      - `padding.js` — подготовка холста под модель (div16, `padToMin`) и обратное
        срезание padding'а с ответа;
      - `process.js` — основной вызов модели (генерация/правка/векторизация);
      - `correction.js` — коррекция результата (кадр, альфа, повтор);
      - `alignment.js` — приведение ответа к кадру исходника или запрошенному
        кадру (`fitPayloadsToFrame`).
- [ ] `src/agent/pipeline.js` — оркестратор стадий: состояние, порядок, передача
      артефактов, сборка отчёта (`~/.ai-image/notes/<дата>.json` + `--json`).
- [ ] `src/agent/tools.js` — инструменты агента: `generate_image`, `edit_image`,
      `crop_image`, `pad_image`, `fit_image`, `alpha_image`, `vectorize_image`,
      `compare_images`, `view_image` (описание через vision-модель — как
      `describeImage` в монолите).
- [ ] `src/agent/schemas.js` — схемы строгих ответов ролей (то же, что
      `text.format` в монолите).
- [ ] Тесты: `test/roles.test.js` — планер строит корректную стратегию,
      корректор находит несовпадение кадра, learner читает прошлые записи,
      декоратор пишет и SVG, и CSS.

---

## 12. CLI `ai-image` и рендерер

- [ ] `src/cli.js` — разбор команды (`generate|edit|vectorize|decorate|crop|pad|
      fit|resize|trim|split|alpha|background|compare|info|purpose|process|config`),
      общие флаги, `--dry-run`, `--json`, маршрутизация в `src/commands/*`.
- [ ] `src/cli/renderer.js` — события и живой вывод: «модель · кадр · формат →
      каталог», прогресс по частям, итоговый список файлов; в не-TTY — плоский
      текст без цвета.
- [ ] `src/cli/colors.js` — цвета с отключением через `NO_COLOR`/`AI_IMAGE_NO_COLOR`.
- [ ] `src/cli/compatibility.js` — проверка Node >= 26, маппинг ошибок в коды выхода.
- [ ] `src/help.js` — справка: команды, примеры (генерация, правка, кроп, подгонка,
      снятие фона, purpose).
- [ ] Проверка вручную: `ai-image --help`, `ai-image purpose`, `ai-image info file.png`,
      `ai-image crop file.png --trim --out out.png`, `ai-image generate "…" --dry-run`.

---

## 13. Тесты / проверка

- [ ] `npm test` = `node --test --test-timeout=60000 "test/*.test.js"` — без сети:
      mock-хосты через локальный `http.createServer` или подставной клиент.
- [ ] Состав тестов:
      | Файл | Что закрывает |
      |---|---|
      | `test/config.test.js` | загрузка конфига, env-оверрайды, плейсхолдеры, отказ на неизвестном разделе, `~/.ai-image/*` |
      | `test/sizing.test.js` | лестница кадров, тиры, пропорции, лимиты, попытки |
      | `test/purpose.test.js` | карта purpose, разрешение модели по бэкендам, приоритет `imageModel` |
      | `test/client.test.js` | `/images/generations`, `/images/edits`, fallback на Responses, цепочка моделей, ошибка размера |
      | `test/parser.test.js` | ИИ-парсер payload/result, песочница `node:vm`, архив |
      | `test/raster.test.js` | sharp/canvas/magick: кроп, trim, pad, split, scale |
      | `test/alpha.test.js` | альфа-канал и снятие фона |
      | `test/tools.test.js` | crop/pad/fit/resize/trim/split/compare, sink |
      | `test/roles.test.js` | planner/processor/corrector/learner/decorator |
      | `test/cli.test.js` | разбор аргументов, `--dry-run`, `--json`, коды выхода |
- [ ] Сетевые тесты — за флагом `AI_IMAGE_NETWORK_TESTS=1`, по умолчанию выключены.
- [ ] Отдельный прогон `node --check` по всем файлам `src/` и `bin/`.

---

## 14. Затухание в монолите и релиз

- [ ] Монолит: команда `ai image` (`src/commands/image.js`) становится мостом в
      `ai-image` (как `ai decompose` → `ai-decompose`): ищет бинарь
      (`AI_IMAGE_BIN` → `ai-image` в `PATH`), передаёт аргументы и код выхода.
- [ ] Монолит: агентские инструменты (`generate_image`, `edit_image`, `crop_image`,
      `split_image`, `compare_images`, `vectorize_image`) на первом этапе остаются
      в монолите; следующий шаг (вне этого плана) — перевести их на вызов
      пакета как библиотеки.
- [ ] Монолит: конфиг `image.*` остаётся рабочим и после ухода команды; при
      расхождении полей — новый пакет читает свой `~/.ai-image/config.json`, а
      монолит — свой.
- [ ] Чек-лист релиза 0.3.xx:
      - `package.json` нового пакета опубликован как `@u2ai/images`;
      - README пакета: установка, команды, примеры, конфиг, совместимость
        провайдеров, ограничения (вектор — через векторную модель; SVG-векторизация
        требует провайдера);
      - `planned.md` переведён в статус «шаги 1–14 завершены»;
      - тесты пакета и тесты монолита зелёные.

---

## Порядок работы и зависимости шагов

```
1 каркас ──► 2 конфиг ──► 3 профили+purpose ──► 4 размеры ──► 5 клиент
                                   │                    │            │
                                   │                    │            ├─► 6 ИИ-парсер
                                   │                    │            │
                                   ▼                    ▼            ▼
                              9 локальные ops ◄── 7 image-слой ── 8 альфа
                                   │
                                   ├──► 10 генерация/редактирование ──► 12 CLI
                                   └──► 11 роли и стадии ─────────────► 12 CLI
                                                            │
                                                            ▼
                                                      13 тесты ──► 14 затухание
```

Порядок шагов 7 и 9 можно поменять местами: локальные операции нужны клиенту
(подготовка входа) и стадиям (padding/crop).

## Риски и заметки

- **`src/image/raster.js` (~1300 строк в монолите)** — самый большой перенос;
  портировать по движкам, каждый шаг фиксировать тестом кругового преобразования
  (sharp → canvas → magick дают одну и ту же картинку с точностью до ±1 по
  цвету канала).
- **Лестница кадров** — самая хрупкая часть: правила в монолите частично
  закомментированы, часть поведения — эвристика. Портируем как есть, но каждое
  правило закрываем тестом; расхождение с монолитом фиксируем в README как
  «известное отличие».
- **Fallback на Responses** — хост может иметь `/responses`, но не иметь
  `image_generation`; тогда ошибка должна называть конкретную причину, а не
  «картинка не получена».
- **`node:vm` в ИИ-парсере** — это ограничитель, а не граница безопасности;
  sandbox остаётся узким (никаких `require`/`process`/`fs`), а запись —
  только внутрь рабочего каталога.
- **ImageMagick** — бинарь может отсутствовать; каждая команда должна честно
  сказать, каких движков не хватает, а не падать с `ENOENT`.
- **Файлы `src/config/*.js` и `~/.ai-image/config.json`** могут быть открыты в
  редакторе — после изменений на диске делать reload, чтобы не затереть
  актуальное содержимое.
- **Пакеты не пушатся** без явной команды пользователя.
