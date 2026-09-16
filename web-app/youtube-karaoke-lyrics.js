const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_TIMEOUT_MS = 20000;
const { parseLrc } = require('./public/js/lrc-parse');
const { normalizeKaraokeLyrics } = require('./youtube-karaoke-protocol');

function buildYouTubeLyricsPayload(videoId, injected) {
  if (!VIDEO_ID_RE.test(videoId || '') || typeof injected !== 'string') return null;
  const parsed = parseLrc(injected);
  if (parsed.unsynced) return null;
  return normalizeKaraokeLyrics({
    videoId,
    offsetMs: 0,
    lines: parsed.lines.map((line) => ({
      timeMs: Math.max(0, Math.round(line.time * 1000)),
      text: line.text,
      words: Array.isArray(line.words) && line.words.length >= 2 ? line.words : null,
    })),
  });
}

function shouldKeepYouTubeLyrics(currentLyrics, message, currentRevision = null) {
  return !!currentLyrics && currentLyrics.videoId === message?.videoId
    && (currentRevision === null || currentLyrics.revision === undefined || currentLyrics.revision === currentRevision)
    && message.status !== 'loaded';
}

function resolveYouTubeLyricsStatus(currentLyrics, message, currentRevision = null) {
  return shouldKeepYouTubeLyrics(currentLyrics, message, currentRevision)
    ? 'loaded' : (message?.status || 'no_lyrics');
}

