'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const proto = require('./helpers/proto');
const { createContentEnv } = require('./helpers/content-harness');

const FILES = ['content/capture-redact.js', 'content/capture-store.js', 'content/capture-client.js'];
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function start(storage = {}) {
	const env = createContentEnv({ files: FILES, storage });
	await env.settle();
	return env;
}

function sessionsOf(env) {
	return Object.keys(env.storageData)
		.filter((k) => k.startsWith('ccCap_'))
		.map((k) => env.storageData[k]);
}

async function flush(env) {
	env.fire('pagehide');
	await env.settle(30);
}

test('K01 off by default: the page flag is 0, nothing is stored', async () => {
	const env = await start();
	assert.equal(env.document.documentElement.dataset.ccCapture, '0');
	env.send({ type: 'cc:capture_record', payload: { kind: 'req', id: 1 } });
	await env.settle();
	await flush(env);
	assert.equal(sessionsOf(env).length, 0);
});

test('K02 switching it on in the settings starts a session and sets the page flag', async () => {
	const env = await start();
	env.chrome.storage.local.set({ ccCaptureEnabled: true });
	await env.settle();
	assert.equal(env.document.documentElement.dataset.ccCapture, '1');
	await flush(env);
	const [s] = sessionsOf(env);
	assert.ok(s);
	assert.equal(s.redacted, true);
	assert.equal(s.records[0].kind, 'session');
	assert.equal(s.records[0].ua, 'test-agent');
});

test('K03 already enabled when the page loads: recording starts right away', async () => {
	const env = await start({ ccCaptureEnabled: true });
	assert.equal(env.document.documentElement.dataset.ccCapture, '1');
	await flush(env);
	assert.equal(sessionsOf(env).length, 1);
});

test('K04 records are masked before they are stored, in order, gzip included', async () => {
	const env = await start({ ccCaptureEnabled: true });
	const text = proto.textDeltaFrame('1791743563668-0', 'cblk_000000000000000000000001', 'Soukromý text zprávy').subarray(5);
	const snapshot = Buffer.from(proto.snapshotPayload('1791743563669-0', 'Soukromý název chatu', 1));

	env.send({ type: 'cc:capture_record', payload: { kind: 'frame', id: 1, flags: 1, size: 5, b64: b64(zlib.gzipSync(snapshot)) } });
	env.send({ type: 'cc:capture_record', payload: { kind: 'frame', id: 1, flags: 0, size: text.length, b64: b64(text) } });
	env.send({ type: 'cc:capture_record', payload: { kind: 'stream_end', id: 1, reason: 'done' } });
	await env.settle(60);
	await flush(env);

	const [s] = sessionsOf(env);
	assert.deepEqual(s.records.map((r) => r.kind), ['session', 'frame', 'frame', 'stream_end']);
	assert.equal(s.records[1].wasGzip, true);
	for (const secret of ['Soukromý', 'zprávy', 'chatu']) {
		assert.ok(!JSON.stringify(s).includes(secret), secret);
		for (const r of s.records) if (r.b64) assert.ok(!Buffer.from(r.b64, 'base64').includes(Buffer.from(secret)), secret);
	}
});

test('K05 masking off keeps the bytes as they are', async () => {
	const env = await start({ ccCaptureEnabled: true, ccCaptureRedact: false });
	const text = proto.textDeltaFrame('1791743563668-0', 'b1', 'viditelný text').subarray(5);
	env.send({ type: 'cc:capture_record', payload: { kind: 'frame', id: 1, flags: 0, b64: b64(text) } });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	assert.equal(s.redacted, false);
	assert.ok(Buffer.from(s.records[1].b64, 'base64').includes(Buffer.from('viditelný text')));
});

test('K06 extension events are recorded, a conversation only by its size', async () => {
	const env = await start({ ccCaptureEnabled: true });
	const limits = { windows: { '5h': { status: 1, resets_at: 1791749400, utilization: 0.76 } } };
	env.send({ type: 'cc:message_limit', payload: limits });
	env.send({ type: 'cc:turn_end', payload: {} });
	env.send({ type: 'cc:conversation', payload: { orgId: 'o', conversationId: 'c1', data: { name: 'Tajný chat', chat_messages: [{ text: 'tajné' }, { text: 'tajné' }] } } });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	const events = s.records.filter((r) => r.kind === 'event');
	assert.deepEqual(events.map((e) => e.type), ['cc:message_limit', 'cc:turn_end', 'cc:conversation']);
	assert.deepEqual(events[0].payload, limits);
	assert.equal(events[2].messages, 2);
	assert.ok(!JSON.stringify(s).includes('Tajn'));
	assert.ok(!JSON.stringify(s).includes('tajn'));
});

