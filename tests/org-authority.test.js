'use strict';

// Regression tests for the 2.1.8 organisation model (components 1 + 2).
//
// The rule being tested: an organisation ID seen in a page request is only a *candidate*. The
// active organisation changes only when a trusted source says so (the lastActiveOrg cookie, the
// page's own saved setting, or an org list that explicitly marks one org active). Live streams are
// labelled with the organisation they were opened under, and the content script — which knows the
// active organisation — decides whether to accept them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMainEnv, liveWindow, limitsEvent, ORG } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const B = '99999999-8888-4777-8666-555555555555';
const emptyUsage = async () => ({ five_hour: null, seven_day: null });
const scoped = (orgId, pct) => ({ [`claude_usage_state:${orgId}`]: { version: 2, orgId, usage: { five_hour: liveWindow(pct, START + HOUR), seven_day: null } } });

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

/** Simulates the user picking another organisation in claude.ai: the page rewrites the cookie. */
async function switchCookie(env, orgId) {
	env.document.cookie = `lastActiveOrg=${orgId}`;
	await env.clock.advance(1000); // the once-a-second tick notices the change
	await env.clock.flush();
}

// ---- Component 1: the content script's view of the active organisation -----------------------

test('O01 incidental requests for another org never change the active org (cookie present)', async () => {
	const env = await createMainEnv({ storage: scoped(ORG, 40), cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	const setUsageCalls = env.calls.setUsage.length;
	for (let i = 0; i < 5; i++) {
		await env.emit('cc:org_detected', { orgId: B });
		await env.emit('cc:org_detected', { orgId: ORG });
	}
	await env.clock.advance(3000);
	assert.equal(env.calls.setUsage.length, setUsageCalls, 'the bars were never cleared or redrawn');
	assert.equal(env.calls.usageRequests.filter((r) => r.orgId === B).length, 0, 'the other org is never polled');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.41, 3600], sevenD: null }), { orgId: ORG, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 41, 'the active org stream is still accepted');
	assert.equal(env.stored('claude_last_org_id'), ORG);
});

test('O02 without a cookie, a candidate alone does not switch away from the known org', async () => {
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG, ...scoped(ORG, 40) }, startMs: START, usage: emptyUsage });
	let listRequests = 0;
	env.context.fetch = async () => { listRequests++; return { ok: true, json: async () => [{ uuid: ORG }, { uuid: B }] }; };
	for (let i = 0; i < 5; i++) await env.emit('cc:org_detected', { orgId: B });
	await env.clock.advance(3000);
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	assert.equal(env.calls.usageRequests.filter((r) => r.orgId === B).length, 0);
	assert.equal(listRequests, 1, 'one re-check of the org list, then rate limited');
});

test('O03 a genuine switch clears the screen, keeps snapshots, restores and polls the new org at once', async () => {
	const env = await createMainEnv({ storage: { ...scoped(ORG, 40), ...scoped(B, 7) }, cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	const requestsBefore = env.calls.usageRequests.length;
	await switchCookie(env, B);
	assert.ok(env.calls.setUsage.some((u) => u === null), 'the old org quota left the screen');
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'the new org snapshot is shown');
	assert.equal(env.calls.usageRequests.slice(requestsBefore).filter((r) => r.orgId === B).length, 1, 'the new org is polled immediately');
	assert.equal(env.stored(`claude_usage_state:${ORG}`).usage.five_hour.utilization, 40, 'the old snapshot is preserved');
	assert.equal(env.stored('claude_last_org_id'), B, 'the accepted org is remembered');
});

test('O04 after a genuine switch, the old org poll and old streams cannot reach the new org', async () => {
	const env = await createMainEnv({ storage: scoped(B, 7), cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	let complete;
	env.answers.usage = () => new Promise((resolve) => { complete = resolve; });
	const oldPoll = env.calls.uiOpts.onUsageRefresh();
	await env.clock.flush();
	await switchCookie(env, B);
	complete({ five_hour: { utilization: 55, resets_at: new Date(START + HOUR).toISOString() } });
	await oldPoll;
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'the late poll of the old org was dropped');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.66, 3600], sevenD: null }), { orgId: ORG, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'a stream labelled with the old org is dropped');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.67, 3600], sevenD: null }), { orgId: null, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'an unlabelled stream opened before the switch is not applied');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.08, 3600], sevenD: null }), { orgId: null, openedAt: env.clock.now });
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'nor one opened after it: unlabelled limits are never applied (#11)');
});

