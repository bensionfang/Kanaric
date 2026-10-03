const assert = require('assert');

const {
  normalizeKaraokePitchStatus,
  normalizeKaraokePitchFrame,
} = require('../web-app/youtube-karaoke-protocol.js');
const {
  createKaraokePitchRelayStatus,
  createKaraokePitchRelayFrame,
} = require('../web-app/public/js/karaoke-mode.js');

const VIDEO_ID = 'dQw4w9WgXcQ';
const FRAME = {
  timeMs: 1200,
  hz: 440,
  midi: 69,
  cents: 0,
  confidence: 0.91,
  voiced: true,
  octaveWarning: false,
};

assert.deepStrictEqual(normalizeKaraokePitchStatus({
  type: 'youtube_karaoke_pitch_status',
  videoId: VIDEO_ID,
  revision: 2,
  status: 'enabled',
  error: null,
}), {
  type: 'youtube_karaoke_pitch_status',
  videoId: VIDEO_ID,
  revision: 2,
  status: 'enabled',
  error: null,
});

assert.deepStrictEqual(normalizeKaraokePitchFrame({
  type: 'youtube_karaoke_pitch_frame',
  videoId: VIDEO_ID,
  revision: 2,
  frame: FRAME,
}), {
  type: 'youtube_karaoke_pitch_frame',
  videoId: VIDEO_ID,
  revision: 2,
  frame: FRAME,
});

assert.equal(normalizeKaraokePitchStatus({
  type: 'youtube_karaoke_pitch_status', videoId: VIDEO_ID, revision: 0,
  status: 'enabled', error: null,
}), null, 'relay revision must be positive');
assert.equal(normalizeKaraokePitchStatus({
  type: 'youtube_karaoke_pitch_status', videoId: VIDEO_ID, revision: 2,
  status: 'enabled', error: null, lyrics: 'forbidden',
}), null, 'relay status rejects extra fields');
assert.equal(normalizeKaraokePitchFrame({
  type: 'youtube_karaoke_pitch_frame', videoId: VIDEO_ID, revision: 2,
  frame: { ...FRAME, confidence: 2 },
}), null, 'relay frame rejects out-of-range fields');
assert.equal(normalizeKaraokePitchFrame({
  type: 'youtube_karaoke_pitch_frame', videoId: VIDEO_ID, revision: 2,
  frame: FRAME, rawAudio: 'forbidden',
}), null, 'relay frame rejects raw audio');

assert.deepStrictEqual(createKaraokePitchRelayStatus(VIDEO_ID, 2, 'stopped'), {
  type: 'youtube_karaoke_pitch_status', videoId: VIDEO_ID, revision: 2,
  status: 'stopped', error: null,
});
assert.deepStrictEqual(createKaraokePitchRelayFrame(VIDEO_ID, 2, FRAME), {
  type: 'youtube_karaoke_pitch_frame', videoId: VIDEO_ID, revision: 2,
  frame: FRAME,
});
assert.equal(createKaraokePitchRelayStatus(VIDEO_ID, 2, 'error', {
  code: 'mic', message: 'failed', extra: true,
}), null);
assert.equal(createKaraokePitchRelayFrame(VIDEO_ID, 0, FRAME), null);

console.log('test_karaoke_pitch_relay: OK');
