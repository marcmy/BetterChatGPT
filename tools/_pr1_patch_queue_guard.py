from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# --- queued send: attachment upload only ---
p = Path("chromium/content.js")
text = p.read_text(encoding="utf-8")

old = '''      function attachmentTransactionActive() {
        const activeUpload = hasActiveNativeUpload();
        const uploadHintWhileSettling = hasNativePayloadIntent() && (activeUpload || isNativeComposerBusy());
        const liveFollowUpPreview = isAssistantGenerating() && hasVisibleAttachmentPreview();

        return Boolean(
          activeUpload ||
          uploadHintWhileSettling ||
          liveFollowUpPreview ||
          queuedComposerFiles.length > 0
        );
      }

      function shouldInterceptSendGesture() {
        if (!queueFeatureEnabled() || internalQueuedSendClick) return false;
        if (!probablyHasSomethingToSend()) return false;
        return queued || attachmentTransactionActive() || !canSendNow();
      }
'''
new = '''      function attachmentTransactionActive() {
        const activeUpload = hasActiveNativeUpload();
        const uploadHintWhileSettling = hasNativePayloadIntent() && isNativeComposerBusy();
        return Boolean(activeUpload || uploadHintWhileSettling);
      }

      function relinquishQueueToNativeSend() {
        if (!queued) return;
        clearQueuedSendAttempt();
        internalQueuedSendClick = false;
        if (queuedBridgeNonce) {
          try {
            followUpBridge()?.clearSubmit?.(queuedBridgeNonce);
          } catch (error) {
            log("failed to disarm queued follow-up bridge during native handoff", error);
          }
          queuedBridgeNonce = "";
        }
        queued = false;
        queuedAt = 0;
        clearMonitor();
        clearNativePayloadHint();
        clearQueuedComposerFiles();
        if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
        else clearSendProxy();
        globalThis.BetterChatGPT?.recordTrace?.("queue-native-send-handoff", {});
        log("queue relinquished to native Send");
      }

      function shouldInterceptSendGesture() {
        if (!queueFeatureEnabled() || internalQueuedSendClick) return false;
        if (!probablyHasSomethingToSend()) return false;
        if (attachmentTransactionActive()) return true;
        // Queueing exists only to bridge an attachment upload. Once no upload is
        // active, ChatGPT owns the send gesture completely—even during generation.
        if (queued) relinquishQueueToNativeSend();
        return false;
      }
'''
text = replace_once(text, old, new, "attachment-only queue predicate")

old = '''      function queueSend(source) {
        if (!queueFeatureEnabled()) return false;
        if (!probablyHasSomethingToSend()) {
'''
new = '''      function queueSend(source) {
        if (!queueFeatureEnabled()) return false;
        if (!attachmentTransactionActive()) {
          if (queued) relinquishQueueToNativeSend();
          scheduleCheck();
          return false;
        }
        if (!probablyHasSomethingToSend()) {
'''
text = replace_once(text, old, new, "queueSend upload gate")

old = '''        if (!queuedSendAttempt && canSendNow()) {
          sendNow();
        }
'''
new = '''        if (!queuedSendAttempt && !attachmentTransactionActive() && canSendNow()) {
          sendNow();
        }
'''
text = replace_once(text, old, new, "queued release waits for upload completion")

old = '''          guardToolSurfaces: Number(guardStatus?.markedToolCount || 0),
          guardContainedTools: Number(guardStatus?.containedToolCount || 0),
'''
new = '''          guardToolSurfaces: Number(guardStatus?.markedToolCount || 0),
          guardObservedToolSurfaces: Number(guardStatus?.observedToolCount || 0),
          guardContainedTools: Number(guardStatus?.containedToolCount || 0),
'''
text = replace_once(text, old, new, "guard observed tool heartbeat")
p.write_text(text, encoding="utf-8")


