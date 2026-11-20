'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMainEnv, liveWindow, limitsEvent, ORG, CONV } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const orgStored = { claude_last_org_id: ORG };
// The label the bridge puts on a stream of the active org. Unlabelled events are never applied (#11).
const ORG_STREAM = { orgId: ORG, openedAt: START };

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

const emptyUsage = async () => ({ five_hour: null, seven_day: null });

test('M01 free plan: /usage reports nothing, it is asked once and then only once an hour', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.usageRequests.length, 1);

	await env.clock.advance(10 * MIN); // 600 ticks
	assert.equal(env.calls.usageRequests.length, 1, 'no polling every second');

	await env.clock.advance(51 * MIN);
	assert.equal(env.calls.usageRequests.length, 2, 'one more after an hour');
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(31 * MIN);
	assert.equal(env.calls.usageRequests.length, 3);
});

test('M02 a failed /usage request is retried after a minute, then later and later; a valid answer after an hour', async () => {
	let fail = true;
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => {
			if (fail) throw new Error('timeout');
			return { five_hour: null, seven_day: null };
		}
	});
	assert.equal(env.calls.usageRequests.length, 1);
	await env.clock.advance(MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 2, 'first retry after a minute');
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length, 2, 'the second retry waits longer');
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length, 3, 'two minutes after the second failure');

	fail = false;
	await env.clock.advance(4 * MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 4, 'this one succeeds');
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 4, 'valid answer: wait');
	await env.clock.advance(31 * MIN);
	assert.equal(env.calls.usageRequests.length, 5);
});

test('M02a an account where /usage always fails is not hammered: the wait grows to an hour', async () => {
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => {
			throw new Error('403');
		}
	});
	await env.clock.advance(3 * HOUR);
	// 1, 2, 4, 8, 16, 32 minutes, then every hour: at most about 9 requests in three hours
	assert.ok(env.calls.usageRequests.length <= 9, `requests: ${env.calls.usageRequests.length}`);
	assert.ok(env.calls.usageRequests.length >= 6);
	const gaps = env.calls.usageRequests.slice(1).map((r, i) => r.at - env.calls.usageRequests[i].at);
	assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1] - 2000), 'gaps never shrink');
});

test('M02b an unusable answer (no object) counts as a failure', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => null });
	await env.clock.advance(MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 2);
});

test('M02c nothing is requested while the tab is hidden', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	env.document.hidden = true;
	await env.clock.advance(3 * HOUR);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M02d without a known organisation nothing is asked; the first org found is polled at once (D2)', async () => {
	let listRequests = 0;
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, fetch: async () => { listRequests++; return { ok: false }; } });
	await env.clock.advance(2 * MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 0);
	assert.equal(listRequests, 1, 'start-up asked once and does not retry');
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush(); // no clock advance: acceptance itself polls
	assert.deepEqual(env.calls.usageRequests.map((r) => r.orgId), [ORG]);
});

test('M03 limits from a reply: bars get the values, they are saved with the organisation, /usage is not needed', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: [0.1, 86400] }), ORG_STREAM);
	await env.clock.flush();

	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 20);
	assert.equal(Math.round(u.seven_day.utilization), 10);
	assert.equal(u.five_hour.resets_at, new Date(START + HOUR).toISOString());

	const saved = env.stored(`claude_usage_state:${ORG}`);
	assert.equal(saved.orgId, ORG);
	assert.equal(Math.round(saved.usage.five_hour.utilization), 20);

	const before = env.calls.usageRequests.length;
	await env.clock.advance(59 * MIN);
	assert.equal(env.calls.usageRequests.length, before, 'fresh limits postpone the hourly refresh');
});

test('M04 saved usage is restored on load at once, then confirmed by one request (#15)', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	const u = env.lastUsage();
	assert.equal(u.five_hour.utilization, 33);
	assert.equal(u.seven_day.utilization, 12);
	// A snapshot's age is unknown, so one poll per page load confirms it (owner decision, #15).
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M04b the organisation cookie is not needed (it may be unreadable): the old code needed it', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved, claude_last_org_id: ORG }, startMs: START, cookie: '', usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 33);
});

test('M04c the organisation only becomes known later: the saved usage is restored then', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(40, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.setUsage.length, 0, 'nothing known yet');
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 40);
});

