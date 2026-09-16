const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { karaokeSlots } = require('../../web-app/public/js/karaoke-slots.js');
const { karaokePaint } = require('../../web-app/public/js/karaoke.js');

const {
  projectYouTubeState,
  createStateReporter,
  classifyYouTubeBlock,
  isYouTubeContentCommand,
  selectYouTubeLyricPair,
  lyricElementPolicy,
  setSafeLyricHtml,
  readYouTubeVideo,
  startYouTubeContentRuntime,
} = require('../src/youtube-content.js');
const { normalizeYouTubeActivationMessage } = require('../src/service-worker.js');

test('projectYouTubeState marks ads and emits the canonical state shape', () => {
  assert.deepEqual(projectYouTubeState({
    revision: 2,
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    channelTitle: 'RickAstleyVEVO',
    currentTime: 12.345,
    duration: 213.4,
    playerState: 1,
    isAd: true,
  }), {
    type: 'youtube_karaoke_state',
    state: {
      revision: 2,
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'RickAstleyVEVO',
      state: 'ad',
      positionMs: 12345,
      durationMs: 213400,
      keySemitones: 0,
      error: null,
    },
  });
});

test('projectYouTubeState maps player states and typed errors', () => {
  assert.equal(projectYouTubeState({
    revision: 1,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 1,
    duration: 2,
    playerState: 1,
  }).state.state, 'playing');
  assert.equal(projectYouTubeState({
    revision: 1,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 1,
    duration: 2,
    playerState: 2,
  }).state.state, 'paused');
  assert.deepEqual(projectYouTubeState({
    revision: 4,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 0,
    duration: 0,
    blockedCode: 'youtube-video-unavailable',
  }).state.error, {
    code: 'youtube-video-unavailable',
    message: 'youtube-video-unavailable',
  });
  assert.equal(projectYouTubeState({
    revision: 5,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 1,
    duration: 2,
    playerState: 3,
  }).state.state, 'buffering');
  assert.equal(projectYouTubeState({
    revision: 6,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 0,
    duration: 2,
    isLoading: true,
  }).state.state, 'loading');
  assert.deepEqual(projectYouTubeState({
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 0,
    duration: 0,
    blockedCode: 'youtube-age-restricted',
    blockedMessage: 'Sign in to confirm your age',
  }).state.error, {
    code: 'youtube-age-restricted',
    message: 'Sign in to confirm your age',
  });
});

test('createStateReporter emits ended once per revision and suppresses tiny drift spam', () => {
  const sent = [];
  const reporter = createStateReporter((msg) => sent.push(msg));

  reporter.report(projectYouTubeState({
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 10,
    duration: 120,
    playerState: 1,
  }));
  reporter.report(projectYouTubeState({
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 10.05,
    duration: 120,
    playerState: 1,
  }));
  reporter.report(projectYouTubeState({
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 120,
    duration: 120,
    playerState: 0,
  }));
  reporter.report(projectYouTubeState({
    revision: 7,
    videoId: 'dQw4w9WgXcQ',
    currentTime: 120,
    duration: 120,
    playerState: 0,
  }));
  reporter.report(projectYouTubeState({
    revision: 8,
    videoId: 'kJQP7kiw5Fk',
    currentTime: 1,
    duration: 200,
    playerState: 0,
  }));

  assert.equal(sent.length, 3);
  assert.equal(sent[0].state.state, 'playing');
  assert.equal(sent[1].state.state, 'ended');
  assert.equal(sent[2].state.revision, 8);
});

test('createStateReporter emits corrected metadata for the same video', () => {
  const sent = [];
  const reporter = createStateReporter((msg) => sent.push(msg));

  reporter.report(projectYouTubeState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 - 春雷 Kenshi Yonezu - Shunrai',
    currentTime: 2,
    duration: 297,
    playerState: 1,
  }));
  reporter.report(projectYouTubeState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 - 春雷',
    channelTitle: 'Kenshi Yonezu 米津玄師',
    currentTime: 2.05,
    duration: 297,
    playerState: 1,
  }));

  assert.equal(sent.length, 2);
  assert.equal(sent[1].state.title, '米津玄師 - 春雷');
  assert.equal(sent[1].state.channel, 'Kenshi Yonezu 米津玄師');
});

test('createStateReporter replays the latest state after socket recovery', () => {
  const sent = [];
  const reporter = createStateReporter((msg) => sent.push(msg));
  const message = projectYouTubeState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 - 春雷',
    channelTitle: 'Kenshi Yonezu 米津玄師',
    currentTime: 2,
    duration: 297,
    playerState: 2,
  });

  assert.equal(reporter.report(message), true);
  sent.length = 0;
  assert.equal(reporter.replay(), true);
  assert.deepEqual(sent, [message]);
});

