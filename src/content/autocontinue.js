(() => {
	'use strict';

	// Auto-continue: a one-time plan. The user switches it on in the settings (off by default); it is
	// then planned for the chat in front of them, for a moment relative to the end of the 5-hour window
	// or a fixed one, and sent once. Optionally one more "continue" follows if the 5-hour window is used
	// up again. After that it switches itself off (see autocontinue-core.js).

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const core = CC.autoContinueCore;
	if (!core) return;

	const CLAIM_WAIT_MS = 400;
	const CONFIRM_WAIT_MS = 2500;
	const SETTLE_MS = 250;
	// Whether a message was accepted is judged by the message box having been emptied.
	const SEND_LABEL = /(send|odeslat|ode[sš]li|poslat|po[sš]li|envoyer|senden|enviar|invia)/i;
	const NOT_SEND_LABEL = /(stop|attach|upload|p[rř]ilo[zž]|cancel|zru[sš])/i;

	// ---------------------------------------------------------------- the page: message box and send button

	const dom = {
		isVisible(el) {
			try {
				return !!el && el.isConnected !== false && (el.getClientRects ? el.getClientRects().length > 0 : true);
			} catch {
				return false;
			}
		},

		findComposer() {
			const candidates = document.querySelectorAll('[data-testid="chat-input"], div[contenteditable="true"], textarea');
			for (const el of candidates) {
				if (el.closest && el.closest('.cc-header, .cc-usageRow, .cc-tooltip')) continue;
				if (dom.isVisible(el)) return el;
			}
			return null;
		},

		readText(el) {
			if (!el) return '';
			const raw = typeof el.value === 'string' && el.tagName === 'TEXTAREA' ? el.value : el.textContent || '';
			return String(raw).replace(/​/g, '').trim();
		},

		setText(el, text) {
			try {
				el.focus();
				if (el.tagName === 'TEXTAREA') {
					const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'value')?.set;
					if (setter) setter.call(el, text);
					else el.value = text;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					return dom.readText(el) === text;
				}
				const sel = window.getSelection ? window.getSelection() : null;
				if (sel && document.createRange) {
					const range = document.createRange();
					range.selectNodeContents(el);
					range.collapse(false);
					sel.removeAllRanges();
					sel.addRange(range);
				}
				if (document.execCommand) document.execCommand('insertText', false, text);
				if (dom.readText(el) !== text && typeof InputEvent === 'function') {
					el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
					el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
				}
				return dom.readText(el) === text;
			} catch {
				return false;
			}
		},

		clear(el) {
			try {
				el.focus();
				if (el.tagName === 'TEXTAREA') {
					el.value = '';
					el.dispatchEvent(new Event('input', { bubbles: true }));
					return;
				}
				if (document.execCommand) {
					document.execCommand('selectAll', false);
					document.execCommand('delete', false);
				}
			} catch {
				// ignore
			}
		},

		/** The send button next to the message box: the nearest button whose label says "send". */
		findSendButton(editor) {
			let scope = editor;
			for (let i = 0; i < 8 && scope; i++, scope = scope.parentElement) {
				const buttons = scope.querySelectorAll ? scope.querySelectorAll('button, [role="button"]') : [];
				for (const btn of buttons) {
					// never our own indicator, whose label talks about sending too
					if (btn.closest && btn.closest('.cc-header, .cc-usageRow, .cc-tooltip')) continue;
					const label = [btn.getAttribute('aria-label'), btn.getAttribute('data-testid'), btn.getAttribute('title')].filter(Boolean).join(' ');
					if (label && SEND_LABEL.test(label) && !NOT_SEND_LABEL.test(label)) return btn;
				}
			}
			return null;
		},

		/** Presses the send button, or Enter in the message box when no button is found. */
		send(editor) {
			const button = dom.findSendButton(editor);
			if (button) {
				const disabled = button.disabled === true || button.getAttribute('aria-disabled') === 'true';
				if (disabled) return { sent: false, reason: 'the send button is disabled' };
				button.click();
				return { sent: true, via: 'button' };
			}
			try {
				editor.focus();
				const Key = globalThis.KeyboardEvent || Event;
				for (const type of ['keydown', 'keypress', 'keyup']) {
					editor.dispatchEvent(new Key(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
				}
				return { sent: true, via: 'enter' };
			} catch {
				return { sent: false, reason: 'no send button and Enter did not work' };
			}
		}
	};

	// ---------------------------------------------------------------- the controller

	function readLast(raw) {
		const r = raw && typeof raw === 'object' ? raw : {};
		return { last: r.last && typeof r.last === 'object' ? r.last : null };
	}

	/** A stored plan of this version: kind 'send' | 'again' (a message is due at fireAt) | 'watch' (waiting to see if the window runs out again). */
	function readArmed(raw) {
		if (!raw || typeof raw !== 'object' || raw.v !== 2) return null;
		return raw.kind === 'send' || raw.kind === 'again' || raw.kind === 'watch' ? raw : null;
	}

	function create(deps = {}) {
		const area = deps.storageArea !== undefined ? deps.storageArea : globalThis.chrome?.storage?.local;
		const changes = deps.onChanged !== undefined ? deps.onChanged : globalThis.chrome?.storage?.onChanged;
		const now = deps.now || (() => Date.now());
		const getChatId = deps.getChatId || (() => null);
		const onStatus = deps.onStatus || (() => {});
		const log = deps.log || (() => {});
		const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		const page = deps.dom || dom;
		// Only the tab in front plans a message: the chat it shows is the chat that is meant.
		const isVisible = deps.isVisible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
		const tabId = Math.random().toString(36).slice(2, 10);

		let settings = core.normalizeSettings(null);
		let armed = null;
		let last = readLast(null);
		let lastNote = null;
		let busy = false;
		let arming = false;
		let ready = false;
		let chatId = null;
		let waitReason = null;
		let cooldownUntil = 0;

		const storageGet = (keys) =>
			new Promise((resolve) => {
				try {
					area.get(keys, (r) => resolve(r || {}));
				} catch {
					resolve({});
				}
			});
		const storageSet = (obj) =>
			new Promise((resolve) => {
				try {
					area.set(obj, () => resolve());
				} catch {
					resolve();
				}
			});
		const storageRemove = (keys) =>
			new Promise((resolve) => {
				try {
					area.remove(keys, () => resolve());
				} catch {
					resolve();
				}
			});

		const persistArmed = () => (armed ? storageSet({ [core.ARMED_KEY]: armed }) : storageRemove(core.ARMED_KEY));
		const persistLast = () => storageSet({ [core.LAST_KEY]: last });

		function publish() {
			try {
				const shown = settings.enabled && armed && armed.kind !== 'watch' && armed.chatId === chatId;
				const what = armed && armed.kind === 'again' ? 'continue' : armed && armed.chatId === core.NEW_CHAT ? 'composer' : settings.what;
				onStatus(shown ? { fireAt: armed.fireAt, what, again: armed.kind === 'again' } : null);
			} catch {
				// the page must never be harmed by a failing indicator
			}
		}

		/** Why nothing is planned yet, for the settings (written only by the tab in front). */
		function setWait(reason) {
			const next = reason || null;
			if (next === waitReason) return;
			waitReason = next;
			if (next) storageSet({ [core.WAIT_KEY]: next });
			else storageRemove(core.WAIT_KEY);
		}

		function clearWait() {
			waitReason = null;
			return storageRemove(core.WAIT_KEY);
		}

		function remember(result, reason) {
			last.last = { at: now(), result, reason: reason || null };
			log(`auto-continue ${result}${reason ? `: ${reason}` : ''}`);
			return persistLast();
		}

		/** Done with the plan: the feature switches itself off (the settings stay as they were). */
		async function switchOff() {
			armed = null;
			await persistArmed();
			await clearWait();
			settings = { ...settings, enabled: false };
			await storageSet({ [core.SETTINGS_KEY]: settings });
			publish();
		}

		/** The plan ends, with a result for the settings page (null: nothing to report). */
		async function end(result, reason) {
			if (result) await remember(result, reason);
			await switchOff();
		}

		/**
		 * Plans the message for the chat in front of the user, once the settings can be turned into a moment.
		 * Where that cannot be done yet, the settings page is told why.
		 */
		async function tryArm() {
			if (!ready || !settings.enabled || armed || busy || arming) return;
			if (!chatId || !isVisible()) return;
			const t = now();
			if (t < cooldownUntil) return;
			const plan = core.computeFireAt(settings, lastNote && lastNote.usage, t);
			if (!plan.ok) {
				setWait(plan.reason);
				return;
			}
			arming = true;
			try {
				// another tab may have been first
				const stored = readArmed((await storageGet(core.ARMED_KEY))[core.ARMED_KEY]);
				if (!settings.enabled) return;
				if (stored) {
					armed = stored;
				} else {
					// a new chat has nothing to continue: what is in the message box is what gets sent
					if (chatId === core.NEW_CHAT && settings.what !== 'composer') {
						settings = { ...settings, what: 'composer' };
						await storageSet({ [core.SETTINGS_KEY]: settings });
					}
					armed = { v: 2, kind: 'send', chatId, fireAt: plan.fireAt, armedAt: t, tries: 0 };
					log(`auto-continue planned for ${new Date(plan.fireAt).toISOString()}`);
					await persistArmed();
				}
				await clearWait();
				publish();
			} finally {
				arming = false;
			}
		}

		/** After the first message: has the 5-hour window run out again? Then one more "continue" after its reset. */
		function watchUsage(usage, source) {
			if (source === 'cache' || busy) return;
			if (!settings.again) {
				end(null).catch(() => {});
				return;
			}
			const window = core.fiveHour(usage, now());
			if (!core.isUsedUp(window)) return;
			armed = { v: 2, kind: 'again', chatId: armed.chatId, fireAt: window.resetMs + core.AGAIN_DELAY_MS, armedAt: now(), tries: 0 };
			log(`auto-continue: the limit was reached again, second message planned for ${new Date(armed.fireAt).toISOString()}`);
			persistArmed().catch(() => {});
			publish();
		}

		/** Called with the usage windows every time they change. source: 'sse' (a reply), 'usage', 'cache'. */
		function noteUsage(usage, source) {
			lastNote = { usage, source };
			if (!ready || !settings.enabled) return;
			if (armed) {
				if (armed.kind === 'watch') watchUsage(usage, source);
				return;
			}
			tryArm().catch(() => {});
		}

		function setChat(id) {
			chatId = id || null;
			// the message sent from the new-chat page has created a chat: a second "continue" goes there
			if (armed && armed.kind === 'watch' && armed.chatId === core.NEW_CHAT && armed.sentBy === tabId && chatId && chatId !== core.NEW_CHAT) {
				armed = { ...armed, chatId };
				persistArmed().catch(() => {});
			}
			publish();
			tryArm().catch(() => {});
		}

		/** The user cancels the plan (the indicator): it ends and the feature switches off. */
		async function cancel() {
			if (!armed) return;
			await end('cancelled', 'cancelled by the user');
		}

		async function fire() {
			busy = true;
			try {
				const t = now();
				// Only one tab sends: claim the plan, wait a moment, and see whether the claim is still ours.
				armed = { ...armed, claim: { tab: tabId, at: t } };
				await persistArmed();
				await sleep(CLAIM_WAIT_MS);
				const stored = readArmed((await storageGet(core.ARMED_KEY))[core.ARMED_KEY]);
				if (!stored || !stored.claim || stored.claim.tab !== tabId) {
					armed = stored;
					cooldownUntil = now() + 5000;
					publish();
					return;
				}

				const second = armed.kind === 'again';
				const useBox = !second && (settings.what === 'composer' || armed.chatId === core.NEW_CHAT);
				// the second message has no box content to send: it is the text, or "continue" when the box was meant
				const message = second && settings.what === 'composer' ? core.DEFAULTS.text : settings.text;

				const editor = page.findComposer();
				if (!editor) return retry('no message box on the page');

				const text = page.readText(editor);
				let inserted = false;
				if (useBox) {
					if (!text) return end('skipped', 'the message box is empty');
				} else {
					if (text) return end('skipped', 'the message box holds a draft');
					if (!page.setText(editor, message)) return retry('the text could not be entered');
					inserted = true;
				}

				// The page enables its send button a moment after the text was entered.
				await sleep(SETTLE_MS);
				let res = page.send(editor);
				if (!res.sent && /disabled/.test(res.reason || '')) {
					await sleep(SETTLE_MS * 3);
					res = page.send(editor);
				}
				if (!res.sent) {
					if (inserted) page.clear(editor);
					return retry(res.reason);
				}
				await sleep(CONFIRM_WAIT_MS);
				const again = page.findComposer();
				const after = again ? page.readText(again) : '';
				if (after && after === (inserted ? message : text)) {
					if (inserted) page.clear(again);
					return retry('the message was not accepted');
				}

				// from the new-chat page the page has moved on to the chat that was created, if it has told us yet
				const chat = armed.chatId === core.NEW_CHAT && chatId && chatId !== core.NEW_CHAT ? chatId : armed.chatId;
				await remember('sent', second ? `${res.via}, second continue` : res.via);
				if (!second && settings.again) {
					// watch whether the 5-hour window runs out again
					armed = { v: 2, kind: 'watch', chatId: chat, sentBy: tabId, until: now() + core.WATCH_MS };
					await persistArmed();
					publish();
				} else {
					await switchOff();
				}
			} catch (error) {
				await end('failed', String((error && error.message) || error).slice(0, 80)).catch(() => {});
			} finally {
				busy = false;
			}
		}

		async function retry(reason) {
			if (armed.tries + 1 >= core.MAX_TRIES) {
				await end('failed', reason);
				return;
			}
			const { claim, ...rest } = armed;
			armed = { ...rest, tries: armed.tries + 1, fireAt: now() + core.RETRY_MS };
			log(`auto-continue retry: ${reason}`);
			await persistArmed();
			publish();
		}

		/** Called once a second. */
		function tick() {
			if (!ready || !settings.enabled || busy) return;
			const t = now();
			if (!armed) {
				tryArm().catch(() => {});
				return;
			}
			if (armed.kind === 'watch') {
				if (t > armed.until) end(null).catch(() => {});
				return;
			}
			if (t < armed.fireAt) return;
			if (armed.claim && armed.claim.tab !== tabId && t - armed.claim.at < 60 * 1000) return;
			if (t > armed.fireAt + core.GRACE_MS) {
				end('skipped', 'it was due long ago').catch(() => {});
				return;
			}
			// Only the tab that has the chat open sends; never pull the user away from what they are doing.
			if (armed.chatId !== chatId) return;
			fire();
		}

		function onSettings(next) {
			const before = settings;
			settings = core.normalizeSettings(next);
			if (!settings.enabled) {
				if (armed) {
					armed = null;
					persistArmed().catch(() => {});
				}
				clearWait().catch(() => {});
				publish();
				return;
			}
			if (armed && armed.kind === 'send' && core.timingChanged(before, settings)) {
				// the time was changed after the plan was made: work it out again for the same chat
				const plan = core.computeFireAt(settings, lastNote && lastNote.usage, now());
				if (plan.ok) {
					const { claim, ...rest } = armed;
					armed = { ...rest, fireAt: plan.fireAt, tries: 0 };
				} else {
					armed = null;
				}
				persistArmed().catch(() => {});
			}
			publish();
			if (!armed) tryArm().catch(() => {});
		}

		async function init() {
			if (!area) return;
			const stored = await storageGet([core.SETTINGS_KEY, core.ARMED_KEY, core.LAST_KEY]);
			settings = core.normalizeSettings(stored[core.SETTINGS_KEY]);
			armed = settings.enabled ? readArmed(stored[core.ARMED_KEY]) : null;
			last = readLast(stored[core.LAST_KEY]);
			ready = true;
			if (changes && changes.addListener) {
				changes.addListener((diff, areaName) => {
					if (areaName !== 'local') return;
					if (diff[core.LAST_KEY]) last = readLast(diff[core.LAST_KEY].newValue);
					if (diff[core.ARMED_KEY] && settings.enabled) {
						armed = readArmed(diff[core.ARMED_KEY].newValue);
						publish();
					}
					if (diff[core.SETTINGS_KEY]) onSettings(diff[core.SETTINGS_KEY].newValue);
				});
			}
			if (settings.enabled) {
				if (lastNote) noteUsage(lastNote.usage, lastNote.source);
				else tryArm().catch(() => {});
			}
			publish();
		}

		const ready_ = init();

		return {
			noteUsage,
			setChat,
			tick,
			cancel,
			ready: () => ready_,
			state: () => ({ settings, armed, last, chatId, busy })
		};
	}

	CC.autoContinue = { create, dom };
	if (typeof module !== 'undefined' && module.exports) module.exports = CC.autoContinue;
})();
