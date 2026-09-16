/*
 * 卡拉OK字幕機的版面數學:給定歌詞與播放位置,回答「哪一句放上面、哪一句放下面、
 * 還有幾秒開口」。純函式,獨立成檔的理由同 scroll-zone.js —— 測試 require 得到而不必起瀏覽器。
 *
 * 與首頁 `syncLyricsToTime` 的差別有兩處,都是「唱」與「聽」的差別:
 *
 * 1. **當前句永遠是「有字的那一句」**。落在間奏 (♫) 上時直接把後面那句真歌詞提上來 ——
 *    那時 `pos < cur.time`,karaokePaint 自己算出 0%,一個字都不會亮。首頁捲動時 ♫ 是
 *    一行畫面,唱的人卻要在間奏時就看到下一句是什麼。
 * 2. **間隔夠長才倒數**。句與句之間本來就有三四秒 (`medianGap` 全庫多半是 4 上下),
 *    每句都倒數等於整首歌都在閃。所以「這是間奏」的門檻 (GAP) 與「倒數窗」(COUNT_IN)
 *    是兩個數:間隔 >= GAP 才算間奏,而且要到開口前 COUNT_IN 秒才把下一句換上來。
 *    這條讓沒有 ♫ 標記的歌詞 (很多來源不寫間奏行) 一樣有倒數。
 * 3. **上下兩槽是 JOYSOUND 式的交替,不是「活躍句永遠在上」**。槽位由「這是第幾句真歌詞」
 *    的**奇偶**決定 (間奏 ♫ 不算),偶數在上、奇數在下。
 *    奇偶是每一句的固有屬性,所以同一句在畫面上永遠待在同一槽,不會因為 seek 而跳槽。
 * 4. **另一槽不是一換行就跟著換,要等這句唱到一半** (SWAP,照 JOYSOUND)。在那之前留著
 *    剛唱完的上一句 (紅著,見 .kline.done),之後才換成下一句當預覽。一換行就換掉的話
 *    唱完的紅字一瞬間就不見,而且旁邊直接跳出兩句以後的詞,眼睛跟不上是哪一句。
 *    **第一句沒有上一句可留,那一槽直接放下一句** —— 不特判的話開頭只有一行。
 */
const KARAOKE_COUNT_IN_SEC = 3;
const KARAOKE_GAP_SEC = 6;      // 超過這個間隔才算間奏 —— 一般句距的兩倍
// 另一槽換成「下一句」的時機:這句與下一句間隔的一半,長間奏封頂在這個秒數 ——
// 不封頂的話間奏前那句會霸著半個畫面十幾秒,下一句遲遲不預覽。
const KARAOKE_SWAP_MAX_SEC = 4;

function karaokeSlots(lines, posSec, hint, countInSec) {
    const countIn = typeof countInSec === 'number' ? countInSec : KARAOKE_COUNT_IN_SEC;
    if (!lines || !lines.length) return { index: -1, nextIndex: -1, top: -1, bottom: -1, countdown: null };

    // 落在哪一行 (最後一個 time <= pos)。hint 是上一幀的答案,傳錯不會算錯,只是退回全掃。
    let i = (typeof hint === 'number' && hint >= 0 && hint < lines.length && lines[hint].time <= posSec)
        ? hint : -1;
    while (i + 1 < lines.length && lines[i + 1].time <= posSec) i++;

    const upcoming = nextReal(lines, i);
    let cur;
    if (i < 0 || isFiller(lines[i])) {
        // 間奏中 / 還沒開唱:直接顯示接下來那一句
        cur = upcoming >= 0 ? upcoming : lastReal(lines);
    } else if (upcoming >= 0 &&
               lines[upcoming].time - lineEnd(lines[i]) >= KARAOKE_GAP_SEC &&
               lines[upcoming].time - posSec <= countIn) {
        // 沒有 ♫ 標記的長間隔:開口前 countIn 秒才換上來
        cur = upcoming;
    } else {
        cur = i;
    }
    if (cur < 0) return { index: -1, nextIndex: -1, top: -1, bottom: -1, countdown: null };

    const nextIndex = nextReal(lines, cur);
    // 上槽 / 下槽:活躍句照自己的奇偶入座,另一槽先留著上一句、唱到一半才換成下一句
    // (見檔頭第 4 點)。兩者的序號都跟 cur 差一,奇偶必定相反,所以「不跳槽」仍然成立。
    let other = prevReal(lines, cur);
    if (nextIndex >= 0) {
        const half = (lines[nextIndex].time - lines[cur].time) / 2;
        // **第一句是例外:沒有上一句可以留,那一槽就直接放下一句。** 不特判的話整首歌的
        // 開頭只有孤零零一行,唱到一半才蹦出第二行 —— 字幕機從第一秒起就該是兩行。
        if (other < 0 || posSec >= lines[cur].time + Math.min(half, KARAOKE_SWAP_MAX_SEC)) other = nextIndex;
    }
    const onTop = realOrdinal(lines, cur) % 2 === 0;
    const top = onTop ? cur : other;
    const bottom = onTop ? other : cur;

    let countdown = null;
    if (lines[cur].time > posSec) {
        const anchor = i >= 0 ? lineEnd(lines[i]) : 0;
        const gap = lines[cur].time - anchor;
        if (gap >= countIn) {
            const total = Math.min(gap, countIn);
            countdown = { total, remain: Math.min(lines[cur].time - posSec, total) };
        }
    }

    return { index: cur, nextIndex, top, bottom, countdown };
}

