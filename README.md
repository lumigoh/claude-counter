# Claude Counter

Session and weekly Claude usage bars, with quota percentages, reset countdowns and readable tooltips. A personal build of [she-llac/claude-counter](https://github.com/she-llac/claude-counter), incorporating #60, #15 and adapted #57 improvements.

## Personal build 2.1.6

The approximate token counter is available again as an **opt-in code flag**, displayed on the left of the existing quota row. It defaults to disabled. The old cache timer, separate summary and 200k reference bar remain archived on the [archive branch](https://github.com/lumigoh/claude-counter/tree/archive/token-summary-v2.1.3).

To enable it, set `showTokenCounter: true` in [src/content/config.js](src/content/config.js), then reload the extension and Claude. For the userscript, edit the same flag near the top of the installed script in your manager and save/reload. There is no settings button or stored UI preference. Userscript updates may replace your local code edit, so reapply the flag after updating if needed.

The count estimates visible conversation history and can be inaccurate after compaction; it is not Claude's active context usage. It refreshes on opening/switching chats and after replies; click the count to recount. Disabled builds do not initialize the tokenizer or fetch conversations for counting. The extension loads the vendored tokenizer on demand; the userscript bundles it inside a function that runs only when enabled.

## Features

- Session (5-hour) and weekly (7-day) quota bars from Claude's native usage responses and live limits.
- Support for both legacy SSE and the unified interface's Connect/protobuf streams.
- Local usage persistence, expired-window handling, and distinct unknown/zero states.
- Opaque tooltips with usage, remaining quota, local reset time and recent session readings.
- Refreshes on focus/navigation and periodically while visible, with cooldowns for empty answers and backoff for failures.

Usage sits above the composer, with a soft 40px fade above the row in ongoing chats. The fade follows the composer, matches the page backdrop and lets clicks and scrolling pass through. Bars wait for the visible input card during loading and recover automatically when Claude replaces or hydrates it. A reported overlap with the final lines of chat is being considered separately; [proposed layout fixes](docs/composer-layout-options.md) describe the options.

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