test('O05 A -> B -> A by genuine switches restores A and accepts A streams again', async () => {
	const env = await createMainEnv({ storage: { ...scoped(ORG, 40), ...scoped(B, 7) }, cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	await switchCookie(env, B);
	assert.equal(env.lastUsage().five_hour.utilization, 7);
	await switchCookie(env, ORG);
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.42, 3600], sevenD: null }), { orgId: ORG, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 42);
});

test('O06 without a cookie, an org list that marks another org active is a genuine switch', async () => {
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG, ...scoped(ORG, 40), ...scoped(B, 7) }, startMs: START, usage: emptyUsage });
	env.context.fetch = async () => ({ ok: true, json: async () => [{ uuid: ORG, active: false }, { uuid: B, active: true }] });
	await env.emit('cc:org_detected', { orgId: B });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 7);
});

test('O07 the remembered org is written once when the active org is accepted, not on every request', async () => {
	let writes = 0;
	const env = await createMainEnv({
		cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage,
		beforeStart: (e) => {
			const set = e.chrome.storage.local.set;
			e.chrome.storage.local.set = (items, cb) => { if ('claude_last_org_id' in items) writes++; return set(items, cb); };
		}
	});
	assert.equal(writes, 1, 'start-up acceptance remembers the org');
	assert.equal(env.stored('claude_last_org_id'), ORG);
	for (let i = 0; i < 10; i++) await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(writes, 1, 'requests mentioning the org do not rewrite it');
});

test('O08 an org list entry is identified by its uuid (a numeric id is not an org ID)', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	// Two orgs, so the sole-org fallback cannot hide an ignored `active` flag.
	env.context.fetch = async () => ({ ok: true, json: async () => [{ id: 777, uuid: B }, { id: 12345, uuid: ORG, active: true }] });
	await env.calls.uiOpts.onUsageRefresh();
	assert.equal(env.calls.usageRequests.at(-1).orgId, ORG);
});

test('O09 a labelled reply that arrives before start-up resolved the org is not lost when the cookie names it', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	env.document.cookie = `lastActiveOrg=${ORG}`;
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.3, 3600], sevenD: null }), { orgId: ORG, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 30);
});

// ---- 2.1.8 post-audit A (#10): one validated source chain, deduplicated and race-safe ------------

const C = 'cccccccc-3333-4333-8333-333333333333';
const list = (...orgs) => async () => ({ ok: true, json: async () => orgs });
/** A fetch whose answers the test hands out one by one; `calls` counts requests. */
function heldFetch() {
	const pending = [];
	const fn = async () => new Promise((resolve) => pending.push(resolve));
	fn.calls = () => pending.length;
	fn.answer = (orgs) => pending.shift()({ ok: true, json: async () => orgs });
	fn.fail = () => pending.shift()({ ok: false });
	return fn;
}

test('O10 an invalid remembered org (2.1.7 stored route words) no longer blocks start-up (A1)', async () => {
	const env = await createMainEnv({ storage: { claude_last_org_id: 'discoverable' }, startMs: START, usage: emptyUsage, fetch: list({ uuid: ORG }, { uuid: B }) });
	assert.equal(env.calls.usageRequests.length, 0, 'nothing trusted yet: no org, no poll');
	assert.equal(env.stored('claude_last_org_id'), null, 'the invalid value is dropped');
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.at(-1)?.orgId, ORG, 'the candidate bootstraps');
	assert.equal(env.stored('claude_last_org_id'), ORG);

	const single = await createMainEnv({ storage: { claude_last_org_id: 'discoverable' }, startMs: START, usage: emptyUsage, fetch: list({ uuid: B }) });
	assert.equal(single.calls.usageRequests.at(-1)?.orgId, B, 'the sole org bootstraps');
});

test('O11 an org list that marks one org active beats the remembered org at start-up (A2)', async () => {
	const env = await createMainEnv({ storage: { claude_last_org_id: B }, startMs: START, usage: emptyUsage, fetch: list({ uuid: B }, { uuid: ORG, active: true }) });
	assert.deepEqual(env.calls.usageRequests.map((r) => r.orgId), [ORG]);
	assert.equal(env.stored('claude_last_org_id'), ORG);
});

