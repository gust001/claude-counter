'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CaptureStore, listSessions, clearSessions, KEY_PREFIX } = require('../src/content/capture-store.js');
const { createFakeChrome, promiseStorage } = require('./helpers/fake-chrome');

const tick = () => new Promise((r) => setImmediate(r));

function makeStore(fake, options = {}, extra = {}) {
	return new CaptureStore({ storage: promiseStorage(fake), redacted: true, url: '/chat/x', options: { flushDelayMs: 5, ...options }, ...extra });
}

test('S01 records are written to one key and can be listed', async () => {
	const fake = createFakeChrome();
	const store = makeStore(fake);
	store.add({ t: 1, kind: 'req', id: 1 });
	store.add({ t: 2, kind: 'res', id: 1 });
	await store.flush();

	const sessions = await listSessions(promiseStorage(fake));
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].records.length, 2);
	assert.equal(sessions[0].redacted, true);
	assert.equal(sessions[0].url, '/chat/x');
	assert.ok(Object.keys(fake.data).every((k) => k.startsWith(KEY_PREFIX)));
});

test('S02 the record limit stops recording and leaves a marker', async () => {
	const fake = createFakeChrome();
	const store = makeStore(fake, { maxRecords: 3 });
	const results = [1, 2, 3, 4, 5].map((i) => store.add({ t: i, kind: 'x' }));
	await store.flush();
	assert.deepEqual(results, [true, true, true, false, false]);
	const [s] = await listSessions(promiseStorage(fake));
	assert.equal(s.capped, true);
	assert.equal(s.records.length, 4);
	assert.equal(s.records[3].kind, 'capped');
});

test('S03 the size limit stops recording', async () => {
	const fake = createFakeChrome();
	const store = makeStore(fake, { maxBytes: 1000 });
	let accepted = 0;
	for (let i = 0; i < 50; i++) if (store.add({ t: i, kind: 'frame', b64: 'A'.repeat(100) })) accepted++;
	await store.flush();
	assert.ok(accepted >= 3 && accepted < 15, `accepted ${accepted}`);
	const [s] = await listSessions(promiseStorage(fake));
	assert.equal(s.capped, true);
});

test('S04 only the newest sessions are kept, other storage keys are left alone', async () => {
	const fake = createFakeChrome({ claude_usage_state: { orgId: 'o', usage: {} } });
	let clock = 1000;
	for (let i = 0; i < 6; i++) {
		clock += 1000;
		const store = makeStore(fake, { maxSessions: 3 }, { now: () => clock });
		store.add({ t: clock, kind: 'session' });
		await store.start();
		await store.flush();
		await tick();
	}
	const sessions = await listSessions(promiseStorage(fake));
	assert.equal(sessions.length, 3);
	assert.deepEqual(sessions.map((s) => s.startedAt), [7000, 6000, 5000]);
	assert.ok('claude_usage_state' in fake.data);
});

test('S05 clearSessions removes recordings only', async () => {
	const fake = createFakeChrome({ claude_usage_state: { orgId: 'o' }, ccCaptureEnabled: true });
	const store = makeStore(fake);
	store.add({ t: 1, kind: 'x' });
	await store.flush();
	assert.equal(await clearSessions(promiseStorage(fake)), 1);
	assert.deepEqual(Object.keys(fake.data).sort(), ['ccCaptureEnabled', 'claude_usage_state']);
});

test('S06 a failing storage never throws into the caller', async () => {
	const storage = {
		get: async () => {
			throw new Error('boom');
		},
		set: async () => {
			throw new Error('boom');
		},
		remove: async () => {
			throw new Error('boom');
		}
	};
	const store = new CaptureStore({ storage, redacted: false, url: '/', options: { flushDelayMs: 1 } });
	assert.doesNotThrow(() => store.add({ t: 1, kind: 'x' }));
	await store.flush();
});

test('S07 a stopped store adds nothing and writes nothing, also not what was already scheduled', async () => {
	const fake = createFakeChrome();
	const store = makeStore(fake);
	store.add({ t: 1, kind: 'req', id: 1 });
	await store.flush();
	const key = Object.keys(fake.data)[0];

	store.add({ t: 2, kind: 'req', id: 2 }); // schedules a write
	await promiseStorage(fake).remove([key]); // the user deletes the recording
	store.stop();
	assert.equal(store.add({ t: 3, kind: 'req', id: 3 }), false);
	await new Promise((r) => setTimeout(r, 40));
	await store.flush();
	assert.deepEqual(Object.keys(fake.data), [], 'the session did not come back');
});
