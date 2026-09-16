const { karaokeSlots } = require('../../web-app/public/js/karaoke-slots.js');
const { karaokeSplit, karaokePaint } = require('../../web-app/public/js/karaoke.js');

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LYRICS_SEARCH_TIMEOUT_MS = 25000;
const SOCKET_RECOVERY_REPORT_MS = 5000;
const ACTIVATION_SOURCES = new Set(['app', 'youtube']);
const LYRICS_OPTIONS_STATUSES = new Set(['searching', 'done', 'error']);
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LYRIC_LINES = 1000;
const MAX_LYRIC_LINE_LENGTH = 4000;
const MAX_LYRIC_TOTAL_LENGTH = 256000;
const MAX_WORD_POINTS = 4000;
const YOUTUBE_FULLSCREEN_HINT = '請點擊 YouTube 原生全螢幕按鈕';

function normalizeYouTubeActivationMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 3
    || message.type !== 'youtube_karaoke_activation'
    || typeof message.active !== 'boolean'
    || !ACTIVATION_SOURCES.has(message.source)
    || (message.active && message.source !== 'app')) return null;
  return { type: message.type, active: message.active, source: message.source };
}

function shouldRetainYouTubeLyrics(status, lyrics, currentVideoId) {
  return !!lyrics && lyrics.videoId === currentVideoId;
}

function lyricsSearchResponseError(response) {
  if (response?.ok !== false) return null;
  const message = typeof response.error === 'string' && response.error ? response.error : 'lyrics search unavailable';
  return { code: 'lyrics-search-unavailable', message: message.slice(0, 500) };
}

function createLyricsSearchWatchdog({
  timeoutMs = LYRICS_SEARCH_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onTimeout = () => {},
} = {}) {
  let timer = null;
  let videoId = '';
  return {
    start(nextVideoId) {
      if (timer !== null) clearTimeoutFn(timer);
      videoId = nextVideoId;
      timer = setTimeoutFn(() => {
        timer = null;
        onTimeout(videoId);
      }, timeoutMs);
    },
    stop() {
      if (timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
    },
  };
}

function selectYouTubeLyricPair(lines, positionMs, offsetMs, hint = -1) {
  if (!Array.isArray(lines) || !lines.length) return { index: -1, nextIndex: -1 };
  const slotLines = lines.map((line) => ({ time: line.timeMs / 1000, text: line.text, words: line.words }));
  const slots = karaokeSlots(slotLines, (positionMs - offsetMs) / 1000, hint);
  return { index: slots.index, nextIndex: slots.nextIndex };
}

function lyricElementPolicy(tagName, attributeName) {
  const tag = String(tagName || '').toUpperCase();
  if (!['RUBY', 'RT', 'RP'].includes(tag)) return 'unwrap';
  if (attributeName == null) return 'keep';
  return tag === 'RUBY' && attributeName === 'data-hs' ? 'keep' : 'drop-attribute';
}

function isSafeYouTubeLyricHtml(value) {
  if (typeof value !== 'string') return false;
  const tagPattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g;
  let match;
  let end = 0;
  while ((match = tagPattern.exec(value)) !== null) {
    if (value.slice(end, match.index).includes('<')) return false;
    end = tagPattern.lastIndex;
    const closing = !!match[1];
    const tag = match[2].toLowerCase();
    const attributes = match[3];
    if (!['ruby', 'rt', 'rp'].includes(tag)) return false;
    if (closing) {
      if (attributes.trim()) return false;
      continue;
    }
    if (tag !== 'ruby' && attributes.trim()) return false;
    if (tag === 'ruby' && attributes.trim()
      && !/^(?:\s+(?:class|data-[A-Za-z0-9_-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*$/.test(attributes)) return false;
  }
  return !value.slice(end).includes('<');
}

function setSafeLyricHtml(target, html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    const policy = lyricElementPolicy(element.tagName, null);
    if (policy === 'unwrap') {
      const fragment = document.createDocumentFragment();
      while (element.firstChild) fragment.appendChild(element.firstChild);
      element.replaceWith(fragment);
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (lyricElementPolicy(element.tagName, attribute.name) === 'drop-attribute') element.removeAttribute(attribute.name);
    }
  }
  target.replaceChildren(template.content);
  target.__kc = null;
  target.__kcNow = null;
}

function normalizeYouTubeLyricPayload(command) {
  const lyrics = command?.lyrics;
  if (!lyrics || typeof lyrics !== 'object' || Array.isArray(lyrics)
    || typeof lyrics.videoId !== 'string' || !VIDEO_ID_RE.test(lyrics.videoId)
    || !Number.isSafeInteger(lyrics.offsetMs) || !Array.isArray(lyrics.lines)
    || lyrics.lines.length > MAX_LYRIC_LINES) return null;
  const lines = [];
  let previousLineTime = -1;
  let totalLength = 0;
  for (const line of lyrics.lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)
      || !Number.isSafeInteger(line.timeMs) || line.timeMs < 0 || line.timeMs < previousLineTime
      || typeof line.text !== 'string' || line.text.length > MAX_LYRIC_LINE_LENGTH
      || !isSafeYouTubeLyricHtml(line.text)) return null;
    totalLength += line.text.length;
    if (totalLength > MAX_LYRIC_TOTAL_LENGTH) return null;
    const words = line.words == null ? null : line.words;
    if (words !== null && (!Array.isArray(words) || words.length < 2 || words.length > MAX_WORD_POINTS)) return null;
    const normalizedWords = words === null ? null : [];
    let previousWordIndex = -1;
    let previousWordTime = -1;
    for (const word of words || []) {
      if (!Array.isArray(word) || word.length !== 2
        || !Number.isSafeInteger(word[0]) || word[0] < 0 || word[0] < previousWordIndex
        || !Number.isSafeInteger(word[1]) || word[1] < 0 || word[1] < previousWordTime) return null;
      previousWordIndex = word[0];
      previousWordTime = word[1];
      normalizedWords.push([word[0], word[1]]);
    }
    previousLineTime = line.timeMs;
    lines.push({ timeMs: line.timeMs, text: line.text, words: normalizedWords });
  }
  return { videoId: lyrics.videoId, offsetMs: lyrics.offsetMs, lines };
}

function getVideoId(url = typeof location !== 'undefined' ? location.href : '') {
  try {
    const value = new URL(url).searchParams.get('v');
    return typeof value === 'string' && VIDEO_ID_RE.test(value) ? value : '';
  } catch {
    return '';
  }
}

function createYouTubeNavigationTracker() {
  let videoId = '';
  let revision = 0;
  return {
    observe(nextVideoId) {
      const valid = VIDEO_ID_RE.test(nextVideoId || '') ? nextVideoId : '';
      if (!valid) {
        videoId = '';
        return { changed: false, videoId: '', revision };
      }
      if (valid === videoId) return { changed: false, videoId, revision };
      videoId = valid;
      revision += 1;
      return { changed: true, videoId, revision };
    },
  };
}

function applyYouTubeControlAction(state = {}, action) {
  const next = {
    visible: state.visible !== false,
    keySemitones: Number.isSafeInteger(state.keySemitones) ? Math.max(-6, Math.min(6, state.keySemitones)) : 0,
    offsetMs: Number.isSafeInteger(state.offsetMs) ? state.offsetMs : 0,
  };
  if (action === 'toggle_lyrics') next.visible = !next.visible;
  if (action === 'key_down') next.keySemitones = Math.max(-6, next.keySemitones - 1);
  if (action === 'key_up') next.keySemitones = Math.min(6, next.keySemitones + 1);
  if (action === 'key_zero') next.keySemitones = 0;
  if (action === 'offset_down') next.offsetMs -= 100;
  if (action === 'offset_up') next.offsetMs += 100;
  if (action === 'offset_zero') next.offsetMs = 0;
  return next;
}

function getYouTubeOverlayMarkup() {
  return '<div class="kanaric-lyrics-lines"><div class="kline slot-top" data-slot="slot-top"><span class="kbase"></span><span class="kover"></span></div><div class="kline slot-bottom" data-slot="slot-bottom"><span class="kbase"></span><span class="kover"></span></div></div>';
}

function shouldRefreshYouTubeChromeMutations(records, overlay, overlayStyle, hint = null, pitchOverlay = null, pitchOverlayStyle = null) {
  const owned = (node) => node === overlay || node === overlayStyle || node === hint
    || node === pitchOverlay || node === pitchOverlayStyle
    || node?.id === 'kanaric-youtube-lyrics' || node?.id === 'kanaric-youtube-lyrics-hint'
    || node?.id === 'kanaric-youtube-pitch' || node?.id === 'kanaric-youtube-pitch-style'
    || !!overlay?.contains?.(node) || !!hint?.contains?.(node)
    || !!pitchOverlay?.contains?.(node);
  return Array.from(records || []).some((record) => {
    if (owned(record.target)) return false;
    const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return changed.length === 0 || changed.some((node) => !owned(node));
  });
}

function normalizeLyricsStatus(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'status', 'error'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_status'
    || !VIDEO_ID_RE.test(message.videoId)
    || !['searching', 'loaded', 'no_lyrics', 'error'].includes(message.status)) return null;
  const error = message.error;
  if (error !== null && error !== undefined
    && (!error || typeof error !== 'object' || Array.isArray(error)
      || typeof error.code !== 'string' || typeof error.message !== 'string'
      || error.code.length > 100 || error.message.length > 500)) return null;
  return {
    type: message.type,
    videoId: message.videoId,
    status: message.status,
    error: error || null,
  };
}

