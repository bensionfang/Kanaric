const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const apply = source.slice(source.indexOf('function applyMediaState(data) {'), source.indexOf('\nasync function fetchAndParseLyrics', source.indexOf('function applyMediaState(data) {')));
const load = source.slice(source.indexOf('async function fetchAndParseLyrics('), source.indexOf('\n// 解析本身', source.indexOf('async function fetchAndParseLyrics(')));
let finishOldFetch;
let rendered = '';
const pane = { innerHTML: '' };
const state = {
  document: { getElementById: id => id === 'lyrics-scroll' ? pane : null },
  window: { currentSongInfo: {}, _lyricsOptions: [] },
  performance: { now: () => 0 },
  localStorage: { getItem: () => null },
  fetch: url => String(url).startsWith('/api/lyrics/offset')
    ? Promise.resolve({ json: async () => ({ offset: 0 }) })
    : new Promise(resolve => { finishOldFetch = resolve; }),
  parseLrcLyrics: value => { rendered = value; },
  renderLyrics: () => {},
  resetLyricsOptBtn: () => {}, restoreOptionsState: () => {}, clearLoop: () => {},
  resumeSync: () => {}, setMarqueeText: () => {}, updateOffsetDisplay: () => {},
  offsetSongKey: (title, artist) => `${title}|||${artist}`,
  console,
};
vm.createContext(state);
vm.runInContext(`let lastMediaTitle = 'A', lastMediaArtist = 'Artist';
let lastLyricsKey = 'A|||Artist', displayedTrackId = 'A|||Artist', lyricsFetchSeq = 0;
let parsedLyrics = [], isCurrentlyPlaying = true, clockCorrection = 0;
let currentInterpolatedPosition = 0, lastServerPosition = 0, pendingSeekTarget = null;
let syncOffset = 0, lastThumbnail = null, songDurationSeconds = 180;
${apply}
${load}`, state);

(async () => {
  const old = vm.runInContext("fetchAndParseLyrics('A', 'Artist', 'A|||Artist')", state);
  assert.equal(typeof finishOldFetch, 'function');
  vm.runInContext("applyMediaState({ title: 'B', artist: 'Artist', position: 0, is_playing: true, resolving: true })", state);
  finishOldFetch({ ok: true, json: async () => ({ lyrics: '[00:00]A' }) });
  await old;
  assert.equal(rendered, '', 'old lyrics must not render while the new song is resolving');
  assert.match(pane.innerHTML, /正在搜尋歌詞/, 'new song keeps its loading state');
  console.log('lyrics song switch ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
