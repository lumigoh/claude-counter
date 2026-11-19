(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	// ---------------------------------------------------------------------------------------------
	// Active organisation (2.1.8, issue #2)
	//
	// Quotas belong to one organisation, so everything below is keyed by `currentOrgId`. Two kinds of
	// evidence exist and they are deliberately treated differently:
	//
	//   * Trusted sources say which organisation the user *picked*:
	//       1. the `lastActiveOrg` cookie claude.ai sets when you choose an organisation,
	//       2. claude.ai's own saved setting in page localStorage,
	//       3. the /api/organizations list, but only when it marks exactly one org `active`.
	//     A trusted answer that differs from `currentOrgId` is a genuine switch.
	//
	//   * Candidates are IDs merely *seen* in the page's requests (`cc:org_detected`). claude.ai can
	//     request other organisations too (team + personal accounts), so a candidate never switches
	//     the active org by itself, however often it appears. It is only used to bootstrap when
	//     nothing else is known, and to prompt a (rate-limited) re-check of the trusted sources.
	//
	// At start-up, when no trusted source answers, the remembered org (`claude_last_org_id`), the
	// only org in the list, or the first candidate are used, in that order. Without a cookie, a
	// later candidate only moves us if a trusted source confirms it; otherwise the current org stays.
	// ---------------------------------------------------------------------------------------------

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

	/** Trusted sources that can be read synchronously and cheaply (safe to call every second). */
	function readTrustedOrgSync() {
		const fromCookie = getOrgIdFromCookie();
		if (CC.isPlausibleOrgId(fromCookie)) return fromCookie;
		try {
			const fromPage = localStorage.getItem('lastActiveOrg') || localStorage.getItem('currentOrganizationId');
			return CC.isPlausibleOrgId(fromPage) ? fromPage : null;
		} catch {
			return null;
		}
	}

	/** An org list entry's ID. `uuid` is the string used in URLs; a numeric `id` is not an org ID. */
	function orgListId(org) {
		const id = org?.uuid ?? org?.id;
		return CC.isPlausibleOrgId(id) ? id : null;
	}

	/**
	 * Reads /api/organizations. Returns { active, single }: `active` only when exactly one org is
	 * marked active (trusted), `single` when the account has exactly one org (start-up fallback).
	 */
	async function readOrgList() {
		try {
			const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
			if (!res?.ok) return null;
			const orgs = await res.json();
			if (!Array.isArray(orgs)) return null;
			const active = orgs.filter((o) => o?.active);
			return {
				active: active.length === 1 ? orgListId(active[0]) : null,
				single: orgs.length === 1 ? orgListId(orgs[0]) : null
			};
		} catch {
			return null;
		}
	}

	function readRememberedOrg() {
		return new Promise((resolve) => {
			try {
				if (typeof chrome === 'undefined' || !chrome.storage?.local) return resolve(null);
				chrome.storage.local.get(['claude_last_org_id'], (stored) => resolve(stored?.claude_last_org_id || null));
			} catch {
				resolve(null);
			}
		});
	}

	let lastCandidateOrgId = null;

	/** Resolves the active organisation, bootstrapping it on first use. */
	async function getOrgId() {
		if (currentOrgId) return currentOrgId;

		const trusted = readTrustedOrgSync();
		if (trusted) {
			acceptActiveOrg(trusted);
			return currentOrgId;
		}

		const remembered = await readRememberedOrg();
		if (currentOrgId) return currentOrgId; // resolved by someone else while we waited
		if (remembered) {
			acceptActiveOrg(remembered);
			return currentOrgId;
		}

		const list = await readOrgList();
		if (currentOrgId) return currentOrgId;
		const fromList = list?.active || list?.single || lastCandidateOrgId;
		if (fromList) acceptActiveOrg(fromList);
		return currentOrgId;
	}

	// Without a cookie, a candidate that differs from the active org asks the org list again, at most
	// once per ORG_RECHECK_MS, and switches only if the list explicitly marks another org active.
	const ORG_RECHECK_MS = 5 * 60 * 1000;
	let lastOrgRecheckMs = -Infinity;
	let orgRecheckInFlight = false;

	async function recheckActiveOrg() {
		const trusted = readTrustedOrgSync();
		if (trusted) {
			acceptActiveOrg(trusted);
			return;
		}
		const now = Date.now();
		if (orgRecheckInFlight || now - lastOrgRecheckMs < ORG_RECHECK_MS) return;
		lastOrgRecheckMs = now;
		orgRecheckInFlight = true;
		try {
			const list = await readOrgList();
			if (list?.active) acceptActiveOrg(list.active);
		} finally {
			orgRecheckInFlight = false;
		}
	}

	/** A request mentioned this org. Bootstrap from it if nothing is known; never switch on it alone. */
	function handleOrgCandidate(orgId) {
		if (!CC.isPlausibleOrgId(orgId)) return;
		lastCandidateOrgId = orgId;
		if (!currentOrgId) {
			getOrgId()
				.then(() => { if (usageMissing()) return restoreUsageIfNeeded(); })
				.catch(() => {});
		} else if (orgId !== currentOrgId) {
			recheckActiveOrg().catch(() => {});
		}
	}

	/** Called every tick: a changed cookie (or page setting) is a genuine switch made without a reload. */
	function checkTrustedOrgChange() {
		const trusted = readTrustedOrgSync();
		if (trusted && trusted !== currentOrgId) acceptActiveOrg(trusted);
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
	const orgChangeListeners = new Set();
	// Time of the last genuine A -> B switch. Unlabelled stream events from streams opened before
	// it may belong to the previous organisation, so they are dropped (see handleMessageLimit).
	let lastOrgSwitchMs = -Infinity;
	let orgRevision = 0;
	const windowFreshness = {
		five_hour: { revision: 0, resetMs: null },
		seven_day: { revision: 0, resetMs: null }
	};

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

	let tokenCounter;
	const ui = new CC.ui.CounterUI({
		onTokenCounterRefresh: () => tokenCounter?.refresh(),
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();
	tokenCounter = new CC.OptionalTokenCounter({ ui, bridgeReady, getOrgId, onActiveOrgChange: (fn) => orgChangeListeners.add(fn) });

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
				windowFreshness[key].revision++;
				changed = true;
			}
		}
		return changed;
	}

	function applyUsageUpdate(normalized, source, request = null) {
		if (!normalized) return false;
		const now = Date.now();
		const previous = usageState || { five_hour: null, seven_day: null };
		const accepted = {};
		for (const key of USAGE_WINDOW_KEYS) {
			const value = normalized[key];
			if (!value || (source === 'cache' && previous[key])) continue;
			const meta = windowFreshness[key];
			const resetMs = windowResetMs(value);
			// A retired window cannot replace the new one, even if its response arrives later.
			if (resetMs !== null && meta.resetMs !== null && Math.floor(resetMs / 1000) < Math.floor(meta.resetMs / 1000) && resetMs <= now) continue;
			if (request && request.revisions[key] !== meta.revision) {
				// The response was started before this window received a live update or expired.
				// A provably new window is still useful once the previous reset time has passed.
				const newWindow = resetMs !== null && meta.resetMs !== null && now >= meta.resetMs && Math.floor(resetMs / 1000) > Math.floor(meta.resetMs / 1000);
				if (!newWindow) continue;
			}
			accepted[key] = value;
			// Restored snapshots are a display fallback, not evidence that an in-flight poll is stale.
			if (source !== 'cache') meta.revision++;
			if (resetMs !== null) meta.resetMs = resetMs;
		}
		if (!Object.keys(accepted).length) return false;
		usageState = { ...previous, ...accepted };
		lastUsageUpdateMs = now;
		expireWindows(now);
		if (source === 'cache') {
			if (USAGE_WINDOW_KEYS.some((key) => usageState[key]?.expired)) nextUsageAttemptMs = now;
		} else {
			nextUsageAttemptMs = now + (usageEndpointHasData ? ACTIVE_USAGE_POLL_MS : USAGE_POLL_MS);
		}
		if (source !== 'cache') persistUsage();
		ui.setUsage(usageState);
		return true;
	}

	/**
	 * Makes `newOrgId` the active organisation. Only trusted sources and start-up bootstrap call this.
	 * A switch from another org clears what is on screen and in memory (snapshots on disk are kept per
	 * organisation), invalidates in-flight polls via the revisions, then restores and polls the new org
	 * straight away.
	 */
	function acceptActiveOrg(newOrgId) {
		if (!CC.isPlausibleOrgId(newOrgId) || newOrgId === currentOrgId) return;
		const previous = currentOrgId;
		const switching = !!previous;
		currentOrgId = newOrgId;
		orgRevision++;
		for (const meta of Object.values(windowFreshness)) {
			meta.revision++;
			meta.resetMs = null;
		}
		try {
			if (typeof chrome !== 'undefined' && chrome.storage?.local) chrome.storage.local.set({ claude_last_org_id: newOrgId });
		} catch {}
		ui.setOrg(newOrgId);
		if (switching) {
			lastOrgSwitchMs = Date.now();
			usageState = null;
			lastUsageUpdateMs = 0;
			lastUsageFetchMs = 0;
			usageEndpointHasData = false;
			usageEndpointEmpty = false;
			usageFailures = 0;
			lastRestore = { org: null, at: 0 };
			// The deferred refresh below polls the new org now; the tick only takes over if it cannot.
			nextUsageAttemptMs = Date.now() + USAGE_RETRY_MS;
			ui.setUsage(null);
			// Restore first so the snapshot shows while the poll is in flight. Deferred so callers
			// (getOrgId, refreshUsage) finish their own bookkeeping before this runs.
			Promise.resolve()
				.then(() => restoreUsageIfNeeded())
				.then(() => { if (!document.hidden && currentOrgId === newOrgId) return refreshUsage(); })
				.catch(() => {});
		}
		for (const fn of orgChangeListeners) {
			try { fn(newOrgId, previous); } catch {}
		}
	}

	const usageStorageKey = (orgId) => `claude_usage_state:${orgId}`;

	async function persistUsage() {
		try {
			if (typeof chrome === 'undefined' || !chrome.storage?.local || !usageState) return;
			const revision = orgRevision;
			const snapshot = usageState;
			const orgId = await getOrgId();
			if (!orgId || revision !== orgRevision || orgId !== currentOrgId) return;
			chrome.storage.local.set({ [usageStorageKey(orgId)]: { version: 2, orgId, usage: snapshot } });
		} catch {
			// ignore
		}
	}

	function readStoredUsage(orgId) {
		return new Promise((resolve) => {
			try {
				if (typeof chrome === 'undefined' || !chrome.storage?.local) return resolve(null);
				const key = usageStorageKey(orgId);
				chrome.storage.local.get([key, 'claude_usage_state'], (result) => {
					const scoped = result?.[key];
					if (scoped?.version === 2 && scoped.orgId === orgId) return resolve(scoped);
					// Only migrate a legacy snapshot with one unambiguous owner. Old aliases may
					// already contain mixed windows, even when their primary orgId matches.
					const legacy = result?.claude_usage_state;
					const unambiguous = !Array.isArray(legacy?.orgIds) || legacy.orgIds.every((id) => id === orgId);
					resolve(legacy?.orgId === orgId && unambiguous ? legacy : null);
				});
			} catch {
				resolve(null);
			}
		});
	}

	const usageMissing = () => !usageState || USAGE_WINDOW_KEYS.some((key) => !usageState[key]);
	let lastRestore = { org: null, at: 0 };

	// Restore only this organisation's missing windows, preserving any newer live readings.
	async function restoreUsageIfNeeded() {
		if (!usageMissing()) return true;
		const orgId = await getOrgId();
		if (!orgId) return false;
		const now = Date.now();
		if (lastRestore.org === orgId && now - lastRestore.at < 5000) return false;
		lastRestore = { org: orgId, at: now };

		const revision = orgRevision;
		const entry = await readStoredUsage(orgId);
		if (revision !== orgRevision || orgId !== currentOrgId) return false;
		const cached = entry?.usage;
		if (!cached) return false;
		const fill = {};
		for (const key of USAGE_WINDOW_KEYS) {
			if ((!usageState || !usageState[key]) && cached[key]) fill[key] = cached[key];
		}
		if (!fill.five_hour && !fill.seven_day) return false;
		applyUsageUpdate({ five_hour: fill.five_hour || null, seven_day: fill.seven_day || null }, 'cache');
		persistUsage(); // Migrate a safe legacy snapshot into organisation-scoped storage.
		return true;
	}

	async function refreshUsage() {
		if (usageFetchInFlight) return;
		// Assume failure until a valid answer arrives.
		nextUsageAttemptMs = Date.now() + USAGE_RETRY_MS;
		await bridgeReady;
		const orgId = await getOrgId();
		if (!orgId) return;

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		const request = { orgId, orgRevision, revisions: Object.fromEntries(USAGE_WINDOW_KEYS.map((key) => [key, windowFreshness[key].revision])) };
		let raw = null;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			// Bridge failed or timed out; try direct fetch fallback
			try {
				// Encoded although accepted IDs are URL-safe: defence in depth (#5).
				const res = await fetch(`https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/usage`, {
					credentials: 'include'
				});
				if (res.ok) {
					raw = await res.json();
				}
			} catch {}
		} finally {
			usageFetchInFlight = false;
		}

		if (request.orgRevision !== orgRevision || request.orgId !== currentOrgId) {
			nextUsageAttemptMs = Math.min(nextUsageAttemptMs, Date.now());
			return;
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
		nextUsageAttemptMs = Date.now() + ACTIVE_USAGE_POLL_MS;
		const applied = applyUsageUpdate(parsed, 'usage', request);
		if (!applied && USAGE_WINDOW_KEYS.some((key) => usageState?.[key]?.expired)) {
			// A stale poll must not postpone rollover recovery for an hour.
			nextUsageAttemptMs = Date.now() + USAGE_RETRY_MS;
		}
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

	/**
	 * Limits from a reply. The bridge labels each stream with the organisation it was opened under
	 * (`meta.orgId`, null when unknown) and when (`meta.openedAt`). Only the content script knows the
	 * active organisation, so it decides here:
	 *   - labelled with another org            -> dropped
	 *   - unlabelled, opened before a switch   -> dropped (could be the previous org)
	 *   - otherwise                            -> applied (freshness rules still apply)
	 */
	function handleMessageLimit(messageLimit, meta) {
		// A reply can arrive before start-up resolved the org; the cookie answers synchronously.
		if (!currentOrgId) checkTrustedOrgChange();
		if (meta?.orgId && meta.orgId !== currentOrgId) return;
		if (!meta?.orgId && Number.isFinite(meta?.openedAt) && meta.openedAt < lastOrgSwitchMs) return;
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:message_limit', handleMessageLimit);
	CC.bridge.on('cc:org_detected', (payload) => handleOrgCandidate(payload?.orgId));

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
		await getOrgId();
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
		checkTrustedOrgChange();

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
