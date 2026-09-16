const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const {
  getYouTubeOverlayMarkup,
  getYouTubeLyricsHint,
  shouldRefreshYouTubeChromeMutations,
  startYouTubeContentRuntime,
} = require('../src/youtube-content.js');

function createYouTubeRuntimeFixture({ videoId = 'dQw4w9WgXcQ', fullscreenButton = null } = {}) {
  const previous = {
    chrome: global.chrome,
    document: global.document,
    location: global.location,
    MutationObserver: global.MutationObserver,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  let handler;
  let observerCallback;
  let observerDisconnected = false;
  let currentVideoId = videoId;
  let nativeFullscreenButton = fullscreenButton;
  const nodes = [];
  const events = new Map();
  const intervals = [];
  const sent = [];
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  const player = {
    children: [],
    appendChild(node) {
      if (!this.children.includes(node)) this.children.push(node);
      node.parentNode = this;
      return node;
    },
    querySelector(selector) {
      return selector === '.ytp-fullscreen-button' ? nativeFullscreenButton : null;
    },
  };
  const makeNode = () => {
    const node = {
      id: '',
      dataset: {},
      hidden: false,
      parentNode: null,
      style: { cssText: '' },
      children: [],
      setAttribute() {},
      appendChild(child) {
        if (!this.children.includes(child)) this.children.push(child);
        child.parentNode = this;
        return child;
      },
      remove() {
        if (this.parentNode?.children) {
          this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        }
        this.parentNode = null;
      },
      contains(target) { return target === this || this.children.includes(target); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren() { this.children = []; },
      classList: { add() {}, remove() {}, toggle() {} },
    };
    nodes.push(node);
    return node;
  };
  const setUrl = (nextVideoId) => {
    currentVideoId = nextVideoId;
    global.location.href = `https://www.youtube.com/watch?v=${nextVideoId}`;
  };
  global.location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  global.document = {
    title: 'Song - YouTube',
    body: { innerText: '' },
    fullscreenElement: null,
    querySelector(selector) {
      if (selector === '.html5-video-player') return player;
      if (selector === 'video.html5-main-video' || selector === 'video') return video;
      return null;
    },
    createElement() { return makeNode(); },
    addEventListener(type, listener) { events.set(type, listener); },
    removeEventListener(type, listener) {
      if (events.get(type) === listener) events.delete(type);
    },
  };
  global.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  global.chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener(listener) { handler = listener; },
        removeListener() {},
      },
    },
  };
  global.setInterval = (callback) => {
    intervals.push(callback);
    return intervals.length;
  };
  global.clearInterval = () => {};
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  return {
    runtime,
    player,
    video,
    nodes,
    sent,
    get handler() { return handler; },
    get observerDisconnected() { return observerDisconnected; },
    setFullscreenButton(button) { nativeFullscreenButton = button; },
    setUrl,
    report() { intervals.forEach((callback) => callback()); },
    mutate(records = [{ target: player, addedNodes: [nativeFullscreenButton], removedNodes: [] }]) {
      observerCallback?.(records);
    },
    dispatch(type) { events.get(type)?.(); },
    cue() { return nodes.find((node) => node.id === 'kanaric-youtube-fullscreen-hint'); },
    cleanup() {
      runtime.stop();
      Object.assign(global, previous);
    },
  };
}

test('App-owned lyric failures show a nonblocking player hint only', () => {
  const hint = '找不到歌詞／查詢失敗，從 Kanaric 把手查看備選';
  assert.equal(getYouTubeLyricsHint('no_lyrics'), hint);
  assert.equal(getYouTubeLyricsHint('error'), hint);
  assert.equal(getYouTubeLyricsHint('loaded'), '');
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /kanaric-youtube-lyrics-hint/);
  assert.match(source, /pointer-events: none/);
  assert.match(source, /if \(!active\)/);
  assert.match(source, /lyricStatus = 'searching'/);
  assert.match(source, /hint\?\.remove\?\.\(\)/);
  assert.match(source, /projected\.state\.state === 'ended'/);
});

test('overlay observer ignores mutations caused by its own nodes', () => {
  const overlay = { contains: (node) => node?.owner === 'overlay' };
  const overlayStyle = { owner: 'style' };
  const player = { owner: 'player' };
  assert.equal(shouldRefreshYouTubeChromeMutations([
    { target: overlay, addedNodes: [{ owner: 'overlay' }], removedNodes: [] },
    { target: player, addedNodes: [overlay, overlayStyle], removedNodes: [] },
  ], overlay, overlayStyle), false);
  assert.equal(shouldRefreshYouTubeChromeMutations([
    { target: player, addedNodes: [{ owner: 'youtube' }], removedNodes: [] },
  ], overlay, overlayStyle), true);
});

test('active YouTube keeps the lyric overlay but retires visible controls', () => {
  const markup = getYouTubeOverlayMarkup();
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(markup, /data-slot="slot-top"/);
  assert.match(markup, /data-slot="slot-bottom"/);
  assert.doesNotMatch(source, /className = 'kanaric-controls'/);
  assert.doesNotMatch(source, /kanaric-panel/);
  assert.doesNotMatch(source, /\.ytp-right-controls/);
});