test('M04d usage saved for another organisation is not shown, and not deleted', async () => {
	const saved = { orgId: 'some-other-org', usage: { five_hour: liveWindow(77, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.setUsage.length, 0);
	assert.deepEqual(env.stored('claude_usage_state'), saved);
});

test('M04e the organisation cookie still works when it is readable', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(12, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved }, startMs: START, cookie: `a=b; lastActiveOrg=${ORG}`, usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 12);
});

test('M05 a window that ends shows 0% (expired), the other one stays, the old value does not come back', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.76, 10], sevenD: [0.25, 86400] }), ORG_STREAM);
	await env.clock.flush();
	assert.equal(Math.round(env.lastUsage().five_hour.utilization), 76);

	await env.clock.advance(11000);
	const u = env.lastUsage();
	assert.deepEqual(u.five_hour, { expired: true });
	assert.equal(Math.round(u.seven_day.utilization), 25);

	// /usage was asked at the rollover and knows nothing (free plan): the window must stay expired
	await env.clock.advance(5 * MIN);
	assert.deepEqual(env.lastUsage().five_hour, { expired: true });
	assert.equal(Math.round(env.lastUsage().seven_day.utilization), 25);
	assert.deepEqual(env.stored(`claude_usage_state:${ORG}`).usage.five_hour, { expired: true });
});

test('M05b both windows can end, and a new reply starts a fresh window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.5, 5], sevenD: [0.5, 8] }), ORG_STREAM);
	await env.clock.advance(10000);
	assert.deepEqual(env.lastUsage(), { five_hour: { expired: true }, seven_day: { expired: true } });

	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.02, 5 * 3600], sevenD: [0.3, 7 * 86400] }), ORG_STREAM);
	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 2);
	assert.equal(Math.round(u.seven_day.utilization), 30);
});

test('M06 saved usage whose window ended while the page was closed shows 0% first, and fresh data is asked for at once', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	// a paid plan: /usage knows the real value (used elsewhere, e.g. in another app)
	const env = await createMainEnv({
		storage: { ...orgStored, claude_usage_state: saved },
		startMs: START,
		usage: async () => ({ five_hour: { utilization: 63, resets_at: new Date(START + 4 * HOUR).toISOString() }, seven_day: null })
	});
	const first = env.calls.setUsage.find(Boolean);
	assert.deepEqual(first.five_hour, { expired: true }, 'the snapshot shows the ended window as 0% first');
	assert.equal(first.seven_day.utilization, 12);
	// Start-up confirms a restored snapshot with one poll (#15), so the fresh value arrives at once.
	await env.clock.advance(2000);
	assert.equal(env.calls.usageRequests.length, 1, 'asked once at start-up, not after an hour');
	assert.equal(env.lastUsage().five_hour.utilization, 63);
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M06b saved usage that is still live is confirmed once, not polled repeatedly (#15)', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(10, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 1, 'one start-up confirmation; the empty answer then holds the hourly cooldown');
});

test('M06c on the free plan the stale restore asks once and then waits an hour', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 1);
	assert.deepEqual(env.lastUsage().five_hour, { expired: true });
});

test('M06d a later restore (another tab saved a window) does not undo the free-plan hourly backoff (#15)', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 1, 'start-up confirmation; the empty answer starts the hourly backoff');
	env.chrome.storage.local.set({ [`claude_usage_state:${ORG}`]: { version: 2, orgId: ORG, usage: { five_hour: { expired: true }, seven_day: liveWindow(12, START + 24 * HOUR) } } });
	await env.clock.advance(11000); // the start-up restore retry fills the weekly window
	assert.equal(env.lastUsage().seven_day.utilization, 12);
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 1, 'still within the hourly backoff');
});

test('M06e R6: a restore of an expired window does not shorten the failure backoff (final round)', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => { throw new Error('403'); } });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 1, 'the start-up poll fails: retry in 60 s');
	env.chrome.storage.local.set({ [`claude_usage_state:${ORG}`]: { version: 2, orgId: ORG, usage: { five_hour: { expired: true }, seven_day: liveWindow(12, START + 24 * HOUR) } } });
	await env.clock.advance(50000); // the 10 s restore retry fills both windows
	assert.equal(env.lastUsage().seven_day.utilization, 12);
	assert.equal(env.calls.usageRequests.length, 1, 'still within the failure backoff');
});

