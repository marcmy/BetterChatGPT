(() => {
  "use strict";

  if (globalThis.BetterChatGPT?.version) return;

  const VERSION = "1.1-pre.2";
  const STORAGE_KEY = "better-chatgpt:settings-v1";
  const SYNC_SCHEMA_VERSION = 1;
  const SYNC_WRITE_DELAY_MS = 450;
  const TAB_DISABLED_KEY = "better-chatgpt:disabled-this-tab";
  const STYLE_ID = "better-chatgpt-shell-style";
  const PANEL_ID = "better-chatgpt-settings-panel";
  const BUTTON_ID = "better-chatgpt-settings-button";
  const COMMAND_MENU_ID = "better-chatgpt-command-menu";
  const TOAST_ID = "better-chatgpt-toast";
  const EDIT_ATTACHMENTS_AVAILABLE = true;

  const DEFAULTS = Object.freeze({
    enabled: true,
    profile: "default",
    sync: false,
    ui: {
      launcherX: -1,
      launcherY: -1,
      launcherXRatio: -1,
      launcherYRatio: -1,
    },
    navigation: {
      persistSidebarSections: true,
      projectDoubleClickHome: true,
    },
    resilience: {
      crossDeviceGuard: true,
    },
    layout: {
      wideMode: true,
      conversationWidthPercent: 100,
      composerWidthPercent: 100,
    },
    appearance: {
      enabled: true,
      bubbleColor: "#4e2f88",
      accentColorEnabled: false,
      textColorMode: "auto",
      textColor: "#ffffff",
      opacity: 1,
      radiusPx: 20,
      pageColorsEnabled: false,
      pageBackgroundColor: "#191919",
      pageTextColor: "#ececf1",
      composerColorEnabled: false,
      composerColor: "#212121",
      sidebarColorEnabled: false,
      sidebarColor: "#000000",
      hideFooter: false,
      bottomVignette: true,
    },
    scrolling: {
      enabled: true,
      mode: "auto",
      armDistancePx: 600,
      stableMs: 1800,
      maxFollowMs: 12000,
      manualPauseMs: 2500,
      voiceLatchMs: 90000,
    },
    composer: {
      enabled: true,
    },
    queue: {
      enabled: true,
      maxQueueMs: 600000,
      visuallyEnableSend: true,
    },
    editAttachments: {
      enabled: true,
      paste: true,
      dragDrop: true,
      picker: true,
      maxFiles: 20,
      maxFileSizeMb: 512,
    },
    advanced: {
      debug: false,
      notifications: true,
      performanceHangRecorder: true,
      nativeToolFreezeGuard: true,
    },
  });

  const PROFILE_PATCHES = Object.freeze({
    default: {},
    minimal: {
      editAttachments: { enabled: false },
    },
  });

  const diagnostics = [];
  const bridgeTrace = [];
  let panel = null;
  let toastTimer = 0;
  let settings = loadLocalSettings();
  let syncReady = false;
  let syncWriteTimer = 0;
  let syncListenerInstalled = false;
  let syncStatus = settings.sync ? "starting" : "local-only";

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, patch) {
    const output = clone(base);
    if (!isPlainObject(patch)) return output;

    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(output, key)) continue;
      if (isPlainObject(output[key]) && isPlainObject(value)) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    }
    return output;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function normalizeColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
  }

  function validateSettings(input) {
    const merged = deepMerge(DEFAULTS, input);
    merged.enabled = Boolean(merged.enabled);
    merged.sync = Boolean(merged.sync);
    merged.profile = ["default", "minimal", "custom"].includes(merged.profile)
      ? merged.profile
      : "default";

    merged.ui.launcherX = Math.round(clampNumber(merged.ui.launcherX, -1, 10000, DEFAULTS.ui.launcherX));
    merged.ui.launcherY = Math.round(clampNumber(merged.ui.launcherY, -1, 10000, DEFAULTS.ui.launcherY));
    merged.ui.launcherXRatio = clampNumber(
      merged.ui.launcherXRatio,
      -1,
      1,
      DEFAULTS.ui.launcherXRatio,
    );
    merged.ui.launcherYRatio = clampNumber(
      merged.ui.launcherYRatio,
      -1,
      1,
      DEFAULTS.ui.launcherYRatio,
    );
    if (merged.ui.launcherXRatio < 0) merged.ui.launcherXRatio = -1;
    if (merged.ui.launcherYRatio < 0) merged.ui.launcherYRatio = -1;

    merged.navigation.persistSidebarSections = Boolean(merged.navigation.persistSidebarSections);
    merged.navigation.projectDoubleClickHome = Boolean(merged.navigation.projectDoubleClickHome);
    merged.resilience.crossDeviceGuard = Boolean(merged.resilience.crossDeviceGuard);

    merged.layout.wideMode = Boolean(merged.layout.wideMode);
    merged.layout.conversationWidthPercent = Math.round(
      clampNumber(merged.layout.conversationWidthPercent, 0, 100, DEFAULTS.layout.conversationWidthPercent),
    );
    merged.layout.composerWidthPercent = Math.round(
      clampNumber(merged.layout.composerWidthPercent, 0, 100, DEFAULTS.layout.composerWidthPercent),
    );

    merged.appearance.enabled = Boolean(merged.appearance.enabled);
    merged.appearance.bubbleColor = normalizeColor(merged.appearance.bubbleColor, DEFAULTS.appearance.bubbleColor);
    merged.appearance.accentColorEnabled = Boolean(merged.appearance.accentColorEnabled);
    merged.appearance.textColorMode = merged.appearance.textColorMode === "manual" ? "manual" : "auto";
    merged.appearance.textColor = normalizeColor(merged.appearance.textColor, DEFAULTS.appearance.textColor);
    merged.appearance.opacity = clampNumber(merged.appearance.opacity, 0.2, 1, DEFAULTS.appearance.opacity);
    merged.appearance.radiusPx = Math.round(
      clampNumber(merged.appearance.radiusPx, 0, 40, DEFAULTS.appearance.radiusPx),
    );
    merged.appearance.pageColorsEnabled = Boolean(merged.appearance.pageColorsEnabled);
    merged.appearance.pageBackgroundColor = normalizeColor(
      merged.appearance.pageBackgroundColor,
      DEFAULTS.appearance.pageBackgroundColor,
    );
    merged.appearance.pageTextColor = normalizeColor(
      merged.appearance.pageTextColor,
      DEFAULTS.appearance.pageTextColor,
    );
    merged.appearance.composerColorEnabled = Boolean(merged.appearance.composerColorEnabled);
    merged.appearance.composerColor = normalizeColor(
      merged.appearance.composerColor,
      DEFAULTS.appearance.composerColor,
    );
    merged.appearance.sidebarColorEnabled = Boolean(merged.appearance.sidebarColorEnabled);
    merged.appearance.sidebarColor = normalizeColor(
      merged.appearance.sidebarColor,
      DEFAULTS.appearance.sidebarColor,
    );
    merged.appearance.hideFooter = Boolean(merged.appearance.hideFooter);
    merged.appearance.bottomVignette = Boolean(merged.appearance.bottomVignette);

    merged.scrolling.enabled = Boolean(merged.scrolling.enabled);
    merged.scrolling.mode = ["auto", "voice", "text"].includes(merged.scrolling.mode)
      ? merged.scrolling.mode
      : "auto";
    merged.scrolling.armDistancePx = Math.round(
      clampNumber(merged.scrolling.armDistancePx, 50, 3000, DEFAULTS.scrolling.armDistancePx),
    );
    merged.scrolling.stableMs = Math.round(
      clampNumber(merged.scrolling.stableMs, 250, 10000, DEFAULTS.scrolling.stableMs),
    );
    merged.scrolling.maxFollowMs = Math.round(
      clampNumber(merged.scrolling.maxFollowMs, 1000, 60000, DEFAULTS.scrolling.maxFollowMs),
    );
    merged.scrolling.manualPauseMs = Math.round(
      clampNumber(merged.scrolling.manualPauseMs, 250, 30000, DEFAULTS.scrolling.manualPauseMs),
    );
    merged.scrolling.voiceLatchMs = Math.round(
      clampNumber(merged.scrolling.voiceLatchMs, 5000, 300000, DEFAULTS.scrolling.voiceLatchMs),
    );


    merged.composer.enabled = Boolean(merged.composer.enabled);


    merged.queue.enabled = Boolean(merged.queue.enabled);
    merged.queue.maxQueueMs = Math.round(
      clampNumber(merged.queue.maxQueueMs, 10000, 3600000, DEFAULTS.queue.maxQueueMs),
    );
    merged.queue.visuallyEnableSend = Boolean(merged.queue.visuallyEnableSend);

    merged.editAttachments.enabled = EDIT_ATTACHMENTS_AVAILABLE && Boolean(merged.editAttachments.enabled);
    merged.editAttachments.paste = Boolean(merged.editAttachments.paste);
    merged.editAttachments.dragDrop = Boolean(merged.editAttachments.dragDrop);
    merged.editAttachments.picker = Boolean(merged.editAttachments.picker);
    merged.editAttachments.maxFiles = Math.round(
      clampNumber(merged.editAttachments.maxFiles, 1, 100, DEFAULTS.editAttachments.maxFiles),
    );
    merged.editAttachments.maxFileSizeMb = Math.round(
      clampNumber(merged.editAttachments.maxFileSizeMb, 1, 2048, DEFAULTS.editAttachments.maxFileSizeMb),
    );
    merged.advanced.debug = Boolean(merged.advanced.debug);
    merged.advanced.notifications = Boolean(merged.advanced.notifications);
    merged.advanced.performanceHangRecorder = Boolean(merged.advanced.performanceHangRecorder);
    merged.advanced.nativeToolFreezeGuard = Boolean(merged.advanced.nativeToolFreezeGuard);
    return merged;
  }

  function loadLocalSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return validateSettings(raw ? JSON.parse(raw) : DEFAULTS);
    } catch (error) {
      console.warn("[Better ChatGPT] Settings recovery used defaults.", error);
      return validateSettings(DEFAULTS);
    }
  }

  function saveLocalSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Opaque origins and strict private modes may deny localStorage.
    }
  }

  function getExtensionApi() {
    if (typeof browser !== "undefined" && browser?.storage?.sync) return browser;
    if (typeof chrome !== "undefined" && chrome?.storage?.sync) return chrome;
    return null;
  }

  function decodeSyncedValue(value) {
    if (!isPlainObject(value)) return null;
    if (value.schemaVersion === SYNC_SCHEMA_VERSION && isPlainObject(value.settings)) {
      return {
        settings: value.settings,
        updatedAt: Number(value.updatedAt) || 0,
        legacy: false,
      };
    }
    return { settings: value, updatedAt: 0, legacy: true };
  }

  function makeSyncEnvelope() {
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      updatedAt: Date.now(),
      settings: clone(settings),
    };
  }

  function clearScheduledSyncWrite() {
    clearTimeout(syncWriteTimer);
    syncWriteTimer = 0;
  }

  async function syncWriteNow() {
    if (!settings.sync || !syncReady) return false;
    const api = getExtensionApi();
    if (!api?.storage?.sync) return false;
    try {
      await api.storage.sync.set({ [STORAGE_KEY]: makeSyncEnvelope() });
      syncStatus = "synced";
      return true;
    } catch (error) {
      syncStatus = "error";
      recordError("sync-write", error);
      return false;
    }
  }

  function syncWrite() {
    if (!settings.sync || !syncReady) return;
    clearScheduledSyncWrite();
    syncWriteTimer = window.setTimeout(() => {
      syncWriteTimer = 0;
      void syncWriteNow();
    }, SYNC_WRITE_DELAY_MS);
  }

  function applySyncedSettings(remoteSettings) {
    const next = validateSettings(remoteSettings);
    next.sync = true;
    if (JSON.stringify(next) === JSON.stringify(settings)) return false;
    settings = next;
    apiObject.settings = settings;
    globalThis.__BCG_SETTINGS__ = settings;
    saveLocalSettings();
    dispatchSettingsChanged("sync");
    return true;
  }

  async function syncRead({ announce = false } = {}) {
    if (!settings.sync) return "disabled";
    const api = getExtensionApi();
    if (!api?.storage?.sync) {
      syncReady = false;
      syncStatus = "unavailable";
      if (announce) notify("Browser sync is unavailable in this installation.");
      return "unavailable";
    }
    clearScheduledSyncWrite();
    syncStatus = "loading";
    try {
      const result = await api.storage.sync.get(STORAGE_KEY);
      const remote = decodeSyncedValue(result?.[STORAGE_KEY]);
      if (remote) {
        applySyncedSettings(remote.settings);
        syncReady = true;
        syncStatus = "synced";
        if (remote.legacy) await syncWriteNow();
        if (announce) notify("Browser sync enabled. Existing synced settings were loaded.");
        return "downloaded";
      }

      syncReady = true;
      await syncWriteNow();
      if (announce) notify("Browser sync enabled. This device created the synced copy.");
      return "uploaded";
    } catch (error) {
      syncReady = false;
      syncStatus = "error";
      recordError("sync-read", error);
      if (announce) notify("Browser sync could not be enabled. Local settings were kept.");
      return "error";
    }
  }

  function handleSyncStateChange(previousSync, { announce = false } = {}) {
    if (!previousSync && settings.sync) {
      syncReady = false;
      syncStatus = "loading";
      void syncRead({ announce });
      return true;
    }
    if (previousSync && !settings.sync) {
      clearScheduledSyncWrite();
      syncReady = false;
      syncStatus = "local-only";
      if (announce) notify("Browser sync disabled. Settings remain on this device.");
      return true;
    }
    return false;
  }

  function installSyncChangeListener() {
    if (syncListenerInstalled) return;
    const api = getExtensionApi();
    if (!api?.storage?.onChanged?.addListener) return;
    api.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !settings.sync) return;
      const remote = decodeSyncedValue(changes?.[STORAGE_KEY]?.newValue);
      if (!remote) return;
      applySyncedSettings(remote.settings);
      syncReady = true;
      syncStatus = "synced";
    });
    syncListenerInstalled = true;
  }

  function normalizeLauncherPatch(patch) {
    if (!isPlainObject(patch?.ui)) return patch;
    const normalized = clone(patch);
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(normalized.ui, key);
    if (hasOwn("launcherX") && !hasOwn("launcherXRatio")) normalized.ui.launcherXRatio = -1;
    if (hasOwn("launcherY") && !hasOwn("launcherYRatio")) normalized.ui.launcherYRatio = -1;
    return normalized;
  }

  function markReloadRequired(required = true) {
    if (required) document.documentElement.dataset.bcgNeedsReload = "1";
    updateReloadUi();
  }

  function updateSettings(patch, { announce = false, reloadRequired = false, preserveProfile = false } = {}) {
    const previousProfile = settings.profile;
    const previousSync = settings.sync;
    patch = normalizeLauncherPatch(patch);
    settings = validateSettings(deepMerge(settings, patch));
    settings.profile = preserveProfile ? previousProfile : (patch?.profile || "custom");
    apiObject.settings = settings;
    globalThis.__BCG_SETTINGS__ = settings;
    saveLocalSettings();
    const syncTransition = handleSyncStateChange(previousSync, { announce });
    if (!syncTransition) syncWrite();
    if (reloadRequired) markReloadRequired();
    dispatchSettingsChanged("update");
    if (announce && !syncTransition) notify(reloadRequired ? "Saved. Reload ChatGPT to apply this structural change." : "Saved.");
    return settings;
  }

  function replaceSettings(next, options = {}) {
    const previousSync = settings.sync;
    settings = validateSettings(next);
    apiObject.settings = settings;
    globalThis.__BCG_SETTINGS__ = settings;
    saveLocalSettings();
    const syncTransition = handleSyncStateChange(previousSync, { announce: options.announce !== false });
    if (!syncTransition) syncWrite();
    if (options.reloadRequired === true) markReloadRequired();
    dispatchSettingsChanged("replace");
    if (options.announce !== false) notify("Settings imported.");
  }

  function applyProfile(profile) {
    const patch = PROFILE_PATCHES[profile];
    if (!patch) return false;
    const syncEnabled = settings.sync;
    settings = validateSettings(deepMerge(DEFAULTS, patch));
    settings.sync = syncEnabled;
    settings.profile = profile;
    apiObject.settings = settings;
    globalThis.__BCG_SETTINGS__ = settings;
    saveLocalSettings();
    syncWrite();
    dispatchSettingsChanged("profile");
    notify(`${profile[0].toUpperCase()}${profile.slice(1)} profile applied.`);
    return true;
  }

  function dispatchSettingsChanged(reason) {
    window.dispatchEvent(
      new CustomEvent("bcg:settings-changed", {
        detail: { reason, settings: clone(settings) },
      }),
    );
    refreshPanelValues();
  }

  function isTabDisabled() {
    try {
      return sessionStorage.getItem(TAB_DISABLED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setTabDisabled(disabled) {
    try {
      sessionStorage.setItem(TAB_DISABLED_KEY, disabled ? "1" : "0");
    } catch {
      // Ignore private-mode storage failures.
    }
    notify(disabled ? "Better ChatGPT disabled on this tab." : "Better ChatGPT enabled on this tab.");
    dispatchSettingsChanged("tab-disabled");
  }

  function isFeatureEnabled(path) {
    if (!settings.enabled || isTabDisabled()) return false;
    if (String(path).startsWith("editAttachments.") && !EDIT_ATTACHMENTS_AVAILABLE) return false;
    const parts = String(path).split(".");
    let cursor = settings;
    for (const part of parts) cursor = cursor?.[part];
    return cursor !== false;
  }

  function hexToRgb(hex) {
    const normalized = normalizeColor(hex, "#000000").slice(1);
    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
    };
  }

  function getReadableTextColor(color) {
    const { r, g, b } = hexToRgb(color);
    const channels = [r, g, b].map((value) => {
      const srgb = value / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    return luminance > 0.42 ? "#111111" : "#ffffff";
  }

  function getBubbleTextColor() {
    if (settings.appearance.textColorMode === "manual") return settings.appearance.textColor;
    if (settings.appearance.pageColorsEnabled) return settings.appearance.pageTextColor;
    return getReadableTextColor(settings.appearance.bubbleColor);
  }


  function sanitizeDiagnosticText(value, maxLength = 300) {
    let text = String(value ?? "");
    text = text
      .replace(/https?:\/\/[^\s)]+/gi, "[url]")
      .replace(/\/c\/[A-Za-z0-9_-]+/g, "/c/[redacted]")
      .replace(/\bfile_[A-Za-z0-9_-]+\b/g, "[file-id]")
      .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s<>:"|?*]+[\\/])+[^\s<>:"|?*]*/g, "[path]")
      .replace(/\b[^\s<>:"|?*]{1,160}\.(?:zip|7z|rar|txt|log|json|xml|csv|tsv|md|pdf|docx?|xlsx?|png|jpe?g|webp)\b/gi, "[file]");
    return text.slice(0, maxLength);
  }

  function isBenignResizeObserverWindowError(event) {
    const message = String(event?.message || event?.error?.message || "").trim();
    return (
      message === "ResizeObserver loop completed with undelivered notifications." ||
      message === "ResizeObserver loop completed with undelivered notifications" ||
      message === "ResizeObserver loop limit exceeded" ||
      message === "ResizeObserver loop limit exceeded."
    );
  }

  function recordError(module, error, metadata = {}) {
    const safeMetadata = {};
    for (const [key, value] of Object.entries(metadata || {})) {
      if (/prompt|message|content|text|attachment|filename|file/i.test(key)) continue;
      safeMetadata[key] = typeof value === "string" ? value.slice(0, 160) : value;
    }
    diagnostics.push({
      at: new Date().toISOString(),
      module: String(module).slice(0, 80),
      name: error?.name || "Error",
      message: sanitizeDiagnosticText(error?.message || error || "Unknown error", 300),
      metadata: safeMetadata,
    });
    if (diagnostics.length > 50) diagnostics.splice(0, diagnostics.length - 50);
    if (settings.advanced.debug) console.error(`[Better ChatGPT:${module}]`, error);
  }

  function recordTrace(event, metadata = {}) {
    const safeMetadata = {};
    for (const [key, value] of Object.entries(metadata || {})) {
      if (/prompt|message|content|text|attachment|filename|fileName|token|header|cookie|body/i.test(key)) continue;
      if (typeof value === "string") safeMetadata[key] = value.slice(0, 180);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) safeMetadata[key] = value;
    }
    bridgeTrace.push({
      at: new Date().toISOString(),
      event: String(event || "unknown").slice(0, 100),
      metadata: safeMetadata,
    });
    if (bridgeTrace.length > 80) bridgeTrace.splice(0, bridgeTrace.length - 80);
    if (settings.advanced.debug) console.debug(`[Better ChatGPT bridge:${event}]`, safeMetadata);
  }

  function getStatus() {
    const hybrid = globalThis.__chatgptHybridScroll?.status?.();
    const editSessions = Number(document.documentElement.dataset.bcgEditSessions || 0);
    return {
      version: VERSION,
      enabled: settings.enabled && !isTabDisabled(),
      tabDisabled: isTabDisabled(),
      profile: settings.profile,
      scrollStrategy: hybrid?.strategy || (settings.scrolling.enabled ? "waiting" : "off"),
      scrollPausedMs: hybrid?.pausedMs || 0,
      crossDeviceGuard: Boolean(settings.resilience.crossDeviceGuard),
      editSessions,
      editAttachmentsAvailable: EDIT_ATTACHMENTS_AVAILABLE,
      editBridgeReady: EDIT_ATTACHMENTS_AVAILABLE && Boolean(apiObject.editAttachmentBridge?.isReady?.()),
      errors: diagnostics.length,
      needsReload: document.documentElement.dataset.bcgNeedsReload === "1",
      browserSync: syncStatus,
      performanceHangRecorder: Boolean(settings.advanced.performanceHangRecorder),
      nativeToolFreezeGuard: Boolean(settings.advanced.nativeToolFreezeGuard),
    };
  }

  function diagnosticReport() {
    return {
      product: "Better ChatGPT",
      version: VERSION,
      url: `${location.origin}${location.pathname.replace(/\/c\/[A-Za-z0-9_-]+/, "/c/[redacted]")}`,
      browser: navigator.userAgent.slice(0, 240),
      status: getStatus(),
      settings: {
        enabled: settings.enabled,
        profile: settings.profile,
        ui: { ...settings.ui },
        navigation: { ...settings.navigation },
        resilience: { ...settings.resilience },
        layout: { ...settings.layout },
        appearance: { ...settings.appearance },
        scrolling: { ...settings.scrolling },
        composer: { ...settings.composer },
        queue: { ...settings.queue },
        editAttachments: { ...settings.editAttachments },
        advanced: { ...settings.advanced },
      },
      queueRuntime: typeof apiObject.queueDiagnostics === "function" ? clone(apiObject.queueDiagnostics()) : null,
      performance: apiObject.performanceDiagnostics?.getReport?.() || null,
      nativeToolFreezeGuard: apiObject.nativeToolFreezeGuard?.status?.() || null,
      recentErrors: clone(diagnostics),
      bridgeTrace: clone(bridgeTrace),
    };
  }

  function notify(message) {
    if (!settings.advanced.notifications) return;
    const mount = document.body || document.documentElement;
    if (!mount) return;
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "status");
      mount.appendChild(toast);
    }
    if (toast.textContent === message && toast.dataset.visible === "1") return;
    toast.textContent = message;
    toast.dataset.visible = "1";
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.dataset.visible = "0";
    }, 2600);
  }

  function injectShellStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${BUTTON_ID}{position:fixed;right:18px;bottom:78px;z-index:2147483600;width:42px;height:42px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;background:var(--main-surface-primary,#fff);color:inherit;box-shadow:0 8px 28px rgba(0,0,0,.18);font:700 17px system-ui;cursor:grab;display:grid;place-items:center;touch-action:none;user-select:none;transition:transform .14s ease,box-shadow .14s ease}
#${BUTTON_ID}:hover{transform:translateY(-1px);box-shadow:0 10px 32px rgba(0,0,0,.24)}
#${BUTTON_ID}[data-dragging="1"]{cursor:grabbing;transform:none;transition:none}
#${COMMAND_MENU_ID}{box-sizing:border-box;position:fixed;z-index:2147483601;display:flex;visibility:hidden;pointer-events:none;flex-direction:column;align-items:center;gap:4px;width:46px;padding:5px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:23px;background:color-mix(in srgb,var(--main-surface-primary,#fff) 96%,transparent);color:inherit;box-shadow:0 14px 42px rgba(0,0,0,.3);backdrop-filter:blur(16px);opacity:0;transform:translateY(var(--bcg-command-shift,0)) scale(.82);transition:opacity .16s ease,transform .2s cubic-bezier(.2,.8,.2,1),visibility 0s linear .2s;font:13px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#${COMMAND_MENU_ID}[data-direction="above"]{--bcg-command-shift:8px;transform-origin:center bottom}
#${COMMAND_MENU_ID}[data-direction="below"]{--bcg-command-shift:-8px;transform-origin:center top}
#${COMMAND_MENU_ID}[data-open="1"]{visibility:visible;pointer-events:auto;opacity:1;transform:translateY(0) scale(1);transition-delay:0s}
#${COMMAND_MENU_ID} button{position:relative;display:grid;place-items:center;width:34px;height:34px;min-height:34px;padding:0;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer}
#${COMMAND_MENU_ID} button:hover,#${COMMAND_MENU_ID} button:focus-visible{background:color-mix(in srgb,currentColor 12%,transparent);outline:none;transform:scale(1.06)}
#${COMMAND_MENU_ID} button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
#${COMMAND_MENU_ID} .bcg-command-separator{width:26px;height:1px;margin:2px 0;background:color-mix(in srgb,currentColor 15%,transparent)}
#${COMMAND_MENU_ID} .bcg-command-state{position:absolute;right:2px;top:2px;width:6px;height:6px;border-radius:999px;background:#8b5cf6;box-shadow:0 0 0 2px var(--main-surface-primary,#fff);opacity:0;transform:scale(.4);transition:opacity .14s ease,transform .14s ease}
#${COMMAND_MENU_ID} button[data-enabled="1"] .bcg-command-state{opacity:1;transform:scale(1)}
#${COMMAND_MENU_ID} button::after{content:attr(data-tooltip);position:absolute;top:50%;z-index:2;width:max-content;max-width:220px;padding:6px 8px;border-radius:7px;background:rgba(18,18,18,.96);color:#fff;box-shadow:0 5px 20px rgba(0,0,0,.3);font:12px/1.2 system-ui;white-space:nowrap;opacity:0;pointer-events:none;transform:translateY(-50%) scale(.94);transition:opacity .12s ease,transform .12s ease}
#${COMMAND_MENU_ID}[data-side="right"] button::after{right:calc(100% + 10px);transform-origin:right center}
#${COMMAND_MENU_ID}[data-side="left"] button::after{left:calc(100% + 10px);transform-origin:left center}
#${COMMAND_MENU_ID} button:hover::after,#${COMMAND_MENU_ID} button:focus-visible::after{opacity:1;transform:translateY(-50%) scale(1)}
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483640;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.66);font:14px/1.42 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ececf1;backdrop-filter:blur(5px)}
#${PANEL_ID}[data-open="1"]{display:flex}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .bcg-settings-shell{--bcg-accent:#8747dc;--bcg-accent-strong:#9b5cf0;--bcg-bg:#101012;--bcg-sidebar:#111115;--bcg-surface:#18181d;--bcg-surface-2:#1d1d24;--bcg-border:#363641;--bcg-border-soft:#2b2b34;--bcg-text:#ececf1;--bcg-muted:#a3a3b2;--bcg-success:#58d68d;--bcg-warning:#f5b82e;width:min(1180px,calc(100vw - 36px));height:min(860px,calc(100vh - 36px));display:grid;grid-template-columns:260px minmax(0,1fr);overflow:hidden;border:1px solid var(--bcg-border);border-radius:24px;background:var(--bcg-bg);box-shadow:0 28px 100px rgba(0,0,0,.58);color:var(--bcg-text)}
#${PANEL_ID} .bcg-settings-sidebar{min-width:0;display:flex;flex-direction:column;padding:20px 18px;border-right:1px solid var(--bcg-border-soft);background:linear-gradient(180deg,#111115 0%,#101014 100%)}
#${PANEL_ID} .bcg-brand{display:flex;align-items:center;gap:11px;padding:0 2px 12px}
#${PANEL_ID} .bcg-brand-mark{display:grid;place-items:center;width:40px;height:40px;flex:0 0 auto;border-radius:999px;background:linear-gradient(145deg,var(--bcg-accent-strong),#7334c8);color:#fff;font-weight:800;letter-spacing:-.04em;box-shadow:0 8px 24px rgba(135,71,220,.25)}
#${PANEL_ID} .bcg-brand-copy{min-width:0}.bcg-brand-title{font-size:16px;font-weight:750;white-space:nowrap}.bcg-brand-version{margin-top:1px;color:var(--bcg-muted);font-size:11px}
#${PANEL_ID} .bcg-settings-search{position:relative;margin:0 0 13px}
#${PANEL_ID} .bcg-settings-search svg{position:absolute;left:11px;top:50%;width:15px;height:15px;transform:translateY(-50%);fill:none;stroke:var(--bcg-muted);stroke-width:1.8;pointer-events:none}
#${PANEL_ID} .bcg-settings-search input{width:100%;height:42px;padding:0 12px 0 35px;border:1px solid var(--bcg-border);border-radius:11px;background:#18181e;color:var(--bcg-text);font:inherit;outline:none;transition:border-color .14s,box-shadow .14s}
#${PANEL_ID} .bcg-settings-search input::placeholder{color:#8c8c9b}
#${PANEL_ID} .bcg-settings-search input:focus{border-color:var(--bcg-accent);box-shadow:0 0 0 3px rgba(135,71,220,.18)}
#${PANEL_ID} .bcg-nav-label{padding:0 2px 6px;color:#898998;font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
#${PANEL_ID} .bcg-settings-nav{display:grid;gap:5px;overflow:auto;padding:1px 0 8px}
#${PANEL_ID} .bcg-settings-nav button{position:relative;display:flex;align-items:center;gap:11px;width:100%;min-height:41px;padding:0 11px;border:0;border-radius:10px;background:transparent;color:#aaaab9;font:inherit;text-align:left;cursor:pointer;transition:background .12s,color .12s,transform .12s}
#${PANEL_ID} .bcg-settings-nav button:hover{background:#1b1b22;color:#f0f0f4}
#${PANEL_ID} .bcg-settings-nav button:active{transform:scale(.985)}
#${PANEL_ID} .bcg-settings-nav button[aria-current="page"]{background:linear-gradient(135deg,#8445d9,#8d49df);color:#fff;font-weight:700;box-shadow:0 8px 22px rgba(106,49,183,.22)}
#${PANEL_ID} .bcg-nav-icon{display:grid;place-items:center;width:18px;flex:0 0 18px;font-size:16px;line-height:1}.bcg-nav-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .bcg-nav-badge{margin-left:auto;padding:2px 6px;border-radius:999px;background:rgba(135,71,220,.25);color:#bb91ff;font-size:9px;font-weight:800;letter-spacing:.05em}
#${PANEL_ID} .bcg-settings-nav button[aria-current="page"] .bcg-nav-badge{background:rgba(255,255,255,.18);color:#fff}
#${PANEL_ID} .bcg-extension-status{margin-top:auto;padding:12px;border:1px solid var(--bcg-border);border-radius:12px;background:#18181e}
#${PANEL_ID} .bcg-status-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700}.bcg-status-dot{width:9px;height:9px;border-radius:999px;background:var(--bcg-success);box-shadow:0 0 0 3px rgba(88,214,141,.08)}
#${PANEL_ID} .bcg-status-note{margin-top:5px;color:var(--bcg-muted);font-size:11px}
#${PANEL_ID} .bcg-settings-main{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#121216}
#${PANEL_ID} .bcg-settings-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:22px 22px 18px;border-bottom:1px solid var(--bcg-border-soft);background:rgba(18,18,22,.94);backdrop-filter:blur(14px)}
#${PANEL_ID} .bcg-settings-heading{min-width:0}#${PANEL_ID} .bcg-settings-heading h2{margin:0;color:var(--bcg-text);font-size:24px;line-height:1.15;letter-spacing:-.025em}#${PANEL_ID} .bcg-settings-heading p{margin:5px 0 0;color:var(--bcg-muted);font-size:12px}
#${PANEL_ID} .bcg-header-actions{display:flex;align-items:center;gap:10px;flex:0 0 auto}
#${PANEL_ID} .bcg-reload-badge{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 11px;border:1px solid #6d4d0d;border-radius:10px;background:#31240c;color:#f4ba34;font-size:11px;font-weight:700;opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .15s,transform .15s,visibility 0s linear .15s}
#${PANEL_ID} .bcg-reload-badge::before{content:"";width:7px;height:7px;border-radius:999px;background:#f4b62e;box-shadow:0 0 0 3px rgba(244,182,46,.08)}
#${PANEL_ID} .bcg-reload-badge[data-visible="1"]{opacity:1;visibility:visible;transform:none;transition-delay:0s}
#${PANEL_ID} .bcg-icon-button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid var(--bcg-border);border-radius:10px;background:#1b1b22;color:#aaaab8;cursor:pointer}
#${PANEL_ID} .bcg-icon-button:hover{background:#24242c;color:#fff;border-color:#4a4a57}
#${PANEL_ID} .bcg-icon-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
#${PANEL_ID} .bcg-settings-content{min-height:0;overflow:auto;padding:22px;scrollbar-color:#494956 transparent;scrollbar-width:thin}
#${PANEL_ID} .bcg-section{display:grid;gap:18px}.bcg-section[hidden]{display:none!important}
#${PANEL_ID} .bcg-section-search-title{display:none;margin:0 0 -4px;color:#c6a8f5;font-size:12px;font-weight:750;letter-spacing:.04em;text-transform:uppercase}
#${PANEL_ID} .bcg-settings-content[data-searching="1"] .bcg-section-search-title{display:block}
#${PANEL_ID} .bcg-section-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}
#${PANEL_ID} .bcg-section-grid.bcg-grid-wide-first{grid-template-columns:minmax(0,1.25fr) minmax(310px,.95fr)}
#${PANEL_ID} .bcg-settings-card{min-width:0;padding:16px;border:1px solid var(--bcg-border);border-radius:16px;background:linear-gradient(180deg,#1a1a20,#18181e);box-shadow:0 8px 24px rgba(0,0,0,.08)}
#${PANEL_ID} .bcg-settings-card[hidden]{display:none!important}
#${PANEL_ID} .bcg-settings-card[data-full-width="1"]{grid-column:1/-1}
#${PANEL_ID} .bcg-card-title{margin:0;color:var(--bcg-text);font-size:15px;font-weight:750}.bcg-card-description{margin:4px 0 11px;color:var(--bcg-muted);font-size:11px}
#${PANEL_ID} .bcg-settings-rows{display:grid}.bcg-setting-row{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:50px;padding:8px 0;border-top:1px solid transparent}.bcg-setting-row+ .bcg-setting-row{border-top-color:#272730}.bcg-setting-row[hidden]{display:none!important}
#${PANEL_ID} .bcg-setting-copy{min-width:0;flex:1}.bcg-setting-title{color:#e7e7ed;font-size:12px;font-weight:700}.bcg-setting-description{margin-top:2px;color:var(--bcg-muted);font-size:11px;line-height:1.35}
#${PANEL_ID} .bcg-setting-control{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto;min-width:106px}
#${PANEL_ID} input,#${PANEL_ID} select,#${PANEL_ID} button{font-family:inherit}
#${PANEL_ID} select,#${PANEL_ID} input[type="number"],#${PANEL_ID} input[type="text"]{height:34px;padding:0 10px;border:1px solid var(--bcg-border);border-radius:9px;background:#1e1e25;color:var(--bcg-text);outline:none}
#${PANEL_ID} select{min-width:112px;cursor:pointer;color-scheme:dark}
#${PANEL_ID} input[type="number"]{width:92px;font-variant-numeric:tabular-nums}
#${PANEL_ID} select:focus,#${PANEL_ID} input:focus-visible{border-color:var(--bcg-accent);box-shadow:0 0 0 3px rgba(135,71,220,.16)}
#${PANEL_ID} .bcg-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:0 0 auto;cursor:pointer}.bcg-switch input{position:absolute;inset:0;opacity:0;cursor:pointer}.bcg-switch-track{width:42px;height:24px;border:1px solid #50505b;border-radius:999px;background:#555561;transition:background .15s,border-color .15s}.bcg-switch-track::after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:999px;background:#fff;box-shadow:0 2px 7px rgba(0,0,0,.32);transition:transform .18s cubic-bezier(.2,.8,.2,1)}.bcg-switch input:checked+.bcg-switch-track{border-color:var(--bcg-accent);background:var(--bcg-accent)}.bcg-switch input:checked+.bcg-switch-track::after{transform:translateX(18px)}.bcg-switch input:focus-visible+.bcg-switch-track{box-shadow:0 0 0 3px rgba(135,71,220,.22)}
#${PANEL_ID} .bcg-range-control{display:flex;align-items:center;gap:10px;width:min(230px,28vw)}#${PANEL_ID} input[type="range"]{min-width:100px;flex:1;accent-color:var(--bcg-accent);cursor:ew-resize}.bcg-range-value{min-width:42px;color:#dfdfe7;font-size:11px;font-weight:750;text-align:right;font-variant-numeric:tabular-nums}
#${PANEL_ID} .bcg-color-control{display:flex;align-items:center;gap:8px;min-height:34px;padding:3px 8px 3px 4px;border:1px solid var(--bcg-border);border-radius:9px;background:#1e1e25}.bcg-color-control input[type="color"]{width:27px;height:27px;padding:0;border:0;border-radius:999px;background:transparent;cursor:pointer;overflow:hidden}.bcg-color-control input[type="color"]::-webkit-color-swatch-wrapper{padding:0}.bcg-color-control input[type="color"]::-webkit-color-swatch{border:0;border-radius:999px}.bcg-color-value{min-width:56px;color:#d8d8e0;font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase}
#${PANEL_ID} .bcg-palette{display:flex;align-items:center;gap:9px;margin:2px 0 4px}.bcg-swatch{width:31px!important;height:31px!important;padding:0!important;border:1px solid #555563!important;border-radius:999px!important;background:var(--bcg-swatch)!important;box-shadow:none!important}.bcg-swatch:hover{transform:scale(1.08)}.bcg-swatch[data-selected="1"]{outline:2px solid #fff;outline-offset:2px}
#${PANEL_ID} .bcg-preview{position:relative;overflow:hidden;min-height:230px;background:#17171b}.bcg-preview-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px}.bcg-live-pill{display:flex;align-items:center;gap:5px;padding:4px 7px;border-radius:999px;background:#153824;color:#62dc92;font-size:9px;font-weight:800}.bcg-live-pill::before{content:"";width:6px;height:6px;border-radius:999px;background:#49d47e}.bcg-preview-chat{display:grid;gap:14px;padding:12px 14px 14px}.bcg-preview-assistant{display:flex;align-items:center;gap:9px;color:#d7d7de;font-size:11px}.bcg-preview-avatar{width:24px;height:24px;border-radius:999px;background:#41414d}.bcg-preview-user{justify-self:end;max-width:78%;padding:10px 13px;background:var(--bcg-preview-bubble,#4e2f88);color:var(--bcg-preview-text,#fff);opacity:var(--bcg-preview-opacity,1);border-radius:var(--bcg-preview-radius,20px);font-size:11px}.bcg-preview-composer{display:flex;align-items:center;justify-content:space-between;height:40px;margin-top:2px;padding:0 12px;border-radius:12px;background:#1e1e25;color:#8f8f9d;font-size:10px}.bcg-preview-send{color:var(--bcg-preview-accent,#a767ff);font-size:16px}
#${PANEL_ID} .bcg-info-note{margin-top:10px;padding:10px 11px;border:1px solid #5a3386;border-radius:10px;background:#21182d;color:#bca8d7;font-size:10px}.bcg-info-note strong{color:#cdaafa}
#${PANEL_ID} .bcg-card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
#${PANEL_ID} .bcg-button{min-height:36px;padding:0 12px;border:1px solid var(--bcg-border);border-radius:10px;background:#1b1b22;color:#c1c1cc;cursor:pointer}.bcg-button:hover{border-color:#555563;background:#23232b;color:#fff}.bcg-button[data-primary="1"]{border-color:var(--bcg-accent);background:linear-gradient(135deg,#8445d9,#914de3);color:#fff;font-weight:700}.bcg-button[data-danger="1"]{border-color:#6a303a;color:#ef9da9}
#${PANEL_ID} .bcg-tools-grid{display:flex;gap:8px;flex-wrap:wrap}.bcg-diagnostics{margin-top:12px;max-height:250px;overflow:auto;padding:11px;border-radius:10px;background:#0f0f12;color:#bebed0;font:10px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.bcg-diagnostics[hidden]{display:none}
#${PANEL_ID} .bcg-empty-results{display:none;padding:50px 24px;text-align:center;color:var(--bcg-muted)}#${PANEL_ID} .bcg-empty-results[data-visible="1"]{display:block}.bcg-empty-results strong{display:block;margin-bottom:5px;color:#e8e8ee;font-size:15px}
#${PANEL_ID} .bcg-settings-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px;padding:12px 18px;border-top:1px solid var(--bcg-border-soft);background:#111115}.bcg-save-state{display:flex;align-items:center;gap:8px;color:var(--bcg-muted);font-size:11px}.bcg-save-state::before{content:"";width:7px;height:7px;border-radius:999px;background:var(--bcg-success)}.bcg-footer-actions{display:flex;align-items:center;gap:9px}.bcg-reload-button[data-visible="1"]{box-shadow:0 0 0 3px rgba(135,71,220,.12)}
#${PANEL_ID} .bcg-setting-row[data-disabled="1"]{opacity:.48}.bcg-setting-row[data-disabled="1"] .bcg-setting-control{pointer-events:none}
@media(max-width:900px){#${PANEL_ID}{padding:10px}#${PANEL_ID} .bcg-settings-shell{width:100%;height:calc(100vh - 20px);grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);border-radius:18px}#${PANEL_ID} .bcg-settings-sidebar{display:grid;grid-template-columns:auto minmax(180px,1fr);grid-template-areas:"brand search" "nav nav";gap:8px 14px;padding:13px;border-right:0;border-bottom:1px solid var(--bcg-border-soft)}#${PANEL_ID} .bcg-brand{grid-area:brand;padding:0}.bcg-settings-search{grid-area:search;margin:0!important}.bcg-nav-label,.bcg-extension-status{display:none}.bcg-settings-nav{grid-area:nav;display:flex;gap:6px;overflow-x:auto;padding:1px 0}.bcg-settings-nav button{width:auto;min-width:max-content;padding:0 11px}.bcg-nav-badge{display:none}.bcg-settings-main{min-height:0}.bcg-section-grid,.bcg-section-grid.bcg-grid-wide-first{grid-template-columns:1fr}}
@media(max-width:620px){#${PANEL_ID}{padding:0}#${PANEL_ID} .bcg-settings-shell{height:100vh;border:0;border-radius:0}#${PANEL_ID} .bcg-settings-sidebar{grid-template-columns:1fr;grid-template-areas:"brand" "search" "nav"}.bcg-brand-version{display:none}#${PANEL_ID} .bcg-settings-header{padding:16px}.bcg-settings-heading h2{font-size:20px}.bcg-reload-badge{display:none}#${PANEL_ID} .bcg-settings-content{padding:14px}.bcg-settings-card{padding:14px}.bcg-setting-row{align-items:flex-start;gap:12px}.bcg-setting-control{min-width:auto}.bcg-range-control{width:150px}.bcg-settings-footer{padding:10px 12px}.bcg-save-state{display:none}.bcg-footer-actions{width:100%}.bcg-footer-actions .bcg-button{flex:1}}
#${TOAST_ID}{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);z-index:2147483647;padding:9px 13px;border-radius:999px;background:rgba(18,18,18,.94);color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.3);font:13px system-ui;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
#${TOAST_ID}[data-visible="1"]{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:640px){#${BUTTON_ID}{right:10px;bottom:72px}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setting(path, title, type, description, options = null) {
    return { path, title, type, description, options };
  }

  const SETTINGS_SECTIONS = [
    {
      id: "general",
      title: "General",
      description: "Core Better ChatGPT behavior, profiles, and browser storage.",
      icon: "⚙",
      resetPaths: ["enabled", "profile", "sync", "navigation.persistSidebarSections", "navigation.projectDoubleClickHome", "resilience.crossDeviceGuard"],
      groups: [
        {
          title: "Essentials",
          description: "Global controls for the extension.",
          fullWidth: true,
          fields: [
            setting("enabled", "Master enable", "checkbox", "Turn Better ChatGPT on or off without removing it."),
            setting("profile", "Profile", "select", "Apply a balanced or minimal preset.", ["default", "minimal", "custom"]),
            setting("sync", "Browser sync", "checkbox", "Sync Better ChatGPT settings through this browser profile. Enabling loads an existing synced copy first; if none exists, this device creates it."),
          ],
        },
        {
          title: "ChatGPT convenience",
          description: "Keep native ChatGPT UI state predictable and reduce friction between devices.",
          fullWidth: true,
          fields: [
            setting("navigation.persistSidebarSections", "Remember sidebar sections", "checkbox", "Restore whether Projects and Chats were expanded or collapsed. Pinned is left to ChatGPT because its native control can open a floating panel in some layouts."),
            setting("navigation.projectDoubleClickHome", "Double-click Project home", "checkbox", "Double-click a project in the sidebar to open its native Project home action."),
            setting("resilience.crossDeviceGuard", "Cross-device stale-chat guard", "checkbox", "Detect when another device advanced the current conversation and refresh before this tab can send from an outdated parent."),
          ],
        },
      ],
    },
    {
      id: "layout",
      title: "Layout",
      description: "Control conversation width and the main composer footprint.",
      icon: "▦",
      resetPaths: ["layout.wideMode", "layout.conversationWidthPercent", "layout.composerWidthPercent"],
      groups: [
        {
          title: "Conversation layout",
          description: "Use more of the available viewport without losing centering.",
          fullWidth: true,
          fields: [
            setting("layout.wideMode", "Wide mode", "checkbox", "Allow the transcript and composer to expand beyond ChatGPT's defaults."),
            setting("layout.conversationWidthPercent", "Conversation width", "range", "Percentage of the available conversation stage.", { min: 0, max: 100, step: 1, suffix: "%" }),
            setting("layout.composerWidthPercent", "Composer width", "range", "Percentage of the available composer stage.", { min: 0, max: 100, step: 1, suffix: "%" }),
          ],
        },
      ],
    },
    {
      id: "appearance",
      title: "Appearance",
      description: "Customize how conversations and your messages look.",
      icon: "◐",
      resetPaths: [
        "appearance.enabled", "appearance.bubbleColor", "appearance.accentColorEnabled",
        "appearance.textColorMode", "appearance.textColor",
        "appearance.opacity", "appearance.radiusPx", "appearance.pageColorsEnabled",
        "appearance.pageBackgroundColor", "appearance.pageTextColor",
        "appearance.composerColorEnabled", "appearance.composerColor",
        "appearance.sidebarColorEnabled", "appearance.sidebarColor", "appearance.hideFooter",
        "appearance.bottomVignette",
      ],
      groups: [
        {
          id: "essentials",
          title: "Essentials",
          description: "The controls you are most likely to change.",
          fields: [
            setting("appearance.enabled", "Colored user bubbles", "checkbox", "Tint your outgoing messages."),
            setting("appearance.bottomVignette", "Bottom vignette", "checkbox", "Keep ChatGPT's native fade above the composer."),
            setting("appearance.textColorMode", "Text contrast", "select", "Automatically choose readable text or use a fixed color.", ["auto", "manual"]),
            setting("appearance.textColor", "Manual text color", "color", "Used only when text contrast is set to Manual."),
          ],
        },
        {
          id: "colors",
          title: "Colors",
          description: "Choose a bubble palette or tune it manually.",
          palette: true,
          fields: [
            setting("appearance.bubbleColor", "Bubble color", "color", "Used for outgoing messages."),
            setting("appearance.accentColorEnabled", "Use as ChatGPT accent", "checkbox", "Apply the bubble color to native controls and highlights that follow ChatGPT's Accent color setting."),
            setting("appearance.opacity", "Bubble opacity", "range", "Adjust message transparency.", { min: 0.2, max: 1, step: 0.05, format: "percent" }),
            setting("appearance.radiusPx", "Corner radius", "number", "Message bubble roundness in pixels.", { min: 0, max: 40, step: 1, suffix: " px" }),
          ],
        },
        {
          id: "surface",
          title: "Conversation surface",
          description: "Control ChatGPT's page colors without losing readability.",
          fields: [
            setting("appearance.pageColorsEnabled", "Custom conversation colors", "checkbox", "Override the native conversation background and text."),
            setting("appearance.pageBackgroundColor", "Background", "color", "Conversation canvas color."),
            setting("appearance.pageTextColor", "Conversation text", "color", "Primary message text color."),
            setting("appearance.hideFooter", "Hide ChatGPT footer", "checkbox", "Remove the disclaimer above the composer."),
          ],
        },
        {
          id: "interface-surfaces",
          title: "Interface surfaces",
          description: "Give the composer and sidebar independent backgrounds with automatic text contrast.",
          fullWidth: true,
          fields: [
            setting("appearance.composerColorEnabled", "Custom composer color", "checkbox", "Override the main and expanded composer background."),
            setting("appearance.composerColor", "Composer background", "color", "The writing surface used by the composer."),
            setting("appearance.sidebarColorEnabled", "Custom sidebar color", "checkbox", "Override ChatGPT's expanded and compact sidebar surfaces."),
            setting("appearance.sidebarColor", "Sidebar background", "color", "The navigation and chat-history background."),
          ],
        },
      ],
    },
    {
      id: "scrolling",
      title: "Scrolling",
      description: "Keep long and streaming responses comfortable to follow.",
      icon: "↕",
      resetPaths: ["scrolling.enabled", "scrolling.mode", "scrolling.manualPauseMs"],
      groups: [
        {
          title: "Smart follow",
          description: "Balance automatic following with manual control.",
          fullWidth: true,
          fields: [
            setting("scrolling.enabled", "Smart scrolling", "checkbox", "Follow new output while respecting manual scrolling."),
            setting("scrolling.mode", "Mode", "select", "Choose automatic, voice-oriented, or text-oriented behavior.", ["auto", "voice", "text"]),
            setting("scrolling.manualPauseMs", "Manual pause", "number", "How long automatic following pauses after you scroll, in milliseconds.", { min: 250, max: 30000, step: 250, suffix: " ms" }),
          ],
        },
      ],
    },
    {
      id: "composer",
      title: "Composer",
      description: "Control paste handling and writing behavior.",
      icon: "✎",
      resetPaths: [
        "composer.enabled",
      ],
      groups: [
        {
          title: "Writing behavior",
          description: "Keep composing predictable and preserve your formatting.",
          fields: [
            setting("composer.enabled", "Plain-text paste/copy", "checkbox", "Strip unwanted rich formatting when pasting and copying while leaving large-paste handling to ChatGPT."),
          ],
        },
      ],
    },
    {
      id: "uploads",
      title: "Uploads & Queue",
      description: "Manage attachment-upload queueing and edited-message attachments.",
      icon: "↑",
      badge: "NEW",
      resetPaths: [
        "queue.enabled", "queue.visuallyEnableSend",
        "editAttachments.enabled", "editAttachments.maxFiles",
      ],
      groups: [
        {
          title: "Attachment upload queue",
          description: "Press Send while a file is still uploading; Better ChatGPT sends once ChatGPT finishes the upload.",
          fields: [
            setting("queue.enabled", "Queue Send during uploads", "checkbox", "Remember a Send attempt made during an active attachment upload and release it as soon as ChatGPT's native Send becomes available."),
            setting("queue.visuallyEnableSend", "Show Send while uploading", "checkbox", "Keep Send visually actionable while an attachment is uploading so you can queue it before the upload finishes."),
          ],
        },
        {
          title: "Edited messages",
          description: "Attach files directly when revising an earlier prompt.",
          fields: [
            setting("editAttachments.enabled", "Attachments in edited messages", "checkbox", "Enable file picking, paste, drag-and-drop, and Library mentions in edits."),
            setting("editAttachments.maxFiles", "Maximum edit attachments", "number", "Limit attachments staged on a single edited message.", { min: 1, max: 100, step: 1 }),
          ],
        },
      ],
    },
    {
      id: "advanced",
      title: "Advanced",
      description: "Limits, diagnostics, import/export, and maintenance tools.",
      icon: "⋯",
      resetPaths: ["advanced.notifications", "advanced.debug", "advanced.performanceHangRecorder"],
      groups: [
        {
          title: "Limits & diagnostics",
          description: "Settings that normally do not need adjustment.",
          fullWidth: true,
          fields: [
            setting("advanced.notifications", "Notifications", "checkbox", "Show Better ChatGPT status toasts."),
            setting("advanced.performanceHangRecorder", "Native hang recorder", "checkbox", "Record low-overhead timing, memory, DOM-count, and long-frame diagnostics for ChatGPT freezes. Stays active when Master enable is off so the native UI can be tested without Better ChatGPT features."),
            setting("advanced.nativeToolFreezeGuard", "Native tool freeze guard", "checkbox", "During tool-heavy generation, isolate tool layout work and skip offscreen conversation/tool rendering while protecting the active tail and interactive tool surfaces. Disable this independently if a native tool UI behaves incorrectly; the hang recorder can remain enabled."),
            setting("advanced.debug", "Debug logging", "checkbox", "Record additional console and bridge diagnostics."),
          ],
        },
      ],
    },
  ];

  const FIELD_DEFS = SETTINGS_SECTIONS.map((section) => [
    section.title,
    section.groups.flatMap((group) => group.fields.map((field) => [field.path, field.title, field.type, field.options])),
  ]);
  const FIELD_BY_PATH = new Map(SETTINGS_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) => group.fields.map((field) => [field.path, field])),
  ));
  const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));
  let activeSettingsSection = "appearance";
  let settingsSearchQuery = "";

  function getPath(path) {
    return path.split(".").reduce((value, key) => value?.[key], settings);
  }

  function getDefaultPath(path) {
    return path.split(".").reduce((value, key) => value?.[key], DEFAULTS);
  }

  function patchForPath(path, value) {
    const keys = path.split(".");
    const output = {};
    let cursor = output;
    keys.forEach((key, index) => {
      if (index === keys.length - 1) cursor[key] = value;
      else cursor = cursor[key] = {};
    });
    return output;
  }

  function assignPatchPath(output, path, value) {
    const keys = path.split(".");
    let cursor = output;
    keys.forEach((key, index) => {
      if (index === keys.length - 1) cursor[key] = clone(value);
      else cursor = cursor[key] ||= {};
    });
    return output;
  }

  function isLiveSettingPath(path) {
    return FIELD_BY_PATH.has(path) || path.startsWith("ui.");
  }

  function formatFieldValue(field, value) {
    if (field.options?.format === "percent") return `${Math.round(Number(value) * 100)}%`;
    return `${value}${field.options?.suffix || ""}`;
  }

  function saveFieldValue(field, input) {
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.type === "number" || input.type === "range") value = Number(input.value);
    else value = input.value;

    if (field.path === "profile" && value !== "custom") {
      applyProfile(value);
    } else {
      const liveChange = isLiveSettingPath(field.path);
      const syncChange = field.path === "sync";
      updateSettings(patchForPath(field.path, value), {
        announce: syncChange,
        reloadRequired: !liveChange,
        preserveProfile: syncChange,
      });
      if (field.path.startsWith("appearance.")) {
        apiObject.refreshPageColors?.();
        window.dispatchEvent(new Event("bcg:appearance-refresh"));
      }
      if (field.path.startsWith("layout.")) {
        apiObject.refreshWideMode?.();
        window.dispatchEvent(new Event("bcg:layout-refresh"));
      }
    }
    refreshPanelValues();
  }

  function createField(field) {
    const row = document.createElement("div");
    row.className = "bcg-setting-row";
    row.dataset.bcgSettingRow = "1";
    row.dataset.bcgSettingPath = field.path;
    row.dataset.searchText = `${field.title} ${field.description} ${field.path}`.toLowerCase();

    const copy = document.createElement("div");
    copy.className = "bcg-setting-copy";
    const title = document.createElement("div");
    title.className = "bcg-setting-title";
    title.textContent = field.title;
    const description = document.createElement("div");
    description.className = "bcg-setting-description";
    description.textContent = field.description;
    copy.append(title, description);

    const control = document.createElement("div");
    control.className = "bcg-setting-control";
    const input = document.createElement(field.type === "select" ? "select" : "input");
    input.dataset.settingPath = field.path;
    input.id = `bcg-setting-${field.path.replace(/[^a-z0-9]+/gi, "-")}`;

    let valueOutput = null;
    if (field.type === "select") {
      for (const optionValue of field.options) {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionValue[0].toUpperCase() + optionValue.slice(1);
        input.appendChild(option);
      }
      control.appendChild(input);
    } else if (field.type === "checkbox") {
      input.type = "checkbox";
      const switchLabel = document.createElement("label");
      switchLabel.className = "bcg-switch";
      switchLabel.htmlFor = input.id;
      switchLabel.setAttribute("aria-label", field.title);
      const track = document.createElement("span");
      track.className = "bcg-switch-track";
      switchLabel.append(input, track);
      control.appendChild(switchLabel);
    } else if (field.type === "color") {
      input.type = "color";
      const colorControl = document.createElement("label");
      colorControl.className = "bcg-color-control";
      colorControl.htmlFor = input.id;
      valueOutput = document.createElement("output");
      valueOutput.className = "bcg-color-value";
      colorControl.append(input, valueOutput);
      control.appendChild(colorControl);
    } else if (field.type === "range") {
      input.type = "range";
      input.min = String(field.options.min);
      input.max = String(field.options.max);
      input.step = String(field.options.step);
      valueOutput = document.createElement("output");
      valueOutput.className = "bcg-range-value";
      valueOutput.htmlFor = input.id;
      const range = document.createElement("div");
      range.className = "bcg-range-control";
      range.append(input, valueOutput);
      control.appendChild(range);
    } else {
      input.type = field.type;
      if (field.options) {
        input.min = String(field.options.min);
        input.max = String(field.options.max);
        input.step = String(field.options.step);
      }
      control.appendChild(input);
    }

    const eventName = field.type === "range" || field.type === "color" ? "input" : "change";
    input.addEventListener(eventName, () => saveFieldValue(field, input));
    if (field.type === "color") input.addEventListener("change", () => saveFieldValue(field, input));
    row.append(copy, control);
    return row;
  }

  function createPalette() {
    const palette = document.createElement("div");
    palette.className = "bcg-palette";
    palette.setAttribute("aria-label", "Bubble color presets");
    for (const color of ["#4e2f88", "#3287d8", "#2cb39a", "#df5673", "#555765", "#19191f"]) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "bcg-swatch";
      swatch.style.setProperty("--bcg-swatch", color);
      swatch.dataset.bcgPaletteColor = color;
      swatch.title = color;
      swatch.setAttribute("aria-label", `Use bubble color ${color}`);
      swatch.addEventListener("click", () => {
        updateSettings({ appearance: { bubbleColor: color } }, { reloadRequired: false });
        window.dispatchEvent(new Event("bcg:appearance-refresh"));
        refreshPanelValues();
      });
      palette.appendChild(swatch);
    }
    return palette;
  }

  function createSettingsCard(group) {
    const card = document.createElement("div");
    card.className = "bcg-settings-card";
    card.dataset.bcgSettingsCard = "1";
    if (group.fullWidth) card.dataset.fullWidth = "1";
    const title = document.createElement("h3");
    title.className = "bcg-card-title";
    title.textContent = group.title;
    const description = document.createElement("p");
    description.className = "bcg-card-description";
    description.textContent = group.description;
    card.append(title, description);
    if (group.palette) {
      card.appendChild(createPalette());
      const presets = document.createElement("div");
      presets.className = "bcg-card-actions";
      const classic = makeButton("Classic dark gray", () => {
        updateSettings({
          appearance: {
            pageColorsEnabled: true,
            pageBackgroundColor: "#121212",
            pageTextColor: "#FCFCFC",
            composerColorEnabled: true,
            composerColor: "#242424",
            sidebarColorEnabled: true,
            sidebarColor: "#202020",
          },
        }, { reloadRequired: false });
        apiObject.refreshPageColors?.();
        window.dispatchEvent(new Event("bcg:appearance-refresh"));
        notify("Classic dark gray applied.");
      });
      classic.dataset.bcgClassicPageColors = "1";
      const reset = makeButton("Reset page colors", () => {
        updateSettings({
          appearance: {
            pageColorsEnabled: false,
            pageBackgroundColor: DEFAULTS.appearance.pageBackgroundColor,
            pageTextColor: DEFAULTS.appearance.pageTextColor,
          },
        }, { reloadRequired: false });
        apiObject.refreshPageColors?.();
        window.dispatchEvent(new Event("bcg:appearance-refresh"));
        notify("Official page colors restored.");
      });
      reset.dataset.bcgResetPageColors = "1";
      presets.append(classic, reset);
      card.appendChild(presets);
    }
    const rows = document.createElement("div");
    rows.className = "bcg-settings-rows";
    group.fields.forEach((field) => rows.appendChild(createField(field)));
    card.appendChild(rows);
    return card;
  }

  function createLivePreview() {
    const card = document.createElement("div");
    card.className = "bcg-settings-card bcg-preview";
    card.dataset.bcgLivePreview = "1";
    card.dataset.bcgSearchStatic = "1";
    const head = document.createElement("div");
    head.className = "bcg-preview-head";
    const title = document.createElement("h3");
    title.className = "bcg-card-title";
    title.textContent = "Live preview";
    const live = document.createElement("span");
    live.className = "bcg-live-pill";
    live.textContent = "LIVE";
    head.append(title, live);
    const chat = document.createElement("div");
    chat.className = "bcg-preview-chat";
    const assistant = document.createElement("div");
    assistant.className = "bcg-preview-assistant";
    const avatar = document.createElement("span");
    avatar.className = "bcg-preview-avatar";
    const assistantText = document.createElement("span");
    assistantText.textContent = "Here’s a cleaner settings experience.";
    assistant.append(avatar, assistantText);
    const user = document.createElement("div");
    user.className = "bcg-preview-user";
    user.dataset.bcgPreviewUserBubble = "1";
    user.textContent = "Much better. Keep this.";
    const composer = document.createElement("div");
    composer.className = "bcg-preview-composer";
    composer.innerHTML = '<span>Ask anything</span><span class="bcg-preview-send">↑</span>';
    chat.append(assistant, user, composer);
    card.append(head, chat);
    return card;
  }

  function createAppearanceSection(section) {
    const element = createSectionShell(section);
    const top = document.createElement("div");
    top.className = "bcg-section-grid bcg-grid-wide-first";
    top.append(createLivePreview(), createSettingsCard(section.groups[0]));
    const bottom = document.createElement("div");
    bottom.className = "bcg-section-grid";
    bottom.append(...section.groups.slice(1).map((group) => createSettingsCard(group)));
    const note = document.createElement("div");
    note.className = "bcg-info-note";
    note.dataset.bcgSearchStatic = "1";
    note.innerHTML = "<strong>Automatic contrast</strong> keeps message text readable against your selected bubble color.";
    element.append(top, bottom, note);
    return element;
  }

  function createSectionShell(section) {
    const element = document.createElement("section");
    element.className = "bcg-section";
    element.dataset.bcgSection = section.id;
    const searchTitle = document.createElement("h3");
    searchTitle.className = "bcg-section-search-title";
    searchTitle.textContent = section.title;
    element.appendChild(searchTitle);
    return element;
  }

  function createToolsCard() {
    const card = document.createElement("div");
    card.className = "bcg-settings-card";
    card.dataset.bcgSearchStatic = "1";
    const title = document.createElement("h3");
    title.className = "bcg-card-title";
    title.textContent = "Tools & diagnostics";
    const description = document.createElement("p");
    description.className = "bcg-card-description";
    description.textContent = "Export, import, inspect, or repair Better ChatGPT without leaving this page.";
    const actions = document.createElement("div");
    actions.className = "bcg-tools-grid";
    const reload = makeButton("Reload ChatGPT", () => location.reload(), true);
    const exportButton = makeButton("Export settings", exportSettings);
    const importButton = makeButton("Import settings", importSettings);
    const diagnosticButton = makeButton("Copy diagnostics", copyDiagnostics);
    const showReport = makeButton("Show report", () => {
      const report = card.querySelector("[data-diagnostics]");
      report.hidden = !report.hidden;
      showReport.textContent = report.hidden ? "Show report" : "Hide report";
    });
    const resetButton = makeButton("Reset everything", resetEverything);
    resetButton.dataset.danger = "1";
    actions.append(reload, exportButton, importButton, diagnosticButton, showReport, resetButton);
    const report = document.createElement("pre");
    report.className = "bcg-diagnostics";
    report.dataset.diagnostics = "1";
    report.hidden = true;
    card.append(title, description, actions, report);
    return card;
  }

  function createStandardSection(section) {
    const element = createSectionShell(section);
    const grid = document.createElement("div");
    grid.className = "bcg-section-grid";
    section.groups.forEach((group) => grid.appendChild(createSettingsCard(group)));
    element.appendChild(grid);
    if (section.id === "composer") {
      const note = document.createElement("div");
      note.className = "bcg-info-note";
      note.dataset.bcgSearchStatic = "1";
      note.textContent = "Drag and resize the expanded composer directly; its last position and size are saved.";
      element.appendChild(note);
    }
    if (section.id === "advanced") element.appendChild(createToolsCard());
    return element;
  }

  function refreshPreview() {
    if (!panel?.isConnected) return;
    const preview = panel.querySelector("[data-bcg-live-preview]");
    const bubble = panel.querySelector("[data-bcg-preview-user-bubble]");
    if (!preview || !bubble) return;
    const appearance = settings.appearance;
    preview.style.background = appearance.pageColorsEnabled ? appearance.pageBackgroundColor : "#17171b";
    preview.style.color = appearance.pageColorsEnabled ? appearance.pageTextColor : "#ececf1";
    bubble.style.setProperty("--bcg-preview-bubble", appearance.enabled ? appearance.bubbleColor : "#2f2f36");
    bubble.style.setProperty("--bcg-preview-text", appearance.enabled ? getBubbleTextColor() : "#ececf1");
    bubble.style.setProperty("--bcg-preview-opacity", String(appearance.opacity));
    bubble.style.setProperty("--bcg-preview-radius", `${appearance.radiusPx}px`);
    preview.style.setProperty("--bcg-preview-accent", appearance.accentColorEnabled ? appearance.bubbleColor : "#a767ff");
    const composer = preview.querySelector(".bcg-preview-composer");
    if (composer) {
      composer.style.background = appearance.composerColorEnabled ? appearance.composerColor : "#1e1e25";
      composer.style.color = appearance.composerColorEnabled
        ? getReadableTextColor(appearance.composerColor)
        : "#8f8f9d";
    }
  }

  function updateDependentRows() {
    if (!panel?.isConnected) return;
    const setDisabled = (path, disabled) => {
      const row = panel.querySelector(`[data-bcg-setting-row][data-bcg-setting-path="${path}"]`);
      const input = row?.querySelector("[data-setting-path]");
      if (row) row.dataset.disabled = disabled ? "1" : "0";
      if (input) input.disabled = disabled;
    };
    setDisabled("appearance.textColor", settings.appearance.textColorMode !== "manual");
    setDisabled("appearance.pageBackgroundColor", !settings.appearance.pageColorsEnabled);
    setDisabled("appearance.pageTextColor", !settings.appearance.pageColorsEnabled);
    setDisabled("appearance.composerColor", !settings.appearance.composerColorEnabled);
    setDisabled("appearance.sidebarColor", !settings.appearance.sidebarColorEnabled);
  }

  function updateReloadUi() {
    if (!panel?.isConnected) return;
    const visible = document.documentElement.dataset.bcgNeedsReload === "1" ? "1" : "0";
    panel.querySelector("[data-bcg-reload-badge]")?.setAttribute("data-visible", visible);
    panel.querySelector("[data-bcg-reload-button]")?.setAttribute("data-visible", visible);
  }

  function updateExtensionStatus() {
    if (!panel?.isConnected) return;
    const active = settings.enabled && !isTabDisabled();
    const title = panel.querySelector("[data-bcg-status-title]");
    const note = panel.querySelector("[data-bcg-status-note]");
    const dot = panel.querySelector(".bcg-status-dot");
    if (title) title.textContent = active ? "Extension active" : "Extension disabled";
    if (note) note.textContent = active ? "Settings apply instantly." : "Enable Better ChatGPT in General settings.";
    if (dot) dot.style.background = active ? "var(--bcg-success)" : "#777783";
  }

  function refreshPalette() {
    if (!panel?.isConnected) return;
    panel.querySelectorAll("[data-bcg-palette-color]").forEach((button) => {
      button.dataset.selected = button.dataset.bcgPaletteColor.toLowerCase() === settings.appearance.bubbleColor.toLowerCase() ? "1" : "0";
    });
  }

  function setHeaderForSection(section) {
    const title = panel?.querySelector("[data-bcg-settings-title]");
    const description = panel?.querySelector("[data-bcg-settings-description]");
    if (title) title.textContent = section.title;
    if (description) description.textContent = section.description;
  }

  function applySettingsSearch() {
    if (!panel?.isConnected) return;
    const content = panel.querySelector(".bcg-settings-content");
    const query = settingsSearchQuery.trim().toLowerCase();
    const resetButton = panel.querySelector("[data-bcg-reset-section]");
    const empty = panel.querySelector("[data-bcg-empty-results]");

    if (!query) {
      content.dataset.searching = "0";
      for (const section of SETTINGS_SECTIONS) {
        const sectionNode = panel.querySelector(`[data-bcg-section="${section.id}"]`);
        sectionNode.hidden = section.id !== activeSettingsSection;
        sectionNode.querySelectorAll("[data-bcg-setting-row]").forEach((row) => { row.hidden = false; });
        sectionNode.querySelectorAll("[data-bcg-settings-card], [data-bcg-search-static]").forEach((node) => { node.hidden = false; });
      }
      panel.querySelectorAll("[data-bcg-settings-nav]").forEach((button) => {
        if (button.dataset.bcgSettingsNav === activeSettingsSection) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      setHeaderForSection(SECTION_BY_ID.get(activeSettingsSection));
      if (resetButton) resetButton.disabled = false;
      if (empty) empty.dataset.visible = "0";
      return;
    }

    content.dataset.searching = "1";
    let matches = 0;
    for (const section of SETTINGS_SECTIONS) {
      const sectionNode = panel.querySelector(`[data-bcg-section="${section.id}"]`);
      let sectionMatches = 0;
      sectionNode.querySelectorAll("[data-bcg-search-static]").forEach((node) => { node.hidden = true; });
      sectionNode.querySelectorAll("[data-bcg-settings-card]").forEach((card) => {
        const rows = Array.from(card.querySelectorAll("[data-bcg-setting-row]"));
        if (!rows.length) {
          card.hidden = true;
          return;
        }
        let cardMatches = 0;
        for (const row of rows) {
          const match = row.dataset.searchText.includes(query);
          row.hidden = !match;
          if (match) {
            cardMatches += 1;
            sectionMatches += 1;
            matches += 1;
          }
        }
        card.hidden = cardMatches === 0;
      });
      sectionNode.hidden = sectionMatches === 0;
    }
    panel.querySelectorAll("[data-bcg-settings-nav]").forEach((button) => button.removeAttribute("aria-current"));
    const title = panel.querySelector("[data-bcg-settings-title]");
    const description = panel.querySelector("[data-bcg-settings-description]");
    if (title) title.textContent = "Search results";
    if (description) description.textContent = matches
      ? `${matches} setting${matches === 1 ? "" : "s"} matching “${settingsSearchQuery.trim()}”`
      : `No settings matching “${settingsSearchQuery.trim()}”`;
    if (resetButton) resetButton.disabled = true;
    if (empty) empty.dataset.visible = matches ? "0" : "1";
  }

  function setActiveSettingsSection(sectionId) {
    if (!SECTION_BY_ID.has(sectionId)) return;
    activeSettingsSection = sectionId;
    settingsSearchQuery = "";
    const search = panel?.querySelector("[data-bcg-settings-search]");
    if (search) search.value = "";
    applySettingsSearch();
  }

  function resetActiveSection() {
    const section = SECTION_BY_ID.get(activeSettingsSection);
    if (!section) return;
    const patch = {};
    section.resetPaths.forEach((path) => assignPatchPath(patch, path, getDefaultPath(path)));
    updateSettings(patch, { reloadRequired: false });
    if (section.id === "appearance") {
      apiObject.refreshPageColors?.();
      window.dispatchEvent(new Event("bcg:appearance-refresh"));
    }
    if (section.id === "layout") {
      apiObject.refreshWideMode?.();
      window.dispatchEvent(new Event("bcg:layout-refresh"));
    }
    notify(`${section.title} settings reset.`);
    refreshPanelValues();
  }

  function buildPanel() {
    injectShellStyles();
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset.open = "0";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Better ChatGPT settings");

    const shell = document.createElement("div");
    shell.className = "bcg-settings-shell";

    const sidebar = document.createElement("aside");
    sidebar.className = "bcg-settings-sidebar";
    const brand = document.createElement("div");
    brand.className = "bcg-brand";
    const mark = document.createElement("div");
    mark.className = "bcg-brand-mark";
    mark.textContent = "B+";
    const brandCopy = document.createElement("div");
    brandCopy.className = "bcg-brand-copy";
    const brandTitle = document.createElement("div");
    brandTitle.className = "bcg-brand-title";
    brandTitle.textContent = "Better ChatGPT";
    const version = document.createElement("div");
    version.className = "bcg-brand-version";
    version.textContent = `Version ${VERSION}`;
    brandCopy.append(brandTitle, version);
    brand.append(mark, brandCopy);

    const searchWrap = document.createElement("label");
    searchWrap.className = "bcg-settings-search";
    searchWrap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>';
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search settings";
    search.autocomplete = "off";
    search.dataset.bcgSettingsSearch = "1";
    search.addEventListener("input", () => {
      settingsSearchQuery = search.value;
      applySettingsSearch();
    });
    searchWrap.appendChild(search);

    const navLabel = document.createElement("div");
    navLabel.className = "bcg-nav-label";
    navLabel.textContent = "Settings";
    const nav = document.createElement("nav");
    nav.className = "bcg-settings-nav";
    nav.setAttribute("aria-label", "Settings categories");
    for (const section of SETTINGS_SECTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.bcgSettingsNav = section.id;
      button.innerHTML = `<span class="bcg-nav-icon" aria-hidden="true">${section.icon}</span><span class="bcg-nav-text">${section.title}</span>${section.badge ? `<span class="bcg-nav-badge">${section.badge}</span>` : ""}`;
      button.addEventListener("click", () => setActiveSettingsSection(section.id));
      nav.appendChild(button);
    }

    const status = document.createElement("div");
    status.className = "bcg-extension-status";
    const statusTitle = document.createElement("div");
    statusTitle.className = "bcg-status-title";
    statusTitle.innerHTML = '<span class="bcg-status-dot"></span><span data-bcg-status-title></span>';
    const statusNote = document.createElement("div");
    statusNote.className = "bcg-status-note";
    statusNote.dataset.bcgStatusNote = "1";
    status.append(statusTitle, statusNote);
    sidebar.append(brand, searchWrap, navLabel, nav, status);

    const main = document.createElement("div");
    main.className = "bcg-settings-main";
    const header = document.createElement("header");
    header.className = "bcg-settings-header";
    const heading = document.createElement("div");
    heading.className = "bcg-settings-heading";
    const title = document.createElement("h2");
    title.dataset.bcgSettingsTitle = "1";
    const description = document.createElement("p");
    description.dataset.bcgSettingsDescription = "1";
    heading.append(title, description);
    const headerActions = document.createElement("div");
    headerActions.className = "bcg-header-actions";
    const badge = document.createElement("div");
    badge.className = "bcg-reload-badge";
    badge.dataset.bcgReloadBadge = "1";
    badge.dataset.visible = "0";
    badge.textContent = "Reload required";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "bcg-icon-button";
    close.setAttribute("aria-label", "Close Better ChatGPT settings");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
    close.addEventListener("click", closeSettings);
    headerActions.append(badge, close);
    header.append(heading, headerActions);

    const content = document.createElement("div");
    content.className = "bcg-settings-content";
    content.dataset.searching = "0";
    for (const section of SETTINGS_SECTIONS) {
      content.appendChild(section.id === "appearance" ? createAppearanceSection(section) : createStandardSection(section));
    }
    const empty = document.createElement("div");
    empty.className = "bcg-empty-results";
    empty.dataset.bcgEmptyResults = "1";
    empty.dataset.visible = "0";
    empty.innerHTML = "<strong>No matching settings</strong>Try a different word or category name.";
    content.appendChild(empty);

    const footer = document.createElement("footer");
    footer.className = "bcg-settings-footer";
    const saveState = document.createElement("div");
    saveState.className = "bcg-save-state";
    saveState.textContent = "Settings save automatically";
    const footerActions = document.createElement("div");
    footerActions.className = "bcg-footer-actions";
    const resetSection = makeButton("Reset section", resetActiveSection);
    resetSection.dataset.bcgResetSection = "1";
    const reload = makeButton("↻  Reload ChatGPT", () => location.reload(), true);
    reload.classList.add("bcg-reload-button");
    reload.dataset.bcgReloadButton = "1";
    reload.dataset.visible = "0";
    footerActions.append(resetSection, reload);
    footer.append(saveState, footerActions);

    main.append(header, content, footer);
    shell.append(sidebar, main);
    panel.appendChild(shell);
    panel.addEventListener("mousedown", (event) => {
      if (event.target === panel) closeSettings();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSettings();
    });
    (document.body || document.documentElement).appendChild(panel);
    setActiveSettingsSection(activeSettingsSection);
    refreshPanelValues();
    return panel;
  }


  function makeButton(text, handler, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bcg-button";
    button.textContent = text;
    if (primary) button.dataset.primary = "1";
    button.addEventListener("click", handler);
    return button;
  }

  function refreshPanelValues() {
    if (!panel?.isConnected) return;
    panel.querySelectorAll("input[data-setting-path], select[data-setting-path]").forEach((input) => {
      const field = FIELD_BY_PATH.get(input.dataset.settingPath);
      const value = getPath(input.dataset.settingPath);
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = String(value);
      const row = input.closest("[data-bcg-setting-row]");
      const output = row?.querySelector("output");
      if (output && field) {
        output.value = formatFieldValue(field, value);
        output.textContent = output.value;
      }
    });
    const report = panel.querySelector("[data-diagnostics]");
    if (report) report.textContent = JSON.stringify(diagnosticReport(), null, 2);
    updateDependentRows();
    refreshPreview();
    refreshPalette();
    updateReloadUi();
    updateExtensionStatus();
    if (settingsSearchQuery) applySettingsSearch();
  }

  function openSettings() {
    if (!panel?.isConnected) buildPanel();
    panel.dataset.open = "1";
    refreshPanelValues();
    panel.querySelector("[data-bcg-settings-search]")?.focus();
  }

  function closeSettings() {
    if (!panel) return;
    panel.dataset.open = "0";
    document.getElementById(BUTTON_ID)?.focus();
  }

  function exportSettings() {
    const blob = new Blob([JSON.stringify({ product: "Better ChatGPT", version: VERSION, settings }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `better-chatgpt-settings-${VERSION}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importSettings() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const imported = parsed?.settings || parsed;
        if (!isPlainObject(imported)) throw new TypeError("Settings JSON must contain an object.");
        replaceSettings(imported);
      } catch (error) {
        recordError("settings-import", error);
        notify(`Import failed: ${error.message}`);
      }
    });
    input.click();
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(diagnosticReport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      notify("Diagnostic report copied.");
    } catch {
      window.prompt("Copy diagnostic report:", text);
    }
  }

  function resetEverything() {
    if (!window.confirm("Reset all Better ChatGPT settings to defaults?")) return;
    replaceSettings(DEFAULTS, { announce: false });
    notify("Settings reset. Reload ChatGPT to apply everything.");
  }

  function commandMenu() {
    return document.getElementById(COMMAND_MENU_ID);
  }

  function closeCommandMenu() {
    const menu = commandMenu();
    if (menu) {
      menu.dataset.open = "0";
      menu.setAttribute("aria-hidden", "true");
    }
  }

  function positionCommandMenu() {
    const button = document.getElementById(BUTTON_ID);
    const menu = commandMenu();
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 46;
    const height = menu.offsetHeight || 276;
    const gap = 7;
    const roomAbove = rect.top - 8;
    const roomBelow = innerHeight - rect.bottom - 8;
    const opensAbove = roomAbove >= height + gap || roomBelow < height + gap;
    const centeredLeft = rect.left + (rect.width - width) / 2;
    const left = Math.min(Math.max(0, centeredLeft), Math.max(0, innerWidth - width));
    const desiredTop = opensAbove ? rect.top - gap - height : rect.bottom + gap;
    const top = Math.min(Math.max(8, desiredTop), Math.max(8, innerHeight - height - 8));
    menu.dataset.direction = opensAbove ? "above" : "below";
    menu.dataset.side = rect.left + rect.width / 2 >= innerWidth / 2 ? "right" : "left";
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function dispatchLiveSetting(path) {
    if (path.startsWith("layout.")) {
      apiObject.refreshWideMode?.();
      window.dispatchEvent(new Event("bcg:layout-refresh"));
    }
    if (path.startsWith("appearance.")) {
      apiObject.refreshPageColors?.();
      window.dispatchEvent(new Event("bcg:appearance-refresh"));
    }
  }

  function toggleQuickSetting(path) {
    const next = !getPath(path);
    updateSettings(patchForPath(path, next), { reloadRequired: false });
    dispatchLiveSetting(path);
    refreshCommandMenu();
  }

  const COMMAND_ICONS = Object.freeze({
    "wide-mode": ['<path d="M4 12h16"/>', '<path d="m8 8-4 4 4 4"/>', '<path d="m16 8 4 4-4 4"/>'],
    "page-colors": ['<path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-.7a1.5 1.5 0 0 1 0-3H15a6 6 0 0 0 0-12Z"/>', '<path d="M7.5 10.2h.01M9.4 6.8h.01M14 6.2h.01M17 9h.01"/>'],
    "bottom-vignette": ['<path d="M4 5h16v14H4z"/>', '<path d="M4 13c4-3 12-3 16 0"/>', '<path d="M4 16c4-2 12-2 16 0"/>'],
    "export-markdown": ['<path d="M12 3v12"/>', '<path d="m7 10 5 5 5-5"/>', '<path d="M5 21h14"/>'],
    settings: ['<circle cx="12" cy="12" r="3"/>', '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.36.3.58.73.6 1.2V12c-.02.47-.24.9-.6 1.2Z"/>'],
  });

  function createCommandIcon(command) {
    const svg = document.createElementNS("http:" + "//www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = (COMMAND_ICONS[command] || COMMAND_ICONS.settings).join("");
    return svg;
  }

  function makeCommandButton(label, command, handler, togglePath = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.bcgCommand = command;
    button.dataset.togglePath = togglePath;
    button.dataset.tooltip = label;
    button.dataset.bcgUiControl = "1";
    button.setAttribute("aria-label", label);
    button.setAttribute("role", "menuitem");
    const state = document.createElement("span");
    state.className = "bcg-command-state";
    state.setAttribute("aria-hidden", "true");
    button.append(createCommandIcon(command), state);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
      if (!togglePath) closeCommandMenu();
    });
    return button;
  }

  function refreshCommandMenu() {
    const menu = commandMenu();
    if (!menu) return;
    menu.querySelectorAll("[data-toggle-path]").forEach((button) => {
      const path = button.dataset.togglePath;
      if (!path) return;
      const enabled = Boolean(getPath(path));
      button.setAttribute("aria-pressed", String(enabled));
      button.dataset.enabled = enabled ? "1" : "0";
    });
    positionCommandMenu();
  }

  function buildCommandMenu() {
    let menu = commandMenu();
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = COMMAND_MENU_ID;
    menu.dataset.open = "0";
    menu.dataset.side = "right";
    menu.dataset.direction = "above";
    menu.dataset.bcgUiControl = "1";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Better ChatGPT quick actions");
    menu.setAttribute("aria-hidden", "true");
    menu.append(
      makeCommandButton("Wide mode", "wide-mode", () => toggleQuickSetting("layout.wideMode"), "layout.wideMode"),
      makeCommandButton("Custom page colors", "page-colors", () => toggleQuickSetting("appearance.pageColorsEnabled"), "appearance.pageColorsEnabled"),
      makeCommandButton("Bottom vignette", "bottom-vignette", () => toggleQuickSetting("appearance.bottomVignette"), "appearance.bottomVignette"),
    );
    const separator = document.createElement("div");
    separator.className = "bcg-command-separator";
    separator.setAttribute("role", "separator");
    menu.append(
      separator,
      makeCommandButton("Export conversation as Markdown", "export-markdown", exportConversationMarkdown),
      makeCommandButton("Open settings", "settings", openSettings),
    );
    (document.body || document.documentElement).appendChild(menu);
    refreshCommandMenu();
    return menu;
  }

  function toggleCommandMenu() {
    const menu = buildCommandMenu();
    const opening = menu.dataset.open !== "1";
    menu.dataset.open = opening ? "1" : "0";
    menu.setAttribute("aria-hidden", opening ? "false" : "true");
    if (opening) {
      refreshCommandMenu();
      menu.querySelector("button")?.focus({ preventScroll: true });
    }
  }

  const LAUNCHER_VIEWPORT_MARGIN = 8;

  function launcherPositionFromRatio(ratio, viewportSize, launcherSize) {
    const travel = Math.max(0, viewportSize - launcherSize - LAUNCHER_VIEWPORT_MARGIN * 2);
    return LAUNCHER_VIEWPORT_MARGIN + Math.min(1, Math.max(0, ratio)) * travel;
  }

  function launcherRatioFromPosition(position, viewportSize, launcherSize) {
    const travel = Math.max(0, viewportSize - launcherSize - LAUNCHER_VIEWPORT_MARGIN * 2);
    if (travel <= 0) return 0;
    return Math.min(1, Math.max(0, (position - LAUNCHER_VIEWPORT_MARGIN) / travel));
  }

  function applyLauncherPosition({ migrate = false } = {}) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    const size = button.getBoundingClientRect();
    const hasPixelPosition = settings.ui.launcherX >= 0 && settings.ui.launcherY >= 0;
    const hasRelativePosition = settings.ui.launcherXRatio >= 0 && settings.ui.launcherYRatio >= 0;
    if (hasPixelPosition || hasRelativePosition) {
      const x = hasRelativePosition
        ? launcherPositionFromRatio(settings.ui.launcherXRatio, innerWidth, size.width)
        : Math.min(
          Math.max(LAUNCHER_VIEWPORT_MARGIN, settings.ui.launcherX),
          Math.max(LAUNCHER_VIEWPORT_MARGIN, innerWidth - size.width - LAUNCHER_VIEWPORT_MARGIN),
        );
      const y = hasRelativePosition
        ? launcherPositionFromRatio(settings.ui.launcherYRatio, innerHeight, size.height)
        : Math.min(
          Math.max(LAUNCHER_VIEWPORT_MARGIN, settings.ui.launcherY),
          Math.max(LAUNCHER_VIEWPORT_MARGIN, innerHeight - size.height - LAUNCHER_VIEWPORT_MARGIN),
        );
      button.style.left = `${Math.round(x)}px`;
      button.style.top = `${Math.round(y)}px`;
      button.style.right = "auto";
      button.style.bottom = "auto";

      if (migrate && !hasRelativePosition && hasPixelPosition) {
        updateSettings({
          ui: {
            launcherX: settings.ui.launcherX,
            launcherY: settings.ui.launcherY,
            launcherXRatio: launcherRatioFromPosition(x, innerWidth, size.width),
            launcherYRatio: launcherRatioFromPosition(y, innerHeight, size.height),
          },
        }, { reloadRequired: false, preserveProfile: true });
      }
    }
    positionCommandMenu();
  }

  function installLauncherDrag(button) {
    let drag = null;
    let suppressClickUntil = 0;
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false,
      };
      try { button.setPointerCapture(event.pointerId); } catch {}
    });
    const move = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.moved && distance < 4) return;
      drag.moved = true;
      button.dataset.dragging = "1";
      closeCommandMenu();
      const rect = button.getBoundingClientRect();
      const x = Math.min(Math.max(8, event.clientX - drag.offsetX), Math.max(8, innerWidth - rect.width - 8));
      const y = Math.min(Math.max(8, event.clientY - drag.offsetY), Math.max(8, innerHeight - rect.height - 8));
      button.style.left = `${Math.round(x)}px`;
      button.style.top = `${Math.round(y)}px`;
      button.style.right = "auto";
      button.style.bottom = "auto";
      event.preventDefault();
    };
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) {
        const rect = button.getBoundingClientRect();
        suppressClickUntil = performance.now() + 250;
        updateSettings({
          ui: {
            launcherX: Math.round(rect.left),
            launcherY: Math.round(rect.top),
            launcherXRatio: launcherRatioFromPosition(rect.left, innerWidth, rect.width),
            launcherYRatio: launcherRatioFromPosition(rect.top, innerHeight, rect.height),
          },
        }, { reloadRequired: false, preserveProfile: true });
      }
      button.dataset.dragging = "0";
      try { button.releasePointerCapture(event.pointerId); } catch {}
      drag = null;
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    button.addEventListener("click", (event) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      toggleCommandMenu();
    });
  }

  function markdownText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[\u200b\u2060\ufeff]/g, "");
  }

  function serializeTableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"));
    if (!rows.length) return "";
    const cells = rows.map((row) => Array.from(row.children).map((cell) =>
      markdownText(cell.innerText || cell.textContent).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"),
    ));
    const width = Math.max(...cells.map((row) => row.length));
    const normalize = (row) => Array.from({ length: width }, (_, index) => row[index] || "");
    const output = [normalize(cells[0]), Array(width).fill("---"), ...cells.slice(1).map(normalize)];
    return `${output.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
  }

  function serializeListToMarkdown(list, depth = 0) {
    const ordered = list.tagName === "OL";
    return Array.from(list.children).filter((node) => node.tagName === "LI").map((item, index) => {
      const clone = item.cloneNode(true);
      clone.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => nested.remove());
      const body = serializeNodeToMarkdown(clone, { inline: true }).replace(/\s+/g, " ").trim();
      const prefix = ordered ? `${index + 1}.` : "-";
      const nested = Array.from(item.children).filter((node) => node.matches("ul,ol"))
        .map((node) => serializeListToMarkdown(node, depth + 1)).join("");
      const indent = "  ".repeat(depth);
      return `${indent}${prefix} ${body}\n${nested}`;
    }).join("") + (depth === 0 ? "\n" : "");
  }

  function serializeNodeToMarkdown(node, context = {}) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return markdownText(node.nodeValue);
    if (!(node instanceof Element)) return "";
    if (node.matches("script,style,noscript,svg,canvas,button,input,select,form,[aria-hidden=\"true\"],[hidden]")) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${serializeNodeToMarkdownChildren(node).trim()}\n\n`;
    if (tag === "PRE") {
      const code = node.querySelector("code") || node;
      const language = Array.from(code.classList || []).map((name) => /(?:language-|lang-)([\w+-]+)/.exec(name)?.[1]).find(Boolean) || "";
      return `\`\`\`${language}\n${markdownText(code.textContent).replace(/^\n|\n$/g, "")}\n\`\`\`\n\n`;
    }
    if (tag === "CODE") {
      const text = markdownText(node.textContent);
      const fence = text.includes("`") ? "``" : "`";
      return `${fence}${text}${fence}`;
    }
    if (tag === "A") {
      const text = serializeNodeToMarkdownChildren(node).trim() || markdownText(node.getAttribute("aria-label"));
      const href = node.href || node.getAttribute("href") || "";
      return href && !href.startsWith("javascript:") ? `[${text || href}](${href})` : text;
    }
    if (tag === "IMG") {
      const src = node.currentSrc || node.src || "";
      return src && !src.startsWith("blob:") ? `![${markdownText(node.alt)}](${src})` : "";
    }
    if (tag === "STRONG" || tag === "B") return `**${serializeNodeToMarkdownChildren(node).trim()}**`;
    if (tag === "EM" || tag === "I") return `*${serializeNodeToMarkdownChildren(node).trim()}*`;
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") return `~~${serializeNodeToMarkdownChildren(node).trim()}~~`;
    if (tag === "BLOCKQUOTE") return `${serializeNodeToMarkdownChildren(node).trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    if (tag === "UL" || tag === "OL") return serializeListToMarkdown(node);
    if (tag === "TABLE") return serializeTableToMarkdown(node);
    if (tag === "HR") return "---\n\n";
    const content = serializeNodeToMarkdownChildren(node);
    if (context.inline) return content;
    if (["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DETAILS", "SUMMARY"].includes(tag)) {
      return content.trim() ? `${content.trim()}\n\n` : "";
    }
    return content;
  }

  function serializeNodeToMarkdownChildren(node) {
    return Array.from(node.childNodes).map((child) => serializeNodeToMarkdown(child)).join("");
  }

  function collectConversationMarkdown() {
    const seen = new Set();
    const turns = [];
    for (const roleNode of document.querySelectorAll("[data-message-author-role]")) {
      const role = roleNode.getAttribute("data-message-author-role") || "unknown";
      const turn = roleNode.closest('[data-testid^="conversation-turn-"], article') || roleNode;
      if (seen.has(turn)) continue;
      seen.add(turn);
      const source = roleNode.querySelector('[data-testid="user-message"], .markdown, [data-message-content]') || roleNode;
      const body = serializeNodeToMarkdown(source).replace(/\n{3,}/g, "\n\n").trim();
      if (!body) continue;
      const label = role === "user" ? "You" : role === "assistant" ? "ChatGPT" : role[0].toUpperCase() + role.slice(1);
      turns.push(`## ${label}\n\n${body}`);
    }
    return turns;
  }

  async function exportConversationMarkdown() {
    const title = (document.title || "ChatGPT conversation").replace(/\s*[|–-]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation";
    const turns = collectConversationMarkdown();
    if (!turns.length) {
      notify("No conversation messages found to export.");
      return null;
    }
    const markdown = `# ${title}\n\n> Exported from ChatGPT on ${new Date().toLocaleString()}\n\n${turns.join("\n\n---\n\n")}\n`;
    const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "chatgpt-conversation";
    const filename = `${safeTitle}.md`;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Exported ${turns.length} messages as Markdown.`);
    return { filename, markdown, turns: turns.length };
  }

  function installLauncher() {
    injectShellStyles();
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.dataset.bcgUiControl = "1";
    button.title = "Better ChatGPT quick actions (drag to move)";
    button.setAttribute("aria-label", "Open Better ChatGPT quick actions; drag to move");
    button.textContent = "B+";
    (document.body || document.documentElement).appendChild(button);
    buildCommandMenu();
    installLauncherDrag(button);
    applyLauncherPosition({ migrate: true });
    window.addEventListener("resize", applyLauncherPosition, { passive: true });
    document.addEventListener("pointerdown", (event) => {
      const menu = commandMenu();
      if (menu?.dataset.open === "1" && !menu.contains(event.target) && event.target !== button) closeCommandMenu();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeCommandMenu();
    }, true);
  }

  function registerUserscriptMenus() {
    const register = globalThis.GM_registerMenuCommand || globalThis.GM?.registerMenuCommand;
    if (typeof register !== "function") return;
    const add = (label, callback) => {
      try {
        register(label, callback);
      } catch (error) {
        recordError("userscript-menu", error);
      }
    };
    add("Better ChatGPT: Open settings", openSettings);
    add("Better ChatGPT: Enable/disable", () => {
      updateSettings({ enabled: !settings.enabled });
      location.reload();
    });
    add("Better ChatGPT: Export conversation as Markdown", exportConversationMarkdown);
    add("Better ChatGPT: Export settings", exportSettings);
    add("Better ChatGPT: Copy diagnostics", copyDiagnostics);
    add("Better ChatGPT: Reset settings", resetEverything);
  }

  function installExtensionMessaging() {
    const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
    if (!api?.runtime?.onMessage) return;
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const command = message?.type;
      if (command === "bcg:get-status") sendResponse({ ok: true, status: getStatus() });
      else if (command === "bcg:open-settings") {
        openSettings();
        sendResponse({ ok: true });
      } else if (command === "bcg:toggle-enabled") {
        updateSettings({ enabled: !settings.enabled });
        sendResponse({ ok: true, status: getStatus() });
      } else if (command === "bcg:toggle-tab") {
        setTabDisabled(!isTabDisabled());
        sendResponse({ ok: true });
      } else if (command === "bcg:reload") {
        location.reload();
        sendResponse({ ok: true });
      } else if (command === "bcg:diagnostics") {
        sendResponse({ ok: true, report: diagnosticReport() });
      } else {
        sendResponse({ ok: false, error: "Unknown Better ChatGPT command." });
      }
      return true;
    });
  }

  function installGlobalGuards() {
    window.addEventListener("error", (event) => {
      // Chromium reports ResizeObserver delivery-cycle warnings as window-level
      // ErrorEvents. They are browser scheduling diagnostics, not actionable
      // Better ChatGPT exceptions, and debug mode would otherwise misattribute
      // them to our global catcher.
      if (isBenignResizeObserverWindowError(event)) return;
      if (!String(event.filename || "").includes("better-chatgpt") && !settings.advanced.debug) return;
      recordError("window", event.error || new Error(event.message));
    });
    window.addEventListener("unhandledrejection", (event) => {
      recordError("promise", event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
    });
  }

  const apiObject = {
    version: VERSION,
    defaults: DEFAULTS,
    editAttachmentsAvailable: EDIT_ATTACHMENTS_AVAILABLE,
    get settings() {
      return settings;
    },
    set settings(value) {
      settings = value;
    },
    updateSettings,
    replaceSettings,
    applyProfile,
    isFeatureEnabled,
    isTabDisabled,
    setTabDisabled,
    getReadableTextColor,
    getBubbleTextColor,
    notify,
    recordError,
    recordTrace,
    getStatus,
    diagnosticReport,
    openSettings,
    closeSettings,
    exportSettings,
    exportConversationMarkdown,
    serializeNodeToMarkdown,
    copyDiagnostics,
    resetEverything,
  };

  globalThis.BetterChatGPT = apiObject;
  globalThis.__BCG_SETTINGS__ = settings;

  function initialize() {
    installLauncher();
    buildPanel();
    registerUserscriptMenus();
    installExtensionMessaging();
    installGlobalGuards();
    installSyncChangeListener();
    void syncRead();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const CONTENT_SOURCE = "better-chatgpt-content";
  const PAGE_SOURCE = "better-chatgpt-page";
  const PENDING_ATTRIBUTE = "data-bcg-edit-submit-attachments";
  const STAGE_TIMEOUT_MS = 90000;
  const SUBMIT_TIMEOUT_MS = 120000;
  const pendingUploads = new Map();
  const submitListeners = new Map();
  const submitTimers = new Map();
  const metadataWaiters = new Map();
  const attachmentMetadataById = new Map();
  const attachmentMetadataByFile = new Map();
  let sequence = 0;
  let bridgeReady = false;

  function requestId(prefix) {
    sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function textFingerprint(text) {
    const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
    return { length: normalized.length, hash: fnv1a(normalized) };
  }

  function post(type, payload = {}) {
    window.postMessage({ source: CONTENT_SOURCE, type, ...payload }, "*");
  }

  function attachmentMetadataComplete(attachment) {
    if (!attachment?.id || !attachment?.name) return false;
    return attachment.source !== "library" || Boolean(attachment.library_file_id);
  }

  function uploadedFileMetadataComplete(attachment) {
    return Boolean(attachment?.id && attachment?.name);
  }

  function attachmentFileKey(value) {
    const name = String(value?.name || value?.file_name || "").trim().toLowerCase();
    const size = Number(value?.size ?? value?.size_bytes ?? 0) || 0;
    return name ? `${name}\u0000${size}` : "";
  }

  function attachmentForFile(file) {
    if (!(file instanceof File)) return null;
    const attachment = attachmentMetadataByFile.get(attachmentFileKey(file));
    if (!uploadedFileMetadataComplete(attachment)) return null;
    const mimeType = String(attachment.mime_type || "");
    return {
      ...attachment,
      name: String(attachment.name || file.name),
      size: Number(attachment.size ?? file.size ?? 0) || 0,
      mime_type:
        !mimeType || mimeType === "application/octet-stream"
          ? String(file.type || mimeType || "application/octet-stream")
          : mimeType,
    };
  }

  function attachmentForId(fileId) {
    const attachment = attachmentMetadataById.get(String(fileId || ""));
    return attachmentMetadataComplete(attachment) ? { ...attachment } : null;
  }

  function resolveMetadataWaiters(fileId) {
    const attachment = attachmentMetadataById.get(String(fileId || ""));
    if (!attachmentMetadataComplete(attachment)) return;
    for (const [requestIdValue, waiter] of metadataWaiters) {
      if (waiter.id !== attachment.id) continue;
      metadataWaiters.delete(requestIdValue);
      window.clearTimeout(waiter.timer);
      waiter.resolve({ ...attachment });
    }
  }

  function rememberAttachmentMetadata(attachment) {
    if (!attachment?.id) return null;
    const id = String(attachment.id);
    const merged = { ...(attachmentMetadataById.get(id) || {}), ...attachment, id };
    attachmentMetadataById.set(id, merged);
    const fileKey = attachmentFileKey(merged);
    if (fileKey) attachmentMetadataByFile.set(fileKey, merged);
    resolveMetadataWaiters(id);
    return merged;
  }

  function lookupAttachment(fileId, { timeoutMs = 5000 } = {}) {
    const id = String(fileId || "");
    if (!id) return Promise.resolve(null);
    const cached = attachmentMetadataById.get(id);
    if (attachmentMetadataComplete(cached)) return Promise.resolve({ ...cached });
    const requestIdValue = requestId("attachment-metadata");
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        metadataWaiters.delete(requestIdValue);
        resolve(attachmentMetadataById.get(id) || null);
      }, timeoutMs);
      metadataWaiters.set(requestIdValue, { id, resolve, timer });
      post("bcg:attachment-metadata-lookup", { requestId: requestIdValue, fileId: id });
    });
  }

  function mainPrompt() {
    const candidates = [
      document.querySelector("#prompt-textarea"),
      document.querySelector('[data-testid="prompt-textarea"]'),
      ...document.querySelectorAll('textarea[placeholder*="message" i], [contenteditable="true"][data-lexical-editor="true"]'),
    ];
    return candidates.find(
      (candidate) => candidate instanceof Element && !candidate.closest('.bcg-edit-enhanced, [data-testid*="edit" i]'),
    ) || null;
  }

  function mainComposerRoot() {
    const prompt = mainPrompt();
    return (
      prompt?.closest('form, [data-testid="composer-root"], [class*="composer" i]') ||
      document.querySelector('[data-testid="composer-root"]') ||
      document.querySelector('form[data-testid*="composer" i]:not([data-testid*="edit" i])') ||
      prompt?.parentElement ||
      null
    );
  }

  function fileInputScore(input, root, prompt) {
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.isConnected) return -Infinity;
    if (input.closest('.bcg-edit-enhanced, [data-testid*="edit" i]')) return -Infinity;
    let score = 0;
    if (root?.contains(input)) score += 500;
    if (prompt?.closest("form")?.contains(input)) score += 400;
    if (input.closest('[data-testid="composer-root"]')) score += 300;
    if (input.multiple) score += 30;
    if (input.accept) score += 20;
    const bits = `${input.getAttribute("aria-label") || ""} ${input.getAttribute("data-testid") || ""} ${input.className || ""}`;
    if (/file|upload|attach|image/i.test(bits)) score += 40;
    if (input.closest("nav, header, aside")) score -= 500;
    return score;
  }

  function findMainComposerFileInput() {
    const prompt = mainPrompt();
    const root = mainComposerRoot();
    const candidates = Array.from(new Set([
      ...(root ? root.querySelectorAll('input[type="file"]') : []),
      ...document.querySelectorAll('input[type="file"]'),
    ]));
    return candidates
      .map((input) => ({ input, score: fileInputScore(input, root, prompt) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score)[0]?.input || null;
  }

  function attachmentRemoveButtons(root = document) {
    return Array.from(
      root.querySelectorAll(
        [
          'button[aria-label*="remove file" i]',
          'button[aria-label*="remove attachment" i]',
          'button[aria-label^="remove " i]',
          'button[title*="remove file" i]',
          'button[title*="remove attachment" i]',
          'button[title^="remove " i]',
        ].join(","),
      ),
    ).filter((button) => !button.closest('.bcg-edit-enhanced, [data-testid*="edit" i]'));
  }

  function buttonMentionsFile(button, fileName) {
    const name = String(fileName || "").toLowerCase();
    const container = button.closest(
      '[data-testid*="file" i], [data-testid*="attachment" i], [class*="file-preview" i], [class*="attachment" i], li, div',
    );
    const text = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent,
      container?.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return Boolean(name && text.includes(name));
  }

  function snapshotInput(input) {
    return {
      files: Array.from(input.files || []),
      disabled: input.disabled,
      disabledAttribute: input.hasAttribute("disabled"),
      ariaDisabled: input.getAttribute("aria-disabled"),
      dataDisabled: input.getAttribute("data-disabled"),
    };
  }

  function createTransfer(files) {
    if (typeof DataTransfer !== "function") return null;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    return transfer;
  }

  function restoreInput(input, snapshot) {
    if (!(input instanceof HTMLInputElement) || !input.isConnected || !snapshot) return;
    const transfer = createTransfer(snapshot.files);
    try {
      if (transfer) input.files = transfer.files;
      else input.value = "";
    } catch {
      input.value = "";
    }
    input.disabled = snapshot.disabled;
    if (snapshot.disabledAttribute) input.setAttribute("disabled", "");
    else input.removeAttribute("disabled");
    if (snapshot.ariaDisabled === null) input.removeAttribute("aria-disabled");
    else input.setAttribute("aria-disabled", snapshot.ariaDisabled);
    if (snapshot.dataDisabled === null) input.removeAttribute("data-disabled");
    else input.setAttribute("data-disabled", snapshot.dataDisabled);
  }

  function injectIntoMainComposer(pending) {
    const input = findMainComposerFileInput();
    if (!input) throw new Error("ChatGPT's regular composer uploader was not found.");
    if ((input.files?.length || 0) > 0) {
      throw new Error("ChatGPT's regular composer file input is busy; clear its pending attachment first.");
    }

    const root = mainComposerRoot() || document;
    const existingAttachments = attachmentRemoveButtons(root);
    if (existingAttachments.length > 0) {
      throw new Error("The regular composer already contains an attachment; clear or send it before staging an edit attachment.");
    }

    const transfer = createTransfer([pending.file]);
    if (!transfer) throw new Error("This browser cannot create a native FileList for ChatGPT.");

    pending.input = input;
    pending.inputSnapshot = snapshotInput(input);
    pending.removeButtonsBefore = new Set(attachmentRemoveButtons(document));

    input.disabled = false;
    input.removeAttribute("disabled");
    input.removeAttribute("aria-disabled");
    input.removeAttribute("data-disabled");
    input.value = "";
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    queueMicrotask(() => restoreInput(input, pending.inputSnapshot));
  }

  async function imageDimensions(file) {
    if (!String(file.type || "").toLowerCase().startsWith("image/")) return {};
    if (typeof createImageBitmap !== "function") return {};
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch {
      return {};
    }
  }

  function findNewRemoveButton(pending) {
    const buttons = attachmentRemoveButtons(document).filter((button) => !pending.removeButtonsBefore?.has(button));
    return buttons.find((button) => buttonMentionsFile(button, pending.file.name)) ||
      ((pending.removeButtonsBefore?.size || 0) === 0 && buttons.length === 1 ? buttons[0] : null);
  }

  function cleanupMainComposerAttachment(pending) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let clicked = false;

      const poll = () => {
        const button = findNewRemoveButton(pending);
        if (button && !clicked) {
          clicked = true;
          button.click();
        }

        const stillPresent = attachmentRemoveButtons(document).some(
          (candidate) => !pending.removeButtonsBefore?.has(candidate) && buttonMentionsFile(candidate, pending.file.name),
        );
        if (clicked && !stillPresent) {
          restoreInput(pending.input, pending.inputSnapshot);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 6000) {
          restoreInput(pending.input, pending.inputSnapshot);
          reject(
            new Error(
              clicked
                ? "The staged attachment could not be removed from ChatGPT's regular composer."
                : "ChatGPT uploaded the file, but its regular-composer attachment chip was not found for safe cleanup.",
            ),
          );
          return;
        }
        window.setTimeout(poll, 100);
      };

      poll();
    });
  }

  async function uploadFile(file) {
    if (!(file instanceof File)) throw new TypeError("Edit attachment was not a File.");
    if (!bridgeReady) throw new Error("The native edit attachment bridge is not ready.");

    const id = requestId("native-stage");
    const dimensions = await imageDimensions(file);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const pending = pendingUploads.get(id);
        pendingUploads.delete(id);
        post("bcg:native-stage-cancel", { requestId: id });
        restoreInput(pending?.input, pending?.inputSnapshot);
        reject(new Error("ChatGPT's native Library upload timed out."));
      }, STAGE_TIMEOUT_MS);

      pendingUploads.set(id, {
        file,
        resolve,
        reject,
        timeout,
        dimensions,
        input: null,
        inputSnapshot: null,
        removeButtonsBefore: null,
        injected: false,
      });
      post("bcg:native-stage-start", {
        requestId: id,
        file: {
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          lastModified: file.lastModified,
          ...dimensions,
        },
      });
    });
  }

  function armSubmit(text, attachments, onResult) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;
    const nonce = requestId("submit");
    const payload = {
      nonce,
      expiresAt: Date.now() + SUBMIT_TIMEOUT_MS,
      textFingerprint: textFingerprint(text),
      attachments,
    };
    document.documentElement?.setAttribute(PENDING_ATTRIBUTE, JSON.stringify(payload));
    if (typeof onResult === "function") submitListeners.set(nonce, onResult);
    const timer = window.setTimeout(() => {
      const listener = submitListeners.get(nonce);
      clearSubmit(nonce);
      listener?.({ nonce, ok: false, status: 0, error: "Timed out waiting for ChatGPT's edited-message request." });
    }, SUBMIT_TIMEOUT_MS + 100);
    submitTimers.set(nonce, timer);
    BCG.recordTrace?.("edit-submit-armed", { attachmentCount: attachments.length });
    return nonce;
  }

  function clearSubmit(nonce) {
    const root = document.documentElement;
    if (!root) return;
    try {
      const current = JSON.parse(root.getAttribute(PENDING_ATTRIBUTE) || "null");
      if (!nonce || current?.nonce === nonce) root.removeAttribute(PENDING_ATTRIBUTE);
    } catch {
      root.removeAttribute(PENDING_ATTRIBUTE);
    }
    if (nonce) {
      submitListeners.delete(nonce);
      const timer = submitTimers.get(nonce);
      if (timer) window.clearTimeout(timer);
      submitTimers.delete(nonce);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    if (event.data.type === "bcg:bridge-ready") {
      const becameReady = !bridgeReady;
      bridgeReady = true;
      if (becameReady) window.dispatchEvent(new Event("bcg:edit-bridge-ready"));
      return;
    }
    if (event.data.type === "bcg:bridge-trace") {
      BCG.recordTrace?.(event.data.event, event.data.metadata || {});
      return;
    }
    if (event.data.type === "bcg:attachment-metadata") {
      rememberAttachmentMetadata(event.data.attachment);
      return;
    }
    if (event.data.type === "bcg:attachment-metadata-result") {
      const waiter = metadataWaiters.get(event.data.requestId);
      const attachment = rememberAttachmentMetadata(event.data.attachment);
      if (!waiter || !attachmentMetadataComplete(attachment)) return;
      metadataWaiters.delete(event.data.requestId);
      window.clearTimeout(waiter.timer);
      waiter.resolve({ ...attachment });
      return;
    }
    if (event.data.type === "bcg:conversation-request-seen") {
      window.dispatchEvent(new CustomEvent("bcg:conversation-request-seen", {
        detail: event.data.fingerprint || null,
      }));
      return;
    }
    if (event.data.type === "bcg:native-stage-ready") {
      const pending = pendingUploads.get(event.data.requestId);
      if (!pending || pending.injected) return;
      try {
        pending.injected = true;
        injectIntoMainComposer(pending);
        BCG.recordTrace?.("native-input-dispatched", { transport: "dom", stage: "input-change" });
      } catch (error) {
        pendingUploads.delete(event.data.requestId);
        clearTimeout(pending.timeout);
        post("bcg:native-stage-cancel", { requestId: event.data.requestId });
        restoreInput(pending.input, pending.inputSnapshot);
        pending.reject(error);
      }
      return;
    }
    if (event.data.type === "bcg:native-stage-result") {
      const pending = pendingUploads.get(event.data.requestId);
      if (!pending) return;
      pendingUploads.delete(event.data.requestId);
      clearTimeout(pending.timeout);
      if (!event.data.ok || !event.data.attachment) {
        restoreInput(pending.input, pending.inputSnapshot);
        pending.reject(new Error(event.data.error || "ChatGPT rejected the native Library upload."));
        return;
      }
      const attachment = rememberAttachmentMetadata({ ...event.data.attachment, ...pending.dimensions });
      void cleanupMainComposerAttachment(pending)
        .then(() => pending.resolve(attachment))
        .catch((error) => pending.reject(error));
      return;
    }
    if (event.data.type === "bcg:edit-submit-result") {
      const listener = submitListeners.get(event.data.nonce);
      clearSubmit(event.data.nonce);
      listener?.(event.data);
    }
  });

  post("bcg:bridge-ping", { requestId: requestId("ping") });

  globalThis.BetterChatGPT.editAttachmentBridge = {
    uploadFile,
    lookupAttachment,
    attachmentForFile,
    attachmentForId,
    armSubmit,
    clearSubmit,
    isReady: () => bridgeReady,
  };
})();

/*
 * Width interpolation is adapted from ChatGPT Widescreen by Adam Lui and
 * contributors, used under the MIT License. Better ChatGPT intentionally
 * ports only the wide transcript/composer sizing behavior.
 */
(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const STYLE_ID = "better-chatgpt-wide-mode";
  const ROOT_ATTRIBUTE = "data-bcg-wide-mode";
  const PROMPT_SELECTOR = '#prompt-textarea, [data-testid="prompt-textarea"]';
  const CONVERSATION_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const CONVERSATION_ATTRIBUTE = "data-bcg-wide-conversation";
  const COMPOSER_HOST_CLASS = "bcg-wide-composer-host";
  const COMPOSER_ROOT_CLASS = "bcg-wide-composer-root";
  const RESIZE_SETTLE_MS = 180;
  const UI_CONTROL_SELECTOR = "[data-bcg-ui-control], [data-bcg-composer-control]";
  const INTERACTIVE_OVERLAY_SELECTOR = [
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="dialog"]',
    '[data-radix-popper-content-wrapper]',
    '[data-headlessui-portal]',
    '[data-floating-ui-portal]',
    '[popover]',
  ].join(",");
  let refreshQueued = false;
  let resizeObserver = null;
  let observedConversationHost = null;
  let observedComposerHost = null;
  let markedConversations = [];
  let markedComposerHost = null;
  let markedComposerRoot = null;
  let measuredConversations = [];
  let measuredComposerHost = null;
  let widthRange = null;
  let measurementsDirty = true;
  let settledRemeasureTimer = null;
  let resetRangeAfterResize = false;
  let preserveWidestMeasurement = false;

  const CSS = `
html[${ROOT_ATTRIBUTE}="1"] [${CONVERSATION_ATTRIBUTE}] {
  width: 100% !important;
  max-width: min(var(--bcg-conversation-width), calc(100% - 24px)) !important;
  margin-inline: auto !important;
}

html[${ROOT_ATTRIBUTE}="1"] .${COMPOSER_HOST_CLASS} {
  box-sizing: border-box !important;
  width: min(var(--bcg-composer-width), calc(100% - 24px)) !important;
  max-width: min(var(--bcg-composer-width), calc(100% - 24px)) !important;
  margin-inline: auto !important;
  align-self: center !important;
}

html[${ROOT_ATTRIBUTE}="1"] .${COMPOSER_ROOT_CLASS} {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  margin-inline: 0 !important;
  align-self: stretch !important;
}

:is(main, [role="main"]) :is(
  .${COMPOSER_HOST_CLASS},
  .${COMPOSER_ROOT_CLASS},
  ${PROMPT_SELECTOR}
) {
  pointer-events: auto !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(main, [role="main"]) div[class*="tableContainer"] {
  width: auto !important;
  margin-inline: 0 !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(main, [role="main"]) div[class*="tableWrapper"] {
  max-width: 100% !important;
  margin-inline: 0 !important;
}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function findPrompt() {
    return document.querySelector(PROMPT_SELECTOR);
  }

  function findComposerRoot(prompt = findPrompt()) {
    if (!(prompt instanceof Element)) return null;
    return prompt.closest("form") || prompt.closest('[data-testid="composer-root"]');
  }

  function findComposerWidthHost(composer) {
    if (!(composer instanceof HTMLElement)) return null;
    const main = composer.closest("main, [role=main]");
    let candidate = composer;
    let node = composer.parentElement;

    while (node && node !== main && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const parentRect = node.parentElement?.getBoundingClientRect?.();
      if (
        rect.width > 100
        && parentRect?.width > rect.width + 20
        && rect.width <= Math.max(composer.getBoundingClientRect().width + 12, 2400)
      ) {
        candidate = node;
        break;
      }
      node = node.parentElement;
    }
    return candidate;
  }

  function markComposerTargets(composer) {
    const host = findComposerWidthHost(composer) || composer;
    if (markedComposerHost !== host) {
      markedComposerHost?.classList.remove(COMPOSER_HOST_CLASS);
      markedComposerHost = host;
      markedComposerHost?.classList.add(COMPOSER_HOST_CLASS);
      measurementsDirty = true;
    }
    if (markedComposerRoot !== composer) {
      markedComposerRoot?.classList.remove(COMPOSER_ROOT_CLASS);
      markedComposerRoot = composer;
      markedComposerRoot?.classList.add(COMPOSER_ROOT_CLASS);
    }
    return host;
  }

  function addConversationWrapper(wrappers, wrapper, prompt) {
    if (!(wrapper instanceof HTMLElement)) return;
    if (prompt && wrapper.contains(prompt)) return;
    if (!wrappers.includes(wrapper)) wrappers.push(wrapper);
  }

  function wrapperInsideConversationTurn(turn, prompt) {
    if (!(turn instanceof Element)) return null;
    const textBase = turn.matches("div.text-base")
      ? turn
      : Array.from(turn.querySelectorAll("div.text-base")).find((candidate) => !(prompt && candidate.contains(prompt)));
    if (!(textBase instanceof HTMLElement)) return null;

    const direct = Array.from(textBase.children).find((child) => (
      child instanceof HTMLElement
      && !(prompt && child.contains(prompt))
      && !child.matches('[data-testid="thread-disclaimer"]')
    ));
    return direct || textBase;
  }

  function findConversationWrappers() {
    const prompt = findPrompt();
    const wrappers = [];

    // Current ChatGPT mounts the conversation-turn shell before the final
    // assistant message exists. Activity/tool-working UI lives in that shell,
    // so discover it directly instead of waiting for data-message-author-role.
    for (const turn of document.querySelectorAll(CONVERSATION_TURN_SELECTOR)) {
      addConversationWrapper(wrappers, wrapperInsideConversationTurn(turn, prompt), prompt);
    }

    // Fallback for older/alternate layouts that do not expose conversation-turn
    // test IDs but still expose author-role nodes.
    for (const turn of document.querySelectorAll("[data-message-author-role]")) {
      let node = turn;
      while (
        node.parentElement
        && !node.parentElement.matches("div.text-base")
        && !node.parentElement.matches("main, [role=main]")
      ) {
        node = node.parentElement;
      }
      if (!node.parentElement?.matches("div.text-base")) continue;
      addConversationWrapper(wrappers, node, prompt);
    }
    return wrappers;
  }

  function sameElements(left, right) {
    return left.length === right.length && left.every((node, index) => node === right[index]);
  }

  function markConversationTargets(conversations) {
    if (!sameElements(markedConversations, conversations)) {
      for (const conversation of markedConversations) {
        conversation.removeAttribute(CONVERSATION_ATTRIBUTE);
      }
      markedConversations = conversations;
      for (const conversation of markedConversations) {
        conversation.setAttribute(CONVERSATION_ATTRIBUTE, "1");
      }
      measurementsDirty = true;
    }
    return markedConversations;
  }

  function renderedWidth(element, fallback = 768) {
    const width = element?.getBoundingClientRect?.().width || 0;
    return width > 100 ? width : fallback;
  }

  function renderedConversationWidth(conversations, fallback = 768) {
    const widths = conversations
      .map((conversation) => conversation?.getBoundingClientRect?.().width || 0)
      .filter((width) => width > 100);
    return widths.length ? Math.max(...widths) : fallback;
  }

  function measureRenderedWidthRange(root, conversations, composerHost) {
    if (
      !measurementsDirty
      && widthRange
      && sameElements(measuredConversations, conversations)
      && measuredComposerHost === composerHost
    ) return widthRange;

    const previousRange = widthRange;
    root.setAttribute(ROOT_ATTRIBUTE, "0");
    root.style.removeProperty("--bcg-conversation-width");
    root.style.removeProperty("--bcg-composer-width");
    const nativeConversation = renderedConversationWidth(conversations, renderedWidth(composerHost));
    const nativeComposer = renderedWidth(composerHost, nativeConversation);

    // Measure the actual CSS-constrained stage, not a theoretical ancestor
    // width. ChatGPT's sidebar/layout wrappers can be much wider than the
    // containing block that ultimately clamps these elements.
    root.setAttribute(ROOT_ATTRIBUTE, "1");
    root.style.setProperty("--bcg-conversation-width", "100000px");
    root.style.setProperty("--bcg-composer-width", "100000px");
    const widestConversation = Math.max(
      nativeConversation,
      renderedConversationWidth(conversations, nativeConversation),
    );
    const widestComposer = Math.max(nativeComposer, renderedWidth(composerHost, nativeComposer));

    measuredConversations = [...conversations];
    measuredComposerHost = composerHost;
    measurementsDirty = false;
    const nextRange = {
      nativeConversation,
      nativeComposer,
      widestConversation,
      widestComposer,
    };
    if (preserveWidestMeasurement && previousRange) {
      for (const key of Object.keys(nextRange)) {
        nextRange[key] = Math.max(nextRange[key], previousRange[key] || 0);
      }
    }
    preserveWidestMeasurement = false;
    widthRange = nextRange;
    return widthRange;
  }

  function interpolateWidth(minimum, maximum, percent) {
    const progress = Math.min(100, Math.max(0, Number(percent) || 0)) / 100;
    return minimum + (maximum - minimum) * progress;
  }

  function markedTargetsAreCurrent() {
    return (
      markedConversations.length > 0
      && markedConversations.every((conversation) => conversation.isConnected)
      && markedComposerHost?.isConnected
      && markedComposerRoot?.isConnected
    );
  }

  function applyInterpolatedWidths(root, range) {
    const conversationPercent = BCG.settings.layout.conversationWidthPercent;
    const composerPercent = BCG.settings.layout.composerWidthPercent;
    const conversationWidth = interpolateWidth(
      range.nativeConversation,
      range.widestConversation,
      conversationPercent,
    );
    const composerWidth = Math.min(
      interpolateWidth(range.nativeComposer, range.widestComposer, composerPercent),
      conversationWidth,
    );

    root.style.setProperty(
      "--bcg-conversation-width",
      `${Math.round(conversationWidth)}px`,
    );
    root.style.setProperty(
      "--bcg-composer-width",
      `${Math.round(composerWidth)}px`,
    );
  }

  function syncResizeTargets(conversations, composerHost) {
    if (typeof ResizeObserver !== "function") return;
    resizeObserver ||= new ResizeObserver(() => queueSettledRemeasure());

    const conversationHost = conversations[0]?.closest("main, [role=main]")
      || conversations[0]?.parentElement
      || null;
    const composerLayoutHost = composerHost?.parentElement || null;
    if (conversationHost !== observedConversationHost) {
      if (observedConversationHost) resizeObserver.unobserve(observedConversationHost);
      observedConversationHost = conversationHost;
      if (observedConversationHost) resizeObserver.observe(observedConversationHost);
    }
    if (composerLayoutHost !== observedComposerHost) {
      if (observedComposerHost) resizeObserver.unobserve(observedComposerHost);
      observedComposerHost = composerLayoutHost;
      if (observedComposerHost) resizeObserver.observe(observedComposerHost);
    }
  }

  function applyWideMode() {
    refreshQueued = false;
    injectStyle();

    const root = document.documentElement;
    const enabled = BCG.isFeatureEnabled("layout.wideMode");
    const enabledValue = enabled ? "1" : "0";
    if (root.getAttribute(ROOT_ATTRIBUTE) !== enabledValue) {
      root.setAttribute(ROOT_ATTRIBUTE, enabledValue);
    }
    if (!enabled) {
      root.style.removeProperty("--bcg-conversation-width");
      root.style.removeProperty("--bcg-composer-width");
      measurementsDirty = true;
      return;
    }

    if (!measurementsDirty && widthRange && markedTargetsAreCurrent()) {
      applyInterpolatedWidths(root, widthRange);
      return;
    }

    const conversations = markConversationTargets(findConversationWrappers());
    const composer = findComposerRoot();
    const composerHost = composer ? markComposerTargets(composer) : null;
    syncResizeTargets(conversations, composerHost);
    const range = measureRenderedWidthRange(root, conversations, composerHost);
    applyInterpolatedWidths(root, range);
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(applyWideMode);
  }

  function queueRemeasure() {
    measurementsDirty = true;
    queueRefresh();
  }

  function queueSettledRemeasure({ resetRange = false } = {}) {
    if (!BCG.isFeatureEnabled("layout.wideMode")) return;
    resetRangeAfterResize ||= resetRange;
    if (settledRemeasureTimer !== null) clearTimeout(settledRemeasureTimer);
    settledRemeasureTimer = setTimeout(() => {
      settledRemeasureTimer = null;
      if (!BCG.isFeatureEnabled("layout.wideMode")) {
        resetRangeAfterResize = false;
        return;
      }

      const shouldResetRange = resetRangeAfterResize;
      resetRangeAfterResize = false;
      if (shouldResetRange) {
        widthRange = null;
        measuredConversations = [];
        measuredComposerHost = null;
      }
      preserveWidestMeasurement = !shouldResetRange;
      queueRemeasure();
    }, RESIZE_SETTLE_MS);
  }

  function pointFallsInsideComposer(event, composerHost) {
    if (!(composerHost instanceof Element)) return false;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rect = composerHost.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function targetBelongsToInteractiveOverlay(target) {
    return target instanceof Element && Boolean(target.closest(INTERACTIVE_OVERLAY_SELECTOR));
  }

  function guardComposerClickThrough(event) {
    const prompt = findPrompt();
    const composer = findComposerRoot(prompt);
    const composerHost = composer ? (markedComposerHost || findComposerWidthHost(composer) || composer) : null;
    const target = event.target;
    if (target instanceof Element && target.closest(UI_CONTROL_SELECTOR)) return;
    if (targetBelongsToInteractiveOverlay(target)) return;
    if (!prompt || !composerHost || composerHost.contains(target)) return;
    if (!pointFallsInsideComposer(event, composerHost)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      prompt.focus({ preventScroll: true });
    } catch {
      prompt.focus();
    }
  }

  BCG.refreshWideMode = queueRefresh;
  window.addEventListener("bcg:layout-refresh", queueRefresh);
  window.addEventListener("bcg:settings-changed", queueRefresh);
  window.addEventListener("resize", () => queueSettledRemeasure({ resetRange: true }), { passive: true });
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "auxclick"]) {
    window.addEventListener(type, guardComposerClickThrough, true);
  }

  const mutationObserver = new MutationObserver((records) => {
    const needsRefresh = records.some((record) => {
      // If ChatGPT has just created a live activity turn, mark its width target
      // once. Do not remeasure for every token/tool-card mutation inside a turn
      // that already owns a wide-mode target.
      const targetTurn = record.target instanceof Element
        ? record.target.closest?.(CONVERSATION_TURN_SELECTOR)
        : null;
      if (targetTurn && !targetTurn.querySelector(`[${CONVERSATION_ATTRIBUTE}]`)) return true;

      const changedNodes = [...record.addedNodes, ...record.removedNodes];
      return changedNodes.some((node) =>
        node instanceof Element && (
          node.matches?.(PROMPT_SELECTOR)
          || node.querySelector?.(PROMPT_SELECTOR)
          || node.matches?.(CONVERSATION_TURN_SELECTOR)
          || node.querySelector?.(CONVERSATION_TURN_SELECTOR)
          || node.matches?.(`[${CONVERSATION_ATTRIBUTE}]`)
          || node.querySelector?.(`[${CONVERSATION_ATTRIBUTE}]`)
          || node.matches?.("[data-message-author-role]")
          || node.querySelector?.("[data-message-author-role]")
        )
      );
    });
    if (needsRefresh) queueRemeasure();
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", queueRefresh, { once: true });
  }
  queueRefresh();
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const STYLE_ID = "better-chatgpt-header-actions";
  const SHARE_SOURCE_ATTRIBUTE = "data-bcg-wide-share-source";
  const OVERFLOW_ATTRIBUTE = "data-bcg-share-overflow";
  const OVERFLOW_SHELL_ATTRIBUTE = "data-bcg-share-overflow-shell";
  const MENU_ITEM_CLASS = "bcg-share-menu-item";
  const MENU_SELECTOR = [
    '[role="menu"]',
    '[data-radix-menu-content]',
    '[data-headlessui-menu-items]',
  ].join(",");

  let shareSource = null;
  let shareSources = [];
  let overflowButton = null;
  let overflowShell = null;
  let refreshQueued = false;
  let menuScanQueued = false;
  let pendingMenuUntil = 0;

  const CSS = `
html[data-bcg-wide-mode="1"] [${SHARE_SOURCE_ATTRIBUTE}]{display:none!important}
html[data-bcg-wide-mode="1"] [${OVERFLOW_SHELL_ATTRIBUTE}]{background:transparent!important}
.${MENU_ITEM_CLASS}{box-sizing:border-box;width:100%;min-width:0;display:flex;align-items:center;gap:10px;padding:8px 12px 8px 17px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;line-height:1.25;cursor:pointer}
.${MENU_ITEM_CLASS}:hover,.${MENU_ITEM_CLASS}:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent);outline:none}
.${MENU_ITEM_CLASS} svg{width:18px;height:18px;flex:0 0 auto}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonLabel(button) {
    return [
      button?.getAttribute?.("aria-label"),
      button?.getAttribute?.("title"),
      button?.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisibleButton(button) {
    if (!(button instanceof HTMLElement) || button.closest(MENU_SELECTOR)) return false;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function isHeaderShareButton(button) {
    const label = buttonLabel(button);
    const testId = button.getAttribute("data-testid") || "";
    if (!/(?:^|\b)share(?:\s+(?:chat|conversation))?(?:\b|$)/i.test(label) && !/share/i.test(testId)) return false;
    /*
     * Most buttons in a long conversation belong to code blocks and tool cards.
     * Reject them by label before forcing layout/style reads for visibility.
     */
    if (!isVisibleButton(button)) return false;
    const rect = button.getBoundingClientRect();
    return rect.top < 110 && rect.right > innerWidth * 0.45;
  }

  function isLikelyOverflowButton(button, shareRect) {
    if (!isVisibleButton(button)) return false;
    const rect = button.getBoundingClientRect();
    if (Math.abs((rect.top + rect.bottom) / 2 - (shareRect.top + shareRect.bottom) / 2) > 24) return false;
    if (Math.abs(rect.left - shareRect.right) > 90 && Math.abs(rect.right - shareRect.left) > 90) return false;
    const label = buttonLabel(button);
    return /(?:^|\b)(?:more|more options|more actions|conversation options|conversation actions|overflow|options)(?:\b|$)/i.test(label)
      || /^[.…·\s]+$/.test(label)
      || (!label && Boolean(button.querySelector("svg")));
  }

  function findHeaderActionPair() {
    const candidates = Array.from(document.querySelectorAll(
      'button[aria-label*="share" i], button[title*="share" i], button[data-testid*="share" i], button',
    )).filter(isHeaderShareButton);

    const pairs = [];
    for (const share of candidates) {
      const shareRect = share.getBoundingClientRect();
      for (let container = share.parentElement, depth = 0; container && depth < 4; container = container.parentElement, depth += 1) {
        const overflow = Array.from(container.querySelectorAll("button"))
          .filter((button) => button !== share && isLikelyOverflowButton(button, shareRect))
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return Math.abs(aRect.left - shareRect.right) - Math.abs(bRect.left - shareRect.right);
          })[0];
        if (overflow) {
          pairs.push({ share, overflow });
          break;
        }
      }
    }
    if (!pairs.length) return null;
    pairs.sort((a, b) => {
      const aRect = a.share.getBoundingClientRect();
      const bRect = b.share.getBoundingClientRect();
      return (bRect.width * bRect.height) - (aRect.width * aRect.height);
    });
    return {
      share: pairs[0].share,
      shares: candidates,
      overflow: pairs[0].overflow,
    };
  }

  function clearHeaderPair() {
    for (const source of shareSources) source.removeAttribute(SHARE_SOURCE_ATTRIBUTE);
    overflowButton?.removeAttribute(OVERFLOW_ATTRIBUTE);
    overflowShell?.removeAttribute(OVERFLOW_SHELL_ATTRIBUTE);
    shareSource = null;
    shareSources = [];
    overflowButton = null;
    overflowShell = null;
  }

  function refreshHeaderPair() {
    refreshQueued = false;
    injectStyle();
    clearHeaderPair();
    const pair = findHeaderActionPair();
    if (!pair) return;
    shareSource = pair.share;
    shareSources = pair.shares;
    overflowButton = pair.overflow;
    for (const source of shareSources) source.setAttribute(SHARE_SOURCE_ATTRIBUTE, "1");
    overflowButton.setAttribute(OVERFLOW_ATTRIBUTE, "1");
    overflowShell = overflowButton.parentElement instanceof HTMLElement ? overflowButton.parentElement : null;
    overflowShell?.setAttribute(OVERFLOW_SHELL_ATTRIBUTE, "1");
  }

  function queueHeaderRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshHeaderPair);
  }

  function isWideModeActive() {
    return document.documentElement.dataset.bcgWideMode === "1"
      && BCG.isFeatureEnabled("layout.wideMode");
  }

  function visibleMenus() {
    return Array.from(document.querySelectorAll(MENU_SELECTOR)).filter((menu) => {
      if (!(menu instanceof HTMLElement) || menu.closest("#better-chatgpt-settings-panel")) return false;
      const rect = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      return rect.width > 80 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function nearestPendingMenu() {
    const buttonRect = overflowButton?.getBoundingClientRect?.();
    if (!buttonRect) return null;
    return visibleMenus().sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      const distance = (rect) => Math.hypot(
        Math.max(0, rect.left - buttonRect.right, buttonRect.left - rect.right),
        Math.max(0, rect.top - buttonRect.bottom, buttonRect.top - rect.bottom),
      );
      return distance(aRect) - distance(bRect);
    })[0] || null;
  }

  function makeShareMenuItem() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = MENU_ITEM_CLASS;
    button.dataset.bcgShareMenuItem = "1";
    button.dataset.bcgUiControl = "1";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", "Share conversation");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5"></path>
        <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path>
      </svg>
      <span>Share</span>
    `;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingMenuUntil = 0;
      const source = shareSource;
      if (source?.isConnected) source.click();
    });
    return button;
  }

  function injectShareMenuItem() {
    menuScanQueued = false;
    if (!isWideModeActive() || performance.now() > pendingMenuUntil) return;
    const menu = nearestPendingMenu();
    if (!menu || menu.querySelector(`.${MENU_ITEM_CLASS}`)) return;
    const firstItem = menu.querySelector('[role="menuitem"], button, a');
    const insertionParent = firstItem?.parentElement && menu.contains(firstItem.parentElement)
      ? firstItem.parentElement
      : menu;
    insertionParent.insertBefore(makeShareMenuItem(), firstItem || insertionParent.firstChild);
  }

  function queueMenuScan() {
    if (menuScanQueued) return;
    menuScanQueued = true;
    requestAnimationFrame(injectShareMenuItem);
  }

  function armConversationMenu(event) {
    const button = event.target instanceof Element
      ? event.target.closest(`[${OVERFLOW_ATTRIBUTE}]`)
      : null;
    if (!button || !isWideModeActive()) return;
    pendingMenuUntil = performance.now() + 1600;
    queueMenuScan();
    setTimeout(queueMenuScan, 80);
  }

  function addedNodeMayContainHeader(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches?.('button[aria-label*="share" i], button[title*="share" i], button[data-testid*="share" i]')) return true;
    return Boolean(node.querySelector?.('button[aria-label*="share" i], button[title*="share" i], button[data-testid*="share" i]'));
  }

  injectStyle();
  queueHeaderRefresh();
  document.addEventListener("pointerdown", armConversationMenu, true);
  document.addEventListener("click", armConversationMenu, true);
  window.addEventListener("bcg:layout-refresh", () => {
    if (!isWideModeActive()) document.querySelectorAll(`.${MENU_ITEM_CLASS}`).forEach((item) => item.remove());
    queueHeaderRefresh();
  });
  window.addEventListener("bcg:settings-changed", queueHeaderRefresh);

  new MutationObserver((records) => {
    if (
      records.some((record) => Array.from(record.addedNodes).some(addedNodeMayContainHeader))
    ) queueHeaderRefresh();
    if (
      performance.now() <= pendingMenuUntil
      && records.some((record) => Array.from(record.addedNodes).some((node) =>
        node instanceof Element && (node.matches?.(MENU_SELECTOR) || node.querySelector?.(MENU_SELECTOR)),
      ))
    ) queueMenuScan();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const STYLE_ID = "better-chatgpt-page-colors";
  const ROOT_ATTRIBUTE = "data-bcg-page-colors";
  const ACCENT_ATTRIBUTE = "data-bcg-custom-accent";
  const COMPOSER_ATTRIBUTE = "data-bcg-composer-color";
  const COMPOSER_SURFACE_ATTRIBUTE = "data-bcg-composer-surface";
  const SIDEBAR_ATTRIBUTE = "data-bcg-sidebar-color";
  const HIDE_FOOTER_ATTRIBUTE = "data-bcg-hide-footer";
  const BOTTOM_VIGNETTE_ATTRIBUTE = "data-bcg-bottom-vignette";
  const PROMPT_SELECTOR = '#prompt-textarea, [data-testid="prompt-textarea"]';
  const VIGNETTE_GUTTER_LEFT_ID = "better-chatgpt-bottom-vignette-gutter-left";
  const VIGNETTE_GUTTER_RIGHT_ID = "better-chatgpt-bottom-vignette-gutter-right";
  const LEGACY_VIGNETTE_GUTTER_ID = "better-chatgpt-bottom-vignette-gutter";
  const VIGNETTE_OVERLAP_PX = 1;
  let nativeSurfaces = null;
  let nativeComposerSurfaces = null;
  let vignetteSyncQueued = false;
  let vignetteResizeObserver = null;
  let observedVignetteContainer = null;
  let observedVignetteHost = null;
  let markedComposerSurface = null;
  let markedComposerPrompt = null;

  const CSS = `
html[${ROOT_ATTRIBUTE}="1"],
html[${ROOT_ATTRIBUTE}="1"] body {
  background-color: var(--bcg-page-background) !important;
}

html[${ROOT_ATTRIBUTE}="1"] main,
html[${ROOT_ATTRIBUTE}="1"] [role="main"] {
  --main-surface-primary: var(--bcg-page-background) !important;
  --main-surface-secondary: color-mix(in srgb, var(--bcg-page-background) 92%, var(--bcg-page-text)) !important;
  --main-surface-tertiary: color-mix(in srgb, var(--bcg-page-background) 84%, var(--bcg-page-text)) !important;
  --text-primary: var(--bcg-page-text) !important;
  --text-secondary: color-mix(in srgb, var(--bcg-page-text) 72%, transparent) !important;
  --text-tertiary: color-mix(in srgb, var(--bcg-page-text) 56%, transparent) !important;
  background-color: var(--bcg-page-background) !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(main, [role="main"]) :is(
  [class*="bg-token-main-surface-primary"],
  [class*="bg-token-main-surface-secondary"],
  [class*="bg-token-main-surface-tertiary"],
  [class*="bg-token-bg-primary"]
):not(:where(
  button,
  button *,
  [role="button"],
  [role="button"] *,
  form,
  form *,
  [role="dialog"],
  [role="dialog"] *,
  [role="menu"],
  [role="menu"] *,
  [role="listbox"],
  [role="listbox"] *,
  [data-radix-popper-content-wrapper],
  [data-radix-popper-content-wrapper] *,
  [data-testid*="file" i],
  [data-testid*="file" i] *,
  [data-testid*="attachment" i],
  [data-testid*="attachment" i] *,
  [data-testid*="artifact" i],
  [data-testid*="artifact" i] *,
  [data-testid*="download" i],
  [data-testid*="download" i] *,
  a[download],
  a[download] *,
  a[href^="sandbox:"],
  a[href^="sandbox:"] *,
  :is([data-message-author-role="assistant"], [data-turn="assistant"])
    [class*="rounded"],
  :is([data-message-author-role="assistant"], [data-turn="assistant"])
    [class*="rounded"] *
)) {
  background-color: var(--bcg-page-background) !important;
}

/*
 * Keep interactive surfaces on ChatGPT's native palette while applying custom
 * colors only to conversation surfaces. The selector exclusions above protect
 * class-based controls; these variables protect controls that consume surface
 * tokens directly.
 */
html[${ROOT_ATTRIBUTE}="1"] :is(main, [role="main"]) :is(
  button,
  [role="button"],
  form,
  [role="dialog"],
  [role="menu"],
  [role="listbox"],
  [data-radix-popper-content-wrapper],
  [data-testid*="file" i],
  [data-testid*="attachment" i],
  [data-testid*="artifact" i],
  [data-testid*="download" i],
  a[download],
  a[href^="sandbox:"]
),
html[${ROOT_ATTRIBUTE}="1"] :is(main, [role="main"])
  :is([data-message-author-role="assistant"], [data-turn="assistant"])
  [class*="rounded"] {
  --main-surface-primary: var(--bcg-native-main-surface-primary) !important;
  --main-surface-secondary: var(--bcg-native-main-surface-secondary) !important;
  --main-surface-tertiary: var(--bcg-native-main-surface-tertiary) !important;
  --bg-primary: var(--bcg-native-bg-primary) !important;
}

html[${HIDE_FOOTER_ATTRIBUTE}="1"] :is(main, [role="main"])
  [data-testid="thread-disclaimer"],
html[${HIDE_FOOTER_ATTRIBUTE}="1"] :is(main, [role="main"])
  #thread-bottom-container [class*="view-transition-name:var(--vt-disclaimer)"],
html[${HIDE_FOOTER_ATTRIBUTE}="1"] :is(main, [role="main"])
  .text-caption-regular.text-token-text-tertiary.pointer-events-auto {
  display: none !important;
  view-transition-name: none !important;
  background: transparent !important;
  box-shadow: none !important;
  filter: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

html[${HIDE_FOOTER_ATTRIBUTE}="1"] :is(
  [data-message-author-role],
  [data-turn],
  [role="dialog"],
  [role="menu"]
) .text-caption-regular.text-token-text-tertiary.pointer-events-auto {
  display: revert !important;
}


/*
 * Leave ChatGPT's native vignette completely untouched while enabled. The
 * mirrored gutter strips are mounted directly under <body>, outside ChatGPT's
 * React-owned footer tree, and positioned from the native fade at runtime.
 */
#${VIGNETTE_GUTTER_LEFT_ID},
#${VIGNETTE_GUTTER_RIGHT_ID} {
  position: fixed !important;
  pointer-events: none !important;
  user-select: none !important;
  contain: strict !important;
}

html[${BOTTOM_VIGNETTE_ATTRIBUTE}="0"]
  #thread-bottom-container[class*="threadFooterContentFade"]::before,
html[${BOTTOM_VIGNETTE_ATTRIBUTE}="0"]
  #thread-bottom-container[class*="threadFooterContentFade"]::after {
  content: none !important;
  display: none !important;
  background: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
  filter: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  mask-image: none !important;
}

html[${BOTTOM_VIGNETTE_ATTRIBUTE}="0"] #${VIGNETTE_GUTTER_LEFT_ID},
html[${BOTTOM_VIGNETTE_ATTRIBUTE}="0"] #${VIGNETTE_GUTTER_RIGHT_ID} {
  display: none !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(
  [data-message-author-role="assistant"],
  [data-turn="assistant"]
) {
  --text-primary: var(--bcg-page-text) !important;
  --text-secondary: color-mix(in srgb, var(--bcg-page-text) 72%, transparent) !important;
  color: var(--bcg-page-text) !important;
}

/*
 * Recolor only assistant prose. Native action cards, permission prompts, file
 * tiles, artifacts, and other rounded ChatGPT surfaces keep their own semantic
 * text palette so light/dark control-specific contrast is not flattened into
 * the conversation text color.
 */
html[${ROOT_ATTRIBUTE}="1"] :is(
  [data-message-author-role="assistant"],
  [data-turn="assistant"]
) :is(.markdown, .prose) :where(
  [class*="text-token-text-primary"],
  [class*="text-primary"]
):not(:where(
  button *,
  [role="button"] *,
  [role="dialog"] *,
  [role="menu"] *,
  [role="listbox"] *,
  [class*="rounded"] *,
  [data-testid*="file" i] *,
  [data-testid*="attachment" i] *,
  [data-testid*="artifact" i] *,
  [data-testid*="download" i] *
)) {
  color: var(--bcg-page-text) !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(
  [data-message-author-role="assistant"],
  [data-turn="assistant"]
) :is(.markdown, .prose) :where(
  [class*="text-token-text-secondary"],
  [class*="text-secondary"]
):not(:where(
  button *,
  [role="button"] *,
  [role="dialog"] *,
  [role="menu"] *,
  [role="listbox"] *,
  [class*="rounded"] *,
  [data-testid*="file" i] *,
  [data-testid*="attachment" i] *,
  [data-testid*="artifact" i] *,
  [data-testid*="download" i] *
)) {
  color: color-mix(in srgb, var(--bcg-page-text) 72%, transparent) !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(
  [data-message-author-role="assistant"],
  [data-turn="assistant"]
) :is(.markdown, .prose) :where(
  [class*="text-token-text-tertiary"],
  [class*="text-tertiary"]
):not(:where(
  button *,
  [role="button"] *,
  [role="dialog"] *,
  [role="menu"] *,
  [role="listbox"] *,
  [class*="rounded"] *,
  [data-testid*="file" i] *,
  [data-testid*="attachment" i] *,
  [data-testid*="artifact" i] *,
  [data-testid*="download" i] *
)) {
  color: color-mix(in srgb, var(--bcg-page-text) 56%, transparent) !important;
}

html[${ROOT_ATTRIBUTE}="1"] :is(
  [data-message-author-role="assistant"],
  [data-turn="assistant"]
) :is(.markdown, .prose) :where(p, li, h1, h2, h3, h4, h5, h6, blockquote, strong, em, span):not(:where(
  button *,
  [role="button"] *,
  [role="dialog"] *,
  [role="menu"] *,
  [role="listbox"] *,
  [class*="rounded"] *,
  [data-testid*="file" i] *,
  [data-testid*="attachment" i] *,
  [data-testid*="artifact" i] *,
  [data-testid*="download" i] *
)) {
  color: inherit !important;
}

/*
 * ChatGPT's Accent color preference resolves to the semantic --theme-* tokens
 * below. Override the selected theme outputs rather than its built-in palette
 * constants so switching this option off immediately restores the account
 * preference.
 */
html[${ACCENT_ATTRIBUTE}="1"],
html[${ACCENT_ATTRIBUTE}="1"] :is(
  [role="dialog"],
  [role="menu"],
  [role="listbox"],
  [data-theme],
  [data-color-scheme],
  [data-radix-popper-content-wrapper]
) {
  --theme-accent-text: var(--bcg-custom-accent) !important;
  --theme-entity-accent: var(--bcg-custom-accent) !important;
  --theme-accent-pill-bg-hover: color-mix(in srgb, var(--bcg-custom-accent) 42%, transparent) !important;
  --theme-accent-pill-bg-rest: color-mix(in srgb, var(--bcg-custom-accent) 42%, transparent) !important;
  --theme-accent-pill-text-hover: var(--bcg-custom-accent-contrast) !important;
  --theme-accent-pill-text-rest: color-mix(in srgb, var(--bcg-custom-accent) 72%, var(--bcg-custom-accent-contrast)) !important;
  --theme-chart-color: var(--bcg-custom-accent) !important;
  --theme-submit-btn-bg: var(--bcg-custom-accent) !important;
  --theme-submit-btn-text: var(--bcg-custom-accent-contrast) !important;
  --theme-secondary-btn-bg: color-mix(in srgb, var(--bcg-custom-accent) 82%, var(--bcg-custom-accent-contrast)) !important;
  --theme-secondary-btn-text: var(--bcg-custom-accent-contrast) !important;
  --theme-user-selection-bg: color-mix(in srgb, var(--bcg-custom-accent) 60%, transparent) !important;
  --theme-attribution-highlight-bg: color-mix(in srgb, var(--bcg-custom-accent) 60%, transparent) !important;
}

html[${COMPOSER_ATTRIBUTE}="1"] [${COMPOSER_SURFACE_ATTRIBUTE}="1"] {
  --composer-surface: var(--bcg-composer-background) !important;
  --composer-surface-primary: var(--bcg-composer-background) !important;
  --composer-background-color: var(--bcg-composer-background) !important;
  --text-primary: var(--bcg-composer-text) !important;
  --text-secondary: color-mix(in srgb, var(--bcg-composer-text) 72%, transparent) !important;
  --text-tertiary: color-mix(in srgb, var(--bcg-composer-text) 56%, transparent) !important;
}

html[${COMPOSER_ATTRIBUTE}="1"] [${COMPOSER_SURFACE_ATTRIBUTE}="1"]
  [class~="bg-(--composer-surface-primary)"] {
  background-color: var(--bcg-composer-background) !important;
}

/*
 * A custom page background changes the main semantic surface/text variables.
 * When Composer color is disabled, explicitly restore ChatGPT's captured native
 * composer palette on the marked composer root so remounts cannot momentarily
 * inherit the conversation background.
 */
html[${ROOT_ATTRIBUTE}="1"][${COMPOSER_ATTRIBUTE}="0"] [${COMPOSER_SURFACE_ATTRIBUTE}="1"] {
  --main-surface-primary: var(--bcg-native-main-surface-primary) !important;
  --main-surface-secondary: var(--bcg-native-main-surface-secondary) !important;
  --main-surface-tertiary: var(--bcg-native-main-surface-tertiary) !important;
  --bg-primary: var(--bcg-native-bg-primary) !important;
  --composer-surface: var(--bcg-native-composer-surface) !important;
  --composer-surface-primary: var(--bcg-native-composer-surface-primary) !important;
  --composer-background-color: var(--bcg-native-composer-background-color) !important;
  --text-primary: var(--bcg-native-composer-text-primary) !important;
  --text-secondary: var(--bcg-native-composer-text-secondary) !important;
  --text-tertiary: var(--bcg-native-composer-text-tertiary) !important;
}

html[${SIDEBAR_ATTRIBUTE}="1"] :is(
  #stage-slideover-sidebar,
  .stage-sidebar-pure-surface
) {
  --component-sidebar-bg: var(--bcg-sidebar-background) !important;
  --sidebar-surface: var(--bcg-sidebar-background) !important;
  --sidebar-surface-primary: var(--bcg-sidebar-background) !important;
  --sidebar-surface-secondary: color-mix(in srgb, var(--bcg-sidebar-background) 88%, var(--bcg-sidebar-text)) !important;
  --sidebar-surface-tertiary: color-mix(in srgb, var(--bcg-sidebar-background) 80%, var(--bcg-sidebar-text)) !important;
  --sidebar-body-primary: var(--bcg-sidebar-text) !important;
  --sidebar-title-primary: color-mix(in srgb, var(--bcg-sidebar-text) 58%, transparent) !important;
  --sidebar-icon: color-mix(in srgb, var(--bcg-sidebar-text) 72%, transparent) !important;
  --surface-hover: color-mix(in srgb, var(--bcg-sidebar-text) 15%, transparent) !important;
  --text-primary: var(--bcg-sidebar-text) !important;
  --text-secondary: color-mix(in srgb, var(--bcg-sidebar-text) 72%, transparent) !important;
  background-color: var(--bcg-sidebar-background) !important;
}

html[${SIDEBAR_ATTRIBUTE}="1"] :is(
  #stage-slideover-sidebar,
  .stage-sidebar-pure-surface
) [class~="bg-token-sidebar-surface-primary"] {
  background-color: var(--bcg-sidebar-background) !important;
}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function applyAccentColor() {
    const root = document.documentElement;
    const enabled = BCG.isFeatureEnabled("appearance.accentColorEnabled");
    root.setAttribute(ACCENT_ATTRIBUTE, enabled ? "1" : "0");
    if (!enabled) {
      root.style.removeProperty("--bcg-custom-accent");
      root.style.removeProperty("--bcg-custom-accent-contrast");
      return;
    }
    const color = BCG.settings.appearance.bubbleColor;
    root.style.setProperty("--bcg-custom-accent", color);
    root.style.setProperty("--bcg-custom-accent-contrast", BCG.getReadableTextColor(color));
  }

  function findComposerSurface() {
    const prompt = document.querySelector(PROMPT_SELECTOR);
    const surface = prompt?.closest(
      'form, [data-testid="main-composer"], [data-testid="composer-root"]',
    ) || null;
    return { prompt, surface };
  }

  function syncComposerSurfaceMarker() {
    const { prompt, surface } = findComposerSurface();
    if (markedComposerSurface && markedComposerSurface !== surface) {
      markedComposerSurface.removeAttribute(COMPOSER_SURFACE_ATTRIBUTE);
    }
    if (surface) surface.setAttribute(COMPOSER_SURFACE_ATTRIBUTE, "1");
    markedComposerSurface = surface;
    markedComposerPrompt = prompt;
  }

  function composerSurfaceMutationRequiresSync(records) {
    if (
      markedComposerSurface?.isConnected &&
      markedComposerPrompt?.isConnected &&
      markedComposerSurface.contains(markedComposerPrompt)
    ) {
      return false;
    }

    if (markedComposerSurface || markedComposerPrompt) return true;
    for (const record of records || []) {
      for (const node of record.addedNodes || []) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element) continue;
        if (element.matches?.(PROMPT_SELECTOR) || element.querySelector?.(PROMPT_SELECTOR)) {
          return true;
        }
      }
    }
    return false;
  }

  function applyInterfaceSurfaceColors() {
    const root = document.documentElement;
    const appearance = BCG.settings.appearance;
    const composerEnabled = BCG.isFeatureEnabled("appearance.composerColorEnabled");
    const sidebarEnabled = BCG.isFeatureEnabled("appearance.sidebarColorEnabled");
    root.setAttribute(COMPOSER_ATTRIBUTE, composerEnabled ? "1" : "0");
    root.setAttribute(SIDEBAR_ATTRIBUTE, sidebarEnabled ? "1" : "0");
    syncComposerSurfaceMarker();

    if (composerEnabled) {
      root.style.setProperty("--bcg-composer-background", appearance.composerColor);
      root.style.setProperty("--bcg-composer-text", BCG.getReadableTextColor(appearance.composerColor));
    } else {
      root.style.removeProperty("--bcg-composer-background");
      root.style.removeProperty("--bcg-composer-text");
    }

    if (sidebarEnabled) {
      root.style.setProperty("--bcg-sidebar-background", appearance.sidebarColor);
      root.style.setProperty("--bcg-sidebar-text", BCG.getReadableTextColor(appearance.sidebarColor));
    } else {
      root.style.removeProperty("--bcg-sidebar-background");
      root.style.removeProperty("--bcg-sidebar-text");
    }
  }

  function captureNativeSurfaces() {
    if (nativeSurfaces) return nativeSurfaces;
    const main = document.querySelector("main, [role=\"main\"]");
    if (!main) return null;

    const computed = getComputedStyle(main);
    nativeSurfaces = {
      primary: computed.getPropertyValue("--main-surface-primary").trim() || "#212121",
      secondary: computed.getPropertyValue("--main-surface-secondary").trim() || "#2f2f2f",
      tertiary: computed.getPropertyValue("--main-surface-tertiary").trim() || "#424242",
      bgPrimary: computed.getPropertyValue("--bg-primary").trim() || "#212121",
      textPrimary: computed.getPropertyValue("--text-primary").trim() || "#ececf1",
      textSecondary: computed.getPropertyValue("--text-secondary").trim() || "rgba(236, 236, 241, 0.72)",
      textTertiary: computed.getPropertyValue("--text-tertiary").trim() || "rgba(236, 236, 241, 0.56)",
    };
    return nativeSurfaces;
  }

  function captureNativeComposerSurfaces(surfaces = captureNativeSurfaces()) {
    if (nativeComposerSurfaces) return nativeComposerSurfaces;
    const { surface } = findComposerSurface();
    const computed = surface ? getComputedStyle(surface) : null;
    const fallbackPrimary = surfaces?.primary || "#212121";
    const fallbackTextPrimary = surfaces?.textPrimary || "#ececf1";
    const fallbackTextSecondary = surfaces?.textSecondary || "rgba(236, 236, 241, 0.72)";
    const fallbackTextTertiary = surfaces?.textTertiary || "rgba(236, 236, 241, 0.56)";

    nativeComposerSurfaces = {
      surface: computed?.getPropertyValue("--composer-surface").trim() || fallbackPrimary,
      primary: computed?.getPropertyValue("--composer-surface-primary").trim() || fallbackPrimary,
      background: computed?.getPropertyValue("--composer-background-color").trim() ||
        computed?.getPropertyValue("--composer-surface-primary").trim() || fallbackPrimary,
      textPrimary: computed?.getPropertyValue("--text-primary").trim() || fallbackTextPrimary,
      textSecondary: computed?.getPropertyValue("--text-secondary").trim() || fallbackTextSecondary,
      textTertiary: computed?.getPropertyValue("--text-tertiary").trim() || fallbackTextTertiary,
    };
    return nativeComposerSurfaces;
  }

  function isTransparentColor(value) {
    return !value || value === "transparent" || value === "rgba(0, 0, 0, 0)";
  }

  function findNativeVignetteStyle(container) {
    const candidates = ["::before", "::after"].map((pseudo) => ({
      pseudo,
      style: getComputedStyle(container, pseudo),
    }));

    return candidates
      .filter(({ style }) => {
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const height = Number.parseFloat(style.height);
        const painted =
          style.backgroundImage !== "none" ||
          !isTransparentColor(style.backgroundColor) ||
          style.boxShadow !== "none" ||
          style.filter !== "none" ||
          style.maskImage !== "none";
        return painted && Number.isFinite(height) && height > 1;
      })
      .sort((a, b) => {
        const aGradient = a.style.backgroundImage.includes("gradient") ? 1 : 0;
        const bGradient = b.style.backgroundImage.includes("gradient") ? 1 : 0;
        return bGradient - aGradient || Number.parseFloat(b.style.height) - Number.parseFloat(a.style.height);
      })[0]?.style || null;
  }

  function copyVignettePaint(target, source) {
    const properties = [
      "background",
      "background-color",
      "background-image",
      "background-position",
      "background-size",
      "background-repeat",
      "box-shadow",
      "filter",
      "backdrop-filter",
      "-webkit-backdrop-filter",
      "mask-image",
      "mask-position",
      "mask-size",
      "mask-repeat",
      "clip-path",
      "opacity",
      "mix-blend-mode",
      "border-radius",
    ];
    for (const property of properties) {
      const value = source.getPropertyValue(property);
      if (value) target.style.setProperty(property, value, "important");
    }
  }

  function resolveCssLength(value, basis) {
    const text = String(value || "").trim();
    if (!text || text === "auto") return null;
    const parsed = Number.parseFloat(text);
    if (!Number.isFinite(parsed)) return null;
    return text.endsWith("%") ? (basis * parsed) / 100 : parsed;
  }

  function findStageScrollHost(container) {
    for (let node = container.parentElement; node instanceof HTMLElement; node = node.parentElement) {
      const computed = getComputedStyle(node);
      const scrollbarGutter = computed.scrollbarGutter || computed.getPropertyValue("scrollbar-gutter");
      if (scrollbarGutter && scrollbarGutter !== "auto") return node;
    }
    return null;
  }

  function measureScrollbarGutters(host) {
    const computed = getComputedStyle(host);
    const scrollbarGutter = computed.scrollbarGutter || computed.getPropertyValue("scrollbar-gutter");
    const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(computed.borderRightWidth) || 0;
    const reservedWidth = Math.max(0, host.offsetWidth - host.clientWidth - borderLeft - borderRight);
    if (reservedWidth <= 0.5) return { left: 0, right: 0 };

    if (scrollbarGutter.includes("both-edges")) {
      const each = reservedWidth / 2;
      return { left: each, right: each };
    }
    return computed.direction === "rtl"
      ? { left: reservedWidth, right: 0 }
      : { left: 0, right: reservedWidth };
  }

  function getStageScrollGutters(container) {
    const host = findStageScrollHost(container);
    if (host) {
      const measured = measureScrollbarGutters(host);
      const valid = [measured.left, measured.right].every((value) => Number.isFinite(value) && value >= 0 && value < 64);
      if (valid && measured.left + measured.right > 0.5) return measured;
    }

    /*
     * Compatibility fallback for older/test layouts that exposed a numeric
     * custom property. ChatGPT's current value is a scrollbar-gutter keyword
     * such as "stable both-edges", so the real widths must normally be measured.
     */
    for (let node = container; node instanceof Element; node = node.parentElement) {
      const computed = getComputedStyle(node);
      const value = Number.parseFloat(computed.getPropertyValue("--stage-scroll-gutter"));
      if (!Number.isFinite(value) || value <= 0 || value >= 64) continue;
      const scrollbarGutter = computed.scrollbarGutter || computed.getPropertyValue("scrollbar-gutter");
      if (scrollbarGutter.includes("both-edges")) return { left: value, right: value };
      return computed.direction === "rtl" ? { left: value, right: 0 } : { left: value, right: 0 };
    }
    return { left: 0, right: 0 };
  }

  function resolveVignetteZIndex(container) {
    let highest = 0;
    for (let node = container; node instanceof Element; node = node.parentElement) {
      const value = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(value)) highest = Math.max(highest, value);
    }
    return Math.max(1, highest);
  }

  function removeBottomVignetteGutters() {
    document.getElementById(VIGNETTE_GUTTER_LEFT_ID)?.remove();
    document.getElementById(VIGNETTE_GUTTER_RIGHT_ID)?.remove();
    document.getElementById(LEGACY_VIGNETTE_GUTTER_ID)?.remove();
  }

  function clearVignetteGeometryObserver() {
    vignetteResizeObserver?.disconnect();
    vignetteResizeObserver = null;
    observedVignetteContainer = null;
    observedVignetteHost = null;
  }

  function observeVignetteGeometry(container) {
    const host = findStageScrollHost(container);
    if (container === observedVignetteContainer && host === observedVignetteHost) return;

    clearVignetteGeometryObserver();
    observedVignetteContainer = container;
    observedVignetteHost = host;

    if (typeof ResizeObserver !== "function") return;
    vignetteResizeObserver = new ResizeObserver(queueBottomVignetteSync);
    vignetteResizeObserver.observe(container);
    if (host && host !== container) vignetteResizeObserver.observe(host);
  }

  function nodeContainsVignetteContainer(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element) return false;
    const selector = '#thread-bottom-container[class*="threadFooterContentFade"]';
    return Boolean(element.matches?.(selector) || element.querySelector?.(selector));
  }

  function vignetteMutationRequiresSync(records) {
    if (observedVignetteContainer && !observedVignetteContainer.isConnected) return true;
    for (const record of records || []) {
      if (markedComposerSurface?.contains(record.target)) continue;
      for (const node of [...(record.addedNodes || []), ...(record.removedNodes || [])]) {
        if (nodeContainsVignetteContainer(node)) return true;
      }
    }
    return false;
  }

  function syncVignetteGutter({ id, mount, nativeStyle, left, top, width, height, zIndex }) {
    const existing = document.getElementById(id);
    if (width <= 0.5) {
      existing?.remove();
      return;
    }

    const gutter = existing || document.createElement("div");
    if (!existing) {
      gutter.id = id;
      gutter.setAttribute("aria-hidden", "true");
    }
    if (gutter.parentElement !== mount) mount.appendChild(gutter);

    copyVignettePaint(gutter, nativeStyle);
    gutter.style.setProperty("left", `${left}px`, "important");
    gutter.style.setProperty("top", `${top}px`, "important");
    gutter.style.setProperty("right", "auto", "important");
    gutter.style.setProperty("bottom", "auto", "important");
    gutter.style.setProperty("width", `${width}px`, "important");
    gutter.style.setProperty("height", `${height}px`, "important");
    gutter.style.setProperty("z-index", String(zIndex), "important");
  }

  function syncBottomVignetteGutter() {
    vignetteSyncQueued = false;
    injectStyle();
    document.getElementById(LEGACY_VIGNETTE_GUTTER_ID)?.remove();

    const enabled = BCG.isFeatureEnabled("appearance.bottomVignette");
    if (!enabled) {
      removeBottomVignetteGutters();
      clearVignetteGeometryObserver();
      return;
    }

    const container = document.querySelector('#thread-bottom-container[class*="threadFooterContentFade"]');
    const mount = document.body || document.documentElement;
    if (!container || !mount) {
      removeBottomVignetteGutters();
      clearVignetteGeometryObserver();
      return;
    }

    observeVignetteGeometry(container);
    const nativeStyle = findNativeVignetteStyle(container);
    const gutters = getStageScrollGutters(container);
    if (!nativeStyle || gutters.left + gutters.right <= 0.5) {
      removeBottomVignetteGutters();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const height = Number.parseFloat(nativeStyle.height) || 72;
    const topOffset = resolveCssLength(nativeStyle.top, containerRect.height);
    const bottomOffset = resolveCssLength(nativeStyle.bottom, containerRect.height);
    const top = topOffset !== null
      ? containerRect.top + topOffset
      : bottomOffset !== null
        ? containerRect.bottom - bottomOffset - height
        : containerRect.top - height;
    const zIndex = resolveVignetteZIndex(container);

    syncVignetteGutter({
      id: VIGNETTE_GUTTER_LEFT_ID,
      mount,
      nativeStyle,
      left: containerRect.left - gutters.left,
      top,
      width: gutters.left + VIGNETTE_OVERLAP_PX,
      height,
      zIndex,
    });
    syncVignetteGutter({
      id: VIGNETTE_GUTTER_RIGHT_ID,
      mount,
      nativeStyle,
      left: containerRect.right - VIGNETTE_OVERLAP_PX,
      top,
      width: gutters.right + VIGNETTE_OVERLAP_PX,
      height,
      zIndex,
    });
  }

  function queueBottomVignetteSync() {
    if (vignetteSyncQueued) return;
    vignetteSyncQueued = true;
    requestAnimationFrame(syncBottomVignetteGutter);
  }

  function applyPageColors() {
    injectStyle();
    applyAccentColor();
    applyInterfaceSurfaceColors();
    const root = document.documentElement;
    const surfaces = captureNativeSurfaces();
    if (surfaces) {
      root.style.setProperty("--bcg-native-main-surface-primary", surfaces.primary);
      root.style.setProperty("--bcg-native-main-surface-secondary", surfaces.secondary);
      root.style.setProperty("--bcg-native-main-surface-tertiary", surfaces.tertiary);
      root.style.setProperty("--bcg-native-bg-primary", surfaces.bgPrimary);
    }
    const composerSurfaces = captureNativeComposerSurfaces(surfaces);
    if (composerSurfaces) {
      root.style.setProperty("--bcg-native-composer-surface", composerSurfaces.surface);
      root.style.setProperty("--bcg-native-composer-surface-primary", composerSurfaces.primary);
      root.style.setProperty("--bcg-native-composer-background-color", composerSurfaces.background);
      root.style.setProperty("--bcg-native-composer-text-primary", composerSurfaces.textPrimary);
      root.style.setProperty("--bcg-native-composer-text-secondary", composerSurfaces.textSecondary);
      root.style.setProperty("--bcg-native-composer-text-tertiary", composerSurfaces.textTertiary);
    }
    const appearance = BCG.settings.appearance;
    const enabled = BCG.isFeatureEnabled("appearance.pageColorsEnabled");
    const hideFooter = BCG.isFeatureEnabled("appearance.hideFooter");
    const bottomVignette = BCG.isFeatureEnabled("appearance.bottomVignette");

    root.setAttribute(ROOT_ATTRIBUTE, enabled ? "1" : "0");
    root.setAttribute(HIDE_FOOTER_ATTRIBUTE, hideFooter ? "1" : "0");
    root.setAttribute(BOTTOM_VIGNETTE_ATTRIBUTE, bottomVignette ? "1" : "0");
    queueBottomVignetteSync();
    if (!enabled) {
      root.style.removeProperty("--bcg-page-background");
      root.style.removeProperty("--bcg-page-text");
      return;
    }

    root.style.setProperty("--bcg-page-background", appearance.pageBackgroundColor);
    root.style.setProperty("--bcg-page-text", appearance.pageTextColor);
  }

  BCG.refreshPageColors = applyPageColors;
  BCG.refreshAccentColor = applyAccentColor;
  BCG.refreshInterfaceSurfaceColors = applyInterfaceSurfaceColors;
  window.addEventListener("bcg:appearance-refresh", applyPageColors);
  window.addEventListener("bcg:settings-changed", applyPageColors);
  window.addEventListener("resize", queueBottomVignetteSync, { passive: true });

  new MutationObserver((records) => {
    if (composerSurfaceMutationRequiresSync(records)) syncComposerSurfaceMarker();
    if (vignetteMutationRequiresSync(records)) queueBottomVignetteSync();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyPageColors, { once: true });
  } else {
    applyPageColors();
  }
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const STORAGE_KEY = "better-chatgpt:sidebar-sections-v1";
  const SECTION_NAMES = new Set(["projects", "chats"]);
  const RESTORE_DELAYS = [0, 120, 350, 800, 1600, 3000];
  let restoreGeneration = 0;

  function normalizedText(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isTransientSidebarLayer(node) {
    return Boolean(node?.closest?.(
      '[role="dialog"], [role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], [data-headlessui-portal]',
    ));
  }

  function sectionName(button) {
    if (isTransientSidebarLayer(button)) return "";
    const text = normalizedText(button);
    const ariaLabel = String(button?.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (const name of SECTION_NAMES) {
      if (text === name || ariaLabel === name) return name;
    }
    return "";
  }

  function candidateSectionButtons() {
    return Array.from(document.querySelectorAll('button[aria-expanded], button[data-state], [role="button"][aria-expanded]'))
      .filter((node) => SECTION_NAMES.has(sectionName(node)));
  }

  function isExpanded(button) {
    const aria = button.getAttribute("aria-expanded");
    if (aria === "true" || aria === "false") return aria === "true";
    const state = String(button.getAttribute("data-state") || "").toLowerCase();
    if (state === "open" || state === "closed") return state === "open";
    return null;
  }

  function readState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeState(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Persistence is best-effort in private/restricted browsing modes.
    }
  }

  function rememberButton(button) {
    if (!BCG.isFeatureEnabled("navigation.persistSidebarSections")) return;
    const name = sectionName(button);
    const expanded = isExpanded(button);
    if (!name || expanded === null) return;
    const state = readState();
    if (state[name] === expanded) return;
    state[name] = expanded;
    writeState(state);
    BCG.recordTrace("sidebar-section-saved", { section: name, expanded });
  }

  function restoreSections() {
    if (!BCG.isFeatureEnabled("navigation.persistSidebarSections")) return;
    const wanted = readState();
    if (!Object.keys(wanted).length) return;
    for (const button of candidateSectionButtons()) {
      const name = sectionName(button);
      if (!(name in wanted)) continue;
      const current = isExpanded(button);
      const desired = Boolean(wanted[name]);
      if (current === null || current === desired) continue;
      button.click();
      BCG.recordTrace("sidebar-section-restored", { section: name, expanded: desired });
    }
  }

  function scheduleRestore() {
    const generation = ++restoreGeneration;
    for (const delay of RESTORE_DELAYS) {
      window.setTimeout(() => {
        if (generation !== restoreGeneration) return;
        restoreSections();
      }, delay);
    }
  }

  function projectRowFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    const clickedLink = target.closest('a[href]');
    const clickedHref = String(clickedLink?.getAttribute("href") || "");
    if (/\/c\//i.test(clickedHref) && !/g-p-|project/i.test(clickedHref)) return null;

    let node = target;
    for (let depth = 0; node instanceof Element && depth < 8; depth += 1, node = node.parentElement) {
      if (node.matches("nav, aside")) break;
      const ownBits = `${node.getAttribute("data-testid") || ""} ${node.getAttribute("data-project-id") || ""}`;
      const projectLink = node.matches('a[href*="g-p-" i], a[href*="project" i]')
        ? node
        : node.querySelector('a[href*="g-p-" i], a[href*="project" i]');
      if (!projectLink && !/project|g-p-/i.test(ownBits)) continue;
      if (projectMoreButton(node)) return node;
    }
    return null;
  }

  function visibleMenuItem(label) {
    const wanted = String(label || "").trim().toLowerCase();
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [data-radix-menu-content] button'))
      .find((node) => {
        if (!(node instanceof Element)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && normalizedText(node) === wanted;
      }) || null;
  }

  function projectMoreButton(row) {
    const buttons = Array.from(row.querySelectorAll("button"));
    return buttons.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`;
      return /more|options|menu|\.\.\.|…/i.test(label);
    }) || null;
  }

  async function openProjectHome(row) {
    const more = projectMoreButton(row);
    if (!more) return false;
    more.click();
    for (const delay of [0, 40, 100, 180, 300, 500]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      const item = visibleMenuItem("Project home");
      if (!item) continue;
      item.click();
      BCG.recordTrace("project-home-double-click", { nativeMenu: true });
      return true;
    }
    if (more.isConnected) more.click();
    return false;
  }

  document.addEventListener("click", (event) => {
    if (!BCG.isFeatureEnabled("navigation.persistSidebarSections")) return;
    const button = event.target instanceof Element
      ? event.target.closest('button[aria-expanded], button[data-state], [role="button"][aria-expanded]')
      : null;
    if (!button || !SECTION_NAMES.has(sectionName(button))) return;
    requestAnimationFrame(() => rememberButton(button));
  }, true);

  document.addEventListener("dblclick", (event) => {
    if (!BCG.isFeatureEnabled("navigation.projectDoubleClickHome")) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("button")) return;
    const row = projectRowFromEventTarget(event.target);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    void openProjectHome(row).then((opened) => {
      if (!opened) BCG.recordTrace("project-home-double-click-missed", { nativeMenu: false });
    });
  }, true);

  const observer = new MutationObserver(() => scheduleRestore());
  const start = () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    scheduleRestore();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.addEventListener("popstate", scheduleRestore, { passive: true });
  window.addEventListener("bcg:settings-changed", scheduleRestore);

  BCG.sidebarQol = { restore: restoreSections };
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const PAGE_SOURCE = "better-chatgpt-page";
  const DRAFT_KEY = "better-chatgpt:stale-draft-v1";
  const root = document.documentElement;

  function syncBridgeSetting() {
    root.dataset.bcgCrossDeviceGuard = BCG.isFeatureEnabled("resilience.crossDeviceGuard") ? "1" : "0";
  }

  function mainPrompt() {
    return document.querySelector("#prompt-textarea") ||
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('textarea[placeholder*="message" i]') ||
      document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  }

  function setPromptText(prompt, text) {
    if (!(prompt instanceof Element) || !text) return false;
    if (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(prompt), "value")?.set;
      if (setter) setter.call(prompt, text);
      else prompt.value = text;
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (prompt.getAttribute("contenteditable") === "true") {
      prompt.textContent = text;
      prompt.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }
    return false;
  }

  function restoreStaleDraft() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    } catch {
      saved = null;
    }
    if (!saved || saved.path !== location.pathname || Date.now() - Number(saved.savedAt || 0) > 120000) return;
    if (!saved.text) {
      sessionStorage.removeItem(DRAFT_KEY);
      if (saved.hadAttachments) BCG.notify("Desktop chat was stale and refreshed. Reattach the files that were staged in the composer.");
      return;
    }
    let attempts = 0;
    const tryRestore = () => {
      attempts += 1;
      const prompt = mainPrompt();
      const current = prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement
        ? prompt.value
        : String(prompt?.textContent || "");
      if (prompt && !current.trim() && setPromptText(prompt, String(saved.text))) {
        sessionStorage.removeItem(DRAFT_KEY);
        BCG.notify(saved.hadAttachments
          ? "Desktop chat was stale. Your draft was restored; reattach the files that were staged before refresh."
          : "Desktop chat was stale, so Better ChatGPT refreshed it and restored your unsent message.");
        BCG.recordTrace("stale-draft-restored", { restored: true });
        return;
      }
      if (attempts < 30) window.setTimeout(tryRestore, 150);
    };
    tryRestore();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    if (event.data?.type === "bcg:stale-conversation-detected") {
      BCG.recordTrace("stale-conversation-detected", {
        reason: String(event.data.reason || "node-mismatch").slice(0, 80),
      });
    }
  });

  syncBridgeSetting();
  window.addEventListener("bcg:settings-changed", syncBridgeSetting);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreStaleDraft, { once: true });
  else restoreStaleDraft();
})();