test('O12a a re-check answer is discarded when a trusted source spoke meanwhile, before any switch (A3, #15)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: emptyUsage, fetch });
	fetch.fail(); // start-up list request
	await env.clock.flush();
	await env.emit('cc:org_detected', { orgId: B }); // starts a re-check
	env.document.cookie = `lastActiveOrg=${C}`; // no tick yet: the revision is unchanged
	fetch.answer([{ uuid: ORG }, { uuid: B, active: true }]);
	await env.clock.flush();
	assert.ok(!env.calls.orgs.includes(B), 'the stale list answer never became active');
	await env.clock.advance(1000);
	assert.equal(env.stored('claude_last_org_id'), C);
});

test('O12b a re-check answer is discarded when the org changed meanwhile, even with no trusted source now (A3, #15)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: emptyUsage, fetch });
	fetch.fail();
	await env.clock.flush();
	await env.emit('cc:org_detected', { orgId: B });
	env.document.cookie = `lastActiveOrg=${C}`;
	await env.clock.advance(1000); // the tick accepts C: the revision changes
	env.document.cookie = ''; // and the cookie is unreadable again
	fetch.answer([{ uuid: ORG }, { uuid: B, active: true }]);
	await env.clock.flush();
	assert.ok(!env.calls.orgs.includes(B));
	assert.equal(env.stored('claude_last_org_id'), C);
});

test('O13 concurrent start-up resolution shares one org list request and uses the first candidate (A4)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, fetch });
	assert.equal(fetch.calls(), 1, 'start-up asks once');
	await env.emit('cc:org_detected', { orgId: ORG });
	for (let i = 0; i < 19; i++) await env.emit('cc:org_detected', { orgId: B });
	assert.equal(fetch.calls(), 1, 'candidates join the request in flight');
	fetch.answer([{ uuid: ORG }, { uuid: B }]);
	await env.clock.flush();
	assert.equal(env.stored('claude_last_org_id'), ORG, 'the first candidate, not the latest');
});

test('O14 bootstrapping from a candidate polls usage at once (A5)', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.at(-1)?.orgId, ORG);
});

test('O15 page storage keys are validated separately (A6)', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, pageStorage: { lastActiveOrg: 'not an id', currentOrganizationId: ORG } });
	assert.equal(env.calls.usageRequests.at(-1)?.orgId, ORG);
});

test('O16 a differing candidate during the re-check cooldown schedules one re-check at expiry (A7)', async () => {
	let answer = [{ uuid: ORG, active: true }, { uuid: B }];
	let listRequests = 0;
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, fetch: async () => { listRequests++; return { ok: true, json: async () => answer }; } });
	assert.equal(env.stored('claude_last_org_id'), ORG);
	const startup = listRequests;
	await env.emit('cc:org_detected', { orgId: B });
	await env.clock.flush();
	assert.equal(listRequests - startup, 1, 'first re-check');
	answer = [{ uuid: ORG }, { uuid: B, active: true }]; // the user switches org; no cookie
	await env.clock.advance(MIN);
	await env.emit('cc:org_detected', { orgId: B });
	await env.emit('cc:org_detected', { orgId: B });
	await env.clock.flush();
	assert.equal(listRequests - startup, 1, 'still cooling down');
	await env.clock.advance(4 * MIN + 1000);
	assert.equal(listRequests - startup, 2, 'exactly one re-check at expiry');
	assert.equal(env.stored('claude_last_org_id'), B);
});

test('O17 an event labelled with the newly chosen org is applied within the tick lag (A8)', async () => {
	const env = await createMainEnv({ cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	env.document.cookie = `lastActiveOrg=${B}`; // no tick yet
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.33, 3600], sevenD: null }), { orgId: B, openedAt: START });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 33);
	assert.ok(env.stored(`claude_usage_state:${B}`));
});

// ---- 2.1.8 post-audit B (#11): unlabelled limits are never applied or saved -----------------------

