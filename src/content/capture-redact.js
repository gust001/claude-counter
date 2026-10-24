(() => {
	'use strict';

	// Best-effort redaction for the optional traffic recording (see capture-client.js).
	//
	// Protobuf messages are walked field by field. Numbers stay as they are (timestamps, counters,
	// utilisation), text and binary values are overwritten with the same number of bytes ('x' for text,
	// 0 for binary). Because every replacement keeps the length, the lengths written in the message do
	// not change and the result is still a valid protobuf message with the original structure.
	//
	// This is a heuristic: protobuf does not say whether a length-delimited field is text, bytes or a
	// nested message, so the walker guesses. Recordings are meant to be reviewed before they are shared.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const MAX_DEPTH = 8;
	const MAX_FIELD_NUMBER = 100000;

	const ALLOW_EXACT = new Set([
		'5h',
		'7d',
		'five_hour',
		'seven_day',
		'overage_not_provisioned',
		'within_limit',
		'allowed',
		'en-US',
		'en',
		'cs-CZ',
		'cs'
	]);
	const ALLOW_PATTERNS = [
		/^claude-[a-z0-9][a-z0-9._-]*$/,
		/^type\.googleapis\.com\/[\w.]+$/,
		/^\d{13}-\d+$/, // stream cursors
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // ids, needed to follow references
		/^[a-z]{3,6}_[0-9a-zA-Z]{12,}$/ // prefixed ids such as content block ids
	];

	// Words that may stay in the end-of-stream trailer (why a stream was closed, and the Connect error
	// codes). Everything else in a trailer, such as an error message, is masked.
	const TRAILER_ALLOWED = new Set([
		'cadence',
		'max_age',
		'canceled',
		'unknown',
		'invalid_argument',
		'deadline_exceeded',
		'not_found',
		'already_exists',
		'permission_denied',
		'resource_exhausted',
		'failed_precondition',
		'aborted',
		'out_of_range',
		'unimplemented',
		'internal',
		'unavailable',
		'data_loss',
		'unauthenticated'
	]);

	function isAllowedText(text, extra) {
		if (ALLOW_EXACT.has(text) || (extra && extra.has(text))) return true;
		return ALLOW_PATTERNS.some((re) => re.test(text));
	}

	function readVarint(buf, pos, end) {
		let result = 0;
		let shift = 0;
		let p = pos;
		while (p < end) {
			const b = buf[p++];
			result += (b & 0x7f) * 2 ** shift;
			if (!(b & 0x80)) return { value: result, pos: p };
			shift += 7;
			if (shift > 63) return null;
		}
		return null;
	}

	/** Returns the list of fields of buf[start,end) or null when the bytes are not a valid message. */
	function parseMessage(buf, start, end) {
		const fields = [];
		let pos = start;
		while (pos < end) {
			const tag = readVarint(buf, pos, end);
			if (!tag) return null;
			pos = tag.pos;
			const number = Math.floor(tag.value / 8);
			const wireType = tag.value % 8;
			if (number < 1 || number > MAX_FIELD_NUMBER) return null;

			if (wireType === 0) {
				const v = readVarint(buf, pos, end);
				if (!v) return null;
				pos = v.pos;
				fields.push({ number, wireType });
			} else if (wireType === 1) {
				if (pos + 8 > end) return null;
				fields.push({ number, wireType, start: pos, end: pos + 8 });
				pos += 8;
			} else if (wireType === 5) {
				if (pos + 4 > end) return null;
				pos += 4;
				fields.push({ number, wireType });
			} else if (wireType === 2) {
				const len = readVarint(buf, pos, end);
				if (!len) return null;
				pos = len.pos;
				if (pos + len.value > end) return null;
				fields.push({ number, wireType, start: pos, end: pos + len.value });
				pos += len.value;
			} else {
				return null;
			}
		}
		return fields;
	}

	function printableRatio(buf, start, end) {
		const len = end - start;
		if (len === 0) return 1;
		let printable = 0;
		for (let i = start; i < end; i++) {
			const b = buf[i];
			if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x80) printable++;
		}
		return printable / len;
	}

	function decodeText(buf, start, end) {
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start, end));
		} catch {
			return null;
		}
	}

	function maskRange(buf, start, end, value) {
		buf.fill(value, start, end);
	}

	/** A fixed64 that is a believable double (0 .. 1e12), as opposed to eight bytes of text. */
	function isPlausibleDouble(buf, start) {
		const v = new DataView(buf.buffer, buf.byteOffset + start, 8).getFloat64(0, true);
		if (!Number.isFinite(v)) return false;
		const a = Math.abs(v);
		return a === 0 || (a >= 1e-9 && a <= 1e12);
	}

	/**
	 * `keep` collects the ranges that must survive the final sweep: text that is on the allow list and
	 * doubles that look like real numbers (utilisation).
	 */
	function redactRange(buf, start, end, depth, keep) {
		const len = end - start;
		if (len === 0) return;

		const ratio = printableRatio(buf, start, end);
		if (depth < MAX_DEPTH) {
			const fields = parseMessage(buf, start, end);
			// A text that happens to parse as scalar-only protobuf is still text.
			const looksLikeText = ratio >= 0.9 && fields && fields.every((f) => f.wireType !== 2);
			if (fields && fields.length > 0 && !looksLikeText) {
				for (const f of fields) {
					if (f.wireType === 2) redactRange(buf, f.start, f.end, depth + 1, keep);
					else if (f.wireType === 1 && isPlausibleDouble(buf, f.start)) keep.push([f.start, f.end]);
				}
				return;
			}
		}

		const text = ratio >= 0.9 ? decodeText(buf, start, end) : null;
		if (text !== null) {
			if (isAllowedText(text)) keep.push([start, end]);
			else maskRange(buf, start, end, 0x78);
			return;
		}
		maskRange(buf, start, end, 0x00);
	}

	const STRAY_RUN = 4;
	const isLetter = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

	/**
	 * Last sweep. When a piece of text happens to parse as protobuf, its characters end up as tags,
	 * lengths and small numbers, which the walker keeps. Any run of four or more ASCII letters that is
	 * not on the allow list is therefore masked as well.
	 */
	function sweepStrayText(buf, keep) {
		const kept = new Uint8Array(buf.length);
		for (const [a, b] of keep) kept.fill(1, a, b);
		let runStart = -1;
		for (let i = 0; i <= buf.length; i++) {
			const letter = i < buf.length && isLetter(buf[i]) && !kept[i];
			if (letter) {
				if (runStart < 0) runStart = i;
			} else if (runStart >= 0) {
				if (i - runStart >= STRAY_RUN) buf.fill(0x78, runStart, i);
				runStart = -1;
			}
		}
	}

	/** Returns a masked copy of a protobuf message. */
	function redactProtobuf(bytes) {
		const copy = new Uint8Array(bytes);
		const keep = [];
		redactRange(copy, 0, copy.length, 0, keep);
		sweepStrayText(copy, keep);
		return copy;
	}

	/** JSON text: strings are replaced by 'x' of the same length, numbers and booleans stay. */
	function redactJsonValue(value, extra) {
		if (typeof value === 'string') return isAllowedText(value, extra) ? value : 'x'.repeat(value.length);
		if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, extra));
		if (value && typeof value === 'object') {
			const out = {};
			for (const key of Object.keys(value)) out[key] = redactJsonValue(value[key], extra);
			return out;
		}
		return value;
	}

	function redactJsonText(text, extra) {
		try {
			return JSON.stringify(redactJsonValue(JSON.parse(text), extra));
		} catch {
			return 'x'.repeat(text.length);
		}
	}

	// ---- records coming from the page-side recorder (bridge.js) ----

	const MAX_GUNZIP_BYTES = 4 * 1024 * 1024;

	function base64ToBytes(b64) {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	function bytesToBase64(bytes) {
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(bin);
	}

	async function gunzip(bytes) {
		if (typeof DecompressionStream === 'undefined') return null;
		try {
			const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
			const reader = stream.getReader();
			const chunks = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > MAX_GUNZIP_BYTES) {
					reader.cancel().catch(() => {});
					return null;
				}
				chunks.push(value);
			}
			const out = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) {
				out.set(c, offset);
				offset += c.length;
			}
			return out;
		} catch {
			return null;
		}
	}

	function isJsonType(ct) {
		return typeof ct === 'string' && ct.includes('json');
	}

	function isEnvelopeType(ct) {
		return typeof ct === 'string' && ct.includes('connect') && !ct.includes('json');
	}

	/**
	 * Splits a body made of Connect frames (flags, 4 bytes length, payload), unpacks gzip frames and
	 * masks each payload. Returns null when the bytes are not a clean sequence of frames.
	 */
	async function redactEnvelope(bytes, redact) {
		const parts = [];
		let wasGzip = false;
		let pos = 0;
		let total = 0;
		while (pos < bytes.length) {
			if (pos + 5 > bytes.length) return null;
			const flags = bytes[pos];
			const length = bytes[pos + 1] * 2 ** 24 + (bytes[pos + 2] << 16) + (bytes[pos + 3] << 8) + bytes[pos + 4];
			if (flags > 3 || pos + 5 + length > bytes.length) return null;
			let payload = bytes.subarray(pos + 5, pos + 5 + length);
			pos += 5 + length;

			let outFlags = flags;
			if (flags & 2) {
				const text = new TextDecoder().decode(payload);
				payload = new TextEncoder().encode(redact ? redactJsonText(text, TRAILER_ALLOWED) : text);
			} else {
				if (flags & 1) {
					const unpacked = await gunzip(payload);
					if (!unpacked) return null;
					payload = unpacked;
					outFlags &= ~1;
					wasGzip = true;
				}
				if (redact) payload = redactProtobuf(payload);
			}

			const frame = new Uint8Array(5 + payload.length);
			frame[0] = outFlags;
			frame[1] = Math.floor(payload.length / 2 ** 24) & 0xff;
			frame[2] = (payload.length >> 16) & 0xff;
			frame[3] = (payload.length >> 8) & 0xff;
			frame[4] = payload.length & 0xff;
			frame.set(payload, 5);
			parts.push(frame);
			total += frame.length;
		}
		if (parts.length === 0) return null;
		const result = new Uint8Array(total);
		let offset = 0;
		for (const f of parts) {
			result.set(f, offset);
			offset += f.length;
		}
		return { bytes: result, wasGzip };
	}

	/**
	 * Turns a raw record from the page into what is stored: gzip frames are unpacked, and when
	 * `redact` is on, bodies are masked. The body ends up in `b64` (binary) or `text` (JSON).
	 */
	async function prepareRecord(record, redact) {
		const out = { ...record };
		const hasBody = typeof record.b64 === 'string';
		if (!hasBody) return out;

		let bytes;
		try {
			bytes = base64ToBytes(record.b64);
		} catch {
			delete out.b64;
			out.dropped = 'bad_base64';
			return out;
		}

		const isFrame = record.kind === 'frame';
		if (isFrame && record.flags & 2) {
			// End-of-stream trailer: JSON with the close reason. An error message in it is masked.
			delete out.b64;
			const text = new TextDecoder().decode(bytes);
			out.text = (redact ? redactJsonText(text, TRAILER_ALLOWED) : text).slice(0, 2000);
			return out;
		}

		if (isFrame && record.flags & 1) {
			const unpacked = await gunzip(bytes);
			if (!unpacked) {
				delete out.b64;
				out.dropped = 'gunzip_failed';
				return out;
			}
			bytes = unpacked;
			out.flags = record.flags & ~1;
			out.wasGzip = true;
			out.size = bytes.length;
		}

		if (!isFrame && isEnvelopeType(record.ct)) {
			// A request body made of Connect frames: every frame is masked on its own, so that the
			// structure of the request stays readable.
			const enveloped = await redactEnvelope(bytes, redact);
			if (enveloped) {
				out.b64 = bytesToBase64(enveloped.bytes);
				out.size = enveloped.bytes.length;
				if (enveloped.wasGzip) out.wasGzip = true;
				return out;
			}
		}

		const asJson = !isFrame && isJsonType(record.ct);
		if (asJson) {
			const text = new TextDecoder().decode(bytes);
			delete out.b64;
			out.text = redact ? redactJsonText(text) : text;
			return out;
		}

		const knownBinary = isFrame || (typeof record.ct === 'string' && /proto|connect|octet/.test(record.ct)) || record.ct === undefined;
		if (redact && !knownBinary) {
			delete out.b64;
			out.dropped = 'unknown_type_not_stored';
			return out;
		}

		out.b64 = bytesToBase64(redact ? redactProtobuf(bytes) : bytes);
		return out;
	}

	const api = {
		redactProtobuf,
		redactJsonText,
		redactJsonValue,
		redactEnvelope,
		isAllowedText,
		parseMessage,
		prepareRecord,
		base64ToBytes,
		bytesToBase64,
		gunzip
	};
	CC.captureRedact = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