/* ===== appearance ===== */
if (globalThis.BetterChatGPT) {
  try {
    (() => {
      "use strict";

      const MARKER = "marc-colored-user-bubble-v3";
      const managedStyles = new WeakMap();
      const styledElements = new Set();

      const setManagedStyle = (element, property, value) => {
        if (!(element instanceof HTMLElement)) return;
        let properties = managedStyles.get(element);
        if (!properties) {
          properties = new Map();
          managedStyles.set(element, properties);
          styledElements.add(element);
        }
        if (!properties.has(property)) {
          properties.set(property, {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          });
        }
        element.style.setProperty(property, value, "important");
      };

      const restoreAllBubbleStyles = () => {
        for (const element of styledElements) {
          const properties = managedStyles.get(element);
          for (const [property, original] of properties || []) {
            if (original.value) element.style.setProperty(property, original.value, original.priority);
            else element.style.removeProperty(property);
          }
          element.classList?.remove(MARKER);
          managedStyles.delete(element);
        }
        styledElements.clear();
      };

      const isEnabled = () =>
        globalThis.BetterChatGPT?.isFeatureEnabled?.("appearance.enabled") !== false;

      const looksLikeBubble = (element, root) => {
        if (!(element instanceof HTMLElement)) return false;

        const style = getComputedStyle(element);
        const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
        const rootWidth = root.getBoundingClientRect().width;
        const width = element.getBoundingClientRect().width;

        return radius >= 14 && width > 20 && width < rootWidth * 0.96;
      };

      const findBubble = (root) => {
        const known = root.querySelector('.user-message-bubble-color, [class*="user-message-bubble"]');
        if (known instanceof HTMLElement) return known;

        const text = root.querySelector('.whitespace-pre-wrap, [class*="whitespace-pre-wrap"], p');
        if (!(text instanceof HTMLElement)) return null;

        let candidate = text;
        while (candidate && candidate !== root) {
          if (looksLikeBubble(candidate, root)) return candidate;
          candidate = candidate.parentElement;
        }

        return text.parentElement;
      };

      const applyBubbleStyle = (bubble) => {
        if (!(bubble instanceof HTMLElement) || !isEnabled()) return;

        if (!bubble.classList.contains(MARKER)) bubble.classList.add(MARKER);
        setManagedStyle(bubble, "background-color", globalThis.BetterChatGPT.settings.appearance.bubbleColor);
        setManagedStyle(bubble, "background-image", "none");
        setManagedStyle(bubble, "opacity", String(globalThis.BetterChatGPT.settings.appearance.opacity));
        setManagedStyle(bubble, "border-radius", `${globalThis.BetterChatGPT.settings.appearance.radiusPx}px`);
        setManagedStyle(bubble, "color", globalThis.BetterChatGPT.getBubbleTextColor());

        bubble.querySelectorAll("*").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.closest('a[href], [role="link"]')) {
            setManagedStyle(node, "color", "LinkText");
            return;
          }
          if (node.closest('pre, code, button, [role="button"]')) return;
          setManagedStyle(node, "color", globalThis.BetterChatGPT.getBubbleTextColor());
        });
      };

      const USER_TURN_SELECTOR = '[data-message-author-role="user"], [data-turn="user"]';
      const observedTurns = new Map();
      const pendingTurns = new Set();
      let scheduled = false;
      let discoveryObserver = null;

      const collectUserTurns = (root) => {
        const turns = new Set();
        if (root?.matches?.(USER_TURN_SELECTOR)) turns.add(root);
        for (const turn of root?.querySelectorAll?.(USER_TURN_SELECTOR) || []) turns.add(turn);
        return turns;
      };

      const scanTurn = (turn) => {
        if (!(turn instanceof HTMLElement) || !turn.isConnected || !isEnabled()) return;
        const bubble = findBubble(turn);
        if (bubble) applyBubbleStyle(bubble);
      };

      const scheduleTurn = (turn) => {
        if (!(turn instanceof HTMLElement) || !turn.isConnected) return;
        pendingTurns.add(turn);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const turns = Array.from(pendingTurns);
          pendingTurns.clear();
          for (const pending of turns) scanTurn(pending);
        });
      };

      const observeTurn = (turn) => {
        if (!(turn instanceof HTMLElement) || observedTurns.has(turn)) return;
        const observer = new MutationObserver((records) => {
          const relevant = records.some((record) =>
            record.type !== "attributes" || record.attributeName !== "class" || record.target !== turn,
          );
          if (relevant) scheduleTurn(turn);
        });
        observer.observe(turn, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "data-testid", "data-message-author-role", "data-turn"],
        });
        observedTurns.set(turn, observer);
        scheduleTurn(turn);
      };

      const cleanupTurns = () => {
        for (const [turn, observer] of observedTurns) {
          if (turn.isConnected) continue;
          observer.disconnect();
          observedTurns.delete(turn);
          pendingTurns.delete(turn);
        }
      };

      const discoverTurns = (root = document) => {
        for (const turn of collectUserTurns(root)) observeTurn(turn);
      };

      const scheduleScan = () => {
        if (!isEnabled()) {
          restoreAllBubbleStyles();
          return;
        }
        discoverTurns(document);
        for (const turn of observedTurns.keys()) scheduleTurn(turn);
      };

      const start = () => {
        discoverTurns(document);
        window.addEventListener("bcg:appearance-refresh", scheduleScan);
        window.addEventListener("bcg:settings-changed", scheduleScan);
        discoveryObserver = new MutationObserver((records) => {
          let discovered = false;
          for (const record of records) {
            for (const node of record.addedNodes || []) {
              if (!(node instanceof Element)) continue;
              const turns = collectUserTurns(node);
              if (turns.size === 0) continue;
              discovered = true;
              for (const turn of turns) observeTurn(turn);
            }
          }
          if (discovered || observedTurns.size > 0) cleanupTurns();
        });
        discoveryObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    })();
  } catch (error) {
    globalThis.BetterChatGPT?.recordError("appearance", error);
  }
}

