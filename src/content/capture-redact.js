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

	function isAllowedText(text) {
		if (ALLOW_EXACT.has(text)) return true;
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
				pos += 8;
				fields.push({ number, wireType });
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

	function redactRange(buf, start, end, depth) {
		const len = end - start;
		if (len === 0) return;

		const ratio = printableRatio(buf, start, end);
		if (depth < MAX_DEPTH) {
			const fields = parseMessage(buf, start, end);
			// A text that happens to parse as scalar-only protobuf is still text.
			const looksLikeText = ratio >= 0.9 && fields && fields.every((f) => f.wireType !== 2);
			if (fields && fields.length > 0 && !looksLikeText) {
				for (const f of fields) {
					if (f.wireType === 2) redactRange(buf, f.start, f.end, depth + 1);
				}
				return;
			}
		}

		const text = ratio >= 0.9 ? decodeText(buf, start, end) : null;
		if (text !== null) {
			if (!isAllowedText(text)) maskRange(buf, start, end, 0x78);
			return;
		}
		maskRange(buf, start, end, 0x00);
	}

	/** Returns a masked copy of a protobuf message. */
	function redactProtobuf(bytes) {
		const copy = new Uint8Array(bytes);
		redactRange(copy, 0, copy.length, 0);
		return copy;
	}

	/** JSON text: strings are replaced by 'x' of the same length, numbers and booleans stay. */
	function redactJsonValue(value) {
		if (typeof value === 'string') return isAllowedText(value) ? value : 'x'.repeat(value.length);
		if (Array.isArray(value)) return value.map(redactJsonValue);
		if (value && typeof value === 'object') {
			const out = {};
			for (const key of Object.keys(value)) out[key] = redactJsonValue(value[key]);
			return out;
		}
		return value;
	}

	function redactJsonText(text) {
		try {
			return JSON.stringify(redactJsonValue(JSON.parse(text)));
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
			// End-of-stream trailer: JSON with the close reason, no conversation content.
			delete out.b64;
			out.text = new TextDecoder().decode(bytes).slice(0, 2000);
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
