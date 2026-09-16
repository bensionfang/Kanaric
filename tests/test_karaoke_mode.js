// 卡拉OK模式的回歸測試:node tests/test_karaoke_mode.js
// 兩個純函式:LRC 解析 (從 app.js 抽出來,首頁與卡拉OK頁共用) 與字幕機的兩行版面數學。
const assert = require('assert');
const { parseLrc } = require('../web-app/public/js/lrc-parse.js');
const { karaokeSlots, karaokeFitFontSize, karaokeOffsetHotkey } = require('../web-app/public/js/karaoke-slots.js');

// ===== 1. parseLrc =====

// 標記行不自成一行,而是掛回歌詞行上
{
    const r = parseLrc([
        '[source:NetEase]',
        '[00:00.00]#TITLE#作詞 : A',
        '[00:10.00]AAA',
        '[00:10.00]#TRANS#譯文一',
        '[00:10.00]#ROMAJI#roma ichi',
        '[00:20.00]BBB',
    ].join('\n'));
    assert.strictEqual(r.source, 'NetEase', '[source:] 挖得出來');
    assert.strictEqual(r.unsynced, false);
    assert.strictEqual(r.lines.length, 2, '#TITLE# 丟掉、#TRANS#/#ROMAJI# 不佔行');
    assert.strictEqual(r.lines[0].text, 'AAA');
    assert.strictEqual(r.lines[0].translation, '譯文一');
    assert.strictEqual(r.lines[0].romaji, 'roma ichi');
    assert.strictEqual(r.lines[1].translation, null, '沒有譯文就是 null 不是 undefined');
}

// #WORDS# 要掛到**每一個**同時間戳的重複句 (副歌一行帶多個時間戳)
{
    const r = parseLrc([
        '[00:10.00]AAA',
        '[00:30.00]AAA',
        '[00:20.00]BBB',
        '[00:10.00][00:30.00]#WORDS#0:0,3:900',
    ].join('\n'));
    assert.deepStrictEqual(r.lines.map(l => l.time), [10, 20, 30], '排序過');
    assert.deepStrictEqual(r.lines[0].words, [[0, 0], [3, 900]], '第一次出現有逐字');
    assert.strictEqual(r.lines[1].words, null, '沒被指到的行不該有');
    assert.deepStrictEqual(r.lines[2].words, [[0, 0], [3, 900]], '重複那次也要有 —— 只掛上一句就會漏');
}

// 沒有時間戳 = 純文字歌詞
{
    const r = parseLrc('第一行\n第二行\n');
    assert.strictEqual(r.unsynced, true);
    assert.strictEqual(r.lines.length, 2);
    assert.strictEqual(r.lines[0].time, -1);
}

// 空歌詞不該炸,medianGap 要有保底值
{
    const r = parseLrc('');
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.medianGap, 4);
}

// 沒有文字的時間戳補成 ♫,連續的只留一個;間隔中位數算得出來
{
    const r = parseLrc('[00:00.00]\n[00:02.00]\n[00:10.00]AAA\n[00:14.00]BBB\n');
    assert.deepStrictEqual(r.lines.map(l => l.text), ['♫', 'AAA', 'BBB'], '連續 ♫ 只留一個');
    assert.strictEqual(r.medianGap, 10, '間隔 [4, 10] 的中位數取上面那個');
}

// ===== 2. karaokeSlots =====

const L = [
    { time: 10, text: 'AAA' },
    { time: 13, text: 'BBB' },
    { time: 16, text: '♫' },       // 間奏
    { time: 30, text: 'CCC' },
    { time: 33, text: 'DDD' },
];

// 一般推進:當前句 + 下一句
{
    const s = karaokeSlots(L, 13.5);
    assert.strictEqual(s.index, 1, '落在 BBB');
    assert.strictEqual(s.nextIndex, 3, '下一句要跳過間奏行');
    assert.strictEqual(s.countdown, null, '正在唱不倒數');
}

// 間奏中:♫ 不佔畫面,直接把 CCC 提上來,而且要倒數
{
    const s = karaokeSlots(L, 20);
    assert.strictEqual(s.index, 3, '間奏時顯示接下來那一句');
    assert.strictEqual(s.nextIndex, 4);
    assert.ok(s.countdown, '間奏要倒數');
    assert.strictEqual(s.countdown.total, 3, '倒數窗最多 COUNT_IN 秒');
    assert.strictEqual(s.countdown.remain, 3, '離開口還很遠時點全亮');
    assert.strictEqual(karaokeSlots(L, 28.5).countdown.remain, 1.5, '快到了剩一半');
}

// 開頭:還沒唱第一句
{
    const s = karaokeSlots(L, 2);
    assert.strictEqual(s.index, 0, '第一句先擺上去');
    assert.ok(s.countdown, '前奏要倒數');
}

