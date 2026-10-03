const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'web-app', 'public', 'js', 'app.js'), 'utf8');
const names = ['setSyncPanel', 'isActiveLineVisible', 'updateSyncPanel', 'resumeSync'];
const functions = names.map(name => {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' exists');
    const end = source.indexOf(String.fromCharCode(10) + '}', start);
    return source.slice(start, end + 2);
}).join('\n');

const panel = { style: {} };
const first = { offsetTop: 40, offsetHeight: 50 };
const pane = {
    scrollTop: 600, clientHeight: 400,
    scrollTo({ top }) { this.scrollTop = top; }
};
const elements = {
    'sync-resume-panel': panel,
    'lyrics-scroll': pane,
    'lyric-line-0': first
};
const state = {
    document: { getElementById: id => elements[id] || null },
    performance: { now: () => 1000 },
    parsedLyrics: [{ time: 15, text: 'first line' }],
    isUnsyncedLyrics: false,
    activeLyricIndex: -1,
    scrollLocked: false,
    autoCenter: false,
    programmaticScrollUntil: 0,
    centerActiveLine() { throw new Error('intro should return to top'); }
};
vm.createContext(state);
vm.runInContext(functions, state);

vm.runInContext('updateSyncPanel()', state);
assert.equal(panel.style.display, 'flex', 'intro: first line is offscreen, show resume');
vm.runInContext('resumeSync()', state);
assert.equal(pane.scrollTop, 0, 'intro: resume returns to top');
assert.equal(panel.style.display, 'none', 'intro: resume hides button');
assert.equal(state.autoCenter, true, 'intro: resume restores centering');

pane.scrollTop = 0;
vm.runInContext('updateSyncPanel()', state);
assert.equal(panel.style.display, 'none', 'intro: first line visible, no resume');

state.parsedLyrics = [];
pane.scrollTop = 600;
vm.runInContext('updateSyncPanel()', state);
assert.equal(panel.style.display, 'none', 'no lyrics: no resume');

state.parsedLyrics = [{ time: -1, text: 'plain lyrics' }];
state.isUnsyncedLyrics = true;
vm.runInContext('updateSyncPanel()', state);
assert.equal(panel.style.display, 'none', 'unsynced lyrics: no intro resume');

console.log('intro resume: all tests passed');