test('classifyYouTubeBlock keeps sign-in and age errors distinct', () => {
  assert.deepEqual(classifyYouTubeBlock('Sign in to confirm your age', false), {
    code: 'youtube-sign-in-required',
    message: 'Sign in to confirm your age',
  });
  assert.deepEqual(classifyYouTubeBlock('This video is age-restricted', false), {
    code: 'youtube-age-restricted',
    message: 'YouTube age restriction',
  });
});

test('content runtime accepts an explicit report command after reconnect', () => {
  assert.equal(typeof isYouTubeContentCommand, 'function');
  assert.equal(isYouTubeContentCommand({ action: 'report' }), true);
  assert.equal(isYouTubeContentCommand({ action: 'play' }), true);
  assert.equal(isYouTubeContentCommand({ action: 'set_key' }), false);
});

test('clicking the current Key value sends set_key:0 without seeking', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  const keyHandler = source.slice(
    source.indexOf("if (action === 'key_down' || action === 'key_up' || action === 'key_zero')"),
    source.indexOf("if (action === 'pitch_toggle' || action === 'pitch_retry')"),
  );
  assert.match(keyHandler, /action !== 'key_zero'/);
  assert.match(keyHandler, /type: 'youtube_karaoke_set_key', semitones: desired/);
  assert.doesNotMatch(keyHandler, /currentTime\s*=/);
});

test('content control status renders the worker audio-processing error', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  const updateControls = source.slice(
    source.indexOf('const updateControls = () =>'),
    source.indexOf('lyricSearchWatchdog = createLyricsSearchWatchdog'),
  );
  const connectionHandler = source.slice(
    source.indexOf("if (command?.type === 'youtube_karaoke_connection')"),
    source.indexOf("if (command?.type === 'youtube_karaoke_pitch_status')"),
  );
  assert.match(updateControls, /connectionError/);
  assert.match(connectionHandler, /command\.error/);
});

test('content deactivation resets displayed and internal Key to zero', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  const deactivate = source.slice(
    source.indexOf('const deactivate = (notify = false) =>'),
    source.indexOf("const activate = (source = 'app') =>"),
  );
  assert.match(deactivate, /keySemitones\s*=\s*0/);
  assert.match(deactivate, /controlState\s*=\s*\{[^}]*keySemitones:\s*0/);
});

test('content runtime reads the active YouTube video when a stale video element remains', () => {
  const stale = { currentTime: 0 };
  const active = { currentTime: 30 };
  const fakeDocument = {
    querySelector(selector) {
      if (selector === 'video.html5-main-video') return active;
      if (selector === 'video') return stale;
      return null;
    },
  };
  assert.equal(readYouTubeVideo(fakeDocument), active);
});

test('selectYouTubeLyricPair skips filler lines and preserves the karaoke slot pair', () => {
  assert.deepEqual(selectYouTubeLyricPair([
    { timeMs: 1000, text: 'A', words: null },
    { timeMs: 3000, text: '♫', words: null },
    { timeMs: 5000, text: 'B', words: null },
  ], 1500, 0, -1), { index: 0, nextIndex: 2 });
  assert.deepEqual(selectYouTubeLyricPair([
    { timeMs: 1000, text: 'A', words: null },
    { timeMs: 5000, text: 'B', words: null },
  ], 5200, 300, 0), { index: 0, nextIndex: 1 });
  assert.deepEqual(selectYouTubeLyricPair([], 1000, 0, -1), { index: -1, nextIndex: -1 });
  assert.equal(typeof karaokeSlots, 'function');
  assert.equal(typeof karaokePaint, 'function');
});

test('lyricElementPolicy keeps only safe ruby attributes and unwraps unknown elements', () => {
  assert.equal(lyricElementPolicy('RUBY', 'data-hs'), 'keep');
  assert.equal(lyricElementPolicy('RT', null), 'keep');
  assert.equal(lyricElementPolicy('IMG', 'src'), 'unwrap');
  assert.equal(lyricElementPolicy('RUBY', 'onclick'), 'drop-attribute');
  assert.equal(lyricElementPolicy('SPAN', 'style'), 'unwrap');
});

test('setSafeLyricHtml invalidates detached karaoke state after replacing content', () => {
  const previousDocument = global.document;
  const target = { __kc: { chars: [] }, __kcNow: { stale: true }, replaceChildren() {} };
  global.document = {
    createElement(tagName) {
      assert.equal(tagName, 'template');
      return { content: { querySelectorAll: () => [] }, innerHTML: '' };
    },
  };
  try {
    setSafeLyricHtml(target, '');
    assert.equal(target.__kc, null);
    assert.equal(target.__kcNow, null);
  } finally {
    global.document = previousDocument;
  }
});