test('YouTube activation observes and mounts only the lyric overlay', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /const observeYouTubeChrome = \(\) =>/);
  assert.match(source, /ensureOverlay\(\)/);
  assert.doesNotMatch(source, /ensureControls/);
});

test('the App owns microphone permission and recording controls', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.doesNotMatch(source, /data-kanaric-action="pitch_toggle"/);
  assert.doesNotMatch(source, /data-kanaric-action="pitch_retry"/);
  assert.doesNotMatch(source, /data-kanaric-action="recording_save"/);
  assert.doesNotMatch(source, /navigator\.mediaDevices\.getUserMedia/);
});

test('ruby annotations remain visible in the YouTube lyric overlay', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /#kanaric-youtube-lyrics ruby \{ display: ruby; ruby-position: over;/);
  assert.match(source, /#kanaric-youtube-lyrics rt \{ display: ruby-text; visibility: visible !important;/);
});

test('the lyric overlay remains a two-line, non-interactive surface', () => {
  const markup = getYouTubeOverlayMarkup();
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(markup, /class="kline slot-top"/);
  assert.match(markup, /class="kline slot-bottom"/);
  assert.match(source, /pointer-events: none/);
});

test('legacy Key state helper remains available without a visible YouTube control', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /function applyYouTubeControlAction/);
  assert.doesNotMatch(source, /data-kanaric-action="key_/);
  assert.doesNotMatch(source, /data-kanaric-action="offset_/);
});

test('one lyric overlay is reused when YouTube rebuilds its chrome', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /let overlay = null;/);
  assert.match(source, /if \(!overlay\)/);
  assert.match(source, /if \(overlay\.parentNode !== player\) player\.appendChild\(overlay\)/);
  assert.doesNotMatch(source, /controlRoot/);
});

test('YouTube has no secondary control panel or Escape handler', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.doesNotMatch(source, /setControlsOpen/);
  assert.doesNotMatch(source, /event\.key === 'Escape'/);
});

test('App-owned loaded video shows a passive native fullscreen cue only when ready', () => {
  const clicks = [];
  const fixture = createYouTubeRuntimeFixture({
    fullscreenButton: null,
  });
  try {
    assert.equal(fixture.cue(), undefined, 'ordinary YouTube starts without a cue');
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 4, positionMs: 0 });
    assert.equal(fixture.cue(), undefined, 'player without its native button is not ready');

    fixture.setFullscreenButton({ click() { clicks.push('clicked'); } });
    fixture.mutate();
    const cue = fixture.cue();
    assert.ok(cue, 'ready App-owned video gets a cue');
    assert.equal(cue.textContent, '請點擊 YouTube 原生全螢幕按鈕');
    assert.deepEqual(clicks, [], 'the native button remains user-operated');
  } finally {
    fixture.cleanup();
  }
});

test('fullscreen cue follows owner, track, connection, and native fullscreen lifecycle without auto-entry', () => {
  const fixture = createYouTubeRuntimeFixture({
    fullscreenButton: { click() { throw new Error('native button must not be clicked'); } },
  });
  try {
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 7, positionMs: 0 });
    assert.ok(fixture.cue());

    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 6, positionMs: 0 });
    assert.equal(fixture.cue().parentNode, null, 'a stale revision cannot restore the cue');
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 7, positionMs: 0 });
    assert.ok(fixture.cue());

    global.document.fullscreenElement = fixture.player;
    fixture.dispatch('fullscreenchange');
    assert.equal(fixture.cue().parentNode, null, 'native fullscreen entry clears the cue');

    global.document.fullscreenElement = null;
    fixture.dispatch('fullscreenchange');
    assert.ok(fixture.cue(), 'manual Esc may restore only the passive cue');

    fixture.handler({ type: 'youtube_karaoke_connection', state: 'disconnected', error: 'closed' });
    assert.equal(fixture.cue().parentNode, null, 'disconnect clears the cue');
    fixture.mutate();
    assert.equal(fixture.cue().parentNode, null, 'disconnect does not re-show the cue');

    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    assert.ok(fixture.cue(), 'reconnect can restore the passive cue for the same owner');

    fixture.setUrl('kJQP7kiw5Fk');
    fixture.report();
    assert.equal(fixture.cue().parentNode, null, 'track change clears the old cue');
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 7, positionMs: 0 });
    assert.equal(fixture.cue().parentNode, null, 'stale load identity cannot restore the cue');

    fixture.handler({ type: 'youtube_karaoke_activation', active: false, source: 'app' });
    assert.equal(fixture.cue().parentNode, null, 'owner loss clears the cue');
  } finally {
    fixture.cleanup();
  }
});

test('fullscreen fallback has no automatic or browser-window fullscreen path', () => {
  const contentSource = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  const workerSource = fs.readFileSync(require.resolve('../src/service-worker.js'), 'utf8');
  assert.doesNotMatch(contentSource, /\brequestFullscreen\b/);
  assert.doesNotMatch(contentSource, /KeyboardEvent|key\s*===\s*['"]f['"]/i);
  assert.doesNotMatch(workerSource, /chrome\.windows\.update[\s\S]*fullscreen/i);
});