# --- guard: align pressure trigger with recorder + settle-driven rehydration ---
p = Path("chromium/performance-guard.js")
guard = p.read_text(encoding="utf-8")
guard = replace_once(
    guard,
    "  const REHYDRATE_WINDOW_MS = 3000;\n  const HEAVY_RELEASE_GRACE_MS = 2000;\n",
    "  const REHYDRATE_WINDOW_MS = 3000;\n  const REHYDRATE_MUTATION_EXTEND_MS = 1800;\n  const REHYDRATE_MAX_MS = 15000;\n  const HEAVY_RELEASE_GRACE_MS = 2000;\n",
    "rehydration settle constants",
)
guard = replace_once(
    guard,
    "  const TURN_SELECTOR = 'article[data-testid^=\"conversation-turn\"]';\n",
    "  const TURN_SELECTOR = ':is(article[data-testid^=\"conversation-turn\"], [data-message-author-role])';\n",
    "broader conversation turn selector",
)
guard = replace_once(
    guard,
    '  let rehydrateUntil = 0;\n  let rehydrateReason = "";\n',
    '  let rehydrateUntil = 0;\n  let rehydrateStartedAt = 0;\n  let rehydrateReason = "";\n',
    "rehydration start state",
)
guard = replace_once(
    guard,
    "  let markedToolCount = 0;\n  let containedToolCount = 0;\n",
    "  let markedToolCount = 0;\n  let observedToolCount = 0;\n  let containedToolCount = 0;\n",
    "observed tool state",
)

old = '''  function finishRehydrate() {
    if (!active || rehydrateUntil === Number.POSITIVE_INFINITY) return;
    if (performance.now() < rehydrateUntil) return;
    rehydrateUntil = 0;
    document.documentElement.removeAttribute(ROOT_REHYDRATE_ATTR);
    refreshState();
    BCG.recordTrace?.("native-tool-freeze-guard-rehydrate-done", {
      reason: rehydrateReason,
      toolSurfaces: trackedTools.size,
      containedTools: containedToolCount,
      skippedTools: skippedToolCount,
      skippedTurns: skippedTurnCount,
    });
  }

  function enterRehydrate(reason, { holdWhileHidden = false } = {}) {
    if (!active) return;
    const wasRehydrating = isRehydrating();
    rehydrateReason = String(reason || "resume");
    window.clearTimeout(rehydrateTimer);
    rehydrateTimer = 0;
    rehydrateUntil = holdWhileHidden ? Number.POSITIVE_INFINITY : performance.now() + REHYDRATE_WINDOW_MS;
    document.documentElement.setAttribute(ROOT_REHYDRATE_ATTR, "1");
    if (!holdWhileHidden) {
      rehydrateTimer = window.setTimeout(finishRehydrate, REHYDRATE_WINDOW_MS + 50);
    }
    if (!wasRehydrating) {
      BCG.recordTrace?.("native-tool-freeze-guard-rehydrate", {
        reason: rehydrateReason,
        windowMs: holdWhileHidden ? null : REHYDRATE_WINDOW_MS,
        toolSurfaces: trackedTools.size,
      });
    }
  }
'''
new = '''  function scheduleRehydrateFinish() {
    window.clearTimeout(rehydrateTimer);
    rehydrateTimer = 0;
    if (!active || !Number.isFinite(rehydrateUntil) || rehydrateUntil <= 0) return;
    rehydrateTimer = window.setTimeout(
      finishRehydrate,
      Math.max(50, Math.round(rehydrateUntil - performance.now()) + 50),
    );
  }

  function finishRehydrate() {
    if (!active || rehydrateUntil === Number.POSITIVE_INFINITY) return;
    if (performance.now() < rehydrateUntil) {
      scheduleRehydrateFinish();
      return;
    }
    rehydrateUntil = 0;
    rehydrateStartedAt = 0;
    document.documentElement.removeAttribute(ROOT_REHYDRATE_ATTR);
    refreshState();
    BCG.recordTrace?.("native-tool-freeze-guard-rehydrate-done", {
      reason: rehydrateReason,
      toolSurfaces: trackedTools.size,
      observedToolSurfaces: observedToolCount,
      containedTools: containedToolCount,
      skippedTools: skippedToolCount,
      skippedTurns: skippedTurnCount,
    });
  }

  function extendRehydrateForMutation() {
    if (!isRehydrating() || !Number.isFinite(rehydrateUntil) || !rehydrateStartedAt) return;
    const now = performance.now();
    const maxUntil = rehydrateStartedAt + REHYDRATE_MAX_MS;
    const nextUntil = Math.min(maxUntil, now + REHYDRATE_MUTATION_EXTEND_MS);
    if (nextUntil <= rehydrateUntil) return;
    rehydrateUntil = nextUntil;
    scheduleRehydrateFinish();
  }

  function enterRehydrate(reason, { holdWhileHidden = false } = {}) {
    if (!active) return;
    const wasRehydrating = isRehydrating();
    const now = performance.now();
    rehydrateReason = String(reason || "resume");
    window.clearTimeout(rehydrateTimer);
    rehydrateTimer = 0;
    rehydrateStartedAt = now;
    rehydrateUntil = holdWhileHidden ? Number.POSITIVE_INFINITY : now + REHYDRATE_WINDOW_MS;
    document.documentElement.setAttribute(ROOT_REHYDRATE_ATTR, "1");
    if (!holdWhileHidden) scheduleRehydrateFinish();
    if (!wasRehydrating) {
      BCG.recordTrace?.("native-tool-freeze-guard-rehydrate", {
        reason: rehydrateReason,
        windowMs: holdWhileHidden ? null : REHYDRATE_WINDOW_MS,
        maxWindowMs: holdWhileHidden ? null : REHYDRATE_MAX_MS,
        toolSurfaces: trackedTools.size,
      });
    }
  }
'''
guard = replace_once(guard, old, new, "settle-driven rehydration lifecycle")

