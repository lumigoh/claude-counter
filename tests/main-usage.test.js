'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMainEnv, liveWindow, limitsEvent, ORG, CONV } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const orgStored = { claude_last_org_id: ORG };

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

test('M02d without a known organisation nothing can be asked, and it is retried each minute', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	assert.equal(env.calls.usageRequests.length, 0);
	await env.clock.advance(2 * MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 0);
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length >= 1, true);
});

test('M03 limits from a reply: bars get the values, they are saved with the organisation, /usage is not needed', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: [0.1, 86400] }));
	await env.clock.flush();

	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 20);
	assert.equal(Math.round(u.seven_day.utilization), 10);
	assert.equal(u.five_hour.resets_at, new Date(START + HOUR).toISOString());

	const saved = env.stored('claude_usage_state');
	assert.equal(saved.orgId, ORG);
	assert.equal(Math.round(saved.usage.five_hour.utilization), 20);

	const before = env.calls.usageRequests.length;
	await env.clock.advance(59 * MIN);
	assert.equal(env.calls.usageRequests.length, before, 'fresh limits postpone the hourly refresh');
});

test('M04 saved usage is restored on load, no request needed', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	const u = env.lastUsage();
	assert.equal(u.five_hour.utilization, 33);
	assert.equal(u.seven_day.utilization, 12);
	assert.equal(env.calls.usageRequests.length, 0);
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
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.76, 10], sevenD: [0.25, 86400] }));
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
	assert.deepEqual(env.stored('claude_usage_state').usage.five_hour, { expired: true });
});

test('M05b both windows can end, and a new reply starts a fresh window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.5, 5], sevenD: [0.5, 8] }));
	await env.clock.advance(10000);
	assert.deepEqual(env.lastUsage(), { five_hour: { expired: true }, seven_day: { expired: true } });

	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.02, 5 * 3600], sevenD: [0.3, 7 * 86400] }));
	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 2);
	assert.equal(Math.round(u.seven_day.utilization), 30);
});

test('M06 saved usage whose window ended while the page was closed shows 0%, and fresh data is asked for at once', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	// a paid plan: /usage knows the real value (used elsewhere, e.g. in another app)
	const env = await createMainEnv({
		storage: { ...orgStored, claude_usage_state: saved },
		startMs: START,
		usage: async () => ({ five_hour: { utilization: 63, resets_at: new Date(START + 4 * HOUR).toISOString() }, seven_day: null })
	});
	const first = env.lastUsage();
	assert.deepEqual(first.five_hour, { expired: true });
	assert.equal(first.seven_day.utilization, 12);
	assert.equal(env.calls.usageRequests.length, 0);

	await env.clock.advance(2000);
	assert.equal(env.calls.usageRequests.length, 1, 'asked on the first tick, not after an hour');
	assert.equal(env.lastUsage().five_hour.utilization, 63);
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M06b saved usage that is still live does not trigger a request', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(10, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 0);
});

test('M06c on the free plan the stale restore asks once and then waits an hour', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 1);
	assert.deepEqual(env.lastUsage().five_hour, { expired: true });
});

test('M07 /usage with nothing in it never wipes what is known or saved', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(61 * MIN); // an hourly refresh happens
	assert.ok(env.calls.usageRequests.length >= 1);
	assert.ok(env.stored('claude_usage_state').usage.seven_day, 'still saved');
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M08 a paid plan: /usage values are used, a missing window keeps the known one', async () => {
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => ({ five_hour: { utilization: 41, resets_at: new Date(START + HOUR).toISOString() }, seven_day: null })
	});
	assert.equal(env.lastUsage().five_hour.utilization, 41);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: null, sevenD: [0.5, 86400] }));
	assert.equal(env.lastUsage().five_hour.utilization, 41, 'a limits event with only one window keeps the other');
	assert.equal(Math.round(env.lastUsage().seven_day.utilization), 50);
});

test('M09 a limits event without windows changes nothing', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const before = env.calls.setUsage.length;
	await env.emit('cc:message_limit', { windows: {} });
	await env.emit('cc:message_limit', null);
	assert.equal(env.calls.setUsage.length, before);
});

// ---- persistence across reloads ----

const OTHER_ORG = '99999999-8888-4777-8666-555555555555';
const snapshot = (orgFields) => ({
	...orgFields,
	usage: { five_hour: liveWindow(71, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) }
});

test('M17 a snapshot saved under another id of the same account is restored (aliases)', async () => {
	const saved = snapshot({ orgId: OTHER_ORG, orgIds: [OTHER_ORG, ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 71);
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M17b a snapshot of a different account is not shown', async () => {
	const saved = snapshot({ orgId: OTHER_ORG, orgIds: [OTHER_ORG] });
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage(), undefined);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M18 windows the page does not know are filled in from the snapshot, known ones are kept', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: null }));
	assert.equal(env.lastUsage().five_hour.utilization, 20);
	assert.equal(env.lastUsage().seven_day, null);

	env.chrome.storage.local.set({ claude_usage_state: snapshot({ orgId: ORG, orgIds: [ORG] }) });
	await env.clock.flush();
	await env.clock.advance(11000);
	assert.equal(env.lastUsage().seven_day.utilization, 12, 'weekly filled in from the snapshot');
	assert.equal(env.lastUsage().five_hour.utilization, 20, 'the live value stays');
});

test('M18b the restore retry stops after two minutes', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: null }));
	await env.clock.advance(3 * MIN);
	env.chrome.storage.local.set({ claude_usage_state: snapshot({ orgId: ORG, orgIds: [ORG] }) });
	await env.clock.flush();
	await env.clock.advance(30000);
	assert.equal(env.lastUsage().seven_day, null);
});

test('M19 the snapshot is saved with every id seen on the page', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, cookie: `lastActiveOrg=${ORG}`, usage: emptyUsage });
	await env.emit('cc:org_detected', { orgId: OTHER_ORG });
	await env.emit('cc:message_limit', limitsEvent(START));
	await env.clock.flush();
	const saved = env.stored('claude_usage_state');
	assert.ok(saved.orgIds.includes(ORG) && saved.orgIds.includes(OTHER_ORG), JSON.stringify(saved.orgIds));
	assert.equal(saved.orgId, OTHER_ORG);
});

test('M20 reload on the other id: the account is recognised through the saved aliases', async () => {
	// first page load: the page's own requests use the other id, the cookie says ORG
	const first = await createMainEnv({ storage: orgStored, startMs: START, cookie: `lastActiveOrg=${ORG}`, usage: emptyUsage });
	await first.emit('cc:org_detected', { orgId: OTHER_ORG });
	await first.emit('cc:message_limit', limitsEvent(START));
	await first.clock.flush();
	const saved = first.stored('claude_usage_state');

	// second page load starts with the cookie id only, before any request reveals the other one
	const second = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START + MIN, cookie: `lastActiveOrg=${ORG}`, usage: emptyUsage });
	assert.equal(second.lastUsage().five_hour.utilization, 20);
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
