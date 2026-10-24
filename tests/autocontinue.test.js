'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, makeStore, makePage, makeTab, usage, MIN, CHAT, OTHER_CHAT, ON } = require('./helpers/auto-helpers');

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const clockAt = () => ({ t: T0 });
const RESET = T0 + 60 * MIN;
const LIVE = (pct = 40) => usage({ fiveH: [pct, RESET] });
const armedOf = (tab) => tab.store.data[core.ARMED_KEY];
const lastOf = (tab) => tab.store.data[core.LAST_KEY];
const settingsOf = (tab) => tab.store.data[core.SETTINGS_KEY];
const waitOf = (tab) => tab.store.data[core.WAIT_KEY];

/** Switched on, the 5-hour window known: the message is planned for the chat in front. */
async function armedTab(options = {}) {
	const tab = await makeTab({ settings: ON, now: clockAt(), ...options });
	tab.controller.noteUsage(LIVE(), 'sse');
	await tab.settle();
	return tab;
}

test('A01 switched off (the default): nothing is stored, planned or sent', async () => {
	const tab = await makeTab({ now: clockAt() });
	tab.controller.noteUsage(LIVE(100), 'sse');
	await tab.advance(3 * 60 * MIN);
	assert.deepEqual(Object.keys(tab.store.data), []);
	assert.deepEqual(tab.page.sent, []);
	assert.deepEqual(tab.page.inserted, []);
});

test('A02 switched on with the 5-hour window known: planned for its end plus the offset, for this chat, and saved', async () => {
	const tab = await armedTab();
	assert.deepEqual({ ...armedOf(tab) }, { v: 2, kind: 'send', chatId: CHAT, fireAt: RESET + MIN, armedAt: T0, tries: 0 });
	assert.deepEqual(tab.statuses[tab.statuses.length - 1], { fireAt: RESET + MIN, what: 'continue', again: false });
	assert.equal(waitOf(tab), undefined);
});

test('A02b the indicator shows only in the chat the plan belongs to', async () => {
	const tab = await armedTab();
	tab.setChat(OTHER_CHAT);
	assert.equal(tab.statuses[tab.statuses.length - 1], null);
	tab.setChat(CHAT);
	assert.ok(tab.statuses[tab.statuses.length - 1]);
});

test('A03 without a known 5-hour window nothing is planned and the settings are told why; the window arrives, the plan is made', async () => {
	const tab = await makeTab({ settings: ON, now: clockAt() });
	await tab.settle();
	assert.equal(armedOf(tab), undefined);
	assert.match(waitOf(tab), /5-hour window is not known/);
	tab.controller.noteUsage(usage({ sevenD: [100, T0 + 86400000] }), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab), undefined, 'the weekly window is no use');
	tab.controller.noteUsage(LIVE(), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab).fireAt, RESET + MIN);
	assert.equal(waitOf(tab), undefined, 'the reason is taken back');
});

test('A04 only the tab in front plans: the plan is for the chat the user is looking at', async () => {
	const store = makeStore({ [core.SETTINGS_KEY]: ON });
	const now = clockAt();
	const behind = await makeTab({ store, now, chat: CHAT, visible: false });
	const front = await makeTab({ store, now, chat: OTHER_CHAT, visible: true });
	front.controller.noteUsage(LIVE(), 'sse');
	behind.controller.noteUsage(LIVE(), 'sse');
	await behind.settle(10);
	assert.equal(armedOf(front).chatId, OTHER_CHAT);
	now.t += 61 * MIN;
	behind.controller.tick();
	front.controller.tick();
	await behind.settle(60);
	assert.deepEqual(behind.page.sent, [], 'the tab behind is not the chat');
	assert.deepEqual(front.page.sent, ['continue']);
});

