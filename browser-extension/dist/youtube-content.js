(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/youtube-content.js
  var require_youtube_content = __commonJS({
    "src/youtube-content.js"(exports, module) {
      var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
      function getVideoId(url = typeof location !== "undefined" ? location.href : "") {
        try {
          const value = new URL(url).searchParams.get("v");
          return typeof value === "string" && VIDEO_ID_RE.test(value) ? value : "";
        } catch {
          return "";
        }
      }
      function stateName(input) {
        if (input.blockedCode) return "error";
        if (input.isAd) return "ad";
        if (input.isLoading || input.playerState === -1) return "loading";
        if (input.isBuffering || input.playerState === 3) return "buffering";
        if (input.playerState === 1) return "playing";
        if (input.playerState === 2) return "paused";
        if (input.playerState === 3) return "buffering";
        if (input.playerState === 0 && Number.isFinite(input.duration) && input.duration > 0) return "ended";
        return "idle";
      }
      function classifyYouTubeBlock(text, hasErrorElement) {
        const bodyText = typeof text === "string" ? text : "";
        if (/sign in to confirm your age/i.test(bodyText)) return { code: "youtube-sign-in-required", message: "Sign in to confirm your age" };
        if (/age-restricted|confirm your age/i.test(bodyText)) return { code: "youtube-age-restricted", message: "YouTube age restriction" };
        if (hasErrorElement) return { code: "youtube-video-unavailable", message: "YouTube video unavailable" };
        return null;
      }
      function projectYouTubeState(input) {
        const currentTime = Number.isFinite(input?.currentTime) && input.currentTime >= 0 ? input.currentTime : 0;
        const duration = Number.isFinite(input?.duration) && input.duration >= 0 ? input.duration : 0;
        const blockedCode = typeof input?.blockedCode === "string" && input.blockedCode ? input.blockedCode : null;
        return {
          type: "youtube_karaoke_state",
          state: {
            revision: Number.isSafeInteger(input?.revision) && input.revision >= 0 ? input.revision : 0,
            videoId: VIDEO_ID_RE.test(input?.videoId || "") ? input.videoId : "",
            title: typeof input?.title === "string" ? input.title.slice(0, 200) : "",
            channel: typeof input?.channel === "string" ? input.channel.slice(0, 200) : typeof input?.channelTitle === "string" ? input.channelTitle.slice(0, 200) : "",
            state: stateName(input || {}),
            positionMs: Math.min(Number.MAX_SAFE_INTEGER, Math.round(currentTime * 1e3)),
            durationMs: Math.min(Number.MAX_SAFE_INTEGER, Math.round(duration * 1e3)),
            keySemitones: Number.isSafeInteger(input?.keySemitones) && input.keySemitones >= -6 && input.keySemitones <= 6 ? input.keySemitones : 0,
            error: blockedCode ? { code: blockedCode.slice(0, 100), message: String(input.blockedMessage || blockedCode).slice(0, 500) } : null
          }
        };
      }
      function createStateReporter(send) {
        let last = null;
        const endedRevisions = /* @__PURE__ */ new Set();
        return {
          report(message) {
            if (!message?.state) return false;
            const next = message.state;
            const previous = last?.state;
            if (next.state === "ended" && endedRevisions.has(next.revision)) return false;
            const sameTrack = previous && previous.revision === next.revision && previous.videoId === next.videoId && previous.state === next.state && previous.keySemitones === next.keySemitones && JSON.stringify(previous.error) === JSON.stringify(next.error);
            if (sameTrack && Math.abs(previous.positionMs - next.positionMs) < 200) return false;
            if (next.state === "ended") endedRevisions.add(next.revision);
            last = message;
            send(message);
            return true;
          }
        };
      }
      function readYouTubeInput(video, revision, keySemitones = 0) {
        const title = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, "");
        const channel = document.querySelector("ytd-channel-name yt-formatted-string")?.textContent?.trim() || "";
        const blocked = classifyYouTubeBlock(
          document.body?.innerText || "",
          !!document.querySelector("[is-age-restricted], .age-gate, .ytp-error, ytd-player-error-message-renderer")
        );
        const isLoading = !video || video.readyState === 0;
        const isBuffering = !!video && !video.paused && !video.ended && video.readyState > 0 && video.readyState < 3;
        return {
          revision,
          videoId: getVideoId(),
          title,
          channel,
          currentTime: video?.currentTime || 0,
          duration: Number.isFinite(video?.duration) ? video.duration : 0,
          playerState: !video ? -1 : video.ended ? 0 : isBuffering ? 3 : video.paused ? 2 : 1,
          isAd: !!document.querySelector(".ad-showing, video.ad-video"),
          blockedCode: blocked?.code || null,
          blockedMessage: blocked?.message || null,
          isLoading,
          isBuffering,
          keySemitones
        };
      }
      function startYouTubeContentRuntime() {
        if (typeof chrome === "undefined" || !chrome.runtime || typeof document === "undefined") return null;
        let revision = 0;
        let keySemitones = 0;
        let pendingSeekMs = null;
        const reporter = createStateReporter((message) => chrome.runtime.sendMessage(message));
        const read = () => document.querySelector("video");
        const report = () => {
          const video = read();
          if (pendingSeekMs !== null && video && video.readyState >= 1) {
            video.currentTime = pendingSeekMs / 1e3;
            pendingSeekMs = null;
          }
          reporter.report(projectYouTubeState(readYouTubeInput(video, revision, keySemitones)));
        };
        const timer = setInterval(report, 250);
        document.addEventListener("ended", report, true);
        chrome.runtime.onMessage.addListener((command) => {
          if (!command || !["load", "play", "pause", "seek"].includes(command.action)) return;
          if (command.action === "load") {
            revision = Number.isSafeInteger(command.revision) ? command.revision : revision + 1;
            pendingSeekMs = Number.isSafeInteger(command.positionMs) ? command.positionMs : 0;
          }
          const video = read();
          if (!video) return;
          if (command.action === "play") video.play().catch(() => {
          });
          if (command.action === "pause") video.pause();
          if (command.action === "seek" && Number.isSafeInteger(command.positionMs)) video.currentTime = command.positionMs / 1e3;
          report();
        });
        report();
        return { stop: () => clearInterval(timer) };
      }
      if (typeof document !== "undefined" && typeof chrome !== "undefined") startYouTubeContentRuntime();
      if (typeof module !== "undefined") module.exports = { projectYouTubeState, createStateReporter, classifyYouTubeBlock, getVideoId, startYouTubeContentRuntime };
    }
  });
  require_youtube_content();
})();
