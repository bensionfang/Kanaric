// lrclib 時長守門的自檢。server.js 不能單獨 require (會綁 port 起 server),所以鏡射純判斷式,
// 公式必須與 server.js lrclib 區塊的 durOff 逐字一致:!!(ourDur && theirDur && abs(diff) > 3)。
// 動一邊改兩邊。

// theirDur = lrclib 回傳的時長(秒), ourDur = 播放中時長(秒, 瀏覽器來源為 null)
function durOff(theirDur, ourDur) {
    return !!(ourDur && theirDur && Math.abs(theirDur - ourDur) > 3);
}

function ok(cond, msg) {
    if (!cond) { console.error('FAIL ' + msg); process.exit(1); }
    console.log('ok   ' + msg);
}

// 時長吻合(±3 秒內)→ 收
ok(durOff(200, 200) === false, '完全吻合不擋');
ok(durOff(203, 200) === false, '差 3 秒邊界不擋');
ok(durOff(200, 197) === false, '差 3 秒(反向)不擋');
// 撞名:時長差很多 → 擋
ok(durOff(147, 200) === true, '差 53 秒(QQ preview 式撞名)擋掉');
ok(durOff(230, 239) === true, '差 9 秒(同名別曲)擋掉');
// 沒有我方時長(瀏覽器來源)→ 放行,不擋
ok(durOff(200, null) === false, '瀏覽器來源無時長照舊放行');
ok(durOff(200, 0) === false, '我方時長 0/未知照舊放行');
// lrclib 沒給時長 → 沒得比,放行
ok(durOff(null, 200) === false, 'lrclib 無時長放行');
ok(durOff(undefined, 200) === false, 'lrclib 時長 undefined 放行');

console.log('\nall pass');
