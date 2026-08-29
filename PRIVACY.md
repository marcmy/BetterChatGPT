# Privacy

Better ChatGPT runs locally in your browser.

- It does not send analytics, telemetry, prompts, conversations, files, or settings to the developer.
- It does not load remote JavaScript. The Markdown parser and sanitizer are packaged inside the extension/userscript.
- Extension access is limited to `chatgpt.com` and `chat.openai.com`.
- Settings are stored locally by default. Browser sync is optional, syncs only Better ChatGPT settings, and uses the browser's own extension-sync service. Enabling it reads an existing synced copy before uploading this device's settings.
- Diagnostic reports exclude prompt/message content and attachment names by design.
- The optional native hang recorder stores only local timing/count metadata such as long-frame duration, event-loop delay, coarse heap/DOM counts, visibility/generation state, and sanitized script-source labels. It does not record prompt text, tool output, filenames, request bodies, cookies, tokens, or conversation contents.
- Conversation Markdown exports are generated locally from the page and downloaded directly by the browser.

## Edited-message attachments

Edited-message attachment handling stays inside ChatGPT and the browser. Better ChatGPT temporarily uses ChatGPT's regular composer uploader or native `@` Library picker, observes the resulting local request metadata, and applies that metadata to the edited-message request. It does not send files or file metadata anywhere other than ChatGPT's own existing endpoints.

## Cross-device stale-chat protection

When enabled, Better ChatGPT makes read-only requests to ChatGPT's own authenticated session and conversation endpoints after this tab has been idle/hidden. It uses the returned current conversation node only to detect whether another device advanced the chat. Tokens and conversation contents are not logged, persisted by Better ChatGPT, or sent to the developer. If a stale parent is detected before sending, Better ChatGPT refreshes the page and temporarily stores only the unsent draft text in this tab's session storage so it can be restored after the refresh.
