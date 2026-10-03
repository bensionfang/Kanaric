'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    createKaraokePitchRecorder,
    createDryRecordingController,
    createMicrophonePitchController,
} = require('../web-app/public/js/karaoke-pitch-recorder.js');

function makeTimer() {
    let callback = null;
    return {
        start(fn) { callback = fn; return 1; },
        stop() { callback = null; },
        tick() { if (callback) callback(); },
    };
}

class FakeTrack {
    constructor() { this.stopped = false; }
    stop() { this.stopped = true; }
}

class FakeAnalyser {
    constructor() {
        this.fftSize = 0;
        this.connections = [];
        this.samples = new Float32Array(32);
    }
    getFloatTimeDomainData(target) { target.set(this.samples); }
    connect(node) { this.connections.push(node); }
}

class FakeContext {
    static instances = [];
    constructor() {
        this.destination = { kind: 'destination' };
        this.analyser = new FakeAnalyser();
        this.source = { connections: [], connect: (node) => this.source.connections.push(node) };
        this.closed = false;
        FakeContext.instances.push(this);
    }
    createMediaStreamSource(stream) { this.stream = stream; return this.source; }
    createAnalyser() { return this.analyser; }
    close() { this.closed = true; return Promise.resolve(); }
}

const timer = makeTimer();
const track = new FakeTrack();
const stream = { getTracks: () => [track] };
let micCalls = 0;
let playback = { state: 'paused', positionMs: 0 };
const emitted = [];
let confidence = 0.7;

const recorder = createKaraokePitchRecorder({
    mediaDevices: {
        getUserMedia: async (constraints) => {
            micCalls += 1;
            assert.deepEqual(constraints, {
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                video: false,
            });
            return stream;
        },
    },
    AudioContext: FakeContext,
    getPlaybackState: () => playback,
    onFrame: (frame) => emitted.push(frame),
    setInterval: timer.start,
    clearInterval: timer.stop,
    detectPitchFrame: (_samples, _sampleRate, timeMs) => ({
        timeMs, hz: 440, midi: 69, cents: 0, confidence, voiced: true, octaveWarning: false,
    }),
});

recorder.startTake({ videoId: 'video-before-enable' });
assert.equal(micCalls, 0);
assert.equal(recorder.finishTake().frames.length, 0);

