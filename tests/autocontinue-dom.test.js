'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeDom } = require('./helpers/fake-dom');
const { autoContinue } = require('./helpers/auto-helpers');

// The page side of auto-continue against the small fake DOM: which button is taken for "send".

function page() {
	const dom = createFakeDom();
	globalThis.document = dom.document;
	const { box, flow, input } = dom.buildComposer();
	const button = (label, attrs = {}) => {
		const b = dom.document.createElement('button');
		if (label) b.setAttribute('aria-label', label);
		for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
		b.clicks = 0;
		b.click = () => {
			b.clicks += 1;
		};
		box.appendChild(b);
		return b;
	};
	return { dom, box, flow, input, button };
}

test.afterEach(() => {
	delete globalThis.document;
	delete globalThis.KeyboardEvent;
});

test('D01 the send button is found by its label, in English and Czech, not the stop or attach buttons', () => {
	for (const label of ['Send message', 'Send', 'Odeslat zprávu', 'Pošli', 'Enviar mensaje']) {
		const p = page();
		p.button('Attach file');
		p.button('Stop response');
		const send = p.button(label);
		assert.equal(autoContinue.dom.findSendButton(p.input), send, label);
	}
	const none = page();
	none.button('Attach file');
	assert.equal(autoContinue.dom.findSendButton(none.input), null);
});

test('D02 the data-testid also counts', () => {
	const p = page();
	const send = p.button(null, { 'data-testid': 'send-button' });
	assert.equal(autoContinue.dom.findSendButton(p.input), send);
});

test('D03 our own indicator is never taken for the send button', () => {
	const p = page();
	const row = p.dom.document.createElement('div');
	row.className = 'cc-usageRow';
	const chip = p.dom.document.createElement('span');
	chip.className = 'cc-autoChip';
	chip.setAttribute('role', 'button');
	chip.setAttribute('title', 'Auto-continue: sends "continue" to this chat');
	row.appendChild(chip);
	p.box.appendChild(row);
	assert.equal(autoContinue.dom.findSendButton(p.input), null);
	const send = p.button('Send message');
	assert.equal(autoContinue.dom.findSendButton(p.input), send);
});

test('D04 a disabled button is not pressed, an enabled one is', () => {
	const p = page();
	const send = p.button('Send message', { 'aria-disabled': 'true' });
	const res = autoContinue.dom.send(p.input);
	assert.equal(res.sent, false);
	assert.match(res.reason, /disabled/);
	assert.equal(send.clicks, 0);
	send.setAttribute('aria-disabled', 'false');
	assert.deepEqual(autoContinue.dom.send(p.input), { sent: true, via: 'button' });
	assert.equal(send.clicks, 1);
	send.disabled = true;
	assert.equal(autoContinue.dom.send(p.input).sent, false);
});

test('D05 without a button Enter is pressed in the message box', () => {
	// Node has no KeyboardEvent; a browser does
	globalThis.KeyboardEvent = class {
		constructor(type, init) {
			this.type = type;
			Object.assign(this, init);
		}
	};
	const p = page();
	const events = [];
	p.input.focus = () => {};
	p.input.dispatchEvent = (e) => events.push(`${e.type}:${e.key}`);
	const res = autoContinue.dom.send(p.input);
	assert.deepEqual(res, { sent: true, via: 'enter' });
	assert.deepEqual(events, ['keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
});

test('D06 the message box is the visible editable element, not our own elements', () => {
	const p = page();
	assert.equal(autoContinue.dom.findComposer(), p.input);
	p.input.hidden = true;
	assert.equal(autoContinue.dom.findComposer(), null);
});

test('D07 reading the box: zero-width characters and white space do not count as text', () => {
	const p = page();
	p.input.textContent = '​  \n';
	assert.equal(autoContinue.dom.readText(p.input), '');
	p.input.textContent = ' hello ';
	assert.equal(autoContinue.dom.readText(p.input), 'hello');
});
