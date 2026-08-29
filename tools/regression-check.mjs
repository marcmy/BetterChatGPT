import fs from "node:fs";

const content = fs.readFileSync("chromium/content.js", "utf8");
const bridge = fs.readFileSync("chromium/page-bridge.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("chromium/manifest.json", "utf8"));
const firefoxBuilder = fs.readFileSync("tools/build-firefox.mjs", "utf8");

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`Missing regression guard: ${label}`);
}
function forbidText(haystack, needle, label) {
  if (haystack.includes(needle)) throw new Error(`Forbidden regression detected: ${label}`);
}

if (manifest.version !== "1.1.2" || manifest.version_name !== "1.1-pre.2") {
  throw new Error(`Unexpected Chromium version metadata: ${manifest.version} / ${manifest.version_name}`);
}
requireText(content, 'const VERSION = "1.1-pre.2";', "runtime pre.2 version");
requireText(content, 'setManagedStyle(node, "color", "LinkText")', "user-bubble links stay blue");
requireText(content, 'node.closest(\'a[href], [role="link"]\')', "link descendants excluded from bubble text color");
requireText(content, 'return FIELD_BY_PATH.has(path) || path.startsWith("ui.");', "regular settings are live");
forbidText(content, 'Reload ChatGPT to apply every change.', "generic settings reload requirement");
forbidText(content, 'profile applied. Reload ChatGPT.', "profile reload requirement");

forbidText(content, 'if (globalThis.BetterChatGPT?.isFeatureEnabled("scrolling.enabled"))', "scrolling bootstrap gate");
forbidText(content, 'if (globalThis.BetterChatGPT?.isFeatureEnabled("composer.enabled"))', "composer bootstrap gate");
forbidText(content, 'if (!BCG?.isFeatureEnabled("editAttachments.enabled")) return;', "edit-attachment bootstrap gate");
requireText(content, 'win.addEventListener("bcg:settings-changed", syncRuntimeSettings);', "live scrolling settings listener");
requireText(content, 'const queueFeatureEnabled = () => Boolean(globalThis.BetterChatGPT?.isFeatureEnabled?.("queue.enabled"));', "live queue switch");
requireText(content, 'for (const eventName of ["paste", "drop"])', "native paste/drop file observation");
requireText(content, '// Observe only. ChatGPT keeps full ownership of paste/drop and native upload.', "native upload ownership");
requireText(content, 'window.addEventListener("bcg:settings-changed", scheduleScan, { signal: dragCaptureController.signal });', "live edit attachments");
requireText(content, 'if (!globalThis.BetterChatGPT?.isFeatureEnabled?.("composer.enabled")) return;', "live composer handlers");
requireText(content, 'bcg:native-upload-count', "native upload completion tracking");
requireText(content, 'rememberQueuedComposerFiles', "queued attachment correlation");
requireText(content, 'if (hasActiveNativeUpload() || isNativeComposerBusy()) return false;', "do not send during native upload");

forbidText(bridge, '/file|library|mention|search/i', "generic search-response metadata parsing");
forbidText(bridge, '/file|upload|attachment|library|mention|search/i', "generic XHR search-response metadata parsing");
requireText(bridge, '/file|library|mention|attachment|upload/i', "attachment-only fetch metadata scope");

for (const removed of [
  "Live uploads while generating",
  "Focus composer",
  "Long-chat optimizer",
  "cgpt-lco-hibernated",
  "bcg:wake-all",
  "Wake all messages",
  "uploadFilesNowOrQueue",
  "guardLiveFileDrag",
  "liveFileDragOverlay",
  "__BCG_OPTIMIZER_SUSPENDED_UNTIL",
]) forbidText(content, removed, removed);

requireText(firefoxBuilder, 'delete manifest.version_name;', "Firefox strips Chromium version_name");
requireText(firefoxBuilder, 'strict_min_version: "142.0"', "Firefox metadata permission-compatible minimum");
console.log("BetterChatGPT pre.2 regression checks passed.");