test('A04a a tab that is not in front plans nothing and does not even say why', async () => {
	const tab = await makeTab({ settings: ON, now: clockAt(), visible: false });
	tab.controller.noteUsage(LIVE(), 'sse');
	await tab.advance(2000);
	assert.equal(armedOf(tab), undefined);
	assert.equal(waitOf(tab), undefined);
	tab.front.visible = true;
	await tab.advance(1000);
	assert.equal(armedOf(tab).chatId, CHAT, 'planned as soon as it is in front');
});

test('A04b a tab that is not on a chat plans nothing; the chat page of the same tab does', async () => {
	const tab = await makeTab({ settings: ON, now: clockAt(), chat: null });
	tab.controller.noteUsage(LIVE(), 'sse');
	await tab.advance(1000);
	assert.equal(armedOf(tab), undefined);
	tab.setChat(CHAT);
	await tab.settle();
	assert.equal(armedOf(tab).chatId, CHAT);
});

test('A05 a negative offset sends before the end of the window; a moment that has passed is not planned', async () => {
	const tab = await armedTab({ settings: { enabled: true, offsetMin: -10 } });
	assert.equal(armedOf(tab).fireAt, RESET - 10 * MIN);
	await tab.advance(49 * MIN);
	assert.deepEqual(tab.page.sent, []);
	await tab.advance(MIN);
	assert.deepEqual(tab.page.sent, ['continue'], 'ten minutes before the reset');

	const late = await armedTab({ settings: { enabled: true, offsetMin: -90 } });
	assert.equal(armedOf(late), undefined);
	assert.match(waitOf(late), /already passed/);
});

test('A06 the weekly window does not move the plan: it follows the 5-hour window', async () => {
	const tab = await makeTab({ settings: ON, now: clockAt() });
	tab.controller.noteUsage(usage({ fiveH: [30, RESET], sevenD: [100, T0 + 3 * 86400000] }), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab).fireAt, RESET + MIN);
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['continue']);
});

test('A07 a fixed moment needs no window and is not planned when it has passed or is missing', async () => {
	const at = '2026-10-21T03:00';
	const fixed = core.parseLocalDateTime(at);
	const tab = await makeTab({ settings: { enabled: true, when: 'atTime', at }, now: clockAt() });
	await tab.settle();
	assert.equal(armedOf(tab).fireAt, fixed);
	await tab.advance(fixed - T0 - 1000);
	assert.deepEqual(tab.page.sent, []);
	await tab.advance(1000);
	assert.deepEqual(tab.page.sent, ['continue']);

	const past = await makeTab({ settings: { enabled: true, when: 'atTime', at: '2026-10-17T10:00' }, now: clockAt() });
	await past.settle();
	assert.equal(armedOf(past), undefined);
	assert.match(waitOf(past), /passed/);

	const empty = await makeTab({ settings: { enabled: true, when: 'atTime' }, now: clockAt() });
	await empty.settle();
	assert.match(waitOf(empty), /choose a date and time/);
});

test('A08 "continue" is typed and sent once the time has come and not earlier; then it switches itself off, the settings stay', async () => {
	const tab = await armedTab({ settings: { enabled: true, offsetMin: 3, text: 'continue', again: false } });
	await tab.advance(60 * MIN); // the reset itself
	assert.deepEqual(tab.page.sent, []);
	await tab.advance(3 * MIN - 1000);
	assert.deepEqual(tab.page.sent, []);
	await tab.advance(1000);
	assert.deepEqual(tab.page.inserted, ['continue']);
	assert.deepEqual(tab.page.sent, ['continue']);
	assert.equal(tab.page.box, '');
	assert.equal(armedOf(tab), undefined);
	assert.equal(lastOf(tab).last.result, 'sent');
	assert.equal(settingsOf(tab).enabled, false, 'switched off');
	assert.equal(settingsOf(tab).offsetMin, 3, 'the other settings stay');
	assert.equal(tab.statuses[tab.statuses.length - 1], null);
	await tab.advance(10 * MIN);
	assert.equal(tab.page.sent.length, 1, 'only once');
});

