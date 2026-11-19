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

**Start-up order.** Each source is validated before it can decide (see *Organisation IDs* below); an invalid value falls through to the next:
1. the `lastActiveOrg` cookie (trusted),
2. claude.ai's page `localStorage`: `lastActiveOrg`, then `currentOrganizationId`, each checked on its own (trusted),
3. `/api/organizations`, only when exactly one org is marked `active` (trusted),
4. the remembered org (`claude_last_org_id`); an invalid one, such as a route word stored by 2.1.7, is skipped and overwritten,
5. the account's only org,
6. the first candidate seen.

**Start-up rules.**
- **One request.** Start-up makes at most one org-list request (R1). Concurrent callers share one start-up resolution.
- **2 s limit.** The org list and the remembered org are read at the same time and share one 2-second limit. A read that hasn't answered by then counts as missing. A list that marks one org `active` is used at once, without waiting for the remembered org.
- **Nothing to choose.** With no answer and no fallback, start-up keeps waiting on that same request until it answers, a candidate arrives, or the cookie tick accepts an org. Restores and polls never start their own start-up.
- **No late correction.** Once start-up has chosen, it is over: a later list answer is ignored (R2). This is a deliberate trade-off. Without a cookie, a multi-org account whose list is slower than 2 s shows the remembered org until a candidate re-check or the cookie corrects it.
- **Cookie wins.** A cookie that appears at any point wins, because trusted sources are read again after every wait.

**Candidates** are IDs seen in requests (`cc:org_detected`). claude.ai also requests other organisations (for example team plus personal accounts), so a candidate never switches the active org on its own.

**No-cookie re-check.** Without a cookie, a differing candidate triggers a re-check of the org list, at most every 5 minutes:
- One flag records that a differing candidate was seen since the last re-check started reading (R5). It is cleared only when a re-check starts, so a candidate seen during the cooldown or an in-flight re-check always gets one more re-check, when the cooldown ends.
- The list's answer is discarded if a trusted source spoke or the org changed while waiting.
- If nothing trusted names another org, the current one stays.

**A genuine switch** is a trusted source naming a different org. The 1-second tick notices cookie changes. On a switch:
- memory and the screen are cleared,
- the per-org snapshots on disk are kept,
- in-flight polls are invalidated through revisions,
- the new org's snapshot is restored and polled immediately.

**Snapshots and the start-up poll.** A restored snapshot is shown at once but doesn't count as fresh data, because its age is unknown.
- Every first acceptance of an org restores its snapshot and then polls once. That poll shares the freshness gate with the page's own start-up poll, so there is one poll per page load.
- The poll is skipped only when both windows already hold live readings (R4). A reply carrying only the session window doesn't count.
- A restore needs a known org and never waits for start-up. Acceptance runs it (R3), and callers share the restore in flight for the same org, so a poll never lands before the snapshot is shown.
- An expired snapshot asks for fresh data at once only if no poll has answered or failed yet. A restore never shortens a failure or free-plan backoff (R6).

## Accepting usage numbers

- **Streams are labelled, not judged, by the listener.** Legacy completion streams take the org from their URL. Connect streams take the cookie at open time. Replay and ordering protection (event-ID cursors) is kept per org label.
- **The brain judges.**
  - An event labelled with the active org is applied.
  - An event labelled with another org is dropped, after a synchronous cookie re-check so the new org's events within the 1-second tick lag are kept.
- **No-cookie policy.** An unlabelled event (cookie unreadable) is never applied or saved, because its owner is unknown. Instead it asks for a poll that **starts after the reply**:
  - Replies in a burst share one poll, which runs no sooner than 5 seconds after the last request started.
  - A request already in flight is followed up when it ends.
  - Hidden tabs wait until they're visible.
  - Failure or free-plan backoff drops the request.
  - Without the cookie, the bars update by poll after each reply instead of live. On the free plan, where `/usage` is empty, there are no live values at all.
