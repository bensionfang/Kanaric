(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/popup.js
  var require_popup = __commonJS({
    "src/popup.js"(exports, module) {
      function formatConnectionStatus(state, error = "") {
        const labels = {
          connecting: "\u9023\u63A5\u4E2D",
          connected: "\u5DF2\u9023\u63A5",
          disconnected: "App \u672A\u555F\u52D5",
          error: "App \u672A\u555F\u52D5"
        };
        const label = labels[state] || state || "App \u672A\u555F\u52D5";
        return error ? `${label}: ${error}` : label;
      }
      function initPopup() {
        const connectButton = document.getElementById("connect");
        const statusText = document.getElementById("status");
        const setStatus = (state, error = "") => {
          statusText.textContent = formatConnectionStatus(state, error);
        };
        chrome.storage.local.get(["connectionState", "connectionError"]).then((stored) => {
          if (stored.connectionState) setStatus(stored.connectionState, stored.connectionError || "");
        });
        chrome.storage.onChanged.addListener((changes) => {
          if (changes.connectionState) setStatus(changes.connectionState.newValue, changes.connectionError?.newValue || "");
        });
        connectButton.addEventListener("click", async () => {
          connectButton.disabled = true;
          setStatus("connecting");
          try {
            const result = await chrome.runtime.sendMessage({ type: "connect_karaoke_app" });
            if (!result?.ok) setStatus("error", result?.error || "connection failed");
          } catch (error) {
            setStatus("error", error.message);
          } finally {
            connectButton.disabled = false;
          }
        });
      }
      if (typeof document !== "undefined" && typeof chrome !== "undefined") initPopup();
      if (typeof module !== "undefined") module.exports = { formatConnectionStatus, initPopup };
    }
  });
  require_popup();
})();
