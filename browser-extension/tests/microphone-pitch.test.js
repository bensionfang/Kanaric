const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const offscreen = require('../src/offscreen.js');
const content = require('../src/youtube-content.js');
const {
  createKaraokePitchRecorder,
} = require('../../web-app/public/js/karaoke-pitch-recorder.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const contentSource = read('src/youtube-content.js');
const workerSource = read('src/service-worker.js');
const offscreenSource = read('src/offscreen.js');
const appModeSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'web-app', 'public', 'js', 'karaoke-mode.js'),
  'utf8',
);

// The App owns microphone capture, pitch frames, and optional dry-recording UI.
assert.match(appModeSource, /createKaraokePitchRecorder/);
assert.match(appModeSource, /navigator\.mediaDevices/);
assert.match(appModeSource, /sendPitchRelayFrame/);
assert.match(appModeSource, /createKaraokePitchLifecycle/);

// The extension owns only YouTube tab-audio capture/Key processing and relay input.
for (const source of [contentSource, workerSource, offscreenSource]) {
  assert.doesNotMatch(source, /createMicrophonePitchController|claimMicrophonePitch|releaseMicrophonePitch/);
  assert.doesNotMatch(source, /youtube_karaoke_pitch_(?:claim|release|start|stop)/);
}
assert.doesNotMatch(contentSource, /take:\s*response\?\.recording|audio:\s*response\?\.recording/);
assert.match(offscreenSource, /chromeMediaSource:\s*'tab'/);
assert.match(workerSource, /capture_tab/);
assert.match(workerSource, /set_key/);

class FakeAnalyser {
  constructor() { this.fftSize = 2048; }
  getFloatTimeDomainData() {}
}

class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.closed = false; }
  createMediaStreamSource(stream) {
    return { stream, connect() {}, disconnect() {} };
  }
  createAnalyser() { return new FakeAnalyser(); }
  close() { this.closed = true; }
}

(async () => {
  const requests = [];
  let stopped = false;
  const recorder = createKaraokePitchRecorder({
    mediaDevices: {
      getUserMedia: async (constraints) => {
        requests.push(constraints);
        return { getTracks: () => [{ stop: () => { stopped = true; } }] };
      },
    },
    AudioContext: FakeAudioContext,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  assert.deepEqual(await recorder.enable(), { enabled: true });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].audio, {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  assert.equal(requests[0].video, false);
  await recorder.dispose();
  assert.equal(stopped, true, 'App recorder releases its microphone tracks');

  const tabRequests = [];
  class TabAudioContext extends FakeAudioContext {
    createGain() { return { connect() {}, disconnect() {} }; }
  }
  class SoundTouchNode {
    static async register() {}
    constructor() {
      this.pitch = { value: 1 };
      this.pitchSemitones = { value: 0 };
      this.playbackRate = { value: 1 };
    }
    connect() {}
    disconnect() {}
  }
  const tabStream = { getTracks: () => [{ stop() {} }] };
  const graph = await offscreen.createTabAudioGraph({
    streamId: 'tab-stream',
    mediaDevices: { getUserMedia: async (constraints) => {
      tabRequests.push(constraints);
      return tabStream;
    } },
    AudioContextClass: TabAudioContext,
    SoundTouchNodeClass: SoundTouchNode,
  });
  assert.equal(graph.status, 'ready');
  assert.equal(tabRequests[0].audio.mandatory.chromeMediaSource, 'tab');
  graph.dispose();

  assert.equal(typeof content.normalizeYouTubePitchStatus, 'function');
  assert.equal(typeof content.normalizeYouTubePitchFrame, 'function');
  console.log('microphone-pitch.test: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
