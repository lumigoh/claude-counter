(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	// Every organisation id this page has resolved or seen in the page's own requests. A saved usage
	// snapshot is matched against any of them, because the id found at start-up (cookie, list of
	// organisations) is not always the one the page's requests use.
	const knownOrgIds = new Set();
	function rememberOrg(id) {
		if (typeof id === 'string' && id) knownOrgIds.add(id);
	}
	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	async function getOrgId() {
		if (currentOrgId) return currentOrgId;

		const fromCookie = getOrgIdFromCookie();
		if (fromCookie) {
			currentOrgId = fromCookie;
			rememberOrg(currentOrgId);
			return currentOrgId;
		}

		try {
			const lsOrg = localStorage.getItem('lastActiveOrg') || localStorage.getItem('currentOrganizationId');
			if (lsOrg) {
				currentOrgId = lsOrg;
				rememberOrg(currentOrgId);
				return currentOrgId;
			}
		} catch {}

		try {
			if (typeof chrome !== 'undefined' && chrome.storage?.local) {
				const stored = await new Promise((r) => chrome.storage.local.get(['claude_last_org_id'], r));
				if (stored?.claude_last_org_id) {
					currentOrgId = stored.claude_last_org_id;
					rememberOrg(currentOrgId);
					return currentOrgId;
				}
			}
		} catch {}

		try {
			const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
			if (res.ok) {
				const orgs = await res.json();
				if (Array.isArray(orgs) && orgs.length > 0) {
					const activeOrg = orgs.find((o) => o?.active) || orgs[0];
					const id = activeOrg?.id || activeOrg?.uuid;
					if (id) {
						currentOrgId = id;
						rememberOrg(currentOrgId);
						if (typeof chrome !== 'undefined' && chrome.storage?.local) {
							chrome.storage.local.set({ claude_last_org_id: id });
						}
						return currentOrgId;
					}
				}
			}
		} catch {}

		return null;
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			const startObserving = () => {
				const target = document.body || document.documentElement;
				if (target) {
					observer.observe(target, { childList: true, subtree: true });
				}
			};

			if (document.body || document.documentElement) {
				startObserving();
			} else {
				window.addEventListener('DOMContentLoaded', startObserving, { once: true });
			}

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentOrgId = null;

	// Usage state: one entry per window. A window is either live ({ utilization, resets_at, ... }),
	// expired ({ expired: true }: its reset time has passed, nothing was used since) or null (never seen).
	let usageState = null;
	// When /usage may be asked next. A failed request (error, timeout) is retried after a minute. An
	// answer that is valid but reports no windows (free plan) is a real answer and is not repeated
	// for an hour; the limits arrive with the replies anyway. Without this the free plan was asked
	// again every second.
	let nextUsageAttemptMs = Date.now() + 60 * 60 * 1000;
	let usageFetchInFlight = false;
	let usageFailures = 0; // failed requests in a row; the retry gets longer (1, 2, 4, ... minutes, at most an hour)
	const USAGE_WINDOW_KEYS = ['five_hour', 'seven_day'];
	const USAGE_POLL_MS = 60 * 60 * 1000;
	const USAGE_RETRY_MS = 60 * 1000;
	const ACTIVE_USAGE_POLL_MS = 5 * 60 * 1000;
	let lastUsageUpdateMs = 0;
	let lastUsageFetchMs = 0;
	let usageEndpointEmpty = false;
	let usageEndpointHasData = false;

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function windowResetMs(w) {
		if (!w || w.expired || !w.resets_at) return null;
		const ms = Date.parse(w.resets_at);
		return Number.isFinite(ms) ? ms : null;
	}

	/** Turns windows whose reset time has passed into { expired: true }. Returns true if anything changed. */
	function expireWindows(now) {
		if (!usageState) return false;
		let changed = false;
		for (const key of USAGE_WINDOW_KEYS) {
			const resetMs = windowResetMs(usageState[key]);
			if (resetMs !== null && now >= resetMs) {
				usageState[key] = { expired: true };
				changed = true;
			}
		}
		return changed;
	}

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		const previous = usageState || { five_hour: null, seven_day: null };
		lastUsageUpdateMs = now;
		// A window missing from an update keeps what we know: the free plan's /usage reports nothing
		// even while a window is live, and a limits event may carry only one window.
		usageState = {
			five_hour: normalized.five_hour || previous.five_hour,
			seven_day: normalized.seven_day || previous.seven_day
		};
		expireWindows(now);
		if (source === 'cache') {
			// A saved window that ended while the page was closed is stale: ask for fresh data right away.
			if (USAGE_WINDOW_KEYS.some((key) => usageState[key]?.expired)) nextUsageAttemptMs = now;
		} else {
			nextUsageAttemptMs = now + (usageEndpointHasData ? ACTIVE_USAGE_POLL_MS : USAGE_POLL_MS);
		}
		if (source !== 'cache') persistUsage();
		ui.setUsage(usageState);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string') {
			rememberOrg(newOrgId);
			if (newOrgId !== currentOrgId) currentOrgId = newOrgId;
		}
	}

	// Persist the last usage snapshot so the bars survive reloads (the /usage endpoint returns
	// nothing on the free plan until the next reply brings the limits).
	async function persistUsage() {
		try {
			if (typeof chrome === 'undefined' || !chrome.storage?.local || !usageState) return;
			const orgId = await getOrgId();
			if (!orgId) return;
			const orgIds = Array.from(new Set([orgId, ...knownOrgIds])).slice(0, 4);
			chrome.storage.local.set({ claude_usage_state: { orgId, orgIds, usage: usageState } });
		} catch {
			// ignore
		}
	}

	function readStoredUsage() {
		return new Promise((resolve) => {
			try {
				if (typeof chrome === 'undefined' || !chrome.storage?.local) return resolve(null);
				chrome.storage.local.get(['claude_usage_state'], (result) => resolve(result?.claude_usage_state || null));
			} catch {
				resolve(null);
			}
		});
	}

	const usageMissing = () => !usageState || USAGE_WINDOW_KEYS.some((key) => !usageState[key]);
	let lastRestore = { org: null, at: 0 };

	// The saved snapshot belongs to one account. The organisation is resolved the same way as for
	// every request (not from the cookie alone: it may be unreadable); the snapshot matches when it
	// was saved under this id or under any id seen on the page together with it. Windows the page
	// already knows (from a limits event) are kept; only missing ones are filled in from the snapshot.
	async function restoreUsageIfNeeded() {
		if (!usageMissing()) return true;
		const orgId = await getOrgId();
		if (!orgId) return false;
		const now = Date.now();
		if (lastRestore.org === orgId && now - lastRestore.at < 5000) return false;
		lastRestore = { org: orgId, at: now };

		const entry = await readStoredUsage();
		const cached = entry?.usage;
		const aliases = Array.isArray(entry?.orgIds) ? entry.orgIds : [];
		const matches = !!entry && (entry.orgId === orgId || aliases.includes(orgId) || [...knownOrgIds].some((id) => id === entry.orgId || aliases.includes(id)));
		if (!cached || !matches) return false;
		const fill = {};
		for (const key of USAGE_WINDOW_KEYS) {
			if ((!usageState || !usageState[key]) && cached[key]) fill[key] = cached[key];
		}
		if (!fill.five_hour && !fill.seven_day) return false;
		applyUsageUpdate({ five_hour: fill.five_hour || null, seven_day: fill.seven_day || null }, 'cache');
		return true;
	}

	async function refreshUsage() {
		if (usageFetchInFlight) return;
		// Assume failure until a valid answer arrives.
		nextUsageAttemptMs = Date.now() + USAGE_RETRY_MS;
		await bridgeReady;
		const orgId = await getOrgId();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw = null;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			// Bridge failed or timed out; try direct fetch fallback
			try {
				const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					credentials: 'include'
				});
				if (res.ok) {
					raw = await res.json();
				}
			} catch {}
		} finally {
			usageFetchInFlight = false;
		}

		if (!raw || typeof raw !== 'object') {
			usageFailures += 1;
			nextUsageAttemptMs = Date.now() + Math.min(USAGE_RETRY_MS * 2 ** (usageFailures - 1), USAGE_POLL_MS);
			return;
		}
		usageFailures = 0;
		lastUsageFetchMs = Date.now();
		nextUsageAttemptMs = lastUsageFetchMs + USAGE_POLL_MS;

		// Endpoint reachable but reports no windows (free plan): keep what we know, never wipe the saved snapshot.
		const parsed = parseUsageFromUsageEndpoint(raw);
		usageEndpointEmpty = !parsed;
		usageEndpointHasData = !!parsed;
		if (!parsed) return;
		applyUsageUpdate(parsed, 'usage');
	}

	// Extra refreshes share the failure/empty-answer cooldown with the periodic poll.
	function refreshUsageIfStale(maxAgeMs) {
		const now = Date.now();
		if (document.hidden || usageFetchInFlight) return;
		if ((usageFailures || usageEndpointEmpty) && now < nextUsageAttemptMs) return;
		if (now - Math.max(lastUsageUpdateMs, lastUsageFetchMs) < maxAgeMs) return;
		refreshUsage();
	}

	let streamRefreshTimers = [];
	CC.bridge.on('cc:stream_started', () => {
		for (const timer of streamRefreshTimers) clearTimeout(timer);
		streamRefreshTimers = [20000, 60000].map((delay) => setTimeout(() => refreshUsageIfStale(5000), delay));
	});
	window.addEventListener('focus', () => refreshUsageIfStale(60 * 1000));

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:message_limit', handleMessageLimit);
	CC.bridge.on('cc:org_detected', (payload) => {
		if (payload?.orgId) {
			updateOrgIdIfNeeded(payload.orgId);
			if (typeof chrome !== 'undefined' && chrome.storage?.local) {
				chrome.storage.local.set({ claude_last_org_id: payload.orgId });
			}
			// The saved usage could not be matched earlier if the organisation was still unknown.
			if (usageMissing()) restoreUsageIfNeeded().catch(() => {});
		}
	});

	async function isExtensionEnabled() {
		try {
			if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
				const res = await new Promise((resolve) => {
					chrome.storage.sync.get({ claudeCounterEnabled: true }, (items) => {
						if (chrome.runtime?.lastError) resolve({ claudeCounterEnabled: true });
						else resolve(items || { claudeCounterEnabled: true });
					});
				});
				return res.claudeCounterEnabled !== false;
			}
		} catch {}
		return true;
	}

	async function handleUrlChange() {
		if (!(await isExtensionEnabled())) return;

		// Attach immediately if elements already exist
		ui.attachUsageLine();

		// Reattach when the composer appears after navigation.
		waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});

		// Usage is org-level: restore/refresh on every page, including home/new
		const orgId = await getOrgId();
		updateOrgIdIfNeeded(orgId);
		if (usageMissing()) await restoreUsageIfNeeded();
		if (!usageState && !lastUsageFetchMs && !usageFailures) await refreshUsage();
		else refreshUsageIfStale(2 * 60 * 1000);

	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Initial attach + fetches
	handleUrlChange();

	const startedAtMs = Date.now();
	let nextRestoreCheckMs = startedAtMs + 10000;

	function tick() {
		if (!document.hidden) ui.tick();

		const now = Date.now();

		// Whatever kept the saved usage from being restored at start-up (organisation not known yet,
		// storage slow), try again every ten seconds for the first two minutes.
		if (now >= nextRestoreCheckMs && now - startedAtMs < 120000 && usageMissing()) {
			nextRestoreCheckMs = now + 10000;
			restoreUsageIfNeeded().catch(() => {});
		}

		// A window whose reset time has passed shows 0% (nothing was used since); ask once for fresh data.
		if (expireWindows(now)) {
			persistUsage();
			ui.setUsage(usageState);
			if (!document.hidden) refreshUsage();
		}

		// Poll useful usage data every five minutes; empty answers and failures keep their backoff.
		if (!document.hidden && now >= nextUsageAttemptMs) {
			refreshUsage();
		}
	}

	// Keep #15's immediate visible-tab tick and #57's one-minute staleness check.
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			ui.tick();
			refreshUsageIfStale(60 * 1000);
		}
	});

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
