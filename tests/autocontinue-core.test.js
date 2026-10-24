'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, usage, MIN } = require('./helpers/auto-helpers');

const NOW = new Date(2026, 9, 18, 12, 0, 0).getTime(); // local time on purpose: fixed times are local
const local = (d, h, m = 0) => new Date(2026, 9, d, h, m, 0, 0).getTime();

test('C01 settings: defaults are off, invalid values fall back, the offset may be negative and is clamped', () => {
	const d = core.normalizeSettings(null);
	assert.deepEqual({ ...d }, { enabled: false, when: 'afterReset', offsetMin: 1, at: '', what: 'continue', text: 'continue', again: false });
	const n = core.normalizeSettings({ enabled: 'yes', offsetMin: 'soon', when: 'whenever', what: 'x', at: '2026-13-40T25:00', text: '   ', again: 'yes' });
	assert.equal(n.enabled, false, 'only the boolean true switches it on');
	assert.equal(n.offsetMin, 1);
	assert.equal(n.when, 'afterReset');
	assert.equal(n.what, 'continue');
	assert.equal(n.at, '');
	assert.equal(n.text, 'continue');
	assert.equal(n.again, false, 'only the boolean true ticks the box');
	const ok = core.normalizeSettings({ enabled: true, when: 'atTime', offsetMin: '-10', at: '2026-10-19T03:00', what: 'composer', text: '  go   on  ', again: true });
	assert.deepEqual({ ...ok }, { enabled: true, when: 'atTime', offsetMin: -10, at: '2026-10-19T03:00', what: 'composer', text: 'go on', again: true });
	assert.equal(core.normalizeSettings({ offsetMin: -9999 }).offsetMin, -core.OFFSET_LIMIT_MIN);
	assert.equal(core.normalizeSettings({ offsetMin: 9999 }).offsetMin, core.OFFSET_LIMIT_MIN);
	assert.equal(core.normalizeSettings({ text: 'x'.repeat(500) }).text.length, 200);
});

test('C01b settings of the first build (delayMin, time of day, threshold) still load', () => {
	const old = core.normalizeSettings({ enabled: true, threshold: 90, delayMin: 7, when: 'atTime', timeOfDay: '22:30', what: 'composer', text: 'x' });
	assert.equal(old.offsetMin, 7);
	assert.equal(old.when, 'atTime');
	assert.equal(old.at, '', 'a time of day is not a moment: it has to be chosen again');
	assert.equal(old.what, 'composer');
	assert.ok(!('threshold' in old));
});

test('C02 a fixed moment is read as local time; impossible dates are refused', () => {
	assert.equal(core.parseLocalDateTime('2026-10-19T03:00'), local(19, 3));
	assert.equal(core.parseLocalDateTime('2026-02-30T10:00'), null);
	assert.equal(core.parseLocalDateTime('2026-10-19 03:00'), null);
	assert.equal(core.parseLocalDateTime('2026-10-19T24:00'), null);
	assert.equal(core.parseLocalDateTime(''), null);
	assert.equal(core.parseLocalDateTime(null), null);
});

test('C03 the 5-hour window counts only when live and not yet over', () => {
	const t = NOW;
	assert.equal(core.fiveHour(null, t), null);
	assert.equal(core.fiveHour(usage({}), t), null, 'no window');
	assert.deepEqual(core.fiveHour(usage({ fiveH: [40, t + 60 * MIN] }), t), { resetMs: t + 60 * MIN, utilization: 40 });
	assert.equal(core.fiveHour(usage({ fiveH: [40, t - 1] }), t), null, 'already over');
	assert.equal(core.fiveHour({ five_hour: { expired: true }, seven_day: null }, t), null);
	assert.equal(core.fiveHour(usage({ sevenD: [100, t + 3 * 86400000] }), t), null, 'the weekly window is not the 5-hour one');
	assert.equal(core.isUsedUp({ utilization: 100 }), true);
	assert.equal(core.isUsedUp({ utilization: 99.995 }), true, 'rounding noise');
	assert.equal(core.isUsedUp({ utilization: 99 }), false);
	assert.equal(core.isUsedUp(null), false);
});