// 沒有 ♫ 標記的長間隔:開口前 COUNT_IN 秒才換上來 (很多來源不寫間奏行)
{
    const M = [{ time: 10, text: 'AAA' }, { time: 40, text: 'BBB' }];
    assert.strictEqual(karaokeSlots(M, 20).index, 0, '間隔中段仍停在剛唱完那句');
    assert.strictEqual(karaokeSlots(M, 20).countdown, null, '那時不倒數');
    const s = karaokeSlots(M, 38);
    assert.strictEqual(s.index, 1, '剩 2 秒才換上來');
    assert.strictEqual(s.countdown.remain, 2);
}

// 句距短就不倒數,否則整首歌都在閃
{
    const s = karaokeSlots(L, 12.9);
    assert.strictEqual(s.index, 0, 'AAA 還沒唱完');
    assert.strictEqual(s.countdown, null);
}

// 尾段間奏:後面沒有真歌詞了就停在最後一句,不倒數
{
    const s = karaokeSlots([{ time: 10, text: 'AAA' }, { time: 20, text: '♫' }], 25);
    assert.strictEqual(s.index, 0);
    assert.strictEqual(s.nextIndex, -1);
    assert.strictEqual(s.countdown, null);
}

// hint 是效能提示,不准改變答案
for (let pos = 0; pos <= 40; pos += 0.5) {
    const truth = karaokeSlots(L, pos);
    for (let h = -1; h < L.length; h++) {
        assert.strictEqual(karaokeSlots(L, pos, h).index, truth.index, `hint=${h} pos=${pos}`);
    }
}

// 空歌詞
assert.deepStrictEqual(karaokeSlots([], 5), { index: -1, nextIndex: -1, top: -1, bottom: -1, countdown: null });

// ===== 3. 長句共用字級 =====

// 兩句都放得下就維持 CSS 給的最大字級
assert.strictEqual(karaokeFitFontSize(70, [
    { natural: 500, available: 700 },
    { natural: 600, available: 700 },
]), 70);

// 任一句太長時,上下槽共用那一句需要的較小字級
assert.strictEqual(karaokeFitFontSize(70, [
    { natural: 1000, available: 700 },
    { natural: 500, available: 700 },
]), 49);

// 不設最小字級,並向下取到 0.1px,避免四捨五入後又多溢出一點
assert.strictEqual(karaokeFitFontSize(70, [
    { natural: 1000, available: 333 },
]), 23.3);
assert.strictEqual(karaokeFitFontSize(70, [
    { natural: 10000, available: 100 },
]), 0.7);
assert.strictEqual(karaokeFitFontSize(70, [
    { natural: 100000, available: 100 },
]), 0.1, '極端長句也不能得到 0px');

// DOM 還沒排好或量不到寬度時不要套行內字級,保留原本 CSS
assert.strictEqual(karaokeFitFontSize(70, []), null);
assert.strictEqual(karaokeFitFontSize(70, [{ natural: 0, available: 700 }]), null);
assert.strictEqual(karaokeFitFontSize(70, [{ natural: 500, available: 0 }]), null);

// ===== 4. 字幕早晚快捷鍵 =====

assert.strictEqual(karaokeOffsetHotkey({ key: 'ArrowLeft' }, 'ArrowLeft', 'ArrowRight'), -0.1,
    '提早鍵應讓字幕 offset 減少 100ms');
assert.strictEqual(karaokeOffsetHotkey({ key: 'ArrowRight' }, 'ArrowLeft', 'ArrowRight'), 0.1,
    '延後鍵應讓字幕 offset 增加 100ms');
assert.strictEqual(karaokeOffsetHotkey({ key: 'k', ctrlKey: true }, 'Ctrl+K', 'Alt+J'), -0.1,
    '卡拉 OK 頁要沿用自訂組合鍵');
assert.strictEqual(karaokeOffsetHotkey({ key: 'j', altKey: true }, 'Ctrl+K', 'Alt+J'), 0.1);
assert.strictEqual(karaokeOffsetHotkey({ key: 'ArrowUp' }, 'ArrowLeft', 'ArrowRight'), null,
    '無關按鍵不應改動字幕時間');
assert.strictEqual(karaokeOffsetHotkey({ key: 'ArrowLeft', target: { tagName: 'INPUT' } },
    'ArrowLeft', 'ArrowRight'), null, '在輸入欄按快捷鍵不應改動字幕時間');

