'use strict';

// Runs the real src/content/main.js with a stub UI, a stub bridge and a manual clock. The stubs
// record what main.js asks for, so tests can check the behaviour without a browser.

const { createContentEnv } = require('./content-harness');
const { createClock } = require('./fake-clock');

const ORG = 'fda3f0e1-4fb4-4c97-97f9-c2274f34ec6d';
const CONV = 'd017d8c7-6458-4449-884f-64980589c699';

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Options for start-up behaviour (2.1.8 post-audit, #10):
//   pageStorage  claude.ai's own localStorage entries (lastActiveOrg, currentOrganizationId)
//   fetch        the page fetch used by main.js (org list, direct /usage fallback) from start-up on
//   beforeStart  called with the env before main.js loads, e.g. to install storage spies
async function createMainEnv({ storage = {}, pathname = `/chat/${CONV}`, cookie = '', usage, conversations = {}, showTokenCounter = false, startMs, pageStorage, fetch, beforeStart } = {}) {
	const clock = createClock(startMs);
	const calls = { setUsage: [], setMetrics: [], titles: [], pending: [], uiOpts: null, usageRequests: [], conversationRequests: [], tokenStates: [], tokenizerLoads: [] };
	const handlers = {};

	// What the bridge answers. Tests replace these.
	const answers = {
		usage: usage || (async () => ({ five_hour: null, seven_day: null })),
		conversation: async (orgId, conversationId) => conversations[conversationId] || null
	};

	const bridge = {
		on(type, fn) {
			(handlers[type] = handlers[type] || []).push(fn);
			return () => {};
		},
		async requestUsage(orgId) {
			calls.usageRequests.push({ at: clock.now, orgId });
			return answers.usage(orgId);
		},
		async requestConversation(orgId, conversationId) {
			calls.conversationRequests.push({ at: clock.now, orgId, conversationId });
			return answers.conversation(orgId, conversationId);
		},
		async requestHash() {
			return null;
		}
	};

	async function emit(type, payload, meta) {
		for (const fn of handlers[type] || []) await fn(payload, meta);
	}

	class StubUI {
		constructor(opts) {
			this.opts = opts;
			calls.uiOpts = opts;
		}
		setTokenCounter(state) { calls.tokenStates.push(clone(state)); }
		setOrg(orgId) { calls.orgs = [...(calls.orgs || []), orgId]; }
		initialize() {}
		attachUsageLine() {}
		attachHeader() {}
		tick() {}
		setUsage(usage) {
			calls.setUsage.push(clone(usage));
		}
		setConversationMetrics(m) {
			calls.setMetrics.push(clone(m));
		}
		setPendingCache(p) {
			calls.pending.push(p);
		}
		setConversationTitle(name) {
			calls.titles.push(name);
		}
	}

	const env = createContentEnv({
		files: ['content/config.js', 'content/constants.js'],
		storage,
		pathname,
		extraGlobals: {
			Date: clock.Date,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
			MutationObserver: class {
				observe() {}
				disconnect() {}
			},
			...(pageStorage ? { localStorage: { getItem: (key) => (key in pageStorage ? pageStorage[key] : null) } } : {}),
			...(fetch ? { fetch } : {})
		}
	});
	env.document.cookie = cookie;

	const CC = env.context.ClaudeCounter;
	CC.ui = { CounterUI: StubUI };
	CC.bridge = bridge;
	CC.injectBridgeOnce = () => Promise.resolve(true);

	CC.config = { showTokenCounter };
	env.load(['content/token-counter.js']);
	let tokenCounter;
	const Counter = CC.OptionalTokenCounter;
	CC.OptionalTokenCounter = class extends Counter { constructor(opts) { super(opts); tokenCounter = this; } };

	CC.ensureTokenizer = async () => { calls.tokenizerLoads.push(clock.now); };
	CC.tokens = { computeConversationMetrics: async (data) => ({ totalTokens: data.fakeTokens ?? data.chat_messages.length * 10, trunkMessageCount: data.chat_messages.length }) };
	if (beforeStart) beforeStart(env);
	env.load(['content/main.js']);
	await clock.flush();

	return {
		...env,
		tokenCounter,
		clock,
		calls,
		answers,
		emit,
		/** The windows the UI was last given. */
		lastUsage: () => calls.setUsage[calls.setUsage.length - 1],
		navigate: async (path) => {
			env.location.pathname = path;
			env.window.dispatchEvent({ type: 'cc:urlchange' });
			await clock.flush();
		},
		stored: (key) => env.storageData[key]
	};
}

function liveWindow(utilization, resetsAtMs) {
	return { utilization, resets_at: new Date(resetsAtMs).toISOString(), window_hours: 5 };
}

/** The shape bridge.js posts as cc:message_limit (utilization is a fraction, resets_at epoch seconds). */
function limitsEvent(clockNow, { fiveH = [0.2, 3600], sevenD = [0.1, 86400] } = {}) {
	const windows = {};
	if (fiveH) windows['5h'] = { status: 1, utilization: fiveH[0], resets_at: Math.floor(clockNow / 1000) + fiveH[1] };
	if (sevenD) windows['7d'] = { status: 1, utilization: sevenD[0], resets_at: Math.floor(clockNow / 1000) + sevenD[1] };
	return { windows };
}

function conversation(id, messages) {
	return {
		uuid: id,
		chat_messages: messages
	};
}

module.exports = { createMainEnv, liveWindow, limitsEvent, conversation, ORG, CONV };
