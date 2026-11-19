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
	assert.equal(env.lastUsage().five_hour.utilization, 7, 'an unlabelled stream opened before the switch is dropped');
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.08, 3600], sevenD: null }), { orgId: null, openedAt: env.clock.now });
	assert.equal(env.lastUsage().five_hour.utilization, 8, 'an unlabelled stream opened after the switch is accepted');
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

test('O12 a re-check answer that arrives after the cookie named another org is discarded (A3)', async () => {
	const fetch = heldFetch();
	const env = await createMainEnv({ storage: { claude_last_org_id: ORG }, startMs: START, usage: emptyUsage, fetch });
	fetch.fail(); // start-up list request
	await env.clock.flush();
	assert.equal(env.calls.usageRequests.at(-1).orgId, ORG);
	await env.emit('cc:org_detected', { orgId: B }); // starts a re-check
	assert.equal(fetch.calls(), 1);
	env.document.cookie = `lastActiveOrg=${C}`;
	await env.clock.advance(1000);
	await env.clock.flush();
	fetch.answer([{ uuid: ORG }, { uuid: B, active: true }]);
	await env.clock.advance(3000);
	assert.equal(env.stored('claude_last_org_id'), C);
	assert.equal(env.calls.usageRequests.filter((r) => r.orgId === B).length, 0, 'the stale answer never became active');
	assert.equal(env.calls.usageRequests.at(-1).orgId, C);
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