// ===== 5. 上下槽的交替 (JOYSOUND 式) =====
// 槽位是「第幾句真歌詞」的奇偶,所以同一句永遠待在同一槽。另一槽先留著上一句,
// 唱到一半 (與下一句的間隔取半、封頂 SWAP_MAX) 才換成下一句當預覽。
{
    const s0 = karaokeSlots(L, 12);       // AAA (第 0 句真歌詞) → 上;10→13 的一半是 11.5
    assert.deepStrictEqual([s0.top, s0.bottom], [0, 1], 'AAA 唱過半,下面預覽 BBB');
    assert.strictEqual(s0.index, 0, '活躍句是上面那句');

    const s1 = karaokeSlots(L, 14);       // BBB (第 1 句) → 下,上面還留著剛唱完的 AAA
    assert.deepStrictEqual([s1.top, s1.bottom], [0, 1], '才剛換行,上面留著上一句');
    assert.strictEqual(s1.index, 1, '活躍句是下面那句');

    const s1b = karaokeSlots(L, 17.1);    // BBB 到 CCC 間隔 17 秒,封頂在 SWAP_MAX=4
    assert.deepStrictEqual([s1b.top, s1b.bottom], [3, 1], '長間奏封頂:4 秒後就換成預覽');

    const s2 = karaokeSlots(L, 32);       // CCC (第 2 句,間奏不算) → 上
    assert.deepStrictEqual([s2.top, s2.bottom], [3, 4], '間奏行不佔奇偶序號');
    assert.strictEqual(s2.index, 3);
}

// 換槽的時機:一句的前半留著上一句,後半才換成下一句
{
    const M = [{ time: 0, text: 'A' }, { time: 10, text: 'B' }, { time: 20, text: 'C' }];
    assert.deepStrictEqual([karaokeSlots(M, 11).top, karaokeSlots(M, 11).bottom], [0, 1],
        '剛換到 B:上面還是 A (紅著)');
    assert.deepStrictEqual([karaokeSlots(M, 15).top, karaokeSlots(M, 15).bottom], [2, 1],
        '過了一半 (封頂 4 秒 → 14 秒):上面換成 C');
}

// 同一句不會因為 seek 而換槽:一路掃過去,每個 index 出現時都在同一邊
{
    const seen = {};
    for (let pos = 0; pos <= 40; pos += 0.25) {
        const s = karaokeSlots(L, pos);
        for (const [i, side] of [[s.top, 'top'], [s.bottom, 'bottom']]) {
            if (i < 0) continue;
            if (seen[i] === undefined) seen[i] = side;
            assert.strictEqual(seen[i], side, `第 ${i} 行在 pos=${pos} 跳槽了`);
        }
    }
}

// 最後一句:沒有下一句可預覽,另一槽就一直留著上一句
{
    const s = karaokeSlots(L, 34);
    assert.strictEqual(s.index, 4, 'DDD');
    assert.deepStrictEqual([s.top, s.bottom], [3, 4], '沒有下一句時上槽留著 CCC');
}

// 「長間隔 = 間奏」要扣掉這一句唱多久 —— 只比兩個時間戳的差,長句後面接一般句距也會
// 被判成間奏,那句還在唱就被換成下一句 (變成 .done 整句補滿紅)。
// 數字取自 NOMELON NOLEMON / カイカ:第一句 22.880 起、逐字資料唱到 9.330 秒,
// 下一句 32.503 —— 真正的空檔只有 0.29 秒,但兩個時間戳差 9.62 秒。
{
    const W = [[0, 0], [15, 6616], [22, 9330]];
    const K = [{ time: 22.880, text: '一', words: W }, { time: 32.503, text: '二' }];
    const s = karaokeSlots(K, 29.6);   // 離下一句 2.9 秒,但這句還在唱
    assert.strictEqual(s.index, 0, '還在唱就不准把下一句提上來當活躍句');
    assert.strictEqual(s.countdown, null, '也不該倒數 —— 人還在唱');

    // 真的是間奏 (這句 9.33 秒唱完後空 10 秒) 就照舊提前換上來 + 倒數
    const G = [{ time: 0, text: '一', words: W }, { time: 20, text: '二' }];
    assert.strictEqual(karaokeSlots(G, 18).index, 1, '真間奏:開口前 3 秒換上來');
    assert.ok(karaokeSlots(G, 18).countdown, '真間奏要倒數');
    assert.strictEqual(karaokeSlots(G, 12).index, 0, '間奏中段仍停在剛唱完那句');
}

// 第一句:上一句不存在,那一槽**立刻**放下一句 —— 不特判的話整首歌的開頭只有一行,
// 唱到一半才蹦出第二行。字幕機從第一秒起就該是兩行。
{
    const s = karaokeSlots(L, 10.5);
    assert.deepStrictEqual([s.top, s.bottom], [0, 1], '開頭沒有上一句可留,直接預覽下一句');
    assert.strictEqual(s.index, 0);
}

console.log('test_karaoke_mode: OK');
