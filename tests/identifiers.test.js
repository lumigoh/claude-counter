'use strict';

// 2.1.8 component 5 (#5): organisation IDs are checked before they are used as candidates or
// trusted values, and every ID is encoded when it becomes part of a URL. The check is deliberately
// permissive (it does not assume UUIDs): URL-safe characters, a bounded length, at least one digit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBridgeEnv, settle } = require('./helpers/bridge-harness');
const { createMainEnv, ORG } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const emptyUsage = async () => ({ five_hour: null, seven_day: null });

test('I01 only plausible IDs after /api/organizations/ are reported as candidates', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('{}') });
	for (const url of [
		'https://claude.ai/api/organizations/discoverable',
		'https://claude.ai/api/organizations/abc/x',
		'https://claude.ai/api/organizations/%2e%2e/usage',
		`https://claude.ai/api/organizations/${'1'.repeat(200)}/usage`,
		`https://claude.ai/api/organizations/${ORG}/usage`,
		'https://claude.ai/api/organizations/org_01ABCDEF23/usage'
	]) await env.fetch(url);
	assert.deepEqual(env.events('cc:org_detected').map((p) => p.orgId), [ORG, 'org_01ABCDEF23']);
});

test('I02 the bridge encodes IDs when it builds request URLs', async () => {
	const urls = [];
	const env = createBridgeEnv({ originalFetch: async (url) => { urls.push(String(url)); return new Response('{"uuid":"x"}', { headers: { 'content-type': 'application/json' } }); } });
	env.request('usage', { orgId: 'a/b?c#d' });
	env.request('conversation', { orgId: 'a/b', conversationId: 'c?d' });
	await settle();
	assert.deepEqual(urls, [
		'https://claude.ai/api/organizations/a%2Fb%3Fc%23d/usage',
		'https://claude.ai/api/organizations/a%2Fb/chat_conversations/c%3Fd?tree=true&rendering_mode=messages&render_all_tools=true'
	]);
});

test('I03 implausible candidates and cookie values never become the active org', async () => {
	const env = await createMainEnv({ cookie: 'lastActiveOrg=..%2F..', startMs: START, usage: emptyUsage });
	await env.emit('cc:org_detected', { orgId: 'discoverable' });
	await env.clock.advance(61 * 1000);
	assert.equal(env.calls.usageRequests.length, 0, 'nothing plausible is known, so nothing is requested');
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.advance(61 * 1000);
	assert.equal(env.calls.usageRequests.at(-1).orgId, ORG);
});
