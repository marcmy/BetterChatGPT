# BetterChatGPT

BetterChatGPT is a browser extension for ChatGPT focused on quality-of-life improvements, customization, resilience, and diagnostics without replacing ChatGPT's native workflow. Chromium/Edge and Mozilla-signed Firefox builds are available.

## v1.1 pre-release highlights

- **Sidebar state persistence** — remembers whether Pinned, Projects, and Chats are expanded or collapsed across reloads and browser restarts.
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

**[Download BetterChatGPT v1.1 pre.2 for Chromium/Edge](https://github.com/marcmy/BetterChatGPT/raw/main/artifacts/BetterChatGPT-chromium-v1.1-pre.2.zip)**

SHA-256: `c59a817fcaaa6da23ef3410743610928690b11758a47125fa00463dabe296e10`

1. Extract `BetterChatGPT-chromium-v1.1.zip`.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted folder.

## Install — Firefox

**[Download Mozilla-signed BetterChatGPT v1.1 pre.2 for Firefox](https://github.com/marcmy/BetterChatGPT/raw/main/artifacts/BetterChatGPT-firefox-v1.1-pre.2.xpi)**

SHA-256: `91f3e56dd31b818fc2e3d0062a19f08e0e07aee184d408c7ce9dc734c13b344c`

The XPI is signed by Mozilla AMO as unlisted add-on **Better ChatGPT** (`better-chatgpt@marcmy.github.io`, AMO add-on #3062261).

1. Download `BetterChatGPT-firefox-v1.1.xpi`.
2. In Firefox, open **Add-ons and themes**.
3. Use the gear menu → **Install Add-on From File…** and select the XPI.

Firefox packaging is generated from the same committed runtime with `tools/build-firefox.mjs`. The transform replaces Chromium's MV3 background service worker declaration with Firefox's background script declaration and adds the stable Gecko ID plus Mozilla's required data-collection declaration.

Every push that changes the runtime runs JavaScript validation, `web-ext lint`, and an unsigned Firefox package build in GitHub Actions. A manual **BetterChatGPT Firefox** workflow run with **Sign the Firefox XPI with Mozilla AMO** enabled uses the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` to request an unlisted Mozilla signature and uploads the signed XPI as an Actions artifact.

Local Firefox packaging:

```bash
node tools/build-firefox.mjs
npx --yes web-ext@10 lint --source-dir build/firefox-src
npx --yes web-ext@10 build --source-dir build/firefox-src --artifacts-dir build/firefox --overwrite-dest
```

See `AMO_REVIEW_NOTES.md` for Mozilla reviewer/build notes. Both published browser packages are checksummed in `artifacts/SHA256SUMS.txt`.

## Settings

Click the floating **B+** button in ChatGPT and choose **Settings…**. All regular settings apply immediately; **Reload ChatGPT** remains available only as a manual troubleshooting action.

The **Native hang recorder** lives under Advanced and intentionally remains active when BetterChatGPT's **Master enable** is off. This allows an A/B reproduction where BetterChatGPT's normal features are dormant but the recorder can still capture evidence from a native ChatGPT freeze. Disabling the extension itself from the browser's extension manager disables the recorder as well.

## Privacy

BetterChatGPT runs locally in the ChatGPT page. The native hang recorder records performance/timing metadata and coarse UI counts only; it does not intentionally capture prompts, tool results, filenames, tokens, cookies, or conversation text. See `PRIVACY.md`.

## Notes

ChatGPT's DOM and client behavior change frequently. BetterChatGPT deliberately reuses native ChatGPT actions where practical and keeps diagnostics defensive so a selector or UI change is less likely to take down the whole extension.
