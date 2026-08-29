(() => {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;
  const status = document.getElementById("status");
  const note = document.getElementById("note");
  const buttons = Array.from(document.querySelectorAll("button"));
  const version = document.getElementById("version");
  const manifestVersion = api.runtime?.getManifest?.().version;
  version.textContent = manifestVersion ? `v${manifestVersion}` : "";

  let activeTab = null;
  let snapshot = null;

  function setEnabled(enabled) {
    buttons.forEach((button) => {
      button.disabled = !enabled;
    });
  }

  function render() {
    if (!snapshot) {
      status.textContent = "Better ChatGPT is not available on this tab.";
      note.textContent = "Open chatgpt.com, then reopen this popup.";
      setEnabled(false);
      return;
    }
    setEnabled(true);
    const state = snapshot.enabled ? "Enabled" : "Disabled";
    status.textContent = `${state} · ${snapshot.profile} profile · scroll: ${snapshot.scrollStrategy} · stale guard: ${snapshot.crossDeviceGuard ? "on" : "off"}`;
    document.getElementById("toggle").textContent = snapshot.enabled ? "Disable" : "Enable";
    document.getElementById("tab").textContent = snapshot.tabDisabled ? "Enable on this tab" : "Disable on this tab";
    note.textContent = snapshot.errors ? `${snapshot.errors} diagnostic error(s) recorded.` : "No diagnostic errors recorded.";
  }

  async function send(type) {
    if (!activeTab?.id) throw new Error("No active tab.");
    return api.tabs.sendMessage(activeTab.id, { type });
  }

  async function refresh() {
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      activeTab = tab;
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(tab?.url || "")) throw new Error("Not ChatGPT.");
      const response = await send("bcg:get-status");
      snapshot = response?.ok && response.status ? response.status : null;
    } catch {
      snapshot = null;
    }
    render();
  }

  document.getElementById("toggle").addEventListener("click", async () => {
    await send("bcg:toggle-enabled");
    await refresh();
  });
  document.getElementById("settings").addEventListener("click", async () => {
    await send("bcg:open-settings");
    window.close();
  });
  document.getElementById("tab").addEventListener("click", async () => {
    await send("bcg:toggle-tab");
    window.close();
  });
  document.getElementById("reload").addEventListener("click", async () => {
    await send("bcg:reload");
    window.close();
  });
  document.getElementById("diagnostics").addEventListener("click", async () => {
    try {
      const response = await send("bcg:diagnostics");
      if (!response?.ok) throw new Error("Diagnostic request failed.");
      await navigator.clipboard.writeText(JSON.stringify(response.report, null, 2));
      note.textContent = "Diagnostics copied.";
    } catch (error) {
      note.textContent = error.message;
    }
  });

  refresh();
})();
