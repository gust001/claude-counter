# Changelog

All notable changes to the Claude Counter extension will be documented in this file.

## [2.0.2] - 2026-09-03

### Fixed
- **Uncaught TypeError on `document.body`**: Fixed `Cannot read properties of null (reading 'appendChild')` by defensively mounting tooltips (`makeTooltip`), safely starting `MutationObserver` on `document.body || document.documentElement` (or upon `DOMContentLoaded`), and configuring UI content scripts to run at `document_idle`.

## [2.0.1] - 2026-09-03

### Fixed
- **Composer Mounting & Modern UI Anchoring**: Decoupled usage line mounting from `[data-testid="model-selector-dropdown"]` and `[data-cds="ChatComposer"]`. The usage bar now directly anchors to `[data-testid="chat-input"]` and mounts seamlessly inside `.bg-surface-3` after the flow child on both the home/new chat view and conversation view.
- **Header Token Counter Anchoring**: Added multi-selector support for header title elements (`chat-title-split`, `chat-title-button`, `conversation-title`) so token counts and cache timers reliably render across various page states and updates.
- **Unhandled Storage Promise Crash**: Wrapped `chrome.storage.sync` check in `main.js` with comprehensive try/catch and fallback to avoid silent crashes on initial load when sync storage is unavailable.
- **Direct Fetch Fallbacks**: Added direct content script `fetch()` fallbacks for `/usage`, `/chat_conversations/{id}`, and `/organizations` when the bridge client is delayed or blocked by CSP.
- **Active Org ID Resolution**: Implemented multi-tier active organization resolution checking memory, cookies (`lastActiveOrg`), local storage, extension storage, and querying `/api/organizations` directly.
- **Content Security Policy (CSP) Compatibility**: Declared `src/injected/bridge.js` with `"world": "MAIN"` in `manifest.json`, eliminating failures caused by DOM `<script>` tags blocked by `script-src`.
- **Local Web Crypto Token Hashing**: Added direct `crypto.subtle.digest` in content script context to accelerate token cache fingerprinting without requiring bridge message-passing.

## [2.0.0] - 2026-08-20

### Added
- Forked and updated for claude.ai UI redesign.
- Usage bars rendered inside rounded composer box.
- Local storage persistence for session and weekly usage state.