test('M06f R6/D3: a restored window that expires later does not bypass the failure backoff', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => { throw new Error('403'); } });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 1, 'the start-up poll fails: retry in 60 s');
	env.chrome.storage.local.set({ [`claude_usage_state:${ORG}`]: { version: 2, orgId: ORG, usage: { five_hour: liveWindow(30, START + 20000), seven_day: liveWindow(12, START + 24 * HOUR) } } });
	await env.clock.advance(11000); // the restore retry fills both windows
	assert.equal(env.lastUsage().five_hour.utilization, 30);
	await env.clock.advance(30000); // the session window expires at 20 s
	assert.equal(env.lastUsage().five_hour.expired, true);
	assert.equal(env.calls.usageRequests.length, 1, 'the expiry waits for the backoff');
	await env.clock.advance(25000);
	assert.equal(env.calls.usageRequests.length, 2, 'then retries');
});

test('M07 /usage with nothing in it never wipes what is known or saved', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(61 * MIN); // an hourly refresh happens
	assert.ok(env.calls.usageRequests.length >= 1);
	assert.ok(env.stored(`claude_usage_state:${ORG}`).usage.seven_day, 'still saved');
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M08 a paid plan: /usage values are used, a missing window keeps the known one', async () => {
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => ({ five_hour: { utilization: 41, resets_at: new Date(START + HOUR).toISOString() }, seven_day: null })
	});
	assert.equal(env.lastUsage().five_hour.utilization, 41);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: null, sevenD: [0.5, 86400] }), ORG_STREAM);
	assert.equal(env.lastUsage().five_hour.utilization, 41, 'a limits event with only one window keeps the other');
	assert.equal(Math.round(env.lastUsage().seven_day.utilization), 50);
});

test('M09 a limits event without windows changes nothing', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const before = env.calls.setUsage.length;
	await env.emit('cc:message_limit', { windows: {} }, ORG_STREAM);
	await env.emit('cc:message_limit', null, ORG_STREAM);
	assert.equal(env.calls.setUsage.length, before);
});

// ---- persistence across reloads ----

const OTHER_ORG = '99999999-8888-4777-8666-555555555555';
const snapshot = (orgFields) => ({
	...orgFields,
	usage: { five_hour: liveWindow(71, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) }
});

// 2.1.8 (#2): an ID seen in a request is not a switch. A genuine switch is the page rewriting its
// lastActiveOrg cookie, which the once-a-second tick notices.
async function switchOrg(env, orgId) {
	env.document.cookie = `lastActiveOrg=${orgId}`;
	await env.clock.advance(1000);
	await env.clock.flush();
}

test('M17 legacy aliases cannot authorize another organisation snapshot', async () => {
	const saved = snapshot({ orgId: OTHER_ORG, orgIds: [OTHER_ORG, ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage(), undefined);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M17b a snapshot of a different account is not shown', async () => {
	const saved = snapshot({ orgId: OTHER_ORG, orgIds: [OTHER_ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage(), undefined);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M18 windows the page does not know are filled in from the snapshot, known ones are kept', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: null }), ORG_STREAM);
	assert.equal(env.lastUsage().five_hour.utilization, 20);
	assert.equal(env.lastUsage().seven_day, null);
	await env.clock.flush(); // let the live reading's own save finish before planting the snapshot

	env.chrome.storage.local.set({ [`claude_usage_state:${ORG}`]: { version: 2, ...snapshot({ orgId: ORG }) } });
	await env.clock.flush();
	await env.clock.advance(11000);
	assert.equal(env.lastUsage().seven_day.utilization, 12, 'weekly filled in from the snapshot');
	assert.equal(env.lastUsage().five_hour.utilization, 20, 'the live value stays');
});

test('M18b the restore retry stops after two minutes', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: null }), ORG_STREAM);
	await env.clock.advance(3 * MIN);
	env.chrome.storage.local.set({ [`claude_usage_state:${ORG}`]: { version: 2, ...snapshot({ orgId: ORG }) } });
	await env.clock.flush();
	await env.clock.advance(30000);
	assert.equal(env.lastUsage().seven_day, null);
});