test('A08b the text can be chosen', async () => {
	const tab = await armedTab({ settings: { enabled: true, text: 'Pokračuj prosím' } });
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['Pokračuj prosím']);
});

test('A09 the message box option sends what is in the box; an empty box ends the plan with a note', async () => {
	const filled = await armedTab({ settings: { enabled: true, what: 'composer' }, page: makePage({ box: 'Ještě shrň závěry' }) });
	await filled.advance(61 * MIN);
	assert.deepEqual(filled.page.sent, ['Ještě shrň závěry']);
	assert.deepEqual(filled.page.inserted, [], 'nothing typed');
	assert.equal(settingsOf(filled).enabled, false);

	const empty = await armedTab({ settings: { enabled: true, what: 'composer' } });
	await empty.advance(61 * MIN);
	assert.deepEqual(empty.page.sent, []);
	assert.equal(lastOf(empty).last.result, 'skipped');
	assert.match(lastOf(empty).last.reason, /empty/);
	assert.equal(armedOf(empty), undefined);
	assert.equal(settingsOf(empty).enabled, false);
});

test('A10 the text option leaves a draft alone', async () => {
	const tab = await armedTab({ page: makePage({ box: 'half-written thought' }) });
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, []);
	assert.equal(tab.page.box, 'half-written thought');
	assert.equal(lastOf(tab).last.result, 'skipped');
	assert.match(lastOf(tab).last.reason, /draft/);
	assert.equal(settingsOf(tab).enabled, false);
});

test('A11 in another chat at the time nothing is sent and the user is not pulled away; back in the chat within the hour it is sent', async () => {
	const tab = await armedTab();
	tab.setChat(OTHER_CHAT);
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, []);
	assert.deepEqual(tab.page.inserted, []);
	assert.ok(armedOf(tab), 'the plan waits for its chat');
	tab.setChat(CHAT);
	await tab.advance(1000);
	assert.deepEqual(tab.page.sent, ['continue']);
});

test('A12 a message that was due long ago (computer asleep, chat not open) is not sent', async () => {
	const tab = await armedTab();
	await tab.advance(61 * MIN + core.GRACE_MS + 1000);
	assert.deepEqual(tab.page.sent, []);
	assert.equal(lastOf(tab).last.result, 'skipped');
	assert.match(lastOf(tab).last.reason, /long ago/);
	assert.equal(settingsOf(tab).enabled, false);

	const away = await armedTab();
	away.setChat(OTHER_CHAT);
	await away.advance(61 * MIN + core.GRACE_MS + 1000);
	assert.deepEqual(away.page.sent, []);
	assert.match(lastOf(away).last.reason, /long ago/, 'a tab on another chat clears the plan too');
});

test('A13 a disabled send button: tried again after a minute, three times in all, the box is left clean, then off', async () => {
	const tab = await armedTab({ page: makePage({ sendEnabled: false }) });
	await tab.advance(61 * MIN);
	assert.equal(armedOf(tab).tries, 1);
	assert.equal(armedOf(tab).fireAt, tab.now.t + MIN);
	assert.equal(tab.page.box, '', 'the typed text was taken out again');
	await tab.advance(MIN);
	assert.equal(armedOf(tab).tries, 2);
	await tab.advance(MIN);
	assert.equal(armedOf(tab), undefined);
	assert.equal(lastOf(tab).last.result, 'failed');
	assert.match(lastOf(tab).last.reason, /disabled/);
	assert.deepEqual(tab.page.sent, []);
	assert.equal(tab.page.box, '');
	assert.equal(settingsOf(tab).enabled, false);
});

test('A14 a page that does not accept the message gets one more try a minute later', async () => {
	const tab = await armedTab({ page: makePage({ accepts: false }) });
	await tab.advance(61 * MIN);
	assert.equal(armedOf(tab).tries, 1);
	assert.equal(tab.page.box, '');
	tab.page.accepts = true;
	await tab.advance(MIN);
	assert.deepEqual(tab.page.sent, ['continue']);
	assert.equal(lastOf(tab).last.result, 'sent');
});