(async () => {
    const enabled = await recorder.enable();
    assert.equal(enabled.enabled, true);
    assert.equal(micCalls, 1);
    assert.equal(FakeContext.instances.length, 1);
    const context = FakeContext.instances[0];
    assert.equal(context.source.connections.length, 1);
    assert.equal(context.source.connections[0], context.analyser);
    assert.equal(context.analyser.connections.length, 0);

    const electronSource = fs.readFileSync(path.join(__dirname, '..', 'web-app', 'electron.js'), 'utf8');
    assert.match(electronSource, /setPermissionRequestHandler/);
    assert.match(electronSource, /permission === 'media'/);
    assert.match(electronSource, /mediaTypes\.includes\('audio'\)/);
    assert.match(electronSource, /!mediaTypes\.includes\('video'\)/);
    assert.match(electronSource, /http:\/\/localhost:\$\{PORT\}/);
    assert.match(electronSource, /http:\/\/127\.0\.0\.1:\$\{PORT\}/);

    recorder.startTake({ videoId: 'video-a', title: 'A', channel: 'C' });
    playback = { state: 'playing', positionMs: 104 };
    timer.tick();
    confidence = 0.95;
    playback = { state: 'playing', positionMs: 110 };
    timer.tick();
    assert.equal(emitted.length, 2);

    recorder.pause();
    playback = { state: 'playing', positionMs: 204 };
    timer.tick();
    assert.equal(emitted.length, 2);
    recorder.resume();
    playback = { state: 'playing', positionMs: 304 };
    timer.tick();
    assert.equal(emitted.length, 3);

    for (const state of ['paused', 'buffering', 'ad', 'error']) {
        playback = { state, positionMs: 404 };
        timer.tick();
    }
    assert.equal(emitted.length, 3);

    playback = { state: 'playing', positionMs: 204 };
    timer.tick();
    playback = { state: 'playing', positionMs: 504 };
    timer.tick();
    const finished = recorder.finishTake();
    assert.equal(finished.status, 'insufficient-data');
    assert.deepEqual(finished.frames.map((frame) => frame[0]), [100, 200, 300, 500]);
    assert.equal(finished.frames.length, 4);
    assert.equal(finished.frames[0][2], 950);
    assert.deepEqual(finished.frames.map((frame) => frame[0]), [...finished.frames].sort((a, b) => a[0] - b[0]).map((frame) => frame[0]));

    recorder.startTake({ videoId: 'video-b' });
    playback = { state: 'playing', positionMs: 0 };
    timer.tick();
    const insufficient = recorder.finishTake();
    assert.equal(insufficient.status, 'insufficient-data');

    await recorder.dispose();
    assert.equal(track.stopped, true);
    assert.equal(context.closed, true);
    timer.tick();

    // dispose 與尚未完成的 getUserMedia 競態:晚到的 stream 不得讓 recorder 復活。
    let resolveRaceStream;
    const raceTrack = new FakeTrack();
    const raceStream = { getTracks: () => [raceTrack] };
    const raceRecorder = createKaraokePitchRecorder({
        mediaDevices: {
            getUserMedia: () => new Promise((resolve) => { resolveRaceStream = resolve; }),
        },
        AudioContext: FakeContext,
        setInterval: timer.start,
        clearInterval: timer.stop,
        setTimeout: () => 1,
        clearTimeout: () => {},
    });
    const raceEnable = raceRecorder.enable();
    const raceDispose = raceRecorder.dispose();
    resolveRaceStream(raceStream);
    const [raceResult] = await Promise.all([raceEnable, raceDispose]);
    assert.deepEqual(raceResult, { enabled: false, error: 'microphone-disposed' });
    assert.equal(raceRecorder.getStream(), null, 'dispose 完成後不得留下晚到的 stream');
    assert.equal(raceTrack.stopped, true, '晚到 stream 的 track 必須被釋放');

    class FakeMediaRecorder {
        static instances = [];
        static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
        constructor(input, options) {
            this.stream = input;
            this.mimeType = options.mimeType;
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            FakeMediaRecorder.instances.push(this);
        }
        start() { this.state = 'recording'; }
        stop() {
            this.state = 'inactive';
            this.onstop?.();
        }
    }
    const recordingStream = { getTracks: () => [] };
    const recordingDownloads = [];
    const recordingUrls = [];
    const revokedUrls = [];
    const dry = createDryRecordingController({
        MediaRecorderClass: FakeMediaRecorder,
        createObjectURL: (blob) => { const url = `blob:${recordingUrls.length}`; recordingUrls.push({ url, blob }); return url; },
        revokeObjectURL: (url) => revokedUrls.push(url),
        download: (url, fileName) => recordingDownloads.push({ url, fileName }),
        BlobClass: class FakeBlob {
            constructor(chunks, options) { this.chunks = chunks; this.type = options.type; this.size = chunks.reduce((total, item) => total + item.size, 0); }
        },
    });
    assert.deepEqual(dry.start(recordingStream, { artist: 'A/B', title: 'Song?', keySemitones: -2, now: 0 }), { ok: true });
    assert.equal(FakeMediaRecorder.instances[0].stream, recordingStream);
    assert.equal(FakeMediaRecorder.instances[0].mimeType, 'audio/webm;codecs=opus');
    const recorderPart = FakeMediaRecorder.instances[0];
    recorderPart.ondataavailable({ data: { size: 2, bytes: [1, 2] } });
    const saved = await dry.stop();
    assert.equal(saved.fileName, 'Kanaric-A_B-Song_-key-2-19700101-000000.webm');
    assert.equal(saved.blob.type, 'audio/webm;codecs=opus');
    assert.equal(await dry.stop(), null);
    assert.equal(recordingDownloads.length, 0);
    dry.download(saved);
    assert.equal(recordingDownloads.length, 1);
    assert.deepEqual(recordingDownloads[0], { url: 'blob:0', fileName: saved.fileName });
    assert.deepEqual(revokedUrls, ['blob:0']);

    const empty = createDryRecordingController({ MediaRecorderClass: FakeMediaRecorder, BlobClass: globalThis.Blob });
    assert.deepEqual(empty.start(recordingStream, { artist: 'A', title: 'B', keySemitones: 0, now: 0 }), { ok: true });
    assert.equal(await empty.stop(), null);

    const unsupported = createDryRecordingController({ MediaRecorderClass: null });
    assert.deepEqual(unsupported.start(recordingStream, { artist: 'A', title: 'B', keySemitones: 0, now: 0 }), {
        ok: false,
        error: 'media-recorder-unavailable',
    });
    unsupported.discard();

    let sharedStream;
    let readyRecording;
    let discarded = 0;
    let disposed = false;
    const sharedController = createMicrophonePitchController({
        createRecorder: () => ({
            enable: async () => ({ enabled: true }),
            getStream: () => recordingStream,
            startTake: () => {},
            finishTake: () => ({ status: 'ready', frames: [], range: {} }),
            dispose: async () => { disposed = true; },
        }),
        createDryRecording: () => ({
            start: (streamInput) => { sharedStream = streamInput; return { ok: true }; },
            stop: async () => ({ blob: { type: 'audio/webm' }, fileName: 'local.webm' }),
            discard: async () => { discarded += 1; },
        }),
        onRecordingReady: (result) => { readyRecording = result; },
    });
    assert.deepEqual(await sharedController.handle({
        type: 'pitch_start',
        song: { videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', keySemitones: 1 },
    }), { ok: true, status: 'enabled' });
    assert.equal(sharedStream, recordingStream);
    const sharedStopped = await sharedController.handle({ type: 'pitch_stop' });
    assert.equal(sharedStopped.recording.fileName, 'local.webm');
    assert.equal(readyRecording.controller != null, true);
    assert.equal(disposed, true);

    const exitController = createMicrophonePitchController({
        createRecorder: () => ({
            enable: async () => ({ enabled: true }),
            getStream: () => recordingStream,
            startTake: () => {},
            finishTake: () => ({ status: 'ready', frames: [], range: {} }),
            dispose: async () => {},
        }),
        createDryRecording: () => ({
            start: () => ({ ok: true }),
            stop: async () => ({ blob: {}, fileName: 'should-not-save.webm' }),
            discard: async () => { discarded += 1; },
        }),
    });
    await exitController.handle({ type: 'pitch_start', song: { videoId: 'dQw4w9WgXcQ' } });
    await exitController.handle({ type: 'pitch_dispose' });
    assert.equal(discarded, 1);

    const pendingEnables = [];
    let concurrentEnableCalls = 0;
    let concurrentStartTakes = 0;
    let concurrentDisposeCalls = 0;
    const concurrentStartController = createMicrophonePitchController({
        createRecorder: () => ({
            enable: () => {
                concurrentEnableCalls += 1;
                return new Promise((resolve) => pendingEnables.push(resolve));
            },
            getStream: () => recordingStream,
            startTake: () => { concurrentStartTakes += 1; },
            finishTake: () => ({ status: 'ready', frames: [], range: {} }),
            dispose: async () => { concurrentDisposeCalls += 1; },
        }),
    });
    const firstStart = concurrentStartController.handle({ type: 'pitch_start', song: { videoId: 'dQw4w9WgXcQ' } });
    const secondStart = concurrentStartController.handle({ type: 'pitch_start', song: { videoId: 'dQw4w9WgXcQ' } });
    assert.equal(concurrentEnableCalls, 1);
    assert.equal(pendingEnables.length, 1);
    pendingEnables[0]({ enabled: true });
    assert.deepEqual(await firstStart, { ok: true, status: 'enabled' });
    assert.deepEqual(await secondStart, { ok: true, status: 'enabled' });
    assert.equal(concurrentStartTakes, 1);
    await concurrentStartController.handle({ type: 'pitch_dispose' });
    assert.equal(concurrentDisposeCalls, 1);

    let lifecycleFinishCalls = 0;
    let lifecycleDisposeCalls = 0;
    let lifecycleDryStopCalls = 0;
    let lifecycleDryDiscardCalls = 0;
    let resolveLifecycleDispose;
    const lifecycleController = createMicrophonePitchController({
        createRecorder: () => ({
            enable: async () => ({ enabled: true }),
            getStream: () => recordingStream,
            startTake: () => {},
            finishTake: () => {
                lifecycleFinishCalls += 1;
                return { status: 'ready', frames: [], range: {} };
            },
            dispose: () => {
                lifecycleDisposeCalls += 1;
                return new Promise((resolve) => { resolveLifecycleDispose = resolve; });
            },
        }),
        createDryRecording: () => ({
            start: () => ({ ok: true }),
            stop: async () => { lifecycleDryStopCalls += 1; return null; },
            discard: async () => { lifecycleDryDiscardCalls += 1; },
        }),
    });
    await lifecycleController.handle({ type: 'pitch_start', song: { videoId: 'dQw4w9WgXcQ' } });
    const lifecycleStop = lifecycleController.handle({ type: 'pitch_stop' });
    const lifecycleDispose = lifecycleController.handle({ type: 'pitch_dispose' });
    assert.strictEqual(lifecycleStop, lifecycleDispose);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lifecycleFinishCalls, 1);
    assert.equal(lifecycleDisposeCalls, 1);
    assert.equal(lifecycleDryStopCalls, 1);
    assert.equal(lifecycleDryDiscardCalls, 0);
    resolveLifecycleDispose();
    assert.deepEqual(await lifecycleStop, {
        ok: true,
        status: 'stopped',
        take: { status: 'ready', frames: [], range: {} },
    });
    assert.deepEqual(await lifecycleDispose, {
        ok: true,
        status: 'stopped',
        take: { status: 'ready', frames: [], range: {} },
    });

    const recordingErrors = [];
    let failedRecorderDisposed = 0;
    const failedRecordingController = createMicrophonePitchController({
        createRecorder: () => ({
            enable: async () => ({ enabled: true }),
            getStream: () => recordingStream,
            startTake: () => {},
            finishTake: () => ({ status: 'ready', frames: [], range: {} }),
            dispose: async () => { failedRecorderDisposed += 1; },
        }),
        createDryRecording: () => ({
            start: () => ({ ok: false, error: 'media-recorder-unavailable' }),
            discard: async () => {},
        }),
        onRecordingError: (error) => recordingErrors.push(error),
    });
    assert.deepEqual(await failedRecordingController.handle({
        type: 'pitch_start',
        song: { videoId: 'dQw4w9WgXcQ' },
    }), { ok: false, error: 'media-recorder-unavailable' });
    assert.deepEqual(recordingErrors, ['media-recorder-unavailable']);
    assert.equal(failedRecorderDisposed, 1);
    assert.equal(failedRecordingController.isActive(), false);

    let recorderError;
    class ConstructorErrorMediaRecorder {
        static isTypeSupported() { return true; }
        constructor() { throw Object.assign(new Error('not supported'), { name: 'NotSupportedError' }); }
    }
    const constructorErrorDry = createDryRecordingController({
        MediaRecorderClass: ConstructorErrorMediaRecorder,
        onError: (error) => { recorderError = error; },
    });
    assert.deepEqual(constructorErrorDry.start(recordingStream, {}), { ok: false, error: 'NotSupportedError' });
    assert.equal(recorderError, 'NotSupportedError');

    let startErrorRecorder;
    class StartErrorMediaRecorder {
        static isTypeSupported() { return true; }
        constructor(input, options) {
            this.stream = input;
            this.mimeType = options.mimeType;
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            startErrorRecorder = this;
        }
        start() { throw Object.assign(new Error('start failed'), { name: 'InvalidStateError' }); }
    }
    const startErrorDry = createDryRecordingController({
        MediaRecorderClass: StartErrorMediaRecorder,
        onError: (error) => { recorderError = error; },
    });
    assert.deepEqual(startErrorDry.start(recordingStream, {}), { ok: false, error: 'InvalidStateError' });
    assert.equal(recorderError, 'InvalidStateError');
    assert.equal(startErrorRecorder.state, 'inactive');

    let eventRecorder;
    class EventErrorMediaRecorder {
        static isTypeSupported() { return true; }
        constructor(input, options) {
            this.stream = input;
            this.mimeType = options.mimeType;
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            eventRecorder = this;
        }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    const eventErrorDry = createDryRecordingController({
        MediaRecorderClass: EventErrorMediaRecorder,
        onError: (error) => { recorderError = error; },
    });
    assert.deepEqual(eventErrorDry.start(recordingStream, {}), { ok: true });
    eventRecorder.onerror?.({ error: { name: 'InvalidStateError' } });
    assert.equal(recorderError, 'InvalidStateError');

    console.log('test_karaoke_pitch_recorder: OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
