const test = require('node:test');
const assert = require('node:assert/strict');

const serviceWorker = require('../src/service-worker.js');
let offscreen;
try {
  offscreen = require('../src/offscreen.js');
} catch {
  offscreen = {};
}

test('key controller accepts integer -6..6 and resets on a new song', () => {
  assert.equal(typeof serviceWorker.createKeyController, 'function');
  const controller = serviceWorker.createKeyController();
  assert.equal(controller.current(), 0);
  assert.deepEqual(controller.set(-6), { ok: true, semitones: -6, tempo: 1 });
  assert.deepEqual(controller.set(6), { ok: true, semitones: 6, tempo: 1 });
  assert.equal(controller.set(-7).ok, false);
  assert.equal(controller.set(1.5).ok, false);
  controller.reset();
  assert.equal(controller.current(), 0);
});

test('setKeySemitones clamps integer Key values to -6..6', () => {
  assert.equal(typeof offscreen.setKeySemitones, 'function');
  assert.equal(offscreen.setKeySemitones(-9), -6);
  assert.equal(offscreen.setKeySemitones(9), 6);
  assert.equal(offscreen.setKeySemitones(0), 0);
  assert.equal(offscreen.setKeySemitones(1.5), null);
});

test('captureTabAudio asks tabCapture for the extension-owned target tab and forwards its stream id', async () => {
  const calls = [];
  const response = await serviceWorker.captureTabAudio(17, {
    tabCapture: {
      getMediaStreamId: async (options) => {
        calls.push(['capture', options]);
        return 'stream-1';
      },
    },
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => [],
      sendMessage: async (message) => {
        calls.push(['message', message]);
        return { ok: true, status: 'ready', keySemitones: 0, tempo: 1 };
      },
    },
    offscreen: {
      createDocument: async (options) => calls.push(['offscreen', options]),
    },
  });

  assert.deepEqual(response, { ok: true, status: 'ready', keySemitones: 0, tempo: 1 });
  assert.deepEqual(calls, [
    ['offscreen', {
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Process captured YouTube audio for manual key changes.',
    }],
    ['capture', { targetTabId: 17 }],
    ['message', { type: 'capture_tab', streamId: 'stream-1' }],
  ]);
});

test('ensureOffscreenDocument serializes concurrent document creation', async () => {
  let creates = 0;
  let release;
  const api = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => [],
    },
    offscreen: {
      createDocument: () => new Promise((resolve) => {
        creates += 1;
        release = resolve;
      }),
    },
  };

  const first = serviceWorker.ensureOffscreenDocument(api);
  const second = serviceWorker.ensureOffscreenDocument(api);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(creates, 1);
  release();
  await Promise.all([first, second]);
});

test('offscreen controller acknowledges capture and set_key', async () => {
  assert.equal(typeof offscreen.createOffscreenController, 'function');
  const calls = [];
  const controller = offscreen.createOffscreenController({
    createGraph: async ({ streamId }) => ({
      streamId,
      status: 'ready',
      setKey: (semitones) => { calls.push(semitones); return { ok: true, semitones, tempo: 1 }; },
    }),
  });

  assert.deepEqual(await controller.handle({ type: 'capture_tab', streamId: 'stream-1' }), {
    ok: true,
    status: 'ready',
    keySemitones: 0,
    tempo: 1,
  });
  assert.deepEqual(await controller.handle({ type: 'set_key', semitones: 3 }), {
    ok: true,
    semitones: 3,
    tempo: 1,
  });
  assert.deepEqual(calls, [3]);
  assert.deepEqual(await controller.handle({ type: 'set_key', semitones: 7 }), {
    ok: false,
    error: 'invalid-key',
  });
});

test('offscreen controller reuses one capture graph for the active owner', async () => {
  let creates = 0;
  const graph = {
    status: 'ready',
    keySemitones: 0,
    tempo: 1,
    setKeySemitones: (semitones) => ({ ok: true, semitones, tempo: 1 }),
  };
  const controller = offscreen.createOffscreenController({
    createGraph: async () => { creates += 1; return graph; },
  });

  await controller.handle({ type: 'capture_tab', streamId: 'stream-1' });
  await controller.handle({ type: 'capture_tab', streamId: 'stream-2' });
  assert.equal(creates, 1);
});

test('pitch dispose releases the graph before the next owner capture', async () => {
  let creates = 0;
  let disposes = 0;
  const controller = offscreen.createOffscreenController({
    pitchController: { handle: async () => ({ ok: true }) },
    createGraph: async () => {
      creates += 1;
      return {
        status: 'ready',
        keySemitones: 0,
        tempo: 1,
        setKeySemitones: (semitones) => ({ ok: true, semitones, tempo: 1 }),
        dispose: () => { disposes += 1; },
      };
    },
  });

  await controller.handle({ type: 'capture_tab', streamId: 'stream-1' });
  await controller.handle({ type: 'pitch_dispose' });
  assert.equal(disposes, 1);
  await controller.handle({ type: 'capture_tab', streamId: 'stream-2' });
  assert.equal(creates, 2);
});

