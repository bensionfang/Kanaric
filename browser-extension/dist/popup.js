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
        return error ? `${state}: ${error}` : state;
      }
      function initPopup() {
        const baseUrlInput = document.getElementById("baseUrl");
        const tokenInput = document.getElementById("token");
        const connectButton = document.getElementById("connect");
        const statusText = document.getElementById("status");
        const setStatus = (state, error = "") => {
          statusText.textContent = formatConnectionStatus(state, error);
        };
        chrome.storage.local.get(["baseUrl", "token", "connectionState", "connectionError"]).then((stored) => {
          if (stored.baseUrl) baseUrlInput.value = stored.baseUrl;
          if (stored.token) tokenInput.value = stored.token;
          if (stored.connectionState) setStatus(stored.connectionState, stored.connectionError || "");
        });
        chrome.storage.onChanged.addListener((changes) => {
          if (changes.connectionState) setStatus(changes.connectionState.newValue, changes.connectionError?.newValue || "");
        });
        connectButton.addEventListener("click", async () => {
          const baseUrl = baseUrlInput.value.trim();
          const token = tokenInput.value.trim();
          if (!baseUrl || !token) {
            setStatus("error", "\u8ACB\u8F38\u5165\u672C\u6A5F\u7DB2\u5740\u8207 Token");
            return;
          }
          connectButton.disabled = true;
          setStatus("connecting");
          try {
            await chrome.storage.local.set({ baseUrl, token });
            const result = await chrome.runtime.sendMessage({ type: "start_karaoke" });
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
