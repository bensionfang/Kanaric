// 備選歌詞套用流程回歸測試：node tests/test_lyrics_options_ui.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const elements = new Map();
function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {
        id,
        value: '',
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
        },
        dataset: {},
        style: { setProperty() {} },
        ownerDocument: { defaultView: { innerWidth: 800 } },
        getBoundingClientRect: () => ({ left: 0, right: 300 }),
        contains: () => true,
        querySelectorAll: () => [],
    };
    elements.set(id, el);
    return el;
}

const document = {
    getElementById: element,
    addEventListener() {},
};
const window = {
    currentSongInfo: { title: 'Song', artist: 'Artist' },
    _lyricsOptions: [{ title: 'Candidate', artist: 'Provider', lyrics: '[00:00.00]Hello' }],
};
const modal = element('lyrics-options-modal');
const list = element('lyrics-options-list');
const button = element('lyrics-opt-btn');
const bubble = element('lyrics-opt-bubble');
let finishRequest;
const requests = [];
const intervals = new Map();
let nextInterval = 0;
let stallState = false;
const abortSignals = [];
const states = [
    { status: 'searching', options: [{ title: 'Partial Candidate', artist: 'Provider', lyrics: '[00:00.00]Hello' }] },
    { status: 'done', error: '搜尋逾時', options: [{ title: 'Partial Candidate', artist: 'Provider', lyrics: '[00:00.00]Hello' }] },
];
const context = {
    window,
    document,
    fetch: (url, options) => {
        const args = [url, options];
        requests.push(args);
        if (String(url).includes('/api/lyrics/options/state?')) {
            if (stallState) {
                return new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
                });
            }
            return Promise.resolve({ ok: true, json: async () => states.shift() });
        }
        if (String(url).includes('/api/lyrics/custom')) {
            return new Promise((resolve) => { finishRequest = resolve; });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: (callback) => {
        const id = ++nextInterval;
        intervals.set(id, callback);
        return id;
    },
    clearInterval: (id) => intervals.delete(id),
    AbortSignal: {
        timeout: (timeoutMs) => {
            const listeners = [];
            const signal = {
                timeoutMs,
                addEventListener: (event, listener) => { if (event === 'abort') listeners.push(listener); },
                abort: () => listeners.forEach((listener) => listener()),
            };
            abortSignals.push(signal);
            return signal;
        },
    },
    URLSearchParams,
    console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web-app/public/js/lyrics-tools.js'), 'utf8'), context);

async function run() {
    const searching = context.searchLyricsOptions();
    assert.strictEqual(modal.classList.contains('show'), true, 'search opens the modal immediately');

    let poll = [...intervals.values()].at(-1);
    await poll();
    assert.match(list.innerHTML, /Partial Candidate/, 'partial candidates appear while other sources are searching');
    assert.match(list.innerHTML, /還在找更多來源/, 'partial candidates show that search is still running');

    context.closeLyricsModal();
    const searchesBeforeSpinnerClick = requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).length;
    await context.searchLyricsOptions();
    assert.strictEqual(modal.classList.contains('show'), true, 'clicking the searching button opens the modal');
    assert.match(list.innerHTML, /Partial Candidate/, 'the modal shows results from the active search');
    assert.strictEqual(requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).length,
        searchesBeforeSpinnerClick, 'opening the active search does not start a duplicate search');

    poll = [...intervals.values()].at(-1);
    await poll();
    await searching;
    assert.match(list.innerHTML, /重試/, 'a timed out search leaves a retry action');
    assert.match(list.innerHTML, /Partial Candidate/, 'partial candidates remain after a search error');
    assert.doesNotMatch(list.innerHTML, /fa-spinner/, 'failed search does not keep spinning');

    context.closeLyricsModal();
    context.resetLyricsOptBtn();
    states.push({ status: 'done', options: [{ title: 'Auto Candidate', artist: 'Provider', lyrics: '[00:00.00]Auto' }] });
    const autoSearch = context.searchLyricsOptions(false, false, true, true);
    assert.strictEqual(modal.classList.contains('show'), false, 'automatic searches stay in the background');
    assert.strictEqual(button.dataset.loading, '1', 'automatic searches keep the toolbar spinner');
    poll = [...intervals.values()].at(-1);
    await poll();
    await autoSearch;
    assert.strictEqual(modal.classList.contains('show'), false, 'background completion does not open the modal');
    assert.strictEqual(button.dataset.ready, '1', 'background completion marks options as ready');
    assert.strictEqual(bubble.classList.contains('show'), true, 'background completion displays the result bubble');

    const applyRequestsBeforeSongChange = requests.filter(([url]) => String(url).includes('/api/lyrics/custom')).length;
    window.currentSongInfo = { title: 'Song', artist: 'Different Artist' };
    const staleApply = context.applyLyricsOption(0);
    assert.strictEqual(requests.filter(([url]) => String(url).includes('/api/lyrics/custom')).length,
        applyRequestsBeforeSongChange, 'a stale option cannot be applied to the same title by a different artist');
    await staleApply;
    window.currentSongInfo = { title: 'Song', artist: 'Artist' };

    modal.classList.add('show');
    const listBeforeApply = list.innerHTML;
    const first = context.applyLyricsOption(0);
    const duplicate = context.applyLyricsOption(0);
    assert.strictEqual(requests.filter(([url]) => String(url).includes('/api/lyrics/custom')).length, 1,
        'only one apply request may run at a time');
    assert.strictEqual(modal.classList.contains('show'), true, 'modal stays open until the server confirms the apply');

    finishRequest({ ok: false, status: 500, json: async () => ({ error: 'write failed' }) });
    await Promise.all([first, duplicate]);
    assert.strictEqual(modal.classList.contains('show'), true, 'failed apply keeps the candidate list open');
    assert.strictEqual(window._lyricsOptions.length, 1, 'failed apply keeps candidates available');
    assert.strictEqual(list.innerHTML, listBeforeApply, 'failed apply leaves the visible candidate list intact');
    assert.match(element('toast-message').textContent, /套用失敗/, 'failure is shown to the user');

    modal.classList.add('show');
    const success = context.applyLyricsOption(0);
    assert.strictEqual(modal.classList.contains('show'), true, 'successful apply also waits for the response');
    finishRequest({ ok: true, json: async () => ({ success: true, lyrics: '[00:00.00]Hello' }) });
    await success;
    assert.strictEqual(modal.classList.contains('show'), false, 'successful apply closes the modal');
    assert.match(element('toast-message').textContent, /已套用/, 'success appears only after the server confirms it');

    const titleInput = element('manual-title');
    const artistInput = element('manual-artist');
    titleInput.value = 'Song';
    artistInput.value = 'Artist';
    window._lyricsOptionsSearch = null;
    states.push({ status: 'done', options: [{ title: 'Retry Candidate', artist: 'Provider', lyrics: '[00:00.00]Retry' }] });
    const fallbackRetry = context.retryLyricsOptions();
    const retryUrl = String(requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).at(-1)[0]);
    assert.match(retryUrl, /force=1/, 'retry after a restored error forces a fresh search');
    assert.doesNotMatch(retryUrl, /searchTitle|searchArtist/, 'fallback retry leaves the remembered server override in control');
    poll = [...intervals.values()].at(-1);
    await poll();
    await fallbackRetry;

    states.push({ status: 'done', options: [{ title: 'Refresh Candidate', artist: 'Provider', lyrics: '[00:00.00]Refresh' }] });
    const forceRefresh = context.searchLyricsOptions(true);
    const refreshUrl = String(requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).at(-1)[0]);
    assert.match(refreshUrl, /force=1/, 'force refresh bypasses completed server state');
    assert.doesNotMatch(refreshUrl, /searchTitle|searchArtist/, 'force refresh preserves remembered overrides when inputs are unchanged');
    poll = [...intervals.values()].at(-1);
    await poll();
    await forceRefresh;

    titleInput.value = 'Edited title';
    artistInput.value = 'Edited artist';
    states.push({ status: 'done', options: [{ title: 'Edited Candidate', artist: 'Provider', lyrics: '[00:00.00]Edited' }] });
    const editedRefresh = context.searchLyricsOptions(true);
    const editedUrl = String(requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).at(-1)[0]);
    assert.match(editedUrl, /searchTitle=Edited\+title/, 'an edited title is used by an explicit force refresh');
    assert.match(editedUrl, /searchArtist=Edited\+artist/, 'an edited artist is used by an explicit force refresh');
    poll = [...intervals.values()].at(-1);
    await poll();
    await editedRefresh;

    titleInput.value = 'Song';
    artistInput.value = 'Artist';
    window._lyricsOptions = [];
    states.push({ status: 'done', options: [{ title: 'Empty Modal Candidate', artist: 'Provider', lyrics: '[00:00.00]Empty' }] });
    context.openLyricsModal();
    const emptyModalUrl = String(requests.filter(([url]) => String(url).includes('/api/lyrics/options?')).at(-1)[0]);
    assert.doesNotMatch(emptyModalUrl, /searchTitle|searchArtist/, 'opening an empty list preserves the remembered server override');
    poll = [...intervals.values()].at(-1);
    await poll();

    window.currentSongInfo = { title: 'Restored Song', artist: 'Restored Artist' };
    window._lyricsOptions = [];
    list.innerHTML = '';
    modal.classList.add('show');
    states.push({ status: 'done', options: [{ title: 'Restored Candidate', artist: 'Provider', lyrics: '[00:00.00]Restored' }] });
    await context.restoreOptionsState();
    assert.match(list.innerHTML, /Restored Candidate/, 'restoring completed options redraws an already open modal');

    stallState = true;
    const timedRetry = context.retryLyricsOptions();
    for (let attempt = 0; attempt < 3; attempt++) {
        poll = [...intervals.values()].at(-1);
        const pendingPoll = poll();
        const signal = abortSignals.at(-1);
        assert.strictEqual(signal.timeoutMs, 8000, 'state polling has a bounded request timeout');
        signal.abort();
        await pendingPoll;
    }
    await timedRetry;
    assert.match(list.innerHTML, /重試/, 'a stalled state request eventually presents a retry action');
    assert.doesNotMatch(list.innerHTML, /fa-spinner/, 'a stalled state request cannot spin forever');
    console.log('lyrics-options-ui: search and apply flows passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
