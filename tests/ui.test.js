'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUiEnv, iso, START } = require('./helpers/ui-harness');

const HOUR = 3600 * 1000;

function texts(env) {
	return { session: env.ui.sessionUsageSpan.textContent, weekly: env.ui.weeklyUsageSpan.textContent };
}

function responsiveComposer() {
	const env = createUiEnv();
	env.dom.buildHeader();
	const { box, input } = env.dom.buildComposer();
	const wrapper = env.document.createElement('div');
	env.document.body.appendChild(wrapper);
	wrapper.appendChild(box);
	const chin = env.document.createElement('div');
	chin.setAttribute('data-cds', 'ChatComposerChin');
	wrapper.appendChild(chin);
	const control = env.document.createElement('button');
	chin.appendChild(control);
	chin.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, height: 40 });
	control.getBoundingClientRect = () => ({ left: 0, right: 250, width: 250, height: 30 });
	return { ...env, box, input, chin, control, wrapper };
}

test('U01 before any data the bars say "no data yet", not 0%', () => {
	const env = createUiEnv();
	assert.deepEqual(texts(env), { session: 'Session: no data yet', weekly: 'Weekly: no data yet' });
});

test('U02 a live window shows the value, the bar and the countdown', () => {
	const env = createUiEnv();
	env.ui.setUsage({
		five_hour: { utilization: 76, resets_at: iso(START + HOUR) },
		seven_day: { utilization: 25.04, resets_at: iso(START + 49 * HOUR) }
	});
	assert.deepEqual(texts(env), { session: 'Session: 76% · resets in 1h 0m', weekly: 'Weekly: 25% · resets in 2d 1h' });
	assert.equal(env.ui.sessionBarFill.style.width, '76%');
	assert.equal(env.ui.weeklyBarFill.style.width, '25.04%');
	assert.equal(env.ui.sessionMarker.classList.contains('cc-hidden'), false);
});

test('U03 an expired window shows 0% with no countdown and no marker', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: { utilization: 10, resets_at: iso(START + 5 * HOUR) } });
	assert.equal(texts(env).session, 'Session: 0%');
	assert.equal(env.ui.sessionBarFill.style.width, '0%');
	assert.equal(env.ui.sessionMarker.classList.contains('cc-hidden'), true);
	assert.equal(env.ui.sessionResetMs, null);
	assert.match(texts(env).weekly, /^Weekly: 10% · resets in/);
});

test('U03b ticking never brings a countdown back to an expired window', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: { expired: true } });
	env.ui.tick();
	assert.deepEqual(texts(env), { session: 'Session: 0%', weekly: 'Weekly: 0%' });
});

test('U04 a window that was never reported is "no data yet", also when the other one is known', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: null, seven_day: { utilization: 3, resets_at: iso(START + 3 * HOUR) } });
	assert.equal(texts(env).session, 'Session: no data yet');
	assert.equal(env.ui.sessionBarFill.style.width, '0%');
	env.ui.setUsage({});
	assert.deepEqual(texts(env), { session: 'Session: no data yet', weekly: 'Weekly: no data yet' });
	env.ui.setUsage(undefined);
	assert.equal(texts(env).session, 'Session: no data yet');
});

test('U05 states can change back and forth', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { utilization: 99.9, resets_at: iso(START + HOUR) }, seven_day: null });
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-full'), true);
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: null });
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-full'), false);
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-warn'), false);
	env.ui.setUsage({ five_hour: { utilization: 5, resets_at: iso(START + 5 * HOUR) }, seven_day: null });
	assert.match(texts(env).session, /^Session: 5% · resets in 5h/);
});

test('U06 the countdown text counts down with the clock', async () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { utilization: 10, resets_at: iso(START + 90 * 1000) }, seven_day: null });
	assert.equal(texts(env).session, 'Session: 10% · resets in 2m');
	await env.clock.advance(40 * 1000);
	env.ui.tick();
	assert.equal(texts(env).session, 'Session: 10% · resets in 50s');
});

test('U14 tooltips explain the current state without unrelated caveats', () => {
	const env = createUiEnv();
	assert.match(env.ui.sessionTooltip.textContent, /No data yet/);
	env.ui.setUsage({ five_hour: { utilization: 40, resets_at: iso(START + HOUR) }, seven_day: { expired: true } });
	assert.match(env.ui.sessionTooltip.textContent, /40% used · 60% remaining/);
	assert.match(env.ui.sessionTooltip.textContent, /local time/);
	assert.match(env.ui.sessionTooltip.textContent, /Fill = usage · tick = time elapsed/);
	assert.match(env.ui.weeklyTooltip.textContent, /Reset time reached/);
	assert.doesNotMatch(env.ui.sessionTooltip.textContent, /No data yet/);
});

