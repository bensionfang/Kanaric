'use strict';

const assert = require('node:assert/strict');
const pitch = require('../web-app/public/js/pitch-analysis.js');

function tone(hz, sampleRate = 48000, length = 4096) {
    return Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * hz * index / sampleRate));
}

function frame(midi, confidence = 0.95, voiced = true, timeMs = midi * 10, octaveWarning = false) {
    return { timeMs, midi, hz: pitch.midiToHz(midi), cents: 0, confidence, voiced, octaveWarning };
}

assert.equal(typeof pitch.detectPitchFrame, 'function');
assert.equal(typeof pitch.summarizeRange, 'function');
assert.equal(pitch.recommendKey, undefined);
assert.equal(pitch.shiftPitchFrames, undefined);

for (const [hz, midi] of [[220, 57], [440, 69], [880, 81]]) {
    const detected = pitch.detectPitchFrame(tone(hz), 48000, 1234);
    assert.equal(detected.timeMs, 1234);
    assert.equal(detected.voiced, true);
    assert.ok(Math.abs(detected.midi - midi) < 0.5, `${hz}Hz detected as MIDI ${detected.midi}`);
    assert.ok(detected.confidence >= 0.6, `${hz}Hz confidence=${detected.confidence}`);
    assert.ok(Math.abs(detected.cents) < 50, `${hz}Hz cents=${detected.cents}`);
}

const silent = pitch.detectPitchFrame(new Float32Array(4096), 48000, 20);
assert.equal(silent.voiced, false);
assert.equal(silent.midi, null);
assert.equal(silent.hz, null);
assert.equal(silent.confidence, 0);

const lowConfidence = pitch.detectPitchFrame(
    Float32Array.from(tone(440), (value) => value * 0.005), 48000, 30,
);
assert.equal(lowConfidence.voiced, false);
assert.ok(lowConfidence.confidence < 0.6);

const ambiguous = pitch.detectPitchFrame(Float32Array.from({ length: 4096 }, (_, index) => (
    Math.sin(2 * Math.PI * 220 * index / 48000)
    + Math.sin(2 * Math.PI * 440 * index / 48000)
)), 48000, 40);
assert.equal(ambiguous.octaveWarning, true);
assert.ok(ambiguous.confidence < 0.85);

const range = pitch.summarizeRange([
    frame(40),
    frame(60), frame(60), frame(62), frame(64), frame(66), frame(68), frame(70), frame(70),
    frame(92),
    frame(120, 0.95, true, 100, true),
    frame(10, 0.95, false),
]);
assert.equal(range.lowestMidi, 40);
assert.equal(range.highestMidi, 92);
assert.equal(range.comfortableLowMidi, 60);
assert.equal(range.comfortableHighMidi, 70);
assert.equal(range.voicedRatio, 0.833);
assert.equal(range.octaveWarning, true);

console.log('test_pitch_analysis: OK');
