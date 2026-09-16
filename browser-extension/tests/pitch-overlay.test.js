const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  getYouTubePitchOverlayMarkup,
  drawYouTubePitchTrail,
  shouldRefreshYouTubeChromeMutations,
  startYouTubeContentRuntime,
} = require('../src/youtube-content.js');

function createPitchRuntimeFixture({ videoId = 'dQw4w9WgXcQ' } = {}) {
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
  let currentVideoId = videoId;
  const nodes = [];
  const intervals = [];
  const events = new Map();
  const contexts = [];
  const video = { readyState: 1, paused: true, ended: false, currentTime: 0, duration: 10 };
  const player = {
    children: [],
    appendChild(node) {
      if (!this.children.includes(node)) this.children.push(node);
      node.parentNode = this;
      return node;
    },
    querySelector(selector) {
      return selector === '.ytp-fullscreen-button' ? { click() {} } : findDescendant(this, selector);
    },
  };

  function matches(node, selector) {
    if (!node || typeof selector !== 'string') return false;
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return node.className?.split?.(/\s+/).includes(selector.slice(1));
    return node.tagName?.toLowerCase() === selector.toLowerCase();
  }

  function findDescendant(node, selector) {
    for (const child of node?.children || []) {
      if (matches(child, selector)) return child;
      const nested = findDescendant(child, selector);
      if (nested) return nested;
    }
    return null;
  }

  function makeNode(tagName = 'div') {
    const node = {
      tagName: tagName.toUpperCase(),
      id: '',
      className: '',
      dataset: {},
      hidden: false,
      parentNode: null,
      children: [],
      style: { cssText: '' },
      attributes: {},
      classList: {
        add(...names) { node.className = [...new Set(`${node.className} ${names.join(' ')}`.trim().split(/\s+/).filter(Boolean))].join(' '); },
        remove(...names) { node.className = node.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
        toggle(name, force) {
          const next = force === undefined ? !node.className.split(/\s+/).includes(name) : force;
          if (next) this.add(name); else this.remove(name);
          return next;
        },
      },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      appendChild(child) {
        if (!node.children.includes(child)) node.children.push(child);
        child.parentNode = node;
        return child;
      },
      remove() {
        if (node.parentNode?.children) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
        node.parentNode = null;
      },
      contains(target) { return target === node || node.children.some((child) => child === target || child.contains?.(target)); },
      querySelector(selector) { return findDescendant(node, selector); },
      querySelectorAll(selector) {
        const result = [];
        const visit = (parent) => {
          for (const child of parent.children || []) {
            if (matches(child, selector)) result.push(child);
            visit(child);
          }
        };
        visit(node);
        return result;
      },
      replaceChildren(...children) {
        node.children = [];
        children.flat().forEach((child) => node.appendChild(child));
      },
    };
    let text = '';
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => text,
      set: (value) => { text = String(value); },
    });
    Object.defineProperty(node, 'innerHTML', {
      configurable: true,
      get: () => '',
      set: (value) => {
        node.children = [];
        if (!String(value).includes('kanaric-pitch-canvas')) return;
        const canvas = makeNode('canvas');
        canvas.className = 'kanaric-pitch-canvas';
        canvas.width = 600;
        canvas.height = 180;
        const context = {
          clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        };
        canvas.getContext = () => context;
        contexts.push(context);
        node.appendChild(canvas);
        for (const className of ['kanaric-pitch-note', 'kanaric-pitch-confidence', 'kanaric-pitch-status']) {
          const child = makeNode('span');
          child.className = className;
          node.appendChild(child);
        }
      },
    });
    nodes.push(node);
    return node;
  }

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
    createElement(tagName) { return makeNode(tagName); },
    addEventListener(type, listener) { events.set(type, listener); },
    removeEventListener(type, listener) { if (events.get(type) === listener) events.delete(type); },
  };
  global.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  };
  global.chrome = {
    runtime: {
      sendMessage() { return Promise.resolve({ ok: true }); },
      onMessage: { addListener(listener) { handler = listener; }, removeListener() {} },
    },
  };
  global.setInterval = (callback) => { intervals.push(callback); return intervals.length; };
  global.clearInterval = () => {};
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  const runtime = startYouTubeContentRuntime();
  return {
    runtime,
    player,
    video,
    nodes,
    contexts,
    get handler() { return handler; },
    setUrl,
    report() { intervals.forEach((callback) => callback()); },
    mutate(records = [{ target: player, addedNodes: [makeNode()], removedNodes: [] }]) { observerCallback?.(records); },
    pitchRoot() { return player.children.find((node) => node.id === 'kanaric-youtube-pitch'); },
    pitchStyle() { return player.children.find((node) => node.id === 'kanaric-youtube-pitch-style'); },
    cleanup() { runtime.stop(); Object.assign(global, previous); },
    currentVideoId: () => currentVideoId,
  };
}

