# Claude Counter

A minimal browser extension that shows token count, cache timer, and usage bars on claude.ai.

![Claude Counter screenshot](screenshot.png)

> Fork of [she-llac/claude-counter](https://github.com/she-llac/claude-counter) v0.4.2, updated for the claude.ai UI redesign (August 2026) and for the new unified claude.ai interface (October 2026).

## Features

- **Token count** — Approximate token count for the current conversation, with a mini progress bar against the 200k context limit
- **Cache timer** — Countdown showing how long the conversation remains cached (cheaper to continue)
- **Usage bars** — Session (5-hour) and weekly (7-day) usage from Claude's native API, with progress bars and reset countdowns

## Supported claude.ai interfaces

claude.ai is moving accounts to a new unified interface, and an account can be switched from one to the other.

| | Old interface | New interface |
| --- | --- | --- |
| Usage bars | `message_limit` in the `/completion` stream | limits in the `StreamTimeline` Connect stream |
| Token count, cache timer | conversation read when the page loads it | conversation read by the extension, again after every reply |

Both methods run side by side; whichever the page uses is picked up.

## What's changed from upstream v0.4.2

- Fixed broken selectors after claude.ai's UI redesign (`chat-title-split`, `bg-surface-3`)
- Usage bars now render inside the rounded composer box
- Bars persist across page refreshes via `chrome.storage.local`
- Bars always visible with 0% fallback (free plan returns nulls until first message)
- Org-scoped usage snapshot with expired-window cleanup
- Version bumped to 2.0.2 with resilient DOM anchoring, direct fetch fallbacks, and CSP compatibility
- 2.1.0: support for the new unified interface, fixes for the usage polling, expired windows and saved usage, optional traffic recording, tests (see the [changelog](CHANGELOG.md))

## Installation

**Chrome / Edge / Chromium**

1. Download `claude-counter-2.0.2.zip` from [Releases](../../releases/tag/v2.0.2)
2. Go to `chrome://extensions` and enable **Developer mode**
3. Drag and drop the zip onto the page

**Firefox**

1. Download `claude-counter-2.0.2.xpi` from [Releases](../../releases/tag/v2.0.2)
2. Drag it into any Firefox window and click **Add**

## How it works

- Intercepts Claude's API responses to read conversation data and usage info
- Uses a vendored tokenizer (`o200k_base`) for approximate token counting
- Uses Claude's `/usage` plus the live limits that come with every reply (the old `message_limit` event, or the limits of the new `StreamTimeline` stream) for accurate progress bars
- Where `/usage` reports nothing (free plan) the bars show "no data yet" until the first reply of a session brings the limits; an ended window shows 0%
- Watches for DOM changes to inject UI elements as you navigate

## Traffic recording (for developers)

Off by default. Open the extension's settings (`chrome://extensions` → Claude Counter → Details → Extension options) to record what claude.ai and its server exchange, e.g. to analyse a change of the interface. Message text and binary values are masked unless you switch masking off. Conversation ids in addresses are always replaced. A recording is kept in the browser (about 2.5 MB per page load, the newest three) until you download or delete it; deleting it stops open tabs from recording until they are reloaded. It is a best-effort heuristic: look at a file before you share it.

## Development

Load the repository folder with **Load unpacked** (Developer mode). Run the tests with `npm test` (Node 22, nothing to install).

## Privacy

- All data stays local — no external servers, no tracking
- Reads your `lastActiveOrg` cookie (or the organisation id the page itself uses) to query Claude's `/usage` endpoint
- Traffic recording is off unless you switch it on in the settings, and its data never leaves your browser unless you download it
- Makes requests only to `claude.ai`

## Credits

- Original project by [she-llac](https://github.com/she-llac/claude-counter) (MIT)
- Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Inspired by [Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension) by lugia19

## License

MIT — see [LICENSE](LICENSE)
