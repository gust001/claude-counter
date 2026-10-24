(() => {
	'use strict';

	// Auto-continue, the logic part: settings and when the message is to be sent. No DOM, no storage:
	// autocontinue.js does the rest. The feature is a one-time plan: the user switches it on, it sends
	// once (or, if asked, once more after the 5-hour window has been used up again) and switches itself off.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// The target of a plan made on the new-chat page, where there is no chat address yet.
	const NEW_CHAT = 'new';

	const SETTINGS_KEY = 'ccAuto';
	const ARMED_KEY = 'ccAutoArmed';
	const LAST_KEY = 'ccAutoLast';
	const WAIT_KEY = 'ccAutoWait'; // why nothing is planned yet (text), written by the tab in front

	const MINUTE = 60 * 1000;
	const HOUR = 60 * MINUTE;
	// A message due long ago (computer asleep, browser closed) is no longer sent: the chat may have moved on.
	const GRACE_MS = HOUR;
	const RETRY_MS = MINUTE;
	const MAX_TRIES = 3;
	// The second "continue" is sent this long after the reset of the window that was used up again:
	// a few seconds, so that it still falls within the 5-minute cache window of the previous reply.
	const AGAIN_DELAY_MS = 3000;
	// After the first message: how long to watch for the 5-hour window running out again.
	const WATCH_MS = 6 * HOUR;
	const OFFSET_LIMIT_MIN = 300;

	const DEFAULTS = Object.freeze({
		enabled: false,
		when: 'afterReset', // 'afterReset' (relative to the end of the 5-hour window) | 'atTime' (a fixed moment)
		offsetMin: 1, // minutes after the end of the 5-hour window; negative = before it
		at: '', // 'YYYY-MM-DDTHH:MM' local time, used when when = 'atTime'
		what: 'continue', // 'continue' | 'composer'
		text: 'continue',
		again: false // send "continue" once more after the next reset if the 5-hour window is used up again
	});

	function toInt(value, fallback, min, max) {
		const n = Math.round(Number(value));
		if (!Number.isFinite(n)) return fallback;
		return Math.max(min, Math.min(max, n));
	}

	function pad2(n) {
		return String(n).padStart(2, '0');
	}

	/** 'YYYY-MM-DDTHH:MM' (what a datetime-local field gives) as local time in ms, or null. */
	function parseLocalDateTime(value) {
		const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || '').trim());
		if (!m) return null;
		const [y, mo, d, h, mi] = m.slice(1).map(Number);
		const date = new Date(y, mo - 1, d, h, mi, 0, 0);
		if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null;
		return date.getTime();
	}

	/** Whatever is stored becomes a valid settings object: unknown values fall back to the defaults. */
	function normalizeSettings(raw) {
		const r = raw && typeof raw === 'object' ? raw : {};
		const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
		const at = typeof r.at === 'string' && parseLocalDateTime(r.at) !== null ? r.at.trim() : '';
		// delayMin: what the first build called the offset
		const offset = r.offsetMin !== undefined ? r.offsetMin : r.delayMin;
		return {
			enabled: r.enabled === true,
			when: r.when === 'atTime' ? 'atTime' : 'afterReset',
			offsetMin: toInt(offset, DEFAULTS.offsetMin, -OFFSET_LIMIT_MIN, OFFSET_LIMIT_MIN),
			at,
			what: r.what === 'composer' ? 'composer' : 'continue',
			text: text || DEFAULTS.text,
			again: r.again === true
		};
	}

	/** Do the settings that decide the time of the message differ? */
	function timingChanged(a, b) {
		return a.when !== b.when || a.offsetMin !== b.offsetMin || a.at !== b.at;
	}

	/** The live 5-hour window: { resetMs, utilization } or null (no data, expired, or already over). */
	function fiveHour(usage, now) {
		const w = usage && usage.five_hour;
		if (!w || w.expired || !w.resets_at) return null;
		const resetMs = Date.parse(w.resets_at);
		if (!Number.isFinite(resetMs) || resetMs <= now) return null;
		return { resetMs, utilization: typeof w.utilization === 'number' ? w.utilization : 0 };
	}

	/** The 5-hour window is used up (rounding noise tolerated). */
	function isUsedUp(window) {
		return !!window && window.utilization >= 100 - 0.01;
	}

	function formatClock(ms) {
		const d = new Date(ms);
		return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	}

	/**
	 * When the message is sent: { ok: true, fireAt } or { ok: false, reason }. Relative to the end of the
	 * 5-hour window (the offset may be negative), or at a fixed moment whatever the windows do.
	 */
	function computeFireAt(settings, usage, now) {
		if (settings.when === 'atTime') {
			const ms = parseLocalDateTime(settings.at);
			if (ms === null) return { ok: false, reason: 'choose a date and time' };
			if (ms <= now) return { ok: false, reason: 'that time has already passed' };
			return { ok: true, fireAt: ms };
		}
		const window = fiveHour(usage, now);
		if (!window) return { ok: false, reason: 'the end of the current 5-hour window is not known yet; send a message first, or choose a fixed time' };
		const fireAt = window.resetMs + settings.offsetMin * MINUTE;
		if (fireAt <= now) return { ok: false, reason: `that moment has already passed (the 5-hour window ends at ${formatClock(window.resetMs)})` };
		return { ok: true, fireAt, resetMs: window.resetMs };
	}

	const api = {
		NEW_CHAT,
		SETTINGS_KEY,
		ARMED_KEY,
		LAST_KEY,
		WAIT_KEY,
		GRACE_MS,
		RETRY_MS,
		MAX_TRIES,
		AGAIN_DELAY_MS,
		WATCH_MS,
		OFFSET_LIMIT_MIN,
		DEFAULTS,
		normalizeSettings,
		timingChanged,
		parseLocalDateTime,
		fiveHour,
		isUsedUp,
		computeFireAt,
		formatClock
	};
	CC.autoContinueCore = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
