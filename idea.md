И теперь нужно портировать функции `image-processor` (`images`, `decorator`) уже в `u2ai-images` (`submodules/u2ai-images`).
- Его `CLI` это `ai-image`.
- Его конфиг это `~/.ai-image`
- Репозиторий github - `https://github.com/u2re-space/u2ai-images`

Фичи для портирования в новый модуль и CLI...
- `seedream-5-5` API из оригинала портировать не нужно (он был нужен из-за layer decomposition).
- достаточно реализации (портирования) поддержки парсера payload/result при помощи ИИ
- нужна реализация поддержки fallback'ов, backend'ов, openai-compatible API, generate endpoint fallback.
- нужно также портировать продвинутую систему размеров.
- и портирования функций image-magick, sharp, canvas...
  - вроде crop, padding, подгонки под размер
  - функций удаления фонов, альфа-каналов
  - реализация и портирования системы purpose

Ещё для `submodules/u2ai-images` реализовать (портировать) нужно:
- Поддержка любого `size` через padding (aligment), сохранение пропорций и размера содержимого при обработки при помощи ИИ, и обрезки этого padding. 
- Поддержка альтернативного пути решения проблемы с `size` через downscale с сохранением aspect-ratio (пропорций).
- Поддержку `purpose` для ИИ запросов, таких как `remove_background` (`isolate_object`), `upscale`, `edit`, `generate`, `unrotate` (`rectify`).