test('M19 each organisation persists only its own windows, including partial updates', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.4, 3600], sevenD: null }), ORG_STREAM);
	await env.clock.flush();
	await switchOrg(env, OTHER_ORG);
	assert.equal(env.lastUsage(), null, 'old quota is removed immediately');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: null, sevenD: [0.05, 86400] }), { orgId: OTHER_ORG });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour, null, 'the missing session window is not filled from another organisation');
	assert.equal(env.stored(`claude_usage_state:${ORG}`).usage.five_hour.utilization, 40);
	assert.equal(env.stored(`claude_usage_state:${OTHER_ORG}`).usage.five_hour, null);
	assert.equal(env.stored(`claude_usage_state:${OTHER_ORG}`).usage.seven_day.utilization, 5);
});

test('M20 a reload follows the cookie, not another organisation ID seen in requests', async () => {
	const first = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await switchOrg(first, OTHER_ORG);
	await first.emit('cc:message_limit', limitsEvent(first.clock.now), { orgId: OTHER_ORG });
	await first.clock.flush();
	const saved = first.stored(`claude_usage_state:${OTHER_ORG}`);
	const second = await createMainEnv({ storage: { ...orgStored, [`claude_usage_state:${OTHER_ORG}`]: saved }, startMs: START + MIN, cookie: `lastActiveOrg=${ORG}`, usage: emptyUsage });
	assert.equal(second.lastUsage(), undefined, 'the cookie organisation does not inherit the other one');
	await second.emit('cc:org_detected', { orgId: OTHER_ORG });
	await second.clock.flush();
	assert.equal(second.lastUsage(), undefined, 'a request mentioning the other organisation is not a switch');
	await switchOrg(second, OTHER_ORG);
	assert.equal(second.lastUsage().five_hour.utilization, 20, 'a genuine switch restores that organisation');
	assert.equal(second.lastUsage().seven_day.utilization, 10);
});

// #57 refresh triggers must coexist with #60's empty-answer and failure backoff.
const usefulUsage = async () => ({ five_hour: liveWindow(20, START + 10 * HOUR), seven_day: liveWindow(10, START + 100 * HOUR) });

test('M57a useful endpoint data is refreshed every five visible minutes', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: usefulUsage });
	await env.clock.advance(5 * MIN - 1000);
	assert.equal(env.calls.usageRequests.length, 1);
	await env.clock.advance(1000);
	assert.equal(env.calls.usageRequests.length, 2);
	env.document.hidden = true;
	await env.clock.advance(10 * MIN);
	assert.equal(env.calls.usageRequests.length, 2);
	env.document.hidden = false;
	env.document.dispatchEvent({ type: 'visibilitychange' });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 3);
});

test('M57b focus and navigation refresh stale data without duplicate requests', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: usefulUsage });
	await env.clock.advance(MIN);
	env.window.dispatchEvent({ type: 'focus' });
	env.document.dispatchEvent({ type: 'visibilitychange' });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 2);
	env.window.dispatchEvent({ type: 'focus' });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(2 * MIN);
	await env.navigate('/new');
	assert.equal(env.calls.usageRequests.length, 3);
});

test('M57c a legacy stream schedules refreshes at 20 and 60 seconds', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: usefulUsage });
	await env.emit('cc:stream_started', {});
	await env.clock.advance(19000);
	assert.equal(env.calls.usageRequests.length, 1);
	await env.clock.advance(1000);
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(40000);
	assert.equal(env.calls.usageRequests.length, 3);
});

test('M57d empty /usage answers keep the hourly cooldown across focus, navigation and stream events', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:stream_started', {});
	await env.clock.advance(2 * MIN);
	env.window.dispatchEvent({ type: 'focus' });
	env.document.dispatchEvent({ type: 'visibilitychange' });
	await env.navigate('/new');
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M57e extra refresh events respect failure backoff and hidden tabs', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => { throw new Error('403'); } });
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(MIN);
	env.window.dispatchEvent({ type: 'focus' });
	env.document.dispatchEvent({ type: 'visibilitychange' });
	await env.emit('cc:stream_started', {});
	await env.navigate('/new');
	assert.equal(env.calls.usageRequests.length, 2);
	env.document.hidden = true;
	await env.clock.advance(3 * MIN);
	env.window.dispatchEvent({ type: 'focus' });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.length, 2);
});


test('M21 opening a chat and completing a turn do not fetch token-summary data', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:turn_end', {});
	await env.emit('cc:generation_start', {});
	await env.clock.advance(20000);
	assert.equal(env.calls.conversationRequests.length, 0);
	assert.equal(env.calls.setMetrics.length, 0);
});

