const PAIRING_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})#([A-Za-z0-9_-]+)$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const KEY_MIN = -6;
const KEY_MAX = 6;
const SOCKET_RECONNECT_DELAY_MS = 1000;
const SOCKET_HEARTBEAT_MS = 20000;
const SOCKET_REPLACED_CLOSE_CODE = 4000;
const SOCKET_INVALID_PAIRING_CLOSE_CODE = 4001;
const MAX_LYRIC_LINES = 1000;
const MAX_LYRIC_LINE_LENGTH = 4000;
const MAX_LYRIC_TOTAL_LENGTH = 256000;
const MAX_WORD_POINTS = 4000;
const ACTIVATION_SOURCES = new Set(['app', 'youtube']);
const LYRICS_OPTIONS_STATUSES = new Set(['searching', 'done', 'error']);
const OPTION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const NATIVE_HOST_NAME = 'com.resuaumis.kanaric';
const NATIVE_PROTOCOL = 'kanaric-youtube-v1';
const DISCOVERY_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_WINDOW_DIMENSION = 32768;
const PITCH_STATUSES = new Set(['enabled', 'stopped', 'error']);
const MAX_PITCH_FRAME_TIME_MS = 86400000;

function normalizeYouTubeActivationMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 3
    || message.type !== 'youtube_karaoke_activation'
    || typeof message.active !== 'boolean'
    || !ACTIVATION_SOURCES.has(message.source)
    || (message.active && message.source !== 'app')) return null;
  return { type: message.type, active: message.active, source: message.source };
}

function canActivate({ appConnected, action } = {}) {
  return appConnected === true && action === 'load';
}

function activateFromApp(command, tabId) {
  return canActivate({ appConnected: true, action: command?.action })
    && Number.isInteger(tabId) && tabId >= 0
    && VIDEO_ID_RE.test(command?.videoId || '');
}

function parsePairingString(value) {
  if (typeof value !== 'string') return null;
  const match = PAIRING_RE.exec(value);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !TOKEN_RE.test(match[2])) return null;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl, token: match[2], wsUrl: `ws://127.0.0.1:${port}` };
}

function createNativeDiscoveryRequest() {
  return { type: 'discover', protocol: NATIVE_PROTOCOL };
}

function normalizeNativeDiscoveryRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'protocol'].includes(key))
    || message.type !== 'discover' || message.protocol !== NATIVE_PROTOCOL) return null;
  return createNativeDiscoveryRequest();
}

function normalizeNativeDiscoveryResponse(message, now = Date.now()) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.ok === false) {
    return typeof message.error === 'string' && message.error.length <= 100
      ? { ok: false, error: message.error }
      : null;
  }
  if (message.ok !== true || typeof message.baseUrl !== 'string'
    || typeof message.token !== 'string' || !DISCOVERY_TOKEN_RE.test(message.token)
    || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= now
    || !Number.isSafeInteger(message.pid) || message.pid < 1) return null;
  let parsed;
  try { parsed = new URL(message.baseUrl); } catch { return null; }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ok: true,
    baseUrl,
    token: message.token,
    expiresAt: message.expiresAt,
    pid: message.pid,
  };
}

function normalizePitchRelayStatus(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 5
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'status', 'error'].includes(key))
    || message.type !== 'youtube_karaoke_pitch_status'
    || !VIDEO_ID_RE.test(message.videoId || '')
    || !Number.isSafeInteger(message.revision) || message.revision < 1
    || !PITCH_STATUSES.has(message.status)) return null;
  let error = null;
  if (message.error !== null) {
    if (!message.error || typeof message.error !== 'object' || Array.isArray(message.error)
      || Object.keys(message.error).length !== 2
      || Object.keys(message.error).some((key) => !['code', 'message'].includes(key))
      || typeof message.error.code !== 'string' || !message.error.code || message.error.code.length > 100
      || typeof message.error.message !== 'string' || !message.error.message || message.error.message.length > 500) return null;
    error = { code: message.error.code, message: message.error.message };
  }
  if (message.status === 'error' ? !error : error !== null) return null;
  return { type: message.type, videoId: message.videoId, revision: message.revision, status: message.status, error };
}

function normalizePitchRelayFrame(message) {
  const frame = message?.frame;
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 4
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'frame'].includes(key))
    || message.type !== 'youtube_karaoke_pitch_frame'
    || !VIDEO_ID_RE.test(message.videoId || '')
    || !Number.isSafeInteger(message.revision) || message.revision < 1
    || !frame || typeof frame !== 'object' || Array.isArray(frame)
    || Object.keys(frame).length !== 7
    || Object.keys(frame).some((key) => !['timeMs', 'hz', 'midi', 'cents', 'confidence', 'voiced', 'octaveWarning'].includes(key))
    || !Number.isSafeInteger(frame.timeMs) || frame.timeMs < 0 || frame.timeMs > MAX_PITCH_FRAME_TIME_MS
    || ![frame.hz, frame.midi, frame.cents].every((value) => value === null || typeof value === 'number' && Number.isFinite(value))
    || (frame.hz !== null && (frame.hz < 0 || frame.hz > 5000))
    || (frame.midi !== null && (frame.midi < 0 || frame.midi > 200))
    || (frame.cents !== null && (frame.cents < -1200 || frame.cents > 1200))
    || typeof frame.confidence !== 'number' || !Number.isFinite(frame.confidence)
    || frame.confidence < 0 || frame.confidence > 1
    || typeof frame.voiced !== 'boolean' || typeof frame.octaveWarning !== 'boolean') return null;
  return {
    type: message.type,
    videoId: message.videoId,
    revision: message.revision,
    frame: {
      timeMs: frame.timeMs,
      hz: frame.hz,
      midi: frame.midi,
      cents: frame.cents,
      confidence: frame.confidence,
      voiced: frame.voiced,
      octaveWarning: frame.octaveWarning,
    },
  };
}