test('A15 no message box on the page: tried again, then given up', async () => {
	const tab = await armedTab({ page: makePage({ hasComposer: false }) });
	await tab.advance(61 * MIN);
	await tab.advance(MIN);
	await tab.advance(MIN);
	assert.equal(lastOf(tab).last.result, 'failed');
	assert.match(lastOf(tab).last.reason, /message box/);
	assert.equal(settingsOf(tab).enabled, false);
});

test('A16 cancelling (the indicator) ends the plan and switches the feature off', async () => {
	const tab = await armedTab();
	await tab.controller.cancel();
	await tab.settle();
	assert.equal(armedOf(tab), undefined);
	assert.equal(lastOf(tab).last.result, 'cancelled');
	assert.equal(settingsOf(tab).enabled, false);
	await tab.advance(2 * 60 * MIN);
	assert.deepEqual(tab.page.sent, []);
	tab.controller.noteUsage(LIVE(), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab), undefined, 'not planned again by itself');
});

test('A17 switching it off in the settings drops the plan and the reason', async () => {
	const tab = await armedTab();
	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: false } });
	await tab.settle(10);
	assert.equal(armedOf(tab), undefined);
	assert.equal(tab.statuses[tab.statuses.length - 1], null);
	await tab.advance(2 * 60 * MIN);
	assert.deepEqual(tab.page.sent, []);

	const waiting = await makeTab({ settings: ON, now: clockAt() });
	await waiting.settle();
	assert.ok(waitOf(waiting));
	waiting.store.area.set({ [core.SETTINGS_KEY]: { enabled: false } });
	await waiting.settle(10);
	assert.equal(waitOf(waiting), undefined);
});

test('A18 changing the time moves the plan; changing the text does not; an unusable time drops it until fixed', async () => {
	const tab = await armedTab();
	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, offsetMin: -10 } });
	await tab.settle(10);
	assert.equal(armedOf(tab).fireAt, RESET - 10 * MIN);
	assert.equal(armedOf(tab).chatId, CHAT, 'still the same chat');

	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, offsetMin: -10, text: 'Jdi dál', what: 'composer', again: true } });
	await tab.settle(10);
	assert.equal(armedOf(tab).fireAt, RESET - 10 * MIN, 'what is sent does not change when');

	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, when: 'atTime', at: '' } });
	await tab.settle(10);
	assert.equal(armedOf(tab), undefined);
	assert.match(waitOf(tab), /choose a date and time/);

	const fixed = core.parseLocalDateTime('2026-10-21T03:00');
	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, when: 'atTime', at: '2026-10-21T03:00' } });
	await tab.settle(10);
	assert.equal(armedOf(tab).fireAt, fixed);
	assert.equal(waitOf(tab), undefined);
});

test('A19 the plan survives a reload of the page', async () => {
	const first = await armedTab();
	const second = await makeTab({ store: first.store, now: first.now });
	assert.equal(second.controller.state().armed.fireAt, RESET + MIN);
	await second.advance(61 * MIN);
	assert.deepEqual(second.page.sent, ['continue']);
});

test('A20 two tabs on the same chat send one message, not two', async () => {
	const store = makeStore({ [core.SETTINGS_KEY]: ON });
	const now = clockAt();
	const a = await makeTab({ store, now });
	const b = await makeTab({ store, now });
	a.controller.noteUsage(LIVE(), 'sse');
	b.controller.noteUsage(LIVE(), 'sse');
	await a.settle(10);
	now.t += 61 * MIN;
	a.controller.tick();
	b.controller.tick();
	await a.settle(60);
	assert.equal(a.page.sent.length + b.page.sent.length, 1);
	assert.equal(settingsOf(a).enabled, false);
});

