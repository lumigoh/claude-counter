'use strict';

// Regression tests for 2.1.8 component 2 (issue #2): the bridge labels each live stream with the
// organisation it was opened under and the time it opened. It no longer drops streams itself when
// some other organisation ID is seen; the content script, which knows the active organisation,
// decides (see tests/org-authority.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const proto = require('./helpers/proto');
const { createBridgeEnv, streamResponse, readAll, settle, STREAM_URL } = require('./helpers/bridge-harness');

const ORG = 'fda3f0e1-4fb4-4c97-97f9-c2274f34ec6d';
const B = '99999999-8888-4777-8666-555555555555';

// ---- Component 2: streams are labelled by organisation, not by a global counter ---------------

const quotaFrame = (cursor, pct) => proto.connectFrame(0, proto.limitsPayload({ cursor, windows: [['5h', 1, 1791749400, pct]] }));
const limitMessages = (env) => env.messages.filter((m) => m.type === 'cc:message_limit');

function streamingEnv(cookie, nowMs) {
	const streams = [];
	const env = createBridgeEnv({
		cookie,
		nowMs,
		originalFetch: async (url) => {
			if (!String(url).includes('StreamTimeline')) return new Response('{}');
			let controller;
			const body = new ReadableStream({ start(c) { controller = c; } });
			streams.push({ push: (b) => controller.enqueue(b), close: () => controller.close() });
			return new Response(body, { headers: { 'content-type': 'application/connect+proto' } });
		}
	});
	return { env, streams };
}

test('S01 incidental requests for another org do not silence an open stream', async () => {
	const { env, streams } = streamingEnv(`lastActiveOrg=${ORG}`);
	await env.fetch(STREAM_URL, { method: 'POST' });
	streams[0].push(quotaFrame('2000-1', 0.4)); await settle();
	await env.fetch(`https://claude.ai/api/organizations/${B}/members`);
	await env.fetch(`https://claude.ai/api/organizations/${ORG}/usage`);
	streams[0].push(quotaFrame('2000-2', 0.41)); await settle();
	assert.deepEqual(limitMessages(env).map((m) => m.payload.windows['5h'].utilization), [0.4, 0.41]);
	assert.ok(limitMessages(env).every((m) => m.meta.orgId === ORG), 'labelled with the org it was opened under');
});

test('S02 A -> B -> A: the stream opened under A keeps its A label and keeps delivering', async () => {
	const { env, streams } = streamingEnv(`lastActiveOrg=${ORG}`);
	await env.fetch(STREAM_URL, { method: 'POST' });
	env.document.cookie = `lastActiveOrg=${B}`;
	await env.fetch(STREAM_URL, { method: 'POST' });
	streams[1].push(quotaFrame('2000-1', 0.1)); await settle();
	env.document.cookie = `lastActiveOrg=${ORG}`;
	streams[0].push(quotaFrame('2000-1', 0.4)); await settle();
	assert.deepEqual(limitMessages(env).map((m) => [m.meta.orgId, m.payload.windows['5h'].utilization]), [[B, 0.1], [ORG, 0.4]],
		'cursors are kept per organisation, and the old stream is not dropped by the bridge');
});

test('S03 every stream message carries the time its stream was opened', async () => {
	const opened = 1791743968000;
	const { env, streams } = streamingEnv('', opened); // pinned clock: the exact open time is known
	await env.fetch(STREAM_URL, { method: 'POST' });
	streams[0].push(quotaFrame('2000-1', 0.4)); await settle();
	const [message] = limitMessages(env);
	assert.equal(message.meta.orgId, null, 'no cookie: the stream is honestly unlabelled');
	assert.equal(message.meta.openedAt, opened);
});

test('S04 a legacy completion stream is labelled with the organisation in its own URL', async () => {
	const sse = `data: ${JSON.stringify({ type: 'message_limit', windows: { '5h': { utilization: 0.3, resets_at: 1791749400 } } })}\n\n`;
	const env = createBridgeEnv({ cookie: `lastActiveOrg=${ORG}`, originalFetch: async () => streamResponse([Buffer.from(sse)], { contentType: 'text/event-stream' }) });
	await readAll(await env.fetch(`https://claude.ai/api/organizations/${B}/chat_conversations/c/completion`, { method: 'POST' }));
	await settle();
	assert.equal(limitMessages(env)[0].meta.orgId, B);
});

