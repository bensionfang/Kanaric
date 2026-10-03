const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const fn = source.match(/function advancePlaybackClock\(dt\) \{[\s\S]*?\n\}/)?.[0];
const pollFn = source.match(/async function pollSystemMedia\(force = false\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fn, '找不到主介面的播放時鐘');
assert.ok(pollFn, '找不到媒體狀態保底查詢');

const state = vm.createContext({});
vm.runInContext(`let currentInterpolatedPosition = 10;
let clockCorrection = -0.3;
let isCurrentlyPlaying = true;
${fn}
function snapshot() { return [currentInterpolatedPosition, clockCorrection]; }
function pause() { isCurrentlyPlaying = false; }
function resume() { isCurrentlyPlaying = true; }
`, state);

let previous = 10;
for (let i = 0; i < 120; i++) {
    vm.runInContext('advancePlaybackClock(1 / 60)', state);
    const [position] = vm.runInContext('snapshot()', state);
    assert.ok(position >= previous, '小幅落後的回報不能讓逐字填色倒退');
    previous = position;
}
const [position, correction] = vm.runInContext('snapshot()', state);
assert.ok(Math.abs(position - 11.7) < 1e-9, '落後的 300ms 應在播放中漸進修正');
assert.ok(Math.abs(correction) < 1e-9, '修正量應消耗完');
vm.runInContext('pause(); advancePlaybackClock(1)', state);
assert.equal(vm.runInContext('snapshot()', state)[0], position, '暫停不推進');
vm.runInContext('resume(); advancePlaybackClock(15)', state);
assert.equal(vm.runInContext('snapshot()', state)[0], position, '視窗在背景停住後，不得一次內插整段時間');

const polls = [];
const pollState = vm.createContext({
    window: { __mediaSocketAlive: true },
    fetch: async () => {
        polls.push('fetch');
        return { ok: true, json: async () => ({ position: 42 }) };
    },
    applyMediaState: (data, force) => polls.push([data.position, force])
});
vm.runInContext(pollFn, pollState);
(async () => {
    await vm.runInContext('pollSystemMedia()', pollState);
    assert.deepEqual(polls, [], 'WebSocket 活著時仍應跳過平常輪詢');
    await vm.runInContext('pollSystemMedia(true)', pollState);
    assert.deepEqual(polls, ['fetch', [42, true]], '視窗還原時即使 WebSocket 活著也要強制查最新位置');
    console.log('playback clock passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