/* ===== hybrid-scroll ===== */
if (globalThis.BetterChatGPT) {
  try {
    (function bootstrap(root, factory) {
      "use strict";

      const api = factory();

      if (typeof module === "object" && module.exports) {
        module.exports = api;
        return;
      }

      api.install(root);
    })(typeof window !== "undefined" ? window : globalThis, function factory() {
      "use strict";

      const MESSAGE_SELECTOR = "[data-message-author-role]";
      const FALLBACK_TURN_SELECTOR = [
        'section[data-testid^="conversation-turn-"]',
        'article[data-testid^="conversation-turn-"]',
      ].join(",");
      const SCROLL_ROOT_SELECTOR = '[class*="group/scroll-root"]';
      const STOP_BUTTON_SELECTOR = [
        'button[data-testid="stop-button"]',
        'button[data-testid="composer-stop-button"]',
        'button[aria-label*="stop generating" i]',
        'button[title*="stop generating" i]',
      ].join(",");
      const SCROLL_INDICATOR_SELECTOR =
        'span[aria-hidden="true"][class*="group-data-stream-active/scroll-root:opacity-100"]';

      const POLL_MS = 100;
      const CLICK_RETRY_DELAYS_MS = [120, 250, 450, 750];
      const NAVIGATION_SCROLL_DELAYS_MS = [0, 80, 180, 320, 550, 900, 1400, 2200, 3400, 5000];
      const BOTTOM_REARM_DISTANCE_PX = 48;
      const BOTTOM_TOLERANCE_PX = 3;
      const USER_TRANSCRIPT_GROWTH_WINDOW_MS = 6000;

      function scrollingEnabled() {
        return Boolean(globalThis.BetterChatGPT?.isFeatureEnabled?.("scrolling.enabled"));
      }

      function liveScrollNumber(key, fallback) {
        const value = Number(globalThis.BetterChatGPT?.settings?.scrolling?.[key]);
        return Number.isFinite(value) ? value : fallback;
      }

      const armDistancePx = () => liveScrollNumber("armDistancePx", 600);
      const stableMs = () => liveScrollNumber("stableMs", 1800);
      const maxFollowMs = () => liveScrollNumber("maxFollowMs", 12000);
      const manualPauseMs = () => liveScrollNumber("manualPauseMs", 2500);
      const voiceLatchMs = () => liveScrollNumber("voiceLatchMs", 90000);

      function computeFollowTarget(maximum) {
        return Number.isFinite(maximum) ? Math.max(0, maximum) : 0;
      }

      function chooseScrollStrategy(voiceActive) {
        return voiceActive ? "voice-follow" : "native-click";
      }

      function classifyVoiceControlLabels(labels) {
        const activePattern = [
          "\\b(?:end|exit|leave|close|stop)\\b.{0,24}\\b(?:voice|conversation|call)\\b",
          "\\b(?:voice|conversation|call)\\b.{0,24}\\b(?:end|exit|leave|close|stop)\\b",
          "\\b(?:mute|unmute)\\b.{0,20}\\b(?:microphone|mic|voice)\\b",
          "^(?:mute|unmute)$",
          "\\bvoice[-_ ]?(?:session|conversation|call)[-_ ]?(?:active|controls?)\\b",
        ].join("|");
        const inactivePattern = [
          "\\b(?:start|open|launch|begin)\\b.{0,20}\\bvoice\\b",
          "\\bvoice\\b.{0,20}\\b(?:start|open|launch|begin)\\b",
        ].join("|");
        const activeRegex = new RegExp(activePattern, "i");
        const inactiveRegex = new RegExp(inactivePattern, "i");

        for (const rawLabel of labels || []) {
          const label = String(rawLabel || "").trim();
          if (!label || inactiveRegex.test(label)) continue;
          if (activeRegex.test(label)) return true;
        }

        return false;
      }

      function classifyInactiveVoiceControlLabels(labels) {
        const inactiveRegex = new RegExp(
          [
            "\\b(?:start|open|launch|begin)\\b.{0,20}\\bvoice\\b",
            "\\bvoice\\b.{0,20}\\b(?:start|open|launch|begin)\\b",
          ].join("|"),
          "i",
        );

        return (labels || []).some((rawLabel) => inactiveRegex.test(String(rawLabel || "").trim()));
      }

      function isIncrementalUserTranscript(previous, current, maxGapMs = USER_TRANSCRIPT_GROWTH_WINDOW_MS) {
        if (!previous || !current) return false;
        if (previous.elementId !== current.elementId) return false;
        if (!previous.text || !current.text || previous.text === current.text) return false;

        const elapsed = current.changedAt - previous.changedAt;
        return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= maxGapMs;
      }

      function shouldArmFollow(distanceFromBottom, threshold = armDistancePx()) {
        return Number.isFinite(distanceFromBottom) && distanceFromBottom >= 0 && distanceFromBottom <= threshold;
      }

      function shouldStopFollow(now, startedAt, stableSince, stableWindowMs = stableMs(), maxMs = maxFollowMs()) {
        return now - startedAt >= maxMs || now - stableSince >= stableWindowMs;
      }

      function install(win) {
        const doc = win.document;
        if (!doc?.documentElement) return;

        let timer = 0;
        let destroyed = false;
        let activeFollow = null;
        let manualPauseUntil = 0;
        let manualScrollHold = false;
        let navigationScrollRequest = 0;
        let lastLocationHref = win.location.href;
        let restoreHistoryHooks = () => {};
        let lastSignature = getTranscriptSignature();
        let wasGenerating = isGenerating();
        let pendingNativeClick = 0;
        let voiceLatchUntil = 0;
        let lastUserTranscriptState = null;
        let modeOverride = globalThis.BetterChatGPT.settings.scrolling.mode;
        let sawActiveVoiceControl = false;

        const elementIds = new WeakMap();
        let nextElementId = 1;

        function getElementId(element) {
          if (!(element instanceof win.Element)) return null;
          let id = elementIds.get(element);
          if (!id) {
            id = nextElementId++;
            elementIds.set(element, id);
          }
          return id;
        }

        function isGenerating() {
          return Boolean(doc.querySelector(STOP_BUTTON_SELECTOR));
        }

        function findScrollToBottomButton() {
          const indicator = doc.querySelector(SCROLL_INDICATOR_SELECTOR);
          const button = indicator?.closest("button");
          return button instanceof win.HTMLButtonElement ? button : null;
        }

        function isVisibleElement(element) {
          if (!(element instanceof win.Element)) return false;
          const style = win.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") === 0)
            return false;

          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < win.innerHeight;
        }

        function getVisibleControlLabels() {
          const selectors = [
            "button[aria-label]",
            "button[title]",
            "button[data-testid]",
            '[role="button"][aria-label]',
            '[role="button"][title]',
            '[data-testid*="voice" i]',
            '[data-testid*="audio" i]',
          ].join(",");
          const labels = [];

          for (const element of doc.querySelectorAll(selectors)) {
            if (!isVisibleElement(element)) continue;
            for (const value of [
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.getAttribute("data-testid"),
              element.textContent,
            ]) {
              const label = value?.trim();
              if (label) labels.push(label);
            }
          }

          return labels;
        }

        function getConversationTurns() {
          const messages = [...doc.querySelectorAll(MESSAGE_SELECTOR)];
          if (messages.length) return messages;
          return [...doc.querySelectorAll(FALLBACK_TURN_SELECTOR)];
        }

        function getTranscriptSignature() {
          return getConversationTurns()
            .slice(-8)
            .map((turn) => {
              const role =
                turn.getAttribute("data-message-author-role") || turn.getAttribute("data-testid") || turn.tagName;
              const text = turn.textContent?.trim() ?? "";
              return `${role}:${text.length}:${text.slice(-120)}`;
            })
            .join("|");
        }

        function getLatestTurn() {
          const turns = getConversationTurns();
          return turns.length ? turns[turns.length - 1] : null;
        }

        function getLatestUserTurn() {
          const turns = getConversationTurns();
          for (let index = turns.length - 1; index >= 0; index -= 1) {
            const turn = turns[index];
            const role = turn.getAttribute("data-message-author-role") || "";
            if (role.toLowerCase() === "user") return turn;
          }
          return null;
        }

        function refreshVoiceEvidence(now) {
          const labels = getVisibleControlLabels();
          const activeControl = classifyVoiceControlLabels(labels);
          const inactiveControl = classifyInactiveVoiceControlLabels(labels);

          if (activeControl) {
            voiceLatchUntil = Math.max(voiceLatchUntil, now + voiceLatchMs());
            sawActiveVoiceControl = true;
          } else if (sawActiveVoiceControl && inactiveControl) {
            voiceLatchUntil = 0;
            sawActiveVoiceControl = false;
          }

          const latestUser = getLatestUserTurn();
          if (latestUser) {
            const currentState = {
              elementId: getElementId(latestUser),
              text: latestUser.textContent?.trim() ?? "",
              changedAt: now,
            };

            if (isIncrementalUserTranscript(lastUserTranscriptState, currentState)) {
              voiceLatchUntil = Math.max(voiceLatchUntil, now + voiceLatchMs());
            }

            if (
              !lastUserTranscriptState ||
              currentState.elementId !== lastUserTranscriptState.elementId ||
              currentState.text !== lastUserTranscriptState.text
            ) {
              lastUserTranscriptState = currentState;
            }
          }

          if (modeOverride === "voice") return true;
          if (modeOverride === "text") return false;
          return now < voiceLatchUntil;
        }

        function isVoiceModeActive(now = win.performance.now()) {
          return refreshVoiceEvidence(now);
        }

        function scheduleNativeScrollAfterResponse() {
          if (manualScrollHold || win.performance.now() < manualPauseUntil) return;
          const requestId = ++pendingNativeClick;

          function tryClick(attempt) {
            if (requestId !== pendingNativeClick || isGenerating() || manualScrollHold) return;
            if (win.performance.now() < manualPauseUntil) return;
            if (chooseScrollStrategy(isVoiceModeActive()) !== "native-click") return;

            const button = findScrollToBottomButton();
            if (button && !button.disabled) {
              button.click();
              return;
            }

            const nextAttempt = attempt + 1;
            if (nextAttempt < CLICK_RETRY_DELAYS_MS.length) {
              win.setTimeout(() => tryClick(nextAttempt), CLICK_RETRY_DELAYS_MS[nextAttempt]);
            }
          }

          win.setTimeout(() => tryClick(0), CLICK_RETRY_DELAYS_MS[0]);
        }

        function isNearBottom(scroller, threshold = BOTTOM_REARM_DISTANCE_PX) {
          return Boolean(scroller) && getMetrics(scroller).distanceFromBottom <= threshold;
        }

        function cancelPendingAutomaticScroll() {
          pendingNativeClick += 1;
          navigationScrollRequest += 1;
          stopFollow();
        }

        function refreshManualScrollHold() {
          if (!manualScrollHold) return;
          const scroller = findTranscriptScroller();
          if (scroller && isNearBottom(scroller)) {
            manualScrollHold = false;
          }
        }

        function scheduleConversationBottomScroll(reason = "navigation") {
          const requestId = ++navigationScrollRequest;
          const href = win.location.href;

          pendingNativeClick += 1;
          manualScrollHold = false;
          manualPauseUntil = 0;
          stopFollow();

          for (const delay of NAVIGATION_SCROLL_DELAYS_MS) {
            win.setTimeout(() => {
              if (destroyed || requestId !== navigationScrollRequest || win.location.href !== href || manualScrollHold) {
                return;
              }

              const scroller = findTranscriptScroller();
              if (!scroller) return;
              pinToBottom(scroller);
            }, delay);
          }

          if (globalThis.BetterChatGPT?.settings?.advanced?.debug) {
            console.debug("[ChatGPT Hybrid Scroll] scheduled bottom on", reason);
          }
        }

        function checkForConversationNavigation() {
          const href = win.location.href;
          if (href === lastLocationHref) return false;
          lastLocationHref = href;
          scheduleConversationBottomScroll("route change");
          return true;
        }

        function installHistoryHooks() {
          const history = win.history;
          if (!history) return () => {};

          const restorers = [];
          const scheduleCheck = () => win.setTimeout(checkForConversationNavigation, 0);

          for (const methodName of ["pushState", "replaceState"]) {
            const original = history[methodName];
            if (typeof original !== "function") continue;

            const wrapped = function wrappedHistoryMethod(...args) {
              const result = Reflect.apply(original, this, args);
              scheduleCheck();
              return result;
            };

            try {
              history[methodName] = wrapped;
              restorers.push(() => {
                if (history[methodName] === wrapped) history[methodName] = original;
              });
            } catch {
              // The polling fallback below still detects the route change.
            }
          }

          const onPopState = () => checkForConversationNavigation();
          const onHashChange = () => checkForConversationNavigation();
          win.addEventListener("popstate", onPopState);
          win.addEventListener("hashchange", onHashChange);

          restorers.push(() => win.removeEventListener("popstate", onPopState));
          restorers.push(() => win.removeEventListener("hashchange", onHashChange));

          return () => {
            for (const restore of restorers.reverse()) restore();
          };
        }

        function isScrollable(element) {
          if (!(element instanceof win.Element)) return false;
          const style = win.getComputedStyle(element);
          return /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4;
        }

        function visibleArea(element) {
          const rect = element.getBoundingClientRect();
          const width = Math.max(0, Math.min(rect.right, win.innerWidth) - Math.max(rect.left, 0));
          const height = Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0));
          return width * height;
        }

        function scoreScroller(element) {
          if (!isScrollable(element)) return -Infinity;

          const area = visibleArea(element);
          if (area <= 0) return -Infinity;

          const classBonus = element.matches(SCROLL_ROOT_SELECTOR) ? 1_000_000_000 : 0;
          const viewportBonus = element.clientHeight >= win.innerHeight * 0.7 ? 100_000_000 : 0;

          return classBonus + viewportBonus + area + element.scrollHeight;
        }

        function findTranscriptScroller() {
          const latest = getLatestTurn();
          let best = null;
          let bestScore = -Infinity;

          let current = latest?.parentElement ?? null;
          while (current && current !== doc.body) {
            const score = scoreScroller(current);
            if (score > bestScore) {
              best = current;
              bestScore = score;
            }
            current = current.parentElement;
          }

          if (best) return best;

          for (const candidate of doc.querySelectorAll(SCROLL_ROOT_SELECTOR)) {
            const score = scoreScroller(candidate);
            if (score > bestScore) {
              best = candidate;
              bestScore = score;
            }
          }

          return best;
        }

        function getMetrics(scroller) {
          const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          return {
            maximum,
            distanceFromBottom: Math.max(0, maximum - scroller.scrollTop),
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
          };
        }

        function pinToBottom(scroller) {
          const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const target = computeFollowTarget(maximum);

          scroller.scrollTop = target;
          if (typeof scroller.scrollTo === "function") {
            scroller.scrollTo({ top: target, left: 0, behavior: "auto" });
          }

          return Math.abs(scroller.scrollTop - target) <= BOTTOM_TOLERANCE_PX;
        }

        function startOrRefreshFollow(scroller, signature, now) {
          const metrics = getMetrics(scroller);

          if (!activeFollow) {
            if (manualScrollHold || now < manualPauseUntil) return;
            if (!shouldArmFollow(metrics.distanceFromBottom)) return;

            activeFollow = {
              startedAt: now,
              stableSince: now,
              scroller,
              signature,
              scrollHeight: metrics.scrollHeight,
              clientHeight: metrics.clientHeight,
            };
          } else {
            activeFollow.stableSince = now;
            activeFollow.scroller = scroller;
            activeFollow.signature = signature;
            activeFollow.scrollHeight = metrics.scrollHeight;
            activeFollow.clientHeight = metrics.clientHeight;
          }

          pinToBottom(scroller);
        }

        function stopFollow() {
          activeFollow = null;
        }

        function tick() {
          timer = 0;
          if (destroyed || !scrollingEnabled()) return;

          const now = win.performance.now();
          checkForConversationNavigation();
          refreshManualScrollHold();
          const generating = isGenerating();
          const signature = getTranscriptSignature();
          const transcriptChanged = signature !== lastSignature;
          const voiceActive = isVoiceModeActive(now);
          const strategy = chooseScrollStrategy(voiceActive);
          const scroller = strategy === "voice-follow" ? findTranscriptScroller() : null;

          if (!wasGenerating && generating) {
            pendingNativeClick += 1;
          }

          if (wasGenerating && !generating) {
            if (strategy === "native-click") {
              stopFollow();
              if (!manualScrollHold) scheduleNativeScrollAfterResponse();
            } else {
              pendingNativeClick += 1;
            }
          }

          wasGenerating = generating;

          if (strategy === "voice-follow" && scroller && transcriptChanged) {
            startOrRefreshFollow(scroller, signature, now);
            voiceLatchUntil = Math.max(voiceLatchUntil, now + voiceLatchMs());
          } else if (strategy === "native-click" && activeFollow) {
            stopFollow();
          }

          lastSignature = signature;

          if (activeFollow) {
            if (strategy !== "voice-follow" || manualScrollHold || now < manualPauseUntil) {
              stopFollow();
            } else {
              const currentScroller = scroller || activeFollow.scroller;

              if (!currentScroller?.isConnected) {
                stopFollow();
              } else {
                const metrics = getMetrics(currentScroller);
                const geometryChanged =
                  currentScroller !== activeFollow.scroller ||
                  metrics.scrollHeight !== activeFollow.scrollHeight ||
                  metrics.clientHeight !== activeFollow.clientHeight ||
                  signature !== activeFollow.signature;

                if (geometryChanged) activeFollow.stableSince = now;

                activeFollow.scroller = currentScroller;
                activeFollow.signature = signature;
                activeFollow.scrollHeight = metrics.scrollHeight;
                activeFollow.clientHeight = metrics.clientHeight;

                pinToBottom(currentScroller);

                if (shouldStopFollow(now, activeFollow.startedAt, activeFollow.stableSince)) {
                  win.requestAnimationFrame(() => {
                    if (currentScroller.isConnected) pinToBottom(currentScroller);
                  });
                  stopFollow();
                }
              }
            }
          }

          timer = win.setTimeout(tick, POLL_MS);
        }

        function pauseForManualScroll() {
          if (!scrollingEnabled()) return;
          manualPauseUntil = win.performance.now() + manualPauseMs();
          manualScrollHold = true;
          globalThis.__BCG_MANUAL_SCROLL_ACTIVE_UNTIL = Math.max(
            Number(globalThis.__BCG_MANUAL_SCROLL_ACTIVE_UNTIL || 0),
            Date.now() + 750,
          );
          cancelPendingAutomaticScroll();
        }

        function onPointerDown(event) {
          const scroller = findTranscriptScroller();
          if (scroller && event.target === scroller) pauseForManualScroll();
        }

        function onKeyDown(event) {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            pauseForManualScroll();
          }
        }

        doc.addEventListener("wheel", pauseForManualScroll, { capture: true, passive: true });
        doc.addEventListener("touchmove", pauseForManualScroll, { capture: true, passive: true });
        doc.addEventListener("pointerdown", onPointerDown, true);
        doc.addEventListener("keydown", onKeyDown, true);
        restoreHistoryHooks = installHistoryHooks();
        scheduleConversationBottomScroll("initial load");

        function syncRuntimeSettings() {
          modeOverride = globalThis.BetterChatGPT?.settings?.scrolling?.mode || "auto";
          if (!scrollingEnabled()) {
            win.clearTimeout(timer);
            timer = 0;
            manualPauseUntil = 0;
            manualScrollHold = false;
            cancelPendingAutomaticScroll();
            stopFollow();
            return;
          }
          if (!timer) timer = win.setTimeout(tick, POLL_MS);
        }

        win.__chatgptHybridScroll = {
          forceVoiceFollow() {
            if (!scrollingEnabled()) return false;
            modeOverride = "voice";
            const scroller = findTranscriptScroller();
            if (!scroller) return false;

            const now = win.performance.now();
            manualPauseUntil = 0;
            manualScrollHold = false;
            navigationScrollRequest += 1;
            activeFollow = {
              startedAt: now,
              stableSince: now,
              scroller,
              signature: getTranscriptSignature(),
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            };
            return pinToBottom(scroller);
          },
          setMode(mode) {
            if (!["auto", "voice", "text"].includes(mode)) {
              throw new TypeError('Mode must be "auto", "voice", or "text".');
            }
            modeOverride = mode;
            if (mode === "text") stopFollow();
            return modeOverride;
          },
          status() {
            const now = win.performance.now();
            const voiceActive = isVoiceModeActive(now);
            const scroller = voiceActive ? findTranscriptScroller() : null;
            return {
              modeOverride,
              voiceActive,
              strategy: chooseScrollStrategy(voiceActive),
              activeFollow: Boolean(activeFollow),
              scrollerFound: Boolean(scroller),
              distanceFromBottom: scroller ? Math.round(getMetrics(scroller).distanceFromBottom) : null,
              pausedMs: Math.max(0, Math.round(manualPauseUntil - now)),
              manualScrollHold,
              generating: isGenerating(),
            };
          },
          destroy() {
            destroyed = true;
            pendingNativeClick += 1;
            win.clearTimeout(timer);
            doc.removeEventListener("wheel", pauseForManualScroll, true);
            doc.removeEventListener("touchmove", pauseForManualScroll, true);
            doc.removeEventListener("pointerdown", onPointerDown, true);
            doc.removeEventListener("keydown", onKeyDown, true);
            win.removeEventListener("bcg:settings-changed", syncRuntimeSettings);
            restoreHistoryHooks();
            navigationScrollRequest += 1;
            stopFollow();
            delete win.__chatgptHybridScroll;
          },
        };

        win.addEventListener("bcg:settings-changed", syncRuntimeSettings);
        syncRuntimeSettings();
      }

      return {
        install,
        computeFollowTarget,
        chooseScrollStrategy,
        classifyVoiceControlLabels,
        classifyInactiveVoiceControlLabels,
        isIncrementalUserTranscript,
        shouldArmFollow,
        shouldStopFollow,
      };
    });
  } catch (error) {
    globalThis.BetterChatGPT?.recordError("hybrid-scroll", error);
  }
}

