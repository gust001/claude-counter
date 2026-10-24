'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMainEnv, limitsEvent, liveWindow, ORG, CONV } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60 * 1000;
const OTHER = 'e1111111-2222-4333-8444-555555555555';
const orgStored = { claude_last_org_id: ORG };
const ON = { ccAuto: { enabled: true } };

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

/** Replaces the page side of auto-continue with a recording stub. */
function stubPage(env, { box = '' } = {}) {
	const page = { box, sent: [] };
	const d = env.context.ClaudeCounter.autoContinue.dom;
	d.findComposer = () => ({});
	d.readText = () => page.box;
	d.setText = (_e, text) => {
		page.box = text;
		return true;
	};
	d.clear = () => {
		page.box = '';
	};
	d.send = () => {
		page.sent.push(page.box);
		page.box = '';
		return { sent: true, via: 'button' };
	};
	return page;
}

// a reply brings the limits: the 5-hour window at 40 %, ending in an hour; the weekly one is used up
const reply = (env) => limitsEvent(env.clock.now, { fiveH: [0.4, 3600], sevenD: [1.0, 3 * 86400] });
const resetMs = (env) => Math.floor(env.clock.now / 1000) * 1000 + 3600 * 1000;

test('MA01 by default nothing is planned, whatever the usage', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START });
	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [1.0, 3600], sevenD: [1.0, 86400] }));
	await env.clock.advance(2 * 60 * MIN);
	assert.equal(env.stored('ccAutoArmed'), undefined);
	assert.ok(env.calls.auto.every((s) => s === null), 'no indicator');
});

test('MA02 switched on: a reply that tells the 5-hour window plans a message a minute after its end, whatever the weekly one says', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START });
	const reset = resetMs(env);
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed').chatId, CONV);
	assert.equal(env.stored('ccAutoArmed').fireAt, reset + MIN);
	assert.deepEqual(env.calls.auto[env.calls.auto.length - 1], { fireAt: reset + MIN, what: 'continue', again: false });
});

test('MA03 the message is sent by the page timer when the time comes, and the feature switches itself off', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START });
	const page = stubPage(env);
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(59 * MIN);
	assert.deepEqual(page.sent, []);
	await env.clock.advance(3 * MIN);
	assert.deepEqual(page.sent, ['continue']);
	assert.equal(env.stored('ccAutoArmed'), undefined);
	assert.equal(env.stored('ccAuto').enabled, false);
	assert.equal(env.calls.auto[env.calls.auto.length - 1], null);
});

test('MA04 the indicator follows the chat: gone in another chat, back in this one', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START });
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.ok(env.calls.auto[env.calls.auto.length - 1]);
	await env.navigate(`/chat/${OTHER}`);
	assert.equal(env.calls.auto[env.calls.auto.length - 1], null);
	await env.navigate(`/chat/${CONV}`);
	assert.ok(env.calls.auto[env.calls.auto.length - 1]);
});

test('MA05 a 5-hour window saved from an earlier visit is enough to plan when the page opens', async () => {
	const snapshot = { orgId: ORG, orgIds: [ORG], usage: { five_hour: liveWindow(40, START + 60 * MIN), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, ...ON, claude_usage_state: snapshot }, startMs: START });
	await env.clock.advance(2000);
	assert.equal(env.stored('ccAutoArmed')?.chatId, CONV);
	assert.equal(env.stored('ccAutoArmed')?.fireAt, START + 61 * MIN);
});

test('MA06 the indicator cancels the plan and switches the feature off', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START });
	const page = stubPage(env);
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.ok(env.stored('ccAutoArmed'));
	env.calls.uiOpts.onAutoCancel();
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed'), undefined);
	assert.equal(env.stored('ccAuto').enabled, false);
	assert.equal(env.stored('ccAutoLast').last.result, 'cancelled');
	await env.clock.advance(2 * 60 * MIN);
	assert.deepEqual(page.sent, []);
});

test('MA07 on the new-chat page the plan is made for that page, with the message box option, and sent from there', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START, pathname: '/new' });
	const page = stubPage(env, { box: 'Nový dotaz' });
	const reset = resetMs(env);
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed')?.chatId, 'new');
	assert.equal(env.stored('ccAuto').what, 'composer');
	assert.deepEqual(env.calls.auto[env.calls.auto.length - 1], { fireAt: reset + MIN, what: 'composer', again: false });
	await env.clock.advance(62 * MIN);
	assert.deepEqual(page.sent, ['Nový dotaz']);
	assert.equal(env.stored('ccAuto').enabled, false);
});

test('MA07b the home page counts as the new-chat page; a plan for it waits while a chat is open and is carried out back on it', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START, pathname: '/' });
	const page = stubPage(env, { box: 'Nový dotaz' });
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed')?.chatId, 'new');
	await env.navigate(`/chat/${CONV}`);
	assert.equal(env.calls.auto[env.calls.auto.length - 1], null, 'no indicator in a chat');
	await env.clock.advance(62 * MIN);
	assert.deepEqual(page.sent, [], 'a chat is not the new-chat page');
	await env.navigate('/new');
	await env.clock.advance(2000);
	assert.deepEqual(page.sent, ['Nový dotaz']);
});

test('MA07c on other pages (settings, projects) nothing is planned', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START, pathname: '/settings/profile' });
	await env.emit('cc:message_limit', reply(env));
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed'), undefined);
	assert.ok(env.calls.auto.every((s) => s === null));
});

test('MA08 an expired 5-hour window plans nothing and the settings are told why', async () => {
	const env = await createMainEnv({ storage: { ...orgStored, ...ON }, startMs: START });
	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [1.0, -10], sevenD: [0.1, 86400] }));
	await env.clock.advance(1000);
	assert.equal(env.stored('ccAutoArmed'), undefined);
	assert.match(env.stored('ccAutoWait'), /5-hour window is not known/);
});

test('MA09 a fixed time needs no usage data at all', async () => {
	const at = '2026-10-21T03:00';
	const env = await createMainEnv({ storage: { ...orgStored, ccAuto: { enabled: true, when: 'atTime', at } }, startMs: START });
	const page = stubPage(env);
	await env.clock.advance(2000);
	const fixed = new Date(2026, 9, 21, 3, 0).getTime();
	assert.equal(env.stored('ccAutoArmed')?.fireAt, fixed);
	await env.clock.advance(fixed - env.clock.now + 2000);
	assert.deepEqual(page.sent, ['continue']);
});
