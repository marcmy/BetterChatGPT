# Changelog

## 1.1-pre.2 - 2026-08-29

- Keep hyperlinks inside colored user bubbles on the browser-native blue link color instead of inheriting BetterChatGPT text colors.
- Make all regular settings, profiles, imports, and section resets apply on-the-fly without requiring a ChatGPT reload. Master enable now suspends/resumes feature runtimes live; the Native hang recorder remains intentionally independent for A/B diagnostics.
- Make Smart scrolling, Queued sending, plain-text paste/copy, and edited-message attachment enhancement react to settings changes without page reloads.
- Harden queued native attachments during generation: observe file-input, paste, and drop File objects without preventing or replaying ChatGPT's native upload events; wait for native upload completion before releasing a queued send.
- Narrow page-bridge attachment metadata parsing so generic tool/search responses are no longer cloned and recursively scanned.
- Remove the final dead Long-chat optimizer UI remnant (Wake all messages).
- Add a permanent regression checker covering removed v1.0.83 behaviors, live-setting bootstrap gates, native attachment ownership, and link styling.
- Raise Firefox's minimum version to 142 to match Mozilla's `data_collection_permissions` manifest support and package this pre-release internally as extension version `1.1.2`.

## 1.1-pre.1 - 2026-08-29

- Update the **Classic dark gray** preset to match the current ChatGPT desktop dark theme: conversation `#121212` / `#FCFCFC`, composer `#242424`, sidebar `#202020`.
- Remove BetterChatGPT's obsolete **Live uploads while generating** takeover and leave uploads to ChatGPT's native implementation while retaining **Queued send**.
- Remove **Focus composer** and all of its settings/state/runtime hooks.
- Polish the Wide Mode `…` control hover shell and align the relocated **Share** row with ChatGPT's native menu items.
- Remember the expanded/collapsed state of ChatGPT's **Pinned**, **Projects**, and **Chats** sidebar sections across reloads/reopens.
- Add a double-click shortcut on sidebar projects that invokes ChatGPT's existing native **Project home** menu action.
- Add a cross-device stale-chat guard: snapshot the authoritative conversation tail after idle/hidden periods, compare it when the user returns, and block/resync a normal send if its `parent_message_id` is no longer the server's current node. Preserve and restore unsent draft text across that safety refresh.
- Remove the obsolete **Long-chat optimizer** now that ChatGPT performs native conversation virtualization.
- Add a low-overhead **Native hang recorder** focused on ChatGPT/tool-call UI freezes. It records long animation frames/event-loop stalls plus coarse memory/DOM/UI counts locally; Chromium uses an extension service worker and Firefox uses a background script to detect when the page stops heartbeating. The recorder intentionally remains active when BetterChatGPT's Master enable is off so native-vs-extension A/B testing is possible.
- Add first-class **Firefox packaging and signing** from the same runtime. The Firefox build is validated with `web-ext`, signed by Mozilla AMO as an unlisted extension, and published alongside the Chromium package.
