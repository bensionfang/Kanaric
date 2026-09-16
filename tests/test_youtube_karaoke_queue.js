const assert = require('assert');
const fs = require('fs');
const { createYouTubeKaraokeQueue } = require('../web-app/public/js/youtube-karaoke-queue.js');
const {
    toYouTubeQueueItem,
    pickInitialYouTubeResult,
    createYouTubeCommand,
    applyYouTubeState,
    readYouTubeState,
    applyYouTubeKey,
    startYouTubeSong,
    handleYouTubeEnded,
    buildQueueView,
    createYouTubeLyricsMessage,
} = require('../web-app/public/js/youtube-karaoke.js');

const karaokeModeSource = fs.readFileSync(
    require.resolve('../web-app/public/js/karaoke-mode.js'), 'utf8',
);
assert.match(karaokeModeSource, /function pickResult\(item(?:, confirmed = false)?\)/,
    '點歌流程要提供給後續歌詞預查使用的 pickResult seam');

const item = (videoId) => ({ videoId, title: `Song ${videoId}`, channel: 'Channel', durationSec: 180, thumb: `https://img/${videoId}` });
const q = createYouTubeKaraokeQueue();

const a = q.add(item('dQw4w9WgXcQ'));
const b = q.add(item('kJQP7kiw5Fk'));
assert.match(a.queueId, /^q-\d+$/);
assert.notStrictEqual(a.queueId, b.queueId);
assert.deepStrictEqual(q.snapshot().items.map((x) => x.videoId), ['dQw4w9WgXcQ', 'kJQP7kiw5Fk']);
assert.strictEqual(q.snapshot().currentQueueId, a.queueId);

assert.strictEqual(q.start(a.queueId).queueId, a.queueId);
assert.strictEqual(q.advance(q.snapshot().revision).queueId, b.queueId);
const afterAdvance = q.snapshot();
assert.strictEqual(q.advance(afterAdvance.revision - 1), null);
assert.strictEqual(q.advance(afterAdvance.revision), null);

const c = q.add(item('9bZkp7q19f0'));
assert.deepStrictEqual(q.move(c.queueId, -1).items.map((x) => x.videoId), ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk']);
assert.deepStrictEqual(q.move(c.queueId, -99).items.map((x) => x.videoId), ['9bZkp7q19f0', 'dQw4w9WgXcQ', 'kJQP7kiw5Fk']);
assert.strictEqual(q.remove('q-999'), null);
assert.strictEqual(q.remove(b.queueId).videoId, 'kJQP7kiw5Fk');
assert.strictEqual(q.clear().items.length, 0);
assert.strictEqual(q.snapshot().currentQueueId, null);

console.log('test_youtube_karaoke_queue: OK');

// ===== YouTube state / command / UI pure contracts =====

const result = {
    videoId: 'M7lc1UVf-VE', title: 'Song <unsafe>', channel: 'Channel',
    durationSec: 210, thumb: 'https://img.example/thumb.jpg', ok: true,
};
const queueItem = toYouTubeQueueItem(result);
assert.deepStrictEqual(queueItem, result, '搜尋結果應保留 YouTube metadata 並成為 Queue item');
assert.strictEqual(pickInitialYouTubeResult([
    { ...result, videoId: 'dQw4w9WgXcQ', ok: false },
    result,
]).videoId, result.videoId, '第一筆 ok 才是預選');
assert.strictEqual(pickInitialYouTubeResult([{ ...result, ok: false }]), null,
    '全部不可靠時不得自動選歌');

assert.deepStrictEqual(createYouTubeCommand('seek', { positionMs: 1234 }, 7), {
    type: 'youtube_karaoke_command', commandId: 7, action: 'seek', positionMs: 1234,
});

assert.deepStrictEqual(createYouTubeLyricsMessage('dQw4w9WgXcQ', 0.3, [
    { time: 1.234, text: '<ruby>言<rt>こと</rt></ruby>', words: [[0, 0], [1, 500]], translation: 'omit', romaji: 'omit' },
]), {
    type: 'youtube_karaoke_lyrics',
    lyrics: {
        videoId: 'dQw4w9WgXcQ', offsetMs: 300,
        lines: [{ timeMs: 1234, text: '<ruby>言<rt>こと</rt></ruby>', words: [[0, 0], [1, 500]] }],
    },
});
assert.deepStrictEqual(createYouTubeLyricsMessage('dQw4w9WgXcQ', 0, []), {
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [] },
});
assert.strictEqual(createYouTubeLyricsMessage('invalid', 0, []), null);

