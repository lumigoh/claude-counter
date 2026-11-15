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
