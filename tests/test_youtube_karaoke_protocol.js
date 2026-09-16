const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeExtensionState,
  normalizeKaraokeCommand,
  normalizeKaraokeLyrics,
  normalizeKaraokeLyricsSearch,
  normalizeKaraokeLyricsPrefetch,
  readOrCreateExtensionToken,
} = require('../web-app/youtube-karaoke-protocol.js');

const validLyrics = {
  videoId: 'dQw4w9WgXcQ',
  offsetMs: 300,
  lines: [
    { timeMs: 10000, text: '<ruby data-hs="0">言<rt>こと</rt></ruby>葉', words: [[0, 0], [1, 400]] },
    { timeMs: 14000, text: 'next', words: null },
  ],
};

assert.deepStrictEqual(normalizeKaraokeLyrics(validLyrics), validLyrics);
assert.deepStrictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3,
}), { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3 });
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'bad', title: 'Song', channel: 'Artist', revision: 3,
}), null);
assert.deepStrictEqual(normalizeKaraokeLyricsPrefetch({
  type: 'youtube_karaoke_lyrics_prefetch', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist',
}), { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist' });
assert.deepStrictEqual(normalizeKaraokeLyricsPrefetch({
  type: 'youtube_karaoke_lyrics_prefetch', videoId: 'dQw4w9WgXcQ', title: '  Song  ', channel: '\tArtist\n',
}), { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist' });
assert.strictEqual(normalizeKaraokeLyricsPrefetch({
  type: 'youtube_karaoke_lyrics_prefetch', videoId: 'dQw4w9WgXcQ', title: '', channel: 'Artist',
}), null);
assert.strictEqual(normalizeKaraokeLyricsPrefetch({
  type: 'youtube_karaoke_lyrics_prefetch', videoId: 'dQw4w9WgXcQ', title: 'x'.repeat(201), channel: 'Artist',
}), null);
assert.strictEqual(normalizeKaraokeLyricsPrefetch({
  type: 'youtube_karaoke_lyrics_prefetch', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', extra: true,
}), null);
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: '', channel: 'Artist', revision: 3,
}), null);
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3, token: 'secret',
}), null);
assert.deepStrictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3, force: false,
}), { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3, force: false });
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 3, force: 'false',
}), null);
assert.deepStrictEqual(normalizeKaraokeLyrics({ videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [] }), {
  videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [],
});
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, videoId: 'bad' }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, offsetMs: 0.5 }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, offsetMs: Number.MAX_SAFE_INTEGER + 1 }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, extra: true }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 20, text: 'b', words: null }, { timeMs: 10, text: 'a', words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x'.repeat(4001), words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [[1, 20], [0, 30]] }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [[0, 30], [1, 20]] }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [[0, 0, 1]] }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [[0, -1]] }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [
  { timeMs: 0, text: 'x', words: [[0, 0]] },
  { timeMs: 1, text: 'y', words: [[0, Number.MAX_SAFE_INTEGER + 1]] },
] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [
  { timeMs: 0, text: 'x', words: [[0, 0]] },
  { timeMs: 1, text: 'y', words: [[1, 20], [0, 30]] },
] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', extra: true, words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: -1, text: 'x', words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: Number.MAX_SAFE_INTEGER + 1, text: 'x', words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: 'bad' }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: '<script>alert(1)</script>', words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [] }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: [[0, 0]] }] }), null);
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'kJQP7kiw5Fk', title: 'Song', channel: 'Artist', revision: 3,
}, { videoId: 'dQw4w9WgXcQ', revision: 3 }), null);
assert.strictEqual(normalizeKaraokeLyricsSearch({
  type: 'youtube_karaoke_search', videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', revision: 2,
}, { videoId: 'dQw4w9WgXcQ', revision: 3 }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: Array.from({ length: 1001 }, (_, i) => ({ timeMs: i, text: '', words: null })) }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x'.repeat(256000), words: null }] }), null);
assert.strictEqual(normalizeKaraokeLyrics({ ...validLyrics, lines: [{ timeMs: 0, text: 'x', words: Array.from({ length: 4001 }, (_, i) => [i, i]) }] }), null);

{
  const rawState = {
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channel: 'RickAstleyVEVO',
    state: 'playing',
    positionMs: 12500,
    durationMs: 245100,
    keySemitones: -2,
    error: null,
    commandId: 12,
  };
  const state = normalizeExtensionState(rawState);
  assert.deepStrictEqual(state, {
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channel: 'RickAstleyVEVO',
    state: 'playing',
    positionMs: 12500,
    durationMs: 245100,
    keySemitones: -2,
    error: null,
    commandId: 12,
  });

  const ownerWindowBounds = { x: -1920, y: 0, width: 1920, height: 1080 };
  const stateWithBounds = normalizeExtensionState({ ...rawState, ownerWindowBounds });
  assert.deepStrictEqual(
    stateWithBounds?.ownerWindowBounds,
    ownerWindowBounds,
  );
  assert.strictEqual(normalizeExtensionState({
    ...rawState, ownerWindowBounds: { ...ownerWindowBounds, width: 0 },
  }), null);
  assert.strictEqual(normalizeExtensionState({
    ...rawState, ownerWindowBounds: { ...ownerWindowBounds, height: Infinity },
  }), null);
  assert.strictEqual(normalizeExtensionState({
    ...rawState, ownerWindowBounds: { ...ownerWindowBounds, extra: true },
  }), null);
}

{
  assert.strictEqual(normalizeExtensionState({ videoId: 'bad', state: 'playing', positionMs: 0, durationMs: 1, keySemitones: 0, revision: 1 }), null);
  assert.strictEqual(normalizeExtensionState({ videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: -1, durationMs: 1, keySemitones: 0, revision: 1 }), null);
  assert.strictEqual(normalizeExtensionState({ videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: 0.5, durationMs: 1, keySemitones: 0, revision: 1 }), null);
  assert.strictEqual(normalizeExtensionState({ videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: 0, durationMs: 1, keySemitones: 7, revision: 1 }), null);
  assert.strictEqual(normalizeExtensionState({ videoId: 'dQw4w9WgXcQ', state: 'unknown', positionMs: 0, durationMs: 1, keySemitones: 0, revision: 1 }), null);
  assert.strictEqual(normalizeExtensionState({ videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: 0, durationMs: 1, keySemitones: 0, revision: 1, title: 'x'.repeat(201) }), null);
}

{
  assert.deepStrictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'load', videoId: 'dQw4w9WgXcQ' }), {
    commandId: 1, action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0,
  });
  assert.deepStrictEqual(normalizeKaraokeCommand({ commandId: 2, action: 'play' }), { commandId: 2, action: 'play' });
  assert.deepStrictEqual(normalizeKaraokeCommand({ commandId: 3, action: 'seek', positionMs: 9500 }), {
    commandId: 3, action: 'seek', positionMs: 9500,
  });
  assert.deepStrictEqual(normalizeKaraokeCommand({ commandId: 4, action: 'set_key', semitones: -6 }), {
    commandId: 4, action: 'set_key', semitones: -6,
  });
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'load', videoId: 'bad' }), null);
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'set_key', semitones: 7 }), null);
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'seek', positionMs: -1 }), null);
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'bogus' }), null);
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1.5, action: 'play' }), null);
  assert.strictEqual(normalizeKaraokeCommand({ commandId: 1, action: 'play', extra: true }), null);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-token-'));
  const randomBytes = (n) => Buffer.alloc(n, 7);
  const first = readOrCreateExtensionToken({ dataDir: tmp, randomBytes });
  const second = readOrCreateExtensionToken({ dataDir: tmp, randomBytes: () => Buffer.alloc(32, 9) });
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(first, second);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'youtube-karaoke-token'), 'utf8'), first);
}

console.log('test_youtube_karaoke_protocol: OK');
