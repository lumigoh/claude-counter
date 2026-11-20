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

**Design rules (2.1.8 simplification).** Four review rounds showed that many triggers, each with its own guard, can't be made safe by patching. The rules below define the behaviour of each path.

- **D1: after start-up, only a trusted source switches the org.** That means the cookie or the page setting, read every second by the tick, when a candidate arrives, and synchronously before a labelled event is dropped.
  - A candidate (an org ID seen in a request, `cc:org_detected`) never switches a known org and never asks the org list. claude.ai requests other organisations too, such as team plus personal accounts.
  - A candidate is only used while no org is known: start-up takes the first one seen, and after a start-up that found nothing, the next one becomes the org.
  - Cost: without a cookie, a multi-org user who switches org keeps the start-up org until a reload or until the cookie appears.
- **D2: one start-up decision per page load.**
  - It runs once and settles within 2 s, with an org or with none. It makes at most one org-list request. Callers wait for it but never restart it.
  - The list and the remembered org are read at the same time and share the 2 s limit; a read that hasn't answered by then counts as missing.
  - A list that marks one org `active` is used at once, without waiting for the remembered org.
  - If start-up settles with none, a later list answer naming an active or sole org can still supply the *first* org. It never replaces one.
  - A cookie that appears at any point wins, because trusted sources are read again after every wait.
- **D3: one poll function behind one gate.** Every `/usage` request goes through `pollUsage`. That covers acceptance, page changes, focus, visibility, stream timers, the periodic tick, expiry, reply polls and the user's click. It runs in a fixed order:
  1. Wait for start-up.
  2. Wait for the org's **ready gate**, its snapshot restore, which is set on every acceptance. If another acceptance happened meanwhile (even back to the same org), stop: that acceptance polls for itself.
  3. In one place, check hidden tab, request in flight, backoff and freshness. Only the user's click overrides backoff.
- **D4: fresh means both windows are live.** A restored snapshot is shown at once but isn't fresh, because its age is unknown. If either window lacks a live reading, freshness comes from a poll answer received since the last window expiry.
- **D5: session history follows the current org and reset window.** See *Recent session readings*.
- **D6: every wait in the poll path has a time limit.** Bridge readiness and start-up each have a 2 s limit. The ready gate gives the snapshot read 3 s, then polling can proceed. The bridge usage request and the direct fallback each have a 5 s limit. The fallback shares one deadline between the fetch and its body, and aborts on timeout. A direct timeout releases the in-flight slot and enters failure backoff for the active org.

**A genuine switch** is a trusted source naming a different org. The 1-second tick notices cookie changes. On a switch:
- memory and the screen are cleared,
- the per-org snapshots on disk are kept,
- in-flight polls are invalidated through revisions and the ready gate,
- the new org's snapshot gets a bounded restore attempt before it is polled.

**Snapshots.**
- Every acceptance attempts to restore the org's snapshot before polling (D3, D6). With the freshness rule (D4), that makes one poll per page load.
- Callers share the restore in flight for the same org.
- An expired snapshot asks for fresh data at once only if no poll has answered or failed yet. Backoff (failure, free plan) is checked in `pollUsage`, and usage readings preserve its deadline.

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
  - Before the first org is accepted, it waits for start-up (≤ 2 s). If start-up found no org, the token counter's first-org refresh recounts instead.
  - Unlabelled turn ends still recount: a recount always fetches the active org's current chat.
- **Replay heuristic.** Event IDs start with the server's epoch milliseconds. A limits event more than 120 000 ms older than its stream's open time is a replay: its limits are delivered, but no turn end is sent. Two edges are known and accepted:
  - Reloading within 120 s of a reply treats that reply as live, so one extra recount can happen.
  - A client clock more than *S* > 120 s ahead of the server suppresses turn ends during the first *S* − 120 s of a stream.
- **Freshness.** Each window (5-hour, 7-day) tracks a revision and its reset time. A poll that started before a newer live reading can't overwrite it. A retired window can't replace a newer one. Saved snapshots are only a display fallback.
- **Expired windows** show 0% and trigger a fresh poll.

## Recent session readings

The Session tooltip's "Recent readings" are stored per org and reset window (`claude_session_history:<org>`).
- A window’s saved history is loaded once per visit to that window. Reset timestamps that represent the same instant use the same history. Readings that arrive while the load is pending are queued and applied on top of the saved history when it lands, then saved once.
- A load belongs to one org and one window. Switching org, clearing, or a new window invalidates it, so a late read can't leak one org's readings into another's.
- Starting a load for a different window hides the old window's readings until the new history lands (D5). A reset time going R1→R2→R1 therefore reloads R1.

## Known limits

These are recorded rather than fixed, because a fix would add more code than the risk justifies:
- **Clock step.** A backward system-clock step right after a poll can drop one unlabelled reply's poll. The next scheduled poll catches up.
- **Extra recount.** A labelled turn end that waits through start-up, followed by a switch before its recount, can cause one extra recount for the new org.
- **Hidden reply poll (medium, pre-existing).** Hiding the tab while a reply poll waits for the snapshot can consume the reply's refresh and leave the bars unchanged until the next eligible poll.
- **Same-millisecond reply.** A reply and a subsequent poll with the same millisecond timestamp can cause one redundant follow-up poll.
- **Expired snapshot backfill (regression).** A restore that fills a missing window with an expired snapshot can make a newer poll answer count as stale and cause one extra request.
- **History across tabs.** Two tabs writing history for the same org and reset window use last-writer-wins storage, so one tab's readings can be lost.
- **Array response.** A `[]` response from `/usage` is treated as an empty free-plan answer and can postpone automatic retries for up to an hour.

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