test('offscreen controller keeps bypass truthful and rejects key changes', async () => {
  const controller = offscreen.createOffscreenController({
    createGraph: async () => ({
      status: 'bypass',
      keySemitones: 0,
      tempo: 1,
      error: { code: 'pitch-processing-unavailable', message: 'worklet failed' },
      setKeySemitones: () => ({ ok: false, error: 'pitch-processing-unavailable', status: 'bypass', bypassed: true }),
    }),
  });

  const capture = await controller.handle({ type: 'capture_tab', streamId: 'stream-1' });
  assert.equal(capture.status, 'bypass');
  assert.equal(capture.ok, false);
  assert.equal(capture.error.code, 'pitch-processing-unavailable');
  assert.deepEqual(await controller.handle({ type: 'set_key', semitones: 2 }), {
    ok: false,
    error: 'pitch-processing-unavailable',
    status: 'bypass',
    bypassed: true,
  });
});

test('worklet initialization failure bypasses audio and reports an explicit bypass status', async () => {
  assert.equal(typeof offscreen.createTabAudioGraph, 'function');
  const graph = await offscreen.createTabAudioGraph({
    streamId: 'stream-1',
    mediaDevices: { getUserMedia: async () => ({ id: 'tab-stream' }) },
    AudioContextClass: class FakeAudioContext {
      constructor() { this.destination = { id: 'destination' }; }
      createMediaStreamSource() { return { connections: [], connect(node) { this.connections.push(node); }, disconnect() {}, }; }
      createGain() { return { connections: [], connect(node) { this.connections.push(node); }, }; }
    },
    SoundTouchNodeClass: {
      register: async () => { throw new Error('worklet failed'); },
    },
  });

  assert.equal(graph.status, 'bypass');
  assert.equal(graph.ok, false);
  assert.equal(graph.bypassed, true);
  assert.equal(graph.error.code, 'pitch-processing-unavailable');
  assert.equal(graph.source.connections[0], graph.gain);
  assert.equal(graph.gain.connections[0].id, 'destination');
  assert.deepEqual(graph.setKeySemitones(2), {
    ok: false,
    error: 'pitch-processing-unavailable',
    status: 'bypass',
    bypassed: true,
  });
});

test('successful audio graph fixes SoundTouch tempo at 1.0 and applies the requested key', async () => {
  class FakeNode {
    constructor() { this.connections = []; }
    connect(node) { this.connections.push(node); }
    disconnect() {}
  }
  class FakeAudioContext {
    constructor() { this.destination = { id: 'destination' }; }
    createMediaStreamSource() { return new FakeNode(); }
    createGain() { return new FakeNode(); }
    async resume() {}
  }
  class FakeSoundTouchNode extends FakeNode {
    static async register() {}
    constructor() {
      super();
      this.pitch = { value: 0 };
      this.pitchSemitones = { value: 0 };
      this.playbackRate = { value: 0 };
    }
  }

  const graph = await offscreen.createTabAudioGraph({
    streamId: 'stream-1',
    mediaDevices: { getUserMedia: async () => ({ id: 'tab-stream' }) },
    AudioContextClass: FakeAudioContext,
    SoundTouchNodeClass: FakeSoundTouchNode,
  });

  assert.equal(graph.status, 'ready');
  assert.equal(graph.node.playbackRate.value, 1);
  assert.equal(graph.node.pitch.value, 1);
  assert.deepEqual(graph.setKeySemitones(6), { ok: true, semitones: 6, tempo: 1 });
  assert.equal(graph.node.pitchSemitones.value, 6);
});

test('setting Key preserves playback position and playback rate', async () => {
  class FakeNode {
    constructor() { this.connections = []; }
    connect(node) { this.connections.push(node); }
    disconnect() {}
  }
  class FakeAudioContext {
    constructor() { this.currentTime = 12.5; this.destination = { id: 'destination' }; }
    createMediaStreamSource() { return new FakeNode(); }
    createGain() { return new FakeNode(); }
    async resume() {}
  }
  class FakeSoundTouchNode extends FakeNode {
    static async register() {}
    constructor() {
      super();
      this.pitch = { value: 1 };
      this.pitchSemitones = { value: 0 };
      this.playbackRate = { value: 1 };
    }
  }

  const graph = await offscreen.createTabAudioGraph({
    streamId: 'stream-1',
    mediaDevices: { getUserMedia: async () => ({ id: 'tab-stream' }) },
    AudioContextClass: FakeAudioContext,
    SoundTouchNodeClass: FakeSoundTouchNode,
  });
  const before = { positionMs: graph.context.currentTime * 1000, playbackRate: graph.node.playbackRate.value };
  assert.deepEqual(graph.setKeySemitones(-9), { ok: true, semitones: -6, tempo: 1 });
  assert.deepEqual({ positionMs: graph.context.currentTime * 1000, playbackRate: graph.node.playbackRate.value }, before);
});