test('A20b a claim left by a tab that died a while ago does not block the message', async () => {
	const first = await armedTab();
	const stored = armedOf(first);
	first.store.data[core.ARMED_KEY] = { ...stored, claim: { tab: 'ghost', at: first.now.t - 10 * MIN } };
	const tab = await makeTab({ store: first.store, now: first.now });
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['continue']);
});

test('A21 a stored plan is ignored while the feature is off, and a plan of the first build is not taken over', async () => {
	const old = { v: 1, chatId: CHAT, resetMs: RESET, fireAt: RESET + MIN, tries: 0 };
	const off = await makeTab({ store: makeStore({ [core.ARMED_KEY]: old }), now: clockAt() });
	await off.advance(2 * 60 * MIN);
	assert.deepEqual(off.page.sent, []);

	const on = await makeTab({ store: makeStore({ [core.ARMED_KEY]: old, [core.SETTINGS_KEY]: ON }), now: clockAt() });
	on.controller.noteUsage(LIVE(), 'sse');
	await on.settle();
	assert.equal(armedOf(on).v, 2);
	assert.equal(armedOf(on).kind, 'send');
});

test('A22 "send continue once more": after the first message it watches; when the window is used up again the second follows a few seconds after its reset', async () => {
	const tab = await armedTab({ settings: { enabled: true, again: true } });
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['continue']);
	assert.equal(armedOf(tab).kind, 'watch');
	assert.equal(settingsOf(tab).enabled, true, 'still on: the second message is possible');
	assert.equal(tab.statuses[tab.statuses.length - 1], null, 'nothing to show yet');

	tab.controller.noteUsage(usage({ fiveH: [60, tab.now.t + 120 * MIN] }), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab).kind, 'watch', 'not used up yet');

	const reset2 = tab.now.t + 3 * 60 * MIN;
	tab.controller.noteUsage(usage({ fiveH: [100, reset2] }), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab).kind, 'again');
	assert.equal(armedOf(tab).fireAt, reset2 + core.AGAIN_DELAY_MS);
	assert.deepEqual(tab.statuses[tab.statuses.length - 1], { fireAt: reset2 + core.AGAIN_DELAY_MS, what: 'continue', again: true });

	await tab.advance(3 * 60 * MIN);
	assert.equal(tab.page.sent.length, 1, 'not at the reset itself');
	await tab.advance(core.AGAIN_DELAY_MS - 1000);
	assert.equal(tab.page.sent.length, 1, 'not before the few seconds have passed');
	await tab.advance(2000);
	assert.deepEqual(tab.page.sent, ['continue', 'continue']);
	assert.match(lastOf(tab).last.reason, /second continue/);
	assert.equal(armedOf(tab), undefined);
	assert.equal(settingsOf(tab).enabled, false, 'now it is off');
	await tab.advance(6 * 60 * MIN);
	assert.equal(tab.page.sent.length, 2, 'never a third');
});

test('A22b the second message is the chosen text; after the box content it is "continue"', async () => {
	const text = await armedTab({ settings: { enabled: true, again: true, text: 'Pokračuj prosím' } });
	await text.advance(61 * MIN);
	text.controller.noteUsage(usage({ fiveH: [100, text.now.t + 60 * MIN] }), 'sse');
	await text.settle();
	await text.advance(61 * MIN);
	assert.deepEqual(text.page.sent, ['Pokračuj prosím', 'Pokračuj prosím']);

	const box = await armedTab({ settings: { enabled: true, again: true, what: 'composer', text: 'ignored here' }, page: makePage({ box: 'Shrň to' }) });
	await box.advance(61 * MIN);
	assert.deepEqual(box.page.sent, ['Shrň to']);
	box.controller.noteUsage(usage({ fiveH: [100, box.now.t + 60 * MIN] }), 'sse');
	await box.settle();
	await box.advance(61 * MIN);
	assert.deepEqual(box.page.sent, ['Shrň to', 'continue']);
});