/**
 * 上下槽共用的單列字級。measurements 每筆都是同一句在 maxPx 下的自然寬度與可用寬度。
 * DOM 尚未排好時回 null,讓呼叫端保留 CSS 字級。
 */
function karaokeFitFontSize(maxPx, measurements) {
    if (!Number.isFinite(maxPx) || maxPx <= 0 || !measurements || !measurements.length) return null;
    let scale = 1;
    for (const m of measurements) {
        if (!m || !Number.isFinite(m.natural) || m.natural <= 0
            || !Number.isFinite(m.available) || m.available <= 0) return null;
        scale = Math.min(scale, m.available / m.natural);
    }
    return Math.max(0.1, Math.floor(maxPx * scale * 10) / 10);
}

function karaokeOffsetHotkey(e, advance, delay) {
    if (!e || typeof e.key !== 'string') return null;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return null;
    let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (key === ' ') key = 'Space';
    let prefix = '';
    if (e.ctrlKey) prefix += 'Ctrl+';
    if (e.altKey) prefix += 'Alt+';
    if (e.shiftKey && e.key.length > 1) prefix += 'Shift+';
    key = prefix + key;
    if (key === advance) return -0.1;
    if (key === delay) return 0.1;
    return null;
}

/**
 * 這一句唱完的時間。有逐字資料就用最後一個折線點 (毫秒是相對於這一句的時間戳),
 * 沒有就退回時間戳本身 (= 舊行為)。
 *
 * **「間隔夠長 = 間奏」必須扣掉這一句唱多久,不能只看兩句時間戳的差。**
 * 長句 (カイカ 第一句唱滿 9.3 秒) 後面接一般句距,兩個時間戳的差照樣 >= GAP,
 * 於是那句還在唱、離下一句只剩 countIn 秒時畫面就把「下一句」提上來當活躍句 ——
 * 剛唱到六成的那句瞬間變成 .done 整句補滿紅字 (2026-08-10 回報:兩張差 100ms 的
 * 截圖,填色從六成跳到全滿)。首頁沒有這條規則,所以只有卡拉OK頁會這樣。
 */
function lineEnd(line) {
    const w = line && line.words;
    return line.time + (w && w.length ? w[w.length - 1][1] / 1000 : 0);
}

// 這是第幾句「真歌詞」(間奏不算)。一首歌頂多一兩百行,每幀全掃比維護一張表便宜。
function realOrdinal(lines, idx) {
    let n = 0;
    for (let j = 0; j < idx; j++) if (!isFiller(lines[j])) n++;
    return n;
}

// 間奏行:沒有文字的時間戳被 lrc-parse.js 補成 ♫
function isFiller(line) {
    return !line || !line.text || line.text === '♫';
}

function nextReal(lines, from) {
    for (let j = from + 1; j < lines.length; j++) if (!isFiller(lines[j])) return j;
    return -1;
}

function prevReal(lines, from) {
    for (let j = from - 1; j >= 0; j--) if (!isFiller(lines[j])) return j;
    return -1;
}

function lastReal(lines) {
    for (let j = lines.length - 1; j >= 0; j--) if (!isFiller(lines[j])) return j;
    return -1;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
    karaokeSlots, karaokeFitFontSize, karaokeOffsetHotkey,
    KARAOKE_COUNT_IN_SEC, KARAOKE_GAP_SEC, KARAOKE_SWAP_MAX_SEC,
};
