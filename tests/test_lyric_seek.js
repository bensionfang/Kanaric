const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const preroll = source.match(/const LYRIC_SEEK_PREROLL = [^\n]+;/)?.[0];
const advance = source.match(/const WEB_APP_LYRICS_ADVANCE = [^\n]+;/)?.[0];
const fn = source.match(/function seekToLyric\(lyricTime(?:,\s*lyricIndex = -1)?\) \{[\s\S]*?\n\}/)?.[0];
const seekFn = source.match(/function seekTo\(sec\) \{[\s\S]*?\n\}/)?.[0];
const syncFn = source.match(/function syncLyricsToTime\(position, skipScroll = false\) \{[\s\S]*?\n\}/)?.[0];
const centerFn = source.match(/function centerActiveLine\(\) \{[\s\S]*?\n\}/)?.[0];
const autoScrollFn = source.match(/function applyAutoScroll\(prevIndex\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(preroll, '找不到句子跳轉提前量');
assert.ok(advance, '找不到歌詞顯示提前量');
assert.ok(fn, '找不到共用句子跳轉函式');
assert.ok(seekFn, '找不到共用播放位置跳轉函式');
assert.ok(syncFn, '找不到歌詞時間同步函式');
assert.ok(centerFn, '找不到歌詞置中函式');
assert.ok(autoScrollFn, '找不到歌詞自動捲動函式');

for (const [time, offset, expected] of [
    [30, 0, 29.5],
    [30, 0.5, 30],
    [30, -0.3, 29.2],
    [0.2, 0, 0]
]) {
    let target;
    const state = vm.createContext({
        seekTo: (value) => { target = value; },
        syncOffset: offset
    });
    vm.runInContext(`${preroll}\nlet parsedLyrics = [], lyricSeekFocusIndex = -1;\n${fn}`, state);
    vm.runInContext(`seekToLyric(${time})`, state);
    assert.ok(Math.abs(target - expected) < 1e-9, `句首 ${time}s / 校正 ${offset}s 應跳到 ${expected}s，實際 ${target}s`);
}

const scrollCalls = [];
const pane = {
    scrollTop: 1500,
    clientHeight: 600,
    scrollTo({ top, behavior }) {
        scrollCalls.push({ top, behavior });
        this.scrollTop = top;
    }
};
const lines = Array.from({ length: 8 }, (_, index) => {
    const classes = new Set(index === 6 ? ['active'] : []);
    return {
        offsetTop: index * 220,
        offsetHeight: 80,
        clientHeight: 80,
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name)
        }
    };
});
const dom = vm.createContext({
    document: { getElementById: id => id === 'lyrics-scroll' ? pane : lines[Number(id.slice('lyric-line-'.length))] },
    performance: { now: () => 100 },
    fetch: () => Promise.resolve(),
    nextScrollState: require('../web-app/public/js/scroll-zone.js').nextScrollState,
    karaokeClear: () => {},
    karaokeFill: () => {},
    updatePlaybackProgress: () => {},
    setSyncPanel: () => {},
    updateSyncPanel: () => {},
    scrollCalls
});
vm.runInContext(`
let parsedLyrics = Array.from({ length: 8 }, (_, i) => ({ time: i === 0 ? 0.2 : i * 10 }));
let activeLyricIndex = 6;
let lyricSeekFocusIndex = -1;
let isUnsyncedLyrics = false;
let isCurrentlyPlaying = true;
let syncOffset = 0;
let currentInterpolatedPosition = 60;
let clockCorrection = 0;
let pendingSeekTarget = null;
let pendingSeekUntil = 0;
let autoCenter = true;
let scrollLocked = false;
let programmaticScrollUntil = 0;
let jumpToActiveLine = false;
${preroll}
${advance}
${centerFn}
${autoScrollFn}
${syncFn}
${seekFn}
${fn}
`, dom);

vm.runInContext('seekToLyric(parsedLyrics[2].time, 2)', dom);
assert.equal(vm.runInContext('activeLyricIndex', dom), 2, '半秒準備期間也要立即聚焦所選句');
assert.equal(vm.runInContext('lyricSeekFocusIndex', dom), 2, '準備期間保留所選句焦點');
assert.equal(scrollCalls.length, 1, '跳句只置中一次，不先捲到提前量對應的前一句');
assert.equal(scrollCalls[0].behavior, 'smooth', '播放中的跳句保留平滑捲動');
assert.ok(scrollCalls[0].top < 1500, '向前句跳轉只發出往上捲的目標');