test('M22 the code flag defaults off, regardless of an old saved preference', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, claude_counter_show_tokens: true }, startMs: START, usage: emptyUsage });
	await env.emit('cc:turn_end', {});
	await env.clock.advance(20000);
	assert.equal(env.calls.tokenStates.at(-1).enabled, false);
	assert.equal(env.calls.tokenizerLoads.length, 0);
	assert.equal(env.calls.conversationRequests.length, 0);
});

test('M23 the code flag enables the counter at startup without a saved preference', async () => {
	const env = await createMainEnv({ storage: orgStored, showTokenCounter: true, conversations: { [CONV]: { chat_messages: [{}, {}], fakeTokens: 345 } }, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 345);
	assert.equal(env.calls.conversationRequests.length, 1);
	assert.equal(env.stored('claude_counter_show_tokens'), undefined);
});

test('M24 the code opt-in is honored and navigation cannot show a late previous-chat count', async () => {
	const env = await createMainEnv({ storage: orgStored, showTokenCounter: true, startMs: START, usage: emptyUsage });
	let finish;
	env.answers.conversation = async () => new Promise((resolve) => { finish = resolve; });
	const refresh = env.calls.uiOpts.onTokenCounterRefresh();
	await env.clock.flush();
	await env.navigate('/new');
	finish({ chat_messages: [{}], fakeTokens: 999 });
	await refresh;
	assert.equal(env.calls.tokenStates.at(-1).active, false);
	assert.notEqual(env.calls.tokenStates.at(-1).totalTokens, 999);
});

test('M25 disabling while a conversation is loading ignores its eventual count', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	let finish;
	env.answers.conversation = async () => new Promise((resolve) => { finish = resolve; });
	const enabling = env.tokenCounter.setEnabled(true);
	await env.clock.flush();
	await env.tokenCounter.setEnabled(false);
	finish({ chat_messages: [{}], fakeTokens: 999 });
	await enabling;
	assert.equal(env.calls.tokenStates.at(-1).enabled, false);
	assert.notEqual(env.calls.tokenStates.at(-1).totalTokens, 999);
});

test('M26 end-of-turn counting retries while new messages have not been stored', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	let messages = [{}];
	env.answers.conversation = async () => ({ chat_messages: messages });
	await env.tokenCounter.setEnabled(true);
	await env.emit('cc:turn_end', {});
	await env.clock.advance(1300);
	assert.equal(env.calls.conversationRequests.length, 2);
	messages = [{}, {}];
	await env.clock.advance(5000);
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 20);
	const count = env.calls.conversationRequests.length;
	await env.clock.advance(20000);
	assert.equal(env.calls.conversationRequests.length, count);
});


test('M27 an enabled counter retries when the organisation is discovered after startup', async () => {
	const env = await createMainEnv({ showTokenCounter: true, startMs: START, usage: emptyUsage, conversations: { [CONV]: { chat_messages: [{}], fakeTokens: 77 } } });
	assert.equal(env.calls.conversationRequests.length, 0);
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 77);
});

async function pendingUsage(env) {
	let complete;
	env.answers.usage = () => new Promise((resolve) => { complete = resolve; });
	const done = env.calls.uiOpts.onUsageRefresh();
	await env.clock.flush();
	return { done, complete: (value) => complete(value) };
}

test('F01 a late poll cannot lower a newer live reading, even within the same millisecond', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const poll = await pendingUsage(env);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.4, 3600], sevenD: null }), ORG_STREAM);
	poll.complete({ five_hour: { utilization: 39, resets_at: new Date(START + HOUR).toISOString() }, seven_day: { utilization: 12, resets_at: new Date(START + 24 * HOUR).toISOString() } });
	await poll.done;
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	assert.equal(env.lastUsage().seven_day.utilization, 12, 'the untouched weekly window still accepts the poll');
	assert.equal(env.stored(`claude_usage_state:${ORG}`).usage.five_hour.utilization, 40);
	assert.equal(env.clock.now, START, 'a clock timestamp alone cannot distinguish these updates');
});

