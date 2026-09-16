// 卡拉OK模式的回歸測試:node tests/test_karaoke_mode.js
// 兩個純函式:LRC 解析 (從 app.js 抽出來,首頁與卡拉OK頁共用) 與字幕機的兩行版面數學。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { parseLrc } = require('../web-app/public/js/lrc-parse.js');
const { karaokeSlots, karaokeFitFontSize, karaokeOffsetHotkey } = require('../web-app/public/js/karaoke-slots.js');
const {
    classifyYouTubeCandidate,
    pickInitialYouTubeResult,
    toYouTubeQueueItem,
    createYouTubeCommand,
    startYouTubeSong,
} = require('../web-app/public/js/youtube-karaoke.js');
const { createYouTubeKaraokeQueue } = require('../web-app/public/js/youtube-karaoke-queue.js');
let createKaraokePitchLifecycle;
let createKaraokeCompactStartGate;
let createKaraokeWindowBlocker;
let createKaraokeCollapseController;
let createYouTubeLyricsPrefetchController;
try {
    ({ createKaraokePitchLifecycle, createKaraokeCompactStartGate, createKaraokeWindowBlocker, createKaraokeCollapseController, createYouTubeLyricsPrefetchController } = require('../web-app/public/js/karaoke-mode.js'));
} catch {}

// Task 3: queue rows own prefetch state; removed rows ignore late responses.
{
    assert.equal(typeof createYouTubeLyricsPrefetchController, 'function', 'lyrics prefetch controller is exported');
    const sent = [];
    const states = [];
    const controller = createYouTubeLyricsPrefetchController({
        send: (message) => sent.push(message),
        onState: (state) => states.push(state),
    });
    const queuedA = { queueId: 'q-a', videoId: 'dQw4w9WgXcQ', title: 'Song A', channel: 'Artist A' };
    const queuedB = { queueId: 'q-b', videoId: 'kJQP7kiw5Fk', title: 'Song B', channel: 'Artist B' };
    assert.equal(controller.prefetch(queuedA), true);
    assert.deepStrictEqual(sent, [{
        type: 'youtube_karaoke_lyrics_prefetch', videoId: queuedA.videoId,
        title: queuedA.title, channel: queuedA.channel,
    }]);
    assert.equal(controller.prefetch(queuedA), false, 'same identity is prefetched once per page');
    assert.equal(controller.prefetch(queuedB), true);
    controller.remove(queuedB.queueId);
    controller.receiveStatus({ type: 'youtube_karaoke_lyrics_prefetch_status', videoId: queuedB.videoId, status: 'loaded' });
    assert.equal(states.some((state) => state.queueId === queuedB.queueId && state.status === 'loaded'), false,
        'removed row ignores a late result');
    controller.receiveStatus({ type: 'youtube_karaoke_lyrics_prefetch_status', videoId: queuedA.videoId, status: 'no_lyrics' });
    assert.equal(states.at(-1).status, 'no_lyrics');
}

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

// ===== 6. Official MV ranking and non-blocking mismatch warning =====
assert.deepStrictEqual(classifyYouTubeCandidate({ official: true, durationDeltaSec: 46 }), {
    official: true,
    needsConfirmation: true,
    reason: 'duration-mismatch',
});
assert.deepStrictEqual(classifyYouTubeCandidate({ official: null, durationDeltaSec: 46, needsConfirmation: false }), {
    official: null,
    needsConfirmation: true,
    reason: 'duration-mismatch',
}, '未知歌手的時長不符也不得被後端安全旗標掩蓋');
assert.strictEqual(pickInitialYouTubeResult([
    { videoId: 'dQw4w9WgXcQ', title: 'Song exact title', channel: 'Someone', durationSec: 180, thumb: '', ok: true, official: false },
    { videoId: 'kJQP7kiw5Fk', title: 'Unrelated song', channel: 'Artist Official', durationSec: 226, thumb: '', ok: true, official: true },
]).videoId, 'dQw4w9WgXcQ', '後面的無關官方結果不得蓋過後端排序的標題候選');
assert.strictEqual(pickInitialYouTubeResult([
    { videoId: 'kJQP7kiw5Fk', title: 'Exact official', channel: 'Artist Official', durationSec: 226, thumb: '', ok: true, official: true, needsConfirmation: false },
]).needsConfirmation, false, '官方且時長吻合的候選不應被標成需確認');
const fallbackCandidate = pickInitialYouTubeResult([
    { videoId: '9bZkp7q19f0', title: 'Fallback', channel: 'Someone', durationSec: 180, thumb: '', ok: true, official: false },
]);
assert.strictEqual(fallbackCandidate.needsConfirmation, true, '沒有官方候選時只能帶確認提示');
const oneSearchCandidate = pickInitialYouTubeResult([
    { videoId: 'M7lc1UVf-VE', title: 'Exact search', channel: 'Uploader', durationSec: 180, thumb: '', ok: true,
        durationDeltaSec: 0, needsConfirmation: false },
]);
assert.strictEqual(oneSearchCandidate.official, null, '一欄搜尋的空歌手要保留 official unknown');
assert.strictEqual(oneSearchCandidate.needsConfirmation, false,
    '後端明確判定安全的一欄搜尋候選不得被前端重分類成警告');
assert.strictEqual(toYouTubeQueueItem({
    videoId: 'M7lc1UVf-VE', title: 'Bad search', channel: 'Uploader', durationSec: 180, thumb: '', ok: false,
}).needsConfirmation, true, '壞候選即使沒有歌手資訊也仍需確認');

// ===== 6. YouTube-only page boundary =====
const karaokeModeSource = fs.readFileSync(require.resolve('../web-app/public/js/karaoke-mode.js'), 'utf8');
assert.doesNotMatch(karaokeModeSource, /requestFullscreen|fullscreenchange|exitFullscreen/,
    'App 主視窗緊湊控台不得依賴瀏覽器全螢幕');

