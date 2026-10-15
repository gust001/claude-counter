'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMainEnv, liveWindow, limitsEvent, conversation, ORG, CONV } = require('./helpers/main-harness');

const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const orgStored = { claude_last_org_id: ORG };

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

const emptyUsage = async () => ({ five_hour: null, seven_day: null });

test('M01 free plan: /usage reports nothing, it is asked once and then only once an hour', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.usageRequests.length, 1);

	await env.clock.advance(10 * MIN); // 600 ticks
	assert.equal(env.calls.usageRequests.length, 1, 'no polling every second');

	await env.clock.advance(51 * MIN);
	assert.equal(env.calls.usageRequests.length, 2, 'one more after an hour');
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(31 * MIN);
	assert.equal(env.calls.usageRequests.length, 3);
});

test('M02 a failed /usage request is retried after a minute, a valid answer after an hour', async () => {
	let fail = true;
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => {
			if (fail) throw new Error('timeout');
			return { five_hour: null, seven_day: null };
		}
	});
	assert.equal(env.calls.usageRequests.length, 1);
	await env.clock.advance(MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 2);
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length, 3);

	fail = false;
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length, 4, 'this one succeeds');
	await env.clock.advance(30 * MIN);
	assert.equal(env.calls.usageRequests.length, 4, 'valid answer: wait');
	await env.clock.advance(31 * MIN);
	assert.equal(env.calls.usageRequests.length, 5);
});

test('M02b an unusable answer (no object) counts as a failure', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: async () => null });
	await env.clock.advance(MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 2);
});

test('M02c nothing is requested while the tab is hidden', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	env.document.hidden = true;
	await env.clock.advance(3 * HOUR);
	assert.equal(env.calls.usageRequests.length, 1);
});

test('M02d without a known organisation nothing can be asked, and it is retried each minute', async () => {
	const env = await createMainEnv({ startMs: START, usage: emptyUsage });
	assert.equal(env.calls.usageRequests.length, 0);
	await env.clock.advance(2 * MIN + 5000);
	assert.equal(env.calls.usageRequests.length, 0);
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.advance(MIN);
	assert.equal(env.calls.usageRequests.length >= 1, true);
});

test('M03 limits from a reply: bars get the values, they are saved with the organisation, /usage is not needed', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.2, 3600], sevenD: [0.1, 86400] }));
	await env.clock.flush();

	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 20);
	assert.equal(Math.round(u.seven_day.utilization), 10);
	assert.equal(u.five_hour.resets_at, new Date(START + HOUR).toISOString());

	const saved = env.stored('claude_usage_state');
	assert.equal(saved.orgId, ORG);
	assert.equal(Math.round(saved.usage.five_hour.utilization), 20);

	const before = env.calls.usageRequests.length;
	await env.clock.advance(59 * MIN);
	assert.equal(env.calls.usageRequests.length, before, 'fresh limits postpone the hourly refresh');
});

test('M04 saved usage is restored on load, no request needed', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	const u = env.lastUsage();
	assert.equal(u.five_hour.utilization, 33);
	assert.equal(u.seven_day.utilization, 12);
	assert.equal(env.calls.usageRequests.length, 0);
});

test('M04b the organisation cookie is not needed (it may be unreadable): the old code needed it', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved, claude_last_org_id: ORG }, startMs: START, cookie: '', usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 33);
});

test('M04c the organisation only becomes known later: the saved usage is restored then', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(40, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.setUsage.length, 0, 'nothing known yet');
	await env.emit('cc:org_detected', { orgId: ORG });
	await env.clock.flush();
	assert.equal(env.lastUsage().five_hour.utilization, 40);
});

test('M04d usage saved for another organisation is not shown, and not deleted', async () => {
	const saved = { orgId: 'some-other-org', usage: { five_hour: liveWindow(77, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	assert.equal(env.calls.setUsage.length, 0);
	assert.deepEqual(env.stored('claude_usage_state'), saved);
});

test('M04e the organisation cookie still works when it is readable', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(12, START + HOUR), seven_day: null } };
	const env = await createMainEnv({ storage: { claude_usage_state: saved }, startMs: START, cookie: `a=b; lastActiveOrg=${ORG}`, usage: emptyUsage });
	assert.equal(env.lastUsage().five_hour.utilization, 12);
});

