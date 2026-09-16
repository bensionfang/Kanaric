const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const {
  createYouTubeNavigationTracker,
  applyYouTubeControlAction,
  getYouTubeOverlayMarkup,
  normalizeLyricsStatus,
  shouldRetainYouTubeLyrics,
  lyricsSearchResponseError,
  createLyricsSearchWatchdog,
} = require('../src/youtube-content.js');
const {
  createYouTubeLyricsSearchMessage,
  normalizeSocketLyricsStatus,
  shouldForwardYouTubeMessageToTab,
} = require('../src/service-worker.js');

test('native YouTube navigation increments once per valid video and resets off watch pages', () => {
  const tracker = createYouTubeNavigationTracker();
  assert.deepEqual(tracker.observe(''), { changed: false, videoId: '', revision: 0 });
  assert.deepEqual(tracker.observe('dQw4w9WgXcQ'), { changed: true, videoId: 'dQw4w9WgXcQ', revision: 1 });
  assert.deepEqual(tracker.observe('dQw4w9WgXcQ'), { changed: false, videoId: 'dQw4w9WgXcQ', revision: 1 });
  assert.deepEqual(tracker.observe('kJQP7kiw5Fk'), { changed: true, videoId: 'kJQP7kiw5Fk', revision: 2 });
  assert.deepEqual(tracker.observe(''), { changed: false, videoId: '', revision: 2 });
  assert.deepEqual(tracker.observe('dQw4w9WgXcQ'), { changed: true, videoId: 'dQw4w9WgXcQ', revision: 3 });
});

test('YouTube control actions clamp Key, change offset by 100ms, and toggle lyrics', () => {
  let state = { visible: true, keySemitones: 6, offsetMs: 0 };
  state = applyYouTubeControlAction(state, 'key_up');
  assert.deepEqual(state, { visible: true, keySemitones: 6, offsetMs: 0 });
  state = applyYouTubeControlAction(state, 'key_zero');
  state = applyYouTubeControlAction(state, 'key_down');
  state = applyYouTubeControlAction(state, 'offset_down');
  state = applyYouTubeControlAction(state, 'toggle_lyrics');
  assert.deepEqual(state, { visible: false, keySemitones: -1, offsetMs: -100 });
  assert.deepEqual(applyYouTubeControlAction(state, 'offset_zero'), {
    visible: false, keySemitones: -1, offsetMs: 0,
  });
});

test('native overlay uses the Kanaric two-layer line structure', () => {
  const markup = getYouTubeOverlayMarkup();
  assert.match(markup, /class="kline/);
  assert.match(markup, /data-slot="slot-top"/);
  assert.match(markup, /data-slot="slot-bottom"/);
  assert.match(markup, /class="kbase"/);
  assert.match(markup, /class="kover"/);
  assert.doesNotMatch(markup, /kanaric-current|kanaric-next/);
});

test('native overlay keeps both lyric slots visible before either slot becomes active', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /#kanaric-youtube-lyrics \.kline\.slot-top, #kanaric-youtube-lyrics \.kline\.slot-bottom \{ display: block; \}/);
});

test('native overlay red lyrics use a dark outline instead of a white halo', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /#kanaric-youtube-lyrics \.kover \{ color: #e60012; -webkit-text-stroke: \.06em #000; \}/);
  assert.match(source, /#kanaric-youtube-lyrics \.kover rt\.rt-pending, #kanaric-youtube-lyrics \.kover rt\.rt-now, #kanaric-youtube-lyrics \.kover rt\.rt-sung, #kanaric-youtube-lyrics \.kline\.done \.kover rt \{ color: #e60012; -webkit-text-stroke: \.06em #000; \}/);
});

test('native overlay keeps a retained lyric line from flashing during slot changes', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  const paint = source.slice(source.indexOf('const paintLyrics = () =>'), source.indexOf('const report = () =>'));
  assert.match(paint, /const topChanged = slots\.top !== renderedIndex;/);
  assert.match(paint, /if \(topChanged\) renderLine\(top, lyricPayload\.lines\[slots\.top\]\);/);
  assert.match(paint, /const bottomChanged = slots\.bottom !== renderedNextIndex;/);
  assert.match(paint, /if \(bottomChanged\) renderLine\(bottom, lyricPayload\.lines\[slots\.bottom\]\);/);
  assert.doesNotMatch(paint, /const changed = slots\.top !== renderedIndex/);
});

