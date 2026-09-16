// 歌詞 offset 的跨頁共用行為：快速切歌不能互相取消或存錯歌曲。
const assert = require('assert');

let api = {};
try { api = require('../web-app/public/js/offset-sync.js'); } catch (e) {}

assert.strictEqual(typeof api.offsetSongKey, 'function', '缺少歌曲身分函式');
assert.strictEqual(typeof api.createOffsetSaver, 'function', '缺少逐歌延遲儲存器');
assert.strictEqual(typeof api.offsetFromMessage, 'function', '缺少即時校正訊息守門');

const { offsetSongKey, createOffsetSaver, offsetFromMessage } = api;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    assert.strictEqual(offsetSongKey('Song', 'Artist'), 'Artist|||Song');
    assert.strictEqual(offsetFromMessage('Artist|||Song', {
        type: 'sync_offset_updated', title: 'Song', artist: 'Artist', offset: 0.3,
    }), 0.3, '目前歌曲要接收即時校正');
    assert.strictEqual(offsetFromMessage('Artist|||Song', {
        type: 'sync_offset_updated', title: 'Other', artist: 'Artist', offset: 0.8,
    }), null, '其他歌曲的校正不能串進來');
    assert.strictEqual(offsetFromMessage('Artist|||Song', {
        type: 'sync_offset_updated', title: 'Song', artist: 'Artist', offset: 0,
    }), 0, '歸零不能被當成沒有更新');

    const sent = [];
    const save = createOffsetSaver(payload => sent.push(payload), 5);
    save('A', 'Singer', 0.1);
    save('A', 'Singer', 0.2);       // 同一首只留最後一次
    save('B', 'Singer', -0.1);      // 不同首不能取消 A
    save('A', 'Other', 0.3);        // 同歌名、不同歌手也是另一首
    save('', 'Singer', 9);          // 沒歌名不送

    await wait(30);
    sent.sort((a, b) => `${a.artist}|${a.title}`.localeCompare(`${b.artist}|${b.title}`));
    assert.deepStrictEqual(sent, [
        { title: 'A', artist: 'Other', offset: 0.3 },
        { title: 'A', artist: 'Singer', offset: 0.2 },
        { title: 'B', artist: 'Singer', offset: -0.1 },
    ]);

    const flushed = [];
    const flushSave = createOffsetSaver(payload => flushed.push(payload), 50);
    assert.strictEqual(typeof flushSave.flush, 'function', '頁面離開前要能立即送出待存校正');
    flushSave('A', 'Singer', 0.1);
    flushSave('A', 'Singer', 0.2);
    flushSave('B', 'Singer', -0.1);
    flushSave.flush();
    assert.deepStrictEqual(flushed, [
        { title: 'A', artist: 'Singer', offset: 0.2 },
        { title: 'B', artist: 'Singer', offset: -0.1 },
    ], 'flush 要立即送出各歌曲最後一次校正');
    await wait(70);
    assert.strictEqual(flushed.length, 2, 'flush 後原本的 timer 不可重複送出');

    console.log('test_offset_sync: OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