test('O18 an unlabelled reading is neither shown nor saved under the active org; it only prompts a poll (B1)', async () => {
	// A paid plan: /usage answers with the org's own value, so a reply poll is not under free-plan backoff.
	const paid = async () => ({ five_hour: liveWindow(40, START + HOUR), seven_day: null });
	const env = await createMainEnv({ storage: scoped(ORG, 40), cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: paid });
	await env.clock.advance(6000);
	const before = env.calls.usageRequests.length;
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.77, 3600], sevenD: null }), { orgId: null, openedAt: START });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.78, 3600], sevenD: null })); // no meta at all
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	assert.equal(env.stored(`claude_usage_state:${ORG}`).usage.five_hour.utilization, 40, 'not saved under the active org');
	assert.equal(env.calls.usageRequests.length, before + 1, 'one org-scoped poll instead');
	assert.equal(env.calls.usageRequests.at(-1).orgId, ORG);
	const reloaded = await createMainEnv({ storage: env.storageData, cookie: `lastActiveOrg=${ORG}`, startMs: START + MIN, usage: paid });
	assert.equal(reloaded.lastUsage().five_hour.utilization, 40, 'and still not after a reload');
});

test('O19 an unlabelled reading before the org is known is not saved once it is (B3)', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.77, 3600], sevenD: [0.5, 86400] }), { orgId: null, openedAt: START });
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.advance(2000);
	assert.ok(!env.calls.setUsage.some((u) => u?.five_hour?.utilization === 77), 'never shown');
	assert.equal(env.stored(`claude_usage_state:${ORG}`), undefined, 'never saved');
});

test('O20 end to end: after a cookie switch the old org stream is rejected and the new one applied', async () => {
	const proto = require('./helpers/proto');
	const { createBridgeEnv, settle, STREAM_URL } = require('./helpers/bridge-harness');
	const brain = await createMainEnv({ cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	const streams = [];
	const bridge = createBridgeEnv({
		cookie: `lastActiveOrg=${ORG}`,
		originalFetch: async () => {
			let controller;
			streams.push({ push: (b) => controller.enqueue(b) });
			return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'application/connect+proto' } });
		}
	});
	let forwarded = 0;
	const forward = async () => {
		for (const m of bridge.messages.slice(forwarded)) if (m.cc === 'ClaudeCounter') await brain.emit(m.type, m.payload, m.meta);
		forwarded = bridge.messages.length;
		await brain.clock.flush();
	};
	const frame = (cursor, pct) => proto.connectFrame(0, proto.limitsPayload({ cursor, windows: [['5h', 1, Math.floor(START / 1000) + 3600, pct]] }));
	await bridge.fetch(STREAM_URL, { method: 'POST' }); // opened under ORG
	streams[0].push(frame('2000-1', 0.4)); await settle(); await forward();
	assert.equal(brain.lastUsage().five_hour.utilization, 40);

	bridge.document.cookie = `lastActiveOrg=${B}`;
	await switchCookie(brain, B);
	await bridge.fetch(STREAM_URL, { method: 'POST' }); // opened under B
	streams[0].push(frame('2000-2', 0.45)); await settle(); await forward();
	assert.notEqual(brain.lastUsage()?.five_hour?.utilization, 45, 'the old org stream is rejected');
	streams[1].push(frame('2000-1', 0.05)); await settle(); await forward();
	assert.equal(brain.lastUsage().five_hour.utilization, 5, 'the new org stream is applied');
	assert.equal(brain.stored(`claude_usage_state:${ORG}`).usage.five_hour.utilization, 40);
});

test('O21 a turn end labelled with another org does not recount; the active org and unlabelled ones do (B5)', async () => {
	const { CONV } = require('./helpers/main-harness');
	const env = await createMainEnv({ cookie: `lastActiveOrg=${ORG}`, showTokenCounter: true, conversations: { [CONV]: { chat_messages: [{}], fakeTokens: 5 } }, startMs: START, usage: emptyUsage });
	const count = () => env.calls.conversationRequests.length;
	let before = count();
	await env.emit('cc:turn_end', {}, { orgId: B, openedAt: START });
	await env.clock.advance(15000);
	assert.equal(count(), before, 'another org');
	before = count();
	await env.emit('cc:turn_end', {}, { orgId: ORG, openedAt: START });
	await env.clock.advance(1300);
	assert.equal(count(), before + 1, 'the active org');
	before = count();
	await env.clock.advance(15000);
	before = count();
	await env.emit('cc:turn_end', {}, { orgId: null, openedAt: START });
	await env.clock.advance(1300);
	assert.equal(count(), before + 1, 'unlabelled still recounts (owner decision, #11)');
});