function buildYouTubeWatchUrl(videoId, positionMs = 0) {
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId) || !isSafeNonNegativeInteger(positionMs)) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${positionMs / 1000}s`;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeOwnerWindowBounds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 4
    || Object.keys(raw).some((key) => !['x', 'y', 'width', 'height'].includes(key))) return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(Number.isSafeInteger)
    || width < 1 || width > MAX_WINDOW_DIMENSION || height < 1 || height > MAX_WINDOW_DIMENSION) return null;
  return { x, y, width, height };
}

function shouldReconnectAfterSocketClose(code) {
  return code !== SOCKET_REPLACED_CLOSE_CODE && code !== SOCKET_INVALID_PAIRING_CLOSE_CODE;
}

function shouldForwardYouTubeMessageToTab(message, latestState) {
  if (!message || !['youtube_karaoke_lyrics', 'youtube_karaoke_lyrics_status'].includes(message.type)) return true;
  const state = latestState?.state && typeof latestState.state === 'object' ? latestState.state : latestState;
  if (!VIDEO_ID_RE.test(state?.videoId || '')) return true;
  const videoId = message.type === 'youtube_karaoke_lyrics' ? message.lyrics?.videoId : message.videoId;
  return videoId === state.videoId;
}

function createStateRelay({ isOpen = () => false, isClosed = () => false, scheduleReconnect = () => {}, send = () => {} } = {}) {
  let latest = null;
  return {
    receive(message) {
      if (message?.type !== 'youtube_karaoke_state') return false;
      latest = message;
      if (isClosed()) scheduleReconnect();
      if (!isOpen()) return false;
      send(message);
      return true;
    },
    replay() {
      if (!latest || !isOpen()) return false;
      send(latest);
      return true;
    },
    clear() {
      latest = null;
    },
  };
}

function normalizeSocketLyrics(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 2 || message.type !== 'youtube_karaoke_lyrics') return null;
  const lyrics = message.lyrics;
  if (!lyrics || typeof lyrics !== 'object' || Array.isArray(lyrics) || Object.keys(lyrics).some((key) => !['videoId', 'offsetMs', 'lines'].includes(key)) || Object.keys(lyrics).length !== 3) return null;
  if (typeof lyrics.videoId !== 'string' || !VIDEO_ID_RE.test(lyrics.videoId) || !Number.isSafeInteger(lyrics.offsetMs) || !Array.isArray(lyrics.lines) || lyrics.lines.length > MAX_LYRIC_LINES) return null;
  let totalLength = 0;
  let previousLineTime = -1;
  const lines = [];
  for (const line of lyrics.lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line) || Object.keys(line).some((key) => !['timeMs', 'text', 'words'].includes(key)) || Object.keys(line).some((key) => key === 'timeMs' || key === 'text' ? line[key] === undefined : false)) return null;
    if (!Number.isSafeInteger(line.timeMs) || line.timeMs < 0 || line.timeMs < previousLineTime || typeof line.text !== 'string' || line.text.length > MAX_LYRIC_LINE_LENGTH) return null;
    totalLength += line.text.length;
    if (totalLength > MAX_LYRIC_TOTAL_LENGTH) return null;
    previousLineTime = line.timeMs;
    const words = line.words == null ? null : line.words;
    if (words !== null && (!Array.isArray(words) || words.length > MAX_WORD_POINTS)) return null;
    let previousIndex = -1;
    let previousTime = -1;
    const normalizedWords = words === null ? null : [];
    if (words) {
      for (const word of words) {
        if (!Array.isArray(word) || word.length !== 2 || !isSafeNonNegativeInteger(word[0]) || !isSafeNonNegativeInteger(word[1]) || word[0] < previousIndex || word[1] < previousTime) return null;
        previousIndex = word[0];
        previousTime = word[1];
        normalizedWords.push([word[0], word[1]]);
      }
    }
    lines.push({ timeMs: line.timeMs, text: line.text, words: normalizedWords });
  }
  return { type: 'youtube_karaoke_lyrics', lyrics: { videoId: lyrics.videoId, offsetMs: lyrics.offsetMs, lines } };
}

function normalizeSocketLyricsStatus(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'status', 'error'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_status'
    || !VIDEO_ID_RE.test(message.videoId)
    || !['searching', 'loaded', 'no_lyrics', 'error'].includes(message.status)) return null;
  const rawError = message.error;
  if (rawError !== null && rawError !== undefined) {
    if (!rawError || typeof rawError !== 'object' || Array.isArray(rawError)
      || typeof rawError.code !== 'string' || typeof rawError.message !== 'string'
      || !rawError.code || !rawError.message || rawError.code.length > 100 || rawError.message.length > 500) return null;
  }
  return {
    type: message.type,
    videoId: message.videoId,
    status: message.status,
    error: rawError || null,
  };
}

function normalizeLyricsOptionsRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'title', 'artist'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_options_request'
    || !VIDEO_ID_RE.test(message.videoId)
    || !isSafeNonNegativeInteger(message.revision)
    || typeof message.title !== 'string' || !message.title.trim() || message.title.length > 200
    || typeof message.artist !== 'string' || !message.artist.trim() || message.artist.length > 200) return null;
  return {
    videoId: message.videoId,
    revision: message.revision,
    title: message.title.trim(),
    artist: message.artist.trim(),
  };
}

function normalizeLyricsOptionSelect(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'optionId'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_option_select'
    || !VIDEO_ID_RE.test(message.videoId)
    || !isSafeNonNegativeInteger(message.revision)
    || typeof message.optionId !== 'string' || !OPTION_ID_RE.test(message.optionId)) return null;
  return { videoId: message.videoId, revision: message.revision, optionId: message.optionId };
}

function normalizeLyricsOptionsMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'status', 'options', 'error'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_options'
    || !VIDEO_ID_RE.test(message.videoId)
    || !isSafeNonNegativeInteger(message.revision)
    || !LYRICS_OPTIONS_STATUSES.has(message.status)
    || !Array.isArray(message.options) || message.options.length > 20) return null;
  const options = message.options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)
      || Object.keys(option).some((key) => !['optionId', 'source', 'format', 'preview', 'hasWords'].includes(key))
      || typeof option.optionId !== 'string' || !OPTION_ID_RE.test(option.optionId)
      || typeof option.source !== 'string' || option.source.length > 100
      || typeof option.format !== 'string' || option.format.length > 20
      || typeof option.preview !== 'string' || option.preview.length > 500
      || typeof option.hasWords !== 'boolean') return null;
    return { ...option };
  });
  if (options.some((option) => !option)) return null;
  const normalized = {
    type: message.type,
    videoId: message.videoId,
    revision: message.revision,
    status: message.status,
    options,
  };
  if (message.error !== undefined) {
    if (typeof message.error !== 'string' || message.error.length > 500) return null;
    normalized.error = message.error;
  }
  return normalized;
}

function createLyricsOptionsRequest(state) {
  if (!state || typeof state !== 'object') return null;
  const request = normalizeLyricsOptionsRequest({
    type: 'youtube_karaoke_lyrics_options_request',
    videoId: state.videoId,
    revision: state.revision,
    title: typeof state.title === 'string' ? state.title.trim() : '',
    artist: typeof state.channel === 'string' ? state.channel.trim() : '',
  });
  return request ? { type: 'youtube_karaoke_lyrics_options_request', ...request } : null;
}

function createYouTubeLyricsSearchMessage(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !VIDEO_ID_RE.test(state.videoId)
    || typeof state.title !== 'string' || !state.title.trim() || state.title.length > 200
    || typeof state.channel !== 'string' || !state.channel.trim() || state.channel.length > 200
    || !isSafeNonNegativeInteger(state.revision)) return null;
  return {
    type: 'youtube_karaoke_search',
    videoId: state.videoId,
    title: state.title.trim(),
    channel: state.channel.trim(),
    revision: state.revision,
  };
}

function createLatestMessageRelay(send = () => {}, normalize = normalizeSocketLyrics) {
  let latest = null;
  return {
    receive(message) {
      const normalized = normalize(message);
      if (!normalized) return false;
      latest = normalized;
      send(normalized);
      return true;
    },
    replay() {
      if (!latest) return false;
      send(latest);
      return true;
    },
    clear() {
      latest = null;
    },
  };
}

function createSocketKeepAlive({
  isOpen = () => false,
  send = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = SOCKET_HEARTBEAT_MS,
} = {}) {
  let timer = null;
  return {
    start() {
      if (timer !== null) return false;
      timer = setIntervalFn(() => {
        if (isOpen()) send({ type: 'youtube_karaoke_heartbeat' });
      }, intervalMs);
      return true;
    },
    stop() {
      if (timer === null) return false;
      clearIntervalFn(timer);
      timer = null;
      return true;
    },
  };
}

function createReconnectScheduler({
  reconnect,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  delayMs = SOCKET_RECONNECT_DELAY_MS,
} = {}) {
  let timer = null;
  return {
    schedule() {
      if (timer !== null) return false;
      timer = setTimeoutFn(() => {
        timer = null;
        reconnect();
      }, delayMs);
      return true;
    },
    cancel() {
      if (timer === null) return false;
      clearTimeoutFn(timer);
      timer = null;
      return true;
    },
  };
}

function normalizeKey(value) {
  return Number.isSafeInteger(value) && value >= KEY_MIN && value <= KEY_MAX ? value : null;
}

function createKeyController() {
  let semitones = 0;
  return {
    current: () => semitones,
    set(value) {
      const next = normalizeKey(value);
      if (next === null) return { ok: false, error: 'invalid-key' };
      semitones = next;
      return { ok: true, semitones, tempo: 1 };
    },
    reset() {
      semitones = 0;
    },
  };
}

function normalizeSocketCommand(message) {
  if (!message || message.type !== 'youtube_karaoke_command' || !message.command) return null;
  const raw = message.command;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = new Set(['commandId', 'revision', 'action', 'videoId', 'positionMs', 'seconds', 'semitones']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (raw.commandId !== undefined && !isSafeNonNegativeInteger(raw.commandId)) return null;
  if (raw.revision !== undefined && !isSafeNonNegativeInteger(raw.revision)) return null;
  if (!['load', 'play', 'pause', 'seek', 'set_key'].includes(raw.action)) return null;
  const command = {};
  if (raw.commandId !== undefined) command.commandId = raw.commandId;
  if (raw.revision !== undefined) command.revision = raw.revision;
  command.action = raw.action;
  if (raw.action === 'load') {
    if (typeof raw.videoId !== 'string' || !VIDEO_ID_RE.test(raw.videoId)) return null;
    command.videoId = raw.videoId;
    command.positionMs = raw.positionMs === undefined ? 0 : raw.positionMs;
    if (!isSafeNonNegativeInteger(command.positionMs)) return null;
  } else if (raw.action === 'seek') {
    if (raw.positionMs !== undefined) {
      if (!isSafeNonNegativeInteger(raw.positionMs)) return null;
      command.positionMs = raw.positionMs;
    } else {
      if (!Number.isFinite(raw.seconds) || raw.seconds < 0) return null;
      command.positionMs = Math.round(raw.seconds * 1000);
      if (!isSafeNonNegativeInteger(command.positionMs)) return null;
    }
  } else if (raw.action === 'set_key') {
    if (!Number.isSafeInteger(raw.semitones) || raw.semitones < -6 || raw.semitones > 6) return null;
    command.semitones = raw.semitones;
  } else if (Object.keys(raw).some((key) => !['commandId', 'revision', 'action'].includes(key))) {
    return null;
  }
  return command;
}

function createRevisionTracker() {
  let revision = 0;
  return {
    current: () => revision,
    apply(command) {
      if (!command || command.action !== 'load') return revision;
      revision += 1;
      return revision;
    },
  };
}

let socket = null;
let youtubeTabId = null;
let youtubeKaraokeActive = false;
let pendingLoad = null;
let pendingActivation = null;
let loadSequence = 0;
let activeClaimId = null;
let latestYouTubeState = null;
let pendingMetadataSearch = null;
let audioCaptureActive = false;
const revisionTracker = createRevisionTracker();
const keyController = createKeyController();
let audioProcessingError = null;
let offscreenCreation = null;
let offscreenDocumentOpen = false;
let offscreenClosePromise = null;
let audioCaptureInFlight = null;
let keyAudioRelease = null;
let pitchRelayIdentity = null;
let pitchRelayEnabled = false;
let pendingPitchRelayStatus = null;
let ownerWindowBounds = null;
let ownerWindowBoundsKey = null;
let ownerWindowBoundsGeneration = 0;

function hasChromeRuntime() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.tabs && chrome.storage;
}

async function restoreStoredYouTubeTabId(sender, api = chrome) {
  const senderTabId = sender?.tab?.id;
  if (!Number.isInteger(senderTabId) || senderTabId < 0) return null;
  if (youtubeTabId !== null) return senderTabId === youtubeTabId ? youtubeTabId : null;
  const stored = await api.storage.local.get(['youtubeTabId']);
  if (!Number.isInteger(stored?.youtubeTabId) || stored.youtubeTabId < 0 || stored.youtubeTabId !== senderTabId) return null;
  if (youtubeTabId !== stored.youtubeTabId) clearOwnerWindowBounds();
  youtubeTabId = stored.youtubeTabId;
  youtubeKaraokeActive = true;
  return youtubeTabId;
}

async function getPairing() {
  const stored = await chrome.storage.local.get(['baseUrl', 'token', 'tokenExpiresAt']);
  if (typeof stored.baseUrl !== 'string' || typeof stored.token !== 'string') return null;
  if (stored.tokenExpiresAt !== undefined
    && (!Number.isSafeInteger(stored.tokenExpiresAt) || stored.tokenExpiresAt <= Date.now())) return null;
  return parsePairingString(`${stored.baseUrl}#${stored.token}`);
}

