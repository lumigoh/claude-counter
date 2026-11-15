'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../userscript/storage-adapter.js'), 'utf8');

function adapter(localStorage) {
	const pageChrome = { sentinel: true };
	const context = vm.createContext({ localStorage, chrome: pageChrome });
	const storage = vm.runInContext(`(() => { ${source}; return chrome.storage; })()`, context);
	assert.equal(context.chrome, pageChrome, 'the adapter must not change the page chrome object');
	return storage.local;
}

test('userscript snapshots survive a reload and use a namespaced storage key', async () => {
	const data = new Map();
	const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
	await adapter(storage).set({ claude_usage_state: { orgId: 'org-1', usage: { five_hour: { utilization: 42 } } } });
	assert.ok(data.has('claude-counter:userscript:claude_usage_state'));
	const result = await adapter(storage).get(['claude_usage_state']);
	assert.equal(result.claude_usage_state.usage.five_hour.utilization, 42);
});

test('userscript storage supports extension-style defaults and callbacks', async () => {
	const local = adapter({ getItem: () => null, setItem() {} });
	let received;
	await local.get({ claudeCounterEnabled: true }, (value) => { received = value; });
	assert.equal(received.claudeCounterEnabled, true);
	let saved = false;
	await local.set({ setting: false }, () => { saved = true; });
	assert.equal(saved, true);
	assert.equal((await local.get('setting')).setting, false);
});

test('userscript storage keeps working when the browser blocks localStorage', async () => {
	const local = adapter({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
	await local.set({ claude_last_org_id: 'org-2' });
	assert.equal((await local.get('claude_last_org_id')).claude_last_org_id, 'org-2');
});
