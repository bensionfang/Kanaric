const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  youtubeCnSourceOrder,
  shouldAcceptYoutubeCnResult,
} = require('../web-app/youtube-lyrics-source');

const serverSource = fs.readFileSync(path.join(__dirname, '../web-app/server.js'), 'utf8');
assert.match(serverSource, /youtubeWordTimesRetried/);
assert.match(serverSource, /ensureTranslations\(artist, title, true\)/);

assert.deepStrictEqual(
  youtubeCnSourceOrder('QQMusic'),
  ['QQMusic', 'NetEase', 'Kugou'],
  'QQ preference must enter the Chinese-source chain first',
);
assert.deepStrictEqual(
  youtubeCnSourceOrder('Lrclib', { youtube: true }),
  ['QQMusic', 'NetEase', 'Kugou'],
  'YouTube must still probe QQ word timing before a non-Chinese preference',
);
assert.strictEqual(
  shouldAcceptYoutubeCnResult('QQMusic', { lyrics: 'qrc', source: 'QQMusic', word: true }),
  true,
  'QQ result with word timing is preferred',
);
assert.strictEqual(
  shouldAcceptYoutubeCnResult('QQMusic', { lyrics: 'fallback', source: 'NetEase', word: false }),
  false,
  'a QQ request that internally fell back must not masquerade as QQ',
);
assert.strictEqual(
  shouldAcceptYoutubeCnResult('QQMusic', { lyrics: 'lrc', source: 'QQMusic', word: false }),
  false,
  'QQ without word timing yields to the preferred fallback source',
);
assert.strictEqual(
  shouldAcceptYoutubeCnResult('NetEase', { lyrics: 'lrc', source: 'NetEase', word: false }),
  true,
  'the non-QQ preferred source keeps existing acceptance behavior',
);

console.log('test_youtube_lyrics_source: OK');