function getYouTubeLyricsHint(status) {
  return status === 'no_lyrics' || status === 'error'
    ? '找不到歌詞／查詢失敗，從 Kanaric 把手查看備選' : '';
}

function normalizeYouTubeLyricsOptions(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'status', 'options', 'error'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_options'
    || !VIDEO_ID_RE.test(message.videoId)
    || !Number.isSafeInteger(message.revision) || message.revision < 0
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
  const normalized = { type: message.type, videoId: message.videoId, revision: message.revision, status: message.status, options };
  if (message.error !== undefined) {
    if (typeof message.error !== 'string' || message.error.length > 500) return null;
    normalized.error = message.error;
  }
  return normalized;
}

function createYouTubeLyricsOptionsRequest(state) {
  if (!state || typeof state !== 'object' || !VIDEO_ID_RE.test(state.videoId || '')
    || !Number.isSafeInteger(state.revision) || state.revision < 0) return null;
  const title = typeof state.title === 'string' ? state.title.trim() : '';
  const artist = typeof state.channel === 'string' ? state.channel.trim() : '';
  if (!title || !artist || title.length > 200 || artist.length > 200) return null;
  return { type: 'youtube_karaoke_lyrics_options_request', videoId: state.videoId, revision: state.revision, title, artist };
}

function createYouTubeLyricsOptionSelect(videoId, revision, optionId) {
  if (!VIDEO_ID_RE.test(videoId || '') || !Number.isSafeInteger(revision) || revision < 0
    || typeof optionId !== 'string' || !OPTION_ID_RE.test(optionId)) return null;
  return { type: 'youtube_karaoke_lyrics_option_select', videoId, revision, optionId };
}

const PITCH_STATUSES = new Set(['enabled', 'stopped', 'error']);
const MAX_PITCH_FRAME_TIME_MS = 86400000;
const PITCH_WINDOW_MS = 15000;

function normalizeYouTubePitchStatus(message) {
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

function normalizeYouTubePitchFrame(message) {
  const frame = message?.frame;
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 4
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'frame'].includes(key))
    || message.type !== 'youtube_karaoke_pitch_frame' || !VIDEO_ID_RE.test(message.videoId || '')
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

function isCurrentYouTubePitchIdentity(message, videoId, revision) {
  return !!message && message.videoId === videoId
    && message.revision === revision && Number.isSafeInteger(revision) && revision >= 1;
}

