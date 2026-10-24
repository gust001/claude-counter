(() => {
	'use strict';

	// Optional recording of the traffic between claude.ai and its server, for analysing the new
	// interface. Off by default. It is switched on in the extension's settings page (options), never
	// from the console. Runs at document_start so that streams opened while the page loads are seen.
	//
	// Flow: bridge.js (page world) hands raw records over with window.postMessage ('cc:capture_record'),
	// this script redacts them (unless turned off), keeps them in chrome.storage.local, and the
	// settings page downloads them as one JSON file.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__captureStarted) return;
	CC.__captureStarted = true;

	const SETTINGS_DEFAULTS = { ccCaptureEnabled: false, ccCaptureRedact: true };
	const MARKER = 'ClaudeCounter';
	const EVENT_TYPES = new Set(['cc:message_limit', 'cc:turn_end', 'cc:generation_start', 'cc:conversation', 'cc:bridge_ready']);

	const area = globalThis.chrome?.storage?.local;
	if (!area) return;

	const storage = {
		get: (keys) => new Promise((resolve) => area.get(keys, (r) => resolve(r || {}))),
		set: (obj) => new Promise((resolve) => area.set(obj, () => resolve())),
		remove: (keys) => new Promise((resolve) => area.remove(keys, () => resolve()))
	};

	let enabled = false;
	let redact = true;
	let store = null;
	let chain = Promise.resolve();

	// A conversation id in an address would tell who is who; ids are replaced in everything stored.
	const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
	function safePath(path) {
		return String(path || '')
			.replace(/\/chat\/[^/?#]+/g, '/chat/:id')
			.replace(UUID, ':id');
	}

	function setPageFlag(on) {
		try {
			// bridge.js reads this on every request, so the setting takes effect without a reload.
			document.documentElement.dataset.ccCapture = on ? '1' : '0';
		} catch {
			// ignore
		}
	}

	function startSession() {
		store = new CC.captureStore.CaptureStore({ storage, redacted: redact, url: safePath(location.pathname) });
		store.start();
		store.add({ t: Date.now(), kind: 'session', path: safePath(location.pathname), redacted: redact, ua: navigator.userAgent });
	}

	function applySettings(s) {
		const nextEnabled = !!s.ccCaptureEnabled;
		const nextRedact = s.ccCaptureRedact !== false;
		const redactChanged = nextRedact !== redact;
		redact = nextRedact;

		if (nextEnabled && (!enabled || redactChanged)) {
			if (store) store.flush();
			startSession();
		}
		if (!nextEnabled && store) {
			store.flush();
			store = null;
		}
		enabled = nextEnabled;
		setPageFlag(enabled);
	}

	function record(rec) {
		if (!enabled || !store) return;
		const current = store;
		const useRedact = redact;
		// Keep the order of records even though unpacking gzip frames is asynchronous.
		chain = chain
			.then(() => CC.captureRedact.prepareRecord(rec, useRedact))
			.then((prepared) => {
				// the setting may have been switched off, or the session deleted, while this was prepared
				if (enabled && store === current) current.add(prepared);
			})
			.catch(() => {});
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== MARKER || !enabled) return;

		if (data.type === 'cc:capture_record') {
			if (data.payload && typeof data.payload === 'object') record(data.payload);
			return;
		}

		if (EVENT_TYPES.has(data.type)) {
			const payload = data.payload || {};
			const rec = { t: Date.now(), kind: 'event', type: data.type };
			if (data.type === 'cc:message_limit' || data.type === 'cc:turn_end') rec.payload = payload;
			if (data.type === 'cc:conversation') {
				rec.messages = Array.isArray(payload.data?.chat_messages) ? payload.data.chat_messages.length : null;
			}
			record(rec);
		}
	});

	// ---- what the page looks like (for finding where the header goes in the new interface) ----

	const ANCHOR_SELECTORS = [
		'[data-testid="chat-title-split"]',
		'[data-testid="chat-title-button"]',
		'[data-testid="chat-menu-trigger"]',
		'[data-testid="conversation-title"]',
		'header h1',
		'header',
		'[data-testid="model-selector-dropdown"]',
		'[data-testid="chat-input"]',
		'[data-testid="chat-input-grid-container"]',
		'[data-cds="ChatComposer"]',
		'div[contenteditable="true"]',
		'.chat-project-wrapper'
	];

	function ariaText(label, masked) {
		const text = String(label || '').slice(0, 40);
		if (!text) return undefined;
		return masked ? 'x'.repeat(text.length) : text;
	}

	function describe(el, masked) {
		const rect = el.getBoundingClientRect();
		const chain = [];
		let p = el.parentElement;
		for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
			chain.push(`${p.tagName.toLowerCase()}${p.getAttribute('data-testid') ? `[${p.getAttribute('data-testid')}]` : ''}`);
		}
		return {
			tag: el.tagName.toLowerCase(),
			testid: el.getAttribute('data-testid') || undefined,
			role: el.getAttribute('role') || undefined,
			// an aria-label can be a chat title: with masking on only its length is kept
			aria: ariaText(el.getAttribute('aria-label'), masked),
			cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 100) || undefined,
			box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
			parents: chain
		};
	}

	// Where the page shows the chat title: the element whose whole text is the title (document.title
	// without the site name), with a few levels of parents, so the header can be placed next to it.
	// With masking on only the length of the title is kept, never the text.
	// How the element is laid out (CSS only, no content): a title bar that floats over the chat and
	// hides it only when the title gets long is told apart by position, background and overflow.
	function styleOf(el) {
		try {
			if (typeof getComputedStyle !== 'function') return undefined;
			const cs = getComputedStyle(el);
			const out = {
				position: cs.position,
				z: cs.zIndex,
				display: cs.display,
				overflow: cs.overflow,
				bg: cs.backgroundColor,
				bgImage: cs.backgroundImage && cs.backgroundImage !== 'none' ? 'set' : 'none',
				pointer: cs.pointerEvents
			};
			if (/flex/.test(cs.display)) {
				out.dir = cs.flexDirection;
				out.wrap = cs.flexWrap;
			}
			if (cs.maskImage && cs.maskImage !== 'none') out.mask = 'set';
			if (cs.backdropFilter && cs.backdropFilter !== 'none') out.backdrop = 'set';
			return out;
		} catch {
			return undefined;
		}
	}

	const PROBE_SKIP = 'nav, aside, [role="navigation"], .cc-header, .cc-usageRow, .cc-tooltip, script, style';
	function titleProbe(masked) {
		const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
		const title = norm(String(document.title || '').replace(/\s*[-\u2013\u2014|\u00b7]\s*Claude\s*$/i, ''));
		if (title.length < 2) return { found: false, reason: 'no title in document.title' };
		const out = { found: false, titleLength: title.length, matches: 0 };
		if (!masked) out.title = title;
		let scanned = 0;
		for (const el of document.querySelectorAll('*')) {
			if (++scanned > 6000) {
				out.truncated = true;
				break;
			}
			if (el.children && el.children.length) continue;
			if (norm(el.textContent) !== title) continue;
			if (el.closest(PROBE_SKIP)) {
				out.inSidebar = (out.inSidebar || 0) + 1;
				continue;
			}
			out.matches += 1;
			if (out.found) continue;
			const rect = el.getBoundingClientRect();
			out.found = true;
			out.leaf = describe(el, masked);
			out.leaf.style = styleOf(el);
			out.ancestors = [];
			let p = el.parentElement;
			for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
				const r = p.getBoundingClientRect();
				out.ancestors.push({
					tag: p.tagName.toLowerCase(),
					testid: p.getAttribute('data-testid') || undefined,
					cls: String(p.className && p.className.baseVal !== undefined ? p.className.baseVal : p.className || '').slice(0, 100) || undefined,
					box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
					children: p.children ? p.children.length : undefined,
					style: styleOf(p)
				});
			}
			const next = el.nextElementSibling;
			if (next) out.next = describe(next, masked);
			out.visible = rect.width > 0 && rect.height > 0;
		}
		return out;
	}

	// The message box and the buttons around it (to see where the send button sits). The label
	// of a button that looks like "send" is a word of the page's interface and is kept; other labels
	// are only kept when masking is off.
	const SEND_LABEL = /(send|odeslat|ode[sš]li|poslat|po[sš]li|envoyer|senden|enviar|invia)/i;
	function composerProbe(masked) {
		const editor = document.querySelector('[data-testid="chat-input"], div[contenteditable="true"], textarea');
		if (!editor) return { found: false };
		const out = { found: true, editor: describe(editor, masked), buttons: [] };
		const seen = new Set();
		let scope = editor;
		for (let level = 0; level < 8 && scope; level++, scope = scope.parentElement) {
			for (const button of scope.querySelectorAll('button, [role="button"]')) {
				if (seen.has(button) || (button.closest && button.closest('.cc-header, .cc-usageRow, .cc-tooltip'))) continue;
				seen.add(button);
				if (out.buttons.length >= 14) break;
				const text = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.getAttribute('title')].filter(Boolean).join(' ');
				const sendLike = SEND_LABEL.test(text);
				const item = describe(button, masked && !sendLike);
				item.level = level;
				item.sendLike = sendLike;
				item.disabled = button.disabled === true || button.getAttribute('aria-disabled') === 'true';
				item.type = button.getAttribute('type') || undefined;
				out.buttons.push(item);
			}
		}
		return out;
	}

	function domSnapshot(label) {
		if (!enabled || !document.body) return;
		try {
			const anchors = {};
			for (const sel of ANCHOR_SELECTORS) anchors[sel] = document.querySelectorAll(sel).length;

			const top = [];
			for (const el of document.querySelectorAll('[data-testid], header, [role="banner"], h1')) {
				const r = el.getBoundingClientRect();
				if (r.height > 0 && r.top < 140 && top.length < 60) top.push(describe(el, redact));
			}

			const testids = {};
			for (const el of document.querySelectorAll('[data-testid]')) {
				const id = el.getAttribute('data-testid');
				testids[id] = (testids[id] || 0) + 1;
			}

			const headerEl = document.querySelector('.cc-header');
			const ours = {
				header: !!headerEl,
				usageLine: !!document.querySelector('.cc-usageGroup'),
				place: headerEl && typeof headerEl.getAttribute === 'function' ? headerEl.getAttribute('data-cc-place') || undefined : undefined,
				headerBox: headerEl
					? (() => {
							const r = headerEl.getBoundingClientRect();
							return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
						})()
					: undefined
			};

			record({
				t: Date.now(),
				kind: 'dom',
				label,
				path: safePath(location.pathname),
				viewport: [window.innerWidth, window.innerHeight],
				anchors,
				top,
				testids: Object.fromEntries(Object.entries(testids).slice(0, 150)),
				titleProbe: titleProbe(redact),
				composer: composerProbe(redact),
				ours
			});
		} catch {
			// diagnostics must never get in the way
		}
	}

	function scheduleSnapshots(label) {
		setTimeout(() => domSnapshot(`${label}+2s`), 2000);
		setTimeout(() => domSnapshot(`${label}+8s`), 8000);
	}

	let lastPath = location.pathname;
	window.addEventListener('cc:urlchange', () => {
		if (location.pathname === lastPath) return;
		lastPath = location.pathname;
		if (enabled) {
			record({ t: Date.now(), kind: 'nav', path: safePath(location.pathname) });
			scheduleSnapshots('nav');
		}
	});

	// ---- settings ----

	storage.get(SETTINGS_DEFAULTS).then((s) => {
		applySettings({ ...SETTINGS_DEFAULTS, ...s });
		if (enabled) scheduleSnapshots('load');
	});

	try {
		globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return;

			// The recording of this page was deleted (settings page, or the newest-three rule): stop,
			// otherwise the next write would bring it back.
			if (store && changes[store.key] && changes[store.key].newValue === undefined) {
				store.stop();
				store = null;
			}

			if (!('ccCaptureEnabled' in changes) && !('ccCaptureRedact' in changes)) return;
			storage.get(SETTINGS_DEFAULTS).then((s) => {
				const wasEnabled = enabled;
				applySettings({ ...SETTINGS_DEFAULTS, ...s });
				if (enabled && !wasEnabled) scheduleSnapshots('enabled');
			});
		});
	} catch {
		// ignore
	}

	window.addEventListener('pagehide', () => {
		if (store) store.flush();
	});
})();
