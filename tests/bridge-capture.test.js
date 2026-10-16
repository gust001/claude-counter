'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const fixtures = require('./fixtures/frames.json');
const proto = require('./helpers/proto');
const { createBridgeEnv, streamResponse, readAll, settle, STREAM_URL, PERFORM_URL } = require('./helpers/bridge-harness');

const frame = (name) => proto.fromHex(fixtures.frames[name].hex);

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

function records(env) {
	return env.events('cc:capture_record');
}

test('C01 nothing is recorded while the setting is off', async () => {
	const env = createBridgeEnv({ originalFetch: async () => streamResponse([frame('limits_5h_first')]) });
	await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) }));
	await env.fetch('https://claude.ai/api/organizations/o/usage');
	await settle();
	assert.equal(records(env).length, 0);
	assert.equal(env.events('cc:message_limit').length, 1, 'normal operation is unaffected');
});

test('C02 a stream is recorded frame by frame, the page still gets every byte', async () => {
	const chunks = [frame('limits_5h_first'), frame('keepalive'), frame('end_cadence')];
	const env = createBridgeEnv({ originalFetch: async () => streamResponse(chunks) });
	env.setCapture(true);

	const returned = await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([9, 8, 7]), headers: { 'content-type': 'application/connect+proto' } });
	const bytes = await readAll(returned);
	await settle(50);

	assert.deepEqual(bytes, Buffer.concat(chunks), 'response untouched');

	const recs = records(env);
	const kinds = recs.map((r) => r.kind);
	assert.deepEqual(kinds, ['req', 'res', 'frame', 'frame', 'frame', 'stream_end']);
	assert.ok(recs.every((r) => r.id === recs[0].id));
	assert.equal(recs[0].url, '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline');
	assert.equal(recs[0].ct, 'application/connect+proto');
	assert.equal(Buffer.from(recs[0].b64, 'base64').toString('hex'), '090807');
	assert.equal(recs[1].status, 200);
	assert.deepEqual(recs.slice(2, 5).map((r) => r.flags), [0, 0, 2]);
	assert.equal(Buffer.from(recs[2].b64, 'base64').toString('hex'), Buffer.from(frame('limits_5h_first').subarray(5)).toString('hex'));
	assert.equal(recs[5].reason, 'done');
});

test('C03 frames split across chunks are recorded once, complete', async () => {
	const whole = Buffer.concat([frame('limits_5h_first'), frame('text_delta_emoji')]);
	const chunks = [whole.subarray(0, 7), whole.subarray(7, 100), whole.subarray(100)];
	const env = createBridgeEnv({ originalFetch: async () => streamResponse(chunks) });
	env.setCapture(true);
	await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) }));
	await settle(50);
	const frames = records(env).filter((r) => r.kind === 'frame');
	assert.equal(frames.length, 2);
	assert.equal(frames[0].size, frame('limits_5h_first').length - 5);
});

test('C04 gzip frames are recorded as they are (unpacking happens later)', async () => {
	const gz = zlib.gzipSync(Buffer.from(proto.snapshotPayload('1791743563668-0', 'T', 1)));
	const env = createBridgeEnv({ originalFetch: async () => streamResponse([proto.connectFrame(1, gz)]) });
	env.setCapture(true);
	await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) }));
	await settle(50);
	const [f] = records(env).filter((r) => r.kind === 'frame');
	assert.equal(f.flags, 1);
	assert.deepEqual(Buffer.from(f.b64, 'base64'), gz);
});

test('C05 unary RPC calls: request body and response body are recorded', async () => {
	const env = createBridgeEnv({
		originalFetch: async () => new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/proto' } })
	});
	env.setCapture(true);
	const returned = await env.fetch(PERFORM_URL, { method: 'POST', body: new Uint8Array([5, 6]), headers: new Headers({ 'Content-Type': 'application/proto' }) });
	assert.deepEqual(await readAll(returned), Buffer.from([1, 2, 3, 4]));
	await settle(50);

	const recs = records(env);
	const req = recs.find((r) => r.kind === 'req');
	const body = recs.find((r) => r.kind === 'body');
	assert.equal(req.method, 'POST');
	assert.equal(req.ct, 'application/proto');
	assert.equal(Buffer.from(req.b64, 'base64').toString('hex'), '0506');
	assert.equal(Buffer.from(body.b64, 'base64').toString('hex'), '01020304');
	assert.equal(env.events('cc:generation_start').length, 0);
});

test('C06 request bodies given as string, ArrayBuffer, view, Blob or Request are all read', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response(null, { status: 204 }) });
	env.setCapture(true);
	const bodies = [
		'abc',
		new Uint8Array([97, 98, 99]).buffer,
		new DataView(new Uint8Array([0, 97, 98, 99, 0]).buffer, 1, 3),
		new Blob(['abc'])
	];
	for (const body of bodies) await env.fetch(PERFORM_URL, { method: 'POST', body });
	await env.fetch(new Request(PERFORM_URL, { method: 'POST', body: 'abc' }));
	await settle(50);
	const reqs = records(env).filter((r) => r.kind === 'req');
	assert.equal(reqs.length, 5);
	for (const r of reqs) assert.equal(Buffer.from(r.b64, 'base64').toString(), 'abc');
});