function createYouTubeLyricsCoordinator({ search, publish, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof search !== 'function' || typeof publish !== 'function') throw new TypeError('search and publish are required');
  const jobs = new Map();
  const shared = new Map();
  const prefetchJobs = new Map();
  let runId = 0;
  let active = null;

  function identityFor(state) {
    if (!state || !VIDEO_ID_RE.test(state.videoId || '')) return null;
    const title = typeof state.title === 'string' ? state.title.trim() : '';
    const channel = typeof state.channel === 'string' ? state.channel.trim() : '';
    if (!title || title.length > 200 || !channel || channel.length > 200) return null;
    return `${state.videoId}\u0000${title}\u0000${channel}`;
  }

  function safeError(error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(error.code)
      ? error.code : 'lyrics-search-failed';
    const message = typeof error?.message === 'string' && error.message.length <= 500
      ? error.message : 'lyrics search failed';
    return { code, message };
  }

  function normalizeSearchResult(result, videoId) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { videoId, status: 'no_lyrics' };
    }
    if (result.status === 'loaded' && result.lyrics) {
      if (result.lyrics.videoId && result.lyrics.videoId !== videoId) {
        return { videoId, status: 'error', error: { code: 'lyrics-video-mismatch', message: 'lyrics video mismatch' } };
      }
      return { videoId, status: 'loaded', lyrics: result.lyrics };
    }
    if (result.status === 'error') return { videoId, status: 'error', error: safeError(result.error) };
    if (result.status === 'no_lyrics') return { videoId, status: 'no_lyrics' };
    return { videoId, status: 'no_lyrics' };
  }

  function searchOnce(state, { force = false, preferExisting = true, allowCompleted = false, kind = 'canonical' } = {}) {
    const identity = identityFor(state);
    if (!identity) return Promise.resolve({ videoId: state?.videoId || '', status: 'error', error: {
      code: 'invalid-prefetch-request', message: 'invalid lyrics request',
    } });
    const previous = shared.get(identity);
    if (previous?.status === 'searching' && preferExisting) return previous.promise;
    if (previous?.status === 'completed' && !force && allowCompleted) return Promise.resolve(previous.result);

    const entry = { identity, state: { ...state, title: state.title.trim(), channel: state.channel.trim() },
      force, kind, status: 'searching', result: null, promise: null };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('lyrics search timed out');
        error.code = 'lyrics-search-timeout';
        reject(error);
      }, timeoutMs);
    });
    const complete = (result) => {
      clearTimeout(timer);
      entry.status = 'completed';
      entry.result = result;
      if (result.status !== 'loaded' && shared.get(identity) === entry) shared.delete(identity);
      return result;
    };
    let searchResult;
    try {
      searchResult = search(entry.state, { force });
    } catch (error) {
      searchResult = Promise.reject(error);
    }
    entry.promise = Promise.race([
      searchResult,
      timeout,
    ]).then(
      (result) => complete(normalizeSearchResult(result, entry.state.videoId)),
      (error) => complete({ videoId: entry.state.videoId, status: 'error', error: safeError(error) }),
    );
    shared.set(identity, entry);
    return entry.promise;
  }

  function publicPrefetchResult(state, result) {
    const status = ['loaded', 'no_lyrics', 'error'].includes(result?.status) ? result.status : 'error';
    const output = { videoId: state.videoId, status };
    if (status === 'error') output.error = { code: safeError(result?.error).code };
    return output;
  }

  function request(state, { force = false } = {}) {
    const identity = identityFor(state);
    if (!identity) return false;
    const revision = Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : null;
    const previous = jobs.get(state.videoId);
    const previousShared = shared.get(identity);
    if (previous?.status === 'searching') {
      const sameRevision = active?.videoId === state.videoId && active.revision === revision;
      const sameMetadata = sameRevision
        && active.title === state.title && active.channel === state.channel;
      if (sameRevision && sameMetadata && previousShared?.status === 'searching') return false;
    }
    const sameCompletedLookup = previous && previous.revision === revision
      && previous.title === state.title && previous.channel === state.channel
      && (previous.status !== 'searching' || previousShared?.status === 'completed');
    if (!force && sameCompletedLookup) {
      const result = previous.result || previousShared?.result;
      if (result && active?.videoId !== state.videoId) {
        active = { videoId: state.videoId, revision, runId: previous.runId };
        publish({ ...result, videoId: state.videoId });
      }
      return false;
    }

    const current = { videoId: state.videoId, revision, runId: ++runId, title: state.title, channel: state.channel };
    active = current;
    jobs.set(current.videoId, {
      status: 'searching', revision, runId: current.runId,
      title: current.title, channel: current.channel,
    });
    publish({ videoId: current.videoId, status: 'searching' });
    const shareInFlight = previousShared?.status === 'searching'
      && previousShared.kind === 'prefetch' && !force;
    const reusePrefetch = previousShared?.status === 'completed'
      && previousShared.kind === 'prefetch' && previousShared.result?.status === 'loaded' && !force;
    const resultPromise = searchOnce(state, {
      force,
      preferExisting: shareInFlight,
      allowCompleted: reusePrefetch,
      kind: 'canonical',
    });
    resultPromise
      .then((result) => {
        if (active?.runId !== current.runId) {
          if (jobs.get(current.videoId)?.runId === current.runId) jobs.delete(current.videoId);
          return;
        }
        const message = { videoId: current.videoId, ...result };
        jobs.set(current.videoId, {
          status: message.status || 'no_lyrics', revision, runId: current.runId,
          title: current.title, channel: current.channel, result: message,
        });
        publish(message);
      })
      .catch((error) => {
        if (active?.runId !== current.runId) return;
        jobs.set(current.videoId, {
          status: 'error', revision, runId: current.runId,
          title: current.title, channel: current.channel,
        });
        publish({
          videoId: current.videoId,
          status: 'error',
          error: safeError(error),
        });
      });
    return true;
  }

  function prefetch(state) {
    const identity = identityFor(state);
    if (!identity) return null;
    const previous = prefetchJobs.get(identity);
    if (previous) return previous.promise;
    const entry = { videoId: state.videoId, identity, status: 'searching', promise: null };
    const resultPromise = searchOnce({ ...state, title: state.title.trim(), channel: state.channel.trim() }, {
      force: false, preferExisting: true, allowCompleted: true, kind: 'prefetch',
    });
    entry.promise = resultPromise.then((result) => {
      entry.status = result.status;
      if (result.status !== 'loaded' && prefetchJobs.get(identity) === entry) prefetchJobs.delete(identity);
      return publicPrefetchResult(state, result);
    });
    prefetchJobs.set(identity, entry);
    return entry.promise;
  }

  function prefetchStatus(state) {
    const identity = identityFor(state);
    const entry = identity && prefetchJobs.get(identity);
    if (!entry) return null;
    return { videoId: entry.videoId, status: entry.status };
  }

  return {
    request,
    prefetch,
    prefetchStatus,
    async fetchForTest(state) {
      if (!state || !VIDEO_ID_RE.test(state.videoId || '')) throw new TypeError('valid videoId is required');
      const result = await search(state, { force: true });
      const injected = typeof result === 'string' ? result : result?.injectedLyrics;
      const payload = buildYouTubeLyricsPayload(state.videoId, injected);
      if (!payload || payload.videoId !== state.videoId) throw new Error('invalid lyrics payload');
      return payload;
    },
    resetActive() {
      const previousActive = active;
      active = null;
      if (previousActive && jobs.get(previousActive.videoId)?.runId === previousActive.runId
        && jobs.get(previousActive.videoId)?.status === 'searching') {
        jobs.delete(previousActive.videoId);
      }
    },
    status(videoId) {
      return jobs.get(videoId)?.status
        || Array.from(prefetchJobs.values()).find((entry) => entry.videoId === videoId)?.status
        || null;
    },
  };
}

module.exports = {
  buildYouTubeLyricsPayload,
  createYouTubeLyricsCoordinator,
  resolveYouTubeLyricsStatus,
  shouldKeepYouTubeLyrics,
};