async function discoverKanaricApp(api = chrome) {
  if (typeof api.runtime?.sendNativeMessage !== 'function') return { ok: false, error: 'native-messaging-unavailable' };
  let raw;
  try {
    raw = await api.runtime.sendNativeMessage(NATIVE_HOST_NAME, createNativeDiscoveryRequest());
  } catch (error) {
    return { ok: false, error: 'app-not-running' };
  }
  const response = normalizeNativeDiscoveryResponse(raw);
  if (!response) return { ok: false, error: 'invalid-discovery-response' };
  if (!response.ok) return response;
  const pairing = parsePairingString(`${response.baseUrl}#${response.token}`);
  if (!pairing) return { ok: false, error: 'invalid-discovery-response' };
  await api.storage.local.set({
    baseUrl: response.baseUrl,
    token: response.token,
    tokenExpiresAt: response.expiresAt,
  });
  return { ok: true, pairing, expiresAt: response.expiresAt, pid: response.pid };
}

async function openKanaricDetails(api = chrome) {
  const pairing = await getPairing();
  if (!pairing || typeof api.tabs?.create !== 'function') return { ok: false, error: 'invalid-pairing' };
  await api.tabs.create({ url: `${pairing.baseUrl}/karaoke`, active: true });
  return { ok: true };
}

function sendToTab(message) {
  if (!shouldForwardYouTubeMessageToTab(message, latestYouTubeState)) return;
  if (youtubeTabId !== null) chrome.tabs.sendMessage(youtubeTabId, message).catch(() => {});
}

