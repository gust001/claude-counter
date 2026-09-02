# Claude Counter

A minimal browser extension that shows token count, cache timer, and usage bars on claude.ai.

![Claude Counter screenshot](screenshot.png)

> Fork of [she-llac/claude-counter](https://github.com/she-llac/claude-counter) v0.4.2, updated for the claude.ai UI redesign (August 2026).

## Features

- **Token count** — Approximate token count for the current conversation, with a mini progress bar against the 200k context limit
- **Cache timer** — Countdown showing how long the conversation remains cached (cheaper to continue)
- **Usage bars** — Session (5-hour) and weekly (7-day) usage from Claude's native API, with progress bars and reset countdowns

## What's changed from upstream v0.4.2

- Fixed broken selectors after claude.ai's UI redesign (`chat-title-split`, `bg-surface-3`)
- Usage bars now render inside the rounded composer box
- Bars persist across page refreshes via `chrome.storage.local`
- Bars always visible with 0% fallback (free plan returns nulls until first message)
- Org-scoped usage snapshot with expired-window cleanup
- Version bumped to 2.0.2 with resilient DOM anchoring, direct fetch fallbacks, and CSP compatibility

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
- Uses Claude's `/usage` plus live SSE `message_limit` data for accurate progress bars
- Watches for DOM changes to inject UI elements as you navigate

## Privacy

- All data stays local — no external servers, no tracking
- Reads your `lastActiveOrg` cookie to query Claude's `/usage` endpoint
- Makes requests only to `claude.ai`

## Credits

- Original project by [she-llac](https://github.com/she-llac/claude-counter) (MIT)
- Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Inspired by [Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension) by lugia19

## License

MIT — see [LICENSE](LICENSE)