{
    const calls = [];
    const timers = [];
    const gate = createKaraokeCompactStartGate({
        bridge: {
            startCollapsed: (options) => { calls.push(['startCollapsed', options]); return { ok: true }; },
            finish: () => { calls.push(['finish']); return Promise.resolve({ ok: true }); },
        },
        schedule: (fn) => { const timer = { fn, cancelled: false }; timers.push(timer); return timer; },
        cancel: (timer) => { timer.cancelled = true; },
    });
    gate.arm('dQw4w9WgXcQ');
    gate.onState({ videoId: 'other-video', revision: 1, state: 'playing' });
    assert.equal(calls.length, 0, '錯誤 owner 不能讓 App 視窗縮小');
    assert.equal(timers.length, 0, '有效 owner 狀態前不得排縮窗計時器');
    gate.onState({ videoId: 'dQw4w9WgXcQ', revision: 2, state: 'playing',
        ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } });
    assert.deepStrictEqual(calls[0], ['startCollapsed', { compact: true, top: true,
        ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }]);
    assert.equal(timers.length, 0, '有效 owner revision 後要直接 atomic 收合，不得等待 timeout');
    gate.arm('next-video');
    gate.onState({ videoId: 'next-video', revision: 3, state: 'error' });
    assert.equal(timers.length, 0, '載入失敗時不得在 timeout 後縮小');
    gate.arm('third-video');
    assert.equal(timers.length, 0, '沒有有效 owner 狀態時不能啟動備援 timeout');
    gate.onState({ videoId: 'third-video', revision: 4, state: 'playing' });
    assert.equal(calls.length, 1, 'owner bounds 尚未就緒時不得原子收合 App');
    gate.onState({ videoId: 'third-video', revision: 4, state: 'playing',
        ownerWindowBounds: { x: 0, y: 0, width: 0, height: 1080 } });
    assert.equal(calls.length, 1, '無效 owner bounds 不得原子收合 App');
    gate.onState({ videoId: 'third-video', revision: 4, state: 'playing',
        ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } });
    assert.deepStrictEqual(calls[1], ['startCollapsed', { compact: true, top: true,
        ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 } }],
        '有效 owner bounds 才能由 App atomic 收合');
    gate.onState({ videoId: 'third-video', revision: 4, state: 'error' });
    assert.deepStrictEqual(calls[2], ['finish'], '晚到的載入錯誤要展開回完整頁面');
    gate.finish();
    assert.deepStrictEqual(calls[3], ['finish']);
    const browserOnly = createKaraokeCompactStartGate({
        schedule: () => { throw new Error('純瀏覽器模式不應啟動縮窗計時器'); },
    });
    browserOnly.arm('dQw4w9WgXcQ');
    browserOnly.onState({ videoId: 'dQw4w9WgXcQ', revision: 1, state: 'playing' });
    assert.strictEqual(browserOnly.finish(), undefined);
}
const karaokeViewSource = fs.readFileSync(require.resolve('../web-app/views/karaoke.ejs'), 'utf8');
const karaokeCssSource = fs.readFileSync(require.resolve('../web-app/public/css/style.css'), 'utf8');
const karaokeFooterSource = fs.readFileSync(require.resolve('../web-app/views/footer.ejs'), 'utf8');
const karaokeLyricsModalSource = fs.readFileSync(require.resolve('../web-app/views/modals/lyrics-options.ejs'), 'utf8');
const commonSource = fs.readFileSync(require.resolve('../web-app/public/js/common.js'), 'utf8');
const compactGateSource = karaokeModeSource.match(
    /function createKaraokeCompactStartGate\([\s\S]*?\n\}\n\nfunction createKaraokeWindowBlocker/
)?.[0] || '';
assert.match(compactGateSource, /startCollapsed/, '首唱 native path 必須只呼叫 atomic startCollapsed');
assert.doesNotMatch(compactGateSource, /bridge\.start\(/, '首唱不得退回 start 後再等 timer');
const interactionSource = karaokeModeSource.match(
    /function isWindowInteracting\(\) \{[\s\S]*?\n    \}/
)?.[0] || '';
assert.match(interactionSource, /karaoke-picker-queue-pane/,
    '可見 Queue pane 要阻止 idle collapse');
assert.match(interactionSource, /k-youtube-queue-row/,
    'Queue row focus 要阻止 idle collapse');

// ===== Task 7. native collapse timer and interaction guards =====
assert.equal(typeof createKaraokeCollapseController, 'function', '要有單一 native collapse timer controller');
assert.equal(typeof createKaraokeWindowBlocker, 'function', '錯誤原因要能並存');

;(async () => {
    const state = { started: true, compact: true, autoCollapse: true, pinned: false, interacting: false, blockingError: false };
    const calls = [];
    const timers = [];
    const controller = createKaraokeCollapseController({
        bridge: {
            collapse: () => { calls.push('collapse'); return { ok: true }; },
            expand: () => { calls.push('expand'); return { ok: true }; },
        },
        getState: () => state,
        schedule: (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
        cancel: (timer) => { timer.cancelled = true; },
    });
    controller.arm();
    assert.equal(timers[0].delay, 3000, '必須使用 3000ms timer');
    state.interacting = true;
    controller.arm();
    assert.equal(timers[0].cancelled, true, '輸入／互動中要取消 timer');
    state.interacting = false;
    state.focused = true;
    controller.arm();
    assert.equal(timers.length, 1, '文字輸入焦點不得新增 timer');
    state.focused = false;
    state.pinned = true;
    controller.arm();
    assert.equal(timers.length, 1, '釘選展開不得新增 timer');
    state.pinned = false;
    state.blockingError = true;
    controller.arm();
    assert.equal(timers.length, 1, '錯誤狀態不得新增 timer');
    state.blockingError = false;
    state.compact = false;
    controller.arm();
    assert.equal(timers.length, 1, '完整控台不得新增收合 timer');
    state.compact = true;
    controller.arm();
    assert.equal(timers[1].delay, 3000, '解除互動後重新計時');
    timers[1].fn();
    assert.deepEqual(calls, ['collapse'], '閒置 3 秒才收合');
    controller.expand();
    assert.deepEqual(calls, ['collapse', 'expand'], 'hover/click 把手要展開');

    const pendingStarts = [];
    const lifecycleEvents = [];
    const generationGate = createKaraokeCompactStartGate({
        bridge: {
            startCollapsed: (options) => {
                let resolve;
                let reject;
                const promise = new Promise((nextResolve, nextReject) => {
                    resolve = nextResolve;
                    reject = nextReject;
                });
                pendingStarts.push({ options, promise, resolve, reject });
                return promise;
            },
            finish: () => { lifecycleEvents.push('finish'); return { ok: true }; },
        },
        onStarted: () => lifecycleEvents.push('started'),
        onError: (error) => lifecycleEvents.push(['error', error]),
    });
    const ownerBounds = { x: -1920, y: 0, width: 1920, height: 1080 };
    generationGate.arm('dQw4w9WgXcQ');
    generationGate.onState({ videoId: 'dQw4w9WgXcQ', revision: 1, state: 'playing', ownerWindowBounds: ownerBounds });
    generationGate.arm('9bZkp7q19f0');
    generationGate.onState({ videoId: '9bZkp7q19f0', revision: 2, state: 'playing', ownerWindowBounds: ownerBounds });
    pendingStarts[0].reject(new Error('stale-start-failed'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(lifecycleEvents, [], '新 session 建立後，舊 start failure 不得 finish 或 onError');
    pendingStarts[1].resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(lifecycleEvents, ['started'], '只有最新 start 才能 onStarted');
    generationGate.arm('kJQP7kiw5Fk');
    generationGate.onState({ videoId: 'kJQP7kiw5Fk', revision: 3, state: 'playing', ownerWindowBounds: ownerBounds });
    generationGate.finish();
    pendingStarts[2].resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(lifecycleEvents, ['started', 'finish'], 'finish 後舊 start success 不得重收合或觸發 callback');

    let resolveNativeCollapse;
    let nativeCollapseCalls = 0;
    const nativeCollapse = new Promise((resolve) => { resolveNativeCollapse = resolve; });
    const pendingTimers = [];
    const pendingController = createKaraokeCollapseController({
        bridge: {
            collapse: () => { nativeCollapseCalls += 1; return nativeCollapse; },
        },
        getState: () => ({ started: true, nativeStarted: true, compact: true, autoCollapse: true }),
        schedule: (fn, delay) => { const timer = { fn, delay }; pendingTimers.push(timer); return timer; },
        cancel: () => {},
    });
    pendingController.arm();
    const firstPending = pendingTimers[0].fn();
    const secondPending = pendingController.collapse();
    assert.equal(nativeCollapseCalls, 1, '原生 collapse 未完成前不得重複呼叫');
    assert.strictEqual(secondPending, firstPending, '重複呼叫應共用同一個 pending Promise');
    resolveNativeCollapse({ ok: true });
    await firstPending;

    const failedCalls = [];
    const failedTimers = [];
    const failedController = createKaraokeCollapseController({
        bridge: {
            collapse: () => { failedCalls.push('collapse'); return { ok: false, error: 'native-failed' }; },
            expand: () => { failedCalls.push('expand'); return { ok: true }; },
        },
        getState: () => ({ started: true, nativeStarted: true, compact: true, autoCollapse: true }),
        schedule: (fn) => { const timer = { fn }; failedTimers.push(timer); return timer; },
        cancel: () => {},
    });
    failedController.arm();
    failedTimers[0].fn();
    assert.deepEqual(failedCalls, ['collapse', 'expand'], 'native collapse 失敗要立即展開復原');

    let recoveries = 0;
    const blocker = createKaraokeWindowBlocker({ onClear: () => { recoveries += 1; } });
    blocker.set(true, 'playback');
    blocker.set(true, 'connection');
    blocker.set(false, 'connection');
    assert.equal(blocker.isBlocked(), true, 'connection 恢復時仍須保留 playback error');
    blocker.set(false, 'playback');
    assert.equal(blocker.isBlocked(), false, '全部錯誤解除後才恢復');
    assert.equal(recoveries, 1, '只在最後一個錯誤解除時重新允許收合');
    blocker.set(false, 'connection');
    assert.equal(recoveries, 1, '正常播放狀態持續回報時不得重設閒置計時器');
    console.log('test_karaoke_collapse_timer: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

assert.doesNotMatch(karaokeViewSource, /id="karaoke-mv"/, 'App 不得擁有 YouTube MV stage');
assert.doesNotMatch(karaokeViewSource, /src="\/js\/karaoke-mv\.js"/, 'App 不得載入第二個 MV player');
assert.doesNotMatch(karaokeViewSource, /id="karaoke-lines"/, 'App 不得擁有第二份歌詞 stage');
assert.doesNotMatch(karaokeViewSource, /id="karaoke-countin"/, 'App 不得擁有 local count-in');
assert.match(karaokeViewSource, /id="youtube-karaoke-results"/, 'App 保留候選 MV 控制');
assert.match(karaokeViewSource, /id="youtube-karaoke-current"/, 'App 保留目前歌曲控制');
assert.match(karaokeViewSource + karaokeFooterSource + karaokeLyricsModalSource, /id="lyrics-options-modal"/, 'App 保留備選歌詞控制');
assert.ok(!karaokeModeSource.includes('/api/current-media'), '卡拉OK頁不得讀一般 media API');
assert.ok(!karaokeModeSource.includes('mediaAction('), '卡拉OK頁控制不得走一般 mediaAction');
assert.ok(!karaokeModeSource.includes('mvLoad('), '卡拉OK頁不得建立第二個 MV player');
assert.match(karaokeModeSource, /msg\.type === ['"]youtube_karaoke_state['"]/, 'App controls consume YouTube owner state');
assert.doesNotMatch(karaokeModeSource, /karaoke(?:Fill|Paint)\s*\(/, 'App 不得在 YouTube session 本地填色');
assert.doesNotMatch(karaokeModeSource, /requestAnimationFrame\(frame\)/, 'App 不得執行 local lyrics frame loop');
assert.ok(karaokeViewSource.includes('/js/youtube-karaoke.js'), '卡拉OK頁要載入 YouTube state helper');
assert.ok(karaokeViewSource.includes('youtube-karaoke-warning'), '卡拉OK頁要有非阻塞候選警告');
assert.ok(karaokeViewSource.includes('繼續播放'), '候選警告要能繼續播放');
assert.ok(karaokeViewSource.includes('查看其他影片'), '候選警告要能查看其他影片');
for (const id of [
    'youtube-karaoke-query', 'youtube-karaoke-results', 'youtube-karaoke-now',
    'youtube-karaoke-queue', 'kbar-key', 'kbar-seek',
]) assert.ok(karaokeViewSource.includes(`id="${id}"`), `缺少 YouTube Karaoke UI: ${id}`);
assert.ok(commonSource.includes('youtubeKaraokeOnly'), '一般 media polling 要有 YouTube-only 停用閘門');

// ===== 8. App microphone ownership and explicit dry-recording lifecycle =====
assert.match(karaokeViewSource, /id="karaoke-pitch-recording"/, 'App 要提供乾聲錄音的明確操作區');
assert.match(karaokeViewSource, /id="karaoke-pitch-recording-save"/, '乾聲只能由儲存按鈕下載');
assert.match(karaokeViewSource, /id="karaoke-pitch-recording-discard"/, '乾聲要有捨棄按鈕');
assert.match(karaokeModeSource, /function createKaraokePitchLifecycle/, 'App mic lifecycle 要集中管理競態');
assert.match(karaokeModeSource, /createDryRecordingController/, 'App 要沿用既有乾聲錄音 controller');
assert.match(karaokeModeSource, /currentRecorder\.getStream\?\.\(\)/, '乾聲錄音必須使用同一個 App 麥克風 stream');
assert.match(karaokeModeSource, /finishTake\(currentRecorder\)[\s\S]*?disposeRecorder\(currentRecorder\)/,
    'App 離開時要先結束 take 再釋放麥克風');
assert.match(karaokeModeSource, /requestGeneration !== generation/, 'App stop 要取消過期 enable');
assert.match(karaokeModeSource, /pending-recording/, '未處理乾聲不得覆寫舊錄音');
assert.match(karaokeModeSource, /savePending[\s\S]*?discardPending/, '乾聲只允許明確儲存或捨棄');
assert.doesNotMatch(karaokeModeSource, /youtube_karaoke_pitch_(?:start|claim|release)/,
    'App mic 不得再轉發會觸發 extension capture 的命令');

// ===== 7. 共用點歌 picker 與歌詞來源邊界 =====
assert.strictEqual((karaokeViewSource.match(/id="youtube-karaoke-query"/g) || []).length, 1,
    '搜尋欄只能由同一個 picker 擁有');
for (const id of ['youtube-karaoke-results', 'youtube-karaoke-current', 'youtube-karaoke-queue']) {
    assert.strictEqual((karaokeViewSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1,
        `${id} 只能有一份`);
}
assert.match(karaokeViewSource, /id="karaoke-song-picker"/, '點歌與待唱要共用 picker');
assert.match(karaokeViewSource, /搜尋 YouTube 影片/, '搜尋 label 要說明唯一的 YouTube 搜尋入口');
assert.match(karaokeViewSource, /歌手、歌名或貼上 YouTube 網址/, '搜尋框要說明完整文字與 URL 用法');
assert.doesNotMatch(karaokeViewSource, /id="karaoke-console-summary"[^>]*aria-live=/,
    'console summary 不應讓 250ms state repaint 反覆朗讀');
assert.match(karaokeViewSource, /id="karaoke-console-state"[^>]*role="status"[^>]*aria-live="polite"/,
    '只有離散 console state 要進 live region');
assert.match(karaokeViewSource, /id="karaoke-picker-tab-search"[^>]*aria-controls="karaoke-picker-results-pane"/,
    '點歌 tab 要指向搜尋結果 panel');
assert.match(karaokeViewSource, /id="karaoke-picker-tab-queue"[^>]*aria-controls="karaoke-picker-queue-pane"/,
    '待唱 tab 要指向 Queue panel');
assert.match(karaokeViewSource, /id="karaoke-picker-results-pane"[^>]*role="tabpanel"/,
    '搜尋結果要是 tabpanel');
assert.match(karaokeViewSource, /id="karaoke-picker-queue-pane"[^>]*role="tabpanel"/,
    'Queue 要是 tabpanel');
assert.match(karaokeViewSource, /youtube-karaoke-query-label/,
    '搜尋 label 要保留鍵盤可達的唯一搜尋欄');
assert.match(karaokeCssSource, /#karaoke-song-picker/, 'picker 要有完整頁布局');
assert.match(karaokeCssSource, /body\.karaoke-page[^\n]*#karaoke-song-picker|body\.karaoke-page[\s\S]*#karaoke-song-picker/,
    'karaoke-page 仍要顯示同一個 picker');

// ===== Task 4. one-search contract (RED before implementation) =====
assert.strictEqual((karaokeViewSource.match(/<input\b[^>]*id="youtube-karaoke-query"/g) || []).length, 1,
    '點歌首頁只能有一個 YouTube 搜尋框');
assert.doesNotMatch(karaokeViewSource, /data-karaoke-search-focus|id="karaoke-search-mode-/,
    '搜尋不得再顯示歌名／歌手選擇器或來源模式');
assert.doesNotMatch(karaokeModeSource, /\bsearchMode\b|setSearchMode|searchCachedLyrics/,
    '搜尋 renderer 不得保留死掉的 searchMode 分支');
assert.match(karaokeModeSource, /async function searchYouTube\(queryOverride = ''\) \{/,
    'YouTube search 要接收完整使用者文字');
assert.match(karaokeModeSource, /searchButton\?\.addEventListener\(['"]click['"], \(\) => searchYouTube\(\)\)/,
    '搜尋按鈕 click 不得把 DOM event 當成 query');

assert.doesNotMatch(karaokeModeSource, /selectCachedSong|k-cached-lyric-result/,
    'YouTube 點歌頁不得保留歌詞模式的結果分支');

// ===== Task 2. 一點即唱；演唱中點歌只加入待唱 =====
const pickResultSource = karaokeModeSource.match(
    /    function pickResult\(item(?:, confirmed = false)?\) \{[\s\S]*?\r?\n    \}/
)?.[0];
assert.ok(pickResultSource, '結果列必須共用單一 pickResult seam');

// Task 3B: automatic canonical lookup is explicitly non-forced; reload stays forced.
const requestCanonicalLyricsSource = karaokeModeSource.match(
    /    function requestCanonicalLyrics\(force = false\) \{[\s\S]*?\r?\n    \}/
)?.[0];
assert.ok(requestCanonicalLyricsSource, '找得到 canonical lyrics request seam');
{
    const requests = [];
    const requestContext = {
        currentItem: { videoId: 'dQw4w9WgXcQ' },
        extensionState: { videoId: 'dQw4w9WgXcQ', revision: 4 },
        title: 'Song', artist: 'Artist', canonicalRefreshPending: false,
        window: { sendMediaSocket(message, stickyKey) { requests.push({ message, stickyKey }); } },
    };
    const requestCanonicalLyrics = vm.runInNewContext(`(${requestCanonicalLyricsSource})`, requestContext);
    assert.equal(requestCanonicalLyrics(false), true);
    assert.equal(requestCanonicalLyrics(true), true);
    assert.equal(requests[0].message.force, false, '初次 canonical lookup 必須明傳 force:false');
    assert.equal(requests[1].message.force, true, '明確 reload 必須明傳 force:true');
    assert.equal(requests[0].stickyKey, undefined, 'canonical request 不得覆蓋 karaoke_active sticky state');
    assert.equal(requests[1].stickyKey, undefined, 'explicit reload 不得覆蓋 karaoke_active sticky state');
}

assert.match(karaokeModeSource,
    /row\.addEventListener\(['"]click['"], \(\) => pickResult\(item\)\)/,
    '影片結果 click 必須走唯一 pickResult，不得分流到歌詞模式');
assert.doesNotMatch(karaokeModeSource.match(
    /    function renderSearchResults\(items\) \{[\s\S]*?\r?\n    \}/
)?.[0] || '', /karaokeStart\(/,
    'renderSearchResults 不得因預選候選自動開唱');
assert.match(karaokeCssSource,
    /body:not\(\.karaoke-page\)\s+#karaoke-picker-queue-pane\s*\{\s*display:\s*none;\s*\}/,
    '尚未開始時不得呈現空待唱面板');
assert.match(karaokeCssSource,
    /body:not\(\.karaoke-page\)\s+#youtube-karaoke-selected\s*\{\s*display:\s*none;\s*\}/,
    '尚未開始時不得呈現二次現在唱操作');
assert.match(karaokeCssSource,
    /body:has\(#karaoke-song-picker\):not\(\.karaoke-page\)\s+\.player-bar\s*\{\s*display:\s*none;\s*\}/,
    '卡拉OK 初始頁也不得呈現 footer player bar');

const reliableVideo = {
    videoId: 'dQw4w9WgXcQ', title: 'Reliable', channel: 'Official', durationSec: 180,
    thumb: 'https://img/reliable', ok: true, official: true, durationDeltaSec: 0,
};
const suspiciousVideo = {
    videoId: 'kJQP7kiw5Fk', title: 'Maybe another version', channel: 'Uploader', durationSec: 240,
    thumb: 'https://img/suspicious', ok: true, official: false,
};
const oneSearchVideo = {
    videoId: 'M7lc1UVf-VE', title: 'Exact search', channel: 'Uploader', durationSec: 180,
    thumb: 'https://img/one-search', ok: true, durationDeltaSec: 0, needsConfirmation: false,
};

function exercisePickResult({ started, item: rawItem, confirm = false } = {}) {
    const actions = [];
    const added = [];
    const context = {
        started,
        pendingCandidate: null,
        youtube: { toYouTubeQueueItem },
        prefetchQueuedLyrics(item) { actions.push(['prefetch', item.videoId]); },
        queue: { add(item) {
            const queued = { ...item, queueId: `q-${added.length + 1}` };
            added.push(queued);
            return queued;
        }, snapshot() { return { items: added }; } },
        window: { karaokeStart(item) { actions.push(['start', item.videoId]); return { ok: true }; } },
        selectSearchResult() {},
        showCandidateWarning() { actions.push(['warn']); },
        clearCandidateWarning() {},
        setSearchStatus() {},
        renderQueue() {},
    };
    const pickResult = vm.runInNewContext(`(${pickResultSource})`, context);
    const result = pickResult(rawItem, confirm);
    return { actions, added, result, context, pickResult };
}

{
    const first = exercisePickResult({ started: false, item: reliableVideo });
    assert.deepStrictEqual(first.actions, [['start', reliableVideo.videoId]],
        '第一首可靠影片的一次 click 必須直接走 karaokeStart');
    assert.strictEqual(first.added.length, 0, '第一首由 karaokeStart 建立唯一 Queue item');
}
{
    const first = exercisePickResult({ started: false, item: oneSearchVideo });
    assert.deepStrictEqual(first.actions, [['start', oneSearchVideo.videoId]],
        '一欄搜尋的乾淨候選一次 click 必須直接走 karaokeStart/load/play');
    assert.strictEqual(first.added.length, 0, '一欄搜尋首歌由 karaokeStart 建立唯一 Queue item');
}
{
    const later = exercisePickResult({ started: true, item: reliableVideo });
    assert.deepStrictEqual(later.actions, [['prefetch', reliableVideo.videoId]],
        '演唱中點第二首要立即預查但不得觸發 karaokeStart/load/play');
    assert.strictEqual(later.added.length, 1, '演唱中點第二首只加入一筆待唱');
}
{
    const suspicious = exercisePickResult({ started: false, item: suspiciousVideo });
    assert.deepStrictEqual(suspicious.actions, [['warn']], '可疑候選未確認只能顯示確認提示');
    assert.strictEqual(suspicious.added.length, 0, '可疑候選未確認不得加入 Queue');
    assert.strictEqual(suspicious.context.pendingCandidate.videoId, suspiciousVideo.videoId,
        '可疑候選要保留給明示確認');
    const confirmed = suspicious.pickResult(suspiciousVideo, true);
    assert.deepStrictEqual(suspicious.actions, [['warn'], ['start', suspiciousVideo.videoId]],
        '明示確認後才走同一條首歌開唱路徑');
    assert.deepStrictEqual(confirmed, { ok: true });
}
{
    const invalid = exercisePickResult({ started: false, item: { title: 'not a video' } });
    assert.deepStrictEqual(invalid.actions, [], '沒有合法 videoId 的候選不得觸發任何動作');
    assert.strictEqual(invalid.added.length, 0);
}
{
    const singingSuspicious = exercisePickResult({
        started: true,
        item: { ...suspiciousVideo, needsConfirmation: true, replaceCurrent: true },
    });
    assert.deepStrictEqual(singingSuspicious.actions, [['warn']],
        '演唱中按現在唱的可疑候選仍要先顯示確認提示');
    assert.strictEqual(singingSuspicious.added.length, 0,
        '演唱中按現在唱的可疑候選確認前不得入列');
    const confirmed = singingSuspicious.pickResult(singingSuspicious.context.pendingCandidate, true);
    assert.deepStrictEqual(singingSuspicious.actions, [['warn'], ['start', suspiciousVideo.videoId]],
        'warning-continue 後要替換現在唱，不得把可疑候選偷偷當成待播');
    assert.deepStrictEqual(confirmed, { ok: true });
}

// 直接執行 production pickResult → karaokeStart → loadYouTubeItem chain，確認一欄搜尋首點只有一組 load/play。
const nowClickSource = karaokeModeSource.match(
    /    document\.getElementById\(['"]youtube-karaoke-now['"]\)\?\.addEventListener\(['"]click['"], \(\) => \{[\s\S]*?\r?\n    \}\);/
)?.[0];
assert.ok(nowClickSource, '找得到現在唱 click handler');
let nowClick = null;
const nowActions = [];
const nowButton = { addEventListener(event, handler) { if (event === 'click') nowClick = handler; } };
vm.runInNewContext(nowClickSource, {
    document: { getElementById(id) { return id === 'youtube-karaoke-now' ? nowButton : null; } },
    selectedResult: { ...suspiciousVideo, needsConfirmation: true },
    started: true,
    window: { karaokeStart(item) { nowActions.push(['start', item.videoId]); } },
    pickResult(item, confirmed) { nowActions.push(['pick', confirmed, item]); },
});
nowClick();
assert.strictEqual(nowActions[0]?.[0], 'pick',
    '演唱中現在唱不得直接繞過 pickResult');
assert.notStrictEqual(nowActions[0]?.[1], true,
    '演唱中現在唱不得把可疑候選標成已確認');

const sendYouTubeCommandSource = karaokeModeSource.match(
    /    function sendYouTubeCommand\(action, payload = \{\}\) \{[\s\S]*?\r?\n    \}/
)?.[0];
const loadYouTubeItemSource = karaokeModeSource.match(
    /    function loadYouTubeItem\(item, autoplay = true\) \{[\s\S]*?\r?\n    \}/
)?.[0];
const karaokeStartSource = karaokeModeSource.match(
    /    window\.karaokeStart = function \(item = selectedResult\) \{[\s\S]*?\r?\n    \};/
)?.[0];
assert.ok(sendYouTubeCommandSource && loadYouTubeItemSource && karaokeStartSource,
    '找得到首歌 production load/play chain');
const chainActions = [];
const chainContext = {
    youtube: { toYouTubeQueueItem, createYouTubeCommand, startYouTubeSong },
    KARAOKE_ACTIVE_STICKY_KEY: 'karaoke-active',
    queue: createYouTubeKaraokeQueue(),
    commandId: 0,
    extensionState: { state: 'idle', videoId: '', positionMs: 0, durationMs: 0, keySemitones: 0, revision: 0 },
    warnedCandidateVideoId: '',
    currentItem: null,
    selectedResult: null,
    started: false,
    playing: false,
    clearCandidateWarning() {},
    setCurrentSong() {},
    renderQueue() {},
    setPickerPane() {},
    paintPlayBtn() {},
    setWindowBlocked() {},
    compactGate: { arm() {} },
    showBar() {},
    setSearchStatus() {},
    prefetchQueuedLyrics(item) { chainActions.push({ type: 'prefetch-call', videoId: item.videoId }); },
    document: { body: { classList: { add() {}, remove() {} } } },
    window: {
        __mediaSocketAlive: true,
        sendMediaSocket(message, stickyKey) { chainActions.push({ ...message, stickyKey }); },
    },
};
chainContext.sendYouTubeCommand = vm.runInNewContext(`(${sendYouTubeCommandSource})`, chainContext);
chainContext.loadYouTubeItem = vm.runInNewContext(`(${loadYouTubeItemSource})`, chainContext);
const karaokeStartFunctionSource = karaokeStartSource
    .replace(/^\s*window\.karaokeStart\s*=\s*/, '')
    .replace(/;\s*$/, '');
chainContext.window.karaokeStart = vm.runInNewContext(`(${karaokeStartFunctionSource})`, chainContext);
const productionPickResult = vm.runInNewContext(`(${pickResultSource})`, chainContext);
productionPickResult(oneSearchVideo);
const activeIndex = chainActions.findIndex((message) => message.type === 'karaoke_active');
const prefetchIndex = chainActions.findIndex((message) => message.type === 'prefetch-call');
const loadIndex = chainActions.findIndex((message) => message.type === 'youtube_karaoke_command'
    && message.command.action === 'load');
assert.ok(activeIndex >= 0 && prefetchIndex > activeIndex && loadIndex > prefetchIndex,
    '一欄搜尋首首預查要在 App 標記 active 後、owner load/revision 前立即開始');
assert.equal(chainActions[activeIndex].stickyKey, 'karaoke-active',
    'reconnect 要重送 karaoke_active，而不是把查詢 request 當成角色旗標');
assert.deepStrictEqual(
    chainActions.filter((message) => message.type === 'youtube_karaoke_command').map((message) => message.command.action),
    ['load', 'play'],
    '一欄搜尋首首的一次點擊必須只發送一次 load 與一次 play',
);
assert.strictEqual(chainContext.queue.snapshot().items.length, 1,
    '一欄搜尋首首的一次點擊只能建立一筆 Queue item');

// 「查看其他影片」要清掉去重 id，拒絕後再點同一可疑候選仍可重新確認。
const showCandidateWarningSource = karaokeModeSource.match(
    /    function showCandidateWarning\(item\) \{[\s\S]*?\r?\n    \}/
)?.[0];
const warningOtherSource = karaokeModeSource.match(
    /    document\.getElementById\(['"]youtube-karaoke-warning-other['"]\)\?\.addEventListener\(['"]click['"], \(\) => \{[\s\S]*?\r?\n    \}\);/
)?.[0];
assert.ok(showCandidateWarningSource && warningOtherSource, '找得到可疑候選 warning lifecycle');
const warningClassOps = [];
const warningBanner = { classList: {
    add(name) { warningClassOps.push(['add', name]); },
    remove(name) { warningClassOps.push(['remove', name]); },
} };
const warningMessage = { textContent: '' };
const warningCandidate = { ...suspiciousVideo, needsConfirmation: true };
const warningOtherButton = {
    handler: null,
    addEventListener(event, handler) {
        if (event === 'click') this.handler = handler;
    },
};
const warningContext = {
    warnedCandidateVideoId: '',
    pendingCandidate: warningCandidate,
    candidate: warningCandidate,
    warningOtherButton,
    document: { getElementById(id) {
        if (id === 'youtube-karaoke-warning') return warningBanner;
        if (id === 'youtube-karaoke-warning-message') return warningMessage;
        if (id === 'youtube-karaoke-warning-other') return warningOtherButton;
        if (id === 'youtube-karaoke-query') return { focus() {} };
        return null;
    } },
    clearCandidateWarning() { warningBanner.classList.add('hidden'); },
    selectSearchResult() {},
    setSearchStatus() {},
};
const warningVm = vm.createContext(warningContext);
vm.runInContext(`
    const showCandidateWarning = (${showCandidateWarningSource});
    showCandidateWarning(candidate);
    ${warningOtherSource}
    warningOtherButton.handler();
    showCandidateWarning(candidate);
`, warningVm);
assert.strictEqual(warningClassOps.filter(([action]) => action === 'remove').length, 2,
    '查看其他影片後再次點同一候選仍要顯示確認提示');

// Key 目前值本身就是歸零按鈕；state replay 仍要更新同一個 DOM 節點。
assert.match(karaokeViewSource,
    /<button type="button" id="kbar-key-value" aria-label="Key 歸零" title="點擊回原 Key">0<\/button>/,
    'Key 目前值要是唯一的歸零按鈕');
assert.doesNotMatch(karaokeViewSource, /id="kbar-key-zero"/, '不得保留獨立 Key 歸零按鈕');
assert.match(karaokeModeSource,
    /document\.getElementById\(['"]kbar-key-value['"]\)\?\.addEventListener\(['"]click['"], \(\) => setYouTubeKey\(0\)\)/,
    'Key 目前值 click 必須送出 setYouTubeKey(0)');
const setYouTubeKeySource = karaokeModeSource.match(
    /    function setYouTubeKey\(value\) \{[\s\S]*?\n    \}/
)?.[0];
assert.ok(setYouTubeKeySource, '找得到 setYouTubeKey');
assert.doesNotMatch(setYouTubeKeySource, /kbar-key-value/,
    'Key 目前值只能由 applyState 的 YouTube state 更新');

const applyStateSource = karaokeModeSource.match(
    /    function applyState\(message\) \{[\s\S]*?\n    \}\r?\n\r?\n    \/\/ ===================== 進入 \/ 離開 =====================/
)?.[0].replace(/\r?\n\r?\n    \/\/ ===================== 進入 \/ 離開 =====================$/, '');
assert.ok(applyStateSource, '找得到 applyState');
const keyValueElement = { textContent: '0' };
const seekElement = { max: '', value: '' };
const stateContext = {
    currentItem: { videoId: 'song' },
    extensionState: { videoId: 'song', state: 'paused', positionMs: 0, durationMs: 1000, keySemitones: 0, revision: 1 },
    youtube: {
        readYouTubeState: (message) => message.state || message,
        applyYouTubeState: (previous, incoming) => ({ ...previous, ...incoming }),
    },
    document: { getElementById(id) {
        return id === 'kbar-key-value' ? keyValueElement : id === 'kbar-seek' ? seekElement : null;
    } },
    pitchRecorder: null,
    compactGate: { onState() {} },
    windowBlocker: { reasons: () => new Set() },
    setWindowBlocked() {},
    showCandidateWarning() {},
    paintConsoleSong() {},
    paintConsoleState() {},
    setPitchPlaybackStatus() {},
    paintPlayBtn() {},
    requestCanonicalLyrics() {},
    setSearchStatus() {},
    canonicalRefreshPending: false,
};
const applyState = vm.runInNewContext(`(${applyStateSource})`, stateContext);
for (const keySemitones of [-6, 0, 6]) {
    applyState({ type: 'youtube_karaoke_state', state: {
        videoId: 'song', state: 'playing', positionMs: 0, durationMs: 1000, keySemitones, revision: 1,
    } });
    assert.strictEqual(keyValueElement.textContent, String(keySemitones),
        `youtube_karaoke_state 要更新 Key 目前值為 ${keySemitones}`);
}

assert.doesNotMatch(karaokeModeSource, /createYouTubeLyricsMessage/, 'controller 不得直接建構未版本化歌詞 payload');
assert.doesNotMatch(karaokeModeSource, /sendMediaSocket\(.*youtube-karaoke-lyrics/, 'controller 不得直接 relay 歌詞 payload');
assert.match(karaokeModeSource, /type:\s*['"]youtube_karaoke_search['"]/, 'controller 必須走 canonical search path');
function assertSourceOrder(...needles) {
    let at = -1;
    for (const needle of needles) {
        const next = karaokeModeSource.indexOf(needle, at + 1);
        assert.ok(next > at, `source order: ${needle}`);
        at = next;
    }
}
assertSourceOrder('syncOffset = o.offset || 0;', 'paintOffset();', 'requestCanonicalLyrics();');
assertSourceOrder('syncOffset = liveOffset;', 'paintOffset();', 'requestCanonicalLyrics();');
assertSourceOrder('window.karaokeAdjustOffset = function', 'paintOffset();', 'saveOffset();');
assertSourceOrder('window.karaokeResetOffset = function', 'paintOffset();', 'saveOffset();');
assertSourceOrder('currentItem = queued;', 'setCurrentSong(queued);');

// Live search must send the complete user query and keep metadata cleanup internal.
(async () => {
    let requestedUrl = '';
    const input = { value: '米津玄師 Lemon' };
    const button = { disabled: false };
    const searchFunction = karaokeModeSource.match(
        /    async function searchYouTube\(queryOverride = ''\) \{[\s\S]*?\n    \}/
    )?.[0];
    assert.ok(searchFunction, '找得到 live search function');
    const context = {
        artist: '目前歌曲歌手不得污染搜尋文字',
        currentItem: { durationSec: 274 },
        searchGeneration: 0,
        searchResults: [],
        window: { currentMediaDuration: 274 },
        document: { getElementById(id) { return id === 'youtube-karaoke-query' ? input : button; } },
        encodeURIComponent,
        fetch: async (url) => {
            requestedUrl = url;
            return { ok: true, json: async () => ({ results: [] }) };
        },
        renderSearchResults() {},
        setSearchStatus() {},
        youtube: { toYouTubeQueueItem() { return null; } },
    };
    const searchYouTube = vm.runInNewContext(`(${searchFunction})`, context);
    await searchYouTube();
    assert.strictEqual(requestedUrl,
        '/api/mv/search?title=%E7%B1%B3%E6%B4%A5%E7%8E%84%E5%B8%AB%20Lemon&artist=&duration=274',
        'live search request must carry the complete input and duration');
    await searchYouTube('https://youtu.be/dQw4w9WgXcQ');
    assert.strictEqual(requestedUrl,
        '/api/mv/search?title=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&artist=&duration=274',
        'pasted YouTube URL must stay intact through the existing search path');

    // 換歌後 offset lookup 失敗時,後續歌詞 relay 不得沿用上一首的 offset。
    const offsetFlow = karaokeModeSource.match(
        /        (?:syncOffset = 0;\r?\n        paintOffset\(\);\r?\n        )?const requestedOffsetKey = offsetSongKey\(title, artist\);[\s\S]*?        requestCanonicalLyrics\(\);\r?\n            \}\)\.catch\(\(\) => \{\}\);\r?\n/
    )?.[0];
    assert.ok(offsetFlow, '找得到 per-song offset lookup flow');
    const relayAfterFailedOffsetLookup = await vm.runInNewContext(`(async () => {
        let syncOffset = 1.25;
        let title = 'New Song';
        let artist = 'Artist';
        let requested = 0;
        let rejectLookup;
        const offsetSongKey = (t, a) => t + '||' + a;
        const paintOffset = () => {};
        const requestCanonicalLyrics = () => { requested += 1; };
        const fetch = () => new Promise((resolve, reject) => { rejectLookup = reject; });
${offsetFlow}
        rejectLookup(new Error('lookup failed'));
        await Promise.resolve();
        return { syncOffset, requested };
    })()`, {});
    assert.strictEqual(relayAfterFailedOffsetLookup.syncOffset, 0,
        'failed new-song offset lookup must keep sync offset at zero');
    assert.strictEqual(relayAfterFailedOffsetLookup.requested, 0,
        'failed new-song offset lookup must not publish a controller payload');
    console.log('test_karaoke_mode: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// ===== 10. App microphone lifecycle is runnable, serialized and explicit =====
;(async () => {
    assert.equal(typeof createKaraokePitchLifecycle, 'function', 'App 要暴露可測的 mic lifecycle');

    const song = { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist' };
    let started = true;
    let recorderCount = 0;
    let getUserMediaCalls = 0;
    let dryStreams = [];
    let downloads = 0;
    let discards = 0;
    const order = [];
    const recorders = [];
    const dryControllers = [];

    const makeRecorder = () => {
        recorderCount += 1;
        const track = { stopped: false, stop() { this.stopped = true; order.push(`track-stop-${recorderCount}`); } };
        const stream = { getTracks: () => [track] };
        const recorder = {
            stream,
            track,
            enable: async () => { getUserMediaCalls += 1; order.push(`enable-${recorderCount}`); return { enabled: true }; },
            getStream: () => stream,
            startTake: () => { order.push(`start-take-${recorderCount}`); },
            finishTake: () => { order.push(`finish-${recorderCount}`); return { status: 'ready', frames: [], range: {} }; },
            dispose: async () => { order.push(`dispose-${recorderCount}`); track.stop(); },
        };
        recorders.push(recorder);
        return recorder;
    };
    const makeDryRecording = () => {
        const controller = {
            start: (stream) => { dryStreams.push(stream); return { ok: true }; },
            stop: async () => ({ blob: { type: 'audio/webm' }, fileName: 'take.webm' }),
            discard: async () => { discards += 1; },
            download: () => { downloads += 1; return true; },
        };
        dryControllers.push(controller);
        return controller;
    };
    const session = createKaraokePitchLifecycle({
        createRecorder: makeRecorder,
        createDryRecording: makeDryRecording,
        getCurrentSong: () => song,
        isStarted: () => started,
        finishTake: (recorder) => recorder.finishTake(),
    });

    assert.equal(getUserMediaCalls, 0, '按下 App mic 前不得請求麥克風');
    const firstStart = await session.start(song);
    assert.deepEqual(firstStart, { ok: true, status: 'enabled' });
    assert.equal(getUserMediaCalls, 1, '按下 App mic 後只請求一次麥克風');
    assert.strictEqual(dryStreams[0], recorders[0].stream, '乾聲必須使用同一個 App stream');

    const firstStop = await session.stop();
    assert.deepEqual(firstStop.take, { status: 'ready', frames: [], range: {} });
    assert.ok(order.indexOf('finish-1') < order.indexOf('dispose-1'), '退出要先 finishTake 再 dispose');
    assert.equal(recorders[0].track.stopped, true, '退出要停止麥克風 tracks');
    assert.equal(downloads, 0, '停止不得自動下載乾聲');
    assert.ok(session.getPendingRecording(), '停止後要保留待處理乾聲');
    assert.deepEqual(await session.start(song), { ok: false, error: 'pending-recording' },
        '未儲存或捨棄前不得覆寫舊錄音');
    assert.equal(recorderCount, 1, 'pending recording 存在時不得建立新 recorder');
    assert.equal(await session.savePending(), true, '儲存必須是明確操作');
    assert.equal(downloads, 1);
    assert.equal(session.getPendingRecording(), null);

    assert.deepEqual(await session.start(song), { ok: true, status: 'enabled' });
    assert.equal(recorderCount, 2, '重進要建立 fresh recorder');
    assert.strictEqual(dryStreams[1], recorders[1].stream, '第二次乾聲仍使用當次 App stream');
    const secondStop = await session.stop({ discardRecording: true });
    assert.equal(secondStop.recording, undefined);
    assert.equal(discards, 1, '明確捨棄要 discard 乾聲');
    assert.equal(downloads, 1, '捨棄不得下載');

    let resolveRaceEnable;
    let raceStarts = 0;
    let raceDisposed = 0;
    const raceTrack = { stopped: false, stop() { this.stopped = true; } };
    const raceStream = { getTracks: () => [raceTrack] };
    const raceRecorder = {
        enable: () => new Promise((resolve) => { resolveRaceEnable = resolve; }),
        getStream: () => raceStream,
        startTake: () => { raceStarts += 1; },
        finishTake: () => ({ status: 'ready', frames: [], range: {} }),
        dispose: async () => {
            raceDisposed += 1;
            raceTrack.stop();
            resolveRaceEnable?.({ enabled: false, error: 'microphone-disposed' });
        },
    };
    const raceSession = createKaraokePitchLifecycle({
        createRecorder: () => raceRecorder,
        createDryRecording: makeDryRecording,
        getCurrentSong: () => song,
        isStarted: () => started,
        finishTake: (recorder) => recorder.finishTake(),
    });
    const raceStart = raceSession.start(song);
    await Promise.resolve();
    const raceStop = raceSession.stop({ discardRecording: true });
    const [raceStartResult, raceStopResult] = await Promise.all([raceStart, raceStop]);
    assert.equal(raceStartResult.ok, false, 'stop 取消 pending enable');
    assert.equal(raceStartResult.error, 'cancelled');
    assert.deepEqual(raceStopResult, { ok: true, status: 'stopped', take: null });
    assert.equal(raceStarts, 0, '取消後不得 startTake');
    assert.equal(raceDisposed > 0, true, '取消 pending enable 必須 dispose');
    assert.equal(raceTrack.stopped, true, '取消 race 不得留下 microphone track');
    assert.equal(raceSession.isEnabled(), false);

    started = false;
    assert.deepEqual(await session.start(song), { ok: false, error: 'song-required' }, '未進入 App 不得啟用 mic');
    console.log('test_karaoke_pitch_lifecycle: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// ===== 9. pending search + 空查詢要釋放搜尋按鈕 =====
;(async () => {
    const searchFunction = karaokeModeSource.match(
        /    async function searchYouTube\(queryOverride = ''\) \{[\s\S]*?\n    \}/
    )?.[0];
    assert.ok(searchFunction, '找得到唯一 YouTube search function');
    const input = { value: '舊歌' };
    const button = { disabled: false };
    let resolvePending;
    const context = {
        artist: '正在唱歌手',
        currentItem: { durationSec: 274 },
        searchGeneration: 0,
        searchResults: [],
        selectedResult: null,
        window: { currentMediaDuration: 274 },
        document: { getElementById(id) { return id === 'youtube-karaoke-query' ? input : button; } },
        encodeURIComponent,
        fetch: () => new Promise((resolve) => { resolvePending = resolve; }),
        renderSearchResults() {},
        setSearchStatus() {},
        youtube: { toYouTubeQueueItem(item) { return item; } },
    };
    const search = vm.runInNewContext(`(${searchFunction})`, context);
    const pending = search();
    await Promise.resolve();
    assert.strictEqual(button.disabled, true, 'pending search 要鎖定按鈕');
    input.value = '';
    await search();
    assert.strictEqual(button.disabled, false,
        '清空輸入後按 Enter 要釋放 pending search 按鈕');
    resolvePending({ ok: true, json: async () => ({ results: [], items: [] }) });
    await pending;
    console.log('test_karaoke_blank_search_unlock: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// ===== 8. 搜尋 race、完整文字與版本時長 =====
;(async () => {
    const searchFunction = karaokeModeSource.match(
        /    async function searchYouTube\(queryOverride = ''\) \{[\s\S]*?\n    \}/
    )?.[0];
    assert.ok(searchFunction, '找得到唯一 YouTube search');
    const input = { value: '夜の花' };
    const button = { disabled: false };
    const requests = [];
    const context = {
        artist: '正在唱歌手',
        currentItem: { durationSec: 274 },
        searchGeneration: 0,
        searchResults: [],
        window: { currentMediaDuration: 274 },
        document: { getElementById(id) { return id === 'youtube-karaoke-query' ? input : button; } },
        encodeURIComponent,
        fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ results: [] }) }; },
        renderSearchResults() {},
        setSearchStatus() {},
        youtube: { toYouTubeQueueItem() { return null; } },
    };
    const searchYouTube = vm.runInNewContext(`(${searchFunction})`, context);
    await searchYouTube('夜の花 花歌手');
    assert.strictEqual(requests.at(-1),
        '/api/mv/search?title=%E5%A4%9C%E3%81%AE%E8%8A%B1%20%E8%8A%B1%E6%AD%8C%E6%89%8B&artist=&duration=274',
        '完整搜尋文字不得拆成 title／artist 或省略 duration');
    await searchYouTube();
    assert.strictEqual(requests.at(-1),
        '/api/mv/search?title=%E5%A4%9C%E3%81%AE%E8%8A%B1&artist=&duration=274',
        '共用搜尋欄重試要只送欄內完整文字');
    input.value = '別首 歌手';
    await searchYouTube();
    assert.strictEqual(requests.at(-1),
        '/api/mv/search?title=%E5%88%A5%E9%A6%96%20%E6%AD%8C%E6%89%8B&artist=&duration=274',
        '手動改查詢後要把整段文字送入 YouTube query');

    let resolveFirst;
    let resolveSecond;
    let call = 0;
    const rendered = [];
    const raceContext = {
        artist: '', currentItem: null, searchGeneration: 0, searchResults: [], selectedResult: null,
        window: { currentMediaDuration: 0 },
        document: { getElementById(id) { return id === 'youtube-karaoke-query' ? { value: '' } : { disabled: false }; } },
        encodeURIComponent,
        fetch: (url) => new Promise((resolve) => {
            if (++call === 1) resolveFirst = () => resolve({ ok: true, json: async () => ({ results: [
                { videoId: 'dQw4w9WgXcQ', title: 'first', channel: 'A', thumb: '', durationSec: 1 },
            ] }) });
            else resolveSecond = () => resolve({ ok: true, json: async () => ({ results: [
                { videoId: 'kJQP7kiw5Fk', title: 'second', channel: 'B', thumb: '', durationSec: 2 },
            ] }) });
        }),
        renderSearchResults(items) { rendered.push(items.map((item) => item.title)); },
        setSearchStatus() {},
        youtube: { toYouTubeQueueItem(item) { return item; } },
    };
    const raceSearch = vm.runInNewContext(`(${searchFunction})`, raceContext);
    const first = raceSearch('first A');
    const second = raceSearch('second B');
    resolveSecond();
    await new Promise((resolve) => setImmediate(resolve));
    resolveFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(rendered.at(-1), ['second'], '舊搜尋回覆不得覆寫最新結果');
    console.log('test_karaoke_search_race: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