test('F02 a fresh poll can apply a real downward correction, including a revised future reset time', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.4, 7200], sevenD: null }), ORG_STREAM);
	env.answers.usage = async () => ({ five_hour: { utilization: 39, resets_at: new Date(START + HOUR).toISOString() } });
	await env.calls.uiOpts.onUsageRefresh();
	assert.equal(env.lastUsage().five_hour.utilization, 39, 'there is no blanket maximum clamp');
	assert.equal(env.lastUsage().five_hour.resets_at, new Date(START + HOUR).toISOString());
});

test('F03 a window that ended while a poll was pending can accept a genuinely new window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.9, 1], sevenD: null }), ORG_STREAM);
	const poll = await pendingUsage(env);
	await env.clock.advance(2000);
	assert.equal(env.lastUsage().five_hour.expired, true);
	poll.complete({ five_hour: { utilization: 1, resets_at: new Date(START + HOUR).toISOString() } });
	await poll.done;
	assert.equal(env.lastUsage().five_hour.utilization, 1);
});

test('F04 an old-window poll arriving after expiry keeps the expired state and retries within a minute', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.9, 1], sevenD: null }), ORG_STREAM);
	const poll = await pendingUsage(env);
	await env.clock.advance(2000);
	poll.complete({ five_hour: { utilization: 90, resets_at: new Date(START + 1000).toISOString() } });
	await poll.done;
	assert.equal(env.lastUsage().five_hour.expired, true);
	const requests = env.calls.usageRequests.length;
	env.answers.usage = async () => ({ five_hour: { utilization: 1, resets_at: new Date(START + HOUR).toISOString() } });
	await env.clock.advance(MIN + 1000);
	assert.ok(env.calls.usageRequests.length > requests);
	assert.equal(env.lastUsage().five_hour.utilization, 1);
});

test('F05 stale events for a retired window cannot erase a live new window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.02, 3600], sevenD: null }), ORG_STREAM);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.9, -1], sevenD: null }), ORG_STREAM);
	assert.equal(env.lastUsage().five_hour.utilization, 2);
});

// F06 and O04 cover per-window freshness across a switch: their old poll answers the same window,
// so per-window revisions reject it even without the org guard in refreshUsage. O22 is the test that
// fails when that org guard is removed (#17).
test('F06 old organisation polls and labelled stream events are ignored after switching', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.4, 3600], sevenD: null }), ORG_STREAM);
	const poll = await pendingUsage(env);
	await switchOrg(env, OTHER_ORG);
	poll.complete({ five_hour: { utilization: 39, resets_at: new Date(START + HOUR).toISOString() } });
	await poll.done;
	assert.equal(env.lastUsage(), null, 'switching removes the previous organisation quota');
	env.answers.usage = async () => ({ five_hour: { utilization: 5, resets_at: new Date(START + HOUR / 2).toISOString() } });
	await env.calls.uiOpts.onUsageRefresh();
	assert.equal(env.lastUsage().five_hour.utilization, 5);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.42, 3600], sevenD: null }), { orgId: ORG });
	assert.equal(env.lastUsage().five_hour.utilization, 5);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.06, 1800], sevenD: null }), { orgId: OTHER_ORG });
	assert.equal(env.lastUsage().five_hour.utilization, 6);
});

test('F07 precision differences in reset timestamps do not reject a live update for the same window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => ({ five_hour: { utilization: 40, resets_at: new Date(START + HOUR + 500).toISOString() } }) });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.41, 3600], sevenD: null }), ORG_STREAM);
	assert.equal(env.lastUsage().five_hour.utilization, 41);
});

test('F08 direct-fetch fallback retains the original poll freshness boundary', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	let complete;
	env.answers.usage = async () => { throw new Error('bridge timeout'); };
	env.context.fetch = async () => new Promise((resolve) => { complete = resolve; });
	const done = env.calls.uiOpts.onUsageRefresh();
	await env.clock.flush();
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.4, 3600], sevenD: null }), ORG_STREAM);
	complete({ ok: true, json: async () => ({ five_hour: { utilization: 39, resets_at: new Date(START + HOUR).toISOString() } }) });
	await done;
	assert.equal(env.lastUsage().five_hour.utilization, 40);
});

