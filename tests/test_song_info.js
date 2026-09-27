const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const start = source.indexOf('function updateSongInfo(');
assert.ok(start >= 0, 'current song info renderer exists');
const end = source.indexOf('\nfunction ', start + 1);
const elements = Object.fromEntries([
  'song-info', 'song-info-player', 'song-info-title', 'song-info-original', 'song-info-original-row',
  'song-info-status', 'song-info-provider',
].map(id => [id, { textContent: '', hidden: false }]));
const state = { document: { getElementById: id => elements[id] || null } };
vm.createContext(state);
vm.runInContext(source.slice(start, end), state);

vm.runInContext(`updateSongInfo({source:'Spotify.exe', title:'春泥棒', artist:'ヨルシカ',
  original_title:'Haru Dorobou', original_artist:'Yorushika'}, 'ready', 'NetEase')`, state);
assert.equal(elements['song-info'].hidden, false);
assert.match(elements['song-info-title'].textContent, /ヨルシカ.*春泥棒/);
assert.match(elements['song-info-original'].textContent, /Yorushika.*Haru Dorobou/);
assert.equal(elements['song-info-provider'].textContent, 'NetEase');
assert.equal(elements['song-info-status'].textContent, '歌詞已載入');

vm.runInContext(`updateSongInfo({source:'chrome.exe', title:'Lemon', artist:'米津玄師',
  original_title:'Lemon', original_artist:'米津玄師'}, 'ready', '')`, state);
assert.equal(elements['song-info-original-row'].hidden, true, 'same raw name stays out of view');
assert.equal(elements['song-info-provider'].textContent, '來源未知');

vm.runInContext(`updateSongInfo({source:'spotify', title:'Aoi', artist:'サカナクション',
  original_artist:'魚韻'}, 'ready', 'QQMusic')`, state);
assert.equal(elements['song-info-original'].textContent, '魚韻 — Aoi', 'partial raw name keeps the unchanged title');

vm.runInContext(`updateSongInfo({title:'',artist:''}, 'waiting', '')`, state);
assert.equal(elements['song-info'].hidden, true, 'no song hides empty fields');

const empty = source.slice(source.indexOf('function emptyLyricsHtml('), source.indexOf('\n// 解析本身', source.indexOf('function emptyLyricsHtml(')));
vm.runInContext(empty, state);
for (const [status, phrase, action] of [
  ['waiting', '播放一首歌', 'openMediaSourceSettings'],
  ['not_found', '找不到這首歌', 'searchLyricsOptions'],
  ['no_lyrics', '已標記為無歌詞', 'searchLyricsOptions'],
  ['error', '載入失敗', 'reloadCurrentLyrics'],
]) {
  const html = vm.runInContext(`emptyLyricsHtml('${status}')`, state);
  assert.ok(html.includes(phrase) && html.includes(action) && html.includes('role="status"'), status);
}

const openSource = source.slice(source.indexOf('function openMediaSourceSettings('), source.indexOf('\nasync function fetchAndParseLyrics', source.indexOf('function openMediaSourceSettings(')));
const menu = { show: false, classList: { contains: () => menu.show } };
const section = { show: false, classList: { contains: () => section.show } };
let menuToggles = 0;
let sourceToggles = 0;
let sourceFocus = 0;
const menuState = {
  document: { getElementById: id => id === 'settings-menu' ? menu : id === 'source-toggle' ? { focus: () => sourceFocus++ } : section },
  toggleSettingsMenu: () => { menu.show = !menu.show; menuToggles++; },
  toggleSourceSection: () => { section.show = !section.show; sourceToggles++; },
};
vm.createContext(menuState);
vm.runInContext(openSource, menuState);
vm.runInContext('openMediaSourceSettings(); openMediaSourceSettings()', menuState);
assert.equal(menuToggles, 1, 'already open settings stay open');
assert.equal(sourceToggles, 1, 'already open source list stays open');
assert.equal(sourceFocus, 2, 'keyboard focus moves to the opened source controls');
console.log('song info ok');