test('O22 a late poll of the previous org cannot pass as a new window after the new org window expires', async () => {
	let completeA;
	const env = await createMainEnv({ cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	env.answers.usage = (orgId) => (orgId === ORG ? new Promise((resolve) => { completeA = resolve; }) : emptyUsage());
	const oldPoll = env.calls.uiOpts.onUsageRefresh();
	await env.clock.flush();
	await switchCookie(env, B);
	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.1, 600], sevenD: null }), { orgId: B, openedAt: env.clock.now });
	assert.equal(env.lastUsage().five_hour.utilization, 10);
	await env.clock.advance(11 * MIN); // B's window reaches its reset time
	completeA({ five_hour: { utilization: 55, resets_at: new Date(env.clock.now + 2 * HOUR).toISOString() } });
	await oldPoll;
	await env.clock.flush();
	assert.notEqual(env.lastUsage()?.five_hour?.utilization, 55, 'the old org reading never reaches the new org');
	assert.notEqual(env.stored(`claude_usage_state:${B}`)?.usage?.five_hour?.utilization, 55, 'nor its saved snapshot');
});

// ---- targeted review (#15): bootstrap never blocks on the network; candidates are not lost ------

test('O23 a stalled org list does not block start-up: the remembered org shows after 2 s and a late list can correct it (A2)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG, ...scoped(ORG, 40) }, startMs: START, usage: emptyUsage, fetch });
	assert.equal(env.calls.usageRequests.length, 0, 'nothing chosen while the list may still answer');
	await env.clock.advance(2000);
	assert.equal(env.lastUsage().five_hour.utilization, 40, 'the remembered org snapshot shows');
	assert.equal(env.calls.usageRequests.at(-1)?.orgId, ORG, 'and is confirmed by a poll');
	fetch.answer([{ uuid: ORG }, { uuid: B, active: true }]); // the list finally answers
	await env.clock.flush();
	assert.equal(env.stored('claude_last_org_id'), B, 'its trusted answer corrects the fallback');
	assert.equal(env.calls.usageRequests.at(-1).orgId, B);
});

test('O24 a cookie that appears while the start-up list is pending beats the list answer (A3)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: emptyUsage, fetch });
	env.document.cookie = `lastActiveOrg=${C}`; // no tick yet
	fetch.answer([{ uuid: ORG }, { uuid: B, active: true }]);
	await env.clock.flush();
	assert.equal(env.stored('claude_last_org_id'), C);
	assert.ok(!env.calls.orgs.includes(B));
	assert.ok(env.calls.usageRequests.every((r) => r.orgId === C));
});

test('O25 a candidate seen while a re-check is in flight is re-checked at cooldown expiry (A7)', async () => {
	const answers = [];
	let held = null;
	const fetch = async () => {
		const next = answers.shift();
		if (next === 'hold') return new Promise((resolve) => { held = resolve; });
		return { ok: true, json: async () => next };
	};
	answers.push([{ uuid: ORG, active: true }, { uuid: B }, { uuid: C }]); // start-up
	answers.push('hold'); // re-check started by B
	answers.push([{ uuid: ORG }, { uuid: B }, { uuid: C, active: true }]); // the later re-check
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, fetch });
	assert.equal(env.stored('claude_last_org_id'), ORG);
	await env.emit('cc:org_detected', { orgId: B });
	await env.emit('cc:org_detected', { orgId: C }); // the user moved to C, no cookie
	held({ ok: true, json: async () => [{ uuid: ORG, active: true }, { uuid: B }, { uuid: C }] }); // the old selection
	await env.clock.flush();
	assert.equal(env.stored('claude_last_org_id'), ORG);
	await env.clock.advance(5 * MIN + 1000);
	assert.equal(env.stored('claude_last_org_id'), C, 'C was not lost');
});