const flatState = readYouTubeState({
    type: 'youtube_karaoke_state', videoId: queueItem.videoId, state: 'playing',
    positionMs: 1234, durationMs: 210000, keySemitones: 0,
});
assert.strictEqual(flatState.positionMs, 1234, 'flat server state must be accepted');
assert.strictEqual(readYouTubeState({ state: { videoId: queueItem.videoId, positionMs: 2345 } }).positionMs, 2345,
    'nested state must remain supported');

let songState = startYouTubeSong({ keySemitones: 2, state: 'playing' }, queueItem);
assert.strictEqual(songState.keySemitones, 0, '換歌時 Key 歸零');
assert.deepStrictEqual(applyYouTubeKey(songState, 1), { ...songState, keySemitones: 1 },
    '送出 Key 指令後 UI 狀態應立即反映新的半音');
songState = applyYouTubeState(songState, {
    revision: 1, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'playing', positionMs: 1000, durationMs: 210000, keySemitones: 2, error: null,
});
assert.strictEqual(applyYouTubeState(songState, {
    revision: 1, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'paused', positionMs: 1300, durationMs: 210000, keySemitones: 2, error: null,
}).positionMs, 1300, 'pause 不應自行累加本地位置');
assert.strictEqual(applyYouTubeState(songState, {
    revision: 1, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'buffering', positionMs: 1400, durationMs: 210000, keySemitones: 2, error: null,
}).positionMs, 1400, 'buffering 不應自行累加本地位置');
assert.strictEqual(applyYouTubeState(songState, {
    revision: 1, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'ad', positionMs: 1500, durationMs: 210000, keySemitones: 2, error: null,
}).positionMs, 1500, '廣告狀態只接受 extension clock');
assert.strictEqual(applyYouTubeState(songState, {
    revision: 1, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'playing', positionMs: 9000, durationMs: 210000, keySemitones: 2, error: null,
}).positionMs, 9000, 'seek 必須硬對齊 extension positionMs');

const stateQueue = createYouTubeKaraokeQueue();
const secondItem = toYouTubeQueueItem({ ...result, videoId: 'kJQP7kiw5Fk', title: 'Second', ok: true });
stateQueue.add(queueItem);
stateQueue.add(secondItem);
let ended = handleYouTubeEnded(stateQueue, songState, {
    revision: 2, videoId: queueItem.videoId, title: queueItem.title, channel: queueItem.channel,
    state: 'ended', positionMs: 210000, durationMs: 210000, keySemitones: 2, error: null,
});
assert.strictEqual(ended.item.videoId, secondItem.videoId, 'ended 應前進下一首');
assert.strictEqual(ended.state.keySemitones, 0, 'Queue 換歌的 state Key 歸零');
assert.strictEqual(handleYouTubeEnded(stateQueue, ended.state, {
    revision: 2, videoId: queueItem.videoId, state: 'ended', positionMs: 210000,
}).item, null, '同一 ended revision 不得重複前進');

const lastQueue = createYouTubeKaraokeQueue();
lastQueue.add(queueItem);
const last = handleYouTubeEnded(lastQueue, songState, {
    revision: 3, videoId: queueItem.videoId, state: 'ended', positionMs: 210000,
});
assert.strictEqual(last.item, null);
assert.strictEqual(last.state.state, 'idle', '最後一首 ended 回 idle');

const view = buildQueueView(stateQueue.snapshot());
assert.strictEqual(view.current.videoId, secondItem.videoId, 'UI view 找得到現在唱');
assert.deepStrictEqual(view.upcoming.map((x) => x.videoId), [], 'UI view 分開待播');

// Picker 是 Queue 的唯一 DOM 宿主；控台不可複製一套搜尋欄或佇列。
const karaokeViewSource = fs.readFileSync(require.resolve('../web-app/views/karaoke.ejs'), 'utf8');
assert.strictEqual((karaokeViewSource.match(/id="karaoke-song-picker"/g) || []).length, 1,
    'Queue 與點歌頁只能共用一個 picker');
for (const id of ['youtube-karaoke-query', 'youtube-karaoke-results', 'youtube-karaoke-current', 'youtube-karaoke-queue']) {
    assert.strictEqual((karaokeViewSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1,
        `${id} 不得在控台複製`);
}
