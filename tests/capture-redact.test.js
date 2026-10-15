'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const fixtures = require('./fixtures/frames.json');
const proto = require('./helpers/proto');
const { createBridgeEnv, streamResponse, readAll, settle, STREAM_URL } = require('./helpers/bridge-harness');
const redact = require('../src/content/capture-redact.js');

const frame = (name) => proto.fromHex(fixtures.frames[name].hex);
const payloadOf = (frameBytes) => new Uint8Array(frameBytes.subarray(5));
const asText = (bytes) => Buffer.from(bytes).toString('latin1');

test('R01 text is masked with the same length, structure and numbers stay', () => {
	const secret = 'Tajný rodinný recept na bábovku, číslo 12345';
	const bytes = payloadOf(proto.textDeltaFrame('1791743563668-0', '00000000-0000-4000-8000-000000000042', secret));
	const out = redact.redactProtobuf(bytes);

	assert.equal(out.length, bytes.length);
	assert.ok(!Buffer.from(out).includes(Buffer.from('Tajný')), 'secret text is gone');
	assert.ok(!Buffer.from(out).includes(Buffer.from('recept')));
	// still a valid protobuf message with the same field layout
	const before = redact.parseMessage(bytes, 0, bytes.length);
	const after = redact.parseMessage(out, 0, out.length);
	assert.deepEqual(after, before);
	// ids and cursors needed to follow the stream survive
	assert.ok(Buffer.from(out).includes(Buffer.from('1791743563668-0')));
	assert.ok(Buffer.from(out).includes(Buffer.from('00000000-0000-4000-8000-000000000042')));
});

test('R02 the real limits frames survive masking: the bridge still reads the same limits', async () => {
	for (const name of ['limits_7d_first', 'limits_5h_first', 'limits_5h_first_turn2']) {
		const original = frame(name);
		const masked = proto.connectFrame(0, redact.redactProtobuf(payloadOf(original)));

		const run = async (bytes) => {
			const env = createBridgeEnv({ originalFetch: async () => streamResponse([bytes]) });
			await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([0]) }));
			await settle();
			return env.events('cc:message_limit');
		};

		const expected = await run(original);
		const got = await run(masked);
		assert.equal(expected.length, 1, name);
		assert.deepEqual(got, expected, name);
	}
});

test('R03 a real text-delta frame (emoji) is masked and keeps its length', () => {
	const original = payloadOf(frame('text_delta_emoji'));
	const out = redact.redactProtobuf(original);
	assert.equal(out.length, original.length);
	assert.ok(redact.parseMessage(out, 0, out.length), 'still parses');
	assert.ok(Buffer.from(out).includes(Buffer.from('cblk_000000000000000000000000')), 'block ids stay');
});

test('R04 never throws and never changes the length, whatever the bytes are', () => {
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = 0; i < 2000; i++) {
		const len = Math.floor(rnd() * 200);
		const bytes = new Uint8Array(len).map(() => Math.floor(rnd() * 256));
		const out = redact.redactProtobuf(bytes);
		assert.equal(out.length, bytes.length);
	}
	assert.equal(redact.redactProtobuf(new Uint8Array(0)).length, 0);
});

test('R05 binary values are zeroed, plain numbers are kept', () => {
	const bytes = proto.encodeFields([
		[1, 'v', 1791743562],
		[2, 'b', [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]],
		[3, 'd', 0.76]
	]);
	const out = redact.redactProtobuf(new Uint8Array(bytes));
	const fields = redact.parseMessage(out, 0, out.length);
	assert.equal(fields.length, 3);
	const bin = out.subarray(fields[1].start, fields[1].end);
	assert.ok(Array.from(bin).every((b) => b === 0));
	// number and double are byte-identical
	assert.deepEqual(Array.from(out.subarray(0, fields[1].start - 2)), Array.from(bytes.subarray(0, fields[1].start - 2)));
	assert.deepEqual(Array.from(out.subarray(fields[1].end)), Array.from(bytes.subarray(fields[1].end)));
});

