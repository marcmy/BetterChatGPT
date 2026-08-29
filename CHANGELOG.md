# Changelog

## 1.1 - 2026-08-28

- Update the **Classic dark gray** preset to match the current ChatGPT desktop dark theme: conversation `#121212` / `#FCFCFC`, composer `#242424`, sidebar `#202020`.
- Remove BetterChatGPT's obsolete **Live uploads while generating** takeover and leave uploads to ChatGPT's native implementation while retaining **Queued send**.
- Remove **Focus composer** and all of its settings/state/runtime hooks.
- Polish the Wide Mode `…` control hover shell and align the relocated **Share** row with ChatGPT's native menu items.
- Remember the expanded/collapsed state of ChatGPT's **Pinned**, **Projects**, and **Chats** sidebar sections across reloads/reopens.
- Add a double-click shortcut on sidebar projects that invokes ChatGPT's existing native **Project home** menu action.
- Add a cross-device stale-chat guard: snapshot the authoritative conversation tail after idle/hidden periods, compare it when the user returns, and block/resync a normal send if its `parent_message_id` is no longer the server's current node. Preserve and restore unsent draft text across that safety refresh.
- Remove the obsolete **Long-chat optimizer** now that ChatGPT performs native conversation virtualization.
- Add a low-overhead **Native hang recorder** focused on ChatGPT/tool-call UI freezes. It records long animation frames/event-loop stalls plus coarse memory/DOM/UI counts locally, and Chromium uses an extension service worker to detect when the page stops heartbeating. The recorder intentionally remains active when BetterChatGPT's Master enable is off so native-vs-extension A/B testing is possible.