function clearPitchRelay({ notify = true } = {}) {
  const identity = pitchRelayIdentity;
  pitchRelayIdentity = null;
  pitchRelayEnabled = false;
  pendingPitchRelayStatus = null;
  if (notify && identity) {
    sendToTab({
      type: 'youtube_karaoke_pitch_status',
      videoId: identity.videoId,
      revision: identity.revision,
      status: 'stopped',
      error: null,
    });
  }
}

function receivePitchRelay(message) {
  const status = normalizePitchRelayStatus(message);
  const state = currentYouTubeState();
  if (status) {
    if (!state) {
      pendingPitchRelayStatus = status;
      return true;
    }
    if (status.videoId !== state.videoId || status.revision !== state.revision) return false;
    pendingPitchRelayStatus = null;
    pitchRelayIdentity = { videoId: status.videoId, revision: status.revision };
    pitchRelayEnabled = status.status === 'enabled';
    sendToTab(status);
    if (status.status === 'stopped') pitchRelayIdentity = null;
    return true;
  }
  const frame = normalizePitchRelayFrame(message);
  if (!frame || !state || !pitchRelayEnabled || !pitchRelayIdentity
    || frame.videoId !== state.videoId || frame.revision !== state.revision
    || frame.videoId !== pitchRelayIdentity.videoId || frame.revision !== pitchRelayIdentity.revision) return false;
  sendToTab(frame);
  return true;
}

function replayPendingPitchRelayStatus() {
  if (!pendingPitchRelayStatus) return false;
  const status = pendingPitchRelayStatus;
  pendingPitchRelayStatus = null;
  return receivePitchRelay(status);
}

function replayConnectionStateToTab() {
  if (!socket) return;
  const state = socket.readyState === WebSocket.OPEN ? 'connected'
    : socket.readyState === WebSocket.CONNECTING ? 'connecting' : null;
  if (state) sendToTab({ type: 'youtube_karaoke_connection', state, error: audioProcessingError?.message || '' });
}

function setConnectionState(state, error = '') {
  if (!hasChromeRuntime()) return;
  const visibleError = error || audioProcessingError?.message || '';
  chrome.storage.local.set({ connectionState: state, connectionError: visibleError }).catch(() => {});
  sendToTab({ type: 'youtube_karaoke_connection', state, error: visibleError });
}

function clearYouTubeLyricsFromTab() {
  lyricsRelay.clear();
  lyricsStatusRelay.clear();
  lyricsOptionsRelay.clear();
  const state = latestYouTubeState?.state && typeof latestYouTubeState.state === 'object'
    ? latestYouTubeState.state : latestYouTubeState;
  if (VIDEO_ID_RE.test(state?.videoId || '')) {
    sendToTab({ type: 'youtube_karaoke_lyrics_reset', videoId: state.videoId });
  }
}

function clearOwnerWindowBounds() {
  ownerWindowBounds = null;
  ownerWindowBoundsKey = null;
  ownerWindowBoundsGeneration += 1;
}

async function clearYouTubeOwnerActivation({ notify = false, clearContent = false } = {}) {
  const ownerTabId = youtubeTabId;
  clearOwnerWindowBounds();
  clearPitchRelay();
  if (notify && ownerTabId !== null) {
    sendToTab({ type: 'youtube_karaoke_activation', active: false, source: 'app' });
  }
  if (clearContent) clearYouTubeLyricsFromTab();
  youtubeTabId = null;
  youtubeKaraokeActive = false;
  pendingActivation = null;
  if (clearContent) {
    latestYouTubeState = null;
    pendingMetadataSearch = null;
    stateRelay.clear();
    lyricsRelay.clear();
    lyricsStatusRelay.clear();
    lyricsOptionsRelay.clear();
  }
  await chrome.storage.local.remove(['youtubeTabId', 'youtubeKaraokeActive']).catch(() => {});
  return ownerTabId;
}

function closeSocket(code, reason, error = '') {
  const candidate = socket;
  if (candidate && candidate.readyState !== WebSocket.CLOSED) {
    socket = null;
    try { candidate.close(code, reason); } catch {}
  }
  if (error) setConnectionState('error', error);
}

async function ensureOffscreenDocument(api = chrome) {
  if (!api.offscreen?.createDocument || !api.runtime?.getURL) throw new Error('offscreen-unavailable');
  const url = api.runtime.getURL('offscreen.html');
  if (api.runtime.getContexts) {
    const contexts = await api.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (contexts?.length) {
      offscreenDocumentOpen = true;
      return;
    }
  }
  if (!offscreenCreation) {
    offscreenCreation = api.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Process captured YouTube audio for manual key changes.',
    });
  }
  try {
    await offscreenCreation;
    offscreenDocumentOpen = true;
  } finally {
    offscreenCreation = null;
  }
}

async function sendToOffscreen(message, api = chrome) {
  await ensureOffscreenDocument(api);
  const response = await api.runtime.sendMessage(message);
  if (!response) throw new Error('offscreen-no-response');
  return response;
}