test('A23 when the window is not used up again the watch ends and the feature switches off; saved data and an unticked box do not trigger it', async () => {
	const quiet = await armedTab({ settings: { enabled: true, again: true } });
	await quiet.advance(61 * MIN);
	quiet.controller.noteUsage(usage({ fiveH: [100, quiet.now.t + 60 * MIN] }), 'cache');
	await quiet.settle();
	assert.equal(armedOf(quiet).kind, 'watch', 'a saved snapshot is no news');
	await quiet.advance(core.WATCH_MS + MIN);
	assert.equal(settingsOf(quiet).enabled, false);
	assert.equal(armedOf(quiet), undefined);
	assert.equal(quiet.page.sent.length, 1);
	assert.equal(lastOf(quiet).last.result, 'sent', 'the result of the message stays');

	const unticked = await armedTab({ settings: { enabled: true, again: true } });
	await unticked.advance(61 * MIN);
	unticked.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, again: false } });
	await unticked.settle(10);
	unticked.controller.noteUsage(usage({ fiveH: [100, unticked.now.t + 60 * MIN] }), 'sse');
	await unticked.settle(10);
	assert.equal(settingsOf(unticked).enabled, false);
	await unticked.advance(2 * 60 * MIN);
	assert.equal(unticked.page.sent.length, 1);
});

test('A24 the watch survives a reload of the page', async () => {
	const first = await armedTab({ settings: { enabled: true, again: true } });
	await first.advance(61 * MIN);
	const second = await makeTab({ store: first.store, now: first.now });
	assert.equal(second.controller.state().armed.kind, 'watch');
	second.controller.noteUsage(usage({ fiveH: [100, second.now.t + 60 * MIN] }), 'sse');
	await second.settle();
	await second.advance(61 * MIN);
	assert.deepEqual(second.page.sent, ['continue']);
});

test('A25 a draft in the box when the second message is due: skipped, and the feature is off', async () => {
	const tab = await armedTab({ settings: { enabled: true, again: true } });
	await tab.advance(61 * MIN);
	tab.page.box = 'something I started';
	tab.controller.noteUsage(usage({ fiveH: [100, tab.now.t + 60 * MIN] }), 'sse');
	await tab.settle();
	await tab.advance(61 * MIN);
	assert.equal(tab.page.sent.length, 1);
	assert.equal(tab.page.box, 'something I started');
	assert.match(lastOf(tab).last.reason, /draft/);
	assert.equal(settingsOf(tab).enabled, false);
});

const NEW = core.NEW_CHAT;
const REAL_CHAT = 'f2222222-3333-4444-8555-666666666666';

test('A27 switched on in the new-chat page: planned for that page, and the message box option is chosen for the user', async () => {
	const tab = await armedTab({ chat: NEW, settings: { enabled: true, what: 'continue' }, page: makePage({ box: 'Napiš mi plán' }) });
	assert.equal(armedOf(tab).chatId, NEW);
	assert.equal(settingsOf(tab).what, 'composer', 'nothing to continue in a new chat');
	assert.deepEqual(tab.statuses[tab.statuses.length - 1], { fireAt: RESET + MIN, what: 'composer', again: false });
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['Napiš mi plán']);
	assert.deepEqual(tab.page.inserted, [], 'nothing typed');
	assert.equal(settingsOf(tab).enabled, false);
});

test('A27b a plan for the new-chat page sends the box content even if the text option is chosen afterwards; an empty box ends it', async () => {
	const tab = await armedTab({ chat: NEW, page: makePage({ box: 'abc' }) });
	tab.store.area.set({ [core.SETTINGS_KEY]: { enabled: true, what: 'continue' } });
	await tab.settle(10);
	assert.equal(tab.statuses[tab.statuses.length - 1].what, 'composer', 'the indicator tells what really happens');
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['abc']);
	assert.deepEqual(tab.page.inserted, [], '"continue" is never typed into a new chat');

	const empty = await armedTab({ chat: NEW });
	await empty.advance(61 * MIN);
	assert.deepEqual(empty.page.sent, []);
	assert.match(lastOf(empty).last.reason, /empty/);
	assert.equal(settingsOf(empty).enabled, false);
});

