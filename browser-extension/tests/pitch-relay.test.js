const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = require('../src/service-worker.js');
const content = require('../src/youtube-content.js');

const videoId = 'dQw4w9WgXcQ';
const frame = {
  timeMs: 1200,
  hz: 440,
  midi: 69,
  cents: 0,
  confidence: 0.91,
  voiced: true,
  octaveWarning: false,
};

assert.deepEqual(worker.normalizePitchRelayStatus({
  type: 'youtube_karaoke_pitch_status', videoId, revision: 2,
  status: 'enabled', error: null,
}), {
  type: 'youtube_karaoke_pitch_status', videoId, revision: 2,
  status: 'enabled', error: null,
});
assert.deepEqual(worker.normalizePitchRelayFrame({
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 2, frame,
}), {
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 2, frame,
});

assert.equal(worker.normalizePitchRelayStatus({
  type: 'youtube_karaoke_pitch_status', videoId, revision: 1,
  status: 'enabled', error: null, extra: true,
}), null);
assert.equal(worker.normalizePitchRelayFrame({
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 1,
  frame: { ...frame, pcm: 'forbidden' },
}), null);
assert.equal(worker.normalizePitchRelayFrame({
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 1,
  frame: { ...frame, confidence: 2 },
}), null);

assert.deepEqual(content.normalizeYouTubePitchStatus({
  type: 'youtube_karaoke_pitch_status', videoId, revision: 2,
  status: 'enabled', error: null,
}), {
  type: 'youtube_karaoke_pitch_status', videoId, revision: 2,
  status: 'enabled', error: null,
});
assert.deepEqual(content.normalizeYouTubePitchFrame({
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 2, frame,
}), {
  type: 'youtube_karaoke_pitch_frame', videoId, revision: 2, frame,
});
assert.equal(content.normalizeYouTubePitchStatus({
  type: 'youtube_karaoke_pitch_status', videoId, revision: 0,
  status: 'enabled', error: null,
}), null);

const contentSource = fs.readFileSync(path.join(__dirname, '../src/youtube-content.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '../src/service-worker.js'), 'utf8');
assert.doesNotMatch(contentSource, /createMicrophonePitchController|youtube_karaoke_pitch_(?:claim|release|start|stop)/);
assert.doesNotMatch(workerSource, /createMicrophonePitchController|persistPitchTake|youtube_karaoke_pitch_(?:claim|release|start|stop)/);

console.log('pitch-relay.test: OK');