test('M05 a window that ends shows 0% (expired), the other one stays, the old value does not come back', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.76, 10], sevenD: [0.25, 86400] }));
	await env.clock.flush();
	assert.equal(Math.round(env.lastUsage().five_hour.utilization), 76);

	await env.clock.advance(11000);
	const u = env.lastUsage();
	assert.deepEqual(u.five_hour, { expired: true });
	assert.equal(Math.round(u.seven_day.utilization), 25);

	// /usage was asked at the rollover and knows nothing (free plan): the window must stay expired
	await env.clock.advance(5 * MIN);
	assert.deepEqual(env.lastUsage().five_hour, { expired: true });
	assert.equal(Math.round(env.lastUsage().seven_day.utilization), 25);
	assert.deepEqual(env.stored('claude_usage_state').usage.five_hour, { expired: true });
});

test('M05b both windows can end, and a new reply starts a fresh window', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: [0.5, 5], sevenD: [0.5, 8] }));
	await env.clock.advance(10000);
	assert.deepEqual(env.lastUsage(), { five_hour: { expired: true }, seven_day: { expired: true } });

	await env.emit('cc:message_limit', limitsEvent(env.clock.now, { fiveH: [0.02, 5 * 3600], sevenD: [0.3, 7 * 86400] }));
	const u = env.lastUsage();
	assert.equal(Math.round(u.five_hour.utilization), 2);
	assert.equal(Math.round(u.seven_day.utilization), 30);
});

test('M06 saved usage whose window ended while the page was closed shows 0%', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(71, START - HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	const u = env.lastUsage();
	assert.deepEqual(u.five_hour, { expired: true });
	assert.equal(u.seven_day.utilization, 12);
});

test('M07 /usage with nothing in it never wipes what is known or saved', async () => {
	const saved = { orgId: ORG, usage: { five_hour: liveWindow(33, START + HOUR), seven_day: liveWindow(12, START + 24 * HOUR) } };
	const env = await createMainEnv({ storage: { ...orgStored, claude_usage_state: saved }, startMs: START, usage: emptyUsage });
	await env.clock.advance(61 * MIN); // an hourly refresh happens
	assert.ok(env.calls.usageRequests.length >= 1);
	assert.ok(env.stored('claude_usage_state').usage.seven_day, 'still saved');
	assert.equal(env.lastUsage().seven_day.utilization, 12);
});

test('M08 a paid plan: /usage values are used, a missing window keeps the known one', async () => {
	const env = await createMainEnv({
		storage: orgStored,
		startMs: START,
		usage: async () => ({ five_hour: { utilization: 41, resets_at: new Date(START + HOUR).toISOString() }, seven_day: null })
	});
	assert.equal(env.lastUsage().five_hour.utilization, 41);
	await env.emit('cc:message_limit', limitsEvent(START, { fiveH: null, sevenD: [0.5, 86400] }));
	assert.equal(env.lastUsage().five_hour.utilization, 41, 'a limits event with only one window keeps the other');
	assert.equal(Math.round(env.lastUsage().seven_day.utilization), 50);
});

test('M09 a limits event without windows changes nothing', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const before = env.calls.setUsage.length;
	await env.emit('cc:message_limit', { windows: {} });
	await env.emit('cc:message_limit', null);
	assert.equal(env.calls.setUsage.length, before);
});

// ---- conversation: token count and cache timer ----

function twoMessages(assistantAt) {
	return conversation(CONV, [
		{ uuid: 'm1', sender: 'human', created_at: new Date(assistantAt - 5000).toISOString() },
		{ uuid: 'm2', sender: 'assistant', created_at: new Date(assistantAt).toISOString() }
	]);
}
function fourMessages(assistantAt) {
	return conversation(CONV, [
		{ uuid: 'm1', sender: 'human', created_at: new Date(assistantAt - 60000).toISOString() },
		{ uuid: 'm2', sender: 'assistant', created_at: new Date(assistantAt - 50000).toISOString() },
		{ uuid: 'm3', sender: 'human', created_at: new Date(assistantAt - 5000).toISOString() },
		{ uuid: 'm4', sender: 'assistant', created_at: new Date(assistantAt).toISOString() }
	]);
}

test('M10 opening a chat reads the conversation and shows tokens and the cache end', async () => {
	const at = START - 60000;
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(at) } });
	const m = env.calls.setMetrics[env.calls.setMetrics.length - 1];
	assert.equal(m.totalTokens, 20);
	assert.equal(m.cachedUntil, at + 5 * MIN);
	assert.equal(env.calls.conversationRequests.length, 1);
});

