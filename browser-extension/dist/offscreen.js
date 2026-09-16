(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/offscreen.js
  var require_offscreen = __commonJS({
    "src/offscreen.js"(exports, module) {
      var KEY_MIN = -6;
      var KEY_MAX = 6;
      var TEMPO = 1;
      var PROCESSOR_URL = "vendor/soundtouch-processor.js";
      function normalizeKey(value) {
        return Number.isSafeInteger(value) && value >= KEY_MIN && value <= KEY_MAX ? value : null;
      }
      function setKeySemitones(value) {
        return Number.isSafeInteger(value) ? Math.max(KEY_MIN, Math.min(KEY_MAX, value)) : null;
      }
      function unavailable(error) {
        return {
          ok: false,
          status: "bypass",
          keySemitones: 0,
          tempo: TEMPO,
          bypassed: true,
          error: { code: "pitch-processing-unavailable", message: error?.message || "AudioWorklet unavailable" }
        };
      }
      function createTabAudioGraph({
        streamId,
        mediaDevices = globalThis.navigator?.mediaDevices,
        AudioContextClass = globalThis.AudioContext,
        SoundTouchNodeClass = globalThis.SoundTouchLib?.SoundTouchNode,
        processorUrl = PROCESSOR_URL
      } = {}) {
        return (async () => {
          if (!streamId || !mediaDevices?.getUserMedia || !AudioContextClass) throw new Error("tab-capture-unavailable");
          const context = new AudioContextClass();
          let stream;
          try {
            stream = await mediaDevices.getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: "tab",
                  chromeMediaSourceId: streamId
                }
              }
            });
          } catch (error) {
            context.close?.();
            throw error;
          }
          const source = context.createMediaStreamSource(stream);
          const gain = context.createGain();
          gain.connect(context.destination);
          try {
            if (!SoundTouchNodeClass?.register) throw new Error("AudioWorklet unavailable");
            await SoundTouchNodeClass.register(context, processorUrl);
            const node = new SoundTouchNodeClass({ context });
            let disposed = false;
            source.connect(node);
            node.connect(gain);
            node.pitch.value = 1;
            node.pitchSemitones.value = 0;
            node.playbackRate.value = TEMPO;
            await context.resume?.();
            return {
              status: "ready",
              ok: true,
              keySemitones: 0,
              tempo: TEMPO,
              context,
              stream,
              source,
              node,
              gain,
              setKeySemitones(value) {
                const next = setKeySemitones(value);
                if (next === null) return { ok: false, error: "invalid-key" };
                node.pitchSemitones.value = next;
                return { ok: true, semitones: next, tempo: node.playbackRate?.value ?? TEMPO };
              },
              setKey(semitones) {
                return this.setKeySemitones(semitones);
              },
              dispose() {
                if (disposed) return;
                disposed = true;
                source.disconnect?.();
                node.disconnect?.();
                gain.disconnect?.();
                stream.getTracks?.().forEach((track) => track.stop?.());
                context.close?.();
              }
            };
          } catch (error) {
            source.disconnect?.();
            source.connect(gain);
            let disposed = false;
            return {
              ...unavailable(error),
              context,
              stream,
              source,
              gain,
              setKeySemitones: () => ({ ok: false, error: "pitch-processing-unavailable", status: "bypass", bypassed: true }),
              setKey(semitones) {
                return this.setKeySemitones(semitones);
              },
              dispose() {
                if (disposed) return;
                disposed = true;
                source.disconnect?.();
                gain.disconnect?.();
                stream.getTracks?.().forEach((track) => track.stop?.());
                context.close?.();
              }
            };
          }
        })();
      }
      function createOffscreenController({ createGraph = createTabAudioGraph } = {}) {
        let graph = null;
        let graphCreation = null;
        const graphResponse = () => ({
          ok: graph.status === "ready",
          status: graph.status,
          keySemitones: graph.keySemitones || 0,
          tempo: graph.tempo || TEMPO,
          ...graph.error ? { error: graph.error } : {},
          ...graph.bypassed ? { bypassed: true } : {}
        });
        return {
          async handle(message) {
            if (message?.type === "pitch_dispose") {
              if (graphCreation) await graphCreation.catch(() => {
              });
              graph?.dispose?.();
              graph = null;
              return { ok: true, status: "disposed" };
            }
            if (message?.type === "capture_tab") {
              if (!graph) {
                if (!graphCreation) {
                  graphCreation = Promise.resolve().then(() => createGraph({ streamId: message.streamId })).then((created) => {
                    graph = created;
                    return created;
                  }).finally(() => {
                    graphCreation = null;
                  });
                }
                try {
                  await graphCreation;
                } catch (error) {
                  graph = {
                    ...unavailable(error),
                    error: { code: "tab-capture-unavailable", message: error?.message || "Tab capture unavailable" }
                  };
                }
              }
              return graphResponse();
            }
            if (message?.type === "set_key") {
              const semitones = normalizeKey(message.semitones);
              if (semitones === null) return { ok: false, error: "invalid-key" };
              if (!graph) return { ok: false, status: "bypass", error: "pitch-processing-unavailable", bypassed: true };
              return graph.setKeySemitones ? graph.setKeySemitones(semitones) : graph.setKey(semitones);
            }
            return { ok: false, error: "unsupported-message" };
          }
        };
      }
      var offscreenController = createOffscreenController();
      if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (!["capture_tab", "set_key", "pitch_dispose"].includes(message?.type)) return false;
          offscreenController.handle(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || "pitch-processing-unavailable" }));
          return true;
        });
      }
      if (typeof module !== "undefined") module.exports = {
        createTabAudioGraph,
        createOffscreenController,
        setKeySemitones,
        normalizeKey
      };
    }
  });
  require_offscreen();
})();
