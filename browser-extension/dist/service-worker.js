(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/service-worker.js
  var require_service_worker = __commonJS({
    "src/service-worker.js"(exports, module) {
      var PAIRING_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})#([A-Za-z0-9_-]+)$/;
      var TOKEN_RE = /^[A-Za-z0-9_-]+$/;
      var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
      function parsePairingString(value) {
        if (typeof value !== "string") return null;
        const match = PAIRING_RE.exec(value);
        if (!match) return null;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !TOKEN_RE.test(match[2])) return null;
        const baseUrl = `http://127.0.0.1:${port}`;
        return { baseUrl, token: match[2], wsUrl: `ws://127.0.0.1:${port}` };
      }
      function buildYouTubeWatchUrl(videoId, positionMs = 0) {
        if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId) || !isSafeNonNegativeInteger(positionMs)) return null;
        return `https://www.youtube.com/watch?v=${videoId}&t=${positionMs / 1e3}s`;
      }
      function isSafeNonNegativeInteger(value) {
        return Number.isSafeInteger(value) && value >= 0;
      }
      function normalizeSocketCommand(message) {
        if (!message || message.type !== "youtube_karaoke_command" || !message.command) return null;
        const raw = message.command;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const allowed = /* @__PURE__ */ new Set(["commandId", "revision", "action", "videoId", "positionMs", "seconds", "semitones"]);
        if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
        if (raw.commandId !== void 0 && !isSafeNonNegativeInteger(raw.commandId)) return null;
        if (raw.revision !== void 0 && !isSafeNonNegativeInteger(raw.revision)) return null;
        if (!["load", "play", "pause", "seek", "set_key"].includes(raw.action)) return null;
        const command = {};
        if (raw.commandId !== void 0) command.commandId = raw.commandId;
        if (raw.revision !== void 0) command.revision = raw.revision;
        command.action = raw.action;
        if (raw.action === "load") {
          if (typeof raw.videoId !== "string" || !VIDEO_ID_RE.test(raw.videoId)) return null;
          command.videoId = raw.videoId;
          command.positionMs = raw.positionMs === void 0 ? 0 : raw.positionMs;
          if (!isSafeNonNegativeInteger(command.positionMs)) return null;
        } else if (raw.action === "seek") {
          if (raw.positionMs !== void 0) {
            if (!isSafeNonNegativeInteger(raw.positionMs)) return null;
            command.positionMs = raw.positionMs;
          } else {
            if (!Number.isFinite(raw.seconds) || raw.seconds < 0) return null;
            command.positionMs = Math.round(raw.seconds * 1e3);
            if (!isSafeNonNegativeInteger(command.positionMs)) return null;
          }
        } else if (raw.action === "set_key") {
          if (!Number.isSafeInteger(raw.semitones) || raw.semitones < -6 || raw.semitones > 6) return null;
          command.semitones = raw.semitones;
        } else if (Object.keys(raw).some((key) => !["commandId", "revision", "action"].includes(key))) {
          return null;
        }
        return command;
      }
      function createRevisionTracker() {
        let revision = 0;
        return {
          current: () => revision,
          apply(command) {
            if (!command || command.action !== "load") return revision;
            revision += 1;
            return revision;
          }
        };
      }
      var socket = null;
      var youtubeTabId = null;
      var pendingLoad = null;
      var revisionTracker = createRevisionTracker();
      function hasChromeRuntime() {
        return typeof chrome !== "undefined" && chrome.runtime && chrome.tabs && chrome.storage;
      }
      async function getPairing() {
        const stored = await chrome.storage.local.get(["baseUrl", "token"]);
        if (typeof stored.baseUrl !== "string" || typeof stored.token !== "string") return null;
        return parsePairingString(`${stored.baseUrl}#${stored.token}`);
      }
      function sendToTab(message) {
        if (youtubeTabId !== null) chrome.tabs.sendMessage(youtubeTabId, message).catch(() => {
        });
      }
      function setConnectionState(state, error = "") {
        if (!hasChromeRuntime()) return;
        chrome.storage.local.set({ connectionState: state, connectionError: error }).catch(() => {
        });
      }
      function waitForSocketOpen(candidate) {
        if (candidate.readyState === 1) return Promise.resolve(candidate);
        return new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => finish(new Error("WebSocket connection timed out")), 8e3);
          const cleanup = () => {
            clearTimeout(timer);
            candidate.removeEventListener("open", onOpen);
            candidate.removeEventListener("error", onError);
            candidate.removeEventListener("close", onClose);
          };
          const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(candidate);
          };
          const onOpen = () => finish();
          const onError = () => finish(new Error("WebSocket connection failed"));
          const onClose = () => finish(new Error("WebSocket closed before open"));
          candidate.addEventListener("open", onOpen);
          candidate.addEventListener("error", onError);
          candidate.addEventListener("close", onClose);
        });
      }
      async function connectSocket(pairing) {
        if (socket && socket.readyState === 1) return socket;
        if (socket && socket.readyState === 0) return waitForSocketOpen(socket);
        setConnectionState("connecting");
        socket = new WebSocket(pairing.wsUrl, ["kanaric-youtube-v1", pairing.token]);
        const candidate = socket;
        candidate.addEventListener("open", () => setConnectionState("connected"));
        socket.addEventListener("message", (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type !== "youtube_karaoke_command") return;
          const command = normalizeSocketCommand(message);
          if (!command) return;
          if (command.action === "load") {
            revisionTracker.apply(command);
            pendingLoad = { ...command, revision: revisionTracker.current() };
            if (youtubeTabId !== null) {
              const url = buildYouTubeWatchUrl(command.videoId, command.positionMs);
              chrome.tabs.update(youtubeTabId, { url, active: true }).catch(() => {
              });
            }
            return;
          }
          sendToTab({ ...command, revision: revisionTracker.current() });
        });
        candidate.addEventListener("error", () => setConnectionState("error", "WebSocket connection failed"));
        candidate.addEventListener("close", () => {
          if (socket === candidate) socket = null;
          setConnectionState("disconnected");
        });
        try {
          return await waitForSocketOpen(candidate);
        } catch (error) {
          if (socket === candidate) socket = null;
          setConnectionState("error", error.message);
          throw error;
        }
      }
      async function ensureYouTubeTab(api = chrome) {
        const stored = await api.storage.local.get(["youtubeTabId"]);
        if (Number.isInteger(stored.youtubeTabId)) {
          try {
            const tab2 = await api.tabs.get(stored.youtubeTabId);
            youtubeTabId = tab2.id;
            await api.tabs.update(tab2.id, { active: true });
            return tab2;
          } catch {
          }
        }
        const tab = await api.tabs.create({ url: "https://www.youtube.com/watch", active: true });
        youtubeTabId = tab.id;
        await api.storage.local.set({ youtubeTabId: tab.id });
        return tab;
      }
      async function startKaraoke() {
        const pairing = await getPairing();
        if (!pairing) throw new Error("invalid pairing");
        await ensureYouTubeTab();
        connectSocket(pairing);
      }
      if (hasChromeRuntime()) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message?.type === "start_karaoke") {
            startKaraoke().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
          }
          if (message?.type === "youtube_karaoke_state" && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
          }
          return void 0;
        });
        chrome.tabs.onRemoved.addListener((tabId) => {
          if (tabId === youtubeTabId) {
            youtubeTabId = null;
            pendingLoad = null;
            chrome.storage.local.remove("youtubeTabId").catch(() => {
            });
          }
        });
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
          if (tabId === youtubeTabId && changeInfo.status === "complete" && pendingLoad) {
            const command = pendingLoad;
            pendingLoad = null;
            sendToTab(command);
          }
        });
      }
      if (typeof module !== "undefined") module.exports = {
        parsePairingString,
        normalizeSocketCommand,
        createRevisionTracker,
        buildYouTubeWatchUrl,
        ensureYouTubeTab
      };
    }
  });
  require_service_worker();
})();
