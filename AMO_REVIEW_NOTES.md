# Mozilla Add-ons reviewer notes

BetterChatGPT is a local browser extension for `chatgpt.com` / `chat.openai.com`.

## Firefox build

The Firefox package is generated from the committed `chromium/` runtime by:

```bash
node tools/build-firefox.mjs
npx --yes web-ext@10 lint --source-dir build/firefox-src
npx --yes web-ext@10 build --source-dir build/firefox-src --artifacts-dir build/firefox --overwrite-dest
```

The transform only changes Firefox-specific manifest metadata:

- replaces the Chromium MV3 `background.service_worker` declaration with Firefox MV3 `background.scripts`;
- adds the stable Gecko ID `better-chatgpt@marcmy.github.io`;
- declares `data_collection_permissions.required = ["none"]`;
- sets Firefox minimum version 140.

No JavaScript is minified, obfuscated, downloaded, or generated from remote code.

## Network behavior

BetterChatGPT does not operate a developer backend and does not send telemetry or analytics to the developer.

The page-world bridge observes and, for specific extension features, interacts with ChatGPT's own same-origin requests. In particular, the cross-device stale-chat guard performs same-origin requests to ChatGPT/OpenAI endpoints to compare the current conversation node after the tab has been idle. It retains only the conversation ID/current-node/update-time metadata required for the freshness check. Authentication remains between the user's browser session and ChatGPT/OpenAI.

The edited-message attachment helper also observes ChatGPT's native same-origin attachment/library metadata so it can reuse ChatGPT's existing upload and Library mechanisms. It does not upload files to an extension-controlled service.

## Diagnostics and privacy

The native hang recorder stores local performance/timing metadata and coarse counts such as DOM nodes, message turns, code blocks, iframes, and tool surfaces. It intentionally does not record prompt text, tool-result text, filenames, cookies, access tokens, or conversation contents. Diagnostics remain local unless the user explicitly copies them.

See `PRIVACY.md` for the user-facing privacy description.