test('F09 D6: a stalled snapshot releases the ready gate after three seconds', async () => {
	let release;
	const env = await createMainEnv({
		storage: orgStored, startMs: START, usage: usefulUsage,
		beforeStart: ({ chrome }) => {
			const get = chrome.storage.local.get;
			chrome.storage.local.get = (keys, cb) => {
				if (keys.includes(`claude_usage_state:${ORG}`)) release = cb;
				else get(keys, cb);
			};
		}
	});
	env.window.dispatchEvent({ type: 'focus' });
	await env.clock.advance(2999);
	assert.equal(typeof release, 'function');
	assert.equal(env.calls.usageRequests.length, 0);
	await env.clock.advance(1);
	assert.equal(env.calls.usageRequests.length, 1);
	const readings = env.calls.setUsage.length;
	release({ [`claude_usage_state:${ORG}`]: { version: 2, orgId: ORG, usage: { five_hour: liveWindow(99, START + HOUR) } } });
	await env.clock.flush();
	assert.equal(env.calls.setUsage.length, readings, 'the timed-out callback is ignored');
});

for (const phase of ['fetch', 'body']) {
	test(`F10 ${phase} D6: a stalled direct /usage ${phase} aborts and enters failure backoff`, async () => {
		let signal;
		let readBody = false;
		const stalled = new Promise(() => {});
		const env = await createMainEnv({
			storage: orgStored, startMs: START, usage: async () => { throw new Error('bridge timeout'); },
			fetch: async (url, options) => {
				if (!url.endsWith('/usage')) return { ok: false };
				signal = options.signal;
				return phase === 'fetch' ? stalled : { ok: true, json: () => { readBody = true; return stalled; } };
			}
		});
		assert.equal(readBody, phase === 'body');
		assert.equal(signal?.aborted, false, 'the direct request receives a live signal');
		await env.clock.advance(4999);
		assert.equal(signal.aborted, false);
		await env.clock.advance(1);
		assert.equal(signal.aborted, true);
		env.window.dispatchEvent({ type: 'focus' });
		await env.clock.advance(MIN - 1);
		assert.equal(env.calls.usageRequests.length, 1, 'the timeout counts as a failure');
		env.answers.usage = usefulUsage;
		await env.clock.advance(1001);
		assert.equal(env.calls.usageRequests.length, 2, 'the retry is no longer blocked by the timed-out request');
		assert.ok(env.lastUsage());
	});
}

for (const change of ['switch', 'hide']) {
	test(`F11 ${change} D6: ${change} during a bridge poll suppresses its direct fallback`, async () => {
		let fail;
		const fallbacks = [];
		const env = await createMainEnv({
			cookie: `lastActiveOrg=${ORG}`, startMs: START,
			usage: () => new Promise((resolve, reject) => { fail = reject; }),
			fetch: async (url) => { fallbacks.push(url); return { ok: false }; }
		});
		if (change === 'switch') await switchOrg(env, OTHER_ORG);
		else env.document.hidden = true;
		env.answers.usage = usefulUsage;
		fail(new Error('bridge timeout'));
		await env.clock.flush();
		await env.clock.advance(1000);
		assert.deepEqual(fallbacks, []);
		if (change === 'switch') assert.deepEqual(env.calls.usageRequests.map(({ orgId }) => orgId), [ORG, OTHER_ORG]);
	});
}

test('F14 a cache restore during a poll cannot outrank the fresh endpoint answer', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.clock.advance(6000);
	const poll = await pendingUsage(env);
	env.chrome.storage.local.set({ claude_usage_state: { orgId: ORG, usage: { five_hour: liveWindow(40, START + HOUR) } } });
	await env.clock.advance(10000); // the start-up restore retry picks the snapshot up
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	poll.complete({ five_hour: { utilization: 39, resets_at: new Date(START + HOUR).toISOString() } });
	await poll.done;
	assert.equal(env.lastUsage().five_hour.utilization, 39);
});