- **Unlabelled streams are kept apart.**
  - Each one has its own replay and cursor keys (`stream:<n>`), so one stream can't hide another's snapshot.
  - All unlabelled streams use their own bounded store (32 seen IDs, 64 cursors). Their churn can never evict a labelled org's cursors (labelled store: 32 seen IDs, 128 cursors).
  - Replay detection across reopened streams therefore needs the label. Without it, at most one extra recount can follow a reopen.
- **Turn ends.** `cc:turn_end` carries the stream's label.
  - The token counter ignores one labelled with another org.
  - Before the first org is accepted, it waits for the org instead of dropping the turn end.
  - Unlabelled turn ends still recount: a recount always fetches the active org's current chat.
- **Replay heuristic.** Event IDs start with the server's epoch milliseconds. A limits event more than 120 000 ms older than its stream's open time is a replay: its limits are delivered, but no turn end is sent. Two edges are known and accepted:
  - Reloading within 120 s of a reply treats that reply as live, so one extra recount can happen.
  - A client clock more than *S* > 120 s ahead of the server suppresses turn ends during the first *S* − 120 s of a stream.
- **Freshness.** Each window (5-hour, 7-day) tracks a revision and its reset time. A poll that started before a newer live reading can't overwrite it. A retired window can't replace a newer one. Saved snapshots are only a display fallback.
- **Expired windows** show 0% and trigger a fresh poll.

## Recent session readings

The Session tooltip's "Recent readings" are stored per org and reset window (`claude_session_history:<org>`).
- A window's saved history is loaded once. Readings that arrive while the load is pending are queued and applied on top of the saved history when it lands, then saved once.
- A load belongs to one org and one window. Switching org, clearing, or a new window invalidates it, so a late read can't leak one org's readings into another's.

## Known limits

These are recorded rather than fixed, because a fix would add more code than the risk justifies:
- **Clock step.** A backward system-clock step right after a poll can drop one unlabelled reply's poll. The next scheduled poll catches up.
- **Reset A→B→A.** A session reset time that changes A→B→A while B's history is still loading can save B's history while A is shown.
- **Extra recount.** A labelled turn end that waits through start-up, followed by a switch before its recount, can cause one extra recount for the new org.

## Keeping the bars in place

claude.ai rebuilds and hydrates the composer.
- A page-wide `MutationObserver` only *schedules* a placement check: one scan per 150 ms while mutations continue, ignoring batches that only touch the extension's own nodes. Pre-existing gap: moves of our own row are recorded on the page parent, so they cost one extra scan.
- The check finds the visible composer card once and re-places the bars only if needed.
- The 1-second tick is the safety net.

The soft fade above the bars shows only on conversation pages (`isConversationPage` in `ui.js`):

| Path | Fade |
|---|---|
| `/chat/<id>`, including nested `/…/chat/<id>` (as in 2.1.7) | yes |
| `/code/<id>`, e.g. `/code/session_…` | yes |
| `/`, `/new`, `/code`, `/code/`, `/code/new`, `/projects` | no |

Only `/chat/<id>` and `/code/session_<id>` have been confirmed on the real site.

Keyboard: Session and Weekly are focusable buttons.
- Enter or Space refreshes them; held keys and modifier combinations are ignored.
- Tooltips open only on keyboard (`:focus-visible`) focus. A touch tap uses the long-press tooltip with its 3-second auto-hide.
- In Claude Code, forward Tab jumps from the transcript into the message box (#9). Shift+Tab from the message box reaches the bars.

## Organisation IDs

`isPlausibleOrgId` (in `constants.js`, with a copy in `bridge.js`) accepts URL-safe characters, 8–128 long, with at least one digit. It doesn't assume UUIDs. The digit rule fails closed: an org ID with no digits at all would be rejected. Among UUIDs, only the RFC 9562 Max UUID (`ffffffff-…`) has no digit.

## Tests

`npm test` first checks the generated userscript matches the sources, then runs the unit tests:
- the real files run against fakes: a fake page window, a fake DOM, a manual clock, and recorded Connect frames;
- `tests/org-authority.test.js` and `tests/bridge-org-labels.test.js` cover the organisation rules above.
