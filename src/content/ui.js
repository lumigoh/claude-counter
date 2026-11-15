(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const IS_ES = /^es\b/i.test(document.documentElement.lang || globalThis.navigator?.language || '');
	const L = IS_ES
		? {
				session: 'Sesión',
				weekly: 'Semana',
				resetsIn: 'Se reinicia en',
				sessionTip: 'Ventana de uso de 5 horas.\nLa barra muestra tu consumo; la línea vertical, cuánto pasó de la ventana.\nClic para actualizar.',
				weeklyTip: 'Ventana de uso de 7 días.\nLa barra muestra tu consumo; la línea vertical, cuánto pasó de la ventana.\nClic para actualizar.'
			}
		: {
				session: 'Session',
				weekly: 'Weekly',
				resetsIn: 'resets in',
				sessionTip: '5-hour session window.\nThe bar shows your usage; the tick marks elapsed time.\nClick to refresh.',
				weeklyTip: '7-day usage window.\nThe bar shows your usage; the tick marks elapsed time.\nClick to refresh.'
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

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

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
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.sessionHistory = [];
			this.sessionResetKey = null;
			this.refreshingUsage = false;
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
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			this.domObserver = new MutationObserver(() => {
				if (this._usageMisplaced()) this._scheduleUsageReattach(150);
			});

			const startObserving = () => {
				const target = document.body || document.documentElement;
				if (target) {
					this.domObserver.observe(target, { childList: true, subtree: true });
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
			this.usageLine.className = 'cc-usageRow';
			const makeGroup = (label) => {
				const group = document.createElement('div');
				group.className = 'cc-usageGroup';
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
				pct.textContent = 'no data yet';
				const reset = document.createElement('span');
				reset.className = 'cc-usageReset';
				for (const el of [labelEl, bar, pct, reset]) span.appendChild(el);
				group.appendChild(span);
				return { group, span, bar, fill, marker, pct, reset };
			};
			for (const [key, label] of [['session', L.session], ['weekly', L.weekly]]) {
				const g = makeGroup(label);
				this[`${key}Group`] = g.group;
				this[`${key}UsageSpan`] = g.span;
				this[`${key}Bar`] = g.bar;
				this[`${key}BarFill`] = g.fill;
				this[`${key}Marker`] = g.marker;
				this[`${key}PctSpan`] = g.pct;
				this[`${key}ResetSpan`] = g.reset;
				this.usageLine.appendChild(g.group);
			}

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
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

		_attachUsageLine() {
			if (!this.usageLine) return;
			const box = this._findComposerBox();
			if (!box || !box.parentElement) return;
			this._usageAnchor = box;
			this.usageLine.classList.add('cc-usageRow--above');
			if (this.usageLine.nextElementSibling !== box) box.before(this.usageLine);
			this.refreshProgressChrome();
		}

		_scheduleUsageReattach(delay = 150) {
			if (this._usageReattachTimer) return;
			this._usageReattachTimer = setTimeout(() => {
				this._usageReattachTimer = null;
				this.attachUsageLine();
			}, delay);
		}

		_usageMisplaced() {
			const input = document.querySelector(CC.DOM.CHAT_INPUT);
			if (!input || !this.usageLine) return false;
			return !document.contains(this.usageLine) || !this._usageAnchor?.contains(input) || this.usageLine.nextElementSibling !== this._usageAnchor;
		}

		_findComposerBox() {
			const editor = document.querySelector(CC.DOM.CHAT_INPUT);
			if (!editor) return null;
			for (let el = editor.parentElement; el && el !== document.body; el = el.parentElement) {
				const s = window.getComputedStyle(el);
				const radius = parseFloat(s.borderTopLeftRadius) || 0;
				const hasBg = s.backgroundColor && s.backgroundColor !== 'transparent' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
				if (el.matches('.bg-surface-3') || (radius >= 8 && (hasBg || parseFloat(s.borderTopWidth) > 0 || (s.boxShadow && s.boxShadow !== 'none')))) return el;
				if (el.matches('fieldset, form')) return el;
			}
			return editor.parentElement && editor.parentElement !== document.body ? editor.parentElement : null;
		}

		_usageTooltipText(key) {
			const w = this._tooltipUsage?.[key === 'session' ? 'five_hour' : 'seven_day'];
			const heading = key === 'session' ? `${L.session} quota · 5 hours` : `${L.weekly} quota · 7 days, all models`;
			if (!w) return `${heading}\nNo data yet. Send a message or click the bars to refresh.`;
			if (w.expired) return `${heading}\nReset time reached. Refresh to confirm your available quota.`;
			const pct = Math.round(Math.max(0, Math.min(100, w.utilization)) * 10) / 10;
			const lines = [heading, `${pct}% used · ${Math.round((100 - pct) * 10) / 10}% remaining`];
			const resetMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
			if (Number.isFinite(resetMs)) lines.push(`Resets ${new Date(resetMs).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (local time)`);
			lines.push('Fill = usage · tick = time elapsed');
			if (key === 'session' && this.sessionHistory.length > 1) lines.push(`Recent readings: ${this.sessionHistory.map((v) => `${v}%`).join(' → ')}`);
			lines.push('Click the bars to refresh.');
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

			const processHistory = (storedResetsAt, storedHistory) => {
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
					if (typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.set({
							claude_session_history: { version: 2, resets_at: resetsAt, history }
						});
					}
				} catch (e) {
					// ignore storage errors
				}
			};

			if (this.sessionResetKey !== resetsAt) {
				this.sessionResetKey = resetsAt;
				try {
					if (typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.get(['claude_session_history'], (result) => {
							const data = result?.claude_session_history;
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

			pctSpan.textContent = w && w.expired ? '0%' : 'no data yet';
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
