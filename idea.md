И теперь нужно портировать функции `image-processor` уже в `u2ai-images` (`submodules/u2ai-images`).
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