/* ===== queued-send ===== */
if (globalThis.BetterChatGPT) {
  try {
    (() => {
      "use strict";

      const CHECK_INTERVAL_MS = 250;
      const NATIVE_COMPOSER_SETTLE_MS = 2500;
      const NATIVE_PAYLOAD_VISUAL_GRACE_MS = 120;
      const POINTER_QUEUE_GESTURE_DEDUPE_MS = 450;
      const queueFeatureEnabled = () => Boolean(globalThis.BetterChatGPT?.isFeatureEnabled?.("queue.enabled"));
      const maxQueueMs = () => Number(globalThis.BetterChatGPT?.settings?.queue?.maxQueueMs) || 600000;
      const keepSendButtonVisuallyEnabled = () => Boolean(globalThis.BetterChatGPT?.isFeatureEnabled?.("queue.visuallyEnableSend"));
      const nativePayloadHintMs = () => maxQueueMs();
      const QUEUE_OBSERVER_OPTIONS = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "data-testid"],
      };

      function observeQueueBodyWhenReady(queueObserver) {
        let attempts = 0;

        function tryObserve() {
          const body = document.body;
          if (body) {
            queueObserver.observe(body, QUEUE_OBSERVER_OPTIONS);
            return;
          }

          attempts += 1;
          if (attempts < 100) {
            setTimeout(tryObserve, 25);
            return;
          }

          globalThis.BetterChatGPT?.recordError(
            "queued-send",
            new TypeError("document.body remained unavailable during queue initialization"),
          );
        }

        tryObserve();
      }

      function belongsToEditSubmit(button) {
        if (!(button instanceof Element)) return false;
        if (button.closest('.bcg-edit-enhanced, [data-testid*="edit" i]')) return true;
        try {
          return Boolean(globalThis.BetterChatGPT?.editAttachments?.isEditSubmitControl?.(button));
        } catch {
          return false;
        }
      }

      let queued = false;
      let queuedAt = 0;
      let checkTimer = null;
      let observer = null;
      let toastTimer = null;
      let rafPending = false;
      let visuallyOverriddenButton = null;
      let sendProxyButton = null;
      let sendProxyNativeButton = null;
      const sendProxyNativeStyle = new WeakMap();
      let nativeComposerBusyUntil = 0;
      let nativePayloadHintUntil = 0;
      let nativePayloadVisualReadyAt = 0;
      let queuedComposerFiles = [];
      let queuedBridgeNonce = "";
      let bridgeWaitToastAt = 0;
      let queuedSendAttempt = null;
      let internalQueuedSendClick = false;
      let lastPointerQueueGestureUntil = 0;
      let lastNativeUploadCount = 0;

      function log(...args) {
        if (globalThis.BetterChatGPT?.settings?.advanced?.debug) console.log("[ChatGPT queued send]", ...args);
      }

      function followUpBridge() {
        return globalThis.BetterChatGPT?.editAttachmentBridge || null;
      }

      function fileKey(file) {
        return [file?.name || "", Number(file?.size || 0), file?.type || "", Number(file?.lastModified || 0)].join("\u0000");
      }

      function rememberQueuedComposerFiles(files) {
        if (!isAssistantGenerating()) return;
        const existing = new Set(queuedComposerFiles.map(fileKey));
        for (const file of files || []) {
          if (!(file instanceof File)) continue;
          const key = fileKey(file);
          if (existing.has(key)) continue;
          existing.add(key);
          queuedComposerFiles.push(file);
        }
      }

      function promptText() {
        const input = getPromptInput();
        if (!input) return "";
        return "value" in input ? String(input.value || "") : String(input.textContent || "");
      }

      function composerMentionAttachments(bridge) {
        const root = getComposerRoot() || document;
        const attachments = [];
        for (const pill of root.querySelectorAll?.('[data-inline-selection-pill][data-id]') || []) {
          const rawId = String(pill.getAttribute("data-id") || "");
          const fileId = rawId.startsWith("file-library:") ? rawId.slice("file-library:".length) : "";
          if (!fileId) continue;
          const attachment = bridge.attachmentForId?.(fileId);
          if (!attachment) return null;
          attachments.push({ ...attachment, __bcgMentionReference: true });
        }
        return attachments;
      }

      function queuedFollowUpAttachments() {
        const bridge = followUpBridge();
        if (!bridge?.isReady?.()) return queuedComposerFiles.length ? null : [];

        const attachments = [];
        const seen = new Set();
        for (const file of queuedComposerFiles) {
          const attachment = bridge.attachmentForFile?.(file);
          if (!attachment) return null;
          if (!seen.has(attachment.id)) {
            seen.add(attachment.id);
            attachments.push(attachment);
          }
        }

        const mentions = composerMentionAttachments(bridge);
        if (mentions === null) return null;
        for (const attachment of mentions) {
          if (!seen.has(attachment.id)) {
            seen.add(attachment.id);
            attachments.push(attachment);
          }
        }
        return attachments;
      }

      function armQueuedFollowUp() {
        if (queuedBridgeNonce) return true;
        const attachments = queuedFollowUpAttachments();
        if (attachments === null) {
          const now = Date.now();
          if (now - bridgeWaitToastAt > 1800) {
            bridgeWaitToastAt = now;
            showToast("Waiting for attachment metadata…");
          }
          return false;
        }
        if (!attachments.length) return true;
        const bridge = followUpBridge();
        const nonce = bridge?.armSubmit?.(promptText(), attachments, (result) => {
          queuedBridgeNonce = "";
          if (!result?.ok) showToast(result?.error || "The queued attachment request failed.");
        });
        if (!nonce) return false;
        queuedBridgeNonce = nonce;
        globalThis.BetterChatGPT?.recordTrace?.("followup-submit-armed", { attachmentCount: attachments.length });
        return true;
      }

      function clearQueuedComposerFiles() {
        queuedComposerFiles = [];
        bridgeWaitToastAt = 0;
      }

      function isNativeComposerBusy() {
        return Date.now() < nativeComposerBusyUntil;
      }

      function clearNativePayloadHint() {
        nativePayloadHintUntil = 0;
        nativePayloadVisualReadyAt = 0;
      }

      function hasNativePayloadIntent() {
        return nativePayloadHintUntil > Date.now();
      }

      function hasNativePayloadHint() {
        const now = Date.now();
        return hasNativePayloadIntent() && nativePayloadVisualReadyAt > 0 && nativePayloadVisualReadyAt <= now;
      }

      function activeNativeUploadCount() {
        const raw = document.documentElement?.dataset?.bcgNativeUploadCount;
        const count = Number.parseInt(String(raw ?? "0"), 10);
        return Number.isFinite(count) && count > 0 ? count : 0;
      }

      function hasActiveNativeUpload() {
        return activeNativeUploadCount() > 0;
      }

      function updateNativeUploadState(count) {
        const nextCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : activeNativeUploadCount();
        const previousCount = lastNativeUploadCount;
        lastNativeUploadCount = nextCount;

        if (previousCount > 0 && nextCount === 0) {
          // The page bridge is authoritative for native attachment upload completion.
          // Once it reaches zero, retire the long-lived payload hint and attachment
          // settle grace immediately so a completed attachment sends like a normal
          // composer message instead of being re-queued for another 2.5 seconds.
          clearNativePayloadHint();
          nativeComposerBusyUntil = Math.min(nativeComposerBusyUntil, Date.now());
          globalThis.BetterChatGPT?.recordTrace?.("queue-native-upload-settled", {});
        }
      }

      function eventHasNativePayload(event) {
        const target = event.target;

        if (target instanceof HTMLInputElement && target.type === "file" && target.files?.length > 0) {
          return true;
        }

        const transfer = event.clipboardData || event.dataTransfer;

        // beforeinput events usually do not expose the actual clipboard payload.
        // The preceding paste/drop event already classified it, so an absent
        // transfer is not enough reason to start attachment-style visual probing.
        if (!transfer) return false;

        try {
          if (transfer.files?.length > 0) return true;
          if (Array.from(transfer.items || []).some((item) => item.kind === "file")) return true;
          if (Array.from(transfer.types || []).some((type) => String(type).toLowerCase() === "files")) {
            return true;
          }

          return false;
        } catch {
          return false;
        }
      }

      function eventIsFileInputWithFiles(event) {
        const target = event.target;

        return Boolean(target instanceof HTMLInputElement && target.type === "file" && target.files?.length > 0);
      }

      function isAssistantGenerating() {
        const directSelectors = [
          'button[data-testid="stop-button"]',
          'button[aria-label*="stop generating" i]',
          'button[aria-label*="stop response" i]',
          'button[aria-label*="stop streaming" i]',
          'button[title*="stop generating" i]',
          'button[title*="stop response" i]',
        ];

        if (directSelectors.some((selector) => qsa(selector).some(isVisible))) {
          return true;
        }

        const root = getComposerRoot();
        if (!root) return false;

        return qsa("button", root).some((button) => {
          if (!isVisible(button)) return false;

          const bits = textOf(button);

          return (
            /\bstop\b/i.test(bits) &&
            !/\b(stop listening|stop recording|microphone|voice|camera|screen share)\b/i.test(bits)
          );
        });
      }

      function markNativeComposerBusy(source, event = null) {
        const now = Date.now();

        nativeComposerBusyUntil = Math.max(nativeComposerBusyUntil, now + NATIVE_COMPOSER_SETTLE_MS);

        if (eventHasNativePayload(event || {})) {
          // This lets us show the disabled send button as queueable without reading
          // huge temporary paste text or poking around attachment previews while
          // ChatGPT is still doing its own conversion/upload work.
          nativePayloadHintUntil = Math.max(nativePayloadHintUntil, now + nativePayloadHintMs());

          if (!nativePayloadVisualReadyAt || nativePayloadVisualReadyAt > now + NATIVE_PAYLOAD_VISUAL_GRACE_MS) {
            nativePayloadVisualReadyAt = now + NATIVE_PAYLOAD_VISUAL_GRACE_MS;
          }
        }

        // Ordinary text keeps the queue completely dormant while ProseMirror is
        // settling. Confirmed files may wake the visual Send override after the
        // short payload grace so the user can queue them during a real upload.
        if (!queued && visuallyOverriddenButton && !hasNativePayloadHint()) {
          clearVisualOverride(visuallyOverriddenButton);
        }

        setTimeout(() => {
          scheduleCheck();
        }, NATIVE_PAYLOAD_VISUAL_GRACE_MS + 50);

        setTimeout(() => {
          scheduleCheck();
        }, NATIVE_COMPOSER_SETTLE_MS + 50);

        log("native composer busy from", source);
      }

      function eventLooksComposerRelated(event) {
        const target = event.target;
        const targetElement = target instanceof Element ? target : null;
        const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
        if (targetElement?.closest('.bcg-edit-enhanced, [data-testid*="edit" i]') || activeElement?.closest('.bcg-edit-enhanced, [data-testid*="edit" i]')) return false;

        // Clipboard/drop events can be retargeted oddly. If the active element is
        // the prompt, assume the event belongs to the composer.
        const active = document.activeElement;
        if (active?.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], textarea, [contenteditable="true"]')) {
          return true;
        }

        if (!(target instanceof Element)) return false;

        if (target.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], textarea, [contenteditable="true"]')) {
          return true;
        }

        const root = getComposerRoot();
        return Boolean(root && root.contains(target));
      }

      function textOf(el) {
        return [
          el?.getAttribute?.("aria-label"),
          el?.getAttribute?.("title"),
          el?.getAttribute?.("data-testid"),
          el?.id,
          el?.name,
          el?.type,
          el?.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      }

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;

        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function qsa(selector, root = document) {
        try {
          return Array.from(root.querySelectorAll(selector));
        } catch {
          return [];
        }
      }

      function getPromptInputs() {
        const inputs = qsa(
          [
            "#prompt-textarea",
            '[data-testid="prompt-textarea"]',
            "textarea",
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]',
          ].join(","),
        ).filter((element) => isVisible(element) && !element.closest('.bcg-edit-enhanced, [data-testid*="edit" i]'));
        const primary = inputs.filter((element) => element.matches?.(
          '#prompt-textarea, [data-testid="prompt-textarea"]',
        ));
        return primary.length ? primary : inputs;
      }

      function getPromptInput() {
        const inputs = getPromptInputs();

        const active = document.activeElement;
        const focused = inputs.find((el) => el === active || el.contains(active));
        if (focused) return focused;

        return inputs.at(-1) || null;
      }

      let cachedQueueComposerSurface = null;
      let cachedSendButton = null;

      function getQueueComposerSurface() {
        const input = getPromptInput();

        // ChatGPT can leave an old composer connected while mounting a replacement.
        // Only keep the cache when it still owns the currently visible prompt input.
        if (cachedQueueComposerSurface?.isConnected && input && cachedQueueComposerSurface.contains(input)) {
          return cachedQueueComposerSurface;
        }

        cachedQueueComposerSurface =
          input?.closest("form") ||
          input?.closest('[data-testid="composer-root"]') ||
          document.querySelector('[data-testid="composer-root"]') ||
          null;
        cachedSendButton = null;
        return cachedQueueComposerSurface;
      }

      function getComposerRoot() {
        return getQueueComposerSurface();
      }

      function elementFromNode(node) {
        return node instanceof Element ? node : node?.parentElement || null;
      }

      function elementIsWithinQueueComposer(node, surface = getQueueComposerSurface()) {
        const element = elementFromNode(node);
        return Boolean(element && surface && (element === surface || surface.contains(element)));
      }

      function elementContainsQueueComposer(node, surface = getQueueComposerSurface()) {
        const element = elementFromNode(node);
        if (!element) return false;
        if (surface && (element === surface || element.contains(surface))) return true;
        const selector = '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-root"], [data-testid*="send" i]';
        return Boolean(element.matches?.(selector) || element.querySelector?.(selector));
      }

      function mutationsTouchQueueComposer(records) {
        const surface = getQueueComposerSurface();
        for (const record of records || []) {
          if (elementIsWithinQueueComposer(record.target, surface)) return true;
          if (record.type !== "childList") continue;
          for (const node of record.addedNodes || []) {
            if (elementContainsQueueComposer(node, surface)) return true;
          }
        }
        return false;
      }

      function hasComposerText() {
        const inputs = getPromptInputs();

        return inputs.some((input) => {
          let value = "";

          if ("value" in input) {
            value = input.value || "";
          } else {
            value = input.textContent || "";
          }

          value = value
            .replace(/\u200b/g, "")
            .replace(/\s+/g, " ")
            .trim();

          return value.length > 0;
        });
      }

      function hasVisibleAttachmentPreview() {
        const root = getComposerRoot();

        const likelyAttachmentSelectors = [
          '[data-testid="file-preview"]',
          '[data-testid*="file-preview" i]',
          '[data-testid*="attachment-preview" i]',
          '[data-testid*="composer-attachment" i]',
          '[data-testid*="uploaded-file" i]',
          '[data-testid*="file" i]',
          '[data-testid*="attachment" i]',
          '[aria-label*="Remove file" i]',
          '[aria-label*="Remove attachment" i]',
          'button[aria-label^="Remove " i]',
        ];

        if (likelyAttachmentSelectors.some((sel) => qsa(sel, root).some(isVisible))) {
          return true;
        }

        // Do not scan root.innerText. During a long paste, ChatGPT may temporarily
        // stage a huge text blob before converting it to a .txt attachment; reading
        // all composer/page text repeatedly can interfere with that native flow.
        const attachmentishNodes = qsa(
          [
            '[data-testid*="file" i]',
            '[data-testid*="attachment" i]',
            '[aria-label*="file" i]',
            '[aria-label*="attachment" i]',
          ].join(","),
          root,
        ).filter(isVisible);

        const attachmentText = attachmentishNodes.map((el) => el.innerText || el.textContent || "").join("\n");

        return /\.(log|txt|json|xml|csv|tsv|md|zip|7z|rar|pdf|docx?|xlsx?|png|jpe?g|webp)\b/i.test(attachmentText);
      }

      function hasSomethingToSend() {
        return hasComposerText() || hasVisibleAttachmentPreview();
      }

      function probablyHasSomethingToSend() {
        if (hasNativePayloadIntent()) return true;
        if (hasActiveNativeUpload()) return true;

        // A visible preview is durable evidence of an attachment even while the
        // editor is in its generic post-paste settling window.
        if (isNativeComposerBusy()) return hasVisibleAttachmentPreview();

        return hasSomethingToSend();
      }

      function scoreSendButton(button, root) {
        if (!button || !(button instanceof HTMLButtonElement) || belongsToEditSubmit(button)) return -9999;
        if (button.dataset?.cgptProbe === "true" || button.dataset?.cgptQueueProxy === "true") return -9999;
        if (!isVisible(button)) return -9999;

        const bits = textOf(button);

        if (/\b(stop|cancel|interrupt|voice|dictat|microphone|attach|upload|tools|search|reason|add|plus|more)\b/i.test(bits)) {
          return -9999;
        }

        // Current ChatGPT has other composer buttons that may be type=submit (notably
        // the left-side + menu). Never treat a generic submit control as Send. The
        // candidate must carry an explicit send/submit identity in its own metadata.
        const hasSendIdentity = Boolean(
          /\bsend\b/i.test(bits) ||
          /\bsubmit\b/i.test(bits) ||
          button.matches?.('[data-testid*="send" i], [data-testid*="submit" i]')
        );
        if (!hasSendIdentity) return -9999;

        let score = 0;

        if (/\bsend\b/i.test(bits)) score += 100;
        if (/\bsubmit\b/i.test(bits)) score += 60;
        if (button.matches?.('[data-testid*="send" i]')) score += 100;
        if (button.matches?.('[data-testid*="submit" i]')) score += 80;
        if (button.type === "submit") score += 25;

        if (root?.contains(button)) score += 30;
        if (button.closest("form")) score += 10;

        return score;
      }

      function findSendButton() {
        const root = getComposerRoot();
        if (!root) {
          cachedSendButton = null;
          return null;
        }

        if (
          cachedSendButton?.isConnected &&
          root.contains(cachedSendButton) &&
          scoreSendButton(cachedSendButton, root) > 0
        ) {
          return cachedSendButton;
        }

        const preferredSelector = [
          'button[data-testid*="send" i]',
          'button[aria-label*="send" i]',
          'button[title*="send" i]',
          'button[data-testid*="submit" i]',
          'button[aria-label*="submit" i]',
          'button[title*="submit" i]',
        ].join(",");
        let candidates = qsa(preferredSelector, root);
        if (!candidates.length) candidates = qsa("button", root);

        cachedSendButton = (
          candidates
            .map((button) => ({ button, score: scoreSendButton(button, root) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.button || null
        );
        return cachedSendButton;
      }

      function isDisabled(button) {
        if (!button) return true;

        return (
          button.disabled ||
          button.getAttribute("aria-disabled") === "true" ||
          button.hasAttribute("disabled") ||
          button.dataset.disabled === "true"
        );
      }

      function canSendNow() {
        const button = findSendButton();
        return Boolean(button && !isDisabled(button));
      }

      function pointInside(el, event) {
        if (!el) return false;

        const r = el.getBoundingClientRect();

        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      }


      function rememberInlineStyle(button, property) {
        return {
          value: button.style.getPropertyValue(property),
          priority: button.style.getPropertyPriority(property),
        };
      }

      function restoreInlineStyle(button, property, saved) {
        if (!button || !saved) return;
        if (saved.value) button.style.setProperty(property, saved.value, saved.priority || "");
        else button.style.removeProperty(property);
      }

      const SEND_VISUAL_STYLE_PROPERTIES = [
        "position",
        "opacity",
        "filter",
        "pointer-events",
        "cursor",
        "background-color",
        "color",
        "border-color",
        "box-shadow",
      ];

      function clearSendProxy() {
        if (sendProxyButton?.isConnected) sendProxyButton.remove();

        const native = sendProxyNativeButton;
        const saved = native ? sendProxyNativeStyle.get(native) : null;
        if (native && saved) {
          for (const property of SEND_VISUAL_STYLE_PROPERTIES) {
            restoreInlineStyle(native, property, saved[property]);
          }
          sendProxyNativeStyle.delete(native);
        }

        sendProxyButton = null;
        sendProxyNativeButton = null;
      }

      function ensureSendProxy(button, mode) {
        if (!button?.isConnected || !button.parentElement) {
          clearSendProxy();
          return null;
        }

        if (sendProxyNativeButton && sendProxyNativeButton !== button) clearSendProxy();

        if (!sendProxyButton?.isConnected) {
          const proxy = button.cloneNode(true);
          proxy.dataset.cgptQueueProxy = "true";
          proxy.removeAttribute("id");
          proxy.removeAttribute("data-testid");
          proxy.removeAttribute("name");
          proxy.removeAttribute("disabled");
          proxy.removeAttribute("aria-disabled");
          proxy.removeAttribute("data-disabled");
          proxy.disabled = false;
          proxy.type = "button";
          proxy.tabIndex = 0;
          proxy.classList.remove("cgpt-queued-send-visual", "cgpt-queued-send-ready", "cgpt-queued-send-queued");
          proxy.style.removeProperty("position");
          proxy.style.removeProperty("opacity");
          proxy.style.setProperty("pointer-events", "auto", "important");
          proxy.style.setProperty("cursor", "pointer", "important");

          proxy.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            globalThis.BetterChatGPT?.recordTrace?.("queue-proxy-clicked", {
              nativeUploadCount: activeNativeUploadCount(),
              nativePayloadIntent: hasNativePayloadIntent(),
              preview: hasVisibleAttachmentPreview(),
            });
            log("Send proxy clicked");
            queueSend("Send proxy");
            scheduleCheck();
          });

          button.parentElement.insertBefore(proxy, button);
          sendProxyButton = proxy;
          sendProxyNativeButton = button;
          sendProxyNativeStyle.set(
            button,
            Object.fromEntries(SEND_VISUAL_STYLE_PROPERTIES.map((property) => [property, rememberInlineStyle(button, property)])),
          );

          // Keep ChatGPT's real button connected for React refs/state, but remove it
          // from hit testing and from the layout slot occupied by the enabled proxy.
          button.style.setProperty("position", "absolute", "important");
          button.style.setProperty("opacity", "0", "important");
          button.style.setProperty("pointer-events", "none", "important");
          button.style.setProperty("cursor", "default", "important");

          globalThis.BetterChatGPT?.recordTrace?.("queue-proxy-mounted", {
            nativeUploadCount: activeNativeUploadCount(),
            nativeDisabled: isDisabled(button),
          });
          log("Send proxy mounted");
        }

        sendProxyButton.dataset.mode = mode;
        sendProxyButton.title = mode === "queued" ? "Send is queued" : "Queue send until ChatGPT is ready";
        sendProxyButton.setAttribute("aria-label", mode === "queued" ? "Send queued" : "Queue send until ChatGPT is ready");

        if (mode === "queued") {
          sendProxyButton.style.setProperty("background-color", "#7a7a7a", "important");
          sendProxyButton.style.setProperty("border-color", "#7a7a7a", "important");
          sendProxyButton.style.setProperty("color", "white", "important");
          sendProxyButton.style.setProperty("box-shadow", "none", "important");
        } else {
          for (const property of ["background-color", "border-color", "color", "box-shadow"]) {
            sendProxyButton.style.removeProperty(property);
          }
        }

        return sendProxyButton;
      }

      function installVisualOverrideStyle() {
        if (document.getElementById("cgpt-queued-send-visual-style")) return;

        const style = document.createElement("style");
        style.id = "cgpt-queued-send-visual-style";

        style.textContent = `
          button.cgpt-queued-send-visual,
          button.cgpt-queued-send-visual[disabled],
          button.cgpt-queued-send-visual[aria-disabled="true"] {
            opacity: 1 !important;
            filter: none !important;
            cursor: default !important;
            pointer-events: none !important;
          }

          button.cgpt-queued-send-visual *,
          button.cgpt-queued-send-visual[disabled] *,
          button.cgpt-queued-send-visual[aria-disabled="true"] * {
            opacity: 1 !important;
            filter: none !important;
          }


          button.cgpt-queued-send-queued,
          button.cgpt-queued-send-queued[disabled],
          button.cgpt-queued-send-queued[aria-disabled="true"] {
            background-color: #7a7a7a !important;
            border-color: #7a7a7a !important;
            color: white !important;
            box-shadow: none !important;
          }
        `;

        document.documentElement.appendChild(style);
      }

      function clearVisualOverride(button) {
        if (!button) return;

        const restoredFromProxy = sendProxyNativeButton === button;
        if (restoredFromProxy) clearSendProxy();

        button.classList.remove("cgpt-queued-send-visual", "cgpt-queued-send-ready", "cgpt-queued-send-queued");

        if (!restoredFromProxy) {
          for (const property of SEND_VISUAL_STYLE_PROPERTIES) button.style.removeProperty(property);
        }

        if (visuallyOverriddenButton === button) {
          visuallyOverriddenButton = null;
        }
      }

      function applyVisualOverride(button, mode) {
        if (!button) return;

        if (visuallyOverriddenButton && visuallyOverriddenButton !== button) {
          clearVisualOverride(visuallyOverriddenButton);
        }

        visuallyOverriddenButton = button;
        button.classList.add("cgpt-queued-send-visual");
        button.classList.toggle("cgpt-queued-send-ready", mode === "ready");
        button.classList.toggle("cgpt-queued-send-queued", mode === "queued");

        ensureSendProxy(button, mode);
        button.style.setProperty("position", "absolute", "important");
        button.style.setProperty("opacity", "0", "important");
        button.style.setProperty("filter", "none", "important");
        button.style.setProperty("cursor", "default", "important");
        button.style.setProperty("pointer-events", "none", "important");
      }

      function updateVisualSendButton() {
        if (!queueFeatureEnabled() || !keepSendButtonVisuallyEnabled()) {
          if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
          return;
        }

        installVisualOverrideStyle();

        const sendButton = findSendButton();

        if (!sendButton) {
          if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
          return;
        }

        const disabled = isDisabled(sendButton);

        if (!disabled) {
          if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
          return;
        }

        if (queued) {
          applyVisualOverride(sendButton, "queued");
          return;
        }

        if (isNativeComposerBusy()) {
          if (hasNativePayloadHint() || hasActiveNativeUpload() || hasVisibleAttachmentPreview()) {
            applyVisualOverride(sendButton, "ready");
          } else if (visuallyOverriddenButton) {
            clearVisualOverride(visuallyOverriddenButton);
          }
          return;
        }

        if (hasSomethingToSend() || hasNativePayloadHint() || hasActiveNativeUpload()) {
          applyVisualOverride(sendButton, "ready");
          return;
        }

        if (visuallyOverriddenButton) {
          clearVisualOverride(visuallyOverriddenButton);
        }
      }

      function scheduleCheck() {
        if (
          !queued && isNativeComposerBusy() && !hasNativePayloadHint() &&
          !hasActiveNativeUpload() && !hasVisibleAttachmentPreview()
        ) {
          return;
        }

        if (rafPending) return;

        rafPending = true;

        requestAnimationFrame(() => {
          rafPending = false;
          checkQueue();
        });
      }

      function showToast(message) {
        let toast = document.getElementById("cgpt-queued-send-toast");

        if (!toast) {
          toast = document.createElement("div");
          toast.id = "cgpt-queued-send-toast";

          Object.assign(toast.style, {
            position: "fixed",
            left: "50%",
            bottom: "24px",
            transform: "translateX(-50%)",
            zIndex: "2147483647",
            padding: "9px 13px",
            borderRadius: "999px",
            background: "rgba(20, 20, 20, 0.92)",
            color: "white",
            font: '13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            boxShadow: "0 6px 24px rgba(0, 0, 0, 0.25)",
            pointerEvents: "none",
          });

          document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.style.opacity = "1";

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toast.style.opacity = "0";
        }, 2200);
      }

      function clearMonitor() {
        if (checkTimer) {
          clearInterval(checkTimer);
          checkTimer = null;
        }

        if (observer) {
          observer.disconnect();
          observer = null;
        }
      }

      function cancelQueue(reason = "Queued send canceled.") {
        if (!queued) return;

        if (queuedSendAttempt?.timer) clearTimeout(queuedSendAttempt.timer);
        queuedSendAttempt = null;
        internalQueuedSendClick = false;
        if (queuedBridgeNonce) {
          try {
            followUpBridge()?.clearSubmit?.(queuedBridgeNonce);
          } catch (error) {
            log("failed to disarm queued follow-up bridge", error);
          }
          queuedBridgeNonce = "";
        }
        // Keep the selected attachment bookkeeping so Esc can be followed by a
        // deliberate re-queue without losing the already-staged follow-up files.
        queued = false;
        queuedAt = 0;
        clearMonitor();

        updateVisualSendButton();
        showToast(reason);

        log("queue canceled");
      }

      function attachmentTransactionActive() {
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

      function clearQueuedSendAttempt() {
        if (queuedSendAttempt?.timer) clearTimeout(queuedSendAttempt.timer);
        queuedSendAttempt = null;
      }

      function finalizeQueuedSend(source) {
        if (!queued) return false;

        clearQueuedSendAttempt();
        queued = false;
        queuedAt = 0;
        clearMonitor();
        clearNativePayloadHint();
        clearQueuedComposerFiles();

        if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);

        showToast("Queued send released.");
        globalThis.BetterChatGPT?.recordTrace?.("queue-send-confirmed", {
          source,
          nativeUploadCount: activeNativeUploadCount(),
        });
        log("send confirmed from", source);
        return true;
      }

      function verifyQueuedSendAttempt(attempt) {
        if (!queued || queuedSendAttempt !== attempt) return;

        const textWasPresent = Boolean(attempt.promptText.trim());
        const textCleared = textWasPresent && !hasComposerText();
        const previewCleared = attempt.hadPreview && !hasVisibleAttachmentPreview();
        const generationStarted = !attempt.wasGenerating && isAssistantGenerating();

        if (textCleared || previewCleared || generationStarted) {
          finalizeQueuedSend("composer state");
          return;
        }

        clearQueuedSendAttempt();
        globalThis.BetterChatGPT?.recordTrace?.("queue-send-noop", {
          nativeUploadCount: activeNativeUploadCount(),
          nativePayloadIntent: hasNativePayloadIntent(),
          preview: hasVisibleAttachmentPreview(),
        });
        log("native Send produced no observable send; keeping queue armed");
        scheduleCheck();
      }

      function sendNow() {
        if (!queued || queuedSendAttempt) return false;
        if (hasActiveNativeUpload() || isNativeComposerBusy()) return false;

        const button = findSendButton();
        if (!button || isDisabled(button)) return false;
        if (!armQueuedFollowUp()) return false;

        const attempt = {
          startedAt: Date.now(),
          promptText: promptText(),
          hadPreview: hasVisibleAttachmentPreview(),
          wasGenerating: isAssistantGenerating(),
          timer: null,
        };
        queuedSendAttempt = attempt;

        globalThis.BetterChatGPT?.recordTrace?.("queue-send-attempt", {
          nativeUploadCount: activeNativeUploadCount(),
          nativePayloadIntent: hasNativePayloadIntent(),
          preview: attempt.hadPreview,
          sendDisabled: isDisabled(button),
        });

        internalQueuedSendClick = true;
        try {
          button.click();
        } finally {
          queueMicrotask(() => {
            internalQueuedSendClick = false;
          });
        }

        attempt.timer = setTimeout(() => verifyQueuedSendAttempt(attempt), 650);
        return true;
      }

      function checkQueue() {
        if (!queueFeatureEnabled()) {
          if (queued) cancelQueue("Queued send canceled because queued sending was disabled.");
          clearQueuedComposerFiles();
          clearNativePayloadHint();
          nativeComposerBusyUntil = 0;
          if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
          return;
        }
        if (
          !queued && isNativeComposerBusy() && !hasNativePayloadHint() &&
          !hasActiveNativeUpload() && !hasVisibleAttachmentPreview()
        ) {
          if (visuallyOverriddenButton) clearVisualOverride(visuallyOverriddenButton);
          return;
        }

        updateVisualSendButton();

        if (!queued) return;

        if (Date.now() - queuedAt > maxQueueMs()) {
          cancelQueue("Queued send expired.");
          return;
        }

        if (!queuedSendAttempt && !attachmentTransactionActive() && canSendNow()) {
          sendNow();
        }
      }

      function startMonitor() {
        clearMonitor();

        checkTimer = setInterval(checkQueue, CHECK_INTERVAL_MS);

        observer = new MutationObserver((records) => {
          if (mutationsTouchQueueComposer(records)) scheduleCheck();
        });

        // document.body may not exist yet because Better ChatGPT runs at document-start.
        observeQueueBodyWhenReady(observer);
      }

      function queueSend(source) {
        if (!queueFeatureEnabled()) return false;
        if (!attachmentTransactionActive()) {
          if (queued) relinquishQueueToNativeSend();
          scheduleCheck();
          return false;
        }
        if (!probablyHasSomethingToSend()) {
          log("not queueing; composer looks empty");
          return false;
        }

        const pointerGesture = /^(pointerdown|mousedown|click|Send proxy)$/.test(String(source || ""));
        if (queued && pointerGesture && Date.now() < lastPointerQueueGestureUntil) {
          // pointerdown -> mousedown -> click is one physical Send gesture. Do not
          // turn the trailing events into duplicate "Send already queued" toasts.
          scheduleCheck();
          return true;
        }

        if (!queued) {
          if (pointerGesture) lastPointerQueueGestureUntil = Date.now() + POINTER_QUEUE_GESTURE_DEDUPE_MS;
          queued = true;
          queuedAt = Date.now();

          startMonitor();
          updateVisualSendButton();

          showToast("Send queued. Waiting for ChatGPT to be ready… Press Esc to cancel.");
          globalThis.BetterChatGPT?.recordTrace?.("queue-armed", {
            source,
            nativeUploadCount: activeNativeUploadCount(),
            nativePayloadIntent: hasNativePayloadIntent(),
          });
          log("queued from", source);
        } else {
          showToast("Send already queued. Press Esc to cancel.");
        }

        scheduleCheck();
        return true;
      }

      function eventIsInComposer(event) {
        const root = getComposerRoot();
        return Boolean(root && root.contains(event.target));
      }

      function filesFromNativeTransfer(event) {
        const transfer = event?.clipboardData || event?.dataTransfer;
        if (!transfer) return [];
        const files = Array.from(transfer.files || []).filter((file) => file instanceof File);
        for (const item of Array.from(transfer.items || [])) {
          if (item?.kind !== "file") continue;
          const file = item.getAsFile?.();
          if (file instanceof File && !files.some((candidate) => fileKey(candidate) === fileKey(file))) files.push(file);
        }
        return files;
      }

      for (const eventName of ["paste", "drop"]) {
        document.addEventListener(
          eventName,
          (event) => {
            if (!queueFeatureEnabled() || !eventIsInComposer(event) || !isAssistantGenerating()) return;
            const files = filesFromNativeTransfer(event);
            if (!files.length) return;
            // Observe only. ChatGPT keeps full ownership of paste/drop and native upload.
            rememberQueuedComposerFiles(files);
            markNativeComposerBusy(`native ${eventName} attachment`, event);
          },
          true,
        );
      }

      window.addEventListener(
        "change",
        (event) => {
          if (!queueFeatureEnabled()) return;
          if (event.target instanceof Element && event.target.closest('.bcg-edit-enhanced, [data-testid*="edit" i]')) return;
          if (!eventIsFileInputWithFiles(event)) return;

          // ChatGPT now supports uploads during generation natively. Observe that
          // native upload only so queued-send can wait for it; never block, replay,
          // inject, or otherwise take ownership of the upload event.
          if (isAssistantGenerating()) rememberQueuedComposerFiles(Array.from(event.target.files || []));
          else clearQueuedComposerFiles();
          markNativeComposerBusy("native file input change", event);
        },
        true,
      );

      document.addEventListener(
        "beforeinput",
        (event) => {
          if (!queueFeatureEnabled()) return;
          const inputType = event.inputType || "";

          if (/insertFromPaste|insertFromDrop|insertReplacementText/i.test(inputType) && eventLooksComposerRelated(event)) {
            markNativeComposerBusy(inputType, event);
          }
        },
        true,
      );

      document.addEventListener(
        "input",
        (event) => {
          if (!queueFeatureEnabled()) return;
          if (eventIsFileInputWithFiles(event)) {
            markNativeComposerBusy("file input", event);
            return;
          }

          if (!eventLooksComposerRelated(event)) return;
          if (isNativeComposerBusy()) return;

          setTimeout(() => {
            if (!hasSomethingToSend()) {
              clearNativePayloadHint();
            }

            scheduleCheck();
          }, 0);
        },
        true,
      );

      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape" && queued) {
            cancelQueue();
            return;
          }

          if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
            return;
          }

          if (!eventIsInComposer(event)) return;

          if (shouldInterceptSendGesture()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            queueSend("Enter");
          }
        },
        true,
      );

      for (const eventName of ["pointerdown", "mousedown", "click"]) {
        document.addEventListener(
          eventName,
          (event) => {
            if (internalQueuedSendClick) return;
            const eventButton = event.target instanceof Element ? event.target.closest('button') : null;
            if (belongsToEditSubmit(eventButton)) return;
            const sendButton = findSendButton();
            if (!sendButton) return;

            const clickedSend =
              event.target === sendButton || sendButton.contains(event.target) || pointInside(sendButton, event);

            if (!clickedSend) return;

            if (shouldInterceptSendGesture()) {
              event.preventDefault();
              event.stopImmediatePropagation();
              queueSend(eventName);
            }
          },
          true,
        );
      }

      installVisualOverrideStyle();

      // Lightweight always-on observer for visual state only.
      // Again: no style/class observation, or we summon the Firefox freezer.
      const passiveObserver = new MutationObserver((records) => {
        if (mutationsTouchQueueComposer(records)) scheduleCheck();
      });

      // Defer observation until ChatGPT has created its body element.
      observeQueueBodyWhenReady(passiveObserver);

      window.addEventListener("bcg:conversation-request-seen", () => {
        if (!queued || !queuedSendAttempt) return;
        if (Date.now() - queuedSendAttempt.startedAt > 2500) return;
        finalizeQueuedSend("conversation request");
      });

      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        if (event.data?.source !== "better-chatgpt-page") return;
        if (event.data?.type !== "bcg:native-upload-count") return;
        const count = Number(event.data.count || 0);
        globalThis.BetterChatGPT?.recordTrace?.("queue-native-upload-count", { count });
        updateNativeUploadState(count);
        scheduleCheck();
      });

      globalThis.BetterChatGPT.queueDiagnostics = () => {
        const send = findSendButton();
        return {
          queued,
          queuedAgeMs: queuedAt ? Math.max(0, Date.now() - queuedAt) : 0,
          nativeUploadCount: activeNativeUploadCount(),
          nativePayloadIntent: hasNativePayloadIntent(),
          nativePayloadVisuallyReady: hasNativePayloadHint(),
          nativeComposerBusyMs: Math.max(0, nativeComposerBusyUntil - Date.now()),
          trackedComposerFiles: queuedComposerFiles.length,
          attachmentPreview: hasVisibleAttachmentPreview(),
          sendFound: Boolean(send),
          sendDisabled: send ? isDisabled(send) : null,
          proxyMounted: Boolean(sendProxyButton?.isConnected),
          proxyMode: sendProxyButton?.dataset?.mode || null,
          sendAttemptPending: Boolean(queuedSendAttempt),
          sendAttemptAgeMs: queuedSendAttempt ? Math.max(0, Date.now() - queuedSendAttempt.startedAt) : 0,
        };
      };

      window.addEventListener("bcg:settings-changed", scheduleCheck);

      setInterval(() => {
        scheduleCheck();
      }, 750);

      scheduleCheck();

      log("loaded");
    })();
  } catch (error) {
    globalThis.BetterChatGPT?.recordError("queued-send", error);
  }
}

