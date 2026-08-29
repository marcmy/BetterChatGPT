(() => {
  "use strict";

  const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (target.__betterChatGPTPageBridgeInstalled) return;
  target.__betterChatGPTPageBridgeInstalled = true;

  const CONTENT_SOURCE = "better-chatgpt-content";
  const PAGE_SOURCE = "better-chatgpt-page";
  const PENDING_ATTRIBUTE = "data-bcg-edit-submit-attachments";
  const nativeFetch = target.fetch.bind(target);
  const xhrPrototype = target.XMLHttpRequest?.prototype || null;
  const nativeXhrOpen = xhrPrototype?.open || null;
  const nativeXhrSend = xhrPrototype?.send || null;
  const nativeXhrSetRequestHeader = xhrPrototype?.setRequestHeader || null;
  const xhrRequests = new WeakMap();
  const nativeStages = new Map();
  const stageByFileId = new Map();
  const protectedLibraryFileIds = new Map();
  const activeNativeUploadIds = new Set();
  const nativeUploadExpiryTimers = new Map();
  const preparedTokens = new Map();
  const verifiedEditQueries = new Map();
  const attachmentMetadataById = new Map();
  const PREPARED_TOKEN_TTL_MS = 105000;
  const NATIVE_UPLOAD_STALE_MS = 15 * 60 * 1000;

  function trace(event, metadata = {}) {
    post("bcg:bridge-trace", { event, metadata });
  }

  function attachmentId(value) {
    const id = String(value?.id || value?.file_id || "");
    return /^file_[A-Za-z0-9_-]+$/.test(id) ? id : "";
  }

  function normalizeObservedAttachment(value) {
    if (!value || typeof value !== "object") return null;
    const id = attachmentId(value);
    if (!id) return null;
    const libraryFileId = String(value.library_file_id || value.libraryFileId || "");
    const name = String(value.name || value.file_name || value.filename || "");
    const mimeType = String(value.mime_type || value.mimeType || value.type || "application/octet-stream");
    const source = String(value.source || (libraryFileId ? "library" : ""));
    if (!name && !libraryFileId && source !== "library") return null;
    return {
      id,
      size: Number(value.size ?? value.size_bytes ?? value.file_size ?? 0) || 0,
      name: name || "attachment",
      mime_type: mimeType,
      source: source || "library",
      ...(libraryFileId ? { library_file_id: libraryFileId } : {}),
      is_big_paste: Boolean(value.is_big_paste),
    };
  }

  function rememberAttachmentMetadata(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return;
    seen.add(value);
    const attachment = normalizeObservedAttachment(value);
    if (attachment) {
      const previous = attachmentMetadataById.get(attachment.id) || {};
      const merged = { ...previous, ...attachment };
      attachmentMetadataById.set(attachment.id, merged);
      post("bcg:attachment-metadata", { attachment: merged });
    }
    if (Array.isArray(value)) {
      for (const item of value) rememberAttachmentMetadata(item, depth + 1, seen);
      return;
    }
    for (const child of Object.values(value)) rememberAttachmentMetadata(child, depth + 1, seen);
  }

  async function observeAttachmentMetadataResponse(response, path = "") {
    if (!response?.ok || !/file|library|mention|attachment|upload/i.test(String(path))) return;
    const type = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!type.includes("json")) return;
    try {
      rememberAttachmentMetadata(await response.clone().json());
    } catch {
      // Metadata observation must never affect ChatGPT's request.
    }
  }

  function pathOnly(input) {
    const url = requestUrl(input);
    return url ? url.pathname.slice(0, 180) : "";
  }

  function activeStageCount() {
    return nativeStages.size;
  }

  function publishNativeUploadCount() {
    const root = target.document?.documentElement;
    const count = activeNativeUploadIds.size;
    if (root) root.dataset.bcgNativeUploadCount = String(count);
    post("bcg:native-upload-count", { count });
  }

  function markNativeUploadStarted(fileId) {
    if (!fileId) return;
    const id = String(fileId);
    const previousTimer = nativeUploadExpiryTimers.get(id);
    if (previousTimer) target.clearTimeout(previousTimer);
    activeNativeUploadIds.add(id);
    nativeUploadExpiryTimers.set(id, target.setTimeout(() => {
      nativeUploadExpiryTimers.delete(id);
      if (!activeNativeUploadIds.delete(id)) return;
      trace("native-upload-stale-cleared", { activeUploads: activeNativeUploadIds.size });
      publishNativeUploadCount();
    }, NATIVE_UPLOAD_STALE_MS));
    publishNativeUploadCount();
  }

  function markNativeUploadFinished(fileId) {
    if (!fileId) return;
    const id = String(fileId);
    const timer = nativeUploadExpiryTimers.get(id);
    if (timer) target.clearTimeout(timer);
    nativeUploadExpiryTimers.delete(id);
    activeNativeUploadIds.delete(id);
    publishNativeUploadCount();
  }

  function fingerprintKey(fingerprint) {
    return `${Number(fingerprint?.length || 0)}:${String(fingerprint?.hash || "")}`;
  }

  function mergedHeaders(input, init) {
    const headers = new target.Headers(input instanceof target.Request ? input.headers : undefined);
    if (init?.headers) {
      new target.Headers(init.headers).forEach((value, name) => headers.set(name, value));
    }
    return headers;
  }


  function preparedTokenFor(pending) {
    const prepared = preparedTokens.get(pending?.nonce);
    if (!prepared || Date.now() - prepared.recordedAt > PREPARED_TOKEN_TTL_MS) return "";
    return prepared.token;
  }

  function recordPreparedToken(nonce, token) {
    if (!nonce || !token) return;
    preparedTokens.set(nonce, { token, recordedAt: Date.now() });
    trace("edit-prepare-token-recorded", {
      attachmentCount: readPendingEditInjection()?.attachments?.length || 0,
    });
  }

  async function tokenFromPrepareResponse(response) {
    if (!response?.ok) return "";
    const data = await response.clone().json().catch(() => null);
    return String(data?.conduit_token || data?.conduitToken || "");
  }

  function post(type, payload = {}) {
    target.postMessage({ source: PAGE_SOURCE, type, ...payload }, "*");
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

  function conversationRequestFingerprint(rawBody) {
    const payload = parseJsonText(rawBody, null);
    if (!Array.isArray(payload?.messages)) return null;
    const message = [...payload.messages].reverse().find((candidate) => candidate?.author?.role === "user");
    if (!message) return null;
    return textFingerprint(messageText(message));
  }

  function publishConversationRequest(rawBody) {
    const payload = parseJsonText(rawBody, null);
    if (payload) rememberAttachmentMetadata(payload);
    const fingerprint = conversationRequestFingerprint(rawBody);
    if (!fingerprint) return;
    post("bcg:conversation-request-seen", { fingerprint });
  }

  function readPendingEditInjection() {
    const root = target.document?.documentElement;
    const raw = root?.getAttribute(PENDING_ATTRIBUTE);
    if (!raw) return null;
    try {
      const pending = JSON.parse(raw);
      if (!pending || !Array.isArray(pending.attachments) || Number(pending.expiresAt) < Date.now()) {
        root.removeAttribute(PENDING_ATTRIBUTE);
        return null;
      }
      return pending;
    } catch {
      root?.removeAttribute(PENDING_ATTRIBUTE);
      return null;
    }
  }

  function clearPendingEditInjection(nonce) {
    const root = target.document?.documentElement;
    if (!root) return;
    const pending = readPendingEditInjection();
    if (!pending || !nonce || pending.nonce === nonce) root.removeAttribute(PENDING_ATTRIBUTE);
    if (nonce) {
      preparedTokens.delete(nonce);
      verifiedEditQueries.delete(nonce);
    }
  }

  function requestUrl(input) {
    try {
      const base = /^https?:/i.test(String(target.location?.href || ""))
        ? target.location.href
        : "https://chatgpt.com/";
      return new URL(input instanceof target.Request ? input.url : String(input), base);
    } catch {
      return null;
    }
  }

  function requestMethod(input, init) {
    return String(init?.method || (input instanceof target.Request ? input.method : "GET")).toUpperCase();
  }

  function isSameOriginPost(input, init) {
    const url = requestUrl(input);
    return Boolean(
      url &&
        requestMethod(input, init) === "POST" &&
        (target.location.origin === "null" || url.origin === target.location.origin),
    );
  }

  function looksLikeConversationUrl(input) {
    const url = requestUrl(input);
    return Boolean(
      url && /^\/(?:backend-api|backend-anon)\/(?:[^/]+\/)*conversation\/?$/.test(url.pathname),
    );
  }

  function looksLikeConversationPrepareUrl(input) {
    const url = requestUrl(input);
    return Boolean(url && /\/conversation\/prepare\/?$/.test(url.pathname));
  }

  const STALE_DRAFT_KEY = "better-chatgpt:stale-draft-v1";
  const STALE_IDLE_MS = 45000;
  let staleBaseline = null;
  let staleIdleTimer = 0;
  let staleCheckPromise = null;
  let cachedAccessToken = "";
  let cachedAccessTokenAt = 0;

  function crossDeviceGuardEnabled() {
    return target.document?.documentElement?.dataset?.bcgCrossDeviceGuard !== "0";
  }

  function currentConversationId() {
    const match = String(target.location?.pathname || "").match(/\/c\/([0-9a-f-]{20,})/i);
    return match ? match[1] : "";
  }

  function generationLooksActive() {
    return Boolean(target.document?.querySelector?.(
      '[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label="Stop"]',
    ));
  }

  function currentComposerText() {
    const prompt = target.document?.querySelector?.(
      '#prompt-textarea, [data-testid="prompt-textarea"], textarea[placeholder*="message" i], [contenteditable="true"][data-lexical-editor="true"]',
    );
    if (!prompt) return "";
    return String("value" in prompt ? prompt.value : prompt.textContent || "").trim();
  }

  function composerHasAttachments() {
    const prompt = target.document?.querySelector?.(
      '#prompt-textarea, [data-testid="prompt-textarea"], textarea[placeholder*="message" i], [contenteditable="true"][data-lexical-editor="true"]',
    );
    const root = prompt?.closest?.('form, [data-testid="composer-root"], [class*="composer" i]') || prompt?.parentElement;
    return Boolean(root?.querySelector?.(
      '[data-testid*="attachment" i]:not(input), [data-testid*="file" i]:not(input), button[aria-label*="remove file" i], button[aria-label*="remove attachment" i]',
    ));
  }

  function saveStaleDraft(text = "") {
    const draft = String(text || currentComposerText() || "").trim();
    const hadAttachments = composerHasAttachments();
    if (!draft && !hadAttachments) return;
    try {
      target.sessionStorage.setItem(STALE_DRAFT_KEY, JSON.stringify({
        path: String(target.location?.pathname || ""),
        text: draft,
        hadAttachments,
        savedAt: Date.now(),
      }));
    } catch {
      // Draft preservation is best-effort.
    }
  }

  async function accessToken() {
    if (cachedAccessToken && Date.now() - cachedAccessTokenAt < 5 * 60 * 1000) return cachedAccessToken;
    const response = await nativeFetch("/api/auth/session", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Session refresh failed (${response.status}).`);
    const data = await response.json();
    const token = String(data?.accessToken || "");
    if (!token) throw new Error("Session refresh returned no access token.");
    cachedAccessToken = token;
    cachedAccessTokenAt = Date.now();
    return token;
  }

  async function conversationSnapshot(conversationId) {
    if (!conversationId) return null;
    const token = await accessToken();
    const response = await nativeFetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      cachedAccessToken = "";
      cachedAccessTokenAt = 0;
    }
    if (!response.ok) throw new Error(`Conversation freshness check failed (${response.status}).`);
    const data = await response.json();
    return {
      conversationId,
      currentNode: String(data?.current_node || ""),
      updateTime: String(data?.update_time || ""),
    };
  }

  function triggerStaleResync(reason, draftText = "") {
    if (target.document?.documentElement?.dataset?.bcgStaleResync === "1") return;
    saveStaleDraft(draftText);
    if (target.document?.documentElement) target.document.documentElement.dataset.bcgStaleResync = "1";
    post("bcg:stale-conversation-detected", { reason: String(reason || "node-mismatch").slice(0, 80) });
    trace("stale-conversation-resync", { reason: String(reason || "node-mismatch").slice(0, 80) });
    target.setTimeout(() => target.location.reload(), 60);
  }

  async function captureStaleBaseline(reason = "idle") {
    if (!crossDeviceGuardEnabled()) return;
    if (generationLooksActive()) {
      target.setTimeout(() => void captureStaleBaseline(`${reason}-settled`), 5000);
      return;
    }
    const conversationId = currentConversationId();
    if (!conversationId || staleBaseline?.conversationId === conversationId) return;
    try {
      const snapshot = await conversationSnapshot(conversationId);
      if (!snapshot?.currentNode) return;
      staleBaseline = { ...snapshot, capturedAt: Date.now() };
      trace("stale-baseline-captured", { reason, hasNode: true });
    } catch (error) {
      trace("stale-baseline-failed-open", { reason: String(error?.name || "Error").slice(0, 80) });
    }
  }

  async function compareStaleBaseline(reason = "resume") {
    if (!crossDeviceGuardEnabled() || !staleBaseline || staleCheckPromise) return staleCheckPromise;
    const baseline = staleBaseline;
    const conversationId = currentConversationId();
    if (!conversationId || conversationId !== baseline.conversationId) {
      staleBaseline = null;
      return null;
    }
    staleCheckPromise = (async () => {
      try {
        const latest = await conversationSnapshot(conversationId);
        if (latest?.currentNode && baseline.currentNode && latest.currentNode !== baseline.currentNode) {
          triggerStaleResync(reason);
          return false;
        }
        staleBaseline = null;
        trace("stale-baseline-current", { reason });
        return true;
      } catch (error) {
        trace("stale-resume-check-failed-open", { reason: String(error?.name || "Error").slice(0, 80) });
        return null;
      } finally {
        staleCheckPromise = null;
      }
    })();
    return staleCheckPromise;
  }

  async function guardConversationTail(rawBody) {
    if (!crossDeviceGuardEnabled() || !staleBaseline) return true;
    const payload = parseJsonText(rawBody, null);
    if (!payload || String(payload.action || "next") !== "next") return true;
    const conversationId = String(payload.conversation_id || "");
    const parentMessageId = String(payload.parent_message_id || "");
    if (!conversationId || !parentMessageId || staleBaseline.conversationId !== conversationId) return true;
    try {
      const latest = await conversationSnapshot(conversationId);
      if (latest?.currentNode && latest.currentNode !== parentMessageId) {
        const message = Array.isArray(payload.messages)
          ? [...payload.messages].reverse().find((candidate) => candidate?.author?.role === "user")
          : null;
        triggerStaleResync("outdated-parent-before-send", message ? messageText(message) : "");
        return false;
      }
      staleBaseline = null;
      trace("stale-send-preflight-current", { checked: true });
    } catch (error) {
      trace("stale-send-preflight-failed-open", { reason: String(error?.name || "Error").slice(0, 80) });
    }
    return true;
  }

  function scheduleIdleBaseline() {
    target.clearTimeout(staleIdleTimer);
    staleIdleTimer = target.setTimeout(() => void captureStaleBaseline("idle"), STALE_IDLE_MS);
  }

  function noteUserActivity() {
    if (staleBaseline) void compareStaleBaseline("user-returned");
    scheduleIdleBaseline();
  }

  target.addEventListener("visibilitychange", () => {
    if (target.document?.visibilityState === "hidden") void captureStaleBaseline("hidden");
    else if (staleBaseline) void compareStaleBaseline("visible");
  }, { passive: true });
  target.addEventListener("focus", () => {
    if (staleBaseline) void compareStaleBaseline("focus");
    scheduleIdleBaseline();
  }, { passive: true });
  for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    target.addEventListener(eventName, noteUserActivity, { capture: true, passive: true });
  }
  scheduleIdleBaseline();

  function isCreateFileRequest(input, init) {
    const url = requestUrl(input);
    return Boolean(url && requestMethod(input, init) === "POST" && /\/backend-api\/files\/?$/.test(url.pathname));
  }

  function isProcessUploadRequest(input, init) {
    const url = requestUrl(input);
    return Boolean(
      url &&
        requestMethod(input, init) === "POST" &&
        /\/backend-api\/files\/process_upload_stream\/?$/.test(url.pathname),
    );
  }

  function processUploadFileIdFromText(text) {
    const payload = parseJsonText(text, null);
    return payload?.file_id ? String(payload.file_id) : "";
  }

  function completedFileId(input, init) {
    const url = requestUrl(input);
    if (!url) return "";
    const method = requestMethod(input, init);
    const legacy = method === "POST"
      ? url.pathname.match(/\/backend-api\/files\/([^/]+)\/uploaded\/?$/)
      : null;
    if (legacy) return decodeURIComponent(legacy[1]);

    const simple = method === "GET"
      ? url.pathname.match(/\/backend-api\/files\/([^/]+)\/simple\/?$/)
      : null;
    return simple ? decodeURIComponent(simple[1]) : "";
  }

  function protectedDeleteFileId(input, init) {
    const url = requestUrl(input);
    if (!url || requestMethod(input, init) !== "DELETE") return "";
    const match = url.pathname.match(/\/backend-api\/files\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function requestBodyText(input, init) {
    if (typeof init?.body === "string") return init.body;
    if (input instanceof target.Request) return input.clone().text();
    return "";
  }

  function fileTicketMatchMode(ticket, stage) {
    if (!ticket || !stage) return "";
    const nameMatches = String(ticket.file_name || "") === String(stage.file.name || "");
    const sizeMatches = Number(ticket.file_size) === Number(stage.file.size);
    if (nameMatches && sizeMatches) return "exact";
    if (nameMatches) return "name";
    if (sizeMatches) return "size";
    return "";
  }

  function oldestMatchingStage(ticket) {
    const candidates = [...nativeStages.values()]
      .filter((stage) => !stage.fileId)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const mode of ["exact", "name"]) {
      const matches = candidates.filter((stage) => fileTicketMatchMode(ticket, stage) === mode);
      if (matches.length === 1) {
        matches[0].matchMode = mode;
        return matches[0];
      }
    }
    if (candidates.length === 1 && Date.now() - candidates[0].startedAt <= 15000) {
      candidates[0].matchMode = "sole-active-stage";
      return candidates[0];
    }
    return null;
  }

  function failNativeStage(stage, error) {
    if (!stage) return;
    nativeStages.delete(stage.requestId);
    if (stage.fileId) {
      stageByFileId.delete(stage.fileId);
      markNativeUploadFinished(stage.fileId);
    }
    post("bcg:native-stage-result", {
      requestId: stage.requestId,
      ok: false,
      error: String(error?.message || error || "Native Library upload failed").slice(0, 240),
    });
    trace("stage-failed", { reason: String(error?.name || "Error"), activeStages: activeStageCount() });
  }

  function responseSucceeded(status) {
    return Number(status) >= 200 && Number(status) < 300;
  }

  function retryableSubmitFailure(error) {
    const name = String(error?.name || "").toLowerCase();
    const message = String(error?.message || error || "").toLowerCase();
    return name === "aborterror" || message.includes("signal is aborted") || message.includes("the operation was aborted") || message.includes("failed to fetch");
  }

  function pendingSubmitIsActive(nonce) {
    return Boolean(nonce && readPendingEditInjection()?.nonce === nonce);
  }

  function settlePendingSubmit(pending, result) {
    if (!pendingSubmitIsActive(pending?.nonce)) return;
    clearPendingEditInjection(pending.nonce);
    post("bcg:edit-submit-result", {
      nonce: pending.nonce,
      attachmentCount: pending.attachments.length,
      ...result,
    });
  }

  async function observePatchedFetchResponse(response, pending, input) {
    if (!response?.body || !response.ok) {
      settlePendingSubmit(pending, { ok: Boolean(response?.ok), status: Number(response?.status || 0) });
      return;
    }

    let monitored;
    try {
      monitored = response.clone();
    } catch (error) {
      trace("edit-submit-response-unmonitored", {
        path: pathOnly(input),
        transport: "fetch",
        reason: String(error?.name || "clone-failed").slice(0, 80),
      });
      return;
    }

    try {
      const reader = monitored.body?.getReader?.();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      trace("edit-submit-stream-complete", {
        path: pathOnly(input),
        transport: "fetch",
        status: Number(response.status || 0),
      });
      settlePendingSubmit(pending, { ok: response.ok, status: response.status });
    } catch (error) {
      if (retryableSubmitFailure(error)) {
        preparedTokens.delete(pending?.nonce);
        trace("edit-submit-retry-pending", {
          path: pathOnly(input),
          transport: "fetch",
          reason: String(error?.name || "abort").slice(0, 80),
          phase: "response-stream",
        });
        return;
      }
      settlePendingSubmit(pending, {
        ok: false,
        status: Number(response.status || 0),
        error: String(error?.message || error || "Edit response stream failed").slice(0, 240),
      });
    }
  }

  function recordGlobalCreatedFile(created, status, ticket = null) {
    if (!responseSucceeded(status) || !created?.file_id) return;
    const fileId = String(created.file_id);
    markNativeUploadStarted(fileId);

    // Normal composer/follow-up uploads are not native edit stages, so there is
    // no stage object from which to recover the original File later. Correlate
    // ChatGPT's create-file ticket with the returned file ID immediately; the
    // queued follow-up bridge needs this name/size -> ID mapping after upload
    // processing completes.
    if (ticket && typeof ticket === "object") {
      const name = String(ticket.file_name || ticket.name || "");
      const size = Number(ticket.file_size ?? ticket.size ?? 0) || 0;
      if (name) {
        rememberAttachmentMetadata({
          id: fileId,
          name,
          size,
          mime_type: String(
            ticket.mime_type || ticket.mimeType || ticket.file_type || ticket.type || "application/octet-stream",
          ),
          source: String(ticket.source || "library"),
          is_big_paste: Boolean(ticket.is_big_paste),
        });
        trace("file-create-metadata-correlated", {
          size,
          hasName: true,
        });
      }
    }
  }

  function recordCreatedFile(stage, ticket, created, status) {
    if (!stage) return;
    if (!responseSucceeded(status)) {
      failNativeStage(stage, new Error(`ChatGPT's native file creation failed (${status}).`));
      return;
    }
    if (!created?.file_id) {
      failNativeStage(stage, new Error("ChatGPT's native uploader returned no file ID."));
      return;
    }
    stage.fileId = String(created.file_id);
    stage.useCase = String(ticket?.use_case || "my_files");
    stageByFileId.set(stage.fileId, stage);
    trace("file-created", {
      status: Number(status),
      matchedStage: true,
      matchMode: stage.matchMode || "exact",
      activeStages: activeStageCount(),
    });
  }

  function recordFinalizedFile(fileId, completed, status) {
    markNativeUploadFinished(fileId);
    const stage = stageByFileId.get(fileId);
    if (!stage) return;
    if (!responseSucceeded(status)) {
      failNativeStage(stage, new Error(`ChatGPT's native file finalization failed (${status}).`));
      return;
    }
    nativeStages.delete(stage.requestId);
    stageByFileId.delete(fileId);
    protectedLibraryFileIds.set(fileId, Date.now() + 15000);
    rememberAttachmentMetadata(completed);
    const observed = attachmentMetadataById.get(fileId) || {};
    const observedMimeType = String(observed.mime_type || "");
    const attachment = {
      id: fileId,
      size: Number(observed.size ?? stage.file.size ?? 0) || 0,
      name: String(observed.name || stage.file.name || "attachment"),
      mime_type: String(
        observedMimeType && observedMimeType !== "application/octet-stream"
          ? observedMimeType
          : stage.file.type || observedMimeType || "application/octet-stream",
      ),
      source: String(observed.source || "library"),
      ...(observed.library_file_id ? { library_file_id: String(observed.library_file_id) } : {}),
      is_big_paste: Boolean(observed.is_big_paste),
      useCase: stage.useCase || "my_files",
      downloadUrl: typeof completed?.download_url === "string" ? completed.download_url : "",
      ...(Number.isFinite(stage.file.width) ? { width: Number(stage.file.width) } : {}),
      ...(Number.isFinite(stage.file.height) ? { height: Number(stage.file.height) } : {}),
    };
    attachmentMetadataById.set(fileId, attachment);
    post("bcg:native-stage-result", {
      requestId: stage.requestId,
      ok: true,
      attachment,
    });
    trace("file-finalized", { status: Number(status), matchedStage: true, activeStages: activeStageCount() });
  }

  function processingOutcome(text) {
    let completed = false;
    let failed = false;
    let message = "";
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line === "[DONE]" || line.startsWith(":")) continue;
      if (line.startsWith("data:")) line = line.slice(5).trim();
      if (!line || line === "[DONE]") continue;
      const event = parseJsonText(line, null);
      if (!event || typeof event !== "object") continue;
      const name = String(event.event || event.type || event.status || "");
      if (["file.indexing.completed", "file.processing.completed", "file.processed"].includes(name)) {
        completed = true;
      }
      if (["file.indexing.failed", "file.processing.failed"].includes(name)) {
        failed = true;
        message = String(event.message || event.error || name);
      }
    }
    return { completed, failed, message };
  }

  async function observeProcessingResponse(fileId, response) {
    if (!fileId || !response) return;
    try {
      const text = await response.text();
      const outcome = processingOutcome(text);
      trace("file-processing-stream", {
        matchedStage: stageByFileId.has(fileId),
        completed: outcome.completed,
        failed: outcome.failed,
        activeStages: activeStageCount(),
      });
      const stage = stageByFileId.get(fileId);
      if (outcome.failed) {
        markNativeUploadFinished(fileId);
        if (stage) failNativeStage(stage, new Error(outcome.message || "ChatGPT failed to process the staged file."));
      } else if (outcome.completed) {
        recordFinalizedFile(fileId, {}, response.status);
      }
    } catch (error) {
      trace("file-processing-stream-error", {
        reason: String(error?.name || "Error"),
        activeStages: activeStageCount(),
      });
    }
  }

  function parseJsonText(text, fallback = {}) {
    if (typeof text !== "string" || !text.trim()) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function xhrResponseText(xhr) {
    try {
      if (typeof xhr?.responseText === "string") return xhr.responseText;
    } catch {
      // responseText throws for non-text response types.
    }
    try {
      if (typeof xhr?.response === "string") return xhr.response;
    } catch {
      // Ignore browser-specific response getter failures.
    }
    return "";
  }

  function xhrJson(xhr, fallback = {}) {
    try {
      if (xhr?.responseType === "json" && xhr.response && typeof xhr.response === "object") return xhr.response;
    } catch {
      return fallback;
    }
    try {
      if (typeof xhr?.responseText === "string") return parseJsonText(xhr.responseText, fallback);
    } catch {
      // Reading responseText throws for non-text response types.
    }
    try {
      if (typeof xhr?.response === "string") return parseJsonText(xhr.response, fallback);
    } catch {
      // A browser-specific response getter should not break native uploads.
    }
    return fallback;
  }

  function finishProtectedXhr(xhr, url) {
    const values = {
      readyState: 4,
      status: 200,
      statusText: "OK",
      responseURL: String(url || ""),
      responseText: "{}",
      response: xhr?.responseType === "json" ? {} : "{}",
    };
    for (const [name, value] of Object.entries(values)) {
      try {
        Object.defineProperty(xhr, name, { configurable: true, get: () => value });
      } catch {
        // Chromium allows own-property overrides on XHR response fields. If a
        // future browser does not, the synthetic completion events still keep
        // the native composer from hanging while the protected request stays local.
      }
    }
    target.queueMicrotask(() => {
      xhr.dispatchEvent(new target.Event("readystatechange"));
      const Progress = target.ProgressEvent || target.Event;
      xhr.dispatchEvent(new Progress("load"));
      xhr.dispatchEvent(new Progress("loadend"));
    });
  }

  function installXhrObservation() {
    if (!xhrPrototype || typeof nativeXhrOpen !== "function" || typeof nativeXhrSend !== "function") {
      trace("xhr-hook-unavailable", { hasPrototype: Boolean(xhrPrototype) });
      return;
    }

    xhrPrototype.open = function betterChatGptXhrOpen(method, url, ...rest) {
      xhrRequests.set(this, { method: String(method || "GET").toUpperCase(), url: String(url || ""), headers: [] });
      return nativeXhrOpen.call(this, method, url, ...rest);
    };

    if (typeof nativeXhrSetRequestHeader === "function") {
      xhrPrototype.setRequestHeader = function betterChatGptXhrSetRequestHeader(name, value) {
        const request = xhrRequests.get(this);
        if (request) request.headers.push([String(name), String(value)]);
        return nativeXhrSetRequestHeader.call(this, name, value);
      };
    }

    xhrPrototype.send = function betterChatGptXhrSend(body = null) {
      const request = xhrRequests.get(this) || { method: "GET", url: "" };
      const init = { method: request.method, body: typeof body === "string" ? body : "" };
      const pendingSubmit = readPendingEditInjection();
      const sameOriginPost = isSameOriginPost(request.url, init);
      const prepareRequest = sameOriginPost && looksLikeConversationPrepareUrl(request.url);
      const conversationRequest = sameOriginPost && looksLikeConversationUrl(request.url);
      let outgoingBody = body;
      let patchedSubmit = null;
      if (prepareRequest) {
        trace("edit-prepare-seen", {
          path: pathOnly(request.url),
          transport: "xhr",
          pendingSubmit: Boolean(pendingSubmit),
        });
      }
      if (conversationRequest) {
        trace("conversation-request-seen", {
          path: pathOnly(request.url),
          transport: "xhr",
          pendingSubmit: Boolean(pendingSubmit),
        });
      }
      if (conversationRequest) {
        publishConversationRequest(typeof body === "string" ? body : "");
      }
      if (pendingSubmit && prepareRequest) {
        const patchedPrepareBody = patchPendingPrepareBody(typeof body === "string" ? body : "", pendingSubmit);
        if (patchedPrepareBody) {
          outgoingBody = patchedPrepareBody;
          trace("edit-prepare-patched", {
            path: pathOnly(request.url),
            transport: "xhr",
            attachmentCount: pendingSubmit.attachments.length,
          });
          this.addEventListener(
            "loadend",
            () => {
              const token = String(xhrJson(this, null)?.conduit_token || "");
              if (token && responseSucceeded(this.status)) recordPreparedToken(pendingSubmit.nonce, token);
            },
            { once: true },
          );
        } else {
          trace("edit-prepare-ignored", {
            path: pathOnly(request.url),
            transport: "xhr",
            reason: "not-active-edit",
          });
        }
      }
      if (pendingSubmit && conversationRequest) {
        outgoingBody = patchPendingEditBody(typeof outgoingBody === "string" ? outgoingBody : "", pendingSubmit);
        patchedSubmit = pendingSubmit;
        trace("edit-submit-patched", {
          path: pathOnly(request.url),
          transport: "xhr",
          attachmentCount: pendingSubmit.attachments.length,
        });
        this.addEventListener(
          "loadend",
          () => {
            if (Number(this.status || 0) === 0) {
              preparedTokens.delete(pendingSubmit.nonce);
              trace("edit-submit-retry-pending", {
                path: pathOnly(request.url),
                transport: "xhr",
                reason: "status-0",
              });
              return;
            }
            settlePendingSubmit(pendingSubmit, {
              ok: responseSucceeded(this.status),
              status: Number(this.status || 0),
            });
          },
          { once: true },
        );
      }
      if (patchedSubmit) {
        const token = preparedTokenFor(patchedSubmit);
        if (token && typeof nativeXhrSetRequestHeader === "function") {
          nativeXhrSetRequestHeader.call(this, "x-conduit-token", token);
        }
        trace("edit-submit-dispatched-immediately", {
          path: pathOnly(request.url),
          transport: "xhr",
          preparedToken: Boolean(token),
        });
        return nativeXhrSend.call(this, outgoingBody);
      }

      const interestingPath = pathOnly(request.url);
      const interesting = /file|upload|attachment|library|mention/i.test(interestingPath);
      if (interesting) {
        this.addEventListener("loadend", () => {
          if (responseSucceeded(this.status)) rememberAttachmentMetadata(xhrJson(this, null));
        }, { once: true });
      }
      const deletingId = protectedDeleteFileId(request.url, init);
      if (deletingId) {
        markNativeUploadFinished(deletingId);
        const expiresAt = protectedLibraryFileIds.get(deletingId) || 0;
        protectedLibraryFileIds.delete(deletingId);
        if (expiresAt >= Date.now()) {
          finishProtectedXhr(this, request.url);
          return undefined;
        }
      }

      let createTicket = null;
      let createStage = null;
      const createRequest = isCreateFileRequest(request.url, init);
      const finalizingId = completedFileId(request.url, init);
      const processingId = isProcessUploadRequest(request.url, init)
        ? processUploadFileIdFromText(typeof body === "string" ? body : "")
        : "";
      if (createRequest) {
        createTicket = parseJsonText(typeof body === "string" ? body : "", null);
        createStage = oldestMatchingStage(createTicket);
      }

      if (interesting && activeStageCount() > 0) {
        trace("xhr-request", {
          method: request.method,
          path: interestingPath,
          bodyType: body === null ? "null" : typeof body === "string" ? "string" : body?.constructor?.name || typeof body,
          createRoute: createRequest,
          finalizeRoute: Boolean(finalizingId),
          processingRoute: Boolean(processingId),
          matchedStage: Boolean(
            createStage ||
              (finalizingId && stageByFileId.has(finalizingId)) ||
              (processingId && stageByFileId.has(processingId)),
          ),
          activeStages: activeStageCount(),
        });
      }

      if (createRequest || finalizingId || processingId) {
        this.addEventListener(
          "loadend",
          () => {
            trace("xhr-response", {
              path: interestingPath,
              status: Number(this.status || 0),
              createRoute: createRequest,
              finalizeRoute: Boolean(finalizingId),
              processingRoute: Boolean(processingId),
              activeStages: activeStageCount(),
            });
            if (createRequest) {
              const created = xhrJson(this, null);
              recordGlobalCreatedFile(created, this.status, createTicket);
              if (createStage) recordCreatedFile(createStage, createTicket, created, this.status);
            }
            if (finalizingId) recordFinalizedFile(finalizingId, xhrJson(this, {}), this.status);
            if (processingId) {
              const stage = stageByFileId.get(processingId);
              if (!responseSucceeded(this.status)) {
                markNativeUploadFinished(processingId);
                if (stage) failNativeStage(stage, new Error(`ChatGPT's native file processing failed (${this.status}).`));
              } else {
                const outcome = processingOutcome(xhrResponseText(this));
                if (outcome.failed) {
                  markNativeUploadFinished(processingId);
                  if (stage) failNativeStage(stage, new Error(outcome.message || "ChatGPT failed to process the staged file."));
                } else if (outcome.completed) {
                  recordFinalizedFile(processingId, {}, this.status);
                }
              }
            }
          },
          { once: true },
        );
      }

      try {
        return nativeXhrSend.call(this, outgoingBody);
      } catch (error) {
        if (createStage) failNativeStage(createStage, error);
        if (finalizingId) {
          const stage = stageByFileId.get(finalizingId);
          if (stage) failNativeStage(stage, error);
          else markNativeUploadFinished(finalizingId);
        }
        if (processingId) {
          const stage = stageByFileId.get(processingId);
          if (stage) failNativeStage(stage, error);
          else markNativeUploadFinished(processingId);
        }
        if (patchedSubmit) {
          post("bcg:edit-submit-result", {
            nonce: patchedSubmit.nonce,
            ok: false,
            status: 0,
            error: String(error?.message || error || "Edit submission failed").slice(0, 240),
          });
        }
        throw error;
      }
    };
  }

  async function fetchWithNativeStageObservation(input, init) {
    const deletingId = protectedDeleteFileId(input, init);
    if (deletingId) {
      markNativeUploadFinished(deletingId);
      const expiresAt = protectedLibraryFileIds.get(deletingId) || 0;
      protectedLibraryFileIds.delete(deletingId);
      if (expiresAt >= Date.now()) {
        return new target.Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    let createTicket = null;
    let createStage = null;
    const createRequest = isCreateFileRequest(input, init);
    const finalizingId = completedFileId(input, init);
    let processingId = "";

    if (isProcessUploadRequest(input, init)) {
      try {
        processingId = processUploadFileIdFromText(await requestBodyText(input, init));
      } catch {
        processingId = "";
      }
    }

    if (createRequest) {
      try {
        createTicket = JSON.parse(await requestBodyText(input, init));
        createStage = oldestMatchingStage(createTicket);
      } catch {
        createTicket = null;
      }
    }

    const interestingPath = pathOnly(input);
    if (/file|upload|attachment|library/i.test(interestingPath) && activeStageCount() > 0) {
      trace("fetch-request", {
        method: requestMethod(input, init),
        path: interestingPath,
        createRoute: createRequest,
        finalizeRoute: Boolean(finalizingId),
        processingRoute: Boolean(processingId),
        matchedStage: Boolean(
          createStage ||
            (finalizingId && stageByFileId.has(finalizingId)) ||
            (processingId && stageByFileId.has(processingId)),
        ),
        activeStages: activeStageCount(),
      });
    }

    let response;
    try {
      response = await nativeFetch(input, init);
    } catch (error) {
      if (createStage) failNativeStage(createStage, error);
      if (finalizingId) {
        const stage = stageByFileId.get(finalizingId);
        if (stage) failNativeStage(stage, error);
        else markNativeUploadFinished(finalizingId);
      }
      if (processingId) {
        const stage = stageByFileId.get(processingId);
        if (stage) failNativeStage(stage, error);
        else markNativeUploadFinished(processingId);
      }
      throw error;
    }

    if (createRequest) {
      const created = response.ok ? await response.clone().json().catch(() => null) : null;
      recordGlobalCreatedFile(created, response.status, createTicket);
      if (createStage) recordCreatedFile(createStage, createTicket, created, response.status);
    }

    if (finalizingId) {
      const completed = response.ok ? await response.clone().json().catch(() => ({})) : {};
      recordFinalizedFile(finalizingId, completed, response.status);
    }

    if (processingId) {
      if (response.ok) void observeProcessingResponse(processingId, response.clone());
      else {
        markNativeUploadFinished(processingId);
        const stage = stageByFileId.get(processingId);
        if (stage) failNativeStage(stage, new Error(`ChatGPT's native file processing failed (${response.status}).`));
      }
    }

    if (/file|upload|attachment|library/i.test(interestingPath) && activeStageCount() > 0) {
      trace("fetch-response", { path: interestingPath, status: Number(response.status || 0), activeStages: activeStageCount() });
    }
    void observeAttachmentMetadataResponse(response, interestingPath);

    return response;
  }

  function textFromContentPart(part) {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    for (const key of ["text", "content", "value"]) {
      if (typeof part[key] === "string") return part[key];
    }
    return "";
  }

  function messageText(message) {
    if (typeof message?.content === "string") return message.content;
    const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
    const fromParts = parts.map(textFromContentPart).filter(Boolean);
    if (fromParts.length) return fromParts.join("\n");
    for (const candidate of [message?.text, message?.content?.text, message?.content?.content]) {
      if (typeof candidate === "string") return candidate;
    }
    return "";
  }

  function preservedTextParts(parts) {
    if (!Array.isArray(parts)) return [""];
    const kept = parts.filter((part) => {
      if (typeof part === "string") return true;
      return Boolean(part && typeof part === "object" && !part.asset_pointer && textFromContentPart(part));
    });
    return kept.length ? kept : [""];
  }

  function normalizedAttachment(entry) {
    const libraryFileId = String(entry.library_file_id || entry.libraryFileId || "");
    return {
      id: String(entry.id),
      size: Number(entry.size ?? entry.size_bytes ?? 0) || 0,
      name: String(entry.name || "attachment"),
      mime_type: String(entry.mime_type || entry.mimeType || "application/octet-stream"),
      source: String(entry.source || (libraryFileId ? "library" : "library")),
      ...(libraryFileId ? { library_file_id: libraryFileId } : {}),
      is_big_paste: Boolean(entry.is_big_paste),
      ...(Number.isFinite(entry.width) && Number.isFinite(entry.height)
        ? { width: Number(entry.width), height: Number(entry.height) }
        : {}),
    };
  }

  function attachmentMimeType(attachment) {
    return String(attachment?.mime_type || attachment?.mimeType || "application/octet-stream");
  }

  function isMentionReference(entry) {
    return Boolean(entry?.__bcgMentionReference);
  }

  function fingerprintMatches(message, pending) {
    if (!message) return false;
    const fingerprint = textFingerprint(messageText(message));
    return (
      Number(pending.textFingerprint?.length) === fingerprint.length &&
      String(pending.textFingerprint?.hash || "") === fingerprint.hash
    );
  }

  function cloneJson(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function rememberVerifiedEditQuery(message, pending) {
    if (!pending?.nonce || !message) return;
    const query = {};
    for (const key of ["id", "author", "content", "recipient", "end_turn", "weight"]) {
      if (message[key] !== undefined) query[key] = cloneJson(message[key]);
    }
    verifiedEditQueries.set(pending.nonce, query);
  }

  function correlatedPrepareQuery(payload, pending) {
    const verified = verifiedEditQueries.get(pending?.nonce);
    if (!verified || !payload?.partial_query) return null;
    return {
      ...payload.partial_query,
      ...cloneJson(verified),
    };
  }

  function imageAssetPart(attachment) {
    return {
      content_type: "image_asset_pointer",
      asset_pointer: `file-service://${attachment.id}`,
      size_bytes: attachment.size,
      ...(Number.isFinite(attachment.width) ? { width: attachment.width } : {}),
      ...(Number.isFinite(attachment.height) ? { height: attachment.height } : {}),
    };
  }

  function patchPrepareConversationRequest(payload, pending) {
    if (!payload || !pending?.attachments?.length) return null;
    let query = payload.partial_query;
    if (!query) return null;
    if (!fingerprintMatches(query, pending)) {
      const actual = textFingerprint(messageText(query));
      const correlated = correlatedPrepareQuery(payload, pending);
      trace("edit-prepare-fingerprint-mismatch", {
        expectedLength: Number(pending.textFingerprint?.length || 0),
        actualLength: actual.length,
        partCount: Array.isArray(query?.content?.parts) ? query.content.parts.length : 0,
        objectPartCount: Array.isArray(query?.content?.parts)
          ? query.content.parts.filter((part) => part && typeof part === "object").length
          : 0,
        correlated: Boolean(correlated),
      });
      if (!correlated) return null;
      payload.partial_query = correlated;
      query = correlated;
      trace("edit-prepare-correlated-fallback", {
        attachmentCount: pending.attachments.length,
      });
    }

    const sourceAttachments = pending.attachments;
    const attachments = sourceAttachments.map(normalizedAttachment);
    const textAttachments = attachments.filter((attachment, index) =>
      !isMentionReference(sourceAttachments[index]) && !attachmentMimeType(attachment).toLowerCase().startsWith("image/"),
    );
    if (textAttachments.length) {
      const existing = Array.isArray(payload.attachments) ? payload.attachments : [];
      const merged = [...existing];
      for (const attachment of textAttachments) {
        if (!merged.some((candidate) => candidate?.file_id === attachment.id)) {
          merged.push({ file_id: attachment.id });
        }
      }
      payload.attachments = merged;
    }

    const imageAttachments = attachments.filter((attachment, index) =>
      !isMentionReference(sourceAttachments[index]) && attachmentMimeType(attachment).toLowerCase().startsWith("image/"),
    );
    if (imageAttachments.length) {
      const oldContent = query.content && typeof query.content === "object" ? query.content : {};
      const textParts = preservedTextParts(oldContent.parts);
      const existingAssets = Array.isArray(oldContent.parts)
        ? oldContent.parts.filter((part) => part && typeof part === "object" && part.asset_pointer)
        : [];
      const assets = [...existingAssets];
      for (const attachment of imageAttachments) {
        const pointer = `file-service://${attachment.id}`;
        if (!assets.some((part) => part.asset_pointer === pointer)) assets.push(imageAssetPart(attachment));
      }
      query.content = { ...oldContent, content_type: "multimodal_text", parts: [...assets, ...textParts] };
    }
    return payload;
  }

  function patchEditConversationRequest(payload, pending) {
    if (!payload || !Array.isArray(payload.messages) || !pending?.attachments?.length) return null;
    const message = [...payload.messages].reverse().find((candidate) => candidate?.author?.role === "user");
    if (!message) return null;

    if (!fingerprintMatches(message, pending)) return null;

    const sourceAttachments = pending.attachments;
    const attachments = sourceAttachments.map(normalizedAttachment);
    const existingMetadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
    const existingAttachments = Array.isArray(existingMetadata.attachments) ? existingMetadata.attachments : [];
    const mergedAttachments = [...existingAttachments];
    for (const attachment of attachments) {
      if (!mergedAttachments.some((candidate) => candidate?.id === attachment.id)) mergedAttachments.push(attachment);
    }
    message.metadata = { ...existingMetadata, attachments: mergedAttachments };

    const oldContent = message.content && typeof message.content === "object" ? message.content : {};
    const textParts = preservedTextParts(oldContent.parts);
    const assetParts = attachments
      .filter((attachment, index) =>
        !isMentionReference(sourceAttachments[index]) && attachmentMimeType(attachment).toLowerCase().startsWith("image/"),
      )
      .map(imageAssetPart);
    if (assetParts.length) {
      message.content = { ...oldContent, content_type: "multimodal_text", parts: [...assetParts, ...textParts] };
    } else {
      message.content = { ...oldContent, parts: textParts };
    }
    rememberVerifiedEditQuery(message, pending);
    return payload;
  }

  function rejectPendingSubmit(pending, message) {
    clearPendingEditInjection(pending.nonce);
    const error = new TypeError(message);
    post("bcg:edit-submit-result", { nonce: pending.nonce, ok: false, status: 0, error: error.message });
    throw error;
  }

  function patchPendingPrepareBody(rawBody, pending) {
    if (!rawBody) return null;
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const patched = patchPrepareConversationRequest(payload, pending);
    return patched ? JSON.stringify(patched) : null;
  }

  function patchPendingEditBody(rawBody, pending) {
    if (!rawBody) rejectPendingSubmit(pending, "ChatGPT's edited-message request had no readable JSON body.");

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      rejectPendingSubmit(pending, "ChatGPT's edited-message request was not readable JSON.");
    }
    if (!Array.isArray(payload?.messages)) {
      rejectPendingSubmit(pending, "ChatGPT's edited-message request no longer contains a messages array.");
    }

    const patched = patchEditConversationRequest(payload, pending);
    if (!patched) rejectPendingSubmit(pending, "ChatGPT's edited-message request did not match the active edit composer.");
    return JSON.stringify(patched);
  }

  async function fetchWithEditAttachmentPatch(input, init) {
    const pending = readPendingEditInjection();
    const sameOriginPost = isSameOriginPost(input, init);
    const prepareRequest = sameOriginPost && looksLikeConversationPrepareUrl(input);
    const conversationRequest = sameOriginPost && looksLikeConversationUrl(input);
    let rawBody = "";
    let conversationRawBody = "";
    try {
      if (prepareRequest) {
        rawBody = await requestBodyText(input, init);
        trace("edit-prepare-seen", {
          path: pathOnly(input),
          transport: "fetch",
          pendingSubmit: Boolean(pending),
        });
      }
      if (conversationRequest) {
        conversationRawBody = await requestBodyText(input, init);
        trace("conversation-request-seen", {
          path: pathOnly(input),
          transport: "fetch",
          pendingSubmit: Boolean(pending),
        });
        publishConversationRequest(conversationRawBody);
      }
    } catch (error) {
      if (!pending) {
        trace("request-body-observation-failed-open", {
          path: pathOnly(input),
          transport: "fetch",
          reason: String(error?.name || "Error").slice(0, 80),
        });
        return fetchWithNativeStageObservation(input, init);
      }
      throw error;
    }
    if (conversationRequest && conversationRawBody) {
      const safeToSend = await guardConversationTail(conversationRawBody);
      if (!safeToSend) {
        throw new target.DOMException("Better ChatGPT blocked a stale conversation send while refreshing the chat.", "AbortError");
      }
    }
    if (!pending || (!prepareRequest && !conversationRequest)) {
      return fetchWithNativeStageObservation(input, init);
    }

    if (prepareRequest) {
      const body = patchPendingPrepareBody(rawBody, pending);
      if (!body) {
        trace("edit-prepare-ignored", {
          path: pathOnly(input),
          transport: "fetch",
          reason: "not-active-edit",
        });
        return fetchWithNativeStageObservation(input, init);
      }
      trace("edit-prepare-patched", {
        path: pathOnly(input),
        transport: "fetch",
        attachmentCount: pending.attachments.length,
      });
      const response = input instanceof target.Request
        ? await nativeFetch(new target.Request(input, { ...(init || {}), body }))
        : await nativeFetch(input, { ...(init || {}), body });
      const token = await tokenFromPrepareResponse(response);
      if (token) recordPreparedToken(pending.nonce, token);
      return response;
    }

    const body = patchPendingEditBody(conversationRawBody || await requestBodyText(input, init), pending);
    const conduitToken = preparedTokenFor(pending);
    const headers = mergedHeaders(input, init);
    if (conduitToken) headers.set("x-conduit-token", conduitToken);
    trace("edit-submit-dispatched-immediately", {
      path: pathOnly(input),
      transport: "fetch",
      preparedToken: Boolean(conduitToken),
    });

    trace("edit-submit-patched", {
      path: pathOnly(input),
      transport: "fetch",
      attachmentCount: pending.attachments.length,
    });
    let response;
    try {
      if (input instanceof target.Request) {
        response = await nativeFetch(new target.Request(input, { ...(init || {}), headers, body }));
      } else {
        response = await nativeFetch(input, { ...(init || {}), headers, body });
      }
      void observePatchedFetchResponse(response, pending, input);
      return response;
    } catch (error) {
      if (retryableSubmitFailure(error)) {
        preparedTokens.delete(pending.nonce);
        trace("edit-submit-retry-pending", {
          path: pathOnly(input),
          transport: "fetch",
          reason: String(error?.name || "abort").slice(0, 80),
        });
        throw error;
      }
      clearPendingEditInjection(pending.nonce);
      post("bcg:edit-submit-result", {
        nonce: pending.nonce,
        ok: false,
        status: 0,
        error: String(error?.message || error || "Edit submission failed").slice(0, 240),
      });
      throw error;
    }
  }

  target.fetch = fetchWithEditAttachmentPatch;
  installXhrObservation();

  target.addEventListener("message", (event) => {
    if (event.source !== target || event.data?.source !== CONTENT_SOURCE) return;
    const { type, requestId } = event.data;
    if (type === "bcg:bridge-ping") {
      post("bcg:bridge-ready", { requestId });
      return;
    }
    if (type === "bcg:attachment-metadata-lookup") {
      const fileId = String(event.data.fileId || "");
      post("bcg:attachment-metadata-result", {
        requestId,
        attachment: attachmentMetadataById.get(fileId) || null,
      });
      return;
    }
    if (type === "bcg:native-stage-start") {
      const file = event.data.file;
      if (!requestId || !file || !file.name || !Number.isFinite(Number(file.size))) {
        post("bcg:native-stage-result", { requestId, ok: false, error: "Invalid native staging request." });
        return;
      }
      nativeStages.set(requestId, {
        requestId,
        file: {
          name: String(file.name),
          size: Number(file.size),
          type: String(file.type || "application/octet-stream"),
          lastModified: Number(file.lastModified || 0),
          ...(Number.isFinite(Number(file.width)) ? { width: Number(file.width) } : {}),
          ...(Number.isFinite(Number(file.height)) ? { height: Number(file.height) } : {}),
        },
        startedAt: Date.now(),
        fileId: "",
        useCase: "",
        observedRequests: 0,
      });
      trace("stage-registered", { activeStages: activeStageCount() });
      target.setTimeout(() => {
        const stage = nativeStages.get(requestId);
        if (stage && !stage.fileId) {
          trace("stage-no-network", { activeStages: activeStageCount(), elapsedMs: Date.now() - stage.startedAt });
        }
      }, 5000);
      post("bcg:native-stage-ready", { requestId });
      return;
    }
    if (type === "bcg:native-stage-cancel") {
      const stage = nativeStages.get(requestId);
      nativeStages.delete(requestId);
      if (stage?.fileId) stageByFileId.delete(stage.fileId);
    }
  });

  publishNativeUploadCount();
  post("bcg:bridge-ready");
  trace("bridge-installed", { hasXhr: Boolean(xhrPrototype), fetchWrapped: target.fetch === fetchWithEditAttachmentPatch });
})();
