'use strict';

// Helpers for the auto-continue tests: a storage shared by several "tabs", a fake page (message
// box and send button) and usage windows.

globalThis.ClaudeCounter = globalThis.ClaudeCounter || {};
const core = require('../../src/content/autocontinue-core.js');
const autoContinue = require('../../src/content/autocontinue.js');

/** chrome.storage.local-like store; every change is announced asynchronously to all listeners. */
function makeStore(initial = {}) {
	const data = JSON.parse(JSON.stringify(initial));
	const listeners = [];
	const announce = (diff) =>
		setImmediate(() => {
			for (const fn of listeners) fn(diff, 'local');
		});
	const area = {
		get(keys, cb) {
			const list = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
			const out = {};
			for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
			setImmediate(() => cb(out));
		},
		set(obj, cb) {
			const diff = {};
			for (const [k, v] of Object.entries(obj)) {
				const clean = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
				diff[k] = { oldValue: data[k], newValue: clean };
				data[k] = clean;
			}
			announce(diff);
			setImmediate(() => cb && cb());
		},
		remove(keys, cb) {
			const diff = {};
			for (const k of [].concat(keys)) {
				if (k in data) {
					diff[k] = { oldValue: data[k], newValue: undefined };
					delete data[k];
				}
			}
			if (Object.keys(diff).length) announce(diff);
			setImmediate(() => cb && cb());
		}
	};
	return { data, area, onChanged: { addListener: (fn) => listeners.push(fn) } };
}

/** What the controller needs of the page. Tests flip the switches. */
function makePage({ box = '', sendEnabled = true, hasComposer = true, accepts = true } = {}) {
	const page = {
		box,
		sendEnabled,
		hasComposer,
		accepts, // false: the page ignores the send (the box keeps its text)
		sent: [],
		inserted: [],
		cleared: 0,
		findComposer: () => (page.hasComposer ? { id: 'composer' } : null),
		readText: () => page.box,
		setText: (_el, text) => {
			page.box = text;
			page.inserted.push(text);
			return true;
		},
		clear: () => {
			page.box = '';
			page.cleared += 1;
		},
		send: () => {
			if (!page.sendEnabled) return { sent: false, reason: 'the send button is disabled' };
			if (page.accepts) {
				page.sent.push(page.box);
				page.box = '';
				if (page.onSend) page.onSend();
			}
			return { sent: true, via: 'button' };
		}
	};
	return page;
}

/** Usage windows as main.js keeps them (resets_at is an ISO string, utilization 0..100). */
function usage({ fiveH, sevenD } = {}) {
	const win = (spec, hours) => (spec ? { utilization: spec[0], resets_at: new Date(spec[1]).toISOString(), window_hours: hours } : null);
	return { five_hour: win(fiveH, 5), seven_day: win(sevenD, 168) };
}

const MIN = 60 * 1000;
const CHAT = 'd017d8c7-6458-4449-884f-64980589c699';
const OTHER_CHAT = 'e1111111-2222-4333-8444-555555555555';

/**
 * One tab: a controller on a store, with a settable clock and chat. Returns helpers.
 * options: { store, settings, now, chat, page, statuses }
 */
async function makeTab({ store = makeStore(), settings, now = { t: Date.UTC(2026, 9, 18, 12, 0, 0) }, chat = CHAT, page = makePage(), visible = true } = {}) {
	if (settings) store.data[core.SETTINGS_KEY] = JSON.parse(JSON.stringify(settings));
	const statuses = [];
	const logs = [];
	const front = { visible };
	const controller = autoContinue.create({
		storageArea: store.area,
		onChanged: store.onChanged,
		now: () => now.t,
		sleep: () => new Promise((resolve) => setImmediate(resolve)),
		dom: page,
		getChatId: () => chat,
		isVisible: () => front.visible,
		onStatus: (s) => statuses.push(s),
		log: (m) => logs.push(m)
	});
	await controller.ready();
	controller.setChat(chat);
	const settle = async (n = 6) => {
		for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	/** Moves the clock and lets a possible send run to the end. */
	const advance = async (ms) => {
		now.t += ms;
		controller.tick();
		await settle(40);
	};
	return { store, controller, page, now, statuses, logs, settle, advance, front, setChat: (id) => controller.setChat(id) };
}

const ON = { enabled: true };

module.exports = { core, autoContinue, makeStore, makePage, makeTab, usage, MIN, CHAT, OTHER_CHAT, ON };
