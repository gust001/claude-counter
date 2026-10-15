'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUiEnv, iso, START } = require('./helpers/ui-harness');

const HOUR = 3600 * 1000;

function texts(env) {
	return { session: env.ui.sessionUsageSpan.textContent, weekly: env.ui.weeklyUsageSpan.textContent };
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

// ---- header (token count and cache timer) ----

test('U07 with the usual header anchor the header goes next to it', () => {
	const env = createUiEnv();
	const { title } = env.dom.buildHeader();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 24, cachedUntil: START + 272 * 1000 });
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
	assert.equal(env.ui.headerContainer.textContent.replace(/[ \s]+/g, ' '), '~24 tokens cached for 4:32');
});

test('U08 no header anchor in the page (new layout): the header sits above the usage bars', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 912533, cachedUntil: null });

	assert.equal(env.ui.headerInFallback, true);
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
	assert.ok(env.document.contains(env.ui.headerContainer));
	assert.match(env.ui.headerContainer.textContent, /~912,533 tokens/);
});

test('U08b when the anchor shows up later the header moves to it', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	assert.equal(env.ui.headerInFallback, true);

	const { title } = env.dom.buildHeader();
	env.ui.attachHeader();
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
});

test('U09 an anchor that leads to an invisible header: after a few seconds it moves to the fallback', () => {
	const env = createUiEnv();
	const { header } = env.dom.buildHeader();
	env.dom.buildComposer();
	header.hidden = true; // the header exists but is not rendered
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: null });
	assert.equal(env.ui.headerInFallback, false);

	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerInFallback, false, 'not yet');
	env.ui.tick();
	assert.equal(env.ui.headerInFallback, true);
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
	assert.ok(env.ui.headerContainer.getClientRects().length > 0, 'visible now');
});

test('U09b a visible header is left alone by the check', () => {
	const env = createUiEnv();
	const { title } = env.dom.buildHeader();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: null });
	for (let i = 0; i < 10; i++) env.ui.tick();
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
});

test('U09c nothing to show: nothing is moved', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.headerContainer.remove();
	for (let i = 0; i < 5; i++) env.ui.tick();
	assert.equal(env.ui.headerContainer.parentElement, null);
});

test('U10 the page re-renders and drops the header: the next DOM change puts it back', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 50, cachedUntil: null });
	env.ui.headerContainer.remove();
	assert.ok(!env.document.contains(env.ui.headerContainer));

	for (const observer of env.dom.observers) observer.cb([]);
	assert.ok(env.document.contains(env.ui.headerContainer));
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U11 the cache timer ticks down and disappears at zero', async () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: START + 3000 });
	assert.match(env.ui.headerContainer.textContent, /cached for\s0:03/);
	await env.clock.advance(2000);
	env.ui.tick();
	assert.match(env.ui.headerContainer.textContent, /cached for\s0:01/);
	await env.clock.advance(2000);
	env.ui.tick();
	assert.doesNotMatch(env.ui.headerContainer.textContent, /cached/);
	assert.match(env.ui.headerContainer.textContent, /~100 tokens/);
});

test('U12 an expired cache is not shown at all, the token count still is', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 7, cachedUntil: START - 1000 });
	assert.match(env.ui.headerContainer.textContent, /~7 tokens/);
	assert.doesNotMatch(env.ui.headerContainer.textContent, /cached/);
});

test('U13 leaving a chat clears the header', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 7, cachedUntil: START + 60000 });
	env.ui.setConversationMetrics();
	assert.equal(env.ui.headerContainer.textContent, '');
});

test('U14 tooltips explain the three states', () => {
	const env = createUiEnv();
	assert.match(env.ui.sessionTooltip.textContent, /no data yet/);
	assert.match(env.ui.sessionTooltip.textContent, /0% without a countdown/);
});

test('U15 clicking the usage line asks for a refresh', async () => {
	const env = createUiEnv();
	for (const fn of env.ui.usageLine.listeners.click) await fn();
	assert.equal(env.refreshes.length, 1);
});
