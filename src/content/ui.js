(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// Every user-visible string, per language (#6). The page language decides; anything not Spanish
	// falls back to English. Keep both tables complete: a missing key would show "undefined".
	const IS_ES = /^es\b/i.test(document.documentElement.lang || globalThis.navigator?.language || '');
	const L = IS_ES
		? {
				session: 'Sesión',
				weekly: 'Semana',
				resetsIn: 'se reinicia en',
				noData: 'sin datos aún',
				sessionHeading: 'Cuota de sesión · 5 horas',
				weeklyHeading: 'Cuota semanal · 7 días, todos los modelos',
				noDataTip: 'Aún no hay datos. Envía un mensaje o haz clic en las barras para actualizar.',
				expiredTip: 'Se alcanzó la hora de reinicio. Actualiza para confirmar tu cuota disponible.',
				usedRemaining: (used, left) => `${used}% usado · ${left}% restante`,
				resetsAtLocal: (time) => `Se reinicia ${time} (hora local)`,
				legend: 'Relleno = uso · marca = tiempo transcurrido',
				recentReadings: (list) => `Lecturas recientes: ${list}`,
				clickToRefresh: 'Haz clic en las barras para actualizar.',
				tokensPlaceholder: 'Tokens: —',
				tokens: (n) => `~${n} tokens`,
				tokensUnavailable: 'Tokens no disponibles',
				counting: 'Contando…',
				tokenTip: 'Tokens aproximados de la conversación\nCuenta el historial visible del chat, no el contexto activo de Claude.\nPuede ser inexacto tras una compactación. Haz clic en el recuento para volver a contar.'
			}
		: {
				session: 'Session',
				weekly: 'Weekly',
				resetsIn: 'resets in',
				noData: 'no data yet',
				sessionHeading: 'Session quota · 5 hours',
				weeklyHeading: 'Weekly quota · 7 days, all models',
				noDataTip: 'No data yet. Send a message or click the bars to refresh.',
				expiredTip: 'Reset time reached. Refresh to confirm your available quota.',
				usedRemaining: (used, left) => `${used}% used · ${left}% remaining`,
				resetsAtLocal: (time) => `Resets ${time} (local time)`,
				legend: 'Fill = usage · tick = time elapsed',
				recentReadings: (list) => `Recent readings: ${list}`,
				clickToRefresh: 'Click the bars to refresh.',
				tokensPlaceholder: 'Tokens: —',
				tokens: (n) => `~${n} tokens`,
				tokensUnavailable: 'Tokens unavailable',
				counting: 'Counting…',
				tokenTip: 'Approximate conversation tokens\nCounts visible chat history, not Claude’s active context.\nMay be inaccurate after compaction. Click the count to recount.'
			};

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	let tooltipCount = 0;

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');
		// Screen readers announce the tooltip as the trigger's description (#6).
		if (!tooltip.id) tooltip.id = `cc-tooltip-${++tooltipCount}`;
		element.setAttribute('aria-describedby', tooltip.id);

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			tooltip.style.visibility = 'visible';
			const tipRect = tooltip.getBoundingClientRect();

			// Keep the entire panel inside the viewport, flipping below its trigger when needed.
			const left = Math.max(10, Math.min(rect.left + (rect.width - tipRect.width) / 2, window.innerWidth - tipRect.width - 10));
			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + topOffset;
			top = Math.max(10, Math.min(top, window.innerHeight - tipRect.height - 10));
			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;

		};

		const hide = () => {
			tooltip.style.opacity = '0';
			tooltip.style.visibility = 'hidden';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'mouse') hide();
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		window.addEventListener('scroll', hide, true);
		window.addEventListener('resize', hide);
		window.addEventListener('pointerdown', hide);
		window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});

		// Keyboard users get the same tooltip while the trigger has focus.
		element.addEventListener('focus', show);
		element.addEventListener('blur', hide);
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'cc-tooltip';
		tip.setAttribute('role', 'tooltip');
		tip.textContent = text;
		const appendTip = () => {
			const target = document.body || document.documentElement;
			if (target && !target.contains(tip)) {
				target.appendChild(tip);
			}
		};
		if (document.body || document.documentElement) {
			appendTip();
		} else {
			window.addEventListener('DOMContentLoaded', appendTip, { once: true });
		}
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh, onTokenCounterRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onTokenCounterRefresh = onTokenCounterRefresh || (() => {});
			this.sessionHistory = [];
			this.sessionResetKey = null;
			this.refreshingUsage = false;
			this.orgId = null;
		}

		/**
		 * The active organisation (set by main.js). Recent session readings are stored per
		 * organisation, so switching never mixes one org's readings into another's tooltip (#6).
		 */
		setOrg(orgId) {
			if (orgId === this.orgId) return;
			this.orgId = orgId || null;
			this.sessionHistory = [];
			this.sessionResetKey = null;
			this._updateSessionTooltip();
		}

		/** Storage key for the readings, or null while the organisation is unknown (memory only). */
		_historyKey() {
			return this.orgId ? `claude_session_history:${this.orgId}` : null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.sessionBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
		}

		initialize() {
			this._initUsageLine();
			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
			this._initComposerFade();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => {
				this.refreshProgressChrome();
				this._syncComposerFade();
			});
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_initComposerFade() {
			this.composerFade = document.createElement('div');
			this.composerFade.className = 'cc-composerFade';
			this.composerFade.setAttribute('aria-hidden', 'true');
			const schedule = () => {
				if (this._fadeFrame) return;
				this._fadeFrame = window.requestAnimationFrame(() => {
					this._fadeFrame = null;
					this._syncComposerFade();
				});
			};
			window.addEventListener('scroll', schedule, true);
			window.addEventListener('resize', schedule);
			window.visualViewport?.addEventListener('resize', schedule);
			window.visualViewport?.addEventListener('scroll', schedule);
			if (window.ResizeObserver) this._fadeObserver = new window.ResizeObserver(schedule);
			this._syncComposerFade();
		}

		_syncUsageWidth() {
			if (!this._usageAnchor?.isConnected || !this.usageLine?.isConnected) return;
			const width = this._usageAnchor.getBoundingClientRect().width;
			if (width > 0 && this.usageLine.style.width !== `${width}px`) this.usageLine.style.width = `${width}px`;
		}

		_syncComposerFade() {
			this._syncUsageWidth();
			const fade = this.composerFade;
			if (!fade) return;
			const row = this.usageLine;
			const isChat = /\/chat\/[^/]+/.test(window.location?.pathname || '');
			if (!isChat || !row?.isConnected || !row.getClientRects().length) {
				fade.style.display = 'none';
				return;
			}
			const rect = row.getBoundingClientRect();
			if (rect.top <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
				fade.style.display = 'none';
				return;
			}
			// Portal outside the composer: its overflow must not cut off the gradient itself.
			if (!fade.isConnected) (document.body || document.documentElement).appendChild(fade);
			if (this._fadeAnchor !== this._usageAnchor) {
				this._fadeObserver?.disconnect();
				this._fadeAnchor = this._usageAnchor;
				this._fadeObserver?.observe(row);
				if (this._usageAnchor) this._fadeObserver?.observe(this._usageAnchor);
				if (row.parentElement) this._fadeObserver?.observe(row.parentElement);
			}
			// Match the opaque chat backdrop rather than the lighter input-card colour.
			let background = document.documentElement.dataset?.mode === 'dark' ? '#191919' : '#faf9f5';
			for (let el = row.parentElement; el; el = el.parentElement) {
				const color = window.getComputedStyle(el).backgroundColor;
				if (color && color !== 'transparent' && !/^rgba\(.*,[\s]*0(?:\.\d+)?\)$/.test(color)) {
					background = color;
					break;
				}
			}
			const top = Math.max(0, rect.top - 40);
			const left = Math.max(0, rect.left);
			fade.style.display = 'block';
			fade.style.left = `${left}px`;
			fade.style.top = `${top}px`;
			fade.style.width = `${Math.min(window.innerWidth, rect.right) - left}px`;
			fade.style.height = `${rect.top - top}px`;
			fade.style.backgroundImage = `linear-gradient(to bottom, transparent, ${background})`;
		}

		// Claude rebuilds and hydrates the composer, so the bars must be re-placed when the page
		// changes. While a reply streams, the page mutates many times per second, and finding the
		// composer reads layout and computed styles. So the callback itself does no layout work:
		// it ignores our own nodes and schedules one placement check for the whole burst (#3).
		// The 1 s tick remains the safety net for anything missed.
		_observeDom() {
			this.domObserver = new MutationObserver((records) => {
				if (records.length && records.every((r) => r.target?.closest?.('.cc-usageRow, .cc-tooltip, .cc-composerFade'))) return;
				this._scheduleUsageReattach(150);
			});

			const startObserving = () => {
				const target = document.body || document.documentElement;
				if (target) {
					this.domObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-testid', 'contenteditable', 'inert'] });
				}
			};

			if (document.body || document.documentElement) {
				startObserving();
			} else {
				window.addEventListener('DOMContentLoaded', startObserving, { once: true });
			}
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'cc-usageRow cc-unmounted';
			this.tokenDisplay = document.createElement('button');
			this.tokenDisplay.type = 'button';
			this.tokenDisplay.className = 'cc-tokenCounter cc-hidden';
			this.tokenDisplay.textContent = L.tokensPlaceholder;
			this.tokenDisplay.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onTokenCounterRefresh();
			});
			this.usageLine.appendChild(this.tokenDisplay);
			this.quotaGroups = document.createElement('div');
			this.quotaGroups.className = 'cc-quotaGroups';
			this.usageLine.appendChild(this.quotaGroups);
			const makeGroup = (label) => {
				// A focusable button: Tab reaches it, Enter/Space refresh, and its accessible name is its
				// visible text ("Session: 9% · resets in 4h"), so no aria-label overrides it (#6).
				const group = document.createElement('div');
				group.className = 'cc-usageGroup';
				group.setAttribute('role', 'button');
				group.setAttribute('tabindex', '0');
				group.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					return this._requestUsageRefresh();
				});
				const span = document.createElement('span');
				span.className = 'cc-usageText';
				const labelEl = document.createElement('span');
				labelEl.className = 'cc-usageLabel';
				labelEl.textContent = `${label}: `;
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--usage';
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				const marker = document.createElement('div');
				marker.className = 'cc-bar__marker cc-hidden';
				bar.appendChild(fill);
				bar.appendChild(marker);
				const pct = document.createElement('span');
				pct.className = 'cc-usagePct';
				pct.textContent = L.noData;
				const reset = document.createElement('span');
				reset.className = 'cc-usageReset';
				for (const el of [labelEl, bar, pct, reset]) span.appendChild(el);
				group.appendChild(span);
				return { group, span, bar, fill, marker, pct, reset };
			};
			for (const [key, label] of [['session', L.session], ['weekly', L.weekly]]) {
				const g = makeGroup(label);
				g.group.classList.add(`cc-usageGroup--${key}`);
				this[`${key}Group`] = g.group;
				this[`${key}UsageSpan`] = g.span;
				this[`${key}Bar`] = g.bar;
				this[`${key}BarFill`] = g.fill;
				this[`${key}Marker`] = g.marker;
				this[`${key}PctSpan`] = g.pct;
				this[`${key}ResetSpan`] = g.reset;
				this.quotaGroups.appendChild(g.group);
			}

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', () => this._requestUsageRefresh());
		}

		/** Mouse click on the row and Enter/Space on a quota button share one refresh. */
		async _requestUsageRefresh() {
			if (!this.onUsageRefresh || this.refreshingUsage) return;
			this.refreshingUsage = true;
			this.usageLine.classList.add('cc-usageRow--dim');
			try {
				await this.onUsageRefresh();
			} finally {
				this.usageLine.classList.remove('cc-usageRow--dim');
				this.refreshingUsage = false;
			}
		}

		setTokenCounter({ enabled, active, totalTokens, status }) {
			const visible = enabled && active;
			this.tokenDisplay.classList.toggle('cc-hidden', !visible);
			this.usageLine.classList.toggle('cc-usageRow--tokens', visible);
			this.tokenDisplay.textContent = typeof totalTokens === 'number' ? L.tokens(totalTokens.toLocaleString()) : status === 'error' ? L.tokensUnavailable : L.counting;
		}

		_setupTooltips() {
			this.tokenTooltip = makeTooltip(L.tokenTip);
			setupTooltip(this.tokenDisplay, this.tokenTooltip, { topOffset: 8 });
			this.sessionTooltip = makeTooltip(
				this._usageTooltipText('session')
			);
			setupTooltip(
				this.sessionGroup,
				this.sessionTooltip,
				{ topOffset: 8 }
			);

			this.weeklyTooltip = makeTooltip(this._usageTooltipText('weekly'));
			setupTooltip(
				this.weeklyGroup,
				this.weeklyTooltip,
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachUsageLine();
		}

		attachUsageLine() {
			this._attachUsageLine();
		}

		_attachUsageLine(box = this._findComposerBox()) {
			if (!this.usageLine) return;
			if (!box || !box.parentElement) {
				this.usageLine.classList.add('cc-unmounted');
				this._usageAnchor = null;
				this._syncComposerFade();
				return;
			}
			this._usageAnchor = box;
			this.usageLine.classList.remove('cc-unmounted');
			this.usageLine.classList.add('cc-usageRow--above');
			if (this.usageLine.nextElementSibling !== box) box.before(this.usageLine);
			this._syncComposerFade();
			this.refreshProgressChrome();
		}

		/** Coalesces placement checks: the first request starts the timer, later ones join it. */
		_scheduleUsageReattach(delay = 150) {
			if (this._usageReattachTimer) return;
			this._usageReattachTimer = setTimeout(() => {
				this._usageReattachTimer = null;
				this._ensureUsagePlacement();
			}, delay);
		}

		/** One composer scan: re-place the bars only if they are not where they belong. */
		_ensureUsagePlacement() {
			const box = this._findComposerBox();
			if (this._usageMisplaced(box)) this._attachUsageLine(box);
		}

		/** `box` is the composer found by the caller; pass it to avoid scanning twice. */
		_usageMisplaced(box = this._findComposerBox()) {
			if (!this.usageLine) return false;
			if (!box) return !this.usageLine.classList.contains('cc-unmounted');
			return this.usageLine.classList.contains('cc-unmounted') || !document.contains(this.usageLine) || this._usageAnchor !== box || this.usageLine.nextElementSibling !== box;
		}

		_findComposerBox() {
			// Loading placeholders and hidden, previous composers must never win discovery.
			const selectors = ['[data-testid="chat-input"]', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'];
			const seen = new Set();
			for (const selector of selectors) {
				for (const editor of document.querySelectorAll(selector)) {
					if (seen.has(editor)) continue;
					seen.add(editor);
					if (!editor.getClientRects().length || editor.closest('[role="dialog"], [aria-hidden="true"], [inert], aside, nav, header')) continue;
					const bounds = editor.getBoundingClientRect();
					if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) continue;
					const editorStyle = window.getComputedStyle(editor);
					if (editorStyle.visibility === 'hidden' || editorStyle.display === 'none') continue;
					for (let el = editor.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
						if (el.matches('main, aside, nav, header')) break;
						const style = window.getComputedStyle(el);
						if (!el.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') break;
						const radius = parseFloat(style.borderTopLeftRadius) || 0;
						const hasBg = style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
						if (el.matches('.bg-surface-3') || (radius >= 8 && (hasBg || parseFloat(style.borderTopWidth) > 0 || (style.boxShadow && style.boxShadow !== 'none')))) return el;
					}
				}
			}
			return null;
		}

		_usageTooltipText(key) {
			const w = this._tooltipUsage?.[key === 'session' ? 'five_hour' : 'seven_day'];
			const heading = key === 'session' ? L.sessionHeading : L.weeklyHeading;
			if (!w) return `${heading}\n${L.noDataTip}`;
			if (w.expired) return `${heading}\n${L.expiredTip}`;
			const pct = Math.round(Math.max(0, Math.min(100, w.utilization)) * 10) / 10;
			const lines = [heading, L.usedRemaining(pct, Math.round((100 - pct) * 10) / 10)];
			const resetMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
			if (Number.isFinite(resetMs)) lines.push(L.resetsAtLocal(new Date(resetMs).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })));
			lines.push(L.legend);
			if (key === 'session' && this.sessionHistory.length > 1) lines.push(L.recentReadings(this.sessionHistory.map((v) => `${v}%`).join(' → ')));
			lines.push(L.clickToRefresh);
			return lines.join('\n');
		}

		_updateSessionTooltip() {
			if (this.sessionTooltip) this.sessionTooltip.textContent = this._usageTooltipText('session');
		}

		_updateSessionHistory(resetsAt, currentPct) {
			if (!resetsAt) {
				this.sessionHistory = [];
				this.sessionResetKey = null;
				this._updateSessionTooltip();
				return;
			}

			const key = this._historyKey();
			const orgAtStart = this.orgId;
			const processHistory = (storedResetsAt, storedHistory) => {
				if (this.orgId !== orgAtStart) return; // the org changed while storage was being read
				let history = [];
				if (storedResetsAt === resetsAt && Array.isArray(storedHistory) && storedHistory.length > 0) {
					history = [...storedHistory];
				} else {
					history = [currentPct];
				}

				const lastVal = history[history.length - 1];
				if (currentPct > lastVal) {
					history.push(currentPct);
					if (history.length > 5) {
						history = history.slice(-5);
					}
				} else if (currentPct < lastVal) {
					history = [currentPct];
				}

				this.sessionHistory = history;
				this.sessionResetKey = resetsAt;
				this._updateSessionTooltip();

				try {
					if (key && typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.set({
							[key]: { version: 2, resets_at: resetsAt, history }
						});
					}
				} catch (e) {
					// ignore storage errors
				}
			};

			if (this.sessionResetKey !== resetsAt) {
				this.sessionResetKey = resetsAt;
				try {
					if (key && typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.get([key], (result) => {
							const data = result?.[key];
							processHistory(data?.version === 2 ? data.resets_at : null, data?.history);
						});
					} else {
						processHistory(null, null);
					}
				} catch (e) {
					processHistory(null, null);
				}
			} else {
				processHistory(resetsAt, this.sessionHistory);
			}
		}


		_renderWindow({ windowMs, w, pctSpan, resetSpan, fill }) {
			const live = w && !w.expired && typeof w.utilization === 'number';

			if (live) {
				const rawPct = w.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				const resetMs = w.resets_at ? Date.parse(w.resets_at) : null;
				pctSpan.textContent = `${pct}%`;
				resetSpan.textContent = resetMs ? ` · ${L.resetsIn} ${formatResetCountdown(resetMs)}` : '';

				const width = Math.max(0, Math.min(100, rawPct));
				fill.style.width = `${width}%`;
				fill.classList.toggle('cc-caution', width >= 75 && width < 90);
				fill.classList.toggle('cc-warn', width >= 90);
				fill.classList.toggle('cc-full', width >= 99.5);
				return { resetMs, startMs: resetMs ? resetMs - windowMs : null, pct, live: true };
			}

			pctSpan.textContent = w && w.expired ? '0%' : L.noData;
			resetSpan.textContent = '';
			fill.style.width = '0%';
			fill.classList.remove('cc-caution', 'cc-warn', 'cc-full');
			return { resetMs: null, startMs: null, pct: 0, live: false };
		}

		setUsage(usage) {
			this._tooltipUsage = usage;
			this.refreshProgressChrome();

			// Bars are permanent
			this.usageLine?.classList.remove('cc-hidden');
			this.weeklyGroup?.classList.remove('cc-hidden');
			this.sessionGroup?.classList.remove('cc-usageGroup--single');
			this.weeklyUsageSpan.classList.remove('cc-hidden');
			this.weeklyBar.classList.remove('cc-hidden');

			const session = this._renderWindow({
				label: 'Session',
				windowMs: 5 * 60 * 60 * 1000,
				w: usage?.five_hour || null,
				pctSpan: this.sessionPctSpan,
				resetSpan: this.sessionResetSpan,
				fill: this.sessionBarFill
			});
			this.sessionResetMs = session.resetMs;
			this.sessionWindowStartMs = session.startMs;
			this._updateSessionHistory(session.live && usage.five_hour.resets_at ? usage.five_hour.resets_at : null, session.pct);

			const weekly = this._renderWindow({
				label: 'Weekly',
				windowMs: 7 * 24 * 60 * 60 * 1000,
				w: usage?.seven_day || null,
				pctSpan: this.weeklyPctSpan,
				resetSpan: this.weeklyResetSpan,
				fill: this.weeklyBarFill
			});
			this.weeklyResetMs = weekly.resetMs;
			this.weeklyWindowStartMs = weekly.startMs;

			this._updateMarkers();
			this._updateSessionTooltip();
			this.weeklyTooltip.textContent = this._usageTooltipText('weekly');
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		tick() {
			this._ensureUsagePlacement();
			this._syncComposerFade();
			// Reset text is separate so compact mode can hide it without parsing labels.
			for (const key of ['session', 'weekly']) {
				const resetMs = this[`${key}ResetMs`];
				if (resetMs) this[`${key}ResetSpan`].textContent = ` · ${L.resetsIn} ${formatResetCountdown(resetMs)}`;
			}

			this._updateMarkers();
		}
	}

	CC.ui = { CounterUI };
})();