old = '''      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TURN_SKIP_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TOOL_CONTAIN_CLASS} {
'''
new = '''      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TURN_SKIP_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] ${TURN_SELECTOR} :is(
        [data-testid*="tool" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="connector" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="mcp" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="work" i]:not(button):not(a):not(input):not(textarea):not(select),
        iframe[src*="mcp" i],
        iframe[title*="tool" i]
      ) {
        contain: layout;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TOOL_CONTAIN_CLASS} {
'''
guard = replace_once(guard, old, new, "direct heavy tool containment")

old = '''    markedToolCount = trackedTools.size;
    const now = performance.now();
    const rehydrateGrace = Number.isFinite(rehydrateUntil) && now < rehydrateUntil + HEAVY_RELEASE_GRACE_MS;
    const nextHeavy = markedToolCount >= HEAVY_TOOL_THRESHOLD
      && (generationActive() || isRehydrating() || rehydrateGrace);
'''
new = '''    markedToolCount = trackedTools.size;
    try {
      // Deliberately identical to the Native hang recorder's broad marker count.
      // This is the pressure signal; actual containment remains message-scoped.
      observedToolCount = document.querySelectorAll(TOOL_SELECTOR).length;
    } catch {
      observedToolCount = markedToolCount;
    }
    const toolPressureCount = Math.max(markedToolCount, observedToolCount);
    const now = performance.now();
    const rehydrateGrace = Number.isFinite(rehydrateUntil) && now < rehydrateUntil + HEAVY_RELEASE_GRACE_MS;
    const nextHeavy = toolPressureCount >= HEAVY_TOOL_THRESHOLD
      && (generationActive() || isRehydrating() || rehydrateGrace);
'''
guard = replace_once(guard, old, new, "recorder-aligned pressure trigger")
guard = replace_once(
    guard,
    '        toolSurfaces: markedToolCount,\n        toolSurfaceLabels: heavy ? toolSurfaceLabels() : [],\n',
    '        toolSurfaces: markedToolCount,\n        observedToolSurfaces: observedToolCount,\n        toolSurfaceLabels: heavy ? toolSurfaceLabels() : [],\n',
    "heavy trace observed count",
)
guard = replace_once(
    guard,
    '        for (const node of record.addedNodes) if (node instanceof Element) enqueueRoot(node);\n      }\n      if (changed) scheduleScan();\n',
    '        for (const node of record.addedNodes) if (node instanceof Element) enqueueRoot(node);\n      }\n      if (changed) {\n        extendRehydrateForMutation();\n        scheduleScan();\n      }\n',
    "mutation extends rehydration",
)
guard = replace_once(
    guard,
    '    rehydrateUntil = 0;\n    rehydrateReason = "";\n',
    '    rehydrateUntil = 0;\n    rehydrateStartedAt = 0;\n    rehydrateReason = "";\n',
    "stop clears rehydration start",
)
guard = replace_once(
    guard,
    "    markedToolCount = 0;\n    containedToolCount = 0;\n",
    "    markedToolCount = 0;\n    observedToolCount = 0;\n    containedToolCount = 0;\n",
    "stop clears observed tools",
)
guard = replace_once(
    guard,
    "        markedToolCount: trackedTools.size,\n        containedToolCount,\n",
    "        markedToolCount: trackedTools.size,\n        observedToolCount,\n        containedToolCount,\n",
    "status observed tools",
)
p.write_text(guard, encoding="utf-8")