test('A28 a plan for the new-chat page is not carried out anywhere else, and a chat plan is not carried out on the new-chat page', async () => {
	const tab = await armedTab({ chat: NEW, page: makePage({ box: 'Nový dotaz' }) });
	tab.setChat(CHAT);
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, [], 'a chat is not the new-chat page');
	assert.equal(tab.statuses[tab.statuses.length - 1], null);
	tab.setChat(NEW);
	await tab.advance(1000);
	assert.deepEqual(tab.page.sent, ['Nový dotaz'], 'back on the new-chat page within the hour');

	const chat = await armedTab({ page: makePage({ box: 'x' }) });
	chat.setChat(NEW);
	await chat.advance(61 * MIN);
	assert.deepEqual(chat.page.sent, []);
	assert.ok(armedOf(chat), 'still waiting for its chat');
});

test('A29 the second "continue" goes to the chat the first message created (the page moved on at once)', async () => {
	const tab = await armedTab({ chat: NEW, settings: { enabled: true, again: true }, page: makePage({ box: 'Nový dotaz' }) });
	tab.page.onSend = () => tab.setChat(REAL_CHAT);
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['Nový dotaz']);
	assert.equal(armedOf(tab).kind, 'watch');
	assert.equal(armedOf(tab).chatId, REAL_CHAT);
	const reset2 = tab.now.t + 60 * MIN;
	tab.controller.noteUsage(usage({ fiveH: [100, reset2] }), 'sse');
	await tab.settle();
	assert.equal(armedOf(tab).kind, 'again');
	assert.equal(armedOf(tab).chatId, REAL_CHAT);
	await tab.advance(61 * MIN);
	assert.deepEqual(tab.page.sent, ['Nový dotaz', 'continue']);
	assert.equal(settingsOf(tab).enabled, false);
});

test('A29b the chat address arrives a little later: the watch takes it over, in the tab that sent, only', async () => {
	const store = makeStore({ [core.SETTINGS_KEY]: { enabled: true, again: true, what: 'composer' } });
	const now = clockAt();
	const sender = await makeTab({ store, now, chat: NEW, page: makePage({ box: 'Nový dotaz' }) });
	const other = await makeTab({ store, now, chat: CHAT, visible: false });
	sender.controller.noteUsage(LIVE(), 'sse');
	await sender.settle(10);
	await sender.advance(61 * MIN);
	assert.deepEqual(sender.page.sent, ['Nový dotaz']);
	assert.equal(armedOf(sender).chatId, NEW);
	other.setChat(REAL_CHAT);
	await other.settle(10);
	assert.equal(armedOf(sender).chatId, NEW, 'a tab that did not send does not take it over');
	sender.setChat(REAL_CHAT);
	await sender.settle(10);
	assert.equal(armedOf(sender).chatId, REAL_CHAT);
});

test('A26 the indicator callback never breaks the controller', async () => {
	const tab = await makeTab({ settings: ON, now: clockAt() });
	const broken = require('./helpers/auto-helpers').autoContinue.create({
		storageArea: tab.store.area,
		onChanged: tab.store.onChanged,
		now: () => tab.now.t,
		dom: tab.page,
		getChatId: () => CHAT,
		isVisible: () => true,
		onStatus: () => {
			throw new Error('indicator failed');
		}
	});
	await broken.ready();
	broken.setChat(CHAT);
	broken.noteUsage(LIVE(), 'sse');
	await tab.settle(10);
	assert.ok(armedOf(tab), 'still planned');
});