async function closeOffscreenDocument(api = chrome) {
  if (offscreenClosePromise) return offscreenClosePromise;
  offscreenClosePromise = (async () => {
    if (audioCaptureInFlight) await audioCaptureInFlight.catch(() => {});
    const shouldDispose = audioCaptureActive;
    audioCaptureActive = false;
    if (!offscreenDocumentOpen || typeof api.offscreen?.closeDocument !== 'function') return false;
    if (shouldDispose) {
      try { await api.runtime?.sendMessage?.({ type: 'pitch_dispose' }); } catch {}
    }
    try {
      await api.offscreen.closeDocument();
      offscreenDocumentOpen = false;
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await offscreenClosePromise;
  } finally {
    offscreenClosePromise = null;
  }
}

function releaseKeyAudio() {
  if (keyAudioRelease) return keyAudioRelease;
  const release = (async () => {
    keyController.reset();
    clearAudioProcessingError();
    await closeOffscreenDocument();
  })();
  keyAudioRelease = release;
  keyAudioRelease.then(
    () => { if (keyAudioRelease === release) keyAudioRelease = null; },
    () => { if (keyAudioRelease === release) keyAudioRelease = null; },
  );
  return keyAudioRelease;
}

function currentYouTubeState() {
  return latestYouTubeState?.state && typeof latestYouTubeState.state === 'object'
    ? latestYouTubeState.state : latestYouTubeState;
}

function setAudioProcessingError(code, message = code) {
  audioProcessingError = { code, message };
  replayConnectionStateToTab();
}

function clearAudioProcessingError() {
  audioProcessingError = null;
  replayConnectionStateToTab();
}

function decorateStateMessage(message) {
  if (!message?.state || typeof message.state !== 'object') return message;
  const state = {
    ...message.state,
    keySemitones: keyController.current(),
  };
  if (ownerWindowBounds) state.ownerWindowBounds = ownerWindowBounds;
  if (!state.error && audioProcessingError) state.error = audioProcessingError;
  return { ...message, state };
}

function sendStateToSocket(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(decorateStateMessage(message)));
  return true;
}

const stateRelay = createStateRelay({
  isOpen: () => socket?.readyState === 1,
  isClosed: () => socket === null || socket.readyState === WebSocket.CLOSED,
  scheduleReconnect: () => reconnectScheduler.schedule(),
  send: sendStateToSocket,
});

function refreshOwnerWindowBounds(state, api = chrome) {
  const ownerTabId = youtubeTabId;
  const key = Number.isInteger(ownerTabId) && state?.videoId && Number.isSafeInteger(state.revision)
    ? `${ownerTabId}:${state.videoId}:${state.revision}` : null;
  if (!key || typeof api?.tabs?.get !== 'function' || typeof api?.windows?.get !== 'function') return;
  if (ownerWindowBoundsKey === key) return;
  ownerWindowBoundsKey = key;
  ownerWindowBounds = null;
  const generation = ++ownerWindowBoundsGeneration;
  (async () => {
    try {
      const tab = await api.tabs.get(ownerTabId);
      if (!tab || !Number.isSafeInteger(tab.windowId)) return;
      const window = await api.windows.get(tab.windowId);
      const bounds = normalizeOwnerWindowBounds({
        x: window?.left,
        y: window?.top,
        width: window?.width,
        height: window?.height,
      });
      if (ownerWindowBoundsGeneration !== generation || ownerWindowBoundsKey !== key || youtubeTabId !== ownerTabId) return;
      const current = currentYouTubeState();
      if (current?.videoId !== state.videoId || current?.revision !== state.revision) return;
      ownerWindowBounds = bounds;
      if (bounds) stateRelay.replay();
    } catch {}
  })();
}

const lyricsRelay = createLatestMessageRelay(sendToTab);
const lyricsStatusRelay = createLatestMessageRelay(sendToTab, normalizeSocketLyricsStatus);
const lyricsOptionsRelay = createLatestMessageRelay(sendToTab, normalizeLyricsOptionsMessage);

function sendYouTubeLyricsSearch(videoId) {
  if (!youtubeKaraokeActive) return false;
  const state = latestYouTubeState?.state && typeof latestYouTubeState.state === 'object'
    ? latestYouTubeState.state : latestYouTubeState;
  if (!state || state.videoId !== videoId) return false;
  const message = createYouTubeLyricsSearchMessage(state);
  if (!message || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function sendYouTubeLyricsOptionsRequest(request) {
  if (!youtubeKaraokeActive || socket?.readyState !== WebSocket.OPEN) return false;
  const state = latestYouTubeState?.state && typeof latestYouTubeState.state === 'object'
    ? latestYouTubeState.state : latestYouTubeState;
  const normalized = normalizeLyricsOptionsRequest(request);
  if (!normalized || !state || normalized.videoId !== state.videoId || normalized.revision !== state.revision) return false;
  socket.send(JSON.stringify({ type: 'youtube_karaoke_lyrics_options_request', ...normalized }));
  return true;
}

function resetYouTubeNavigation() {
  clearPitchRelay();
  releaseKeyAudio().catch(() => {});
  clearOwnerWindowBounds();
  latestYouTubeState = null;
  pendingMetadataSearch = null;
  stateRelay.clear();
  lyricsRelay.clear();
  lyricsStatusRelay.clear();
  lyricsOptionsRelay.clear();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'youtube_karaoke_state_reset' }));
}

function replayLastState() {
  stateRelay.replay();
}

async function reconnectSocket() {
  const pairing = await getPairing();
  if (!pairing) {
    if (youtubeKaraokeActive) setConnectionState('disconnected');
    return;
  }
  try { await connectSocket(pairing); } catch {}
}

const reconnectScheduler = createReconnectScheduler({ reconnect: reconnectSocket });

function captureTabAudio(tabId, api = chrome) {
  const operation = (async () => {
    if (!Number.isInteger(tabId) || typeof api.tabCapture?.getMediaStreamId !== 'function') {
      throw new Error('tab-capture-unavailable');
    }
    await ensureOffscreenDocument(api);
    const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const response = await api.runtime.sendMessage({ type: 'capture_tab', streamId });
    if (!response) throw new Error('offscreen-no-response');
    if (response.status === 'bypass' || response.status === 'pitch-processing-unavailable' || response.bypassed) {
      audioCaptureActive = true;
      const error = response.error;
      const code = typeof error === 'string' ? error : error?.code || 'pitch-processing-unavailable';
      const message = typeof error === 'string' ? 'Pitch processing unavailable; audio bypassed' : error?.message || 'Pitch processing unavailable; audio bypassed';
      setAudioProcessingError(code, message);
    } else if (response.ok) {
      audioCaptureActive = true;
      clearAudioProcessingError();
    } else {
      audioCaptureActive = false;
    }
    return response;
  })();
  audioCaptureInFlight = operation;
  return operation.finally(() => {
    if (audioCaptureInFlight === operation) audioCaptureInFlight = null;
  });
}

async function resetAudioKey() {
  keyController.reset();
  if (!audioCaptureActive) return { ok: true, semitones: 0, tempo: 1 };
  try {
    const response = await sendToOffscreen({ type: 'set_key', semitones: 0 });
    if (!response?.ok) {
      const error = response?.error;
      const code = typeof error === 'string' ? error : error?.code || 'pitch-processing-unavailable';
      setAudioProcessingError(code, 'Pitch processing unavailable; audio bypassed');
      replayLastState();
      return response;
    }
    clearAudioProcessingError();
    replayLastState();
    return response;
  } catch {
    setAudioProcessingError('pitch-processing-unavailable', 'Pitch processing unavailable; audio bypassed');
    replayLastState();
    return { ok: false, status: 'bypass', error: 'pitch-processing-unavailable', bypassed: true };
  }
}

async function applyKey(semitones) {
  if (!youtubeKaraokeActive || !audioCaptureActive) return { ok: false, error: 'karaoke-inactive' };
  const valid = normalizeKey(semitones);
  if (valid === null) return { ok: false, error: 'invalid-key' };
  try {
    const response = await sendToOffscreen({ type: 'set_key', semitones: valid });
    if (!response.ok) {
      const error = response.error;
      const code = typeof error === 'string' ? error : error?.code;
      if (response.status === 'bypass' || response.bypassed || code === 'pitch-processing-unavailable') {
        setAudioProcessingError(code || 'pitch-processing-unavailable', 'Pitch processing unavailable; audio bypassed');
        replayLastState();
      }
      return response;
    }
    keyController.set(valid);
    clearAudioProcessingError();
    replayLastState();
    return response;
  } catch {
    setAudioProcessingError('pitch-processing-unavailable', 'Pitch processing unavailable; audio bypassed');
    replayLastState();
    return { ok: false, error: 'pitch-processing-unavailable' };
  }
}

function waitForSocketOpen(candidate) {
  if (candidate.readyState === 1) return Promise.resolve(candidate);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('WebSocket connection timed out')), 8000);
    const cleanup = () => {
      clearTimeout(timer);
      candidate.removeEventListener('open', onOpen);
      candidate.removeEventListener('error', onError);
      candidate.removeEventListener('close', onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(candidate);
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error('WebSocket connection failed'));
    const onClose = () => finish(new Error('WebSocket closed before open'));
    candidate.addEventListener('open', onOpen);
    candidate.addEventListener('error', onError);
    candidate.addEventListener('close', onClose);
  });
}

