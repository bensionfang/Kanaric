// 自動捲動的三段判定 (畫面分上半 0~35% / 中間 35~90% / 下半 90~100%),
// 抽成純函式讓 node 測試 require 得到。
//
//   center   —— 把活動行捲到正中央
//   hold     —— 只換高亮,畫面不動 (行會隨著換句往下漂)
//   offscreen—— 活動行已離開畫面:停止捲動,顯示「恢復同步」按鈕
//
// lineTop 是相對歌詞可視區頂端的座標 (負值 = 捲到上面看不見)。
// adjacent = 這次是「唱到下一句」(新行號正好是舊行號 +1);seek / 換歌 / 重畫都不是,
// 那些情況目標行常在畫面外,一律置中,否則按了 seek 反而不捲過去。
function scrollZoneAction(lineTop, lineHeight, paneHeight, adjacent) {
    if (!adjacent) return 'center';   // 要在 offscreen 之前判:seek 的目標行本來就常在畫面外
    const visible = lineTop + lineHeight > 0 && lineTop < paneHeight;
    if (!visible) return 'offscreen';
    // 中間帶刻意**不對稱**:上緣 35% 不動,下緣拉到 90%,所以下半部只剩最後 10%。
    // 上面是「往下漂進同步」的緩衝區,下面則是「已經偏低了、快看不到了」,不需要那麼長。
    // 兩邊都保底至少容得下一行,否則一次換句就可能整個跨過中間帶。
    const top = Math.min(paneHeight * 0.35, paneHeight / 2 - lineHeight);
    const bottom = Math.max(paneHeight * 0.90, paneHeight / 2 + lineHeight);
    const center = lineTop + lineHeight / 2;
    return center >= top && center <= bottom ? 'center' : 'hold';
}

/**
 * 換行時的完整決策 (帶黏著狀態)。回 { autoCenter, action }。
 *
 * **置中一旦開始就要黏住**:只靠 scrollZoneAction 的幾何判定不夠 —— 置中後下一句的中心
 * 必定偏離中線約一行高 (行高 + 行距),行一高就落在中間帶外,於是「置中一次 → 又往下漂
 * → 漂出畫面」。使用者要的是進了中間就一直同步,只有自己捲才會離開。
 *
 * 所以 autoCenter 為 true 時直接置中不看幾何;為 false 時 (使用者捲過) 才用三段判定,
 * 漂進中間帶就重新黏上。使用者捲動時由呼叫端把 autoCenter 設回 false。
 */
function nextScrollState(autoCenter, lineTop, lineHeight, paneHeight, adjacent) {
    if (autoCenter || !adjacent) return { autoCenter: true, action: 'center' };
    const action = scrollZoneAction(lineTop, lineHeight, paneHeight, adjacent);
    return { autoCenter: action === 'center', action };
}

if (typeof module !== 'undefined') module.exports = { scrollZoneAction, nextScrollState };