test('U15 clicking the usage line asks for a refresh', async () => {
	const env = createUiEnv();
	for (const fn of env.ui.usageLine.listeners.click) await fn();
	assert.equal(env.refreshes.length, 1);
});

test('U57a the usage row stays above the composer and its menus', () => {
	const env = responsiveComposer();
	env.ui.attach();
	assert.equal(env.ui.usageLine.nextElementSibling, env.box);
	assert.equal(env.ui.usageLine.parentElement, env.wrapper);
	assert.equal(env.box.contains(env.ui.usageLine), false);
	assert.equal(env.ui._usageMisplaced(), false);
});

test('U57b a relocated model selector does not drag usage below the input', () => {
	const env = responsiveComposer();
	env.ui.attach();
	const model = env.document.createElement('button');
	model.setAttribute('data-testid', 'model-selector-dropdown');
	env.chin.appendChild(model);
	env.ui.attach();
	assert.equal(env.ui.usageLine.nextElementSibling, env.box);
	assert.equal(env.chin.contains(env.ui.usageLine), false);
});

test('U57d page mutations repair a row that was moved inside the input card', async () => {
	const env = responsiveComposer();
	env.ui.usageLine.getBoundingClientRect = () => ({ left: 500, right: 980, width: 480, height: 30 });
	env.ui.attach();
	env.box.appendChild(env.ui.usageLine);
	for (const observer of env.dom.observers) observer.cb([]);
	await env.clock.advance(150);
	assert.equal(env.ui.usageLine.nextElementSibling, env.box);
});

test('U57e warning colours progress from amber to red and clear for unknown/expired data', () => {
	const env = createUiEnv();
	for (const [pct, caution, warn] of [[74, false, false], [75, true, false], [90, false, true]]) {
		env.ui.setUsage({ five_hour: { utilization: pct } });
		assert.equal(env.ui.sessionBarFill.classList.contains('cc-caution'), caution);
		assert.equal(env.ui.sessionBarFill.classList.contains('cc-warn'), warn);
	}
	env.ui.setUsage({ five_hour: { expired: true } });
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-caution'), false);
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-warn'), false);
});

test('U47 tooltips stay within the viewport and dismiss on a click', () => {
	const env = createUiEnv();
	env.ui.sessionGroup.getBoundingClientRect = () => ({ left: 1260, top: 2, right: 1360, bottom: 22, width: 100, height: 20 });
	for (const fn of env.ui.sessionGroup.listeners.pointerenter) fn({ pointerType: 'mouse' });
	assert.equal(env.ui.sessionTooltip.style.left, '1170px');
	assert.equal(env.ui.sessionTooltip.style.top, '30px');
	assert.equal(env.ui.sessionTooltip.style.visibility, 'visible');
	for (const fn of env.ui.sessionGroup.listeners.pointerdown) fn({ pointerType: 'mouse' });
	assert.equal(env.ui.sessionTooltip.style.visibility, 'hidden');
});

test('U48 session history labels actual readings without inventing a zero baseline', async () => {
	const env = createUiEnv();
	const resets_at = iso(START + HOUR);
	env.ui.setUsage({ five_hour: { utilization: 40, resets_at } });
	assert.doesNotMatch(env.ui.sessionTooltip.textContent, /Recent readings/);
	await env.clock.flush();
	env.ui.setUsage({ five_hour: { utilization: 45, resets_at } });
	assert.match(env.ui.sessionTooltip.textContent, /Recent readings: 40% → 45%/);
});

test('U49 loading placeholders never mount bars against a page-wide container', () => {
	const env = createUiEnv();
	const input = env.document.createElement('textarea');
	env.document.body.appendChild(input);
	env.ui.attach();
	assert.equal(env.ui.usageLine.isConnected, false);
	assert.equal(env.ui.usageLine.classList.contains('cc-unmounted'), true);
});

test('U50 hydration of the same input attaches bars when its card styling appears', async () => {
	const env = createUiEnv();
	const box = env.document.createElement('div');
	const input = env.document.createElement('div');
	input.setAttribute('data-testid', 'chat-input');
	box.appendChild(input);
	env.document.body.appendChild(box);
	env.ui.attach();
	assert.equal(env.ui.usageLine.isConnected, false);
	box.className = 'bg-surface-3';
	for (const observer of env.dom.observers) observer.cb([]);
	await env.clock.advance(150);
	assert.equal(env.ui.usageLine.nextElementSibling, box);
	assert.equal(env.ui.usageLine.classList.contains('cc-unmounted'), false);
});