test('lyrics status accepts only the current-video status contract', () => {
  assert.deepEqual(normalizeLyricsStatus({
    type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'searching', error: null,
  }), { type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'searching', error: null });
  assert.equal(normalizeLyricsStatus({
    type: 'youtube_karaoke_lyrics_status', videoId: 'bad', status: 'loaded', error: null,
  }), null);
  assert.equal(normalizeLyricsStatus({
    type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'unknown', error: null,
  }), null);
});

test('content keeps cached lyrics visible when a same-video search fails', () => {
  assert.equal(shouldRetainYouTubeLyrics('searching', { videoId: 'dQw4w9WgXcQ' }, 'dQw4w9WgXcQ'), true);
  assert.equal(shouldRetainYouTubeLyrics('loaded', { videoId: 'dQw4w9WgXcQ' }, 'dQw4w9WgXcQ'), true);
  assert.equal(shouldRetainYouTubeLyrics('no_lyrics', { videoId: 'dQw4w9WgXcQ' }, 'dQw4w9WgXcQ'), true);
  assert.equal(shouldRetainYouTubeLyrics('error', { videoId: 'dQw4w9WgXcQ' }, 'dQw4w9WgXcQ'), true);
  assert.equal(shouldRetainYouTubeLyrics('no_lyrics', { videoId: 'dQw4w9WgXcQ' }, 'kJQP7kiw5Fk'), false);
  assert.equal(shouldRetainYouTubeLyrics('no_lyrics', null, 'dQw4w9WgXcQ'), false);
});

test('content classifies a rejected search response as an error', () => {
  assert.deepEqual(lyricsSearchResponseError({ ok: false, error: 'invalid-pairing' }), {
    code: 'lyrics-search-unavailable', message: 'invalid-pairing',
  });
  assert.equal(lyricsSearchResponseError({ ok: true }), null);
});

test('content watchdog reports a still-searching video after its deadline', () => {
  const timers = [];
  const expired = [];
  const watchdog = createLyricsSearchWatchdog({
    timeoutMs: 25,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
    onTimeout: (videoId) => expired.push(videoId),
  });
  watchdog.start('dQw4w9WgXcQ');
  assert.equal(timers[0].ms, 25);
  timers[0].fn();
  assert.deepEqual(expired, ['dQw4w9WgXcQ']);
});

test('content can request a forced lookup without carrying a pairing token', () => {
  assert.deepEqual(createYouTubeLyricsSearchMessage({
    videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3,
  }), {
    type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3,
  });
  assert.equal(createYouTubeLyricsSearchMessage({ videoId: 'bad', title: 'Song', channel: 'Artist', revision: 3 }), null);
  assert.equal(JSON.stringify(createYouTubeLyricsSearchMessage({
    videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3,
  })).includes('token'), false);
});

test('service worker validates and replays only typed lyrics statuses', () => {
  const status = { type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'no_lyrics', error: null };
  assert.deepEqual(normalizeSocketLyricsStatus(status), status);
  assert.equal(normalizeSocketLyricsStatus({ ...status, status: 'loaded', error: { code: 'x' } }), null);
});

test('service worker does not replay prior-video lyrics into a new YouTube tab', () => {
  const oldLyrics = { type: 'youtube_karaoke_lyrics', lyrics: { videoId: 'dQw4w9WgXcQ' } };
  const oldStatus = { type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'loaded' };
  const current = { state: { videoId: 'kJQP7kiw5Fk' } };
  assert.equal(shouldForwardYouTubeMessageToTab(oldLyrics, current), false);
  assert.equal(shouldForwardYouTubeMessageToTab(oldStatus, current), false);
  assert.equal(shouldForwardYouTubeMessageToTab({ ...oldLyrics, lyrics: { videoId: current.state.videoId } }, current), true);
});
