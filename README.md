# Claude Counter

Session and weekly Claude usage bars, with quota percentages, reset countdowns and readable tooltips. A personal build of [she-llac/claude-counter](https://github.com/she-llac/claude-counter), incorporating #60, #15 and adapted #57 improvements.

## Personal build 2.1.4

The token summary and estimated cache timer have been retired. Their complete implementation is preserved on the [archive branch](https://github.com/lumigoh/claude-counter/tree/archive/token-summary-v2.1.3); see the [archive notes](docs/token-summary-archive.md). Current builds do not load the tokenizer or fetch conversation trees for counting.

## Features

- Session (5-hour) and weekly (7-day) quota bars from Claude's native usage responses and live limits.
- Support for both legacy SSE and the unified interface's Connect/protobuf streams.
- Local usage persistence, expired-window handling, and distinct unknown/zero states.
- Opaque tooltips with usage, remaining quota, local reset time and recent session readings.
- Refreshes on focus/navigation and periodically while visible, with cooldowns for empty answers and backoff for failures.

Usage currently sits above the composer. A reported overlap with the final lines of chat is being considered separately; [proposed layout fixes](docs/composer-layout-options.md) describe the options.

## Installation

**Chrome / Edge / Chromium 111 or newer**

1. Download this fork using **Code → Download ZIP** and unzip it (or clone the repository).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.

To update, replace the local files, reload the extension and reload Claude. This personal build has not been verified in Firefox.

**Userscript — Tampermonkey / Violentmonkey**

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). Enable your browser's userscript permission if requested by your manager.
2. [Install Claude Counter](https://raw.githubusercontent.com/lumigoh/claude-counter/main/userscript/claude-counter.user.js) and confirm **Install**.
3. Reload `claude.ai`. Use either the extension or the userscript to avoid duplicate counters.

The standalone userscript contains the shared usage-tracking code and needs no external `@require`. It stores snapshots in namespaced `claude.ai` localStorage; clearing site data removes them. Updates come from this fork through your manager. Use the install link once to switch an older installation to this update source.

## Development

Run `npm test` (Node 22+, no dependencies to install). Rebuild the userscript after shared source changes with `npm run build:userscript`; `npm run check:userscript` verifies it matches the sources. See [CHANGELOG.md](CHANGELOG.md) for historical changes.

## Privacy

Usage data stays local; there is no telemetry. The extension uses browser-local storage and the userscript uses site-local storage. Usage requests go to `claude.ai` using your current signed-in organisation.

## License

MIT. Original project and prior fork contributions retain their notices in [LICENSE](LICENSE).