test('U51 a hidden old composer does not steal bars from the active chat', () => {
	const env = createUiEnv();
	const old = env.dom.buildComposer();
	env.ui.attach();
	old.box.hidden = true;
	const current = env.dom.buildComposer();
	env.ui.tick();
	assert.equal(env.ui.usageLine.nextElementSibling, current.box);
	assert.notEqual(env.ui.usageLine.nextElementSibling, old.box);
});

test('U52 a replacement composer recovers after the loading view removes the old one', async () => {
	const env = createUiEnv();
	const old = env.dom.buildComposer();
	env.ui.attach();
	old.box.remove();
	for (const observer of env.dom.observers) observer.cb([]);
	await env.clock.advance(150);
	assert.equal(env.ui.usageLine.classList.contains('cc-unmounted'), true);
	const current = env.dom.buildComposer();
	for (const observer of env.dom.observers) observer.cb([]);
	await env.clock.advance(150);
	assert.equal(env.ui.usageLine.nextElementSibling, current.box);
	assert.equal(env.ui.usageLine.classList.contains('cc-unmounted'), false);
});

test('U53 quota width follows the input card rather than a page-wide parent', () => {
	const env = createUiEnv();
	const { box } = env.dom.buildComposer();
	box.getBoundingClientRect = () => ({ left: 200, top: 500, width: 640, height: 100, right: 840, bottom: 600 });
	env.ui.attach();
	assert.equal(env.ui.usageLine.style.width, '640px');
	box.getBoundingClientRect = () => ({ left: 200, top: 500, width: 400, height: 100, right: 600, bottom: 600 });
	env.ui.tick();
	assert.equal(env.ui.usageLine.style.width, '400px');
});

test('U54 an offscreen previous editor cannot win over the visible chat', () => {
	const env = createUiEnv();
	const old = env.dom.buildComposer();
	old.input.getBoundingClientRect = () => ({ left: -500, top: 0, width: 100, height: 20, right: -400, bottom: 20 });
	const current = env.dom.buildComposer();
	env.ui.attach();
	assert.equal(env.ui.usageLine.nextElementSibling, current.box);
});

test('U55 token counter is hidden initially and appears before the quota groups when enabled', () => {
	const env = createUiEnv();
	assert.equal(env.ui.tokenDisplay.classList.contains('cc-hidden'), true);
	env.ui.setTokenCounter({ enabled: true, active: true, totalTokens: 12345, status: 'ready' });
	assert.equal(env.ui.tokenDisplay.classList.contains('cc-hidden'), false);
	assert.equal(env.ui.tokenDisplay.textContent, '~12,345 tokens');
	assert.equal(env.ui.tokenDisplay.nextElementSibling, env.ui.quotaGroups);
	assert.match(env.ui.tokenTooltip.textContent, /compaction/);
	env.ui.setTokenCounter({ enabled: false, active: true });
	assert.equal(env.ui.tokenDisplay.classList.contains('cc-hidden'), true);
});

test('U58 a burst of page mutations costs one composer scan, after a short pause (#3)', async () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	let scans = 0;
	const find = env.ui._findComposerBox.bind(env.ui);
	env.ui._findComposerBox = () => { scans++; return find(); };
	const unrelated = env.document.createElement('p');
	env.document.body.appendChild(unrelated);
	for (let i = 0; i < 100; i++) {
		for (const observer of env.dom.observers) observer.cb([{ type: 'childList', target: unrelated }]);
	}
	assert.equal(scans, 0, 'no layout reads inside the observer callback');
	await env.clock.advance(150);
	assert.equal(scans, 1, 'one scan for the whole burst');

	// A batch mixing our own node with a page node is page work and must be checked (#13).
	for (const observer of env.dom.observers) observer.cb([{ type: 'attributes', target: env.ui.sessionBarFill }, { type: 'childList', target: unrelated }]);
	await env.clock.advance(150);
	assert.equal(scans, 2);
});

test('U59 mutations of the extension\'s own nodes schedule nothing (#3)', async () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	let scans = 0;
	const find = env.ui._findComposerBox.bind(env.ui);
	env.ui._findComposerBox = () => { scans++; return find(); };
	for (const observer of env.dom.observers) observer.cb([{ type: 'attributes', target: env.ui.sessionBarFill }]);
	await env.clock.advance(150);
	assert.equal(scans, 0);
});

