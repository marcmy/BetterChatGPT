(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG || globalThis.__bcgNativeToolFreezeGuard) return;

  const STYLE_ID = "bcg-native-tool-freeze-guard-style";
  const ROOT_ACTIVE_ATTR = "data-bcg-native-freeze-guard";
  const ROOT_HEAVY_ATTR = "data-bcg-native-freeze-guard-heavy";
  const ROOT_REHYDRATE_ATTR = "data-bcg-native-freeze-guard-rehydrate";
  const TURN_SKIP_CLASS = "bcg-native-freeze-guard-turn-skip";
  const TOOL_SKIP_CLASS = "bcg-native-freeze-guard-tool-skip";
  const TOOL_CONTAIN_CLASS = "bcg-native-freeze-guard-tool-contain";
  const HEAVY_TOOL_THRESHOLD = 4;
  const PROTECTED_TAIL_TURNS = 3;
  const SCAN_DELAY_MS = 100;
  const REHYDRATE_WINDOW_MS = 3000;
  const HEAVY_RELEASE_GRACE_MS = 2000;
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
  let nearViewport = new WeakMap();
  const pendingRoots = new Set();

  let observer = null;
  let intersectionObserver = null;
  let scanTimer = 0;
  let rehydrateTimer = 0;
  let rehydrateUntil = 0;
  let rehydrateReason = "";
  let lastRouteKey = `${location.pathname}${location.search}`;
  let active = false;
  let heavy = false;
  let markedToolCount = 0;
  let containedToolCount = 0;
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

  function routeKey(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? `${parsed.pathname}${parsed.search}` : "";
    } catch {
      return "";
    }
  }

  function isRehydrating() {
    return active && (rehydrateUntil === Number.POSITIVE_INFINITY || performance.now() < rehydrateUntil);
  }

  function finishRehydrate() {
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

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_REHYDRATE_ATTR}="1"] ${TURN_SELECTOR} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_REHYDRATE_ATTR}="1"] ${TURN_SELECTOR} :is(
        [data-testid*="tool" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="connector" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="mcp" i]:not(button):not(a):not(input):not(textarea):not(select),
        [data-testid*="work" i]:not(button):not(a):not(input):not(textarea):not(select),
        iframe[src*="mcp" i],
        iframe[title*="tool" i]
      ) {
        contain: layout;
        content-visibility: auto;
        contain-intrinsic-size: auto 180px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TURN_SKIP_CLASS} {
        content-visibility: auto;
        contain-intrinsic-size: auto 720px;
      }

      html[${ROOT_ACTIVE_ATTR}="1"][${ROOT_HEAVY_ATTR}="1"] .${TOOL_CONTAIN_CLASS} {
        contain: layout;
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
    tool.classList?.remove(TOOL_CONTAIN_CLASS);
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
    if (!(element instanceof HTMLElement)) return false;
    if (!element.closest(TURN_SELECTOR)) return false;
    if (element.tagName === "IFRAME") return true;
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
    const warmup = isRehydrating();
    let nextSkippedTurns = 0;
    let nextContainedTools = 0;
    let nextSkippedTools = 0;

    for (const turn of Array.from(trackedTurns)) {
      if (!turn.isConnected) {
        trackedTurns.delete(turn);
        intersectionObserver?.unobserve(turn);
        continue;
      }
      const shouldVirtualize = warmup || nearViewport.get(turn) === false;
      const shouldSkip = active
        && heavy
        && shouldVirtualize
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
      const interactionProtected = active && heavy && isInteractionProtected(tool);
      const shouldContain = active && heavy && !interactionProtected;
      const shouldVirtualize = warmup || nearViewport.get(tool) === false;
      const shouldSkip = shouldContain && shouldVirtualize;
      tool.classList.toggle(TOOL_CONTAIN_CLASS, shouldContain);
      tool.classList.toggle(TOOL_SKIP_CLASS, shouldSkip);
      if (shouldContain) nextContainedTools += 1;
      if (shouldSkip) nextSkippedTools += 1;
    }

    skippedTurnCount = nextSkippedTurns;
    containedToolCount = nextContainedTools;
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
    const now = performance.now();
    const rehydrateGrace = Number.isFinite(rehydrateUntil) && now < rehydrateUntil + HEAVY_RELEASE_GRACE_MS;
    const nextHeavy = markedToolCount >= HEAVY_TOOL_THRESHOLD
      && (generationActive() || isRehydrating() || rehydrateGrace);
    const heavyChanged = heavy !== nextHeavy;
    if (heavyChanged) {
      heavy = nextHeavy;
      if (heavy) document.documentElement.setAttribute(ROOT_HEAVY_ATTR, "1");
      else document.documentElement.removeAttribute(ROOT_HEAVY_ATTR);
    }
    applyVisibilityPolicy();
    if (heavyChanged) {
      BCG.recordTrace?.(heavy ? "native-tool-freeze-guard-heavy" : "native-tool-freeze-guard-normal", {
        toolSurfaces: markedToolCount,
        toolSurfaceLabels: heavy ? toolSurfaceLabels() : [],
        containedTools: containedToolCount,
        skippedTools: skippedToolCount,
        skippedTurns: skippedTurnCount,
        rehydrating: isRehydrating(),
        rehydrateReason,
        generating: generationActive(),
      });
    }
  }

  function detectRouteChange(reason = "route") {
    const nextRouteKey = `${location.pathname}${location.search}`;
    if (nextRouteKey === lastRouteKey) return false;
    lastRouteKey = nextRouteKey;
    enterRehydrate(reason);
    return true;
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
    detectRouteChange("route-mutation");
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

  function handlePotentialConversationNavigation(event) {
    if (!active) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const next = routeKey(anchor.href);
    if (!next || next === lastRouteKey) return;
    enterRehydrate("link-navigation");
  }

  function installNavigationGuards() {
    document.addEventListener("pointerdown", handlePotentialConversationNavigation, true);
    document.addEventListener("click", handlePotentialConversationNavigation, true);
    window.addEventListener("popstate", () => {
      enterRehydrate("popstate");
      detectRouteChange("popstate");
    }, { passive: true });
    window.addEventListener("hashchange", () => enterRehydrate("hashchange"), { passive: true });
    try {
      globalThis.navigation?.addEventListener?.("navigate", (event) => {
        const destination = routeKey(event?.destination?.url || "");
        if (destination && destination !== lastRouteKey) enterRehydrate("navigation-api");
      });
    } catch {
      // Navigation API is optional; pointer/click/popstate + mutation fallback remain active.
    }
    document.addEventListener("visibilitychange", () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        enterRehydrate("hidden", { holdWhileHidden: true });
        return;
      }
      enterRehydrate("visible");
      scanRoot(document);
      refreshState();
    }, { passive: true });
  }

  function start() {
    if (active || !featureEnabled()) return;
    active = true;
    ensureStyle();
    document.documentElement.setAttribute(ROOT_ACTIVE_ATTR, "1");
    enterRehydrate("startup");
    startObserver();
    scanRoot(document);
    refreshState();
    BCG.recordTrace?.("native-tool-freeze-guard-started", {
      heavyToolThreshold: HEAVY_TOOL_THRESHOLD,
      nearViewportMarginPx: NEAR_VIEWPORT_MARGIN_PX,
      rehydrateWindowMs: REHYDRATE_WINDOW_MS,
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
    window.clearTimeout(rehydrateTimer);
    scanTimer = 0;
    rehydrateTimer = 0;
    rehydrateUntil = 0;
    rehydrateReason = "";
    pendingRoots.clear();
    heavy = false;
    markedToolCount = 0;
    containedToolCount = 0;
    skippedToolCount = 0;
    skippedTurnCount = 0;
    document.documentElement.removeAttribute(ROOT_ACTIVE_ATTR);
    document.documentElement.removeAttribute(ROOT_HEAVY_ATTR);
    document.documentElement.removeAttribute(ROOT_REHYDRATE_ATTR);
    for (const turn of trackedTurns) turn.classList?.remove(TURN_SKIP_CLASS);
    for (const tool of trackedTools) {
      tool.classList?.remove(TOOL_SKIP_CLASS);
      tool.classList?.remove(TOOL_CONTAIN_CLASS);
    }
    trackedTurns.clear();
    turnOrder.length = 0;
    trackedTools.clear();
    nearViewport = new WeakMap();
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

  installNavigationGuards();
  window.addEventListener("bcg:settings-changed", syncEnabledState);
  window.addEventListener("pageshow", () => {
    syncEnabledState();
    if (active) {
      enterRehydrate("pageshow");
      scanRoot(document);
      refreshState();
    }
  }, { passive: true });

  const api = {
    status() {
      const remaining = isRehydrating() && Number.isFinite(rehydrateUntil)
        ? Math.max(0, Math.round(rehydrateUntil - performance.now()))
        : null;
      return {
        active,
        heavy,
        rehydrating: isRehydrating(),
        rehydrateReason,
        rehydrateRemainingMs: remaining,
        markedToolCount: trackedTools.size,
        containedToolCount,
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
        enterRehydrate("manual-rescan");
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