test('K07 switching it off stops recording and clears the page flag', async () => {
	const env = await start({ ccCaptureEnabled: true });
	env.chrome.storage.local.set({ ccCaptureEnabled: false });
	await env.settle();
	assert.equal(env.document.documentElement.dataset.ccCapture, '0');
	env.send({ type: 'cc:capture_record', payload: { kind: 'req', id: 9 } });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	assert.ok(!s.records.some((r) => r.id === 9));
});

test('K08 messages not coming from the page itself are ignored', async () => {
	const env = await start({ ccCaptureEnabled: true });
	env.sendForeign({ type: 'cc:capture_record', payload: { kind: 'req', id: 5 } });
	env.send({ type: 'cc:capture_record', payload: { kind: 'req', id: 6 } });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	assert.ok(!s.records.some((r) => r.id === 5), 'foreign message ignored');
	assert.ok(s.records.some((r) => r.id === 6), 'own message recorded');
});

test('K09 a navigation is recorded without the conversation id', async () => {
	const env = await start({ ccCaptureEnabled: true });
	env.location.pathname = '/chat/d017d8c7-6458-4449-884f-64980589c699';
	env.window.dispatchEvent({ type: 'cc:urlchange' });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	const nav = s.records.find((r) => r.kind === 'nav');
	assert.equal(nav.path, '/chat/:id');
	assert.ok(!JSON.stringify(s).includes('d017d8c7'));
});

test('K10 changing the masking setting starts a new session with the new setting', async () => {
	const env = await start({ ccCaptureEnabled: true });
	env.chrome.storage.local.set({ ccCaptureRedact: false });
	await env.settle();
	await flush(env);
	const sessions = sessionsOf(env).sort((a, b) => a.startedAt - b.startedAt);
	assert.equal(sessions.length, 2);
	assert.deepEqual(sessions.map((s) => s.redacted), [true, false]);
});

test('K11 without chrome.storage the script does nothing and does not throw', () => {
	const env = createContentEnv({ files: [] });
	env.context.chrome = {};
	assert.doesNotThrow(() => env.load(FILES));
});

test('K12 end to end: records produced by the real bridge are stored masked and can be read back', async () => {
	const fixtures = require('./fixtures/frames.json');
	const { createBridgeEnv, streamResponse, readAll, settle, STREAM_URL } = require('./helpers/bridge-harness');
	const redact = require('../src/content/capture-redact.js');

	const chunks = [
		proto.fromHex(fixtures.frames.text_delta_emoji.hex),
		proto.fromHex(fixtures.frames.limits_5h_first.hex),
		proto.fromHex(fixtures.frames.end_cadence.hex)
	];
	const bridge = createBridgeEnv({ originalFetch: async () => streamResponse(chunks) });
	bridge.setCapture(true);
	await readAll(await bridge.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1, 2, 3]) }));
	await settle(60);
	const produced = bridge.events('cc:capture_record');
	assert.ok(produced.length >= 6);

	const env = await start({ ccCaptureEnabled: true });
	for (const payload of produced) env.send({ type: 'cc:capture_record', payload });
	await env.settle(80);
	await flush(env);

	const [s] = sessionsOf(env);
	const frames = s.records.filter((r) => r.kind === 'frame');
	assert.equal(frames.length, 3);
	const delta = Buffer.from(frames[0].b64, 'base64');
	assert.ok(!delta.includes(Buffer.from('cblk')) || delta.includes(Buffer.from('cblk_')), 'ids stay readable');
	const limitsFrame = Buffer.from(frames[1].b64, 'base64');
	assert.ok(redact.parseMessage(limitsFrame, 0, limitsFrame.length), 'stored limits frame is still a valid message');
	assert.ok(limitsFrame.includes(Buffer.from('five_hour')));
	assert.equal(frames[2].flags, 2);
	assert.ok(frames[2].text.includes('cadence'));
});