const frame = (revision = 4, overrides = {}) => ({
  type: 'youtube_karaoke_pitch_frame',
  videoId: 'dQw4w9WgXcQ',
  revision,
  frame: {
    timeMs: 1000,
    hz: 261.63,
    midi: 60,
    cents: 0,
    confidence: 0.84,
    voiced: true,
    octaveWarning: false,
    ...overrides,
  },
});

test('pitch overlay markup is a separate passive canvas and text surface', () => {
  const markup = getYouTubePitchOverlayMarkup();
  assert.match(markup, /kanaric-pitch-canvas/);
  assert.match(markup, /kanaric-pitch-note/);
  assert.match(markup, /kanaric-pitch-confidence/);
  assert.match(markup, /kanaric-pitch-status/);
});

test('pitch trail reuses the bounded recent frame window and skips unvoiced gaps', () => {
  const calls = [];
  const canvas = {
    width: 600,
    height: 180,
    getContext() {
      return {
        clearRect: (...args) => calls.push(['clearRect', ...args]),
        beginPath: () => calls.push(['beginPath']),
        moveTo: (...args) => calls.push(['moveTo', ...args]),
        lineTo: (...args) => calls.push(['lineTo', ...args]),
        stroke: () => calls.push(['stroke']),
      };
    },
  };
  drawYouTubePitchTrail(canvas, [
    { timeMs: 0, midi: 60, voiced: true },
    { timeMs: 1000, midi: null, voiced: false },
    { timeMs: 16000, midi: 62, voiced: true },
  ]);
  assert.deepEqual(calls[0], ['clearRect', 0, 0, 600, 180]);
  assert.ok(calls.filter(([name]) => name === 'stroke').length >= 4, 'grid and pitch path are drawn');
  assert.ok(calls.some(([name, x]) => name === 'moveTo' && x === 600), 'latest frame sits at the right edge');
});

test('pitch overlay nodes are excluded from the shared YouTube mutation refresh filter', () => {
  const pitchOverlay = { contains: (node) => node?.owner === 'pitch' };
  const pitchStyle = { id: 'kanaric-youtube-pitch-style' };
  const player = { id: 'player' };
  assert.equal(shouldRefreshYouTubeChromeMutations([
    { target: pitchOverlay, addedNodes: [{ owner: 'pitch' }], removedNodes: [] },
    { target: player, addedNodes: [pitchOverlay, pitchStyle], removedNodes: [] },
  ], null, null, null, pitchOverlay, pitchStyle), false);
  assert.equal(shouldRefreshYouTubeChromeMutations([
    { target: player, addedNodes: [{ owner: 'youtube' }], removedNodes: [] },
  ], null, null, null, pitchOverlay, pitchStyle), true);
});

