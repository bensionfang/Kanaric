const assert = require('assert');

const {
  normalizeLyricsOptionsRequest,
  normalizeLyricsOptionsMessage,
  normalizeLyricsOptionSelect,
  createLyricsOptionsRequest,
} = require('../src/service-worker');
const {
  normalizeYouTubeLyricsOptions,
  createYouTubeLyricsOptionsRequest,
  createYouTubeLyricsOptionSelect,
} = require('../src/youtube-content');

const videoId = 'dQw4w9WgXcQ';

assert.deepStrictEqual(normalizeLyricsOptionsRequest({
  type: 'youtube_karaoke_lyrics_options_request',
  videoId,
  revision: 3,
  title: 'Song',
  artist: 'Artist',
}), { videoId, revision: 3, title: 'Song', artist: 'Artist' });
assert.strictEqual(normalizeLyricsOptionsRequest({
  type: 'youtube_karaoke_lyrics_options_request', videoId, revision: 2,
  title: 'Song', artist: 'Artist', extra: true,
}), null);

const optionsMessage = {
  type: 'youtube_karaoke_lyrics_options',
  videoId,
  revision: 3,
  status: 'done',
  options: [{ optionId: 'opt-1', source: 'AppSource', format: 'LRC', preview: '<x>', hasWords: false }],
};
assert.deepStrictEqual(normalizeLyricsOptionsMessage(optionsMessage), optionsMessage);
assert.strictEqual(normalizeLyricsOptionsMessage({ ...optionsMessage, videoId: 'other' }), null);
assert.strictEqual(normalizeLyricsOptionSelect({
  type: 'youtube_karaoke_lyrics_option_select', videoId, revision: 3, optionId: 'opt-1',
}).optionId, 'opt-1');
assert.strictEqual(normalizeLyricsOptionSelect({
  type: 'youtube_karaoke_lyrics_option_select', videoId, revision: 3, optionId: 'bad id',
}), null);

assert.deepStrictEqual(createLyricsOptionsRequest({ videoId, revision: 3, title: ' Song ', channel: ' Artist ' }), {
  type: 'youtube_karaoke_lyrics_options_request', videoId, revision: 3, title: 'Song', artist: 'Artist',
});
assert.deepStrictEqual(createYouTubeLyricsOptionsRequest({ videoId, revision: 3, title: 'Song', channel: 'Artist' }), {
  type: 'youtube_karaoke_lyrics_options_request', videoId, revision: 3, title: 'Song', artist: 'Artist',
});
assert.deepStrictEqual(createYouTubeLyricsOptionSelect(videoId, 3, 'opt-1'), {
  type: 'youtube_karaoke_lyrics_option_select', videoId, revision: 3, optionId: 'opt-1',
});
assert.deepStrictEqual(normalizeYouTubeLyricsOptions(optionsMessage), optionsMessage);

console.log('lyrics-options.test: OK');