test('M11 end of a reply: the conversation is read again and the timer follows', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(START - HOUR) } });
	assert.equal(env.calls.conversationRequests.length, 1);
	assert.equal(env.calls.setMetrics[env.calls.setMetrics.length - 1].cachedUntil, START - HOUR + 5 * MIN, 'expired timer');

	const doneAt = START + 10 * MIN;
	await env.clock.advance(10 * MIN);
	env.answers.conversation = async () => fourMessages(env.clock.now);
	await env.emit('cc:turn_end', {});
	await env.clock.advance(1300);

	assert.equal(env.calls.conversationRequests.length, 2, 'read once after 1.2 s');
	const m = env.calls.setMetrics[env.calls.setMetrics.length - 1];
	assert.equal(m.totalTokens, 40);
	assert.ok(m.cachedUntil >= doneAt + 5 * MIN);

	await env.clock.advance(30000);
	assert.equal(env.calls.conversationRequests.length, 2, 'new messages seen: no more reads');
});

test('M11b the server is slow to store the reply: it is read again, three times at most', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(START - HOUR) } });
	await env.emit('cc:turn_end', {});
	await env.clock.advance(60000);
	assert.equal(env.calls.conversationRequests.length, 1 + 3);

	// the timer still runs from the end of the reply
	const m = env.calls.setMetrics[env.calls.setMetrics.length - 1];
	assert.equal(m.cachedUntil, START + 5 * MIN);
});

test('M11c the slow server catches up on the second read', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(START - HOUR) } });
	await env.emit('cc:turn_end', {});
	await env.clock.advance(1300);
	assert.equal(env.calls.conversationRequests.length, 2);
	env.answers.conversation = async () => fourMessages(env.clock.now);
	await env.clock.advance(5000);
	assert.equal(env.calls.conversationRequests.length, 3);
	await env.clock.advance(30000);
	assert.equal(env.calls.conversationRequests.length, 3);
});

test('M11d the conversation JSON is newer than the provisional end: the newer one wins', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(START - HOUR) } });
	env.answers.conversation = async () => fourMessages(START + 2 * MIN);
	await env.emit('cc:turn_end', {});
	await env.clock.advance(1300);
	const m = env.calls.setMetrics[env.calls.setMetrics.length - 1];
	assert.equal(m.cachedUntil, START + 2 * MIN + 5 * MIN);
});

test('M11e leaving the chat stops the follow-up reads', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, conversations: { [CONV]: twoMessages(START - HOUR) } });
	await env.emit('cc:turn_end', {});
	await env.clock.advance(500);
	await env.navigate('/new');
	await env.clock.advance(30000);
	assert.equal(env.calls.conversationRequests.length, 1);
});

test('M11f a reply ending on the home page (no chat open) is ignored', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage, pathname: '/new' });
	await env.emit('cc:turn_end', {});
	await env.clock.advance(30000);
	assert.equal(env.calls.conversationRequests.length, 0);
});

test('M12 conversation data for another chat is ignored', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const before = env.calls.setMetrics.length;
	await env.emit('cc:conversation', { orgId: ORG, conversationId: 'some-other-chat', data: twoMessages(START) });
	await env.clock.flush();
	assert.equal(env.calls.setMetrics.length, before);
});

test('M13 an older read that finishes late does not overwrite a newer one', async () => {
	const env = await createMainEnv({ storage: orgStored, startMs: START, usage: emptyUsage });
	const CC = env.context.ClaudeCounter;
	const original = CC.tokens.computeConversationMetrics;
	let first = true;
	CC.tokens.computeConversationMetrics = async (data) => {
		const wasFirst = first;
		first = false;
		if (wasFirst) await new Promise((r) => env.context.setTimeout(r, 500));
		return original(data);
	};
	const slow = env.emit('cc:conversation', { orgId: ORG, conversationId: CONV, data: twoMessages(START) });
	const fast = env.emit('cc:conversation', { orgId: ORG, conversationId: CONV, data: fourMessages(START) });
	await env.clock.advance(600);
	await Promise.all([slow, fast]);
	const m = env.calls.setMetrics[env.calls.setMetrics.length - 1];
	assert.equal(m.totalTokens, 40, 'the newer (four messages) read is what stays');
});
