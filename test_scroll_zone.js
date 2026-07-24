// 歌詞自動捲動三段判定的回歸測試:node test_scroll_zone.js
const assert = require('assert');
const { scrollZoneAction, nextScrollState } = require('./web-app/public/js/scroll-zone.js');

const H = 600;      // 歌詞區高度 → 中間帶 = 行中心落在 210 (35%) ~ 540 (90%)
const LH = 60;      // 一行高 (兩邊保底都用不到:300-60=240 > 210、300+60=360 < 540)
const adj = (top, lineHeight = LH, paneHeight = H) => scrollZoneAction(top, lineHeight, paneHeight, true);
const jump = (top, lineHeight = LH, paneHeight = H) => scrollZoneAction(top, lineHeight, paneHeight, false);

// 唱下一句 (相鄰):中間帶置中,上下半只換高亮
assert.strictEqual(adj(270), 'center', '正中央');
assert.strictEqual(adj(100), 'hold', '上半部不捲動');
assert.strictEqual(adj(520), 'hold', '下半部不捲動');

// 中間帶邊界 (行中心 210~540,行高 60 → top 180~510)。刻意不對稱:上緣 35%、下緣 90%
assert.strictEqual(adj(180), 'center', '中間帶上緣剛好');
assert.strictEqual(adj(179), 'hold', '差一 px 就在上半');
assert.strictEqual(adj(510), 'center', '中間帶下緣剛好');
assert.strictEqual(adj(511), 'hold', '差一 px 就在下半');

// 離開畫面 → 停止捲動 + 顯示恢復同步按鈕
assert.strictEqual(adj(-60), 'offscreen', '整行捲到上方外');
assert.strictEqual(adj(-59), 'hold', '露出 1 px 就還算在畫面內');
assert.strictEqual(adj(H), 'offscreen', '整行捲到下方外');
assert.strictEqual(adj(H - 1), 'hold', '露出 1 px 就還算在畫面內');

// 非相鄰 (seek / 換歌 / 重畫) 一律置中,即使目標行在畫面外
assert.strictEqual(jump(-500), 'center', 'seek 往回');
assert.strictEqual(jump(2000), 'center', 'seek 往後');
assert.strictEqual(jump(100), 'center', '上半部也直接置中');

// 行很高時上緣保底放寬到「中線 − 一行高」(300px 的行 → 上緣 0),否則一次換句就跨過整個中間帶
assert.strictEqual(scrollZoneAction(150, 300, H, true), 'center', '行中心 300 = 正中');
assert.strictEqual(scrollZoneAction(0, 300, H, true), 'center', '行中心 150,上緣保底放寬到 0');
assert.strictEqual(scrollZoneAction(-100, 300, H, true), 'center', '行中心 50,仍在放寬後的中間帶內');
assert.strictEqual(scrollZoneAction(-290, 300, H, true), 'hold', '只剩底部 10 px 露出,行中心遠在上方');

// --- nextScrollState:置中要黏住 ---
// 置中後下一句的中心必定往下偏一行高 (行高 + 行距),行一高就落在中間帶外。
// 不黏的話就是「置中一次又往下漂,最後漂出畫面」—— 使用者實測踩到的那個 bug。
// 行高 110:漂到 top=490 時行中心 545,已經超過中間帶下緣 540
const TALL = 110, DRIFTED = 490;
assert.deepStrictEqual(nextScrollState(true, DRIFTED, TALL, H, true),
    { autoCenter: true, action: 'center' }, '已在置中模式 = 一律置中,不看幾何');
assert.strictEqual(scrollZoneAction(DRIFTED, TALL, H, true), 'hold', '同樣位置的純幾何判定會漂掉 (對照組)');

// 使用者捲走後 (autoCenter=false) 才用三段判定,漂進中間帶就重新黏上
assert.deepStrictEqual(nextScrollState(false, 100, LH, H, true),
    { autoCenter: false, action: 'hold' }, '上半部:只換高亮');
assert.deepStrictEqual(nextScrollState(false, 270, LH, H, true),
    { autoCenter: true, action: 'center' }, '漂到中間帶:黏回逐句置中');
assert.deepStrictEqual(nextScrollState(false, 520, LH, H, true),
    { autoCenter: false, action: 'hold' }, '下半部:只換高亮');
assert.deepStrictEqual(nextScrollState(false, H, LH, H, true),
    { autoCenter: false, action: 'offscreen' }, '漂出畫面:停手 + 按鈕');

// seek / 換歌 一律置中並回到黏著狀態
assert.deepStrictEqual(nextScrollState(false, -500, LH, H, false),
    { autoCenter: true, action: 'center' }, 'seek 到畫面外也置中並黏上');

console.log('scroll-zone: all tests passed');