test('C07 REST calls: only method, path, status and the names of query parameters', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('{"secret":"value"}', { status: 200, headers: { 'content-type': 'application/json' } }) });
	env.setCapture(true);
	await env.fetch('https://claude.ai/api/organizations/org-1/chat_conversations/c-1?tree=true&rendering_mode=messages&q=moje%20tajne%20hledani');
	await settle(50);
	const recs = records(env);
	assert.deepEqual(recs.map((r) => r.kind), ['req', 'res']);
	assert.equal(recs[0].url, '/api/organizations/org-1/chat_conversations/c-1?tree&rendering_mode&q');
	assert.equal(recs[0].b64, undefined);
	assert.ok(!JSON.stringify(recs).includes('tajne'));
	assert.ok(!JSON.stringify(recs).includes('secret'));
});

test('C08 other URLs (assets, third parties) are not recorded', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('x') });
	env.setCapture(true);
	await env.fetch('https://claude.ai/static/app.js');
	await env.fetch('https://example.com/api/thing');
	await settle(20);
	assert.equal(records(env).filter((r) => r.kind === 'req' && r.url.includes('static')).length, 0);
	assert.equal(records(env).filter((r) => r.kind === 'req').length, 0, 'foreign hosts are never recorded');
});

test('C09 very large bodies are noted by size only', async () => {
	const big = new Uint8Array(600 * 1024).fill(7);
	const env = createBridgeEnv({ originalFetch: async () => new Response(big, { status: 200, headers: { 'content-type': 'application/proto' } }) });
	env.setCapture(true);
	await readAll(await env.fetch(PERFORM_URL, { method: 'POST', body: big }));
	await settle(100);
	const req = records(env).find((r) => r.kind === 'req');
	const body = records(env).find((r) => r.kind === 'body');
	for (const r of [req, body]) {
		assert.equal(r.size, big.length);
		assert.equal(r.truncated, true);
		assert.equal(r.b64, undefined);
	}
});

test('C10 a stream that fails is closed with reason "error" and the page is not affected', async () => {
	let n = 0;
	const body = new ReadableStream({
		pull(controller) {
			if (n++ === 0) controller.enqueue(new Uint8Array(frame('keepalive')));
			else controller.error(new Error('network'));
		}
	});
	const env = createBridgeEnv({ originalFetch: async () => new Response(body, { headers: { 'content-type': 'application/connect+proto' } }) });
	env.setCapture(true);
	const returned = await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) });
	await readAll(returned).catch(() => {});
	await settle(50);
	const end = records(env).find((r) => r.kind === 'stream_end');
	assert.ok(end);
	assert.equal(end.reason, 'error');
});

test('C11 switching the flag off stops recording at once, switching on resumes', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('{}', { status: 200 }) });
	env.setCapture(true);
	await env.fetch('https://claude.ai/api/organizations/o/usage');
	env.setCapture(false);
	await env.fetch('https://claude.ai/api/organizations/o/usage');
	await settle(20);
	assert.equal(records(env).filter((r) => r.kind === 'req').length, 1);
	env.setCapture(true);
	await env.fetch('https://claude.ai/api/organizations/o/usage');
	await settle(20);
	assert.equal(records(env).filter((r) => r.kind === 'req').length, 2);
});

test('C12 a missing document or broken fetch never breaks the page', async () => {
	const env = createBridgeEnv({ originalFetch: async () => { throw new TypeError('Failed to fetch'); } });
	env.setCapture(true);
	await assert.rejects(env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) }), /Failed to fetch/);
});

test('C13 a stream opened while recording was on stops reporting when it is switched off', async () => {
	const chunks = [frame('text_delta_emoji'), frame('limits_5h_first'), frame('end_cadence')];
	const env = createBridgeEnv({ originalFetch: async () => streamResponse(chunks, { delayMs: 15 }) });
	env.setCapture(true);
	const reading = readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([1]) }));
	await settle(5);
	env.setCapture(false);
	await reading;
	await settle(80);
	const frames = records(env).filter((r) => r.kind === 'frame');
	assert.ok(frames.length < 3, `frames after switch off: ${frames.length}`);
	// the limits themselves are still delivered to the counter
	assert.equal(env.events('cc:message_limit').length, 1);
});

test('C14 organisation and conversation ids in the recorded path are replaced', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
	env.setCapture(true);
	await env.fetch('https://claude.ai/api/organizations/11111111-2222-4333-8444-555555555555/chat_conversations/d017d8c7-6458-4449-884f-64980589c699?tree=true');
	await settle(50);
	const [req] = records(env);
	assert.equal(req.url, '/api/organizations/:id/chat_conversations/:id?tree');
	assert.ok(!JSON.stringify(records(env)).includes('d017d8c7'));
});
