(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG || globalThis.__bcgNativeToolFreezeGuard) return;

  const STYLE_ID = "bcg-native-tool-freeze-guard-style";
  const ROOT_ACTIVE_ATTR = "data-bcg-native-freeze-guard";
  const ROOT_HEAVY_ATTR = "data-bcg-native-freeze-guard-heavy";
  const TURN_CLASS = "bcg-native-freeze-guard-turn";
  const TOOL_CLASS = "bcg-native-freeze-guard-tool";
  const HEAVY_TOOL_THRESHOLD = 4;
  const SCAN_DELAY_MS = 120;

  const TURN_SELECTOR = 'article[data-testid^="conversation-turn"]';
  const FALLBACK_TURN_SELECTOR = '[data-message-author-role]';
  const TOOL_SELECTOR = [
    '[data-testid*="tool" i]',
    '[data-testid*="connector" i]',
    '[data-testid*="mcp" i]',
    '[data-testid*="work" i]',
    'iframe[src*="mcp" i]',
    'iframe[title*="tool" i]',
  ].join(",");

  const NON_SURFACE_TESTID = /(?:button|trigger|menu|icon|badge|status|label|toggle|header|footer|action|chevron|spinner)/i;
  const NON_SURFACE_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "OPTION", "SVG", "PATH"]);

  let observer = null;
  let scanTimer = 0;
  let active = false;
  let heavy = false;
  let markedToolCount = 0;

  function featureEnabled() {
    return Boolean(BCG.settings?.enabled) && !Boolean(BCG.isTabDisabled?.());
  }

  function generationActive() {
    return Boolean(document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label="Stop"]',
    ));
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT_ACTIVE_ATTR}="1"] .${TURN_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"] .${TOOL_CLASS} {
        contain: layout style;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TOOL_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 180px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function markTurns(root = document) {
    const primary = [];
    if (root instanceof Element && root.matches(TURN_SELECTOR)) primary.push(root);
    primary.push(...root.querySelectorAll?.(TURN_SELECTOR) || []);

    if (primary.length) {
      for (const turn of primary) turn.classList.add(TURN_CLASS);
      return primary.length;
    }

    const fallback = [];
    if (root instanceof Element && root.matches(FALLBACK_TURN_SELECTOR)) fallback.push(root);
    fallback.push(...root.querySelectorAll?.(FALLBACK_TURN_SELECTOR) || []);
    for (const turn of fallback) turn.classList.add(TURN_CLASS);
    return fallback.length;
  }

  function looksLikeToolSurface(element) {
    if (!(element instanceof Element)) return false;
    if (element.tagName === "IFRAME") return true;
    if (!(element instanceof HTMLElement)) return false;
    if (NON_SURFACE_TAGS.has(element.tagName)) return false;

    const testId = String(element.getAttribute("data-testid") || "");
    if (NON_SURFACE_TESTID.test(testId)) return false;

    if (element.children.length >= 2) return true;
    return Boolean(element.querySelector("iframe, pre, code, button, [role=button], [role=region], [aria-expanded]"));
  }

  function candidateTools(root = document) {
    const candidates = [];
    if (root instanceof Element && root.matches(TOOL_SELECTOR)) candidates.push(root);
    candidates.push(...root.querySelectorAll?.(TOOL_SELECTOR) || []);
    return candidates.filter(looksLikeToolSurface);
  }

  function markTools(root = document) {
    const candidates = candidateTools(root);
    if (!candidates.length) return 0;

    const candidateSet = new Set(candidates);
    let marked = 0;

    for (const candidate of candidates) {
      if (candidate.tagName !== "IFRAME") {
        let hasQualifiedChild = false;
        for (const child of candidate.querySelectorAll(TOOL_SELECTOR)) {
          if (child !== candidate && candidateSet.has(child)) {
            hasQualifiedChild = true;
            break;
          }
        }
        if (hasQualifiedChild) continue;
      }

      if (!candidate.classList.contains(TOOL_CLASS)) marked += 1;
      candidate.classList.add(TOOL_CLASS);
    }

    return marked;
  }

  function countMarkedTools() {
    return document.getElementsByClassName(TOOL_CLASS).length;
  }

  function toolSurfaceLabels() {
    const labels = new Set();
    for (const element of document.getElementsByClassName(TOOL_CLASS)) {
      const testId = String(element.getAttribute?.("data-testid") || "").trim();
      if (testId) labels.add(testId.slice(0, 100));
      else if (element.tagName === "IFRAME") labels.add("iframe");
      else labels.add(String(element.tagName || "element").toLowerCase());
      if (labels.size >= 12) break;
    }
    return Array.from(labels);
  }

  function setHeavy(nextHeavy, toolCount) {
    if (heavy === nextHeavy) return;
    heavy = nextHeavy;
    document.documentElement.toggleAttribute(ROOT_HEAVY_ATTR, heavy);
    BCG.recordTrace?.(heavy ? "native-tool-freeze-guard-heavy" : "native-tool-freeze-guard-normal", {
      toolSurfaces: toolCount,
      toolSurfaceLabels: heavy ? toolSurfaceLabels() : [],
      generating: generationActive(),
    });
  }

  function refreshState() {
    if (!active) return;
    const toolCount = countMarkedTools();
    markedToolCount = toolCount;
    setHeavy(generationActive() && toolCount >= HEAVY_TOOL_THRESHOLD, toolCount);
  }

  function scan(root = document) {
    if (!active) return;
    markTurns(root);
    markTools(root);
    refreshState();
  }

  function scheduleScan(root = document) {
    if (!active || scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan(root);
    }, SCAN_DELAY_MS);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      if (!records.some((record) => record.type === "childList" && record.addedNodes.length)) return;
      // Scan the accumulated DOM once per burst. This is more reliable than
      // choosing one added subtree when React commits several tool surfaces at once.
      scheduleScan(document);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    if (active || !featureEnabled()) return;
    active = true;
    ensureStyle();
    document.documentElement.setAttribute(ROOT_ACTIVE_ATTR, "1");
    startObserver();
    scan(document);
    BCG.recordTrace?.("native-tool-freeze-guard-started", {
      heavyToolThreshold: HEAVY_TOOL_THRESHOLD,
      toolSurfaces: markedToolCount,
    });
  }

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    window.clearTimeout(scanTimer);
    scanTimer = 0;
    heavy = false;
    markedToolCount = 0;
    document.documentElement.removeAttribute(ROOT_ACTIVE_ATTR);
    document.documentElement.removeAttribute(ROOT_HEAVY_ATTR);
    BCG.recordTrace?.("native-tool-freeze-guard-stopped", {});
  }

  function syncEnabledState() {
    if (featureEnabled()) start();
    else stop();
  }

  window.addEventListener("bcg:settings-changed", syncEnabledState);
  window.addEventListener("pageshow", () => {
    syncEnabledState();
    scheduleScan(document);
  }, { passive: true });

  const api = {
    status() {
      return {
        active,
        heavy,
        markedToolCount: countMarkedTools(),
        threshold: HEAVY_TOOL_THRESHOLD,
        toolSurfaceLabels: toolSurfaceLabels(),
      };
    },
    rescan() {
      scan(document);
      return this.status();
    },
    stop,
    start,
  };

  globalThis.__bcgNativeToolFreezeGuard = api;
  BCG.nativeToolFreezeGuard = api;
  syncEnabledState();
})();
