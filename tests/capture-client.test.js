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
	assert.equal(events[2].conversationId, undefined, 'no conversation id in the event');
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

test('K13 no conversation id is stored: not in the session address, the session record, the navigation', async () => {
	const env = createContentEnv({ files: FILES, storage: { ccCaptureEnabled: true }, pathname: '/chat/d017d8c7-6458-4449-884f-64980589c699' });
	await env.settle();
	env.location.pathname = '/project/0b3e5d36-1c4a-4c0e-9d6f-aaaaaaaaaaaa/chat/e1111111-2222-4333-8444-555555555555';
	env.window.dispatchEvent({ type: 'cc:urlchange' });
	await env.settle(40);
	await flush(env);
	const [s] = sessionsOf(env);
	assert.equal(s.url, '/chat/:id');
	assert.equal(s.records[0].path, '/chat/:id');
	const nav = s.records.find((r) => r.kind === 'nav');
	assert.ok(!/[0-9a-f]{8}-/.test(nav.path), nav.path);
	assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(s)), 'no uuid anywhere in the session');
});

test('K14 deleting the recording stops this page from writing it again', async () => {
	const env = await start({ ccCaptureEnabled: true });
	await flush(env);
	const [key] = Object.keys(env.storageData).filter((k) => k.startsWith('ccCap_'));
	assert.ok(key);

	env.chrome.storage.local.remove([key]);
	await env.settle(40);
	env.send({ type: 'cc:capture_record', payload: { kind: 'req', id: 77 } });
	await env.settle(40);
	await flush(env);
	await env.settle(40);
	assert.deepEqual(Object.keys(env.storageData).filter((k) => k.startsWith('ccCap_')), [], 'not written again');
});

test('K15 records still being prepared when recording is switched off are not stored', async () => {
	const env = await start({ ccCaptureEnabled: true });
	const snapshot = Buffer.from(proto.snapshotPayload('1791743563669-0', 'Titulek', 1));
	const packed = b64(zlib.gzipSync(snapshot));
	for (let i = 0; i < 40; i++) env.send({ type: 'cc:capture_record', payload: { kind: 'frame', id: 100 + i, flags: 1, b64: packed } });
	await new Promise((r) => setImmediate(r)); // the messages are handled, the gunzip chain is under way
	env.chrome.storage.local.set({ ccCaptureEnabled: false });
	await env.settle(2400); // longer than the delay of the store's own write
	const [s] = sessionsOf(env);
	const stored = s.records.filter((r) => r.kind === 'frame').length;
	assert.ok(stored < 40, `stored ${stored} of 40 frames although recording was switched off`);
});

test('K16 the page snapshot keeps aria-labels only when masking is off', async () => {
	const run = async (redactOn) => {
		const timers = [];
		const fakeSetTimeout = (fn, ms) => {
			if (ms >= 2000) {
				timers.push(fn);
				return { unref() {} };
			}
			return setTimeout(fn, ms);
		};
		const env = createContentEnv({ files: [], storage: { ccCaptureEnabled: true, ccCaptureRedact: redactOn }, extraGlobals: { setTimeout: fakeSetTimeout } });
		const el = {
			tagName: 'BUTTON',
			className: 'btn',
			parentElement: null,
			getBoundingClientRect: () => ({ left: 1, top: 2, width: 30, height: 10 }),
			getAttribute: (k) => ({ 'aria-label': 'Projekt rodinný rozpočet', 'data-testid': 'chat-title-button' })[k] || null
		};
		env.document.body = {};
		env.document.querySelectorAll = (sel) => (sel.includes('data-testid') ? [el] : []);
		env.load(FILES);
		await env.settle();
		for (const fn of timers.splice(0)) fn();
		await env.settle(40);
		env.fire('pagehide');
		await env.settle(40);
		return sessionsOf(env)[0];
	};
	const masked = await run(true);
	const dom = masked.records.find((r) => r.kind === 'dom');
	assert.ok(dom, 'a dom record exists');
	assert.equal(dom.top[0].testid, 'chat-title-button');
	assert.equal(dom.top[0].aria, 'x'.repeat(24));
	assert.ok(!JSON.stringify(masked).includes('rozpo'));

	const open = await run(false);
	assert.equal(open.records.find((r) => r.kind === 'dom').top[0].aria, 'Projekt rodinný rozpočet');
});

