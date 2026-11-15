'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContentEnv } = require('./helpers/content-harness');

test('freshness organisation metadata reaches subscribers without changing the usage payload', async () => {
	const env = createContentEnv({ files: ['content/bridge-client.js'] });
	let received;
	env.context.ClaudeCounter.bridge.on('cc:message_limit', (payload, meta) => { received = { payload, meta }; });
	const payload = { windows: { '5h': { utilization: 0.4 } } };
	env.send({ type: 'cc:message_limit', payload, meta: { orgId: 'org-a' } });
	await env.settle();
	assert.equal(received.payload, payload);
	assert.deepEqual(received.meta, { orgId: 'org-a' });
	env.send({ type: 'cc:message_limit', payload });
	await env.settle();
	assert.equal(received.meta, undefined, 'older bridges without metadata remain compatible');
});
