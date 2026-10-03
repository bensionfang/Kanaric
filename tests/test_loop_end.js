// 段落循環尾段間奏防護的自檢。直接執行 app.js 的終點函式，避免鏡射公式跟實作分岔。
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const factor = source.match(/const LOOP_TAIL_FACTOR = [^\n]+;/)?.[0];
const endFn = source.match(/function loopEndTime\(\) \{[\s\S]*?\n\}/)?.[0];
if (!factor || !endFn) throw new Error('找不到段落循環終點函式');

function computeMedianGap(times) {
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 0) gaps.push(d);
    }
    if (!gaps.length) return 4;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
}

// bTime = B 句開始, nextTime = B+1 句開始 (null 代表 B 是最後一句), hardFallback = 歌曲結束秒數
function loopEndTime(bTime, nextTime, duration, medianGap, offset = 0) {
    const state = vm.createContext({
        parsedLyrics: [{ time: bTime }, ...(nextTime == null ? [] : [{ time: nextTime }])],
        loopB: 0,
        window: { currentMediaDuration: duration },
        songDurationSeconds: 180,
        medianLineGap: medianGap,
        syncOffset: offset
    });
    return vm.runInContext(`${factor}\n${endFn}\nloopEndTime()`, state);
}

function eq(a, b, msg) {
    if (Math.abs(a - b) > 1e-9) { console.error(`FAIL ${msg}: ${a} !== ${b}`); process.exit(1); }
    console.log(`ok   ${msg}`);
}

// 中位數:規律 4 秒一句
eq(computeMedianGap([0, 4, 8, 12]), 4, 'median 規律間隔');
// 中位數:混一段間奏 (outlier) 不該把中位數拉歪
eq(computeMedianGap([0, 4, 8, 40, 44, 48]), 4, 'median 對間奏 outlier 穩健');
// 全是同時間戳 / unsynced → 沒有正間隔 → 預設 4
eq(computeMedianGap([-1, -1, -1]), 4, 'median unsynced 退回預設');

const med = 4;   // cap = B + 4*1.6 = B + 6.4
// 正常尾段:下一句 4 秒後就來,cap 沒到,原樣用下一句 (行為不變)
eq(loopEndTime(100, 104, 999, med), 104, '正常尾段不夾');
// 尾段間奏:下一句 30 秒後才來,夾在 B+6.4 提早跳回
eq(loopEndTime(100, 130, 999, med), 106.4, '尾段間奏被夾住');
// B 是最後一句:沒有下一句,用歌曲結束;若結束遠 → 也夾
eq(loopEndTime(100, null, 200, med), 106.4, '最後一句用 cap 夾住長尾');
eq(loopEndTime(100, null, 103, med), 103, '最後一句短尾用歌曲結束');
// 邊界:剛好等於 cap 不夾 (hardEnd > cap 才夾)
eq(loopEndTime(100, 106.4, 999, med), 106.4, 'cap 邊界不夾');
eq(loopEndTime(100, 104, 999, med, 0.5), 104.5, '正校正時用播放器時間判定終點');
eq(loopEndTime(100, 104, 999, med, -0.3), 103.7, '負校正時用播放器時間判定終點');
eq(loopEndTime(100, null, 103, med, 1), 103, '最後一句的實際歌曲時長不加校正');
eq(loopEndTime(100, 105, 103, med, 1), 103, '終點不超過實際歌曲時長');

console.log('\nall pass');