test('U60 recent session readings are kept per organisation; the old shared key is ignored (#6)', async () => {
	const env = createUiEnv();
	const resets_at = iso(START + HOUR);
	env.storageData.claude_session_history = { version: 2, resets_at, history: [10, 20] };
	env.ui.setOrg('org-a-0001');
	env.ui.setUsage({ five_hour: { utilization: 40, resets_at } });
	await env.clock.flush();
	env.ui.setUsage({ five_hour: { utilization: 45, resets_at } });
	await env.clock.flush();
	assert.match(env.ui.sessionTooltip.textContent, /Recent readings: 40% → 45%/, 'the shared legacy history is not mixed in');
	assert.deepEqual(env.storageData['claude_session_history:org-a-0001'].history, [40, 45]);
	env.ui.setOrg('org-b-0002');
	env.ui.setUsage({ five_hour: { utilization: 50, resets_at } });
	await env.clock.flush();
	assert.doesNotMatch(env.ui.sessionTooltip.textContent, /Recent readings/, 'org B does not inherit org A readings');
	assert.deepEqual(env.storageData['claude_session_history:org-b-0002'].history, [50]);
	assert.deepEqual(env.storageData['claude_session_history:org-a-0001'].history, [40, 45]);
});

test('U61 Session and Weekly are keyboard buttons that refresh and describe themselves (#6)', async () => {
	const env = createUiEnv();
	for (const [group, tooltip] of [[env.ui.sessionGroup, env.ui.sessionTooltip], [env.ui.weeklyGroup, env.ui.weeklyTooltip]]) {
		assert.equal(group.getAttribute('role'), 'button');
		assert.equal(group.getAttribute('tabindex'), '0');
		assert.ok(tooltip.id, 'the tooltip has an id');
		assert.equal(group.getAttribute('aria-describedby'), tooltip.id);
	}
	assert.equal(env.ui.tokenDisplay.getAttribute('aria-describedby'), env.ui.tokenTooltip.id);
	const press = async (group, key, extra = {}) => {
		let prevented = false;
		for (const fn of group.listeners.keydown) await fn({ key, preventDefault: () => { prevented = true; }, ...extra });
		return prevented;
	};
	for (const group of [env.ui.sessionGroup, env.ui.weeklyGroup]) {
		const before = env.refreshes.length;
		assert.equal(await press(group, 'Enter'), true);
		assert.equal(await press(group, ' '), true);
		assert.equal(env.refreshes.length, before + 2);
		assert.equal(await press(group, 'a'), false);
		// Held keys and shortcuts belong to the browser or page, not to a refresh (C3, #12).
		for (const extra of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
			assert.equal(await press(group, 'Enter', extra), false, JSON.stringify(extra));
		}
		assert.equal(env.refreshes.length, before + 2);
	}
});

test('U62 tooltips appear on keyboard focus and hide on blur or Escape (#6, #12)', () => {
	const env = createUiEnv();
	for (const group of [env.ui.sessionGroup, env.ui.weeklyGroup]) {
		const tooltip = group === env.ui.sessionGroup ? env.ui.sessionTooltip : env.ui.weeklyTooltip;
		group.matches = (selector) => selector === ':focus-visible'; // keyboard focus
		for (const fn of group.listeners.focus) fn({});
		assert.equal(tooltip.style.visibility, 'visible');
		for (const fn of group.listeners.blur) fn({});
		assert.equal(tooltip.style.visibility, 'hidden');
		for (const fn of group.listeners.focus) fn({});
		env.fireWindow('keydown', { key: 'Escape' });
		assert.equal(tooltip.style.visibility, 'hidden', 'Escape dismisses it');
	}
});

test('U67 a touch tap that focuses a quota button does not pin its tooltip open (C1, #12)', () => {
	const env = createUiEnv();
	env.ui.weeklyGroup.matches = () => false; // focus without :focus-visible, as after a tap
	for (const fn of env.ui.weeklyGroup.listeners.focus) fn({});
	assert.notEqual(env.ui.weeklyTooltip.style.visibility, 'visible');
});

