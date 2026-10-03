const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const state = {};
vm.createContext(state);

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
console.log('lyrics empty states ok');