test('content lyric listener rejects malformed payloads before mapping', () => {
  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  global.document = {
    title: 'YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      return selector === 'video' ? video : null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.chrome = {
    runtime: {
      sendMessage() {},
      onMessage: { addListener(listener) { handler = listener; }, removeListener() {} },
    },
  };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  const message = (lyrics) => ({ type: 'youtube_karaoke_lyrics', lyrics });
  try {
    for (const lyrics of [
      { videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [null] },
      { videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [{ timeMs: 0, text: 'A', words: [{ start: 0 }] }] },
      { videoId: 12345678901, offsetMs: 0, lines: [] },
    ]) {
      assert.doesNotThrow(() => handler(message(lyrics)));
    }
  } finally {
    runtime.stop();
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('content runtime removes its named message listener on stop', () => {
  const source = fs.readFileSync(require.resolve('../src/youtube-content.js'), 'utf8');
  assert.match(source, /function handleRuntimeMessage\(command\)/);
  assert.match(source, /onMessage\.removeListener\(handleRuntimeMessage\)/);

  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  const removed = [];
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  global.document = {
    title: 'YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      return selector === 'video' ? video : null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.chrome = {
    runtime: {
      sendMessage() {},
      onMessage: {
        addListener(listener) { handler = listener; },
        removeListener(listener) { removed.push(listener); },
      },
    },
  };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  try {
    assert.equal(typeof handler, 'function');
    runtime.stop();
    assert.deepEqual(removed, [handler]);
  } finally {
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('content runtime starts the search watchdog for server-driven searching status', () => {
  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousLocation = global.location;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  const timers = [];
  const intervals = [];
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  global.location = { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  global.document = {
    title: 'Song - YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      return selector === 'video' ? video : null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.chrome = {
    runtime: {
      sendMessage() {},
      onMessage: { addListener(listener) { handler = listener; }, removeListener() {} },
    },
  };
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  global.clearInterval = () => {};
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  try {
    handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    handler({
      type: 'youtube_karaoke_lyrics_status',
      videoId: 'dQw4w9WgXcQ',
      status: 'searching',
      error: null,
    });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 25000);
  } finally {
    runtime.stop();
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.location = previousLocation;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('content runtime mounts and clears the lyric failure hint through the real observer path', () => {
  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousLocation = global.location;
  const previousMutationObserver = global.MutationObserver;
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  let observerCallback;
  let observerDisconnected = false;
  let hintTextWrites = 0;
  const nodes = [];
  const player = {
    children: [],
    appendChild(node) {
      if (!this.children.includes(node)) this.children.push(node);
      node.parentNode = this;
      return node;
    },
    querySelector() { return null; },
  };
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
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
        this.removed = true;
      },
      contains(target) { return target === this || this.children.includes(target); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, toggle() {} },
    };
    let text = '';
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => text,
      set: (value) => {
        if (node.id === 'kanaric-youtube-lyrics-hint') hintTextWrites += 1;
        text = value;
      },
    });
    nodes.push(node);
    return node;
  };
  global.location = { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  global.document = {
    title: 'Song - YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      if (selector === '.html5-video-player') return player;
      if (selector === 'video.html5-main-video' || selector === 'video') return video;
      return null;
    },
    createElement() { return makeNode(); },
    addEventListener() {},
    removeEventListener() {},
  };
  global.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  global.chrome = {
    runtime: {
      sendMessage() {},
      onMessage: { addListener(listener) { handler = listener; }, removeListener() {} },
    },
  };
  global.setInterval = () => 1;
  global.clearInterval = () => {};
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  try {
    handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    handler({ type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'error' });
    const hint = nodes.find((node) => node.id === 'kanaric-youtube-lyrics-hint');
    assert.ok(hint, 'error status mounts a player hint');
    assert.equal(hint.textContent, '找不到歌詞／查詢失敗，從 Kanaric 把手查看備選');
    assert.equal(hintTextWrites, 1);

    observerCallback([{ target: player, addedNodes: [hint], removedNodes: [] }]);
    assert.equal(hintTextWrites, 1, 'observer ignores its own hint node and does not rewrite it');
    handler({ type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'error' });
    assert.equal(hintTextWrites, 1, 'same hint text is idempotent');

    handler({ type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'loaded' });
    assert.equal(hint.parentNode, null, 'loaded clears the hint');
    handler({ type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'error' });
    const replacement = nodes.filter((node) => node.id === 'kanaric-youtube-lyrics-hint').at(-1);
    handler({ type: 'youtube_karaoke_activation', active: false, source: 'app' });
    assert.equal(replacement.parentNode, null, 'owner loss clears the hint');
    assert.equal(observerDisconnected, false, 'owner loss keeps the dormant observer available');
  } finally {
    runtime.stop();
    assert.equal(observerDisconnected, true);
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.location = previousLocation;
    global.MutationObserver = previousMutationObserver;
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('content runtime has no Kanaric DOM before App activation', () => {
  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  let created = 0;
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  const controls = { appendChild() {} };
  const player = {
    querySelector(selector) { return selector === '.ytp-right-controls' ? controls : null; },
    appendChild() {},
  };
  const element = () => ({
    style: { setProperty() {} },
    dataset: {},
    hidden: false,
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
    remove() {},
  });
  global.document = {
    title: 'Song - YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      if (selector === '.html5-video-player') return player;
      if (selector === 'video.html5-main-video' || selector === 'video') return video;
      return null;
    },
    createElement() { created += 1; return element(); },
    addEventListener() {},
    removeEventListener() {},
  };
  global.chrome = {
    runtime: {
      sendMessage() {},
      onMessage: { addListener(listener) { handler = listener; }, removeListener() {} },
    },
  };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};

  const runtime = startYouTubeContentRuntime();
  try {
    assert.equal(typeof handler, 'function');
    assert.equal(created, 0);
    assert.equal(runtime.isActive(), false);
  } finally {
    runtime.stop();
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('content runtime is dormant until activation and releases resources on exit', () => {
  const previousChrome = global.chrome;
  const previousDocument = global.document;
  const previousLocation = global.location;
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  let handler;
  let created = 0;
  const intervals = [];
  const cleared = [];
  const endedRemoved = [];
  const sent = [];
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  const player = { appendChild(node) { node.parentNode = player; } };
  const element = () => ({
    dataset: {},
    hidden: false,
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
    remove() { this.removed = true; },
  });

  global.location = { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  global.document = {
    title: 'Song - YouTube',
    body: { innerText: '' },
    querySelector(selector) {
      if (selector === '.html5-video-player') return player;
      if (selector === 'video.html5-main-video' || selector === 'video') return video;
      return null;
    },
    createElement() { created += 1; return element(); },
    addEventListener() {},
    removeEventListener(type) { if (type === 'ended') endedRemoved.push(type); },
  };
  global.chrome = {
    runtime: {
      sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); },
      onMessage: {
        addListener(listener) { handler = listener; },
        removeListener() {},
      },
    },
  };
  global.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  global.clearInterval = (id) => { cleared.push(id); };
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};

  const runtime = startYouTubeContentRuntime();
  try {
    assert.equal(runtime.isActive(), false);
    assert.equal(created, 0);
    assert.equal(intervals.length, 0);

    handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    assert.equal(runtime.isActive(), true);
    assert.equal(created, 2);
    assert.equal(intervals.length, 2);
    assert.equal(sent.length, 1);

    handler({ type: 'youtube_karaoke_activation', active: false, source: 'youtube' });
    assert.equal(runtime.isActive(), false);
    assert.equal(cleared.length, 2);
    assert.equal(endedRemoved.length, 1);
  } finally {
    runtime.stop();
    global.chrome = previousChrome;
    global.document = previousDocument;
    global.location = previousLocation;
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test('activation messages accept App entry and YouTube exit only', () => {
  assert.deepEqual(normalizeYouTubeActivationMessage({
    type: 'youtube_karaoke_activation', active: true, source: 'app',
  }), { type: 'youtube_karaoke_activation', active: true, source: 'app' });
  assert.deepEqual(normalizeYouTubeActivationMessage({
    type: 'youtube_karaoke_activation', active: false, source: 'youtube',
  }), { type: 'youtube_karaoke_activation', active: false, source: 'youtube' });
  assert.equal(normalizeYouTubeActivationMessage({
    type: 'youtube_karaoke_activation', active: true, source: 'popup',
  }), null);
  assert.equal(normalizeYouTubeActivationMessage({
    type: 'youtube_karaoke_activation', active: true, source: 'unknown', token: 'x',
  }), null);
});

test('loaded bundles retain the source search-completion runtime paths', () => {
  const contentBundle = fs.readFileSync(require.resolve('../dist/youtube-content.js'), 'utf8');
  const workerBundle = fs.readFileSync(require.resolve('../dist/service-worker.js'), 'utf8');
  assert.match(contentBundle, /LYRICS_SEARCH_TIMEOUT_MS/);
  assert.match(contentBundle, /youtube_karaoke_lyrics_reset/);
  assert.match(contentBundle, /shouldRetainYouTubeLyrics/);
  assert.match(workerBundle, /pendingMetadataSearch\.stage === "waiting"/);
});
