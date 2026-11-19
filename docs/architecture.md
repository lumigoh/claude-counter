# How Claude Counter works

A one-page map for anyone changing the code. It describes 2.1.8 and later.

## The three parts

| Part | File | Runs in | Job |
|---|---|---|---|
| **Listener** | `src/injected/bridge.js` | the claude.ai page itself (page world) | Wraps `fetch`, reads copies of the page's own responses, and reports usage limits and organisation IDs it sees. It also answers requests from the brain (`usage`, `conversation`, `hash`). |
| **Brain** | `src/content/main.js` | the extension's content script (isolated world) | Decides which organisation is active, which numbers are fresh, what to save, and when to poll `/usage`. |
| **Display** | `src/content/ui.js` + `src/styles.css` | content script | Draws the Session/Weekly bars above the composer, keeps them in place, and shows the tooltips and the fade. |

Supporting files:
- `bridge-client.js`: the brain's side of the message channel.
- `constants.js`: shared selectors, colours, and `isPlausibleOrgId`.
- `config.js`: the code-only `showTokenCounter` flag.
- `token-counter.js` + `tokens.js`: the optional token count, off by default.

The **userscript** (`userscript/claude-counter.user.js`) is generated from the same files by `scripts/build-userscript.mjs`. It runs everything in the page world and stores data in namespaced `localStorage` (`userscript/storage-adapter.js`). Never edit the generated file; run `npm run build:userscript`.

## Messages between listener and brain

All messages go through `window.postMessage` with `cc: 'ClaudeCounter'`.

| Message | From → to | Meaning |
|---|---|---|
| `cc:message_limit` (+ `meta`) | listener → brain | Usage limits from a reply. `meta.orgId` is the organisation the stream belongs to (or `null`); `meta.openedAt` is when that stream opened. |
| `cc:turn_end` | listener → brain | A reply finished while its stream was open. Used only by the optional token counter. Replays of older events don't send it. |
| `cc:org_detected` | listener → brain | An organisation ID appeared in a page request. **A candidate, not a switch.** |
| `cc:stream_started` | listener → brain | A legacy SSE stream started; the brain schedules extra `/usage` checks. |
| `cc:request` / `cc:response` | brain ↔ listener | `usage`, `conversation` and `hash` requests. |

## Which organisation is active

Quotas belong to one organisation, so everything saved is keyed by it (`claude_usage_state:<org>`, `claude_session_history:<org>`).

**Trusted sources**, which reflect the user's own choice:
1. the `lastActiveOrg` cookie,
2. claude.ai's page `localStorage` (`lastActiveOrg`, `currentOrganizationId`),
3. `/api/organizations`, only when exactly one org is marked `active`.

**Start-up fallbacks**, used only when nothing above answers: the remembered org (`claude_last_org_id`), then the account's only org, then the first candidate.

**Candidates** are IDs seen in requests (`cc:org_detected`). claude.ai also requests other organisations (for example team plus personal accounts), so a candidate never switches the active org on its own. Without a cookie, a differing candidate triggers a re-check of the org list, rate-limited to every 5 minutes. If nothing trusted names another org, the current one stays.

**A genuine switch** is a trusted source naming a different org. The 1-second tick notices cookie changes. On a switch:
- memory and the screen are cleared,
- the per-org snapshots on disk are kept,
- in-flight polls are invalidated through revisions,
- the new org's snapshot is restored and polled immediately.

## Accepting usage numbers

- **Streams are labelled, not judged, by the listener.** Legacy completion streams take the org from their URL. Connect streams take the cookie at open time. Replay and ordering protection (event-ID cursors) is kept per org label.
- **The brain judges.** It drops events labelled with another org, and unlabelled events from streams that opened before the last genuine switch.
- **Freshness.** Each window (5-hour, 7-day) tracks a revision and its reset time. A poll that started before a newer live reading can't overwrite it. A retired window can't replace a newer one. Saved snapshots are only a display fallback.
- **Expired windows** show 0% and trigger a fresh poll.

## Keeping the bars in place

claude.ai rebuilds and hydrates the composer.
- A page-wide `MutationObserver` only *schedules* a placement check: one per 150 ms burst, ignoring the extension's own nodes.
- The check finds the visible composer card once and re-places the bars only if needed.
- The 1-second tick is the safety net.

The soft fade above the bars shows only on conversation pages, `/chat/<id>` and `/code/<id>` (`isConversationPage` in `ui.js`).

## Tests

`npm test` first checks the generated userscript matches the sources, then runs the unit tests:
- the real files run against fakes: a fake page window, a fake DOM, a manual clock, and recorded Connect frames;
- `tests/org-authority.test.js` and `tests/bridge-org-labels.test.js` cover the organisation rules above.
