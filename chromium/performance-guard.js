(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG || globalThis.__bcgNativeToolFreezeGuard) return;

  const STYLE_ID = "bcg-native-tool-freeze-guard-style";
  const ROOT_ACTIVE_ATTR = "data-bcg-native-freeze-guard";
  const ROOT_HEAVY_ATTR = "data-bcg-native-freeze-guard-heavy";
  const TURN_SKIP_CLASS = "bcg-native-freeze-guard-turn-skip";
  const TOOL_SKIP_CLASS = "bcg-native-freeze-guard-tool-skip";
  const HEAVY_TOOL_THRESHOLD = 4;
  const PROTECTED_TAIL_TURNS = 3;
  const SCAN_DELAY_MS = 100;
  const NEAR_VIEWPORT_MARGIN_PX = 1600;

  const TURN_SELECTOR = 'article[data-testid^="conversation-turn"]';
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

  const trackedTurns = new Set();
  const turnOrder = [];
  const trackedTools = new Set();
  const nearViewport = new WeakMap();
  const pendingRoots = new Set();

  let observer = null;
  let intersectionObserver = null;
  let scanTimer = 0;
  let active = false;
  let heavy = false;
  let markedToolCount = 0;
  let skippedToolCount = 0;
  let skippedTurnCount = 0;

  function featureEnabled() {
    return Boolean(BCG.settings?.enabled)
      && Boolean(BCG.settings?.advanced?.nativeToolFreezeGuard)
      && !Boolean(BCG.isTabDisabled?.());
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
      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TURN_SKIP_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TOOL_SKIP_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 180px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getIntersectionObserver() {
    if (intersectionObserver) return intersectionObserver;
    intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) nearViewport.set(entry.target, entry.isIntersecting);
      applyVisibilityPolicy();
    }, {
      root: null,
      rootMargin: `${NEAR_VIEWPORT_MARGIN_PX}px 0px ${NEAR_VIEWPORT_MARGIN_PX}px 0px`,
      threshold: 0,
    });
    return intersectionObserver;
  }

  function trackTurn(turn) {
    if (!(turn instanceof HTMLElement) || trackedTurns.has(turn)) return;
    trackedTurns.add(turn);
    turnOrder.push(turn);
    nearViewport.set(turn, true);
    getIntersectionObserver().observe(turn);
  }

  function untrackTool(tool) {
    if (!trackedTools.delete(tool)) return;
    intersectionObserver?.unobserve(tool);
    tool.classList?.remove(TOOL_SKIP_CLASS);
  }

  function trackTool(tool) {
    if (!(tool instanceof Element) || trackedTools.has(tool)) return;
    for (const existing of Array.from(trackedTools)) {
      if (!existing.isConnected) {
        untrackTool(existing);
        continue;
      }
      if (existing.contains(tool)) untrackTool(existing);
      else if (tool.contains(existing)) return;
    }
    trackedTools.add(tool);
    nearViewport.set(tool, true);
    getIntersectionObserver().observe(tool);
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

  function scanRoot(root) {
    if (!(root instanceof Document || root instanceof Element)) return;

    if (root instanceof Element && root.matches(TURN_SELECTOR)) trackTurn(root);
    for (const turn of root.querySelectorAll?.(TURN_SELECTOR) || []) trackTurn(turn);

    const candidates = [];
    if (root instanceof Element && root.matches(TOOL_SELECTOR)) candidates.push(root);
    candidates.push(...root.querySelectorAll?.(TOOL_SELECTOR) || []);
    const qualified = candidates.filter(looksLikeToolSurface);
    const qualifiedSet = new Set(qualified);
    for (const candidate of qualified) {
      let hasQualifiedChild = false;
      if (candidate.tagName !== "IFRAME") {
        for (const child of candidate.querySelectorAll(TOOL_SELECTOR)) {
          if (child !== candidate && qualifiedSet.has(child)) {
            hasQualifiedChild = true;
            break;
          }
        }
      }
      if (!hasQualifiedChild) trackTool(candidate);
    }
  }

  function isInteractionProtected(element) {
    const focused = document.activeElement;
    if (focused instanceof Node && element.contains(focused)) return true;
    const selection = window.getSelection?.();
    if (selection?.anchorNode && !selection.isCollapsed && element.contains(selection.anchorNode)) return true;
    try {
      return Boolean(element.querySelector(
        '[aria-expanded="true"], [data-state="open"], [role="dialog"], [role="menu"], [popover]:popover-open',
      ));
    } catch {
      return Boolean(element.querySelector('[aria-expanded="true"], [data-state="open"], [role="dialog"], [role="menu"]'));
    }
  }

  function protectedTailSet() {
    const connected = [];
    for (let i = turnOrder.length - 1; i >= 0 && connected.length < PROTECTED_TAIL_TURNS; i -= 1) {
      const turn = turnOrder[i];
      if (turn?.isConnected) connected.push(turn);
    }
    return new Set(connected);
  }

  function applyVisibilityPolicy() {
    const protectedTail = protectedTailSet();
    let nextSkippedTurns = 0;
    let nextSkippedTools = 0;

    for (const turn of Array.from(trackedTurns)) {
      if (!turn.isConnected) {
        trackedTurns.delete(turn);
        intersectionObserver?.unobserve(turn);
        continue;
      }
      const shouldSkip = active
        && heavy
        && nearViewport.get(turn) === false
        && !protectedTail.has(turn)
        && !isInteractionProtected(turn);
      turn.classList.toggle(TURN_SKIP_CLASS, shouldSkip);
      if (shouldSkip) nextSkippedTurns += 1;
    }

    for (const tool of Array.from(trackedTools)) {
      if (!tool.isConnected) {
        untrackTool(tool);
        continue;
      }
      const shouldSkip = active
        && heavy
        && nearViewport.get(tool) === false
        && !isInteractionProtected(tool);
      tool.classList.toggle(TOOL_SKIP_CLASS, shouldSkip);
      if (shouldSkip) nextSkippedTools += 1;
    }

    skippedTurnCount = nextSkippedTurns;
    skippedToolCount = nextSkippedTools;
  }

  function toolSurfaceLabels() {
    const labels = new Set();
    for (const element of trackedTools) {
      if (!element.isConnected) continue;
      const testId = String(element.getAttribute?.("data-testid") || "").trim();
      if (testId) labels.add(testId.slice(0, 100));
      else if (element.tagName === "IFRAME") labels.add("iframe");
      else labels.add(String(element.tagName || "element").toLowerCase());
      if (labels.size >= 12) break;
    }
    return Array.from(labels);
  }

  function refreshState() {
    if (!active) return;
    for (const tool of Array.from(trackedTools)) if (!tool.isConnected) untrackTool(tool);
    markedToolCount = trackedTools.size;
    const nextHeavy = generationActive() && markedToolCount >= HEAVY_TOOL_THRESHOLD;
    if (heavy !== nextHeavy) {
      heavy = nextHeavy;
      document.documentElement.toggleAttribute(ROOT_HEAVY_ATTR, heavy);
      BCG.recordTrace?.(heavy ? "native-tool-freeze-guard-heavy" : "native-tool-freeze-guard-normal", {
        toolSurfaces: markedToolCount,
        toolSurfaceLabels: heavy ? toolSurfaceLabels() : [],
        skippedTools: skippedToolCount,
        skippedTurns: skippedTurnCount,
        generating: generationActive(),
      });
    }
    applyVisibilityPolicy();
  }

  function enqueueRoot(root) {
    if (!(root instanceof Element)) return;
    for (const existing of Array.from(pendingRoots)) {
      if (existing.contains(root)) return;
      if (root.contains(existing)) pendingRoots.delete(existing);
    }
    pendingRoots.add(root);
  }

  function runScheduledScan() {
    scanTimer = 0;
    if (!active) return;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    for (const root of roots) scanRoot(root);
    refreshState();
  }

  function scheduleScan() {
    if (!active || scanTimer) return;
    scanTimer = window.setTimeout(runScheduledScan, SCAN_DELAY_MS);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      let changed = false;
      for (const record of records) {
        if (record.type !== "childList") continue;
        if (record.addedNodes.length || record.removedNodes.length) changed = true;
        for (const node of record.addedNodes) if (node instanceof Element) enqueueRoot(node);
      }
      if (changed) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    if (active || !featureEnabled()) return;
    active = true;
    ensureStyle();
    document.documentElement.setAttribute(ROOT_ACTIVE_ATTR, "1");
    startObserver();
    scanRoot(document);
    refreshState();
    BCG.recordTrace?.("native-tool-freeze-guard-started", {
      heavyToolThreshold: HEAVY_TOOL_THRESHOLD,
      nearViewportMarginPx: NEAR_VIEWPORT_MARGIN_PX,
      toolSurfaces: markedToolCount,
    });
  }

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    window.clearTimeout(scanTimer);
    scanTimer = 0;
    pendingRoots.clear();
    heavy = false;
    markedToolCount = trackedTools.size;
    skippedToolCount = 0;
    skippedTurnCount = 0;
    document.documentElement.removeAttribute(ROOT_ACTIVE_ATTR);
    document.documentElement.removeAttribute(ROOT_HEAVY_ATTR);
    for (const turn of trackedTurns) turn.classList?.remove(TURN_SKIP_CLASS);
    for (const tool of trackedTools) tool.classList?.remove(TOOL_SKIP_CLASS);
    BCG.recordTrace?.("native-tool-freeze-guard-stopped", {});
  }

  function syncEnabledState() {
    if (featureEnabled()) {
      start();
      refreshState();
    } else {
      stop();
    }
  }

  window.addEventListener("bcg:settings-changed", syncEnabledState);
  window.addEventListener("pageshow", () => {
    syncEnabledState();
    if (active) {
      scanRoot(document);
      refreshState();
    }
  }, { passive: true });

  const api = {
    status() {
      return {
        active,
        heavy,
        markedToolCount: trackedTools.size,
        skippedToolCount,
        skippedTurnCount,
        threshold: HEAVY_TOOL_THRESHOLD,
        nearViewportMarginPx: NEAR_VIEWPORT_MARGIN_PX,
        protectedTailTurns: PROTECTED_TAIL_TURNS,
        toolSurfaceLabels: toolSurfaceLabels(),
      };
    },
    rescan() {
      if (active) {
        scanRoot(document);
        refreshState();
      }
      return this.status();
    },
    stop,
    start,
  };

  globalThis.__bcgNativeToolFreezeGuard = api;
  BCG.nativeToolFreezeGuard = api;
  syncEnabledState();
})();