async function connectSocket(pairing) {
  if (socket && socket.readyState === 1) return socket;
  if (socket && socket.readyState === 0) return waitForSocketOpen(socket);
  setConnectionState('connecting');
  socket = new WebSocket(pairing.wsUrl, ['kanaric-youtube-v1', pairing.token]);
  const candidate = socket;
  const keepAlive = createSocketKeepAlive({
    isOpen: () => candidate.readyState === WebSocket.OPEN,
    send: (message) => candidate.send(JSON.stringify(message)),
  });
  candidate.addEventListener('open', () => setConnectionState('connected'));
  candidate.addEventListener('open', () => {
    reconnectScheduler.cancel();
    keepAlive.start();
    clearPitchRelay();
    clearYouTubeLyricsFromTab();
    replayLastState();
    lyricsRelay.replay();
    lyricsStatusRelay.replay();
    lyricsOptionsRelay.replay();
    sendToTab({ action: 'report' });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'youtube_karaoke_lyrics') {
      if (pendingMetadataSearch?.videoId === message.lyrics?.videoId) {
        if (pendingMetadataSearch.stage === 'waiting') pendingMetadataSearch = null;
        else if (pendingMetadataSearch.stage !== 'retrying') return;
      }
      lyricsRelay.receive(message);
      return;
    }
    if (message.type === 'youtube_karaoke_lyrics_status') {
      const status = normalizeSocketLyricsStatus(message);
      if (!status) return;
      if (pendingMetadataSearch?.videoId === status.videoId) {
        if (pendingMetadataSearch.stage === 'waiting' && status.status !== 'searching') {
          if (sendYouTubeLyricsSearch(status.videoId)) {
            pendingMetadataSearch.stage = 'starting';
            return;
          }
          pendingMetadataSearch = null;
        } else if (pendingMetadataSearch.stage === 'starting') {
          if (status.status === 'searching') pendingMetadataSearch.stage = 'retrying';
          else pendingMetadataSearch = null;
        } else if (pendingMetadataSearch.stage === 'retrying' && status.status !== 'searching') {
          pendingMetadataSearch = null;
        }
      }
      lyricsStatusRelay.receive(status);
      return;
    }
    if (message.type === 'youtube_karaoke_lyrics_options') {
      lyricsOptionsRelay.receive(message);
      return;
    }
    if (message.type === 'youtube_karaoke_pitch_status' || message.type === 'youtube_karaoke_pitch_frame') {
      receivePitchRelay(message);
      return;
    }
    if (message.type !== 'youtube_karaoke_command') return;
    const command = normalizeSocketCommand(message);
    if (!command) return;
    if (command.action === 'load') {
      if (!canActivate({ appConnected: candidate.readyState === 1, action: command.action })) return;
      revisionTracker.apply(command);
      resetAudioKey().catch(() => {});
      const loadId = ++loadSequence;
      pendingLoad = {
        ...command,
        revision: revisionTracker.current(),
        loadId,
        candidate,
        activationReady: false,
        queuedCommands: [],
      };
      pendingActivation = null;
      ensureYouTubeTab(chrome, null, { commit: false }).then(async (tab) => {
        if (!isCurrentPendingLoad(loadId, candidate)
          || !activateFromApp(command, tab.id)) return;
        const claimed = await claimYouTubeTab(chrome, tab, () => isCurrentPendingLoad(loadId, candidate), loadId);
        if (!claimed) return;
        if (!isCurrentPendingLoad(loadId, candidate)) {
          await rollbackYouTubeClaim(chrome, tab, loadId, true);
          return;
        }
        try {
          await captureTabAudio(tab.id);
        } catch (error) {
          setAudioProcessingError('tab-capture-unavailable', error.message);
        }
        if (!isCurrentPendingLoad(loadId, candidate)) {
          await rollbackYouTubeClaim(chrome, tab, loadId, true);
          return;
        }
        pendingLoad.activationReady = true;
        pendingActivation = { type: 'youtube_karaoke_activation', active: true, source: 'app' };
        sendToTab(pendingActivation);
        replayConnectionStateToTab();
        const url = buildYouTubeWatchUrl(command.videoId, command.positionMs);
        chrome.tabs.update(tab.id, { url, active: true }).catch(() => {});
      }).catch(() => {
        if (pendingLoad?.loadId === loadId && pendingLoad?.candidate === candidate) pendingLoad = null;
      });
      return;
    }
    if (pendingLoad) {
      pendingLoad.queuedCommands.push(command);
      return;
    }
    if (command.action === 'set_key') {
      applyKey(command.semitones).catch(() => {});
      return;
    }
    if (!youtubeKaraokeActive) return;
    sendToTab({ ...command, revision: revisionTracker.current() });
  });
  candidate.addEventListener('error', () => setConnectionState('error', 'WebSocket connection failed'));
  candidate.addEventListener('close', (event) => {
    keepAlive.stop();
    const abandonedPendingLoad = pendingLoad?.candidate === candidate;
    if (abandonedPendingLoad) {
      pendingLoad = null;
      activeClaimId = null;
      clearYouTubeOwnerActivation({ notify: true, clearContent: true }).catch(() => {});
    }
    if (socket === candidate) {
      socket = null;
      const ownerTabId = youtubeTabId;
      const shouldDeactivateOwner = ownerTabId !== null && !abandonedPendingLoad;
      youtubeKaraokeActive = false;
      clearPitchRelay();
      pendingActivation = null;
      if (shouldDeactivateOwner && event.code !== SOCKET_REPLACED_CLOSE_CODE) {
        sendToTab({ type: 'youtube_karaoke_activation', active: false, source: 'app' });
      }
      releaseKeyAudio().catch(() => {});
      if (shouldDeactivateOwner) chrome.storage.local.set({ youtubeKaraokeActive: false }).catch(() => {});
    }
    if (event.code === SOCKET_INVALID_PAIRING_CLOSE_CODE) {
      clearYouTubeLyricsFromTab();
      setConnectionState('error', 'invalid-pairing');
    } else {
      setConnectionState('disconnected');
      if (shouldReconnectAfterSocketClose(event.code)) reconnectScheduler.schedule();
    }
  });
  try {
    return await waitForSocketOpen(candidate);
  } catch (error) {
    if (socket === candidate) socket = null;
    setConnectionState('error', error.message);
    reconnectScheduler.schedule();
    throw error;
  }
}

function isYouTubeTab(tab) {
  return !!tab && Number.isInteger(tab.id) && tab.id >= 0
    && typeof tab.url === 'string'
    && /^https:\/\/www\.youtube\.com(?:\/|$)/.test(tab.url);
}

function isCurrentPendingLoad(loadId, candidate) {
  return pendingLoad?.loadId === loadId
    && pendingLoad?.candidate === candidate
    && socket === candidate
    && candidate.readyState === 1;
}

