(() => {
	'use strict';

	// Storage side of the optional traffic recording. One recording session = one page load = one
	// storage key (`ccCap_<id>`) holding { id, startedAt, url, redacted, capped, records: [...] }.
	// Limits keep the total well under the 10 MB quota of chrome.storage.local.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const KEY_PREFIX = 'ccCap_';
	const DEFAULTS = Object.freeze({
		maxRecords: 2000,
		maxBytes: 2500000,
		maxSessions: 3,
		flushDelayMs: 1000
	});

	function newSessionId(now = Date.now()) {
		return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	function approxSize(record) {
		let size = 40;
		for (const key of Object.keys(record)) {
			const v = record[key];
			size += key.length + 4;
			if (typeof v === 'string') size += v.length;
			else if (v !== undefined && v !== null) size += JSON.stringify(v).length;
		}
		return size;
	}

	/**
	 * storage: { get(keys) -> Promise<object>, set(obj) -> Promise, remove(keys) -> Promise }
	 */
	class CaptureStore {
		constructor({ storage, redacted, url, now = () => Date.now(), options = {} }) {
			this.storage = storage;
			this.now = now;
			this.opts = { ...DEFAULTS, ...options };
			this.session = {
				id: newSessionId(now()),
				startedAt: now(),
				url: url || '',
				redacted: !!redacted,
				capped: false,
				records: []
			};
			this.key = KEY_PREFIX + this.session.id;
			this.bytes = 0;
			this._timer = null;
			this._dirty = false;
			this._writing = Promise.resolve();
			this._started = null;
		}

		/** Writes the empty session and removes the oldest ones beyond the session limit. */
		start() {
			if (!this._started) {
				this._started = (async () => {
					try {
						await this.storage.set({ [this.key]: this.session });
						const all = await this.storage.get(null);
						const sessions = Object.keys(all || {})
							.filter((k) => k.startsWith(KEY_PREFIX) && k !== this.key)
							.map((k) => ({ k, startedAt: Number(all[k]?.startedAt) || 0 }))
							.sort((a, b) => b.startedAt - a.startedAt);
						const stale = sessions.slice(Math.max(0, this.opts.maxSessions - 1)).map((s) => s.k);
						if (stale.length) await this.storage.remove(stale);
					} catch {
						// storage unavailable: recording simply does nothing
					}
				})();
			}
			return this._started;
		}

		add(record) {
			const s = this.session;
			if (s.capped) return false;
			const size = approxSize(record);
			if (s.records.length >= this.opts.maxRecords || this.bytes + size > this.opts.maxBytes) {
				s.capped = true;
				s.records.push({ t: this.now(), kind: 'capped', records: s.records.length, bytes: this.bytes });
				this._schedule();
				return false;
			}
			this.bytes += size;
			s.records.push(record);
			this._schedule();
			return true;
		}

		_schedule() {
			this._dirty = true;
			if (this._timer) return;
			this._timer = setTimeout(() => {
				this._timer = null;
				this.flush();
			}, this.opts.flushDelayMs);
			this._timer.unref?.();
		}

		/** Persists the session now. Resolves when the write is done. */
		flush() {
			if (this._timer) {
				clearTimeout(this._timer);
				this._timer = null;
			}
			if (!this._dirty) return this._writing;
			this._dirty = false;
			this._writing = this._writing
				.then(() => this.start())
				.then(() => this.storage.set({ [this.key]: this.session }))
				.catch(() => {});
			return this._writing;
		}
	}

	function isSessionKey(key) {
		return typeof key === 'string' && key.startsWith(KEY_PREFIX);
	}

	/** Reads all stored sessions, newest first. */
	async function listSessions(storage) {
		const all = (await storage.get(null)) || {};
		return Object.keys(all)
			.filter(isSessionKey)
			.map((k) => all[k])
			.filter((s) => s && Array.isArray(s.records))
			.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
	}

	async function clearSessions(storage) {
		const all = (await storage.get(null)) || {};
		const keys = Object.keys(all).filter(isSessionKey);
		if (keys.length) await storage.remove(keys);
		return keys.length;
	}

	const api = { KEY_PREFIX, DEFAULTS, CaptureStore, listSessions, clearSessions, isSessionKey, approxSize };
	CC.captureStore = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
