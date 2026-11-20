# Changelog

All notable changes to the Claude Counter extension will be documented in this file.

## [2.1.8] - 2026-11-19

Audit fixes, tracked in #1. Each item lists its issue.

### Polling and startup follow-up

- **Bounded usage waits.** A stalled snapshot gives way after 3 seconds. The direct usage fallback aborts after 5 seconds, including body reading, so the active org can retry after backoff. A failed bridge request only starts a fallback while its org is still current and the tab is visible.
- **Trusted org precedence.** Startup resumes and candidate events check the current cookie or page setting before keeping or choosing an org.
- **Backoff.** Live readings preserve the failure and free-plan retry deadlines.
- **Expiry.** When a quota window expires in a hidden tab, showing the tab can poll immediately even if the previous answer was recent. Backoff still applies.
- **Manual refresh.** A click waiting for a snapshot polls only if the tab is still visible when the wait ends.
- **Session history.** Equivalent reset timestamps share one tooltip history, even when their formatting differs.

### Fixed
- **Organisation switching (#2).**
  - An organisation ID seen in a page request is now only a candidate. The active organisation comes from trusted sources: the `lastActiveOrg` cookie, claude.ai's saved setting, or an org list that marks one org active.
  - Previously, a request touching a second org blanked the bars and refilled them when the first org reappeared.
  - The 1-second tick notices cookie changes, so genuine switches work without a reload. A switch restores the new org's snapshot and polls it immediately.
  - `claude_last_org_id` is written only when an org is accepted. Org-list entries are identified by `uuid`.
- **Live stream silenced (#2).**
  - Streams are labelled with their organisation and opening time instead of a global epoch counter, which had dropped open streams for good after any org change, including A→B→A.
  - The content script drops events from other organisations, and unlabelled events opened before a switch.
- **Composer fade on Claude Code (#7).** The fade above the bars is shown on `/code/<id>` session pages as well as `/chat/<id>`. Pages with no transcript are still excluded.
- **Optional token counter (#4).**
  - Same-chat `pushState`/`replaceState`/`popstate` events no longer cancel the count and refetch the conversation.
  - A replayed limits event, older than its stream, still updates the bars but no longer announces a finished reply.
- **Identifiers (#5).** Org IDs pass a permissive check (URL-safe, 8–128 characters, at least one digit) before use, and IDs are encoded in request URLs.
- **Userscript tokenizer (#6).** It now creates its global on pages that define an AMD loader or CommonJS-looking globals.

### Changed
- **Page observation (#3).** Page mutations now cost one composer scan per 150 ms while they continue, instead of one scan per mutation. The tick scans once instead of twice.
- **Per-org readings (#6).** Recent session readings are stored per organisation (`claude_session_history:<org>`). The old shared key is ignored.
- **No duplicate broadcast (#6).** Conversations fetched for the optional count are no longer broadcast a second time (`cc:conversation`).
- **Keyboard and screen readers (#6).**
  - Session and Weekly are keyboard buttons: Tab, then Enter or Space, refreshes.
  - Tooltips show on focus and are linked with `aria-describedby`, as is the token count's.
- **Spanish (#6).** Spanish pages get fully translated tooltips and token texts.
- **Tidying (#8).** Removed unused selectors, colours, styles and strings.
- **Docs.** Added [docs/architecture.md](docs/architecture.md).

### Post-audit fixes
After a primary audit and an independent review of this release (#10–#13), cross-checked with reproductions and mutation tests:
- **Organisation resolution (#10).**
  - Every start-up source is validated before it can decide. An invalid remembered org (2.1.7 stored route words) no longer blocks start-up without a cookie, and is overwritten.
  - Start-up order is cookie, page storage, org list `active`, remembered org, only org, first candidate. Page storage keys are checked separately.
  - Concurrent start-ups share one org list request, and a start-up from a candidate polls at once.
  - A no-cookie re-check discards a stale answer, and a candidate seen during the cooldown schedules one re-check when it ends.
  - An event labelled with the newly chosen org is kept during the 1-second tick lag.
- **Unlabelled streams (#11).**
  - Limits from a stream without an org label (cookie unreadable) are never applied or saved; they prompt an org-scoped poll. Previously another org's quota could be stored under the active one. Cost: without the cookie, bars update by poll after each reply, and the free plan gets no live values.
  - Unlabelled streams keep separate replay state.
  - Turn ends carry their stream's label; the token counter ignores other orgs' turn ends.
- **UI (#12).**
  - Tooltips open on keyboard focus only, so a touch tap no longer pins them open.
  - A stale session-history read can't overwrite newer readings.
  - Enter/Space ignore key repeat and modifier keys.
  - Nested `/…/chat/<id>` routes get the fade again, as in 2.1.7.
- **Tests (#13).**
  - Replay cut-off boundary tests added.
  - Vacuous or mutant-surviving tests hardened: F11, F17, O02, O07, O08, M29, S03, U58, U61, U62, I01.
  - New end-to-end bridge-to-brain test and a guard-mutant test (O22).
- **Wording.** "One scan per 150 ms while mutations continue" describes the observer change more precisely than "one scan after 150 ms".
- **Left as is and documented:**
  - The digit rule fails closed for digitless IDs.
  - An extra scan when our own row moves.
  - A switch poll skipped by the in-flight flag recovers on the next tick.
  - Both replay-heuristic edges.

### Targeted-review fixes
After an independent review of the post-audit changes (#14–#17), each fix aimed at the underlying mechanism, with a failing test first:
- **Session history (#14).** Loading is now explicit per org and window. A late read for one org can no longer be appended to, and saved under, another org's history. Readings that arrive while the saved history loads are queued instead of overwriting it.
- **Held Space (#14).** Holding Space on a quota button no longer scrolls the page. It refreshes once.
- **Start-up (#15).**
  - Start-up never blocks on `/api/organizations`: the list gets 2 s, then the remembered org is used and a late `active` answer corrects it.
  - A cookie that appears while waiting always wins.
  - A candidate seen while a re-check is in flight is re-checked later.
- **Snapshots (#15).**
  - A restored snapshot no longer counts as fresh. Each page load polls once to confirm it.
  - Start-up restores are shared, so the poll never lands before the snapshot shows.
- **No-cookie replies (#16).**
  - Each unlabelled reply gets a coalesced poll that starts after it. Previously, a reply within 5 s of a poll got none.
  - A labelled turn end before the first org is accepted is no longer dropped.
  - Unlabelled streams keep their replay state in their own bounded store, so they can't evict a labelled org's cursors.
- **Tests (#17).**
  - S03/S06 use a mutable clock.
  - O12 is split per guard half.
  - S05 covers repeated event IDs.
  - F06/O04 now state what they cover.

### Final-round fixes
A second independent review found that several targeted-review fixes added new timing paths. This round removes paths where possible and tests rules rather than single scenarios:
- **Start-up makes one org-list request (R1).**
  - Both start-up reads (list, remembered org) share one 2 s limit. A list that names the active org is used without waiting for the remembered one.
  - With nothing to choose, start-up keeps waiting on that one request until it answers, a candidate arrives, or the cookie names an org.
- **No late list correction (R2).** Once start-up has chosen, a slower list answer is ignored. Switches come only from the cookie or page setting, or from a candidate re-check. Previously an old answer could override a newer re-check and poll the wrong org.
- **Snapshots (R3).** A restore never waits for start-up. The accepting org's restore runs once, before its start-up poll.
- **Start-up poll (R4).** Skipped only when both windows already have live readings, so a reply carrying only the session window no longer leaves the weekly bar blank.
- **Re-checks (R5).** One "unchecked candidate" flag replaces the candidate comparisons, so a candidate seen during a re-check is never lost.
- **Backoff (R6).** Restoring an expired snapshot no longer shortens a failure backoff.
- **Tests.**
  - U69 is split per invalidation.
  - U70 counts writes.
  - S07b covers seen IDs.
  - S03/S06 move the clock before the response headers.
- **Known limits, unchanged.**
  - A backward clock step can drop one reply poll.
  - An org switch during start-up can add one extra token recount.
  - Without a cookie, a multi-org account whose list is slower than 2 s shows the remembered org until the cookie corrects it (superseded by D1 below).

### Simplification
A review of the final round found one high and four medium issues. Following the stopping rule, the design was simplified instead of patched (see *Design rules* in `docs/architecture.md`):
- **D1: no candidate re-checks.** After start-up, only the cookie or page setting switches the org. This fixes a stale re-check switching to the wrong org (high) and candidates being stranded or re-checked twice.
  - Cost: without a cookie, a multi-org user who switches org needs a reload or the cookie.
- **D2: one start-up decision.** Start-up runs once per page load with at most one org-list request and is never restarted, even after an inconclusive list.
- **D3: one poll gate.** Every `/usage` request waits for start-up and for the org's snapshot step, then checks hidden tab, request in flight, backoff and freshness in one place. Fixes:
  - a focus poll or a switch beating the snapshot;
  - a double start-up poll;
  - the expiry tick bypassing backoff.
- **D4: fresh means both windows are live.** This applies everywhere, including on showing a hidden tab.
- **D5: tooltip.** A new reset window hides the previous window's readings, and a reset time going R1→R2→R1 no longer saves the wrong history.
- **Tests.** Re-check tests were replaced by D1 tests. M02d and O32b now test the real rule. New: O37–O45, M06f, U72, U73. Every gate check was confirmed by a mutant that a test catches.

### Validation
- 202 automated tests pass (196 before the simplification, 183 before the final round, 170 before the targeted-review fixes, 151 before the post-audit fixes).
- Earlier post-audit validation: 170 automated tests passed.
- Earlier 2.1.8 validation: 151 automated tests passed. New tests cover:
  - incidental organisation requests, genuine switches, A→B→A, and stale polls and streams
  - observer coalescing
  - token refresh rules and replay detection
  - identifier checks
  - per-org history, keyboard/ARIA and Spanish
  - the AMD tokenizer
  - fade routes
- 28 browser checks pass in Chromium (re-run after the post-audit and targeted-review fixes), for both the unpacked extension and the userscript, against a simulated claude.ai page:
  - placement and late composer
  - an incidental request for another org, and a cookie switch
  - keyboard refresh and tooltips
  - the fade on `/chat`, `/code` and `/new`
  - token counter off and on
- Owner check of the pre-audit userscript in Firefox on real claude.ai: chat bars, the Claude Code fade and keyboard access via Shift+Tab (#9). Not verified: organisation switching on the real site, the extension in Firefox, and real-world performance. Open questions are listed in #1.

## [2.1.7] - 2026-11-15

### Fixed
- Late `/usage` polls can no longer overwrite windows updated after the poll began. Session and weekly freshness are tracked separately, including the direct-fetch fallback and same-millisecond races.
- Connect streams reject older unseen cursors and replays beyond the short duplicate cache. Cursor comparisons are numerical and scoped to an organisation epoch and quota window; real new windows and newer server corrections remain valid.
- Organisation changes invalidate pending polls, token counts and old stream scopes, and immediately clear the previous quota readings. Each organisation has its own storage key; ambiguous legacy alias snapshots are ignored, while single-owner legacy snapshots migrate safely. Delayed organisation discovery cannot overwrite a newer live selection.
- Saved snapshots remain a lower-priority display fallback, and expired windows retry promptly when an old poll arrives at rollover.
- Rebuilt the userscript. Validation: 122 automated tests pass; simulated Chromium checks verify a real pending-poll/live-stream race, a fresh downward correction, old/new stream cursor handling, and organisation-isolated persistence/restoration.

## [2.1.6] - 2026-11-15

### Added
- Optional approximate token count on the left of the existing quota row, with session/weekly usage on the right. Compact container-based styling keeps the count and quotas on one line at narrow widths.
- Code-only configuration in `src/content/config.js` and near the top of the generated userscript: `showTokenCounter: false` by default. There is no settings button and no stored UI preference.
- The tokenizer initializes and conversation requests run only when the code flag is enabled. The extension loads the vendored tokenizer on demand; the standalone userscript bundles it in a lazy initializer.
- Counts refresh when opening/switching chats, after Connect or legacy SSE replies, on branch navigation and by clicking the count. Delayed server persistence is retried with a bound; responses from an old chat or a disabled counter are ignored.
- The tooltip preserves the compaction accuracy caveat. The cache timer, separate summary and context reference bar remain archived.
- Validation: 102 automated tests pass, including default-off behavior, code opt-in, delayed reply persistence, late navigation/disable responses and token math. Simulated Chromium checks cover both code-flag modes, inline layout from 360–1280px, existing fade/hydration behavior and both tokenizer loader paths.

## [2.1.5] - 2026-11-15

### Added
- A soft 40px fade above the quota row in ongoing chats. It blends transcript text into the chat backdrop before the composer edge, leaving quota text and controls sharp.
- The fade is rendered outside the composer's clipping containers, follows scrolling/resizing/editor growth and theme changes, and does not intercept pointer input. It hides on non-chat pages or when the quota row is offscreen.
- Fixed initial-load placement: quota width follows the input card rather than a page-wide parent. Bars wait for a visible composer card, ignore loading placeholders/hidden previous editors, and reattach after hydration even when the input node stays the same. Attribute changes and periodic checks catch missing/hidden rows without requiring another chat navigation.
- Rebuilt the userscript with the same visual change. This changes the visual transition; transcript scroll clearance is unchanged.
- Validation: 88 automated tests pass, plus Chromium checks for fade bounds/theme/pointer passthrough and loading-to-hydrated composer transitions, including a constrained card inside a wide parent. Browser checks use simulated Claude pages.

## [2.1.4] - 2026-11-15

### Removed
- Retired the approximate token summary, reference bar and estimated cache timer from both builds. The complete prior implementation, tokenizer, license and feature tests remain on `archive/token-summary-v2.1.3`; see [archive notes](docs/token-summary-archive.md).
- Removed the tokenizer from extension loading and the generated userscript, along with token-counting modules and conversation-refresh work. Passive conversation response copying is no longer performed.
- The standalone userscript is now about 61 KB rather than 2.1 MB. Session/weekly tracking, Connect/SSE limits, persistence and refresh backoff remain active.

### Notes
- Added [proposed composer layout fixes](docs/composer-layout-options.md) for the reported transcript overlap. These options are not implemented in this removal release; removing the summary reduces the floating composer's height but does not establish that transcript clearance is correct.
- Validation: 82 active automated tests and Chromium smoke checks pass. The archive retains tests for the retired functionality.

## [2.1.3] - 2026-11-15

### Fixed
- Tooltips now use their own opaque background, border, readable text and bounded panel sizing instead of relying on Claude's CSS classes. They stay inside the viewport and dismiss on scrolling, resizing, clicking or Escape.
- Usage bars now occupy a normal-flow row above the input card, keeping them clear of composer menus and the bottom edge in ongoing chats. Narrow layouts wrap and hide inline reset text; full reset details stay in the tooltip.
- Token estimates have a 12px gap beside recognized titles or a 6px gap below discovered titles. A short title bar uses the summary above the composer instead of squeezing text into the title or content below it.
- Tooltips show the current percentage used/remaining, local reset time, marker meaning and labeled recent session readings. Missing and expired usage get their own concise messages. Token and cache tooltips now describe estimates without claiming an exact context limit or guaranteed cache savings.
- Recent session readings now start at the first observed value rather than an invented 0% baseline.
- Rebuilt the userscript with the same UI fixes. Validation: 137 automated tests pass, plus Chromium checks of opaque/viewport-bounded tooltips, bottom-pinned composer placement, narrow windows, Connect updates and reload persistence against simulated Claude pages.

## [2.1.2] - 2026-11-15

### Added
- Restored userscript installation with a direct install/update link to this fork.
- Rebuilt the userscript from the shared extension sources, including #60's Connect streams, #15's hidden-tab guard, and #57's responsive layout/refresh behavior. It wraps fetch at document-start and waits for DOM readiness before mounting the UI.
- Bundled the same tokenizer and its license notice; no external `@require` is needed. Usage snapshots persist in namespaced site-local storage without modifying the page's `chrome` object.
- Added `npm run build:userscript` and `npm run check:userscript` to keep the standalone artifact synchronized with source changes. `npm test` also checks the generated artifact.
- Validation: 135 automated tests pass; Chromium smoke checks verify document-start boot, token counting, Connect limits, persistence across reloads and narrow layout against simulated Claude responses.

## [2.1.1] - 2026-11-15

### Changed
- Adapted [upstream PR #57](https://github.com/she-llac/claude-counter/pull/57) by cikel87 onto the personal build containing #60 and #15.
- Usage bars sit outside the input card, beside the composer strip when space permits. On narrower layouts they hide reset text, then move to a separate wrapping line. DOM and resize observers repair placement as Claude moves its controls.
- Slim usage bars turn amber at 75% and red at 90%; labels follow English/Spanish page language. Reset timestamps remain available on percentage tooltips in compact mode.
- Useful `/usage` data refreshes every five visible minutes, on stale focus/visibility/navigation, and 20/60 seconds after a legacy response stream starts. Empty answers retain the hourly cooldown and failed requests retain exponential backoff.
- Fetch interception reads methods from `Request` objects and accepts top-level SSE limits. The existing early MAIN-world bridge, Connect stream support, unknown/expired states, token/cache fallback and hidden-tab UI guard are preserved.
- Extension version bumped to 2.1.1; the userscript remains unchanged.

### Validation
- 132 automated tests pass, including regressions for refresh/backoff interactions, responsive placement, warning levels and Request/SSE handling.
- Chromium smoke checks against a simulated composer at 1280, 900, 620 and 360 pixels, English/Spanish labels, resizing, relocated model selectors and missing-header fallback. These checks do not use a signed-in claude.ai account.

## [2.1.0] - 2026-10-24

### Added
- **New claude.ai interface (unified UI)**: replies in the new interface arrive on a Connect stream (`ConversationService/StreamTimeline`) instead of the old `/completion` stream. The usage limits (5-hour and 7-day windows) are now read from that stream by field number, so the session and weekly bars update after every reply. The old `message_limit` path is unchanged and still used where claude.ai serves the old interface.
- **Token count and cache timer in the new interface**: the end of a reply (`cc:turn_end`) triggers a new read of the conversation, retried while the server has not stored the new messages. The cache window gets a provisional end from the end of the reply. If the header anchor is missing or the header is not visible, the token count and cache timer are placed next to the chat title, found by the title's own text (the title comes from the conversation read, or from the page title). They go into the bar that holds the title, on a second line under the start of the title (out of the row, taking no room from the title or the buttons; the bar is as high as before). The position follows the title when the page moves it. If that does not work, or the title is not found, they are shown above the usage bars.
- Requires Chrome 111 or newer (`minimum_chrome_version`).
- **Tests**: `npm test` (Node 22, no dependencies) runs the real extension files against recorded frames, a fake DOM and a manual clock.

### Fixed
- **`/usage` asked every second** on plans where it reports nothing (free plan). A valid answer (even an empty one) is now repeated after an hour; a failed request is retried after a minute, then after 2, 4, 8 … minutes, at most hourly. A saved snapshot whose window has ended asks for fresh data at once.
- **Stale value after a window ended**: an ended window shows 0% without a countdown instead of the old value with "resets in 0s". A window that was never reported shows "no data yet".
- **Usage bars empty after opening a page**: the saved usage was matched to the organisation by cookie only, which is unreadable for some accounts. It is now matched like every request, restored again when the organisation becomes known later, and no longer deleted when `/usage` reports nothing.
- **Usage bars after a reload in the new interface**: a saved snapshot is matched against every organisation id seen on the page, filled in only for the windows still missing (a limits event is not overwritten), and restoration is retried every ten seconds for the first two minutes.
- A limits event or `/usage` answer with only one window no longer wipes the other one.
- A chat whose parent links form a loop no longer hangs the token count.
- A window reported without a number (the server leaves out 0.0) shows 0%, not nothing.
- A limits event the server sends again after the stream was re-opened is not taken for a new reply (events are told apart by their id; comparing the limits would not do, they are rounded to whole percent): it neither restarts the cache timer nor triggers a conversation read.
- An error answer to a conversation request is a failure again, not an empty chat. Several reply ends in a row start only one follow-up read.

### Changed
- The `PerformAction` call of the new interface is not treated as the start of a reply (the page also calls it when a chat is opened and while typing).

## [2.0.2] - 2026-09-03

### Fixed
- **Uncaught TypeError on `document.body`**: Fixed `Cannot read properties of null (reading 'appendChild')` by defensively mounting tooltips (`makeTooltip`), safely starting `MutationObserver` on `document.body || document.documentElement` (or upon `DOMContentLoaded`), and configuring UI content scripts to run at `document_idle`.

## [2.0.1] - 2026-09-03

### Fixed
- **Composer Mounting & Modern UI Anchoring**: Decoupled usage line mounting from `[data-testid="model-selector-dropdown"]` and `[data-cds="ChatComposer"]`. The usage bar now directly anchors to `[data-testid="chat-input"]` and mounts seamlessly inside `.bg-surface-3` after the flow child on both the home/new chat view and conversation view.
- **Header Token Counter Anchoring**: Added multi-selector support for header title elements (`chat-title-split`, `chat-title-button`, `conversation-title`) so token counts and cache timers reliably render across various page states and updates.
- **Unhandled Storage Promise Crash**: Wrapped `chrome.storage.sync` check in `main.js` with comprehensive try/catch and fallback to avoid silent crashes on initial load when sync storage is unavailable.
- **Direct Fetch Fallbacks**: Added direct content script `fetch()` fallbacks for `/usage`, `/chat_conversations/{id}`, and `/organizations` when the bridge client is delayed or blocked by CSP.
- **Active Org ID Resolution**: Implemented multi-tier active organization resolution checking memory, cookies (`lastActiveOrg`), local storage, extension storage, and querying `/api/organizations` directly.
- **Content Security Policy (CSP) Compatibility**: Declared `src/injected/bridge.js` with `"world": "MAIN"` in `manifest.json`, eliminating failures caused by DOM `<script>` tags blocked by `script-src`.
- **Local Web Crypto Token Hashing**: Added direct `crypto.subtle.digest` in content script context to accelerate token cache fingerprinting without requiring bridge message-passing.

## [2.0.0] - 2026-08-20

### Added
- Forked and updated for claude.ai UI redesign.
- Usage bars rendered inside rounded composer box.
- Local storage persistence for session and weekly usage state.