function formatPitchNote(midi) {
  if (midi == null || !Number.isFinite(Number(midi))) return '—';
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const rounded = Math.round(Number(midi));
  return `${names[(rounded % 12 + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function formatPitchError(error) {
  const labels = {
    NotAllowedError: '麥克風權限被拒絕，請允許 Chrome 使用麥克風',
    NotFoundError: '找不到可用的麥克風',
    NotReadableError: '麥克風被其他程式占用或無法讀取',
    SecurityError: 'Chrome 阻擋了麥克風存取',
    'microphone-request-timeout': 'Chrome 沒有回應麥克風請求，請重新整理 YouTube 分頁後再重試',
    'microphone-unavailable': '目前 Chrome context 不支援麥克風',
    'media-recorder-unavailable': '目前瀏覽器不支援本機錄音',
    'microphone-recording-failed': '本機錄音失敗',
    'offscreen-unavailable': 'Kanaric 音訊背景頁面無法啟動',
    'offscreen-no-response': 'Kanaric 音訊背景頁面沒有回應',
  };
  const code = typeof error === 'string' ? error : '';
  return labels[code] || (code ? `麥克風無法啟用（${code.slice(0, 120)}）` : '麥克風無法啟用');
}

function applyYouTubePitchStatus(state, command) {
  if (command?.status === 'enabled') {
    return {
      ...state,
      enabled: true,
      status: 'enabled',
      error: '',
      permissionRequired: false,
    };
  }
  return {
    enabled: false,
    status: command?.status || 'stopped',
    error: command?.error?.message || '',
    permissionRequired: false,
    frames: [],
    latest: null,
  };
}

function getYouTubePitchOverlayMarkup() {
  return '<canvas class="kanaric-pitch-canvas" width="600" height="180" aria-hidden="true"></canvas><div class="kanaric-pitch-reading"><strong class="kanaric-pitch-note">目前音名 —</strong><span class="kanaric-pitch-confidence">信心度 —</span><span class="kanaric-pitch-status">音高紀錄已啟用 · 等待音高</span></div>';
}

function drawYouTubePitchTrail(canvas, frames = []) {
  const context = canvas?.getContext?.('2d');
  if (!context) return;
  const points = Array.isArray(frames) ? frames : [];
  const width = Number(canvas.width) > 0 ? Number(canvas.width) : 600;
  const height = Number(canvas.height) > 0 ? Number(canvas.height) : 180;
  const latest = Number(points[points.length - 1]?.timeMs ?? 0);
  const start = Math.max(0, latest - PITCH_WINDOW_MS);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255,255,255,0.3)';
  context.lineWidth = 1;
  for (const midi of [36, 60, 84]) {
    const y = height - ((midi - 36) / 48) * height;
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
  }
  context.strokeStyle = '#b8f7dc';
  context.lineWidth = 2;
  context.beginPath();
  let previous = null;
  for (const frame of points) {
    if (frame.timeMs < start || !frame.voiced || !Number.isFinite(Number(frame.midi))) {
      previous = null;
      continue;
    }
    const x = Math.max(0, Math.min(width, ((frame.timeMs - start) / PITCH_WINDOW_MS) * width));
    const y = height - (Math.max(36, Math.min(84, frame.midi)) - 36) / 48 * height;
    const gapMs = previous ? frame.timeMs - previous.timeMs : Infinity;
    if (!previous || gapMs > 150 || gapMs < 0) context.moveTo(x, y);
    else context.lineTo(x, y);
    previous = frame;
  }
  context.stroke();
}

function isYouTubeContentCommand(command) {
  return !!command && typeof command === 'object'
    && ['load', 'play', 'pause', 'seek', 'report'].includes(command.action);
}

function readYouTubeVideo(doc = document) {
  return doc.querySelector('video.html5-main-video') || doc.querySelector('video');
}

function stateName(input) {
  if (input.blockedCode) return 'error';
  if (input.isAd) return 'ad';
  if (input.isLoading || input.playerState === -1) return 'loading';
  if (input.isBuffering || input.playerState === 3) return 'buffering';
  if (input.playerState === 1) return 'playing';
  if (input.playerState === 2) return 'paused';
  if (input.playerState === 3) return 'buffering';
  if (input.playerState === 0 && Number.isFinite(input.duration) && input.duration > 0) return 'ended';
  return 'idle';
}

function classifyYouTubeBlock(text, hasErrorElement) {
  const bodyText = typeof text === 'string' ? text : '';
  if (/sign in to confirm your age/i.test(bodyText)) return { code: 'youtube-sign-in-required', message: 'Sign in to confirm your age' };
  if (/age-restricted|confirm your age/i.test(bodyText)) return { code: 'youtube-age-restricted', message: 'YouTube age restriction' };
  if (hasErrorElement) return { code: 'youtube-video-unavailable', message: 'YouTube video unavailable' };
  return null;
}

function projectYouTubeState(input) {
  const currentTime = Number.isFinite(input?.currentTime) && input.currentTime >= 0 ? input.currentTime : 0;
  const duration = Number.isFinite(input?.duration) && input.duration >= 0 ? input.duration : 0;
  const blockedCode = typeof input?.blockedCode === 'string' && input.blockedCode ? input.blockedCode : null;
  return {
    type: 'youtube_karaoke_state',
    state: {
      revision: Number.isSafeInteger(input?.revision) && input.revision >= 0 ? input.revision : 0,
      videoId: VIDEO_ID_RE.test(input?.videoId || '') ? input.videoId : '',
      title: typeof input?.title === 'string' ? input.title.slice(0, 200) : '',
      channel: typeof input?.channel === 'string' ? input.channel.slice(0, 200) : (typeof input?.channelTitle === 'string' ? input.channelTitle.slice(0, 200) : ''),
      state: stateName(input || {}),
      positionMs: Math.min(Number.MAX_SAFE_INTEGER, Math.round(currentTime * 1000)),
      durationMs: Math.min(Number.MAX_SAFE_INTEGER, Math.round(duration * 1000)),
      keySemitones: Number.isSafeInteger(input?.keySemitones) && input.keySemitones >= -6 && input.keySemitones <= 6 ? input.keySemitones : 0,
      error: blockedCode ? { code: blockedCode.slice(0, 100), message: String(input.blockedMessage || blockedCode).slice(0, 500) } : null,
    },
  };
}

function createStateReporter(send) {
  let last = null;
  const endedRevisions = new Set();

  return {
    report(message) {
      if (!message?.state) return false;
      const next = message.state;
      const previous = last?.state;
      if (next.state === 'ended' && endedRevisions.has(next.revision)) return false;
      const sameTrack = previous
        && previous.revision === next.revision
        && previous.videoId === next.videoId
        && previous.title === next.title
        && previous.channel === next.channel
        && previous.state === next.state
        && previous.keySemitones === next.keySemitones
        && JSON.stringify(previous.error) === JSON.stringify(next.error);
      if (sameTrack && Math.abs(previous.positionMs - next.positionMs) < 200) return false;
      if (next.state === 'ended') endedRevisions.add(next.revision);
      last = message;
      send(message);
      return true;
    },
    replay() {
      if (!last) return false;
      send(last);
      return true;
    },
  };
}

function readYouTubeInput(video, revision, keySemitones = 0) {
  const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '');
  const channel = document.querySelector('ytd-channel-name yt-formatted-string')?.textContent?.trim() || '';
  const blocked = classifyYouTubeBlock(
    document.body?.innerText || '',
    !!document.querySelector('[is-age-restricted], .age-gate, .ytp-error, ytd-player-error-message-renderer'),
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
    playerState: !video ? -1 : (video.ended ? 0 : (isBuffering ? 3 : (video.paused ? 2 : 1))),
    isAd: !!document.querySelector('.ad-showing, video.ad-video'),
    blockedCode: blocked?.code || null,
    blockedMessage: blocked?.message || null,
    isLoading,
    isBuffering,
    keySemitones,
  };
}

function startYouTubeContentRuntime() {
  if (typeof chrome === 'undefined' || !chrome.runtime || typeof document === 'undefined') return null;
  let active = false;
  let revision = 0;
  let keySemitones = 0;
  let pendingSeekMs = null;
  let lyricPayload = null;
  let slotLines = [];
  let currentIndex = -1;
  let renderedIndex = -2;
  let renderedNextIndex = -2;
  let overlay = null;
  let overlayStyle = null;
  let pitchOverlay = null;
  let pitchOverlayStyle = null;
  let hint = null;
  let fullscreenHint = null;
  let controlObserver = null;
  let frameId = null;
  let stopped = false;
  const navigation = createYouTubeNavigationTracker();
  let lyricStatus = 'searching';
  let connectionState = 'disconnected';
  let connectionError = '';
  let controlState = { visible: true, keySemitones: 0, offsetMs: 0 };
  let optionsState = null;
  let pitchState = { enabled: false, status: 'stopped', error: '', permissionRequired: false, frames: [], latest: null };
  let lyricSearchWatchdog;
  let watchdogVideoId = '';
  let timer = null;
  let recoveryTimer = null;
  let endedListenerBound = false;
  let fullscreenListenerBound = false;
  let appOwnedVideoId = '';
  let appOwnedRevision = -1;
  const reporter = createStateReporter((message) => chrome.runtime.sendMessage(message));
  const read = () => readYouTubeVideo();

  const hideOverlay = () => {
    if (overlay) overlay.hidden = true;
  };

  const clearLyricsHint = () => {
    hint?.remove?.();
    hint = null;
  };

  const clearFullscreenHint = () => {
    fullscreenHint?.remove?.();
    fullscreenHint = null;
  };

  const clearPitchOverlay = () => {
    pitchOverlay?.remove?.();
    pitchOverlayStyle?.remove?.();
    pitchOverlay = null;
    pitchOverlayStyle = null;
  };

  const resetPitchState = () => {
    pitchState = { enabled: false, status: 'stopped', error: '', permissionRequired: false, frames: [], latest: null };
    clearPitchOverlay();
  };

  const updatePitchOverlay = () => {
    const player = document.querySelector('.html5-video-player');
    const video = read();
    const currentVideoId = getVideoId();
    const eligible = active && connectionState === 'connected' && pitchState.enabled
      && currentVideoId === appOwnedVideoId
      && Number.isSafeInteger(appOwnedRevision) && appOwnedRevision >= 1
      && revision === appOwnedRevision && !!player && !!video && video.readyState > 0;
    if (!eligible) {
      clearPitchOverlay();
      return null;
    }
    if (!pitchOverlay) {
      pitchOverlay = document.createElement('div');
      pitchOverlay.id = 'kanaric-youtube-pitch';
      pitchOverlay.setAttribute('role', 'status');
      pitchOverlay.setAttribute('aria-live', 'polite');
      pitchOverlay.setAttribute('aria-label', '音高紀錄');
      pitchOverlay.style.cssText = 'position:absolute;z-index:58;left:0;right:0;top:0;height:33%;pointer-events:none;color:#fff;font:600 15px/1.35 sans-serif;text-shadow:0 1px 3px #000;';
      pitchOverlay.innerHTML = getYouTubePitchOverlayMarkup();
    }
    if (!pitchOverlayStyle) {
      pitchOverlayStyle = document.createElement('style');
      pitchOverlayStyle.id = 'kanaric-youtube-pitch-style';
      pitchOverlayStyle.textContent = `
#kanaric-youtube-pitch {
  position: absolute;
  z-index: 58;
  left: 0;
  right: 0;
  top: 0;
  height: 33%;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(0, 0, 0, .78), rgba(0, 0, 0, .36) 65%, transparent);
  pointer-events: none;
}
#kanaric-youtube-pitch[hidden], #kanaric-youtube-pitch-style[hidden] { display: none !important; }
#kanaric-youtube-pitch .kanaric-pitch-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; opacity: .9; pointer-events: none; }
#kanaric-youtube-pitch .kanaric-pitch-reading { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; padding: 12px 16px; pointer-events: none; }
#kanaric-youtube-pitch .kanaric-pitch-note { font-size: 18px; }
#kanaric-youtube-pitch .kanaric-pitch-confidence, #kanaric-youtube-pitch .kanaric-pitch-status { font-size: 14px; }
#kanaric-youtube-pitch .kanaric-pitch-status { flex-basis: 100%; }
@media (prefers-reduced-motion: reduce) { #kanaric-youtube-pitch, #kanaric-youtube-pitch * { transition: none !important; animation: none !important; } }
`;
    }
    if (pitchOverlay.parentNode !== player) player.appendChild(pitchOverlay);
    if (pitchOverlayStyle.parentNode !== player) player.appendChild(pitchOverlayStyle);
    pitchOverlay.hidden = false;
    const canvas = pitchOverlay.querySelector('.kanaric-pitch-canvas');
    if (canvas && canvas.__pitchFrame !== pitchState.latest) {
      drawYouTubePitchTrail(canvas, pitchState.frames);
      canvas.__pitchFrame = pitchState.latest;
    }
    const latest = pitchState.latest;
    const note = pitchOverlay.querySelector('.kanaric-pitch-note');
    const confidence = pitchOverlay.querySelector('.kanaric-pitch-confidence');
    const status = pitchOverlay.querySelector('.kanaric-pitch-status');
    const noteText = `目前音名 ${latest?.voiced ? formatPitchNote(latest.midi) : '—'}`;
    const confidenceText = latest ? `信心度 ${Math.round(Math.max(0, Math.min(1, Number(latest.confidence) || 0)) * 100)}%` : '信心度 —';
    const statusText = latest
      ? (latest.octaveWarning || !latest.voiced ? '麥克風已啟用 · 信心不足' : '麥克風已啟用')
      : '音高紀錄已啟用 · 等待音高';
    if (note && note.textContent !== noteText) note.textContent = noteText;
    if (confidence && confidence.textContent !== confidenceText) confidence.textContent = confidenceText;
    if (status && status.textContent !== statusText) status.textContent = statusText;
    return pitchOverlay;
  };

  const updateFullscreenHint = () => {
    const player = document.querySelector('.html5-video-player');
    const video = read();
    const currentVideoId = getVideoId();
    const ready = !!player && !!video && video.readyState > 0
      && !!player.querySelector?.('.ytp-fullscreen-button');
    const eligible = active && connectionState === 'connected'
      && currentVideoId === appOwnedVideoId
      && Number.isSafeInteger(appOwnedRevision) && revision === appOwnedRevision
      && ready && !document.fullscreenElement;
    if (!eligible) {
      clearFullscreenHint();
      return;
    }
    if (!fullscreenHint) {
      fullscreenHint = document.createElement('div');
      fullscreenHint.id = 'kanaric-youtube-fullscreen-hint';
      fullscreenHint.setAttribute('role', 'status');
      fullscreenHint.setAttribute('aria-live', 'polite');
      if (fullscreenHint.style) fullscreenHint.style.cssText = 'position:absolute;z-index:61;left:3%;right:3%;top:16px;pointer-events:none;color:#fff;text-align:center;text-shadow:0 1px 3px #000;font:600 14px/1.4 sans-serif;';
    }
    if (fullscreenHint.parentNode !== player) player.appendChild(fullscreenHint);
    if (fullscreenHint.hidden) fullscreenHint.hidden = false;
    if (fullscreenHint.textContent !== YOUTUBE_FULLSCREEN_HINT) fullscreenHint.textContent = YOUTUBE_FULLSCREEN_HINT;
  };

  const updateLyricsHint = () => {
    const text = active ? getYouTubeLyricsHint(lyricStatus) : '';
    if (!text) {
      clearLyricsHint();
      return;
    }
    const player = document.querySelector('.html5-video-player');
    if (!player) {
      clearLyricsHint();
      return;
    }
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'kanaric-youtube-lyrics-hint';
      hint.setAttribute('role', 'status');
      hint.setAttribute('aria-live', 'polite');
      if (hint.style) hint.style.cssText = 'position:absolute;z-index:60;left:3%;right:3%;bottom:16px;pointer-events:none;color:#fff;text-align:center;text-shadow:0 1px 3px #000;font:600 14px/1.4 sans-serif;';
    }
    if (hint.parentNode !== player) player.appendChild(hint);
    if (hint.hidden) hint.hidden = false;
    if (hint.textContent !== text) hint.textContent = text;
  };

  const ensureOverlay = () => {
    const player = document.querySelector('.html5-video-player');
    if (!player) return null;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kanaric-youtube-lyrics';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.hidden = true;
      overlay.innerHTML = getYouTubeOverlayMarkup();
    }
    if (!overlayStyle) {
      overlayStyle = document.createElement('style');
      overlayStyle.textContent = `
#kanaric-youtube-lyrics {
  position: absolute;
  z-index: 59;
  left: 3%;
  right: 3%;
  bottom: max(72px, 12%);
  pointer-events: none;
  font-family: Poppins, "Microsoft JhengHei", "Noto Sans JP", sans-serif;
}
#kanaric-youtube-lyrics[hidden] { display: none !important; }
#kanaric-youtube-lyrics .kanaric-lyrics-lines { display: grid; gap: .12em; text-shadow: 0 2px 4px #000, 0 0 8px #000; pointer-events: none; }
#kanaric-youtube-lyrics .kline { display: none; position: relative; max-width: 100%; font-size: clamp(28px, 4.2vw, 68px); font-weight: 700; line-height: 1.35; }
#kanaric-youtube-lyrics .kline.slot-top, #kanaric-youtube-lyrics .kline.slot-bottom { display: block; }
#kanaric-youtube-lyrics .kline.slot-top { text-align: left; }
#kanaric-youtube-lyrics .kline.slot-bottom { text-align: right; }
#kanaric-youtube-lyrics .kline.cur, #kanaric-youtube-lyrics .kline.done { display: block; }
#kanaric-youtube-lyrics .kbase, #kanaric-youtube-lyrics .kover { display: block; white-space: normal; overflow-wrap: anywhere; paint-order: stroke fill; }
#kanaric-youtube-lyrics .kbase, #kanaric-youtube-lyrics .kbase rt { color: #fff; -webkit-text-stroke: .06em #000; }
#kanaric-youtube-lyrics .kover { color: #e60012; -webkit-text-stroke: .06em #000; }
#kanaric-youtube-lyrics .kover rt { color: #fff; -webkit-text-stroke: .06em #000; }
#kanaric-youtube-lyrics .kover rt.rt-pending, #kanaric-youtube-lyrics .kover rt.rt-now, #kanaric-youtube-lyrics .kover rt.rt-sung, #kanaric-youtube-lyrics .kline.done .kover rt { color: #e60012; -webkit-text-stroke: .06em #000; }
#kanaric-youtube-lyrics .kover { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
#kanaric-youtube-lyrics .kline.cur .kover, #kanaric-youtube-lyrics .kline.done .kover { opacity: 1; }
#kanaric-youtube-lyrics .kline rt { font-size: .45em; transform: translateY(-2px); }
#kanaric-youtube-lyrics .kover .kc, #kanaric-youtube-lyrics .kover rt.rt-pending, #kanaric-youtube-lyrics .kover rt.rt-now, #kanaric-youtube-lyrics .kover rt.rt-sung { --k: 0%; clip-path: inset(-.2em calc(100% - var(--k)) -.2em 0); transition: none; }
#kanaric-youtube-lyrics .kover .kc.sung, #kanaric-youtube-lyrics .kover rt.rt-sung { --k: 100%; clip-path: none; }
#kanaric-youtube-lyrics .kline.done .kover .kc, #kanaric-youtube-lyrics .kline.done .kover rt { --k: 100% !important; clip-path: none !important; }
#kanaric-youtube-lyrics ruby { display: ruby; ruby-position: over; }
#kanaric-youtube-lyrics rt { display: ruby-text; visibility: visible !important; opacity: 1 !important; }
`;
    }
    if (overlay.parentNode !== player) player.appendChild(overlay);
    if (overlayStyle.parentNode !== player) player.appendChild(overlayStyle);
    return overlay;
  };

  const observeYouTubeChrome = () => {
    if (controlObserver || typeof MutationObserver !== 'function') return;
    const observeTarget = document.body || document.documentElement;
    if (!observeTarget) return;
    controlObserver = new MutationObserver((records) => {
      if (stopped) return;
      if (!shouldRefreshYouTubeChromeMutations(records, overlay, overlayStyle, hint, pitchOverlay, pitchOverlayStyle)) return;
      if (active) {
        ensureOverlay();
        updatePitchOverlay();
        updateLyricsHint();
        updateFullscreenHint();
      }
    });
    controlObserver.observe(observeTarget, { childList: true, subtree: true });
  };

  const updateControls = () => {
    // The App owns all visible controls; retain this state hook for nonvisual fallback diagnostics.
    updatePitchOverlay();
    updateLyricsHint();
    updateFullscreenHint();
    return connectionError;
  };
  lyricSearchWatchdog = createLyricsSearchWatchdog({
    onTimeout: (videoId) => {
      if (getVideoId() !== videoId || lyricStatus !== 'searching') return;
      lyricStatus = 'error';
      updateControls();
    },
  });

  const renderLine = (target, line) => {
    if (!target) return;
    target.className = `kline ${target.dataset.slot || ''}`;
    const base = target.querySelector('.kbase');
    const over = target.querySelector('.kover');
    const text = line && line.text !== '♫' ? line.text : '';
    setSafeLyricHtml(base, text);
    setSafeLyricHtml(over, text);
    karaokeSplit(base);
    karaokeSplit(over);
    target.hidden = !text;
  };

  const clearRenderedLyrics = () => {
    const linesRoot = overlay?.querySelector('.kanaric-lyrics-lines');
    if (!linesRoot) return;
    linesRoot.querySelectorAll('.kline').forEach((line) => renderLine(line, null));
    linesRoot.hidden = true;
  };

  const paintLyrics = () => {
    if (!active) {
      hideOverlay();
      return;
    }
    const video = read();
    const currentId = getVideoId();
    if (!video || !currentId) {
      hideOverlay();
      return;
    }
    const root = ensureOverlay();
    if (!root) return;
    root.hidden = false;
    const linesRoot = root.querySelector('.kanaric-lyrics-lines');
    if (!lyricPayload || currentId !== lyricPayload.videoId || video.ended
      || document.querySelector('.ad-showing, video.ad-video') || !lyricPayload.lines.length) {
      if (linesRoot) linesRoot.hidden = true;
      return;
    }
    if (linesRoot) linesRoot.hidden = !controlState.visible;
    const effectiveOffsetMs = lyricPayload.offsetMs + controlState.offsetMs;
    const slots = karaokeSlots(slotLines, (video.currentTime * 1000 - effectiveOffsetMs) / 1000, currentIndex);
    if (slots.index < 0) {
      if (linesRoot) linesRoot.hidden = true;
      return;
    }
    const topChanged = slots.top !== renderedIndex;
    const bottomChanged = slots.bottom !== renderedNextIndex;
    currentIndex = slots.index;
    const top = root.querySelector('.kline.slot-top');
    const bottom = root.querySelector('.kline.slot-bottom');
    if (top) {
      top.dataset.slot = 'slot-top';
      if (topChanged) renderLine(top, lyricPayload.lines[slots.top]);
      top.classList.toggle('cur', slots.top === slots.index);
      top.classList.toggle('done', slots.top !== slots.index && slots.top >= 0 && slots.top < slots.index);
    }
    if (bottom) {
      bottom.dataset.slot = 'slot-bottom';
      if (bottomChanged) renderLine(bottom, lyricPayload.lines[slots.bottom]);
      bottom.classList.toggle('cur', slots.bottom === slots.index);
      bottom.classList.toggle('done', slots.bottom !== slots.index && slots.bottom >= 0 && slots.bottom < slots.index);
    }
    renderedIndex = slots.top;
    renderedNextIndex = slots.bottom;
    const currentLine = lyricPayload.lines[slots.index];
    if (currentLine.words && currentLine.words.length >= 2) {
      const currentRoot = root.querySelector('.kline.cur .kover');
      karaokePaint(currentRoot, currentLine.words,
        video.currentTime * 1000 - effectiveOffsetMs - currentLine.timeMs);
    }
  };

  const handleLegacyControlAction = (action) => {
    if (action === 'key_down' || action === 'key_up' || action === 'key_zero') {
      const desired = applyYouTubeControlAction(controlState, action).keySemitones;
      if (desired === controlState.keySemitones && action !== 'key_zero') return Promise.resolve({ ok: true });
      return Promise.resolve(chrome.runtime.sendMessage({ type: 'youtube_karaoke_set_key', semitones: desired }))
        .then((response) => {
          if (!response?.ok) return response;
          controlState = applyYouTubeControlAction(controlState, action);
          keySemitones = controlState.keySemitones;
          return response;
        })
        .catch(() => ({ ok: false, error: 'set-key-failed' }));
    }
    if (action === 'pitch_toggle' || action === 'pitch_retry') {
      return Promise.resolve({ ok: false, error: 'app-owned-pitch' });
    }
    controlState = applyYouTubeControlAction(controlState, action);
    if (action.startsWith('offset_')) paintLyrics();
    return Promise.resolve(controlState);
  };

  const report = () => {
    if (!active) return false;
    const video = read();
    const currentVideoId = getVideoId();
    const navigationState = navigation.observe(currentVideoId);
    if (navigationState.changed) {
      if (!currentVideoId || currentVideoId !== appOwnedVideoId) {
        appOwnedVideoId = '';
        appOwnedRevision = -1;
      }
      resetPitchState();
      lyricSearchWatchdog.stop();
      revision = navigationState.revision;
      keySemitones = 0;
      controlState = { visible: true, keySemitones: 0, offsetMs: 0 };
      lyricPayload = null;
      optionsState = null;
      lyricStatus = 'searching';
      currentIndex = -1;
      renderedIndex = -2;
      renderedNextIndex = -2;
      updateControls();
    }
    if (!currentVideoId || (appOwnedVideoId && currentVideoId !== appOwnedVideoId)) {
      appOwnedVideoId = '';
      appOwnedRevision = -1;
      resetPitchState();
    }
    if (pendingSeekMs !== null && video && video.readyState >= 1) {
      video.currentTime = pendingSeekMs / 1000;
      pendingSeekMs = null;
    }
    const projected = projectYouTubeState(readYouTubeInput(video, revision, keySemitones));
    if (projected.state.state === 'ended' && getYouTubeLyricsHint(lyricStatus)) {
      lyricSearchWatchdog.stop();
      lyricStatus = 'searching';
      updateControls();
    }
    reporter.report(projected);
    updatePitchOverlay();
    updateFullscreenHint();
  };
  const stopActiveLoops = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (recoveryTimer !== null) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    if (endedListenerBound) {
      document.removeEventListener('ended', report, true);
      endedListenerBound = false;
    }
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  const animate = () => {
    if (!active || stopped) return;
    paintLyrics();
    frameId = requestAnimationFrame(animate);
  };

  const deactivate = (notify = false) => {
    resetPitchState();
    stopActiveLoops();
    active = false;
    lyricSearchWatchdog.stop();
    watchdogVideoId = '';
    lyricPayload = null;
    optionsState = null;
    slotLines = [];
    currentIndex = -1;
    renderedIndex = -2;
    renderedNextIndex = -2;
    lyricStatus = 'searching';
    keySemitones = 0;
    controlState = { ...controlState, keySemitones: 0 };
    connectionError = '';
    appOwnedVideoId = '';
    appOwnedRevision = -1;
    clearRenderedLyrics();
    clearLyricsHint();
    clearFullscreenHint();
    overlay?.remove();
    overlayStyle?.remove();
    overlay = null;
    overlayStyle = null;
    if (!stopped) {
      observeYouTubeChrome();
    }
    if (notify) Promise.resolve(chrome.runtime.sendMessage({
      type: 'youtube_karaoke_activation', active: false, source: 'youtube',
    })).catch(() => {});
    return true;
  };

  const activate = (source = 'app') => {
    if (source !== 'app') return false;
    if (stopped || active) return false;
    active = true;
    observeYouTubeChrome();
    timer = setInterval(report, 250);
    recoveryTimer = setInterval(() => reporter.replay(), SOCKET_RECOVERY_REPORT_MS);
    document.addEventListener('ended', report, true);
    endedListenerBound = true;
    report();
    paintLyrics();
    frameId = requestAnimationFrame(animate);
    return true;
  };

  const handleFullscreenChange = () => {
    if (document.fullscreenElement) clearFullscreenHint();
    else updateFullscreenHint();
  };
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  fullscreenListenerBound = true;

  function handleRuntimeMessage(command) {
    if (command?.type === 'youtube_karaoke_activation') {
      const activation = normalizeYouTubeActivationMessage(command);
      if (!activation) return;
      if (activation.active) activate(activation.source);
      else deactivate();
      return;
    }
    if (!active) return;
    if (command?.type === 'youtube_karaoke_connection') {
      connectionState = typeof command.state === 'string' ? command.state : 'disconnected';
      connectionError = typeof command.error === 'string' ? command.error : '';
      if (connectionState === 'disconnected') clearFullscreenHint();
      if (connectionState === 'disconnected') {
        resetPitchState();
      }
      updateControls();
      return;
    }
    if (command?.type === 'youtube_karaoke_pitch_status') {
      const normalized = normalizeYouTubePitchStatus(command);
      const currentVideoId = appOwnedVideoId || getVideoId();
      const currentRevision = appOwnedRevision;
      if (!normalized || !isCurrentYouTubePitchIdentity(normalized, currentVideoId, currentRevision)) return;
      pitchState = applyYouTubePitchStatus(pitchState, normalized);
      updatePitchOverlay();
      return;
    }
    if (command?.type === 'youtube_karaoke_pitch_frame') {
      const normalized = normalizeYouTubePitchFrame(command);
      if (!normalized || !pitchState.enabled
        || !isCurrentYouTubePitchIdentity(normalized, appOwnedVideoId || getVideoId(), appOwnedRevision)) return;
      pitchState.latest = normalized.frame;
      pitchState.frames.push(normalized.frame);
      const cutoff = normalized.frame.timeMs - 15000;
      pitchState.frames = pitchState.frames.filter((item) => item.timeMs >= cutoff);
      updatePitchOverlay();
      return;
    }
    if (command?.type === 'youtube_karaoke_lyrics_reset') {
      if (command.videoId !== getVideoId()) return;
      lyricSearchWatchdog.stop();
      watchdogVideoId = '';
      lyricPayload = null;
      slotLines = [];
      currentIndex = -1;
      renderedIndex = -2;
      renderedNextIndex = -2;
      lyricStatus = 'searching';
      optionsState = null;
      clearRenderedLyrics();
      hideOverlay();
      updateControls();
      return;
    }
    if (command?.type === 'youtube_karaoke_lyrics_status') {
      const normalized = normalizeLyricsStatus(command);
      if (!normalized || normalized.videoId !== getVideoId()) return;
      if (normalized.status === 'searching') {
        if (watchdogVideoId !== normalized.videoId) {
          watchdogVideoId = normalized.videoId;
          lyricSearchWatchdog.start(normalized.videoId);
        }
      } else {
        watchdogVideoId = '';
        lyricSearchWatchdog.stop();
      }
      lyricStatus = normalized.status;
      if (!shouldRetainYouTubeLyrics(normalized.status, lyricPayload, getVideoId())) {
        lyricPayload = null;
        clearRenderedLyrics();
        hideOverlay();
      }
      updateControls();
      paintLyrics();
      return;
    }
    if (command?.type === 'youtube_karaoke_lyrics_options') {
      const normalized = normalizeYouTubeLyricsOptions(command);
      if (!normalized || normalized.videoId !== getVideoId() || normalized.revision !== revision) return;
      optionsState = normalized;
      return;
    }
    if (command?.type === 'youtube_karaoke_lyrics') {
      const normalized = normalizeYouTubeLyricPayload(command);
      if (!normalized || normalized.videoId !== getVideoId()) return;
      lyricPayload = normalized;
      slotLines = lyricPayload.lines.map((line) => ({ time: line.timeMs / 1000, text: line.text, words: line.words }));
      lyricStatus = 'loaded';
      optionsState = null;
      currentIndex = -1;
      renderedIndex = -2;
      renderedNextIndex = -2;
      updateControls();
      paintLyrics();
      return;
    }
    if (!isYouTubeContentCommand(command)) return;
    if (!active) return;
    if (command.action === 'load') {
      const nextRevision = Number.isSafeInteger(command.revision) ? command.revision : revision + 1;
      const staleRevision = Number.isSafeInteger(command.revision) && command.revision < revision;
      if (nextRevision !== revision || staleRevision) resetPitchState();
      revision = nextRevision;
      appOwnedVideoId = staleRevision || !VIDEO_ID_RE.test(command.videoId || '') ? '' : command.videoId;
      appOwnedRevision = appOwnedVideoId && Number.isSafeInteger(revision) && revision >= 0 ? revision : -1;
      pendingSeekMs = Number.isSafeInteger(command.positionMs) ? command.positionMs : 0;
      navigation.observe(getVideoId());
    }
    const video = read();
    if (!video) return;
    if (command.action === 'play') video.play().catch(() => {});
    if (command.action === 'pause') video.pause();
    if (command.action === 'seek' && Number.isSafeInteger(command.positionMs)) video.currentTime = command.positionMs / 1000;
    report();
  }
  observeYouTubeChrome();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  return {
    activate,
    deactivate,
    isActive: () => active,
    stop: () => {
      stopped = true;
      controlObserver?.disconnect();
      controlObserver = null;
      deactivate();
      if (fullscreenListenerBound) {
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
        fullscreenListenerBound = false;
      }
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    },
  };
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') startYouTubeContentRuntime();

if (typeof module !== 'undefined') module.exports = {
  projectYouTubeState,
  createStateReporter,
  classifyYouTubeBlock,
  getVideoId,
  createYouTubeNavigationTracker,
  applyYouTubeControlAction,
  getYouTubeOverlayMarkup,
  getYouTubeLyricsHint,
  shouldRefreshYouTubeChromeMutations,
  normalizeLyricsStatus,
  normalizeYouTubeLyricsOptions,
  createYouTubeLyricsOptionsRequest,
  createYouTubeLyricsOptionSelect,
  normalizeYouTubePitchStatus,
  normalizeYouTubePitchFrame,
  isCurrentYouTubePitchIdentity,
  getYouTubePitchOverlayMarkup,
  drawYouTubePitchTrail,
  formatPitchNote,
  formatPitchError,
  applyYouTubePitchStatus,
  isYouTubeContentCommand,
  readYouTubeVideo,
  selectYouTubeLyricPair,
  lyricElementPolicy,
  isSafeYouTubeLyricHtml,
  normalizeYouTubeLyricPayload,
  setSafeLyricHtml,
  normalizeYouTubeActivationMessage,
  shouldRetainYouTubeLyrics,
  lyricsSearchResponseError,
  createLyricsSearchWatchdog,
  startYouTubeContentRuntime,
};