test('K17 the page snapshot finds the chat title element by its text, and masks the text', async () => {
	const run = async (redactOn) => {
		const timers = [];
		const fakeSetTimeout = (fn, ms) => {
			if (ms >= 2000) {
				timers.push(fn);
				return { unref() {} };
			}
			return setTimeout(fn, ms);
		};
		const env = createContentEnv({ files: [], storage: { ccCaptureEnabled: true, ccCaptureRedact: redactOn }, extraGlobals: { setTimeout: fakeSetTimeout, getComputedStyle: () => ({ position: 'fixed', zIndex: '10', display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', overflow: 'hidden', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(red, blue)', pointerEvents: 'none', maskImage: 'none', backdropFilter: 'none' }) } });
		const box = (l, t, w, h) => ({ left: l, top: t, width: w, height: h });
		const mk = (tag, text, parent, rect, attrs = {}) => ({
			tagName: tag,
			className: '',
			textContent: text,
			children: [],
			parentElement: parent,
			nextElementSibling: null,
			closest: () => null,
			getBoundingClientRect: () => rect,
			getAttribute: (k) => attrs[k] || null
		});
		const bar = mk('DIV', 'Rodinný rozpočet', null, box(0, 0, 900, 40), { 'data-testid': 'chat-title-bar' });
		const leaf = mk('SPAN', 'Rodinný rozpočet', bar, box(10, 10, 140, 18));
		bar.children = [leaf];
		const sidebar = mk('SPAN', 'Rodinný rozpočet', null, box(0, 300, 100, 18));
		sidebar.closest = () => ({});
		env.document.title = 'Rodinný rozpočet - Claude';
		env.document.body = {};
		env.document.querySelectorAll = (sel) => (sel === '*' ? [bar, leaf, sidebar] : []);
		env.document.querySelector = () => null;
		env.load(FILES);
		await env.settle();
		for (const fn of timers.splice(0)) fn();
		await env.settle(40);
		env.fire('pagehide');
		await env.settle(40);
		return sessionsOf(env)[0];
	};

	const masked = await run(true);
	const probe = masked.records.find((r) => r.kind === 'dom').titleProbe;
	assert.equal(probe.found, true);
	assert.equal(probe.titleLength, 16);
	assert.equal(probe.matches, 1);
	assert.equal(probe.inSidebar, 1);
	assert.equal(probe.leaf.tag, 'span');
	assert.equal(probe.ancestors[0].testid, 'chat-title-bar');
	assert.equal(probe.ancestors[0].style.position, 'fixed');
	assert.equal(probe.ancestors[0].style.bgImage, 'set');
	assert.equal(probe.ancestors[0].style.dir, 'row');
	assert.equal(probe.leaf.style.pointer, 'none');
	assert.ok(!JSON.stringify(masked).includes('rozpo'), 'the title text is not stored when masking is on');

	const open = await run(false);
	assert.equal(open.records.find((r) => r.kind === 'dom').titleProbe.title, 'Rodinný rozpočet');
});

test('K18 the page snapshot lists the message box and its buttons, labels of send-like buttons in clear', async () => {
	const run = async (redactOn) => {
		const timers = [];
		const fakeSetTimeout = (fn, ms) => {
			if (ms >= 2000) {
				timers.push(fn);
				return { unref() {} };
			}
			return setTimeout(fn, ms);
		};
		const env = createContentEnv({ files: [], storage: { ccCaptureEnabled: true, ccCaptureRedact: redactOn }, extraGlobals: { setTimeout: fakeSetTimeout } });
		const rect = { left: 5, top: 600, width: 30, height: 30 };
		const el = (tag, attrs, parent) => ({
			tagName: tag,
			className: '',
			parentElement: parent || null,
			children: [],
			closest: () => null,
			getBoundingClientRect: () => rect,
			getAttribute: (k) => attrs[k] || null,
			querySelectorAll: () => []
		});
		const box = el('DIV', {}, null);
		const editor = el('DIV', { 'data-testid': 'chat-input', contenteditable: 'true' }, box);
		const send = el('BUTTON', { 'aria-label': 'Send message', 'aria-disabled': 'true', type: 'submit' }, box);
		const other = el('BUTTON', { 'aria-label': 'Projekt rodinný rozpočet' }, box);
		box.querySelectorAll = () => [send, other];
		env.document.body = {};
		env.document.querySelectorAll = () => [];
		env.document.querySelector = (sel) => (sel.includes('chat-input') ? editor : null);
		env.load(FILES);
		await env.settle();
		for (const fn of timers.splice(0)) fn();
		await env.settle(40);
		env.fire('pagehide');
		await env.settle(40);
		return sessionsOf(env)[0];
	};

	const masked = await run(true);
	const probe = masked.records.find((r) => r.kind === 'dom').composer;
	assert.equal(probe.found, true);
	assert.equal(probe.editor.testid, 'chat-input');
	assert.equal(probe.buttons.length, 2);
	assert.equal(probe.buttons[0].sendLike, true);
	assert.equal(probe.buttons[0].aria, 'Send message', 'a send-like label is a word of the interface');
	assert.equal(probe.buttons[0].disabled, true);
	assert.equal(probe.buttons[0].type, 'submit');
	assert.equal(probe.buttons[1].sendLike, false);
	assert.equal(probe.buttons[1].aria, 'x'.repeat(24));
	assert.ok(!JSON.stringify(masked).includes('rozpo'), 'other labels are masked');

	const open = await run(false);
	assert.equal(open.records.find((r) => r.kind === 'dom').composer.buttons[1].aria, 'Projekt rodinný rozpočet');
});
