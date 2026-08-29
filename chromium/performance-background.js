"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const STORAGE_KEY = "better-chatgpt:perf-diagnostics-v1";
const HANG_KEY = `${STORAGE_KEY}:hangs`;
const HANG_AFTER_MS = 4500;
const MAX_HANGS = 8;
const MAX_HEARTBEATS = 12;
const watches = new Map();

function watchKey(sender, payload) {
  return `${sender.tab?.id ?? "tab"}:${String(payload?.sessionId || "session")}`;
}

async function storeHang(hang) {
  try {
    const stored = await api.storage.local.get(HANG_KEY);
    const hangs = Array.isArray(stored?.[HANG_KEY]) ? stored[HANG_KEY] : [];
    const existing = hangs.findIndex((item) => item?.watchKey === hang.watchKey && !item?.recoveredAt);
    if (existing >= 0) hangs[existing] = { ...hang };
    else hangs.push(hang);
    if (hangs.length > MAX_HANGS) hangs.splice(0, hangs.length - MAX_HANGS);
    await api.storage.local.set({ [HANG_KEY]: hangs });
  } catch {
    // The watchdog must never make the extension less reliable.
  }
}

async function markRecovered(key, recoveredAt, gapMs) {
  try {
    const stored = await api.storage.local.get(HANG_KEY);
    const hangs = Array.isArray(stored?.[HANG_KEY]) ? stored[HANG_KEY] : [];
    const index = [...hangs].map((item) => item?.watchKey).lastIndexOf(key);
    if (index < 0 || hangs[index]?.recoveredAt) return;
    hangs[index] = { ...hangs[index], recoveredAt, observedGapMs: gapMs };
    await api.storage.local.set({ [HANG_KEY]: hangs });
  } catch {
    // Best effort.
  }
}

function heartbeatSnapshot(payload, now) {
  return {
    at: new Date(Number(payload.at || now)).toISOString(),
    path: String(payload.path || "/").slice(0, 180),
    visibility: String(payload.visibility || "").slice(0, 20),
    generating: Boolean(payload.generating),
    toolSurfaces: Number(payload.toolSurfaces || 0),
    heapUsedMb: Number(payload.heapUsedMb || 0),
    heapLimitMb: Number(payload.heapLimitMb || 0),
    domNodes: Number(payload.domNodes || 0),
    messageTurns: Number(payload.messageTurns || 0),
    codeBlocks: Number(payload.codeBlocks || 0),
    iframes: Number(payload.iframes || 0),
    guardActive: Boolean(payload.guardActive),
    guardHeavy: Boolean(payload.guardHeavy),
    guardRehydrating: Boolean(payload.guardRehydrating),
    guardRehydrateReason: String(payload.guardRehydrateReason || "").slice(0, 40),
    guardRehydrateRemainingMs: Number(payload.guardRehydrateRemainingMs || 0),
    guardToolSurfaces: Number(payload.guardToolSurfaces || 0),
    guardContainedTools: Number(payload.guardContainedTools || 0),
    guardSkippedTools: Number(payload.guardSkippedTools || 0),
    guardSkippedTurns: Number(payload.guardSkippedTurns || 0),
  };
}

api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "bcg:perf-heartbeat" || !sender.tab?.id) return;
  const payload = message.payload || {};
  const key = watchKey(sender, payload);
  const now = Date.now();
  const existing = watches.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  if (existing?.suspectedAt) void markRecovered(key, new Date(now).toISOString(), now - Number(existing.lastAt || now));

  const lastHeartbeat = heartbeatSnapshot(payload, now);
  const recentHeartbeats = Array.isArray(existing?.recentHeartbeats)
    ? existing.recentHeartbeats.slice(-(MAX_HEARTBEATS - 1))
    : [];
  recentHeartbeats.push(lastHeartbeat);

  const record = {
    watchKey: key,
    lastAt: Number(payload.at || now),
    lastHeartbeat,
    recentHeartbeats,
    suspectedAt: 0,
    timer: 0,
  };

  record.timer = setTimeout(() => {
    record.suspectedAt = Date.now();
    watches.set(key, record);
    void storeHang({
      watchKey: key,
      detectedAt: new Date(record.suspectedAt).toISOString(),
      thresholdMs: HANG_AFTER_MS,
      lastHeartbeat: record.lastHeartbeat,
      recentHeartbeats: record.recentHeartbeats.slice(-MAX_HEARTBEATS),
      recoveredAt: null,
    });
  }, HANG_AFTER_MS);
  watches.set(key, record);
});