test('F15 a previously mixed legacy snapshot is rejected even when its primary owner matches', async () => {
	const saved = snapshot({ orgId: ORG, orgIds: [ORG, OTHER_ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage(), undefined);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('F16 a single-owner legacy snapshot migrates into scoped storage; only the start-up confirmation is requested', async () => {
	const saved = snapshot({ orgId: ORG, orgIds: [ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 71);
	assert.equal(env.stored(`claude_usage_state:${ORG}`).version, 2);
	assert.equal(env.calls.usageRequests.length, 1, 'one start-up confirmation (#15), no extra migration request');
});

test('F17 switching back restores only that organisation quota, before its fresh poll answers', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => ({ five_hour: liveWindow(40, START + HOUR) }) });
	env.answers.usage = async () => ({ five_hour: liveWindow(10, START + HOUR) });
	await switchOrg(env, OTHER_ORG);
	assert.equal(env.lastUsage().five_hour.utilization, 10);
	let complete;
	env.answers.usage = () => new Promise((resolve) => { complete = resolve; });
	await switchOrg(env, ORG);
	assert.equal(env.lastUsage().five_hour.utilization, 40, 'the snapshot of this organisation shows while its poll is pending');
	complete({ five_hour: liveWindow(42, START + HOUR) });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 42, 'then the fresh answer replaces it');
	assert.equal(env.stored(`claude_usage_state:${OTHER_ORG}`).usage.five_hour.utilization, 10);
});

test('F18 delayed discovery from stored settings cannot overwrite an organisation the cookie named meanwhile', async () => {
	let finish;
	const env = await createMainEnv({
		startMs: START, usage: emptyUsage,
		beforeStart: (e) => {
			const get = e.chrome.storage.local.get;
			e.chrome.storage.local.get = (keys, callback) => {
				if (keys.includes('claude_last_org_id')) finish = finish || callback;
				else get(keys, callback);
			};
		}
	});
	await switchOrg(env, OTHER_ORG); // the cookie appears while the remembered read is held
	finish({ claude_last_org_id: ORG });
	await env.clock.advance(3000);
	assert.equal(env.calls.usageRequests.at(-1).orgId, OTHER_ORG);
	assert.ok(env.calls.usageRequests.every((r) => r.orgId === OTHER_ORG));
});

test('F19 an enabled token count discards a previous organisation response too', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, showTokenCounter: true });
	let finish;
	env.answers.conversation = async (orgId) => orgId === ORG ? new Promise((resolve) => { finish = resolve; }) : { chat_messages: [{}], fakeTokens: 25 };
	const old = env.calls.uiOpts.onTokenCounterRefresh();
	await env.clock.flush();
	await switchOrg(env, OTHER_ORG);
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 25);
	finish({ chat_messages: [{}], fakeTokens: 999 });
	await old;
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 25);
});

// ---- #4: the optional token counter refreshes only on real changes -------------------------------

test('M28 history events that keep the same chat do not refetch the conversation', async () => {
	const env = await createMainEnv({ storage: orgStored, showTokenCounter: true, conversations: { [CONV]: { chat_messages: [{}], fakeTokens: 5 } }, startMs: START, usage: emptyUsage });
	const before = env.calls.conversationRequests.length;
	for (let i = 0; i < 3; i++) await env.navigate(`/chat/${CONV}`);
	env.window.dispatchEvent({ type: 'popstate' });
	await env.clock.flush();
	assert.equal(env.calls.conversationRequests.length, before);
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 5, 'the count stays on screen');
});

test('M29 a different chat, a branch switch and a finished reply still recount', async () => {
	const OTHER_CHAT = '11111111-2222-4333-8444-555555555555';
	const env = await createMainEnv({ storage: orgStored, showTokenCounter: true, conversations: { [CONV]: { chat_messages: [{}], fakeTokens: 5 }, [OTHER_CHAT]: { chat_messages: [{}], fakeTokens: 9 } }, startMs: START, usage: emptyUsage });
	let count = env.calls.conversationRequests.length;
	await env.navigate(`/chat/${OTHER_CHAT}`);
	assert.equal(env.calls.conversationRequests.length, ++count, 'chat change');
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 9);
	// A click elsewhere is not a branch switch (#13: the old fake matched any selector).
	const BRANCH = 'button[aria-label="Previous"], button[aria-label="Next"]';
	env.document.dispatchEvent({ type: 'click', target: { closest: () => null } });
	await env.clock.advance(600);
	assert.equal(env.calls.conversationRequests.length, count, 'an unrelated click');
	env.document.dispatchEvent({ type: 'click', target: { closest: (selector) => (selector === BRANCH ? {} : null) } });
	await env.clock.advance(600);
	assert.equal(env.calls.conversationRequests.length, ++count, 'branch switch');
	await env.emit('cc:turn_end', {});
	await env.clock.advance(1300);
	assert.equal(env.calls.conversationRequests.length, ++count, 'finished reply');
	await env.navigate(`/chat/${CONV}`);
	assert.equal(env.calls.conversationRequests.length, ++count, 'back to the first chat');
});