p = Path("chromium/performance-background.js")
bg = p.read_text(encoding="utf-8")
bg = replace_once(
    bg,
    "    guardToolSurfaces: Number(payload.guardToolSurfaces || 0),\n    guardContainedTools: Number(payload.guardContainedTools || 0),\n",
    "    guardToolSurfaces: Number(payload.guardToolSurfaces || 0),\n    guardObservedToolSurfaces: Number(payload.guardObservedToolSurfaces || 0),\n    guardContainedTools: Number(payload.guardContainedTools || 0),\n",
    "background observed tool count",
)
p.write_text(bg, encoding="utf-8")


p = Path("tools/regression-check.mjs")
checks = p.read_text(encoding="utf-8")
anchor = 'requireText(content, \'if (hasActiveNativeUpload() || isNativeComposerBusy()) return false;\', "do not send during native upload");\n'
addition = anchor + '''requireText(content, 'return Boolean(activeUpload || uploadHintWhileSettling);', "queue is attachment-upload-only");
requireText(content, 'if (attachmentTransactionActive()) return true;', "only active attachment transaction intercepts send gesture");
requireText(content, 'if (queued) relinquishQueueToNativeSend();', "stale queue relinquishes to native send");
requireText(content, 'if (!attachmentTransactionActive()) {', "queueSend refuses non-upload queueing");
forbidText(content, 'return queued || attachmentTransactionActive() || !canSendNow();', "generation/native-disabled state cannot queue plain text");
forbidText(content, 'const liveFollowUpPreview = isAssistantGenerating() && hasVisibleAttachmentPreview();', "generation preview is not an upload transaction");
requireText(guard, 'observedToolCount = document.querySelectorAll(TOOL_SELECTOR).length;', "guard pressure uses recorder marker count");
requireText(guard, 'const toolPressureCount = Math.max(markedToolCount, observedToolCount);', "guard can engage before strict classifier");
requireText(guard, 'extendRehydrateForMutation();', "rehydration extends while DOM materializes");
requireText(guard, 'const REHYDRATE_MAX_MS = 15000;', "rehydration extension is bounded");
requireText(content, 'guardObservedToolSurfaces', "heartbeat exposes recorder-aligned guard pressure");
requireText(perfBackground, 'guardObservedToolSurfaces', "flight recorder retains guard pressure count");
'''
checks = replace_once(checks, anchor, addition, "queue and guard diagnostic regressions")
p.write_text(checks, encoding="utf-8")


p = Path("CHANGELOG.md")
changelog = p.read_text(encoding="utf-8")
marker = "## 1.1-pre.2 - 2026-08-29\n\n"
addition = marker + "- Correct **Queued Send** semantics: BetterChatGPT now queues only while a native attachment upload/settle transaction is active. Generation state, a disabled native Send button, a staged attachment preview, or a stale internal queued flag can no longer intercept a normal text/native send.\n- Align Native tool freeze guard pressure detection with the hang recorder's broad tool-marker count, and keep rehydration prewarm alive while the returning conversation DOM is still materializing (bounded to 15 seconds) instead of expiring on a fixed 3-second race.\n"
changelog = replace_once(changelog, marker, addition, "pre.2 queue/guard changelog")
p.write_text(changelog, encoding="utf-8")