test('SoundTouchJS synthetic 440 Hz shifts near 220 and 880 Hz without changing tempo parameter', async () => {
  const { SoundTouch } = await import('@soundtouchjs/core');
  const sampleRate = 44100;
  const inputFrames = sampleRate * 3;
  const input = new Float32Array(inputFrames * 2);
  for (let frame = 0; frame < inputFrames; frame += 1) {
    const sample = Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    input[frame * 2] = sample;
    input[frame * 2 + 1] = sample;
  }

  for (const [semitones, expectedHz] of [[-12, 220], [12, 880]]) {
    const processor = new SoundTouch({ sampleRate, sampleBufferType: 'fifo' });
    processor.pitchSemitones = semitones;
    processor.inputBuffer.putSamples(input);
    processor.process();
    const output = new Float32Array(processor.outputBuffer.frameCount * 2);
    processor.outputBuffer.receiveSamples(output, output.length / 2);

    let crossings = 0;
    let previous = output[0];
    const startFrame = sampleRate;
    for (let frame = startFrame; frame < output.length / 2; frame += 1) {
      const current = output[frame * 2];
      if (previous <= 0 && current > 0) crossings += 1;
      previous = current;
    }
    const measuredHz = crossings / ((output.length / 2 - startFrame) / sampleRate);
    assert.ok(Math.abs(measuredHz - expectedHz) / expectedHz < 0.02, `${semitones}: ${measuredHz}Hz`);
  }
});

test('state relay buffers the latest YouTube state until the socket reconnects', () => {
  assert.equal(typeof serviceWorker.createStateRelay, 'function');
  let open = false;
  const sent = [];
  const relay = serviceWorker.createStateRelay({
    isOpen: () => open,
    send: (message) => sent.push(message),
  });
  const message = { type: 'youtube_karaoke_state', state: { videoId: 'dQw4w9WgXcQ', state: 'paused' } };

  assert.equal(relay.receive(message), false);
  assert.deepEqual(sent, []);
  open = true;
  assert.equal(relay.replay(), true);
  assert.deepEqual(sent, [message]);
});

test('state relay schedules one reconnect only when the socket is missing or closed', () => {
  const timers = [];
  let socketState = null;
  const scheduler = serviceWorker.createReconnectScheduler({
    reconnect: () => {},
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
  });
  const relay = serviceWorker.createStateRelay({
    isOpen: () => socketState === 1,
    isClosed: () => socketState === null || socketState === 3,
    scheduleReconnect: () => scheduler.schedule(),
  });
  const message = { type: 'youtube_karaoke_state', state: { videoId: 'dQw4w9WgXcQ', state: 'paused' } };

  relay.receive(message);
  relay.receive(message);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);

  socketState = 0;
  relay.receive(message);
  socketState = 1;
  relay.receive(message);
  assert.equal(timers.length, 1);

  timers[0].fn();
  socketState = 3;
  relay.receive(message);
  assert.equal(timers.length, 2);
});

test('socket keepalive sends an ignored heartbeat only while open', () => {
  assert.equal(typeof serviceWorker.createSocketKeepAlive, 'function');
  const timers = [];
  const sent = [];
  let open = false;
  const keepAlive = serviceWorker.createSocketKeepAlive({
    isOpen: () => open,
    send: (message) => sent.push(message),
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalFn: () => {},
  });

  keepAlive.start();
  assert.equal(timers[0].ms, 20000);
  timers[0].fn();
  assert.deepEqual(sent, []);
  open = true;
  timers[0].fn();
  assert.deepEqual(sent, [{ type: 'youtube_karaoke_heartbeat' }]);
  keepAlive.stop();
});

test('reconnect scheduler coalesces retries and invokes one reconnect', () => {
  assert.equal(typeof serviceWorker.createReconnectScheduler, 'function');
  const timers = [];
  let reconnects = 0;
  const scheduler = serviceWorker.createReconnectScheduler({
    reconnect: () => { reconnects += 1; },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
  });

  assert.equal(scheduler.schedule(), true);
  assert.equal(scheduler.schedule(), false);
  assert.equal(timers[0].ms, 1000);
  timers[0].fn();
  assert.equal(reconnects, 1);
});

test('server replacement close does not schedule a reconnect', () => {
  assert.equal(typeof serviceWorker.shouldReconnectAfterSocketClose, 'function');
  assert.equal(serviceWorker.shouldReconnectAfterSocketClose(4000), false);
  assert.equal(serviceWorker.shouldReconnectAfterSocketClose(1006), true);
});