test('S05 unlabelled streams keep separate cursors: a late frame of one cannot hide another (B4)', async () => {
	const { env, streams } = streamingEnv('');
	await env.fetch(STREAM_URL, { method: 'POST' }); // org A's tab, cookie unreadable
	await env.fetch(STREAM_URL, { method: 'POST' }); // org B's stream
	streams[0].push(quotaFrame('3000-1', 0.4)); await settle();
	streams[1].push(quotaFrame('2000-1', 0.1)); await settle();
	assert.deepEqual(limitMessages(env).map((m) => m.payload.windows['5h'].utilization), [0.4, 0.1]);
	streams[0].push(quotaFrame('2500-1', 0.39)); await settle();
	assert.equal(limitMessages(env).length, 2, 'within one stream the watermark still holds');
	// The same event id in two unlabelled streams is not a replay across them (#17).
	streams[0].push(quotaFrame('4000-7', 0.41)); await settle();
	streams[1].push(quotaFrame('4000-7', 0.11)); await settle();
	assert.deepEqual(limitMessages(env).slice(-2).map((m) => m.payload.windows['5h'].utilization), [0.41, 0.11]);
});

test('S06 turn ends carry their stream label, on Connect and legacy streams (B5)', async () => {
	const opened = 1791743968000;
	const { env, streams } = streamingEnv(`lastActiveOrg=${ORG}`, opened);
	await env.fetch(STREAM_URL, { method: 'POST' });
	streams[0].push(proto.connectFrame(0, proto.limitsPayload({ cursor: `${opened + 1000}-0`, windows: [['5h', 1, 1791749400, 0.4]] }))); await settle();
	const ends = env.messages.filter((m) => m.type === 'cc:turn_end');
	assert.deepEqual(ends.map((m) => m.meta), [{ orgId: ORG, openedAt: opened }]);

	const sse = `data: ${JSON.stringify({ type: 'message_limit', windows: { '5h': { utilization: 0.3, resets_at: 1791749400 } } })}\n\n`;
	const legacy = createBridgeEnv({ cookie: `lastActiveOrg=${ORG}`, nowMs: opened, originalFetch: async () => streamResponse([Buffer.from(sse)], { contentType: 'text/event-stream' }) });
	await readAll(await legacy.fetch(`https://claude.ai/api/organizations/${B}/chat_conversations/c/completion`, { method: 'POST' }));
	await settle();
	assert.deepEqual(legacy.messages.filter((m) => m.type === 'cc:turn_end').map((m) => m.meta), [{ orgId: B, openedAt: opened }]);
});

test('S07 unlabelled stream churn cannot evict a labelled org\'s cursors (B4, #16)', async () => {
	const { env, streams } = streamingEnv(`lastActiveOrg=${ORG}`);
	const both = (cursor, pct) => proto.connectFrame(0, proto.limitsPayload({ cursor, windows: [['5h', 1, 1791749400, pct], ['7d', 1, 1791990000, pct]] }));
	await env.fetch(STREAM_URL, { method: 'POST' });
	streams[0].push(both('3000-1', 0.4)); await settle();
	env.document.cookie = ''; // 65 tabs or reconnects without a readable cookie
	for (let i = 0; i < 65; i++) {
		await env.fetch(STREAM_URL, { method: 'POST' });
		streams.at(-1).push(both(`${5000 + i}-1`, 0.2));
	}
	await settle(60);
	env.document.cookie = `lastActiveOrg=${ORG}`;
	await env.fetch(STREAM_URL, { method: 'POST' });
	const before = limitMessages(env).length;
	streams.at(-1).push(both('2000-1', 0.39)); await settle();
	assert.equal(limitMessages(env).length, before, 'the older labelled frame is still rejected');
});
