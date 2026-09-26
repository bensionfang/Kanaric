const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app/public/js/app.js'), 'utf8');
const fn = source.match(/function advancePlaybackClock\(dt\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fn, '找不到主介面的播放時鐘');

const state = vm.createContext({});
vm.runInContext(`let currentInterpolatedPosition = 10;
let clockCorrection = -0.3;
let isCurrentlyPlaying = true;
${fn}
function snapshot() { return [currentInterpolatedPosition, clockCorrection]; }
function pause() { isCurrentlyPlaying = false; }
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
console.log('playback clock passed');
