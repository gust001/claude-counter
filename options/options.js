(() => {
	'use strict';

	const CC = globalThis.ClaudeCounter;
	const area = chrome.storage.local;

	const storage = {
		get: (keys) => new Promise((resolve) => area.get(keys, (r) => resolve(r || {}))),
		set: (obj) => new Promise((resolve) => area.set(obj, () => resolve())),
		remove: (keys) => new Promise((resolve) => area.remove(keys, () => resolve()))
	};

	const $ = (id) => document.getElementById(id);
	const DEFAULTS = { ccCaptureEnabled: false, ccCaptureRedact: true };

	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function sessionBytes(session) {
		return session.records.reduce((sum, r) => sum + CC.captureStore.approxSize(r), 0);
	}

	function fileStamp(ms) {
		return new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
	}

	function download(sessions, name) {
		const manifest = chrome.runtime.getManifest();
		const payload = {
			format: 'claude-counter-capture/1',
			exportedAt: new Date().toISOString(),
			extensionVersion: manifest.version_name || manifest.version,
			sessions
		};
		const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10000);
	}

	async function render() {
		const settings = { ...DEFAULTS, ...(await storage.get(DEFAULTS)) };
		$('enabled').checked = !!settings.ccCaptureEnabled;
		$('redact').checked = settings.ccCaptureRedact !== false;

		const status = $('status');
		status.classList.toggle('on', !!settings.ccCaptureEnabled);
		status.textContent = settings.ccCaptureEnabled
			? 'Recording is ON for claude.ai tabs.'
			: 'Recording is off.';

		const sessions = await CC.captureStore.listSessions(storage);
		const body = $('sessions').querySelector('tbody');
		body.replaceChildren();

		if (sessions.length === 0) {
			const tr = document.createElement('tr');
			const td = document.createElement('td');
			td.colSpan = 6;
			td.className = 'empty';
			td.textContent = 'No recordings stored.';
			tr.appendChild(td);
			body.appendChild(tr);
		}

		for (const s of sessions) {
			const tr = document.createElement('tr');
			const cells = [
				new Date(s.startedAt).toLocaleString(),
				s.url || '',
				String(s.records.length) + (s.capped ? ' (limit reached)' : ''),
				formatSize(sessionBytes(s)),
				s.redacted ? 'yes' : 'no'
			];
			cells.forEach((text, i) => {
				const td = document.createElement('td');
				if (i === 2 || i === 3) td.className = 'num';
				td.textContent = text;
				tr.appendChild(td);
			});
			const td = document.createElement('td');
			const btn = document.createElement('button');
			btn.textContent = 'Download';
			btn.addEventListener('click', () => download([s], `claude-counter-capture-${fileStamp(s.startedAt)}.json`));
			td.appendChild(btn);
			tr.appendChild(td);
			body.appendChild(tr);
		}

		$('downloadAll').disabled = sessions.length === 0;
		$('clear').disabled = sessions.length === 0;
		$('downloadAll').onclick = () => download(sessions, `claude-counter-capture-${fileStamp(Date.now())}.json`);
	}

	$('enabled').addEventListener('change', async (e) => {
		await storage.set({ ccCaptureEnabled: e.target.checked });
		render();
	});
	$('redact').addEventListener('change', async (e) => {
		await storage.set({ ccCaptureRedact: e.target.checked });
		render();
	});
	$('refresh').addEventListener('click', render);
	$('clear').addEventListener('click', async () => {
		if (!confirm('Delete all stored recordings?')) return;
		await CC.captureStore.clearSessions(storage);
		render();
	});

	// A recording is written every couple of seconds while a page is open, so the list is redrawn at
	// most every two seconds, and only for changes that concern the recording.
	let renderTimer = null;
	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local') return;
		const relevant = Object.keys(changes).some((k) => k === 'ccCaptureEnabled' || k === 'ccCaptureRedact' || CC.captureStore.isSessionKey(k));
		if (!relevant || renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = null;
			render();
		}, 2000);
	});

	render();
})();
