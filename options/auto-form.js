(() => {
	'use strict';

	// The auto-continue settings form, used by the settings page and by the popup of the toolbar icon.
	// It writes the settings into chrome.storage.local (key ccAuto); the content scripts pick them up
	// at once. It builds its own elements so that both pages stay in step.

	const CC = globalThis.ClaudeCounter;
	const core = CC.autoContinueCore;
	const area = chrome.storage.local;

	const get = (keys) => new Promise((resolve) => area.get(keys, (r) => resolve(r || {})));
	const set = (obj) => new Promise((resolve) => area.set(obj, () => resolve()));
	const remove = (keys) => new Promise((resolve) => area.remove(keys, () => resolve()));

	function el(tag, props = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props)) {
			if (key === 'text') node.textContent = value;
			else if (key === 'class') node.className = value;
			else if (key in node && key !== 'list') node[key] = value;
			else node.setAttribute(key, value);
		}
		for (const child of [].concat(children)) if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
		return node;
	}

	function clock(ms) {
		const d = new Date(ms);
		const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		return d.toDateString() === new Date().toDateString() ? hhmm : `${d.getDate()}.${d.getMonth() + 1}. ${hhmm}`;
	}

	function ago(ms) {
		const min = Math.round((Date.now() - ms) / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min} min ago`;
		const h = Math.floor(min / 60);
		return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
	}

	/** The status line: what is planned, or why nothing is, and what happened last. */
	function describe(settings, stored) {
		const armed = stored[core.ARMED_KEY] && stored[core.ARMED_KEY].v === 2 ? stored[core.ARMED_KEY] : null;
		const last = stored[core.LAST_KEY] && stored[core.LAST_KEY].last;
		const wait = stored[core.WAIT_KEY];
		const lines = [];
		if (!settings.enabled) lines.push('Off.');
		else if (armed && armed.kind === 'send' && armed.chatId === core.NEW_CHAT) lines.push(`Planned: what is in the message box of the new chat, at ${clock(armed.fireAt)}.`);
		else if (armed && armed.kind === 'send') lines.push(`Planned: a message at ${clock(armed.fireAt)} in the chat that was in front of you when it was switched on.`);
		else if (armed && armed.kind === 'again') lines.push(`Planned: the second "continue" at ${clock(armed.fireAt)}.`);
		else if (armed && armed.kind === 'watch') lines.push('Sent. Watching whether the 5-hour limit is reached again; if it is, "continue" follows a few seconds after its reset.');
		else if (wait) lines.push(`Not planned yet: ${wait}.`);
		else lines.push('On, nothing planned yet. Open the claude.ai chat you want to continue in, or the new-chat page: the message is planned for the page in front of you.');
		if (last) lines.push(`Last: ${last.result}${last.reason ? ` (${last.reason})` : ''}, ${ago(last.at)}.`);
		return lines.join(' ');
	}

	const pad2 = (n) => String(n).padStart(2, '0');

	/** A moment in ms as the stored 'YYYY-MM-DDTHH:MM' (local time). */
	function toStored(ms) {
		const d = new Date(ms);
		return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	}

	function mountAutoForm(container) {
		let settings = core.normalizeSettings(null);
		let saveTimer = null;
		// the end of the current 5-hour window in ms, or null when it is not known (or already over)
		let resetMs = null;
		// the fixed time counts as chosen once something in its row was touched (before that it only shows a suggestion)
		let atChosen = false;

		const enabled = el('input', { type: 'checkbox', id: 'autoEnabled' });
		const whenAfter = el('input', { type: 'radio', name: 'ccAutoWhen', id: 'autoWhenAfter', value: 'afterReset' });
		const offset = el('input', { type: 'number', id: 'autoOffset', min: String(-core.OFFSET_LIMIT_MIN), max: String(core.OFFSET_LIMIT_MIN), step: '1', class: 'num' });
		const whenAt = el('input', { type: 'radio', name: 'ccAutoWhen', id: 'autoWhenAt', value: 'atTime' });
		// The fixed time is the browser's own date and time field: its calendar, its time columns and its format
		// (24 hours or AM/PM, day or month first) follow the display language of the browser.
		const at = el('input', { type: 'datetime-local', id: 'autoAt' });
		const atReset = el('button', { type: 'button', id: 'autoAtReset', text: '5h reset' });
		const atNow = el('button', { type: 'button', id: 'autoAtNow', text: 'Now', title: 'The next full minute' });
		const whatText = el('input', { type: 'radio', name: 'ccAutoWhat', id: 'autoWhatText', value: 'continue' });
		const text = el('input', { type: 'text', id: 'autoText', maxLength: 200, class: 'wide' });
		const whatComposer = el('input', { type: 'radio', name: 'ccAutoWhat', id: 'autoWhatComposer', value: 'composer' });
		const again = el('input', { type: 'checkbox', id: 'autoAgain' });
		const status = el('div', { class: 'status', id: 'autoStatus' });

		const body = el('div', { class: 'autoBody' }, [
			el('div', { class: 'group' }, [
				el('div', { class: 'groupTitle', text: 'When to send' }),
				el('label', {}, [whenAfter, ' Relative to the end of the 5-hour window: ', offset, ' min']),
				el('div', { class: 'hint', text: 'Negative means before the end (use up what is left and stay within the cache window). The moment is worked out when the plan is made.' }),
				el('label', {}, [whenAt, ' At a fixed time:']),
				el('div', { class: 'atRow' }, [at, ' ', atReset, atNow])
			]),
			el('div', { class: 'group' }, [
				el('div', { class: 'groupTitle', text: 'What to send' }),
				el('label', {}, [whatText, ' The text ', text]),
				el('label', {}, [whatComposer, ' What is in the message box (nothing is sent when it is empty)'])
			]),
			el('label', {}, [again, ' If the 5-hour limit is reached again after that, send "continue" once more, three seconds after its reset']),
			status,
			el('div', {
				class: 'hint',
				text: 'A one-time plan: switch it on in the chat you want to continue in (the message is planned for the chat in front of you), and it switches itself off after sending. It sends only while claude.ai is open on that chat. The text option needs an empty message box; a draft is left alone. Switched on in the new-chat page, it sends what is in the message box into a new chat (the message box option is chosen for you). The second "continue" uses the text above, or "continue" when the message box was chosen.'
			})
		]);

		container.replaceChildren(el('label', { class: 'master' }, [enabled, ' ', el('strong', { text: 'Auto-continue' }), ' (off by default, sends once)']), body);

		// A field that has the focus is being typed in: it is not rewritten (a lone minus sign, a trailing
		// space and the like are not valid values yet). It is tidied when the focus leaves it.
		function setValue(input, value) {
			if (document.activeElement === input || input.value === value) return;
			input.value = value;
		}

		function fill() {
			enabled.checked = settings.enabled;
			whenAfter.checked = settings.when === 'afterReset';
			whenAt.checked = settings.when === 'atTime';
			setValue(offset, String(settings.offsetMin));
			// no time chosen yet: the end of the 5-hour window when it is known, else the next full minute
			// (shown, not saved: it is saved when something here is touched or "At a fixed time" is chosen)
			const shown = settings.at || toStored(resetMs !== null ? resetMs : nextMinute());
			setValue(at, shown);
			whatText.checked = settings.what === 'continue';
			whatComposer.checked = settings.what === 'composer';
			setValue(text, settings.text);
			again.checked = settings.again;
			body.classList.toggle('disabled', !settings.enabled);
			for (const input of body.querySelectorAll('input, select, button')) input.disabled = !settings.enabled;
			updateResetButton();
		}

		function updateResetButton() {
			atReset.disabled = resetMs === null || !settings.enabled;
			atReset.title = resetMs === null ? 'The end of the 5-hour window is not known yet' : `The end of the 5-hour window, ${toStored(resetMs).slice(11)}`;
		}

		const nextMinute = () => Math.floor(Date.now() / 60000) * 60000 + 60000;

		/** The field's value when it holds a complete date and time ('YYYY-MM-DDTHH:MM'), else null (half typed, or cleared). */
		const atValue = () => (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(at.value) ? at.value : null);

		async function refreshReset() {
			const stored = await get(['claude_usage_state']);
			const window = core.fiveHour(stored.claude_usage_state && stored.claude_usage_state.usage, Date.now());
			resetMs = window ? Math.floor(window.resetMs / 60000) * 60000 : null;
		}

		function read() {
			return core.normalizeSettings({
				enabled: enabled.checked,
				when: whenAt.checked ? 'atTime' : 'afterReset',
				offsetMin: offset.value,
				at: (settings.at || atChosen) && atValue() ? atValue() : settings.at,
				what: whatComposer.checked ? 'composer' : 'continue',
				text: text.value,
				again: again.checked
			});
		}

		function save(immediately) {
			clearTimeout(saveTimer);
			const run = async () => {
				settings = read();
				await set({ [core.SETTINGS_KEY]: settings });
				// switched off by hand: whatever was planned goes with it
				if (!settings.enabled) await remove([core.ARMED_KEY, core.WAIT_KEY]);
				fill();
			};
			if (immediately) return run();
			saveTimer = setTimeout(run, 400);
		}

		async function refreshStatus() {
			const stored = await get([core.ARMED_KEY, core.LAST_KEY, core.WAIT_KEY]);
			status.textContent = describe(settings, stored);
		}

		// choosing "At a fixed time" takes the date and time shown, suggested or not
		whenAt.addEventListener('change', () => {
			atChosen = true;
		});
		for (const input of [enabled, whenAfter, whenAt, whatText, whatComposer, again]) input.addEventListener('change', () => save(true));

		// touching the date or the time chooses the fixed time
		function touchedAt() {
			atChosen = true;
			whenAt.checked = true;
			save(true);
		}
		// the field reports a change each time its value is complete (a part still empty, while typing, is no change)
		at.addEventListener('change', () => {
			if (atValue()) touchedAt();
		});
		at.addEventListener('blur', () => {
			if (document.activeElement === at) return;
			fill();
		});
		atReset.addEventListener('click', () => {
			if (resetMs === null) return;
			at.value = toStored(resetMs);
			touchedAt();
		});
		atNow.addEventListener('click', () => {
			at.value = toStored(nextMinute());
			touchedAt();
		});

		// While typing, only a complete value is saved; what is half typed (a lone "-") waits.
		const partial = (input) => input === offset && offset.value === '';
		for (const input of [offset, text]) {
			input.addEventListener('input', () => {
				if (partial(input)) {
					clearTimeout(saveTimer);
					return;
				}
				save(false);
			});
			input.addEventListener('change', () => {
				if (!partial(input)) save(true);
			});
			// the field is tidied only once the focus has left it: a value that cannot be used goes back
			// to the last good one
			input.addEventListener('blur', () => {
				// switching to another window also blurs the field, but the focus is still in it: leave it alone
				if (document.activeElement === input) return;
				if (partial(input)) input.value = '';
				fill();
			});
		}

		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return;
			if (changes[core.SETTINGS_KEY]) {
				// a change made elsewhere (the page switched it off after sending) wins over what is shown here
				const remote = core.normalizeSettings(changes[core.SETTINGS_KEY].newValue);
				if (JSON.stringify(remote) !== JSON.stringify(settings)) {
					settings = remote;
					fill();
				}
			}
			if (changes.claude_usage_state) {
				// the end of the 5-hour window moved: the button and the suggestion follow, unless a choice is being made
				refreshReset().then(() => {
					if (!settings.at && document.activeElement !== at) fill();
					else updateResetButton();
				});
			}
			if (changes[core.ARMED_KEY] || changes[core.LAST_KEY] || changes[core.WAIT_KEY] || changes[core.SETTINGS_KEY]) refreshStatus();
		});

		Promise.all([get([core.SETTINGS_KEY]), refreshReset()]).then(([stored]) => {
			settings = core.normalizeSettings(stored[core.SETTINGS_KEY]);
			fill();
			refreshStatus();
		});
		setInterval(refreshStatus, 15000);
	}

	CC.mountAutoForm = mountAutoForm;
})();
