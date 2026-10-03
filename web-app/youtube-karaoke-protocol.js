const fs = require('fs');
const path = require('path');
const { randomBytes: defaultRandomBytes, timingSafeEqual } = require('crypto');

const TOKEN_FILE = 'youtube-karaoke-token';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const STATES = new Set(['idle', 'loading', 'playing', 'paused', 'buffering', 'ad', 'ended', 'error']);
const COMMANDS = new Set(['load', 'play', 'pause', 'seek', 'set_key']);
const MAX_LYRIC_LINES = 1000;
const MAX_LYRIC_LINE_LENGTH = 4000;
const MAX_LYRIC_TOTAL_LENGTH = 256000;
const MAX_WORD_POINTS = 4000;
const MAX_WINDOW_DIMENSION = 32768;
const PITCH_STATUSES = new Set(['enabled', 'stopped', 'error']);
const MAX_PITCH_FRAME_TIME_MS = 86400000;
const MAX_PITCH_HZ = 5000;
const MAX_PITCH_MIDI = 200;
const MAX_PITCH_CENTS = 1200;

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value) ? value : null;
}

function normalizeText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function normalizeTrimmedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= maxLength ? text : null;
}

function normalizePitchIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !normalizeVideoId(raw.videoId)
    || !Number.isSafeInteger(raw.revision) || raw.revision < 1) return null;
  return { videoId: raw.videoId, revision: raw.revision };
}

function normalizeKaraokePitchStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 5
    || Object.keys(raw).some((key) => !['type', 'videoId', 'revision', 'status', 'error'].includes(key))
    || raw.type !== 'youtube_karaoke_pitch_status'
    || !PITCH_STATUSES.has(raw.status)) return null;
  const identity = normalizePitchIdentity(raw);
  if (!identity) return null;
  let error = null;
  if (raw.error !== null) {
    if (!raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)
      || Object.keys(raw.error).length !== 2
      || Object.keys(raw.error).some((key) => !['code', 'message'].includes(key))
      || typeof raw.error.code !== 'string' || !raw.error.code || raw.error.code.length > 100
      || typeof raw.error.message !== 'string' || !raw.error.message || raw.error.message.length > 500) return null;
    error = { code: raw.error.code, message: raw.error.message };
  }
  if (raw.status === 'error' ? !error : error !== null) return null;
  return { type: raw.type, ...identity, status: raw.status, error };
}

function normalizeKaraokePitchFrame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 4
    || Object.keys(raw).some((key) => !['type', 'videoId', 'revision', 'frame'].includes(key))
    || raw.type !== 'youtube_karaoke_pitch_frame') return null;
  const identity = normalizePitchIdentity(raw);
  const frame = raw.frame;
  if (!identity || !frame || typeof frame !== 'object' || Array.isArray(frame)
    || Object.keys(frame).length !== 7
    || Object.keys(frame).some((key) => !['timeMs', 'hz', 'midi', 'cents', 'confidence', 'voiced', 'octaveWarning'].includes(key))
    || !Number.isSafeInteger(frame.timeMs) || frame.timeMs < 0 || frame.timeMs > MAX_PITCH_FRAME_TIME_MS
    || ![frame.hz, frame.midi, frame.cents].every((value) => value === null || typeof value === 'number' && Number.isFinite(value))
    || (frame.hz !== null && (frame.hz < 0 || frame.hz > MAX_PITCH_HZ))
    || (frame.midi !== null && (frame.midi < 0 || frame.midi > MAX_PITCH_MIDI))
    || (frame.cents !== null && (frame.cents < -MAX_PITCH_CENTS || frame.cents > MAX_PITCH_CENTS))
    || typeof frame.confidence !== 'number' || !Number.isFinite(frame.confidence)
    || frame.confidence < 0 || frame.confidence > 1
    || typeof frame.voiced !== 'boolean' || typeof frame.octaveWarning !== 'boolean') return null;
  return {
    type: raw.type,
    ...identity,
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

function isSafeLyricHtml(value) {
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

function normalizeError(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = normalizeText(value.code, 100);
  const message = normalizeText(value.message, 500);
  return code && message ? { code, message } : null;
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

function normalizeExtensionState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = new Set([
    'revision', 'videoId', 'title', 'channel', 'state', 'positionMs', 'durationMs',
    'keySemitones', 'error', 'commandId', 'ownerWindowBounds',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (!isSafeNonNegativeInteger(raw.revision)) return null;
  if (!normalizeVideoId(raw.videoId)) return null;
  if (!STATES.has(raw.state)) return null;
  if (!isSafeNonNegativeInteger(raw.positionMs) || !isSafeNonNegativeInteger(raw.durationMs)) return null;
  if (!Number.isSafeInteger(raw.keySemitones) || raw.keySemitones < -6 || raw.keySemitones > 6) return null;
  const title = normalizeText(raw.title ?? '', 200);
  const channel = normalizeText(raw.channel ?? '', 200);
  if (title === null || channel === null) return null;
  const error = normalizeError(raw.error);
  if (raw.error !== null && raw.error !== undefined && error === null) return null;
  if (raw.commandId !== undefined && !isSafeNonNegativeInteger(raw.commandId)) return null;
  const ownerWindowBounds = raw.ownerWindowBounds === undefined
    ? null : normalizeOwnerWindowBounds(raw.ownerWindowBounds);
  if (raw.ownerWindowBounds !== undefined && !ownerWindowBounds) return null;
  const state = {
    revision: raw.revision,
    videoId: raw.videoId,
    title,
    channel,
    state: raw.state,
    positionMs: raw.positionMs,
    durationMs: raw.durationMs,
    keySemitones: raw.keySemitones,
    error,
  };
  if (raw.commandId !== undefined) state.commandId = raw.commandId;
  if (ownerWindowBounds) state.ownerWindowBounds = ownerWindowBounds;
  return state;
}

function normalizeKaraokeLyricsSearch(raw, currentState = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !['type', 'videoId', 'title', 'channel', 'revision', 'force'].includes(key))
    || raw.type !== 'youtube_karaoke_search') return null;
  const videoId = normalizeVideoId(raw.videoId);
  const title = normalizeTrimmedText(raw.title, 200);
  const channel = normalizeTrimmedText(raw.channel, 200);
  if (!videoId || !title || !channel || !isSafeNonNegativeInteger(raw.revision)) return null;
  if (raw.force !== undefined && typeof raw.force !== 'boolean') return null;
  if (currentState && (videoId !== currentState.videoId || raw.revision !== currentState.revision)) return null;
  const request = { videoId, title, channel, revision: raw.revision };
  if (raw.force !== undefined) request.force = raw.force;
  return request;
}

function normalizeKaraokeLyricsPrefetch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !['type', 'videoId', 'title', 'channel'].includes(key))
    || raw.type !== 'youtube_karaoke_lyrics_prefetch') return null;
  const videoId = normalizeVideoId(raw.videoId);
  const title = normalizeTrimmedText(raw.title, 200);
  const channel = normalizeTrimmedText(raw.channel, 200);
  if (!videoId || !title || !channel) return null;
  return { videoId, title, channel };
}

function normalizeKaraokeCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!COMMANDS.has(raw.action) || !isSafeNonNegativeInteger(raw.commandId)) return null;
  const allowed = {
    load: new Set(['commandId', 'action', 'videoId', 'positionMs']),
    play: new Set(['commandId', 'action']),
    pause: new Set(['commandId', 'action']),
    seek: new Set(['commandId', 'action', 'positionMs']),
    set_key: new Set(['commandId', 'action', 'semitones']),
  }[raw.action];
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const command = { commandId: raw.commandId, action: raw.action };
  if (raw.action === 'load') {
    command.videoId = normalizeVideoId(raw.videoId);
    if (!command.videoId) return null;
    command.positionMs = raw.positionMs === undefined ? 0 : raw.positionMs;
    if (!isSafeNonNegativeInteger(command.positionMs)) return null;
  } else if (raw.action === 'seek') {
    if (!isSafeNonNegativeInteger(raw.positionMs)) return null;
    command.positionMs = raw.positionMs;
  } else if (raw.action === 'set_key') {
    if (!Number.isSafeInteger(raw.semitones) || raw.semitones < -6 || raw.semitones > 6) return null;
    command.semitones = raw.semitones;
  }
  return command;
}

function normalizeKaraokeLyrics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !['videoId', 'offsetMs', 'lines'].includes(key))) return null;
  const videoId = normalizeVideoId(raw.videoId);
  if (!videoId || !Number.isSafeInteger(raw.offsetMs) || !Array.isArray(raw.lines)
      || raw.lines.length > MAX_LYRIC_LINES) return null;

  let totalLength = 0;
  let previousTime = -1;
  const lines = [];
  for (const line of raw.lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)
        || Object.keys(line).some((key) => !['timeMs', 'text', 'words'].includes(key))
        || !isSafeNonNegativeInteger(line.timeMs) || line.timeMs < previousTime
        || typeof line.text !== 'string' || line.text.length > MAX_LYRIC_LINE_LENGTH) return null;
    totalLength += line.text.length;
    if (totalLength > MAX_LYRIC_TOTAL_LENGTH || !isSafeLyricHtml(line.text)) return null;
    previousTime = line.timeMs;

    let words = null;
    if (line.words !== null && line.words !== undefined) {
      if (!Array.isArray(line.words) || line.words.length < 2 || line.words.length > MAX_WORD_POINTS) return null;
      let previousIndex = -1;
      let previousMs = -1;
      words = [];
      for (const point of line.words) {
        if (!Array.isArray(point) || point.length !== 2
            || !isSafeNonNegativeInteger(point[0]) || !isSafeNonNegativeInteger(point[1])
            || point[0] < previousIndex || point[1] < previousMs) return null;
        previousIndex = point[0];
        previousMs = point[1];
        words.push([point[0], point[1]]);
      }
    }
    lines.push({ timeMs: line.timeMs, text: line.text, words });
  }
  return { videoId, offsetMs: raw.offsetMs, lines };
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readOrCreateExtensionToken({ dataDir, randomBytes = defaultRandomBytes }) {
  const file = path.join(dataDir, TOKEN_FILE);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (!TOKEN_RE.test(existing)) throw new Error('Invalid YouTube extension token file');
    return existing;
  }
  const token = toBase64Url(randomBytes(32));
  if (!TOKEN_RE.test(token)) throw new Error('Generated invalid YouTube extension token');
  fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx' });
  return token;
}

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !TOKEN_RE.test(actual) || !TOKEN_RE.test(expected)) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

module.exports = {
  normalizeExtensionState,
  normalizeKaraokePitchStatus,
  normalizeKaraokePitchFrame,
  normalizeKaraokeLyricsSearch,
  normalizeKaraokeLyricsPrefetch,
  normalizeKaraokeCommand,
  normalizeKaraokeLyrics,
  isSafeLyricHtml,
  readOrCreateExtensionToken,
  tokenMatches,
  TOKEN_FILE,
};