async function rollbackYouTubeClaim(api, tab, claimId, focusStarted) {
  if (activeClaimId !== claimId && activeClaimId !== null
    && socket?.readyState === WebSocket.OPEN) return;
  await api.storage.local.remove(['youtubeTabId', 'youtubeKaraokeActive']).catch(() => {});
  if (activeClaimId !== claimId && activeClaimId !== null) {
    if (focusStarted && Number.isInteger(youtubeTabId) && youtubeTabId !== tab.id) {
      await api.tabs.update(youtubeTabId, { active: true }).catch(() => {});
    }
    return;
  }
  if (focusStarted) await api.tabs.update(tab.id, { active: false }).catch(() => {});
  if (activeClaimId === claimId) activeClaimId = null;
}

async function claimYouTubeTab(api, tab, isFresh = () => true, claimId = null) {
  if (!isYouTubeTab(tab)) throw new Error('youtube-owner-tab-required');
  if (!isFresh()) return false;
  activeClaimId = claimId;
  try {
    await api.storage.local.set({ youtubeTabId: tab.id, youtubeKaraokeActive: true });
  } catch {
    await rollbackYouTubeClaim(api, tab, claimId, false);
    return false;
  }
  if (!isFresh()) {
    await rollbackYouTubeClaim(api, tab, claimId, false);
    return false;
  }
  let focusStarted = false;
  try {
    focusStarted = true;
    await api.tabs.update(tab.id, { active: true });
  } catch {
    await rollbackYouTubeClaim(api, tab, claimId, focusStarted);
    return false;
  }
  if (!isFresh()) {
    await rollbackYouTubeClaim(api, tab, claimId, focusStarted);
    return false;
  }
  if (activeClaimId !== claimId) return false;
  if (youtubeTabId !== tab.id) clearOwnerWindowBounds();
  youtubeTabId = tab.id;
  youtubeKaraokeActive = true;
  return true;
}

async function ensureYouTubeTab(api = chrome, preferredTab = null, { commit = true } = {}) {
  if (isYouTubeTab(preferredTab)) {
    if (!commit) return preferredTab;
    if (youtubeTabId !== preferredTab.id) clearOwnerWindowBounds();
    youtubeTabId = preferredTab.id;
    youtubeKaraokeActive = true;
    await api.storage.local.set({ youtubeTabId: preferredTab.id });
    await api.tabs.update(preferredTab.id, { active: true });
    return preferredTab;
  }
  const stored = await api.storage.local.get(['youtubeTabId']);
  if (Number.isInteger(stored.youtubeTabId)) {
    try {
      const tab = await api.tabs.get(stored.youtubeTabId);
      if (isYouTubeTab(tab)) {
        if (!commit) return tab;
        if (youtubeTabId !== tab.id) clearOwnerWindowBounds();
        youtubeTabId = tab.id;
        youtubeKaraokeActive = true;
        await api.tabs.update(tab.id, { active: true });
        return tab;
      }
    } catch {}
  }
  const [activeTab] = await api.tabs.query({ active: true, currentWindow: true });
  if (isYouTubeTab(activeTab)) {
    if (!commit) return activeTab;
    if (youtubeTabId !== activeTab.id) clearOwnerWindowBounds();
    youtubeTabId = activeTab.id;
    youtubeKaraokeActive = true;
    await api.storage.local.set({ youtubeTabId: activeTab.id });
    await api.tabs.update(activeTab.id, { active: true });
    return activeTab;
  }
  throw new Error('youtube-owner-tab-required');
}

async function activateYouTubeSession(source, preferredTab = null) {
  const tab = await ensureYouTubeTab(chrome, preferredTab);
  youtubeKaraokeActive = true;
  pendingActivation = { type: 'youtube_karaoke_activation', active: true, source };
  await chrome.storage.local.set({ youtubeKaraokeActive: true });
  sendToTab(pendingActivation);
  return tab;
}

async function deactivateYouTubeSession(source = 'youtube', sender = null) {
  const senderTabId = sender?.tab?.id;
  if (Number.isInteger(senderTabId) && youtubeTabId !== null && senderTabId !== youtubeTabId) {
    return { ok: false, error: 'youtube-owner-tab-required' };
  }
  clearOwnerWindowBounds();
  clearPitchRelay();
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'youtube_karaoke_state_reset' })); } catch {}
  }
  closeSocket(SOCKET_REPLACED_CLOSE_CODE, 'deactivated');
  if (youtubeTabId !== null && youtubeKaraokeActive) {
    sendToTab({ type: 'youtube_karaoke_activation', active: false, source });
  }
  youtubeKaraokeActive = false;
  pendingActivation = null;
  pendingLoad = null;
  latestYouTubeState = null;
  pendingMetadataSearch = null;
  stateRelay.clear();
  lyricsRelay.clear();
  lyricsStatusRelay.clear();
  const ownerTabId = youtubeTabId;
  youtubeTabId = null;
  if (ownerTabId !== null) await chrome.storage.local.remove(['youtubeTabId', 'youtubeKaraokeActive']);
  await releaseKeyAudio();
  return { ok: true, active: false };
}

async function startKaraoke(sender = null) {
  const pairing = await getPairing();
  if (!pairing) {
    closeSocket(SOCKET_INVALID_PAIRING_CLOSE_CODE, 'invalid-pairing', 'invalid-pairing');
    throw new Error('invalid pairing');
  }
  closeSocket(SOCKET_REPLACED_CLOSE_CODE, 'replaced');
  const tab = await activateYouTubeSession('popup', sender?.tab);
  try {
    await captureTabAudio(tab.id);
  } catch (error) {
    setAudioProcessingError('tab-capture-unavailable', error.message);
  }
  await connectSocket(pairing);
  return { ok: true };
}