test('R06 nested messages are walked, deep text inside is masked', () => {
	const bytes = proto.encodeFields([[1, 'm', [[2, 'm', [[3, 'm', [[1, 's', 'důvěrné jméno Novák']]]]]]]]);
	const out = redact.redactProtobuf(new Uint8Array(bytes));
	assert.ok(!Buffer.from(out).includes(Buffer.from('Novák')));
	assert.ok(!Buffer.from(out).includes(Buffer.from('jméno')));
	assert.deepEqual(redact.parseMessage(out, 0, out.length), redact.parseMessage(new Uint8Array(bytes), 0, bytes.length));
});

test('R07 JSON: strings masked, numbers kept, allowed words kept', () => {
	const out = JSON.parse(redact.redactJsonText(JSON.stringify({ name: 'Moje chaty', n: 5, ok: true, reason: 'five_hour', model: 'claude-haiku-5-5', arr: ['abc', 1] })));
	assert.equal(out.name, 'x'.repeat('Moje chaty'.length));
	assert.equal(out.n, 5);
	assert.equal(out.ok, true);
	assert.equal(out.reason, 'five_hour');
	assert.equal(out.model, 'claude-haiku-5-5');
	assert.deepEqual(out.arr, ['xxx', 1]);
	assert.equal(redact.redactJsonText('not json at all'), 'x'.repeat('not json at all'.length));
});

test('R08 prepareRecord: gzip frames are unpacked and masked, flags updated', async () => {
	const inner = payloadOf(proto.textDeltaFrame('1791743563668-0', 'b1', 'soukromá zpráva'));
	const rec = { kind: 'frame', id: 1, flags: 1, size: 10, b64: Buffer.from(zlib.gzipSync(inner)).toString('base64') };
	const out = await redact.prepareRecord(rec, true);
	assert.equal(out.flags, 0);
	assert.equal(out.wasGzip, true);
	const bytes = Buffer.from(out.b64, 'base64');
	assert.equal(bytes.length, inner.length);
	assert.ok(!bytes.includes(Buffer.from('soukromá')));
	assert.ok(bytes.includes(Buffer.from('1791743563668-0')));
});

test('R09 prepareRecord: unmasked mode keeps the bytes, end frame keeps its trailer text', async () => {
	const inner = payloadOf(proto.textDeltaFrame('1791743563668-0', 'b1', 'hello'));
	const plain = await redact.prepareRecord({ kind: 'frame', id: 1, flags: 0, b64: Buffer.from(inner).toString('base64') }, false);
	assert.ok(Buffer.from(plain.b64, 'base64').includes(Buffer.from('hello')));

	const trailer = JSON.stringify({ metadata: { 'stream-close-reason': 'cadence' } });
	const end = await redact.prepareRecord({ kind: 'frame', id: 1, flags: 2, b64: Buffer.from(trailer).toString('base64') }, true);
	assert.equal(end.text, trailer);
	assert.equal(end.b64, undefined);
});

test('R10 prepareRecord: corrupt gzip and unknown content are dropped, not stored', async () => {
	const bad = await redact.prepareRecord({ kind: 'frame', id: 1, flags: 1, b64: Buffer.from('not gzip').toString('base64') }, true);
	assert.equal(bad.b64, undefined);
	assert.equal(bad.dropped, 'gunzip_failed');

	const unknown = await redact.prepareRecord({ kind: 'body', id: 2, ct: 'text/html', b64: Buffer.from('<html>secret</html>').toString('base64') }, true);
	assert.equal(unknown.b64, undefined);
	assert.equal(unknown.dropped, 'unknown_type_not_stored');

	const badB64 = await redact.prepareRecord({ kind: 'body', id: 3, ct: 'application/proto', b64: '***' }, true);
	assert.equal(badB64.dropped, 'bad_base64');
});

test('R11 prepareRecord: JSON bodies are masked as text', async () => {
	const rec = { kind: 'body', id: 1, ct: 'application/json', b64: Buffer.from(JSON.stringify({ title: 'Tajné', count: 3 })).toString('base64') };
	const out = await redact.prepareRecord(rec, true);
	assert.deepEqual(JSON.parse(out.text), { title: 'xxxxx', count: 3 });
});

test('R12 records without a body pass through untouched', async () => {
	const rec = { kind: 'res', id: 1, status: 200, ct: 'application/connect+proto' };
	assert.deepEqual(await redact.prepareRecord(rec, true), rec);
});
