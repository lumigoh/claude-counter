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
	assert.ok(listRequests <= 1, 'the org list re-check is rate limited');
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

test('O07 the remembered org is written only when the active org is accepted, not on every request', async () => {
	const env = await createMainEnv({ cookie: `lastActiveOrg=${ORG}`, startMs: START, usage: emptyUsage });
	let writes = 0;
	const set = env.chrome.storage.local.set;
	env.chrome.storage.local.set = (items, cb) => { if ('claude_last_org_id' in items) writes++; return set(items, cb); };
	for (let i = 0; i < 10; i++) await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(writes, 0);
});

test('O08 an org list entry is identified by its uuid (a numeric id is not an org ID)', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	env.context.fetch = async () => ({ ok: true, json: async () => [{ id: 12345, uuid: ORG, active: true }] });
	await env.calls.uiOpts.onUsageRefresh();
	assert.equal(env.calls.usageRequests.at(-1).orgId, ORG);
});

test('O09 a labelled reply that arrives before start-up resolved the org is not lost when the cookie names it', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	env.document.cookie = `lastActiveOrg=${ORG}`;
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.3, 3600], sevenD: null }), { orgId: ORG, openedAt: START });
	assert.equal(env.lastUsage().five_hour.utilization, 30);
});