async function connectDiscoveredKanaricApp(sender = null) {
  const discovered = await discoverKanaricApp();
  if (!discovered.ok) {
    closeSocket(SOCKET_INVALID_PAIRING_CLOSE_CODE, discovered.error, discovered.error);
    return discovered;
  }
  closeSocket(SOCKET_REPLACED_CLOSE_CODE, 'replaced');
  try {
    await connectSocket(discovered.pairing);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

if (hasChromeRuntime()) {
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || (!changes.baseUrl && !changes.token && !changes.tokenExpiresAt)) return;
    const baseUrl = changes.baseUrl?.newValue;
    const token = changes.token?.newValue;
    if (typeof baseUrl !== 'string' || typeof token !== 'string'
      || !parsePairingString(`${baseUrl}#${token}`)) {
      closeSocket(SOCKET_INVALID_PAIRING_CLOSE_CODE, 'invalid-pairing', 'invalid-pairing');
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'youtube_karaoke_activation') {
      const activation = normalizeYouTubeActivationMessage(message);
      if (!activation) {
        if (message.active === true && typeof sendResponse === 'function') {
          sendResponse({ ok: false, error: 'app-required' });
          return true;
        }
        return undefined;
      }
      if (activation.active) {
        sendResponse({ ok: false, error: 'load-required' });
        return true;
      }
      const operation = activation.active
        ? activateYouTubeSession(activation.source, sender?.tab)
        : deactivateYouTubeSession(activation.source, sender);
      operation.then((result) => sendResponse(activation.active ? { ok: true } : result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'start_karaoke') {
      sendResponse({ ok: false, error: 'app-required' });
      return true;
    }
    if (message?.type === 'connect_karaoke_app') {
      connectDiscoveredKanaricApp(sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'youtube_karaoke_state') {
      restoreStoredYouTubeTabId(sender).then((ownerId) => {
        if (ownerId === null) return;
        const previous = latestYouTubeState?.state;
        const next = message.state;
        const metadataChanged = previous?.videoId === next?.videoId
          && previous?.revision === next?.revision
          && (previous.title !== next.title || previous.channel !== next.channel);
        const revisionChanged = previous?.videoId === next?.videoId
          && previous?.revision !== next?.revision;
        const videoChanged = !!previous?.videoId && previous.videoId !== next?.videoId;
        const previousMetadataReady = !!String(previous?.title || '').trim()
          && !!String(previous?.channel || '').trim();
        if (videoChanged || metadataChanged || revisionChanged) {
           if (videoChanged || revisionChanged) clearOwnerWindowBounds();
           if (videoChanged || revisionChanged) clearPitchRelay();
           if (videoChanged || revisionChanged) resetAudioKey().catch(() => {});
          pendingMetadataSearch = null;
          lyricsRelay.clear();
          lyricsStatusRelay.clear();
          lyricsOptionsRelay.clear();
          sendToTab({ type: 'youtube_karaoke_lyrics_reset', videoId: next.videoId });
        }
        latestYouTubeState = message;
        replayPendingPitchRelayStatus();
        refreshOwnerWindowBounds(next);
        replayConnectionStateToTab();
        lyricsRelay.replay();
        lyricsStatusRelay.replay();
        lyricsOptionsRelay.replay();
        stateRelay.receive(message);
        if (metadataChanged && previousMetadataReady) {
          pendingMetadataSearch = { videoId: next.videoId, stage: 'waiting' };
          sendYouTubeLyricsSearch(next.videoId);
        }
      }).catch(() => {});
      return undefined;
    }
    if (message?.type === 'youtube_karaoke_search') {
      const ok = sendYouTubeLyricsSearch(message.videoId);
      if (typeof sendResponse === 'function') sendResponse({ ok });
      return true;
    }
    if (message?.type === 'youtube_karaoke_lyrics_options_request') {
      const request = normalizeLyricsOptionsRequest(message);
      if (socket?.readyState === 1) {
        const ownerId = sender?.tab?.id;
        const ok = Number.isInteger(ownerId) && ownerId === youtubeTabId && sendYouTubeLyricsOptionsRequest(message);
        if (typeof sendResponse === 'function') sendResponse({ ok });
        return true;
      }
      if (typeof sendResponse === 'function') sendResponse({ ok: false, error: 'app-required' });
      return true;
    }
    if (message?.type === 'youtube_karaoke_lyrics_option_select') {
      const selection = normalizeLyricsOptionSelect(message);
      const state = latestYouTubeState?.state && typeof latestYouTubeState.state === 'object'
        ? latestYouTubeState.state : latestYouTubeState;
      if (socket?.readyState === WebSocket.OPEN) {
        const ownerId = sender?.tab?.id;
        const ok = Number.isInteger(ownerId) && ownerId === youtubeTabId && !!selection
          && selection.videoId === state?.videoId && selection.revision === state?.revision
          && socket?.readyState === WebSocket.OPEN;
        if (ok) socket.send(JSON.stringify({ type: message.type, ...selection }));
        if (typeof sendResponse === 'function') sendResponse({ ok });
        return true;
      }
      if (typeof sendResponse === 'function') sendResponse({ ok: false, error: 'app-required' });
      return true;
    }
    if (message?.type === 'youtube_karaoke_set_key') {
      applyKey(message.semitones)
        .then((response) => { if (typeof sendResponse === 'function') sendResponse(response); })
        .catch((error) => { if (typeof sendResponse === 'function') sendResponse({ ok: false, error: error.message }); });
      return true;
    }
    if (message?.type === 'youtube_karaoke_open_details') {
      openKanaricDetails()
        .then((response) => { if (typeof sendResponse === 'function') sendResponse(response); })
        .catch((error) => { if (typeof sendResponse === 'function') sendResponse({ ok: false, error: error.message }); });
      return true;
    }
    return undefined;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === youtubeTabId) deactivateYouTubeSession('owner-lost').catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === youtubeTabId && changeInfo.status === 'loading') {
      resetYouTubeNavigation();
      if (youtubeKaraokeActive && socket?.readyState === 1 && !pendingLoad && !pendingActivation) {
        pendingActivation = { type: 'youtube_karaoke_activation', active: true, source: 'app' };
      }
    }
    if (tabId === youtubeTabId && changeInfo.status === 'complete') {
      (async () => {
        if (keyAudioRelease) await keyAudioRelease.catch(() => {});
        if (youtubeKaraokeActive && !audioCaptureActive) {
          try {
            await captureTabAudio(tabId);
          } catch (error) {
            setAudioProcessingError('tab-capture-unavailable', error.message);
          }
        }
        if (pendingLoad?.activationReady) {
          const load = pendingLoad;
          pendingLoad = null;
          if (pendingActivation) {
            sendToTab(pendingActivation);
            pendingActivation = null;
            replayConnectionStateToTab();
          }
          const { loadId, candidate, activationReady, queuedCommands, ...command } = load;
          sendToTab(command);
          for (const queued of queuedCommands) {
            if (queued.action === 'set_key') applyKey(queued.semitones).catch(() => {});
            else sendToTab({ ...queued, revision: revisionTracker.current() });
          }
        }
        if (pendingActivation) {
          sendToTab(pendingActivation);
          pendingActivation = null;
          replayConnectionStateToTab();
        }
        lyricsRelay.replay();
        lyricsStatusRelay.replay();
        lyricsOptionsRelay.replay();
      })().catch(() => {});
    }
  });
}

if (typeof module !== 'undefined') module.exports = {
  parsePairingString,
  normalizeYouTubeActivationMessage,
  canActivate,
  activateFromApp,
  createNativeDiscoveryRequest,
  normalizeNativeDiscoveryRequest,
  normalizeNativeDiscoveryResponse,
  normalizePitchRelayStatus,
  normalizePitchRelayFrame,
  normalizeSocketCommand,
  createRevisionTracker,
  buildYouTubeWatchUrl,
  ensureYouTubeTab,
  normalizeKey,
  createKeyController,
  createStateRelay,
  normalizeSocketLyrics,
  normalizeSocketLyricsStatus,
  normalizeLyricsOptionsRequest,
  normalizeLyricsOptionsMessage,
  normalizeLyricsOptionSelect,
  createLyricsOptionsRequest,
  createYouTubeLyricsSearchMessage,
  createLatestMessageRelay,
  resetYouTubeNavigation,
  createSocketKeepAlive,
  createReconnectScheduler,
  shouldReconnectAfterSocketClose,
  shouldForwardYouTubeMessageToTab,
  restoreStoredYouTubeTabId,
  ensureOffscreenDocument,
  captureTabAudio,
  sendYouTubeLyricsSearch,
  sendYouTubeLyricsOptionsRequest,
  openKanaricDetails,
  discoverKanaricApp,
  connectDiscoveredKanaricApp,
};