test('pitch overlay is lazy, owner-gated, readable, and fully removed across lifecycle changes', () => {
  const fixture = createPitchRuntimeFixture();
  try {
    assert.equal(fixture.pitchRoot(), undefined, 'ordinary YouTube has no pitch DOM');
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 4, positionMs: 0 });
    assert.equal(fixture.pitchRoot(), undefined, 'pitch is not mounted before App enable');

    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    const root = fixture.pitchRoot();
    assert.ok(root, 'enabled owner mounts pitch overlay');
    assert.ok(fixture.pitchStyle(), 'enabled owner mounts independent pitch style');
    assert.match(root.style.cssText, /pointer-events:\s*none/);
    assert.match(fixture.pitchStyle().textContent, /height:\s*33%/);
    assert.match(fixture.pitchStyle().textContent, /pointer-events:\s*none/);

    fixture.handler(frame());
    assert.equal(root.querySelector('.kanaric-pitch-note').textContent, '目前音名 C4');
    assert.equal(root.querySelector('.kanaric-pitch-confidence').textContent, '信心度 84%');
    assert.match(root.querySelector('.kanaric-pitch-status').textContent, /已啟用/);

    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'stopped', error: null });
    assert.equal(fixture.pitchRoot(), undefined, 'stop removes pitch root');
    assert.equal(fixture.pitchStyle(), undefined, 'stop removes pitch style');

    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    assert.ok(fixture.pitchRoot());
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'disconnected', error: 'closed' });
    assert.equal(fixture.pitchRoot(), undefined, 'disconnect removes pitch root');
    assert.equal(fixture.pitchStyle(), undefined, 'disconnect removes pitch style');

    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    fixture.setUrl('kJQP7kiw5Fk');
    fixture.report();
    assert.equal(fixture.pitchRoot(), undefined, 'song change removes the old pitch root');
    assert.equal(fixture.pitchStyle(), undefined, 'song change removes the old pitch style');
  } finally {
    fixture.cleanup();
  }
});

test('pitch overlay respects player readiness and ignores self mutations without rebuilding', () => {
  const fixture = createPitchRuntimeFixture();
  try {
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 4, positionMs: 0 });
    fixture.video.readyState = 0;
    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    assert.equal(fixture.pitchRoot(), undefined, 'not-ready player does not mount pitch');

    fixture.video.readyState = 1;
    fixture.report();
    const root = fixture.pitchRoot();
    const style = fixture.pitchStyle();
    assert.ok(root);
    assert.ok(style);
    fixture.mutate([{ target: root, addedNodes: [root], removedNodes: [] }, { target: style, addedNodes: [], removedNodes: [] }]);
    assert.equal(fixture.pitchRoot(), root, 'self mutation keeps one pitch root');
    assert.equal(fixture.pitchStyle(), style, 'self mutation keeps one pitch style');

    fixture.handler({ type: 'youtube_karaoke_activation', active: false, source: 'app' });
    assert.equal(root.parentNode, null, 'deactivation removes pitch root');
    assert.equal(style.parentNode, null, 'deactivation removes pitch style');
  } finally {
    fixture.cleanup();
  }
});

test('pitch error requiring retry removes the pitch DOM and stale frames stay ignored', () => {
  const fixture = createPitchRuntimeFixture();
  try {
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 4, positionMs: 0 });
    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    const root = fixture.pitchRoot();
    fixture.handler(frame(3, { midi: 48, confidence: 0.1 }));
    assert.equal(root.querySelector('.kanaric-pitch-note').textContent, '目前音名 —', 'stale frame does not paint');
    fixture.handler({
      type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'error',
      error: { code: 'NotAllowedError', message: 'blocked' },
    });
    assert.equal(root.parentNode, null, 'error removes pitch root for retry');
  } finally {
    fixture.cleanup();
  }
});

test('a same-video revision change removes the old pitch overlay before replay', () => {
  const fixture = createPitchRuntimeFixture();
  try {
    fixture.handler({ type: 'youtube_karaoke_activation', active: true, source: 'app' });
    fixture.handler({ type: 'youtube_karaoke_connection', state: 'connected', error: '' });
    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 4, positionMs: 0 });
    fixture.handler({ type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 4, status: 'enabled', error: null });
    const oldRoot = fixture.pitchRoot();
    const oldStyle = fixture.pitchStyle();
    assert.ok(oldRoot);
    assert.ok(oldStyle);

    fixture.handler({ action: 'load', videoId: 'dQw4w9WgXcQ', revision: 5, positionMs: 0 });
    assert.equal(oldRoot.parentNode, null, 'revision change removes the old root');
    assert.equal(oldStyle.parentNode, null, 'revision change removes the old style');
    assert.equal(fixture.pitchRoot(), undefined, 'revision change waits for matching status replay');
  } finally {
    fixture.cleanup();
  }
});
