'use strict';
// The settings page and the popup are plain HTML files: a script that is missing from the page, or never
// mounts the form, leaves the page empty, and no other test would notice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

for (const page of ['options/options.html', 'popup/popup.html']) {
	const file = path.join(root, page);
	const html = fs.readFileSync(file, 'utf8');
	const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => path.resolve(path.dirname(file), m[1]));

	test(`${page}: every script it names exists`, () => {
		assert.ok(scripts.length > 0);
		for (const s of scripts) assert.ok(fs.existsSync(s), `${s} is missing`);
	});

	test(`${page}: the form container is there and a script mounts the form into it`, () => {
		assert.match(html, /<div id="autoForm"><\/div>/);
		const names = scripts.map((s) => path.relative(root, s));
		const formAt = names.indexOf('options/auto-form.js');
		assert.ok(formAt >= 0, 'auto-form.js is not loaded');
		const mounts = scripts.some((s, i) => i > formAt && /mountAutoForm\(\s*document\.getElementById\('autoForm'\)\s*\)/.test(fs.readFileSync(s, 'utf8')));
		assert.ok(mounts, 'no script after auto-form.js mounts the form');
	});
}