test('C04 relative time: the end of the 5-hour window plus the offset, which may be negative', () => {
	const reset = NOW + 60 * MIN;
	const u = usage({ fiveH: [40, reset] });
	const s = (offsetMin) => core.normalizeSettings({ when: 'afterReset', offsetMin });
	assert.deepEqual(core.computeFireAt(s(1), u, NOW), { ok: true, fireAt: reset + MIN, resetMs: reset });
	assert.equal(core.computeFireAt(s(0), u, NOW).fireAt, reset);
	assert.equal(core.computeFireAt(s(15), u, NOW).fireAt, reset + 15 * MIN);
	assert.equal(core.computeFireAt(s(-10), u, NOW).fireAt, reset - 10 * MIN, 'before the end: use up what is left');
});

test('C05 relative time follows the 5-hour window, whatever the weekly one does', () => {
	const reset5 = NOW + 60 * MIN;
	const reset7 = NOW + 3 * 86400000;
	const both = usage({ fiveH: [30, reset5], sevenD: [100, reset7] });
	assert.equal(core.computeFireAt(core.normalizeSettings({ offsetMin: 1 }), both, NOW).fireAt, reset5 + MIN);
	assert.equal(core.computeFireAt(core.normalizeSettings({ offsetMin: 1 }), usage({ fiveH: [100, reset5], sevenD: [100, reset7] }), NOW).fireAt, reset5 + MIN);
});

test('C06 relative time cannot be worked out without a live 5-hour window, or when that moment has passed', () => {
	const s = core.normalizeSettings({ offsetMin: 1 });
	const none = core.computeFireAt(s, null, NOW);
	assert.equal(none.ok, false);
	assert.match(none.reason, /5-hour window is not known/);
	assert.equal(core.computeFireAt(s, usage({ sevenD: [100, NOW + 86400000] }), NOW).ok, false, 'only the weekly window is known');
	assert.equal(core.computeFireAt(s, usage({ fiveH: [40, NOW - 1000] }), NOW).ok, false, 'the window is over');
	const past = core.computeFireAt(core.normalizeSettings({ offsetMin: -90 }), usage({ fiveH: [40, NOW + 60 * MIN] }), NOW);
	assert.equal(past.ok, false);
	assert.match(past.reason, /already passed/);
	assert.match(past.reason, /13:00/, 'the end of the window is named');
});

test('C07 a fixed moment needs no window and is never in the past', () => {
	const s = (at) => core.normalizeSettings({ when: 'atTime', at, offsetMin: 5 });
	assert.deepEqual(core.computeFireAt(s('2026-10-19T03:00'), null, NOW), { ok: true, fireAt: local(19, 3) }, 'the offset does not apply to a fixed moment');
	assert.equal(core.computeFireAt(s('2026-10-19T03:00'), usage({ fiveH: [100, NOW + 60 * MIN] }), NOW).fireAt, local(19, 3), 'the windows do not matter');
	const past = core.computeFireAt(s('2026-10-18T11:59'), null, NOW);
	assert.equal(past.ok, false);
	assert.match(past.reason, /passed/);
	const none = core.computeFireAt(s(''), null, NOW);
	assert.equal(none.ok, false);
	assert.match(none.reason, /choose/);
});

test('C08 which settings change the time; times are shown as HH:MM', () => {
	const base = core.normalizeSettings({ enabled: true });
	assert.equal(core.timingChanged(base, { ...base, text: 'other', what: 'composer', again: true }), false);
	assert.equal(core.timingChanged(base, { ...base, offsetMin: 5 }), true);
	assert.equal(core.timingChanged(base, { ...base, when: 'atTime' }), true);
	assert.equal(core.timingChanged(base, { ...base, at: '2026-10-19T03:00' }), true);
	assert.equal(core.formatClock(new Date(2026, 9, 18, 7, 5).getTime()), '07:05');
});

test('C09 the second "continue" follows the reset within a few seconds, so that the 5-minute cache window is not lost', () => {
	assert.ok(core.AGAIN_DELAY_MS >= 2000 && core.AGAIN_DELAY_MS <= 5000, `${core.AGAIN_DELAY_MS} ms`);
});