test('O27 a candidate bootstrap with a complete snapshot still polls at once (A5)', async () => {
	const both = { [`claude_usage_state:${ORG}`]: { version: 2, orgId: ORG, usage: { five_hour: liveWindow(40, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } } };
	const env = await createMainEnv({ storage: both, startMs: START, usage: emptyUsage });
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 40);
	assert.equal(env.calls.usageRequests.filter((r) => r.orgId === ORG).length, 1);
});

test('O29 a switch while a restore is still reading storage restores the new org too (#15)', async () => {
	const env = await createMainEnv({ storage: { ...scoped(ORG, 40), ...scoped(B, 7) }, cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	const get = env.chrome.storage.local.get;
	const held = [];
	env.chrome.storage.local.get = (keys, cb) => held.push(() => get(keys, cb));
	await env.clock.advance(11000); // past start-up; storage reads are now held
	env.document.cookie = `lastActiveOrg=${B}`;
	await env.clock.advance(1000);
	while (held.length) { held.shift()(); await env.clock.flush(); }
	assert.equal(env.lastUsage().five_hour.utilization, 7);
});

// ---- targeted review (#16): every unlabelled reply gets a poll that starts after it ----------------

test('O26 an unlabelled reply right after a poll gets its own poll, coalesced, ~5 s after the last one (B2)', async () => {
	let value = 42;
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: async () => ({ five_hour: liveWindow(value, START + HOUR), seven_day: null }) });
	await env.clock.advance(60 * 1000);
	await env.calls.uiOpts.onUsageRefresh(); // a successful poll at t
	assert.equal(env.lastUsage().five_hour.utilization, 42);
	const before = env.calls.usageRequests.length;
	value = 51; // the reply used quota
	await env.clock.advance(1000);
	for (let i = 0; i < 3; i++) await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.51, 3600], sevenD: null }), { orgId: null, openedAt: START });
	await env.clock.advance(3000);
	assert.equal(env.calls.usageRequests.length, before, 'not before 5 s after the last request');
	await env.clock.advance(1100);
	assert.equal(env.calls.usageRequests.length, before + 1, 'one poll for the burst');
	assert.equal(env.lastUsage().five_hour.utilization, 51);
	await env.clock.advance(60 * 1000);
	assert.equal(env.calls.usageRequests.length, before + 1, 'and no more');
});

test('O30 a reply during a poll that started before it gets a follow-up poll (B2)', async () => {
	let value = 42;
	let complete;
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: async () => ({ five_hour: liveWindow(value, START + HOUR), seven_day: null }) });
	await env.clock.advance(60 * 1000);
	env.answers.usage = () => new Promise((resolve) => { complete = resolve; });
	const poll = env.calls.uiOpts.onUsageRefresh(); // in flight, started before the reply
	await env.clock.flush();
	const before = env.calls.usageRequests.length;
	await env.clock.advance(1000);
	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.51, 3600], sevenD: null }), { orgId: null, openedAt: START });
	complete({ five_hour: liveWindow(42, START + HOUR), seven_day: null }); // answer from before the reply
	await poll;
	env.answers.usage = async () => ({ five_hour: liveWindow(51, START + HOUR), seven_day: null });
	await env.clock.advance(6000);
	assert.equal(env.calls.usageRequests.length, before + 1);
	assert.equal(env.lastUsage().five_hour.utilization, 51);
});

test('O28 a labelled turn end that arrives before the first org is accepted still recounts (B5)', async () => {
	let messages = [{}];
	const fetch = heldFetch();
	const env = await createMainEnv({ startMs: START, usage: emptyUsage, fetch, showTokenCounter: true, conversations: {} });
	env.answers.conversation = async () => ({ chat_messages: messages });
	env.document.cookie = `lastActiveOrg=${ORG}`; // readable now, not yet accepted
	await env.emit('cc:turn_end', {}, { orgId: ORG, openedAt: START });
	await env.clock.flush();
	messages = [{}, {}]; // the reply is stored
	await env.clock.advance(4000); // the org resolves (≤ 2 s), then the turn-end recount runs 1.2 s later
	assert.ok(env.calls.conversationRequests.length >= 2, `recounted after the turn (${env.calls.conversationRequests.length} requests)`);
	assert.equal(env.calls.tokenStates.at(-1).totalTokens, 20);
});