vm.runInContext('syncLyricsToTime(19.9)', dom);
assert.equal(vm.runInContext('activeLyricIndex', dom), 2, '提前期間的下一幀仍聚焦所選句');
assert.equal(scrollCalls.length, 1, '準備期間不重複置中');
vm.runInContext('isCurrentlyPlaying = false; syncLyricsToTime(20.1)', dom);
assert.equal(vm.runInContext('lyricSeekFocusIndex', dom), 2, '暫停時即使位置越過句界也保留點選焦點');
vm.runInContext('isCurrentlyPlaying = true; syncLyricsToTime(20.1)', dom);
assert.equal(vm.runInContext('lyricSeekFocusIndex', dom), -1, '播放越過句界後交回自然同步');
assert.equal(scrollCalls.length, 1, '自然同步進入所選句時不再捲動');

vm.runInContext('seekToLyric(parsedLyrics[1].time, 1)', dom);
assert.equal(vm.runInContext('activeLyricIndex', dom), 1, '連點較早句時以新選擇取代舊焦點');
assert.equal(scrollCalls.length, 2, '第二次選句只新增一個捲動目標');
assert.ok(scrollCalls[1].top <= scrollCalls[0].top, '連續往前點句的捲動目標不會先往下修正');

vm.runInContext('isCurrentlyPlaying = false; seekToLyric(parsedLyrics[0].time, 0)', dom);
assert.equal(vm.runInContext('activeLyricIndex', dom), 0, '歌曲開頭被截到零秒時仍聚焦所選句');
assert.equal(vm.runInContext('currentInterpolatedPosition', dom), 0, '歌曲開頭的半秒提前量不產生負時間');
assert.equal(scrollCalls.length, 3, '歌曲開頭只對所選句發出一次捲動');
vm.runInContext('seekTo(12.345)', dom);
assert.equal(vm.runInContext('lyricSeekFocusIndex', dom), -1, '進度條精確跳轉會清除點句焦點');
assert.equal(vm.runInContext('currentInterpolatedPosition', dom), 12.345, '進度條仍跳到指定播放位置');

// 歌詞行的 pointerdown 不是手動捲動;拖曳捲軸仍要退出自動置中。
const gestureStart = source.indexOf('let scrollRaf = 0;');
const gestureComment = source.indexOf('// 重畫歌詞後', gestureStart);
const gestureBlock = source.slice(source.lastIndexOf('{', gestureStart), source.lastIndexOf('}', gestureComment) + 1);
assert.ok(gestureBlock.includes("for (const ev of ['wheel', 'touchstart', 'touchmove'"), '歌詞手勢監聽仍存在');
const gestureHandlers = {};
const pendingFrames = [];
const gesturePane = {
    scrollTop: 0,
    clientHeight: 600,
    addEventListener: (name, handler) => { gestureHandlers[name] = handler; }
};
const gestureState = vm.createContext({
    document: { getElementById: id => id === 'lyrics-scroll' ? gesturePane : lines[0] },
    performance: { now: () => 100 },
    requestAnimationFrame: cb => { pendingFrames.push(cb); return pendingFrames.length; },
    window: { addEventListener: () => {} },
    updateSyncPanel: () => {}
});
vm.runInContext(`let autoCenter = true, scrollLocked = false, activeLyricIndex = 0, programmaticScrollUntil = 0; ${gestureBlock}`, gestureState);
gestureHandlers.pointerdown({ target: { closest: selector => selector === '.lyrics-line' ? {} : null } });
gestureHandlers.scroll();
pendingFrames.shift()();
assert.equal(vm.runInContext('autoCenter', gestureState), true, '點歌詞後的程式捲動不能被當成手動脫離');
gestureHandlers.pointerdown({ target: { closest: () => null } });
gestureHandlers.scroll();
pendingFrames.shift()();
assert.equal(vm.runInContext('autoCenter', gestureState), false, '點捲軸區域後仍可手動脫離同步');

console.log('lyric seek passed');
