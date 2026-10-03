const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const applyStart = source.indexOf('function applyMediaState(');
assert.ok(applyStart >= 0, 'missing applyMediaState');
const apply = source.slice(applyStart, source.indexOf('\nasync function fetchAndParseLyrics', applyStart));
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
let lyricSeekFocusIndex = -1;
let syncOffset = 0, lastThumbnail = null, songDurationSeconds = 180;
${apply}
${load}`, state);

(async () => {
  const pauseBoundary = vm.runInContext(`
    isCurrentlyPlaying = true;
    currentInterpolatedPosition = 29.8;
    lastServerPosition = 29.8;
    applyMediaState({ title: 'A', artist: 'Artist', position: 30, is_playing: false, resolving: true });
    const onPause = currentInterpolatedPosition;
    applyMediaState({ title: 'A', artist: 'Artist', position: 29.9, is_playing: false, resolving: true });
    [onPause, currentInterpolatedPosition]
  `, state);
  assert.deepEqual(Array.from(pauseBoundary), [30, 30], '播放轉暫停時先對準實際暫停點，之後忽略小幅回報抖動');

  const pausedJitter = vm.runInContext(`
    isCurrentlyPlaying = false;
    currentInterpolatedPosition = 30;
    lastServerPosition = 30;
    lyricSeekFocusIndex = 2;
    applyMediaState({ title: 'A', artist: 'Artist', position: 29.9, is_playing: false, resolving: true });
    const afterBeforeBoundary = currentInterpolatedPosition;
    applyMediaState({ title: 'A', artist: 'Artist', position: 30.1, is_playing: false, resolving: true });
    [afterBeforeBoundary, currentInterpolatedPosition, lyricSeekFocusIndex]
  `, state);
  assert.deepEqual(Array.from(pausedJitter), [30, 30, 2], '暫停時句界前後的小幅媒體回報不得改變播放位置或選句焦點');
  const externalSeek = vm.runInContext(`
    applyMediaState({ title: 'A', artist: 'Artist', position: 50, is_playing: false, resolving: true });
    [currentInterpolatedPosition, lyricSeekFocusIndex]
  `, state);
  assert.deepEqual(Array.from(externalSeek), [50, -1], '暫停時外部播放器跳到別段仍更新並清除舊焦點');

  const old = vm.runInContext("fetchAndParseLyrics('A', 'Artist', 'A|||Artist')", state);
  assert.equal(typeof finishOldFetch, 'function');
  vm.runInContext('lyricSeekFocusIndex = 2', state);
  vm.runInContext("applyMediaState({ title: 'B', artist: 'Artist', position: 0, is_playing: true, resolving: true })", state);
  assert.equal(vm.runInContext('lyricSeekFocusIndex', state), -1, '切歌後不保留上一首的暫時焦點');
  finishOldFetch({ ok: true, json: async () => ({ lyrics: '[00:00]A' }) });
  await old;
  assert.equal(rendered, '', 'old lyrics must not render while the new song is resolving');
  assert.match(pane.innerHTML, /正在搜尋歌詞/, 'new song keeps its loading state');
  const restored = vm.runInContext(`currentInterpolatedPosition = 10; lastServerPosition = 10;
    applyMediaState({ title: 'B', artist: 'Artist', position: 10.1, is_playing: true, resolving: true }, true);
    [currentInterpolatedPosition, clockCorrection]`, state);
  assert.deepEqual(Array.from(restored), [10.1, 0], '視窗還原時的小幅差距也要立刻對準最新位置');
  console.log('lyrics song switch ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