test('U68 a pending history read for an org is ignored once a newer update for that org ran (C2, #12)', async () => {
	const env = createUiEnv();
	const resets_at = iso(START + HOUR);
	const key = 'claude_session_history:org-a-0001';
	env.storageData[key] = { version: 2, resets_at, history: [10] };
	const reads = [];
	const get = env.chrome.storage.local.get;
	env.chrome.storage.local.get = (keys, cb) => reads.push(() => get(keys, cb));
	env.ui.setOrg('org-a-0001');
	env.ui.setUsage({ five_hour: { utilization: 40, resets_at } }); // read 1, held
	env.ui.setOrg('org-b-0002');
	env.ui.setOrg('org-a-0001');
	env.ui.setUsage({ five_hour: { utilization: 45, resets_at } }); // read 2, held
	reads[1]();
	await env.clock.flush(); // storage answers asynchronously
	env.ui.setUsage({ five_hour: { utilization: 50, resets_at } });
	reads[0](); // the stale read finishes last
	await env.clock.flush();
	assert.deepEqual(env.storageData[key].history, [10, 45, 50]);
	assert.match(env.ui.sessionTooltip.textContent, /10% → 45% → 50%/);
});

test('U66 the fade route table (C4, #12)', () => {
	const { isConversationPage } = createUiEnv().CC.ui;
	const cases = {
		'/chat/d017d8c7': true,
		'/project/p1/chat/d017d8c7': true, // nested chat routes matched in 2.1.7 and still do
		'/code/session_01PWd9m9bo3k1fLhqDAJHu8w': true,
		'/chat/': false,
		'/code': false,
		'/code/': false,
		'/code/new': false,
		'/new': false,
		'/': false,
		'/projects': false
	};
	for (const [path, expected] of Object.entries(cases)) assert.equal(isConversationPage(path), expected, path);
});

test('U63 Spanish pages get whole tooltips and token texts in Spanish, not just the labels (#6)', async () => {
	const env = createUiEnv({ lang: 'es-ES' });
	const english = /quota|used|remaining|Resets|local time|Click|No data|Recent|Fill|Counting|unavailable|Approximate|Reset time/;
	assert.doesNotMatch(env.ui.sessionTooltip.textContent, english);
	assert.match(env.ui.sessionTooltip.textContent, /Cuota de sesión · 5 horas/);
	const resets_at = iso(START + HOUR);
	env.ui.setOrg('org-a-0001');
	env.ui.setUsage({ five_hour: { utilization: 40, resets_at }, seven_day: { expired: true } });
	await env.clock.flush();
	env.ui.setUsage({ five_hour: { utilization: 45, resets_at }, seven_day: { expired: true } });
	await env.clock.flush();
	for (const tip of [env.ui.sessionTooltip, env.ui.weeklyTooltip, env.ui.tokenTooltip]) assert.doesNotMatch(tip.textContent, english);
	assert.match(env.ui.sessionTooltip.textContent, /45% usado · 55% restante/);
	assert.match(env.ui.sessionTooltip.textContent, /Lecturas recientes: 40% → 45%/);
	assert.match(env.ui.weeklyTooltip.textContent, /Cuota semanal/);
	env.ui.setUsage(null);
	assert.equal(env.ui.sessionPctSpan.textContent, 'sin datos aún');
	env.ui.setTokenCounter({ enabled: true, active: true, totalTokens: null, status: 'loading' });
	assert.equal(env.ui.tokenDisplay.textContent, 'Contando…');
	env.ui.setTokenCounter({ enabled: true, active: true, totalTokens: null, status: 'error' });
	assert.equal(env.ui.tokenDisplay.textContent, 'Tokens no disponibles');
});

// #7: the soft fade above the bars belongs to ongoing conversations, in Chat and in Claude Code.
function fadeOn(pathname, { rowTop = 500 } = {}) {
	const env = createUiEnv({ pathname });
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.usageLine.getBoundingClientRect = () => ({ left: 200, right: 840, width: 640, top: rowTop, bottom: rowTop + 24, height: 24 });
	env.ui.tick();
	return env.ui.composerFade;
}

test('U64 the fade shows above the bars in Chat and Claude Code conversations', () => {
	for (const path of ['/chat/d017d8c7-6458-4449-884f-64980589c699', '/code/session_01PWd9m9bo3k1fLhqDAJHu8w']) {
		const fade = fadeOn(path);
		assert.equal(fade.style.display, 'block', path);
		assert.equal(fade.style.top, '460px', `${path}: 40px above the row`);
		assert.equal(fade.style.height, '40px', path);
	}
});

test('U65 the fade stays hidden on pages without a transcript and when the bars are off-screen', () => {
	for (const path of ['/', '/new', '/code', '/code/', '/code/new', '/projects']) {
		assert.equal(fadeOn(path).style.display, 'none', path);
	}
	assert.equal(fadeOn('/code/session_01PWd9m9bo3k1fLhqDAJHu8w', { rowTop: 900 }).style.display, 'none', 'row below the viewport');
});
