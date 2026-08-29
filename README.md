# BetterChatGPT

BetterChatGPT is a browser extension for ChatGPT focused on quality-of-life improvements, customization, resilience, and diagnostics without replacing ChatGPT's native workflow. Chromium/Edge and Mozilla-signed Firefox builds are available.

## v1.1 pre-release highlights

- **Sidebar state persistence** — remembers whether Projects and Chats are expanded or collapsed across reloads and browser restarts. Pinned is intentionally left to ChatGPT's native behavior because its current control can open a floating panel in some layouts.
- **Project home shortcut** — double-click a project in the sidebar to invoke ChatGPT's existing **Project home** action; the normal `...` menu item remains available.
- **Cross-device stale-chat protection** — after the desktop tab has been idle or hidden, BetterChatGPT verifies the authoritative conversation tail before a normal follow-up sends. If another device advanced the chat, it resyncs rather than sending from an outdated `parent_message_id`.
- **Native hang recorder** — low-overhead diagnostics for severe ChatGPT/tool-call UI freezes that can occur even with BetterChatGPT disabled. On Chromium/Edge, a service worker can record when the page stops heartbeating; Firefox uses a background script. Diagnostic data contains timing/count metadata, not prompt or tool-result text.
- **Queued send retained** while ChatGPT now owns uploads natively.
- **Classic dark gray** now matches the ChatGPT desktop-app dark palette: conversation `#121212` / `#FCFCFC`, composer `#242424`, sidebar `#202020`.
- **Wide-mode polish** for the conversation overflow (`...`) control and relocated Share row.
- Removed obsolete **Live uploads while generating**, **Focus composer**, and **Long-chat optimizer** features now superseded by native ChatGPT behavior.

## Existing features

- Wide mode with independent conversation/composer width controls.
- Draggable **B+** launcher and quick-action rail.
- Full visible-conversation Markdown export.
- User-bubble appearance controls and optional ChatGPT accent override.
- Conversation, composer, sidebar, and assistant-text color controls.
- Hybrid scrolling behavior for normal and voice conversations.
- Plain-text composer paste/copy cleanup.
- Queued follow-up sending while ChatGPT is generating.
- Edited-message attachment support using ChatGPT's native upload/Library metadata bridge.
- Settings profiles, local storage, browser sync, JSON import/export, and privacy-safe diagnostics.

## Install — Edge / Chrome

The current published package is **v1.1-pre.1**. Pre.2 remains under active testing.

1. Download the Chromium package from the latest GitHub pre-release.
2. Extract it.
3. Open `edge://extensions` or `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select the extracted folder.

## Install — Firefox

The current published Mozilla-signed Firefox package is also **v1.1-pre.1**.

Firefox packaging is generated from the same committed runtime with `tools/build-firefox.mjs`. Normal pushes and pull requests run only shared/Chromium source validation. Firefox transform validation, `web-ext` lint/package, and AMO signing are intentionally performed only from the manual **BetterChatGPT Firefox Release** workflow when preparing a release.

Local Firefox packaging:

```bash
node tools/build-firefox.mjs
npx --yes web-ext@10 lint --source-dir build/firefox-src
npx --yes web-ext@10 build --source-dir build/firefox-src --artifacts-dir build/firefox --overwrite-dest
```

See `AMO_REVIEW_NOTES.md` for Mozilla reviewer/build notes.

## Settings

Click the floating **B+** button in ChatGPT and choose **Settings…**. All regular settings apply immediately; **Reload ChatGPT** remains available only as a manual troubleshooting action.

The **Native hang recorder** lives under Advanced and intentionally remains active when BetterChatGPT's **Master enable** is off. This allows an A/B reproduction where BetterChatGPT's normal features are dormant but the recorder can still capture evidence from a native ChatGPT freeze. Disabling the extension itself from the browser's extension manager disables the recorder as well.

## Privacy

BetterChatGPT runs locally in the ChatGPT page. The native hang recorder records performance/timing metadata and coarse UI counts only; it does not intentionally capture prompts, tool results, filenames, tokens, cookies, or conversation text. See `PRIVACY.md`.

## Notes

ChatGPT's DOM and client behavior change frequently. BetterChatGPT deliberately reuses native ChatGPT actions where practical and keeps diagnostics defensive so a selector or UI change is less likely to take down the whole extension.