/* ===== plain-text-composer ===== */
if (globalThis.BetterChatGPT) {
  try {
    (() => {
      "use strict";

      // Chromium's legacy insertText command can block ProseMirror for many seconds
      // when one synchronous operation contains a sizeable multiline block. Only
      // use it for small rich-text cleanup; native plain-text and bulk paste paths
      // are substantially faster.
      const MAX_SYNC_RICH_PASTE_CHARS = 4000;
      const MAX_SYNC_RICH_PASTE_LINES = 60;

      const COMPOSER_SELECTOR = ["#prompt-textarea", '[data-testid="prompt-textarea"]'].join(",");

      const BLOCK_TAGS = new Set([
        "ADDRESS",
        "ARTICLE",
        "ASIDE",
        "BLOCKQUOTE",
        "DIV",
        "DL",
        "DT",
        "DD",
        "FIELDSET",
        "FIGCAPTION",
        "FIGURE",
        "FOOTER",
        "FORM",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "HEADER",
        "HR",
        "LI",
        "MAIN",
        "NAV",
        "OL",
        "P",
        "PRE",
        "SECTION",
        "TABLE",
        "TBODY",
        "TD",
        "TFOOT",
        "TH",
        "THEAD",
        "TR",
        "UL",
      ]);

      function normalizePlainText(text) {
        return String(text)
          .replace(/\r\n?/g, "\n")
          .replace(/[\u2028\u2029]/g, "\n")
          .replace(/[\u200B\u2060\uFEFF]/g, "")
          .replace(/\u00A0/g, " ");
      }

      function asElement(node) {
        if (node instanceof Element) return node;
        return node?.parentElement || null;
      }

      function getComposerFromNode(node) {
        const element = asElement(node);
        if (!element) return null;

        const direct = element.closest(COMPOSER_SELECTOR);
        if (direct) return direct;

        const active = document.activeElement;
        if (active instanceof Element) {
          return active.closest(COMPOSER_SELECTOR);
        }

        return null;
      }

      function isAssistantGenerating() {
        const selectors = [
          'button[data-testid="stop-button"]',
          'button[aria-label*="stop generating" i]',
          'button[aria-label*="stop response" i]',
          'button[aria-label*="stop streaming" i]',
          'button[title*="stop generating" i]',
          'button[title*="stop response" i]',
        ];

        return selectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((button) => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);

            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          }),
        );
      }

      function transferHasFiles(transfer) {
        if (!transfer) return false;

        try {
          if (transfer.files?.length > 0) return true;

          return Array.from(transfer.items || []).some((item) => item.kind === "file");
        } catch {
          return false;
        }
      }

      function transferHasRichText(transfer) {
        if (!transfer) return false;

        try {
          return Array.from(transfer.types || []).some(
            (type) => String(type).toLowerCase() === "text/html",
          );
        } catch {
          return false;
        }
      }

      function isSmallSynchronousPaste(text) {
        if (text.length > MAX_SYNC_RICH_PASTE_CHARS) return false;

        let lines = 1;
        for (let index = 0; index < text.length; index += 1) {
          const character = text[index];
          if (character === "\r" && text[index + 1] === "\n") index += 1;
          if (character !== "\r" && character !== "\n" && character !== "\u2028" && character !== "\u2029") {
            continue;
          }
          lines += 1;
          if (lines > MAX_SYNC_RICH_PASTE_LINES) return false;
        }

        return true;
      }

      function placeCaretAtEnd(element) {
        const selection = window.getSelection();
        const range = document.createRange();

        range.selectNodeContents(element);
        range.collapse(false);

        selection?.removeAllRanges();
        selection?.addRange(range);
      }

      function dispatchInput(element, text, inputType) {
        try {
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              composed: true,
              inputType,
              data: text,
            }),
          );
        } catch {
          element.dispatchEvent(
            new Event("input", {
              bubbles: true,
              composed: true,
            }),
          );
        }
      }

      function insertPlainText(composer, text) {
        composer.focus({ preventScroll: true });

        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const start = composer.selectionStart ?? composer.value.length;
          const end = composer.selectionEnd ?? start;

          composer.setRangeText(text, start, end, "end");
          dispatchInput(composer, text, "insertFromPaste");
          return true;
        }

        if (!composer.isContentEditable) return false;

        const selection = window.getSelection();

        if (
          !selection ||
          !selection.rangeCount ||
          !composer.contains(selection.anchorNode) ||
          !composer.contains(selection.focusNode)
        ) {
          placeCaretAtEnd(composer);
        }

        try {
          if (document.execCommand("insertText", false, text)) {
            return true;
          }
        } catch {
          // Fall through to direct range insertion.
        }

        const currentSelection = window.getSelection();
        if (!currentSelection?.rangeCount) return false;

        const range = currentSelection.getRangeAt(0);
        range.deleteContents();

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);

        currentSelection.removeAllRanges();
        currentSelection.addRange(range);

        dispatchInput(composer, text, "insertFromPaste");
        return true;
      }

      function isBlockNode(node) {
        return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName);
      }

      function isPlaceholderOnlyBlock(element) {
        if (!(element instanceof HTMLElement)) return false;

        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = normalizePlainText(child.nodeValue || "");

            if (text.trim().length > 0) return false;
            continue;
          }

          if (child instanceof HTMLBRElement) continue;

          if (child instanceof HTMLElement) {
            if (!isPlaceholderOnlyBlock(child)) return false;
          }
        }

        return true;
      }

      function serializeInline(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return normalizePlainText(node.nodeValue || "");
        }

        if (node instanceof HTMLBRElement) {
          if (node.classList.contains("ProseMirror-trailingBreak")) {
            return "";
          }

          return "\n";
        }

        if (!(node instanceof Element || node instanceof DocumentFragment)) {
          return "";
        }

        if (node instanceof HTMLImageElement) {
          return node.alt || "";
        }

        if (isBlockNode(node)) {
          return serializeBlock(node);
        }

        let output = "";

        for (const child of node.childNodes) {
          output += serializeInline(child);
        }

        return output;
      }

      function serializeMixedChildren(container) {
        const segments = [];
        let inlineBuffer = "";

        const flushInline = () => {
          if (inlineBuffer !== "") {
            segments.push(inlineBuffer);
            inlineBuffer = "";
          }
        };

        for (const child of container.childNodes) {
          if (isBlockNode(child)) {
            flushInline();
            segments.push(serializeBlock(child));
          } else {
            inlineBuffer += serializeInline(child);
          }
        }

        flushInline();
        return segments.join("\n");
      }

      function serializeBlock(element) {
        if (isPlaceholderOnlyBlock(element)) return "";

        return serializeMixedChildren(element);
      }

      function selectionToPlainText(composer) {
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          const start = composer.selectionStart ?? 0;
          const end = composer.selectionEnd ?? start;

          if (start === end) return null;
          return normalizePlainText(composer.value.slice(start, end));
        }

        const selection = window.getSelection();

        if (
          !selection ||
          selection.isCollapsed ||
          !selection.rangeCount ||
          !composer.contains(selection.anchorNode) ||
          !composer.contains(selection.focusNode)
        ) {
          return null;
        }

        const fragment = selection.getRangeAt(0).cloneContents();
        return normalizePlainText(serializeMixedChildren(fragment));
      }

      window.addEventListener(
        "paste",
        (event) => {
          if (!globalThis.BetterChatGPT?.isFeatureEnabled?.("composer.enabled")) return;
          const composer = getComposerFromNode(event.target);
          if (!composer) return;

          // ChatGPT owns live follow-up paste/upload handling while generation is active.
          if (isAssistantGenerating()) return;

          const transfer = event.clipboardData;
          if (!transfer || transferHasFiles(transfer)) return;

          const text = transfer.getData("text/plain");
          if (!text) return;
          if (!transferHasRichText(transfer) || !isSmallSynchronousPaste(text)) return;

          event.preventDefault();
          event.stopImmediatePropagation();

          insertPlainText(composer, normalizePlainText(text));
        },
        true,
      );

      window.addEventListener(
        "copy",
        (event) => {
          if (!globalThis.BetterChatGPT?.isFeatureEnabled?.("composer.enabled")) return;
          const selection = window.getSelection();
          const composer = getComposerFromNode(selection?.anchorNode) || getComposerFromNode(event.target);

          if (!composer || !event.clipboardData) return;

          const text = selectionToPlainText(composer);
          if (text === null) return;

          event.preventDefault();
          event.stopImmediatePropagation();

          event.clipboardData.setData("text/plain", text);
        },
        true,
      );
    })();
  } catch (error) {
    globalThis.BetterChatGPT?.recordError("plain-text-composer", error);
  }
}

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG) return;

  const editAttachmentsEnabled = () => Boolean(BCG.isFeatureEnabled("editAttachments.enabled"));

  const SESSION_CLASS = "bcg-edit-attachment-session";
  const TOOLBAR_CLASS = "bcg-edit-attachment-toolbar";
  const TRAY_CLASS = "bcg-edit-attachment-tray";
  const OWN_INPUT_CLASS = "bcg-edit-own-file-input";
  const BRIDGE_UNAVAILABLE_ERROR = "The native edited-message attachment bridge is unavailable in this browser.";
  const sessions = new Map();
  let scanQueued = false;
  let sequence = 0;
  let activeMentionProxy = null;

  const EDITOR_SELECTOR = [
    'textarea[aria-label*="edit" i]',
    '[contenteditable="true"][aria-label*="edit" i]',
    '[data-testid*="edit" i] textarea',
    '[data-testid*="edit" i] [contenteditable="true"]',
  ].join(",");

  const MAIN_PROMPT_SELECTOR = '#prompt-textarea, [data-testid="prompt-textarea"]';
  const INLINE_PILL_SELECTOR = '[data-inline-selection-pill][data-id]';
  const MENTION_MENU_SELECTOR = '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]';

  const STOP_SELECTOR = [
    'button[data-testid="stop-button"]',
    'button[data-testid="composer-stop-button"]',
    'button[aria-label*="stop generating" i]',
    'button[title*="stop generating" i]',
  ].join(",");

  const SUBMIT_CONTROL_SELECTOR = 'button, [role="button"]';

  function submitControlText(element) {
    if (!(element instanceof Element)) return "";
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid"),
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSubmitControl(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!element.matches(SUBMIT_CONTROL_SELECTOR)) return false;
    const text = submitControlText(element);
    if (/\bcancel\b/i.test(text)) return false;
    if (element instanceof HTMLButtonElement && element.type === "submit") return true;
    return /(?:^|\b)(?:send|save|submit|update)(?:\b|$)/i.test(text);
  }

  function closestSubmitControl(target) {
    const candidate = target instanceof Element ? target.closest(SUBMIT_CONTROL_SELECTOR) : null;
    return isSubmitControl(candidate) ? candidate : null;
  }

  function log(...args) {
    if (BCG.settings.advanced.debug) console.debug("[Better ChatGPT:edit attachments]", ...args);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findEditor(root) {
    if (!(root instanceof Element)) return null;
    return root.matches(EDITOR_SELECTOR) ? root : root.querySelector(EDITOR_SELECTOR);
  }

  function findEditRoot(editor) {
    if (!(editor instanceof Element)) return null;
    const candidates = [];
    let current = editor.closest("form") || editor.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      candidates.push(current);
      if (current.matches('[data-testid*="edit" i], form')) break;
    }

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const buttons = Array.from(candidate.querySelectorAll("button"));
      const hasCancel = buttons.some((button) => /cancel/i.test(button.textContent || button.getAttribute("aria-label") || ""));
      const hasSubmit = buttons.some((button) =>
        /send|save|submit/i.test(
          button.textContent || button.getAttribute("aria-label") || button.getAttribute("data-testid") || "",
        ),
      );
      const insideUserTurn = Boolean(candidate.closest('[data-message-author-role="user"], [data-turn="user"]'));
      const explicitlyEdit = /edit/i.test(candidate.getAttribute("data-testid") || editor.getAttribute("aria-label") || "");
      if ((hasCancel && hasSubmit) || (insideUserTurn && (hasSubmit || explicitlyEdit))) return candidate;
    }
    return null;
  }

  function collectEditRoots() {
    const roots = new Set();
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const root = findEditRoot(editor);
      if (root) roots.add(root);
    }
    return roots;
  }

  function extractFiles(transfer) {
    if (!transfer) return [];
    const candidates = [];
    try {
      candidates.push(...Array.from(transfer.files || []));
    } catch {
      // Continue with items.
    }
    try {
      for (const item of Array.from(transfer.items || [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile?.();
        if (file) candidates.push(file);
      }
    } catch {
      // Some browsers expose only FileList.
    }
    const seen = new Set();
    return candidates.filter((file) => {
      if (!(file instanceof File)) return false;
      const key = `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }


  let activeDragSession = null;

  function transferLooksLikeFiles(transfer) {
    if (!transfer) return false;
    try {
      if (Array.from(transfer.files || []).length > 0) return true;
      if (Array.from(transfer.items || []).some((item) => item.kind === "file")) return true;
      return Array.from(transfer.types || []).some((type) => String(type).toLowerCase() === "files");
    } catch {
      return false;
    }
  }

  function sessionForDragEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (sessions.has(node)) return sessions.get(node);
      if (!(node instanceof Element)) continue;
      const root = node.closest(".bcg-edit-enhanced");
      if (root && sessions.has(root)) return sessions.get(root);
    }

    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest(".bcg-edit-enhanced");
    return root ? sessions.get(root) || null : null;
  }

  function clearEditDragState(session = activeDragSession) {
    if (session?.root instanceof HTMLElement) delete session.root.dataset.bcgEditDragActive;
    if (!session || session === activeDragSession) activeDragSession = null;
  }

  function markEditDragState(session) {
    if (activeDragSession && activeDragSession !== session) clearEditDragState(activeDragSession);
    activeDragSession = session;
    session.root.dataset.bcgEditDragActive = "1";
  }

  function installEditDragCapture() {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };

    for (const type of ["dragenter", "dragover"]) {
      window.addEventListener(
        type,
        (event) => {
          if (!BCG.settings.editAttachments.dragDrop || !transferLooksLikeFiles(event.dataTransfer)) return;
          const session = sessionForDragEvent(event);
          if (!session) return;

          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            event.dataTransfer.dropEffect = "copy";
          } catch {
            // Some browser drag payloads expose a read-only DataTransfer.
          }
          markEditDragState(session);
        },
        options,
      );
    }

    window.addEventListener(
      "drop",
      (event) => {
        if (!BCG.settings.editAttachments.dragDrop || !transferLooksLikeFiles(event.dataTransfer)) return;
        const session = sessionForDragEvent(event);
        if (!session) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        clearEditDragState(session);
        const files = extractFiles(event.dataTransfer);
        if (files.length) addFiles(session, files, "drop");
      },
      options,
    );

    window.addEventListener(
      "dragleave",
      (event) => {
        const session = sessionForDragEvent(event) || activeDragSession;
        if (!session) return;
        const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (related && session.root.contains(related)) return;
        clearEditDragState(session);
      },
      options,
    );

    window.addEventListener("dragend", () => clearEditDragState(), options);
    window.addEventListener("blur", () => clearEditDragState(), options);
    return controller;
  }

  function nativeInputsFor(session) {
    return Array.from(session.root.querySelectorAll('input[type="file"]')).filter(
      (input) => input instanceof HTMLInputElement && !input.classList.contains(OWN_INPUT_CLASS),
    );
  }

  function nativeInputFor(session) {
    const inputs = nativeInputsFor(session);
    return inputs.length === 1 ? inputs[0] : null;
  }

  function createTransfer(files) {
    if (typeof DataTransfer !== "function") return null;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    return transfer;
  }

  function entryName(entry) {
    return String(entry?.file?.name || entry?.attachment?.name || "attachment");
  }

  function entrySize(entry) {
    return Number(entry?.file?.size ?? entry?.attachment?.size ?? 0) || 0;
  }

  function filesSignature(files) {
    return files.map((entry) => `${entry.id}:${entry.status}:${entryName(entry)}:${entrySize(entry)}`).join("|");
  }

  function setStatus(entry, status, error = "") {
    entry.status = status;
    entry.error = error;
  }

  function addMentionAttachment(session, attachment) {
    if (!attachment?.id) return false;
    if (session.files.some((entry) => entry.attachment?.id === attachment.id)) return true;
    if (session.files.length >= BCG.settings.editAttachments.maxFiles) {
      BCG.notify(`Edit attachment limit reached (${BCG.settings.editAttachments.maxFiles}).`);
      return false;
    }
    session.files.push({
      id: ++sequence,
      file: null,
      source: "mention",
      status: "staged",
      error: "",
      objectUrl: "",
      attachment: { ...attachment, __bcgMentionReference: true },
    });
    render(session);
    return true;
  }

  function addFiles(session, files, source) {
    const config = BCG.settings.editAttachments;
    const accepted = [];
    const existingKeys = new Set(
      session.files
        .map(({ file }) => file instanceof File ? `${file.name}\u0000${file.size}\u0000${file.lastModified}` : "")
        .filter(Boolean),
    );

    for (const file of files) {
      if (session.files.length + accepted.length >= config.maxFiles) {
        BCG.notify(`Edit attachment limit reached (${config.maxFiles}).`);
        break;
      }
      if (file.size > config.maxFileSizeMb * 1024 * 1024) {
        BCG.notify(`${file.name} is larger than the configured edit attachment limit.`);
        continue;
      }
      const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      accepted.push({
        id: ++sequence,
        file,
        source,
        status: "pending",
        error: "",
        objectUrl: "",
        attachment: null,
      });
    }

    if (!accepted.length) return false;
    session.files.push(...accepted);
    render(session);
    flush(session);
    return true;
  }

  function dispatchNativeInput(input) {
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function restoreInputFiles(input, files) {
    const transfer = createTransfer(files);
    if (!transfer) return false;
    try {
      input.files = transfer.files;
      dispatchNativeInput(input);
      return true;
    } catch {
      return false;
    }
  }

  function attachmentPreviewNodes(session) {
    const selector = [
      '[data-testid*="attachment" i]',
      '[data-testid*="upload" i]',
      '[class*="attachment" i]',
      '[class*="file-preview" i]',
      '[aria-label*="attachment" i]',
      'img[src^="blob:"]',
    ].join(",");
    return Array.from(session.root.querySelectorAll(selector)).filter(
      (node) => !node.closest(`.${SESSION_CLASS}`) && !node.matches('input[type="file"]'),
    );
  }

  function previewCount(session) {
    return attachmentPreviewNodes(session).length;
  }

  function previewContainsFile(session, file) {
    const name = file.name.toLowerCase();
    return attachmentPreviewNodes(session).some((node) => {
      const haystack = [
        node.textContent,
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.getAttribute?.("data-testid"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return name && haystack.includes(name);
    });
  }

  function inputContainsFile(input, file) {
    return Array.from(input.files || []).some(
      (candidate) =>
        candidate.name === file.name &&
        candidate.size === file.size &&
        candidate.lastModified === file.lastModified,
    );
  }

  function finishUploadVerification(session, input, previous, pending, previewBefore, attempt = 0) {
    const delays = [60, 180, 420, 850];
    if (!session.root.isConnected) return;
    const ownedInput = nativeInputFor(session);
    if (ownedInput !== input) {
      session.uploading = false;
      restoreInputFiles(input, previous);
      pending.forEach((entry) => setStatus(entry, "failed", "The edit uploader changed during upload."));
      render(session);
      return;
    }

    const acceptedByInput = pending.every((entry) => inputContainsFile(input, entry.file));
    const acceptedByName = pending.every((entry) => previewContainsFile(session, entry.file));
    const acceptedByCount = previewCount(session) - previewBefore >= pending.length;
    if (acceptedByInput || acceptedByName || acceptedByCount) {
      session.uploading = false;
      pending.forEach((entry) => setStatus(entry, "uploaded"));
      render(session);
      return;
    }

    if (attempt < delays.length) {
      window.setTimeout(
        () => finishUploadVerification(session, input, previous, pending, previewBefore, attempt + 1),
        delays[attempt],
      );
      return;
    }

    session.uploading = false;
    restoreInputFiles(input, previous);
    pending.forEach((entry) => setStatus(entry, "failed", "ChatGPT rejected the edit attachment."));
    render(session);
  }


  async function uploadPendingViaBridge(session, pending) {
    const bridge = BCG.editAttachmentBridge;
    if (!bridge?.isReady?.()) return false;

    session.uploading = true;
    pending.forEach((entry) => setStatus(entry, "uploading"));
    render(session);

    for (const entry of pending) {
      if (!session.root.isConnected) break;
      try {
        entry.attachment = await bridge.uploadFile(entry.file);
        setStatus(entry, "staged");
      } catch (error) {
        setStatus(entry, "failed", error?.message || "ChatGPT rejected the edit attachment upload.");
        BCG.recordError("edit-upload-bridge", error);
      }
      render(session);
    }

    session.uploading = false;
    render(session);
    return true;
  }

  function flush(session) {
    if (!session.root.isConnected || session.uploading) return;
    const pending = session.files.filter((entry) => entry.status === "pending" || entry.status === "retry");
    if (!pending.length) return;

    const input = nativeInputFor(session);
    if (!input) {
      const count = nativeInputsFor(session).length;
      if (count === 0 && BCG.editAttachmentBridge?.isReady?.()) {
        void uploadPendingViaBridge(session, pending);
        return;
      }
      pending.forEach((entry) =>
        setStatus(
          entry,
          "blocked",
          count > 1
            ? "Multiple edit uploaders were detected; refusing to guess."
            : BRIDGE_UNAVAILABLE_ERROR,
        ),
      );
      render(session);
      return;
    }

    const previous = Array.from(input.files || []);
    const combined = [...previous, ...pending.map((entry) => entry.file)];
    const transfer = createTransfer(combined);
    if (!transfer) {
      pending.forEach((entry) => setStatus(entry, "blocked", "This browser cannot create a safe FileList."));
      render(session);
      return;
    }

    session.uploading = true;
    pending.forEach((entry) => setStatus(entry, "uploading"));
    render(session);

    try {
      const previewBefore = previewCount(session);
      input.files = transfer.files;
      dispatchNativeInput(input);
      finishUploadVerification(session, input, previous, pending, previewBefore);
    } catch (error) {
      session.uploading = false;
      restoreInputFiles(input, previous);
      pending.forEach((entry) => setStatus(entry, "failed", error.message || "Upload failed."));
      BCG.recordError("edit-upload", error);
      render(session);
    }
  }

  function rebuildNativeFiles(session) {
    const input = nativeInputFor(session);
    if (!input || !(input.files?.length > 0)) return;
    const uploaded = session.files.filter((entry) => entry.status === "uploaded").map((entry) => entry.file);
    restoreInputFiles(input, uploaded);
  }

  function removeNativePreview(session, entry) {
    const name = entry.file.name.toLowerCase();
    const preview = attachmentPreviewNodes(session).find((node) =>
      String(node.textContent || node.getAttribute?.("aria-label") || "").toLowerCase().includes(name),
    );
    const removeButton = preview?.querySelector?.(
      'button[aria-label*="remove" i], button[aria-label*="delete" i], button[title*="remove" i], button[title*="delete" i]',
    );
    if (removeButton instanceof HTMLButtonElement) removeButton.click();
  }

  function removeEntry(session, id) {
    const index = session.files.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [entry] = session.files.splice(index, 1);
    if (entry.status === "uploaded") removeNativePreview(session, entry);
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    rebuildNativeFiles(session);
    render(session);
  }

  function retryEntry(session, id) {
    const entry = session.files.find((candidate) => candidate.id === id);
    if (!entry) return;
    setStatus(entry, "retry");
    render(session);
    flush(session);
  }

  function downloadEntry(entry) {
    if (!entry.objectUrl) entry.objectUrl = URL.createObjectURL(entry.file);
    const link = document.createElement("a");
    link.href = entry.objectUrl;
    link.download = entry.file.name || "attachment";
    link.click();
  }

  function findSubmit(session) {
    return Array.from(session.root.querySelectorAll(SUBMIT_CONTROL_SELECTOR)).find(
      (control) => isSubmitControl(control) && isVisible(control),
    ) || null;
  }

  function editorHasText(session) {
    const editor = findEditor(session.root);
    if (!editor) return false;
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return Boolean(editor.value.trim());
    return Boolean(editor.textContent?.trim());
  }

  function hasBlockingFiles(session) {
    return session.files.some((entry) => !["uploaded", "staged"].includes(entry.status));
  }


  function editorText(session) {
    const editor = findEditor(session.root);
    if (!editor) return "";
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return editor.value;
    return editor.textContent || "";
  }

  function bridgedAttachments(session) {
    return session.files
      .filter((entry) => entry.status === "staged" && entry.attachment)
      .map((entry) => entry.attachment);
  }

  function armBridgedSubmit(session) {
    const attachments = bridgedAttachments(session);
    if (!attachments.length) return true;
    if (session.submitNonce) return true;
    const bridge = BCG.editAttachmentBridge;
    if (!bridge?.isReady?.()) return false;
    session.submitNonce = bridge.armSubmit(editorText(session), attachments, (result) => {
      session.submitNonce = "";
      if (result?.ok) return;
      const error = new Error(result?.error || `ChatGPT rejected the edited attachment request (${result?.status || 0}).`);
      BCG.recordError("edit-submit-bridge", error, { status: result?.status || 0 });
      BCG.notify(error.message);
    });
    return Boolean(session.submitNonce);
  }

  function handleSubmitIntent(session, event) {
    if (!editAttachmentsEnabled()) return;
    if (hasBlockingFiles(session)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      BCG.notify("Wait for the edited-message attachments to finish uploading.");
      return;
    }
    if (!armBridgedSubmit(session)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      BCG.notify("Edited attachment bridge is not ready.");
    }
  }

  function externalSubmitSession(submit) {
    if (!isSubmitControl(submit)) return null;
    const submitForm = submit instanceof HTMLButtonElement ? submit.form : null;
    const submitTurn = submit.closest('[data-message-author-role="user"], [data-turn="user"]');
    for (const session of sessions.values()) {
      if (!session.root.isConnected || session.root.contains(submit)) continue;
      const editor = findEditor(session.root) || session.editor;
      if (!(editor instanceof Element)) continue;
      const editorForm = editor.closest("form");
      if (submitForm && editorForm && submitForm === editorForm) return session;
      const editTurn = session.root.closest('[data-message-author-role="user"], [data-turn="user"]');
      if (submitTurn && editTurn && submitTurn === editTurn) return session;
    }
    return null;
  }

  function installExternalSubmitCapture(signal) {
    for (const eventName of ["pointerdown", "click"]) {
      document.addEventListener(
        eventName,
        (event) => {
          const submit = closestSubmitControl(event.target);
          if (!submit) return;
          const session = externalSubmitSession(submit);
          if (!session) return;
          handleSubmitIntent(session, event, eventName, submit);
        },
        { capture: true, signal },
      );
    }
  }

  function render(session) {
    if (!session.root.isConnected) return;
    const signature = `${session.uploading}|${filesSignature(session.files)}`;
    if (signature === session.renderSignature) return;
    session.renderSignature = signature;

    const fragment = document.createDocumentFragment();

    for (const entry of session.files) {
      const row = document.createElement("div");
      row.className = "bcg-edit-file-row";
      row.dataset.status = entry.status;
      const name = document.createElement("span");
      name.className = "bcg-edit-file-name";
      name.textContent = `${entryName(entry)} (${formatBytes(entrySize(entry))})`;
      name.title = entry.error || entryName(entry);
      const status = document.createElement("span");
      status.className = "bcg-edit-file-status";
      status.textContent = statusLabel(entry);
      const actions = document.createElement("span");
      actions.className = "bcg-edit-file-actions";
      if (["failed", "blocked", "waiting"].includes(entry.status)) {
        actions.appendChild(rowButton("Retry", () => retryEntry(session, entry.id)));
        if (entry.file) actions.appendChild(rowButton("Download", () => downloadEntry(entry)));
      }
      actions.appendChild(rowButton("Remove", () => removeEntry(session, entry.id)));
      row.append(name, status, actions);
      fragment.appendChild(row);
    }

    session.tray.replaceChildren(fragment);
    session.tray.hidden = session.files.length === 0;
    document.documentElement.dataset.bcgEditSessions = String(sessions.size);
  }

  function rowButton(text, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", callback);
    return button;
  }

  function statusLabel(entry) {
    return {
      pending: "Pending",
      retry: "Retrying",
      waiting: "Waiting for ChatGPT",
      uploading: "Uploading",
      uploaded: "Attached",
      staged: "Ready for edited message",
      blocked: "Needs native edit uploader",
      failed: "Failed",
    }[entry.status] || entry.status;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function mainPrompt() {
    return Array.from(document.querySelectorAll(MAIN_PROMPT_SELECTOR)).find(
      (candidate) => candidate instanceof HTMLElement && !candidate.closest('.bcg-edit-enhanced, [data-testid*="edit" i]'),
    ) || null;
  }

  function setEditableCaretToEnd(element) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function dispatchEditableInput(element, inputType = "insertText", data = null) {
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }

  function insertPromptTrigger(prompt) {
    prompt.focus({ preventScroll: true });
    setEditableCaretToEnd(prompt);
    let inserted = false;
    try {
      inserted = Boolean(document.execCommand?.("insertText", false, " @"));
    } catch {
      inserted = false;
    }
    if (!inserted) {
      prompt.append(document.createTextNode(" @"));
      dispatchEditableInput(prompt, "insertText", " @");
    }
  }

  function restorePromptHtml(prompt, html) {
    if (!(prompt instanceof HTMLElement) || !prompt.isConnected) return;
    prompt.focus({ preventScroll: true });
    for (let attempt = 0; attempt < 4 && prompt.innerHTML !== html; attempt += 1) {
      try {
        if (!document.execCommand?.("undo")) break;
      } catch {
        break;
      }
    }
    if (prompt.innerHTML === html) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(prompt);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let restored = false;
    try {
      restored = Boolean(document.execCommand?.("insertHTML", false, html));
    } catch {
      restored = false;
    }
    if (!restored || prompt.innerHTML !== html) {
      prompt.innerHTML = html;
      dispatchEditableInput(prompt, "insertReplacementText", null);
    }
  }

  function insertEditText(editor, text, start, end = start) {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editor.setRangeText(text, start, end, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      return;
    }
    editor.focus({ preventScroll: true });
    try {
      document.execCommand?.("insertText", false, text);
    } catch {
      editor.append(document.createTextNode(text));
      dispatchEditableInput(editor, "insertText", text);
    }
  }

  function visibleMentionMenu(initialMenus) {
    return Array.from(document.querySelectorAll(MENTION_MENU_SELECTOR)).find((candidate) => {
      if (!(candidate instanceof HTMLElement) || initialMenus.has(candidate) || !isVisible(candidate)) return false;
      const menu = candidate.matches('[role="listbox"], [role="menu"]')
        ? candidate
        : candidate.querySelector('[role="listbox"], [role="menu"]') || candidate;
      return Boolean(menu.querySelector('[role="option"], button, [data-keyword], [data-value]'));
    }) || null;
  }

  function positionMentionMenu(proxy, menu) {
    const editorRect = proxy.session.editor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(menuRect.width, 260);
    const left = Math.min(Math.max(margin, editorRect.left), Math.max(margin, innerWidth - width - margin));
    const below = editorRect.bottom + margin;
    const top = below + menuRect.height <= innerHeight - margin
      ? below
      : Math.max(margin, editorRect.top - menuRect.height - margin);
    if (proxy.menu !== menu) {
      proxy.menuStyle = menu.getAttribute("style");
      proxy.menuProxyFlag = menu.dataset.bcgEditMentionProxy;
    }
    menu.dataset.bcgEditMentionProxy = "1";
    menu.style.setProperty("position", "fixed", "important");
    menu.style.setProperty("left", `${left}px`, "important");
    menu.style.setProperty("top", `${top}px`, "important");
    menu.style.setProperty("right", "auto", "important");
    menu.style.setProperty("bottom", "auto", "important");
    menu.style.setProperty("inset", "auto", "important");
    menu.style.setProperty("transform", "none", "important");
    menu.style.setProperty("z-index", "2147483646", "important");
    proxy.menu = menu;
  }

  function pillFileId(pill) {
    const raw = String(pill?.getAttribute?.("data-id") || "");
    const match = raw.match(/(?:^|:)((?:file_)[A-Za-z0-9_-]+)$/);
    return match?.[1] || "";
  }

  function finishMentionProxy(proxy, { literal = false } = {}) {
    if (!proxy || proxy.finished) return;
    proxy.finished = true;
    proxy.observer.disconnect();
    window.clearTimeout(proxy.timeout);
    if (proxy.menu) {
      if (proxy.menuStyle === null) proxy.menu.removeAttribute("style");
      else proxy.menu.setAttribute("style", proxy.menuStyle || "");
      if (proxy.menuProxyFlag === undefined) delete proxy.menu.dataset.bcgEditMentionProxy;
      else proxy.menu.dataset.bcgEditMentionProxy = proxy.menuProxyFlag;
    }
    restorePromptHtml(proxy.prompt, proxy.promptHtml);
    proxy.session.editor.focus({ preventScroll: true });
    if (literal) insertEditText(proxy.session.editor, "@", proxy.editStart, proxy.editEnd);
    if (activeMentionProxy === proxy) activeMentionProxy = null;
  }

  async function acceptMentionPill(proxy, pill) {
    if (proxy.accepting || proxy.finished) return;
    proxy.accepting = true;
    const fileId = pillFileId(pill);
    const name = String(pill.getAttribute("data-keyword") || pill.textContent || "attachment").trim();
    if (!fileId || String(pill.getAttribute("data-symbol") || "") !== "documentReference") {
      finishMentionProxy(proxy, { literal: true });
      return;
    }
    const bridge = BCG.editAttachmentBridge;
    const attachment = await bridge?.lookupAttachment?.(fileId, { timeoutMs: 6000 });
    if (!attachment) {
      finishMentionProxy(proxy, { literal: true });
      BCG.notify(`ChatGPT selected ${name}, but its Library metadata was not available.`);
      return;
    }
    addMentionAttachment(proxy.session, attachment);
    finishMentionProxy(proxy);
    insertEditText(proxy.session.editor, `@${attachment.name || name} `, proxy.editStart, proxy.editEnd);
  }

  function openMentionProxy(session, event = null) {
    if (activeMentionProxy || !BCG.editAttachmentBridge?.isReady?.()) return false;
    const prompt = mainPrompt();
    if (!(prompt instanceof HTMLElement)) return false;
    const editor = session.editor;
    const editStart = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.selectionStart ?? editor.value.length
      : 0;
    const editEnd = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.selectionEnd ?? editStart
      : editStart;
    const initialPills = new Set(prompt.querySelectorAll(INLINE_PILL_SELECTOR));
    const initialMenus = new Set(
      Array.from(document.querySelectorAll(MENTION_MENU_SELECTOR)).filter((menu) => isVisible(menu)),
    );
    const proxy = {
      session,
      prompt,
      promptHtml: prompt.innerHTML,
      editStart,
      editEnd,
      initialPills,
      initialMenus,
      menu: null,
      menuStyle: null,
      menuProxyFlag: undefined,
      accepting: false,
      finished: false,
      observer: null,
      timeout: 0,
    };
    proxy.observer = new MutationObserver(() => {
      if (proxy.finished) return;
      const menu = visibleMentionMenu(proxy.initialMenus);
      if (menu && menu !== proxy.menu) positionMentionMenu(proxy, menu);
      const pill = Array.from(prompt.querySelectorAll(INLINE_PILL_SELECTOR)).find(
        (candidate) => !proxy.initialPills.has(candidate),
      );
      if (pill) void acceptMentionPill(proxy, pill);
    });
    proxy.observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
    proxy.timeout = window.setTimeout(() => finishMentionProxy(proxy, { literal: true }), 30000);
    activeMentionProxy = proxy;
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    insertPromptTrigger(prompt);
    return true;
  }

  function attachSession(root) {
    if (!editAttachmentsEnabled() || sessions.has(root) || !(root instanceof HTMLElement)) return;
    const editor = findEditor(root);
    if (!editor) return;

    const controller = new AbortController();
    const toolbar = document.createElement("div");
    toolbar.className = `${SESSION_CLASS} ${TOOLBAR_CLASS}`;
    const attach = document.createElement("button");
    attach.type = "button";
    attach.className = "bcg-edit-attach-button";
    attach.textContent = "Attach files";
    attach.title = "Attach files to this edited message";
    const ownInput = document.createElement("input");
    ownInput.type = "file";
    ownInput.multiple = true;
    ownInput.className = OWN_INPUT_CLASS;
    ownInput.hidden = true;
    toolbar.append(attach, ownInput);

    const tray = document.createElement("div");
    tray.className = `${SESSION_CLASS} ${TRAY_CLASS}`;
    tray.hidden = true;

    const session = {
      root,
      editor,
      controller,
      toolbar,
      tray,
      attach,
      ownInput,
      files: [],
      uploading: false,
      renderSignature: "",
      submitNonce: "",
    };
    sessions.set(root, session);
    root.classList.add("bcg-edit-enhanced");
    editor.insertAdjacentElement("afterend", toolbar);
    toolbar.insertAdjacentElement("afterend", tray);

    attach.addEventListener(
      "click",
      () => {
        if (!BCG.settings.editAttachments.picker) return;
        const nativeAttach = Array.from(root.querySelectorAll("button")).find((button) =>
          /attach|upload|add files?/i.test(
            button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent || "",
          ),
        );
        if (nativeAttach instanceof HTMLButtonElement && nativeAttach !== attach) {
          nativeAttach.click();
          return;
        }
        ownInput.click();
      },
      { signal: controller.signal },
    );

    ownInput.addEventListener(
      "change",
      () => {
        addFiles(session, Array.from(ownInput.files || []), "picker");
        ownInput.value = "";
      },
      { signal: controller.signal },
    );

    root.addEventListener(
      "paste",
      (event) => {
        if (!BCG.settings.editAttachments.paste) return;
        const files = extractFiles(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        addFiles(session, files, "paste");
      },
      { capture: true, signal: controller.signal },
    );

    root.addEventListener(
      "dragover",
      (event) => {
        if (!BCG.settings.editAttachments.dragDrop || !extractFiles(event.dataTransfer).length) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      { capture: true, signal: controller.signal },
    );

    root.addEventListener(
      "drop",
      (event) => {
        if (!BCG.settings.editAttachments.dragDrop) return;
        const files = extractFiles(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        addFiles(session, files, "drop");
      },
      { capture: true, signal: controller.signal },
    );

    root.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "@" && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (openMentionProxy(session, event)) return;
        }
        if (event.key === "Escape" && activeMentionProxy?.session === session) {
          event.preventDefault();
          event.stopImmediatePropagation();
          finishMentionProxy(activeMentionProxy, { literal: true });
          return;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          if (hasBlockingFiles(session)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            BCG.notify("Wait for the edited-message attachments to finish uploading.");
            return;
          }
          if (!armBridgedSubmit(session)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            BCG.notify("Edited attachment bridge is not ready.");
          }
        }
      },
      { capture: true, signal: controller.signal },
    );

    root.addEventListener(
      "submit",
      (event) => {
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        if (!form || !(form === root || form.contains(session.editor))) return;
        handleSubmitIntent(session, event, "submit", event.submitter || null);
      },
      { capture: true, signal: controller.signal },
    );

    for (const eventName of ["pointerdown", "click"]) {
      root.addEventListener(
        eventName,
        (event) => {
          const submit = closestSubmitControl(event.target);
          if (!submit || !session.root.contains(submit)) return;
          handleSubmitIntent(session, event, eventName, submit);
        },
        { capture: true, signal: controller.signal },
      );
    }

    render(session);
    log("attached edit session", root);
  }

  function destroySession(root, session) {
    if (activeMentionProxy?.session === session) finishMentionProxy(activeMentionProxy, { literal: false });
    // ChatGPT removes the edit composer before it dispatches the edited-message
    // conversation request. Keep an armed bridge payload alive across that UI
    // teardown; the request consumes it, or armSubmit's short expiry does.
    if (session.submitNonce) {
      BCG.recordTrace?.("edit-session-closed-submit-pending", { attachmentCount: bridgedAttachments(session).length });
    }
    session.controller.abort();
    for (const entry of session.files) if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    session.toolbar.remove();
    session.tray.remove();
    root.classList.remove("bcg-edit-enhanced");
    sessions.delete(root);
    document.documentElement.dataset.bcgEditSessions = String(sessions.size);
  }

  function scan() {
    scanQueued = false;
    if (!editAttachmentsEnabled()) {
      clearEditDragState();
      for (const [root, session] of Array.from(sessions)) destroySession(root, session);
      return;
    }
    const roots = collectEditRoots();
    roots.forEach(attachSession);
    for (const [root, session] of Array.from(sessions)) {
      if (!root.isConnected || !roots.has(root)) {
        destroySession(root, session);
        continue;
      }
      if (!session.toolbar.isConnected || !session.tray.isConnected) {
        destroySession(root, session);
        attachSession(root);
        continue;
      }
      if (nativeInputFor(session)) {
        session.files.filter((entry) => entry.status === "blocked").forEach((entry) => setStatus(entry, "retry"));
      } else if (BCG.editAttachmentBridge?.isReady?.()) {
        session.files
          .filter((entry) => entry.status === "blocked" && entry.error === BRIDGE_UNAVAILABLE_ERROR)
          .forEach((entry) => setStatus(entry, "retry"));
      }
      flush(session);
    }
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  function injectStyles() {
    const id = "better-chatgpt-edit-attachments-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
.${TOOLBAR_CLASS}{display:flex;align-items:center;gap:8px;margin:8px 0 4px;font:12px system-ui}
.${TOOLBAR_CLASS} button,.${TRAY_CLASS} button{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;background:transparent;color:inherit;padding:5px 8px;cursor:pointer}
.${TRAY_CLASS}{display:grid;gap:5px;margin:4px 0 8px;font:12px system-ui}
.${TRAY_CLASS}[hidden]{display:none}.bcg-edit-file-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:7px 8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:color-mix(in srgb,currentColor 4%,transparent)}
.bcg-edit-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bcg-edit-file-status{font-weight:600}.bcg-edit-file-actions{display:flex;gap:4px}
.bcg-edit-file-row[data-status="failed"],.bcg-edit-file-row[data-status="blocked"]{border-color:#c64040}.bcg-edit-file-row[data-status="uploaded"],.bcg-edit-file-row[data-status="staged"]{border-color:#338a52}
.bcg-edit-enhanced[data-bcg-edit-drag-active="1"]{outline:2px dashed color-mix(in srgb,currentColor 55%,transparent);outline-offset:4px}
@media(max-width:640px){.bcg-edit-file-row{grid-template-columns:1fr}.bcg-edit-file-actions{justify-content:flex-start}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  injectStyles();
  const dragCaptureController = installEditDragCapture();
  installExternalSubmitCapture(dragCaptureController.signal);
  window.addEventListener("bcg:edit-bridge-ready", scheduleScan, { signal: dragCaptureController.signal });
  window.addEventListener("bcg:settings-changed", scheduleScan, { signal: dragCaptureController.signal });
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const monitor = window.setInterval(scheduleScan, 500);
  window.addEventListener("pagehide", () => {
    dragCaptureController.abort();
    clearEditDragState();
    observer.disconnect();
    clearInterval(monitor);
    for (const [root, session] of sessions) destroySession(root, session);
  }, { once: true });

  globalThis.__betterChatGPTEditAttachments = {
    status: () => ({ sessions: sessions.size, files: Array.from(sessions.values()).reduce((n, s) => n + s.files.length, 0) }),
    rescan: scheduleScan,
    destroy: () => {
      dragCaptureController.abort();
      clearEditDragState();
      observer.disconnect();
      clearInterval(monitor);
      for (const [root, session] of sessions) destroySession(root, session);
    },
  };

  BCG.editAttachments = {
    isEditSubmitControl(control) {
      if (!(control instanceof Element)) return false;
      if (control.closest('.bcg-edit-enhanced, [data-testid*="edit" i]')) return true;
      return Boolean(externalSubmitSession(control));
    },
  };

  scheduleScan();
})();

(() => {
  "use strict";

  const BCG = globalThis.BetterChatGPT;
  if (!BCG || globalThis.__bcgPerformanceWatchdog) return;

  const STORAGE_KEY = "better-chatgpt:perf-diagnostics-v1";
  const HEARTBEAT_MS = 1000;
  const SAMPLE_MS = 5000;
  const DOM_SAMPLE_MS = 10000;
  const FLUSH_MS = 10000;
  const STALL_THRESHOLD_MS = 250;
  const MAX_STALLS = 24;
  const MAX_FRAMES = 36;
  const MAX_SAMPLES = 30;
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const startedAt = Date.now();

  let heartbeatTimer = 0;
  let sampleTimer = 0;
  let flushTimer = 0;
  let lastHeartbeatAt = performance.now();
  let lastDomSampleAt = 0;
  let lastDomNodes = 0;
  let active = false;
  let previousSession = null;
  let backgroundHang = null;
  let longFrameObserver = null;
  let longTaskObserver = null;

  const state = {
    sessionId,
    startedAt: new Date(startedAt).toISOString(),
    lastBeatAt: null,
    lastLifecycle: "starting",
    visibility: document.visibilityState,
    peakHeapMb: 0,
    peakDomNodes: 0,
    maxEventLoopLagMs: 0,
    stalls: [],
    longFrames: [],
    samples: [],
  };

  function monitorEnabled() {
    // Deliberately independent from Better ChatGPT's master switch. This allows
    // a near-native A/B test while retaining the hang recorder.
    return BCG.settings?.advanced?.performanceHangRecorder !== false;
  }

  function round(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const scale = 10 ** digits;
    return Math.round(number * scale) / scale;
  }

  function mb(bytes) {
    return round(Number(bytes || 0) / 1048576, 1);
  }

  function safePath() {
    return String(location.pathname || "/")
      .replace(/\/c\/[A-Za-z0-9_-]+/g, "/c/[redacted]")
      .replace(/\/g\/[^/]+/g, "/g/[redacted]");
  }

  function sourceLabel(url) {
    const raw = String(url || "");
    if (!raw) return "inline/unknown";
    try {
      const parsed = new URL(raw, location.href);
      if (/^(?:chrome|moz)-extension:$/.test(parsed.protocol)) return "better-chatgpt";
      if (parsed.origin === location.origin) return `chatgpt:${parsed.pathname.slice(0, 140)}`;
      return `${parsed.origin}${parsed.pathname}`.slice(0, 180);
    } catch {
      return "unknown";
    }
  }

  function trimRing(list, max) {
    if (list.length > max) list.splice(0, list.length - max);
  }

  function generationActive() {
    return Boolean(document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label="Stop"]',
    ));
  }

  function cheapUiMetrics(includeDom = false) {
    const memory = performance.memory;
    const heapUsedMb = memory ? mb(memory.usedJSHeapSize) : 0;
    const heapLimitMb = memory ? mb(memory.jsHeapSizeLimit) : 0;
    if (heapUsedMb > state.peakHeapMb) state.peakHeapMb = heapUsedMb;

    if (includeDom) {
      try {
        lastDomNodes = document.getElementsByTagName("*").length;
        if (lastDomNodes > state.peakDomNodes) state.peakDomNodes = lastDomNodes;
      } catch {
        // DOM sampling is diagnostic-only and must never affect ChatGPT.
      }
    }

    let messageTurns = 0;
    let codeBlocks = 0;
    let iframes = 0;
    let toolSurfaces = 0;
    try {
      messageTurns = document.querySelectorAll('[data-message-author-role], article[data-testid^="conversation-turn"]').length;
      codeBlocks = document.querySelectorAll("pre").length;
      iframes = document.querySelectorAll("iframe").length;
      toolSurfaces = document.querySelectorAll(
        '[data-testid*="tool" i], [data-testid*="connector" i], [data-testid*="mcp" i], [data-testid*="work" i], iframe[src*="mcp" i], iframe[title*="tool" i]',
      ).length;
    } catch {
      // Best-effort selectors only.
    }

    return {
      heapUsedMb,
      heapLimitMb,
      domNodes: lastDomNodes,
      messageTurns,
      codeBlocks,
      iframes,
      toolSurfaces,
      generating: generationActive(),
      visibility: document.visibilityState,
    };
  }

  function recordSample(reason = "interval") {
    const now = performance.now();
    const includeDom = now - lastDomSampleAt >= DOM_SAMPLE_MS;
    if (includeDom) lastDomSampleAt = now;
    const metrics = cheapUiMetrics(includeDom);
    state.samples.push({
      at: new Date().toISOString(),
      reason,
      ...metrics,
    });
    trimRing(state.samples, MAX_SAMPLES);
    return metrics;
  }

  function recordStall(lagMs, metrics = null) {
    const stall = {
      at: new Date().toISOString(),
      lagMs: round(lagMs),
      ...(metrics || cheapUiMetrics(false)),
    };
    state.stalls.push(stall);
    trimRing(state.stalls, MAX_STALLS);
    state.maxEventLoopLagMs = Math.max(state.maxEventLoopLagMs, stall.lagMs);
    BCG.recordTrace?.("native-ui-event-loop-stall", {
      lagMs: stall.lagMs,
      generating: stall.generating,
      toolSurfaces: stall.toolSurfaces,
    });
  }

  function topScripts(entry) {
    const scripts = Array.isArray(entry?.scripts) ? entry.scripts : [];
    return scripts
      .map((script) => ({
        durationMs: round(script.duration, 1),
        forcedLayoutMs: round(script.forcedStyleAndLayoutDuration, 1),
        invokerType: String(script.invokerType || "").slice(0, 80),
        source: sourceLabel(script.sourceURL),
        function: String(script.sourceFunctionName || "").slice(0, 100),
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5);
  }

  function observeLongFrames() {
    const supported = globalThis.PerformanceObserver?.supportedEntryTypes || [];
    if (supported.includes("long-animation-frame")) {
      try {
        longFrameObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const durationMs = round(entry.duration, 1);
            if (durationMs < 80) continue;
            const record = {
              at: new Date(Date.now() - Math.max(0, performance.now() - entry.startTime)).toISOString(),
              type: "long-animation-frame",
              durationMs,
              blockingMs: round(entry.blockingDuration, 1),
              renderStartMs: round(entry.renderStart - entry.startTime, 1),
              styleLayoutStartMs: round(entry.styleAndLayoutStart - entry.startTime, 1),
              scripts: topScripts(entry),
              ...cheapUiMetrics(false),
            };
            state.longFrames.push(record);
            trimRing(state.longFrames, MAX_FRAMES);
          }
        });
        longFrameObserver.observe({ type: "long-animation-frame", buffered: true });
        return "long-animation-frame";
      } catch {
        longFrameObserver = null;
      }
    }

    if (supported.includes("longtask")) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const durationMs = round(entry.duration, 1);
            if (durationMs < 80) continue;
            state.longFrames.push({
              at: new Date().toISOString(),
              type: "longtask",
              durationMs,
              blockingMs: Math.max(0, round(durationMs - 50, 1)),
              scripts: [],
              ...cheapUiMetrics(false),
            });
            trimRing(state.longFrames, MAX_FRAMES);
          }
        });
        longTaskObserver.observe({ type: "longtask", buffered: true });
        return "longtask";
      } catch {
        longTaskObserver = null;
      }
    }
    return "event-loop-only";
  }

  function extensionApi() {
    if (typeof browser !== "undefined" && browser?.storage?.local) return browser;
    if (typeof chrome !== "undefined" && chrome?.storage?.local) return chrome;
    return null;
  }

  async function loadPrevious() {
    const api = extensionApi();
    if (!api?.storage?.local) return;
    try {
      const stored = await api.storage.local.get([STORAGE_KEY, `${STORAGE_KEY}:hangs`]);
      const value = stored?.[STORAGE_KEY];
      if (value?.sessionId && value.sessionId !== sessionId) previousSession = value;
      const hangs = stored?.[`${STORAGE_KEY}:hangs`];
      if (Array.isArray(hangs) && hangs.length) backgroundHang = hangs.at(-1);
    } catch {
      // Diagnostics storage is optional.
    }
  }

  function currentSnapshot() {
    return {
      sessionId,
      startedAt: state.startedAt,
      savedAt: new Date().toISOString(),
      path: safePath(),
      lastBeatAt: state.lastBeatAt,
      lastLifecycle: state.lastLifecycle,
      visibility: state.visibility,
      peakHeapMb: state.peakHeapMb,
      peakDomNodes: state.peakDomNodes,
      maxEventLoopLagMs: state.maxEventLoopLagMs,
      stalls: state.stalls.slice(-MAX_STALLS),
      longFrames: state.longFrames.slice(-MAX_FRAMES),
      samples: state.samples.slice(-MAX_SAMPLES),
    };
  }

  async function persist() {
    const api = extensionApi();
    if (!api?.storage?.local) return;
    try {
      await api.storage.local.set({ [STORAGE_KEY]: currentSnapshot() });
    } catch {
      // Never let diagnostics interfere with the host page.
    }
  }

  function sendHeartbeat(metrics) {
    const guardStatus = BCG.nativeToolFreezeGuard?.status?.() || null;
    const api = extensionApi();
    if (!api?.runtime?.sendMessage) return;
    try {
      const result = api.runtime.sendMessage({
        type: "bcg:perf-heartbeat",
        payload: {
          sessionId,
          at: Date.now(),
          path: safePath(),
          ...metrics,
          guardActive: Boolean(guardStatus?.active),
          guardHeavy: Boolean(guardStatus?.heavy),
          guardRehydrating: Boolean(guardStatus?.rehydrating),
          guardRehydrateReason: String(guardStatus?.rehydrateReason || "").slice(0, 40),
          guardRehydrateRemainingMs: Number(guardStatus?.rehydrateRemainingMs || 0),
          guardToolSurfaces: Number(guardStatus?.markedToolCount || 0),
          guardObservedToolSurfaces: Number(guardStatus?.observedToolCount || 0),
          guardContainedTools: Number(guardStatus?.containedToolCount || 0),
          guardSkippedTools: Number(guardStatus?.skippedToolCount || 0),
          guardSkippedTurns: Number(guardStatus?.skippedTurnCount || 0),
        },
      });
      result?.catch?.(() => {});
    } catch {
      // Firefox/userscript/no background worker: content-side recorder still works.
    }
  }

  function heartbeat() {
    const now = performance.now();
    const elapsed = now - lastHeartbeatAt;
    lastHeartbeatAt = now;
    const lagMs = elapsed - HEARTBEAT_MS;
    const metrics = cheapUiMetrics(false);
    state.lastBeatAt = new Date().toISOString();
    state.visibility = document.visibilityState;
    if (lagMs >= STALL_THRESHOLD_MS) recordStall(lagMs, metrics);
    sendHeartbeat(metrics);
  }

  function start() {
    if (active || !monitorEnabled()) return;
    active = true;
    state.lastLifecycle = "running";
    lastHeartbeatAt = performance.now();
    const observerMode = observeLongFrames();
    recordSample("start");
    heartbeatTimer = window.setInterval(heartbeat, HEARTBEAT_MS);
    sampleTimer = window.setInterval(() => recordSample("interval"), SAMPLE_MS);
    flushTimer = window.setInterval(() => void persist(), FLUSH_MS);
    BCG.recordTrace?.("native-hang-recorder-started", { observerMode });
  }

  function stop() {
    if (!active) return;
    active = false;
    clearInterval(heartbeatTimer);
    clearInterval(sampleTimer);
    clearInterval(flushTimer);
    heartbeatTimer = sampleTimer = flushTimer = 0;
    longFrameObserver?.disconnect?.();
    longTaskObserver?.disconnect?.();
    longFrameObserver = longTaskObserver = null;
    state.lastLifecycle = "disabled";
    void persist();
  }

  function onSettingsChanged() {
    if (monitorEnabled()) start();
    else stop();
  }

  function lifecycle(label) {
    state.lastLifecycle = label;
    state.visibility = document.visibilityState;
    recordSample(label);
    void persist();
  }

  document.addEventListener("visibilitychange", () => lifecycle(`visibility:${document.visibilityState}`), { passive: true });
  window.addEventListener("pagehide", () => lifecycle("pagehide"), { passive: true });
  window.addEventListener("pageshow", () => lifecycle("pageshow"), { passive: true });
  window.addEventListener("bcg:settings-changed", onSettingsChanged);

  const api = {
    getReport() {
      return {
        active,
        note: "Timing/count metadata only; no chat or tool-result content is recorded.",
        current: currentSnapshot(),
        previousSession,
        lastBackgroundDetectedHang: backgroundHang,
      };
    },
    clear() {
      state.stalls.length = 0;
      state.longFrames.length = 0;
      state.samples.length = 0;
      state.maxEventLoopLagMs = 0;
      state.peakHeapMb = 0;
      state.peakDomNodes = 0;
      previousSession = null;
      backgroundHang = null;
      const ext = extensionApi();
      if (ext?.storage?.local) {
        const result = ext.storage.local.remove([STORAGE_KEY, `${STORAGE_KEY}:hangs`]);
        result?.catch?.(() => {});
      }
    },
  };

  globalThis.__bcgPerformanceWatchdog = api;
  BCG.performanceDiagnostics = api;
  void loadPrevious().finally(start);
})();
