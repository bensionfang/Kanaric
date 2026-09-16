'use strict';

(function expose(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./pitch-analysis.js'));
    } else {
        root.KanaricPitchRecorder = factory(root.KanaricPitchAnalysis);
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRecorder(analysis) {
    const BUCKET_MS = 100;
    const SAMPLE_INTERVAL_MS = 50;
    const MIN_VOICED_FRAMES = 20;
    const MIC_REQUEST_TIMEOUT_MS = 10000;
    const RECORDING_MIME = 'audio/webm;codecs=opus';
    const FILE_NAME_UNSAFE = /[<>:"/\\|?*\x00-\x1F]/g;

    function recordingFileName(metadata = {}) {
        const artist = String(metadata.artist || metadata.channel || 'Unknown Artist').replace(FILE_NAME_UNSAFE, '_');
        const title = String(metadata.title || 'Untitled').replace(FILE_NAME_UNSAFE, '_');
        const key = Number.isSafeInteger(metadata.keySemitones) ? metadata.keySemitones : 0;
        const date = new Date(metadata.now == null ? Date.now() : metadata.now);
        const iso = Number.isNaN(date.getTime()) ? new Date() : date;
        const stamp = iso.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
        return `Kanaric-${artist}-${title}-key${key}-${stamp}.webm`.replace(FILE_NAME_UNSAFE, '_');
    }

    function createDryRecordingController({
        MediaRecorderClass = globalThis.MediaRecorder,
        BlobClass = globalThis.Blob,
        createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
        revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
        onError = () => {},
        download = (url, fileName) => {
            if (typeof document === 'undefined') return;
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
        },
    } = {}) {
        let recorder = null;
        let chunks = [];
        let stopPromise = null;
        let resolveStop = null;
        let discarding = false;
        let metadata = null;
        let errorReported = false;

        function errorCode(error, fallback = 'microphone-recording-failed') {
            const named = error?.name || error?.message;
            return typeof named === 'string' && named ? named : typeof error === 'string' && error ? error : fallback;
        }

        function reportError(error, fallback) {
            const code = errorCode(error, fallback);
            if (errorReported) return code;
            errorReported = true;
            try { onError(code); } catch {}
            return code;
        }

        function reset() {
            recorder = null;
            chunks = [];
            stopPromise = null;
            resolveStop = null;
            discarding = false;
            metadata = null;
        }

        function finish() {
            const result = !discarding && chunks.length && typeof BlobClass === 'function'
                ? { blob: new BlobClass(chunks, { type: recorder?.mimeType || 'audio/webm' }), fileName: recordingFileName(metadata) }
                : null;
            const resolve = resolveStop;
            reset();
            resolve?.(result);
        }

        function start(stream, nextMetadata = {}) {
            if (recorder || stopPromise) return { ok: false, error: 'recording-active' };
            errorReported = false;
            if (!stream || typeof stream.getTracks !== 'function') {
                return { ok: false, error: reportError('invalid-microphone-stream') };
            }
            if (typeof MediaRecorderClass !== 'function' || typeof BlobClass !== 'function') {
                return { ok: false, error: reportError('media-recorder-unavailable') };
            }
            const mimeType = typeof MediaRecorderClass.isTypeSupported === 'function'
                && MediaRecorderClass.isTypeSupported(RECORDING_MIME)
                ? RECORDING_MIME : 'audio/webm';
            try {
                recorder = new MediaRecorderClass(stream, { mimeType });
                metadata = { ...nextMetadata };
                chunks = [];
                discarding = false;
                recorder.ondataavailable = (event) => {
                    const size = event?.data?.size;
                    if (event?.data && (size == null || size > 0)) chunks.push(event.data);
                };
                recorder.onerror = (event) => {
                    reportError(event?.error || event?.target?.error, 'microphone-recording-failed');
                    discarding = true;
                    if (!stopPromise) {
                        stopPromise = new Promise((resolve) => { resolveStop = resolve; });
                    }
                    finish();
                };
                recorder.onstop = finish;
                recorder.start();
                return { ok: true };
            } catch (error) {
                const code = reportError(error, 'media-recorder-unavailable');
                reset();
                return { ok: false, error: code };
            }
        }

        function stop() {
            if (!recorder) return Promise.resolve(null);
            if (stopPromise) return stopPromise;
            const pending = new Promise((resolve) => { resolveStop = resolve; });
            stopPromise = pending;
            try {
                if (recorder.state === 'inactive') finish();
                else recorder.stop();
            } catch (error) {
                discarding = true;
                reportError(error);
                finish();
            }
            return pending;
        }

        function discard() {
            if (!recorder) {
                reset();
                return Promise.resolve();
            }
            discarding = true;
            chunks = [];
            if (stopPromise) return stopPromise.then(() => undefined);
            const pending = new Promise((resolve) => { resolveStop = resolve; });
            stopPromise = pending;
            try {
                if (recorder.state === 'inactive') finish();
                else recorder.stop();
            } catch {
                finish();
            }
            return pending.then(() => undefined);
        }

        function save(saved) {
            if (!saved?.blob || typeof createObjectURL !== 'function') return false;
            const url = createObjectURL(saved.blob);
            try {
                download(url, saved.fileName);
                return true;
            } finally {
                if (typeof revokeObjectURL === 'function') revokeObjectURL(url);
            }
        }

        return { start, stop, discard, download: save };
    }

    function createKaraokePitchRecorder({
        mediaDevices,
        AudioContext,
        getPlaybackState,
        onFrame,
        detectPitchFrame = analysis.detectPitchFrame,
        setInterval: schedule = globalThis.setInterval,
        clearInterval: cancel = globalThis.clearInterval,
        setTimeout: scheduleTimeout = globalThis.setTimeout,
        clearTimeout: cancelTimeout = globalThis.clearTimeout,
    } = {}) {
        let stream = null;
        let context = null;
        let source = null;
        let analyser = null;
        let samples = null;
        let intervalId = null;
        let enabled = false;
        let active = false;
        let manuallyPaused = false;
        let currentSong = null;
        let buckets = new Map();
        let mediaRequestSerial = 0;
        let lifecycleSerial = 0;
        let enablePromise = null;
        let cancelPendingEnable = null;
        let disposePromise = null;
        const ENABLE_CANCELLED = Symbol('microphone-disposed');

        function stopStream(nextStream) {
            for (const track of nextStream?.getTracks?.() || []) track.stop();
        }

        function sample() {
            if (!enabled || !active || manuallyPaused || !analyser || typeof getPlaybackState !== 'function') return;
            const playback = getPlaybackState() || {};
            if (playback.state !== 'playing') return;
            const positionMs = Number(playback.positionMs);
            if (!Number.isFinite(positionMs) || positionMs < 0) return;

            analyser.getFloatTimeDomainData(samples);
            const frame = detectPitchFrame(samples, context.sampleRate || 48000, positionMs);
            if (typeof onFrame === 'function') onFrame(frame);
            if (!frame || frame.voiced !== true || frame.octaveWarning === true
                || !Number.isFinite(Number(frame.midi)) || Number(frame.confidence) < analysis.MIN_CONFIDENCE) return;

            const bucketMs = Math.floor(positionMs / BUCKET_MS) * BUCKET_MS;
            const compact = [
                bucketMs,
                Math.round(Number(frame.midi) * 100),
                Math.round(Math.max(0, Math.min(1, Number(frame.confidence))) * 1000),
            ];
            const previous = buckets.get(bucketMs);
            if (!previous || compact[2] > previous[2]) buckets.set(bucketMs, compact);
        }

        async function enableInternal() {
            if (enabled) return { enabled: true };
            if (!mediaDevices?.getUserMedia || typeof AudioContext !== 'function') {
                return { enabled: false, error: 'microphone-unavailable' };
            }
            const currentLifecycle = ++lifecycleSerial;
            const requestSerial = ++mediaRequestSerial;
            let requestTimedOut = false;
            let timeoutId = null;
            let mediaRequest;
            let nextStream = null;
            let nextContext = null;
            let cancelEnable = null;
            const cancellation = new Promise((resolve) => { cancelEnable = () => resolve(ENABLE_CANCELLED); });
            cancelPendingEnable = cancelEnable;
            try {
                mediaRequest = Promise.resolve(mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                    video: false,
                }));
                mediaRequest.then((lateStream) => {
                    if (requestTimedOut || requestSerial !== mediaRequestSerial || currentLifecycle !== lifecycleSerial) stopStream(lateStream);
                }).catch(() => {});
                const timeout = new Promise((_, reject) => {
                    timeoutId = scheduleTimeout(() => {
                        requestTimedOut = true;
                        const error = new Error('microphone-request-timeout');
                        error.name = 'microphone-request-timeout';
                        reject(error);
                    }, MIC_REQUEST_TIMEOUT_MS);
                });
                nextStream = await Promise.race([mediaRequest, timeout, cancellation]);
                if (timeoutId !== null) cancelTimeout(timeoutId);
                if (nextStream === ENABLE_CANCELLED || currentLifecycle !== lifecycleSerial) {
                    stopStream(nextStream === ENABLE_CANCELLED ? null : nextStream);
                    return { enabled: false, error: 'microphone-disposed' };
                }
                nextContext = new AudioContext();
                const nextSource = nextContext.createMediaStreamSource(nextStream);
                const nextAnalyser = nextContext.createAnalyser();
                nextAnalyser.fftSize = 2048;
                nextSource.connect(nextAnalyser);
                const nextSamples = new Float32Array(nextAnalyser.fftSize);
                if (currentLifecycle !== lifecycleSerial) {
                    stopStream(nextStream);
                    await Promise.resolve(nextContext.close?.()).catch(() => {});
                    return { enabled: false, error: 'microphone-disposed' };
                }
                stream = nextStream;
                context = nextContext;
                source = nextSource;
                analyser = nextAnalyser;
                samples = nextSamples;
                enabled = true;
                intervalId = typeof schedule === 'function'
                    ? schedule(sample, SAMPLE_INTERVAL_MS)
                    : null;
                return { enabled: true };
            } catch (error) {
                if (timeoutId !== null) cancelTimeout(timeoutId);
                stopStream(nextStream === ENABLE_CANCELLED ? null : nextStream);
                await Promise.resolve(nextContext?.close?.()).catch(() => {});
                return { enabled: false, error: error?.name || error?.message || 'microphone-denied' };
            } finally {
                if (cancelPendingEnable === cancelEnable) cancelPendingEnable = null;
            }
        }

        function enable() {
            if (enabled) return Promise.resolve({ enabled: true });
            if (enablePromise) return enablePromise;
            const pending = enableInternal();
            const guarded = pending.finally(() => {
                if (enablePromise === guarded) enablePromise = null;
            });
            enablePromise = guarded;
            return guarded;
        }

        function startTake(song) {
            currentSong = song ? { ...song } : null;
            buckets = new Map();
            manuallyPaused = false;
            active = enabled;
            return active;
        }

        function pause() { manuallyPaused = true; }
        function resume() { manuallyPaused = false; }

        function finishTake() {
            const frames = [...buckets.values()].sort((left, right) => left[0] - right[0]);
            const range = analysis.summarizeRange(frames.map(([timeMs, midiTimes100, confidenceTimes1000]) => ({
                timeMs,
                midi: midiTimes100 / 100,
                confidence: confidenceTimes1000 / 1000,
                voiced: true,
                octaveWarning: false,
            })));
            active = false;
            return {
                status: frames.length < MIN_VOICED_FRAMES ? 'insufficient-data' : 'ready',
                song: currentSong,
                frames,
                range,
            };
        }

        function dispose() {
            if (disposePromise) return disposePromise;
            lifecycleSerial += 1;
            mediaRequestSerial += 1;
            cancelPendingEnable?.();
            const pendingEnable = enablePromise;
            const currentStream = stream;
            const currentContext = context;
            active = false;
            stream = null;
            context = null;
            source = null;
            analyser = null;
            samples = null;
            enabled = false;
            if (intervalId !== null && typeof cancel === 'function') cancel(intervalId);
            intervalId = null;
            stopStream(currentStream);
            buckets = new Map();
            const operation = (async () => {
                await Promise.resolve(currentContext?.close?.()).catch(() => {});
                await Promise.resolve(pendingEnable).catch(() => {});
            })();
            const guarded = operation.finally(() => {
                if (disposePromise === guarded) disposePromise = null;
            });
            disposePromise = guarded;
            return guarded;
        }

        return { enable, startTake, pause, resume, finishTake, dispose, getStream: () => stream };
    }

    function normalizePitchPlayback(message) {
        const state = message?.state && typeof message.state === 'object' ? message.state : message;
        if (!state || typeof state !== 'object' || !/^[A-Za-z0-9_-]{11}$/.test(state.videoId || '')
            || !Number.isSafeInteger(state.revision) || state.revision < 0
            || !['playing', 'paused', 'buffering', 'ad', 'seeking', 'error', 'ended', 'idle', 'loading'].includes(state.state)
            || !Number.isSafeInteger(state.positionMs) || state.positionMs < 0
            || !Number.isSafeInteger(state.durationMs) || state.durationMs < 0) return null;
        return {
            videoId: state.videoId,
            revision: state.revision,
            state: state.state,
            positionMs: state.positionMs,
            durationMs: state.durationMs,
        };
    }

    function normalizePitchFrame(frame) {
        if (!frame || typeof frame !== 'object' || !Number.isSafeInteger(frame.timeMs) || frame.timeMs < 0
            || ![frame.hz, frame.midi, frame.cents].every((value) => value == null || Number.isFinite(Number(value)))
            || !Number.isFinite(Number(frame.confidence)) || Number(frame.confidence) < 0 || Number(frame.confidence) > 1
            || typeof frame.voiced !== 'boolean' || typeof frame.octaveWarning !== 'boolean') return null;
        return {
            timeMs: frame.timeMs,
            hz: frame.hz == null ? null : Number(frame.hz),
            midi: frame.midi == null ? null : Number(frame.midi),
            cents: frame.cents == null ? null : Number(frame.cents),
            confidence: Number(frame.confidence),
            voiced: frame.voiced,
            octaveWarning: frame.octaveWarning,
        };
    }

    function createMicrophonePitchController({
        createRecorder: makeRecorder = (options) => createKaraokePitchRecorder({
            mediaDevices: globalThis.navigator?.mediaDevices,
            AudioContext: globalThis.AudioContext || globalThis.webkitAudioContext,
            ...options,
        }),
        sendFrame = () => {},
        createDryRecording: makeDryRecording = null,
        onRecordingReady = () => {},
        onRecordingError = () => {},
    } = {}) {
        let recorder = null;
        let dryRecording = null;
        let playback = null;
        let previousPlayback = null;
        let active = false;
        let startPromise = null;
        let lifecyclePromise = null;

        function updatePlayback(message) {
            const next = normalizePitchPlayback(message);
            if (!next) return false;
            const seeking = previousPlayback && previousPlayback.videoId === next.videoId
                && previousPlayback.state === 'playing' && next.state === 'playing'
                && Math.abs(next.positionMs - previousPlayback.positionMs) > 700;
            playback = seeking ? { ...next, state: 'seeking' } : next;
            previousPlayback = next;
            return true;
        }

        function recordingErrorCode(error, fallback = 'microphone-recording-failed') {
            const named = error?.name || error?.message;
            return typeof named === 'string' && named ? named : typeof error === 'string' && error ? error : fallback;
        }

        function reportRecordingError(error, fallback) {
            const code = recordingErrorCode(error, fallback);
            try { onRecordingError(code); } catch {}
            return code;
        }

        async function startInternal(message) {
            if (!message?.song?.videoId || !/^[A-Za-z0-9_-]{11}$/.test(message.song.videoId)) {
                return { ok: false, error: 'invalid-video' };
            }
            let currentRecorder = null;
            try {
                currentRecorder = makeRecorder({
                    getPlaybackState: () => playback,
                    onFrame: (rawFrame) => {
                        const frame = normalizePitchFrame(rawFrame);
                        if (frame && playback?.videoId) sendFrame({ videoId: playback.videoId, frame });
                    },
                });
                recorder = currentRecorder;
                const result = await currentRecorder.enable();
                if (!result?.enabled) {
                    await Promise.resolve(currentRecorder.dispose?.()).catch(() => {});
                    if (recorder === currentRecorder) recorder = null;
                    return { ok: false, error: result?.error || 'microphone-denied' };
                }
                currentRecorder.startTake(message.song);
                if (typeof makeDryRecording === 'function') {
                    let candidate = null;
                    let candidateErrorReported = false;
                    const reportCandidateError = (error) => {
                        if (candidateErrorReported) return recordingErrorCode(error);
                        candidateErrorReported = true;
                        return reportRecordingError(error);
                    };
                    try {
                        candidate = makeDryRecording({ onError: reportCandidateError });
                        const recording = candidate?.start?.(currentRecorder.getStream?.(), message.song);
                        if (recording?.ok) dryRecording = candidate;
                        else {
                            const code = reportCandidateError(recording?.error || 'media-recorder-unavailable');
                            await Promise.resolve(candidate?.discard?.()).catch(() => {});
                            await Promise.resolve(currentRecorder.dispose?.()).catch(() => {});
                            if (recorder === currentRecorder) recorder = null;
                            return { ok: false, error: code };
                        }
                    } catch (error) {
                        const code = reportCandidateError(error);
                        await Promise.resolve(candidate?.discard?.()).catch(() => {});
                        await Promise.resolve(currentRecorder.dispose?.()).catch(() => {});
                        if (recorder === currentRecorder) recorder = null;
                        return { ok: false, error: code };
                    }
                }
                active = true;
                return { ok: true, status: 'enabled' };
            } catch (error) {
                await Promise.resolve(currentRecorder?.dispose?.()).catch(() => {});
                if (recorder === currentRecorder) recorder = null;
                return { ok: false, error: recordingErrorCode(error, 'microphone-denied') };
            }
        }

        function start(message) {
            if (lifecyclePromise) return lifecyclePromise.then(() => start(message));
            if (active) return Promise.resolve({ ok: true, status: 'enabled' });
            if (startPromise) return startPromise;
            const pending = startInternal(message);
            startPromise = pending;
            pending.finally(() => {
                if (startPromise === pending) startPromise = null;
            }).catch(() => {});
            return pending;
        }

        async function stopInternal() {
            const currentRecorder = recorder;
            const recordingController = dryRecording;
            recorder = null;
            dryRecording = null;
            active = false;
            if (!currentRecorder) {
                await Promise.resolve(recordingController?.discard?.()).catch(() => {});
                return { ok: true, status: 'stopped', take: null };
            }
            let take = null;
            let failure = null;
            try {
                take = currentRecorder.finishTake();
            } catch (error) {
                failure = reportRecordingError(error);
            }
            let recording = null;
            try {
                recording = recordingController ? await recordingController.stop() : null;
            } catch (error) {
                failure = failure || reportRecordingError(error);
            }
            if (recording) {
                try { onRecordingReady({ recording, controller: recordingController }); } catch {}
            }
            try {
                await currentRecorder.dispose();
            } catch (error) {
                failure = failure || reportRecordingError(error);
            }
            if (failure) return { ok: false, status: 'stopped', error: failure, take };
            return { ok: true, status: 'stopped', take, ...(recording ? { recording } : {}) };
        }

        async function disposeInternal() {
            const currentRecorder = recorder;
            const recordingController = dryRecording;
            recorder = null;
            dryRecording = null;
            active = false;
            let take = null;
            let failure = null;
            if (currentRecorder) {
                try { take = currentRecorder.finishTake(); } catch (error) { failure = reportRecordingError(error); }
            }
            await Promise.resolve(recordingController?.discard?.()).catch(() => {});
            if (currentRecorder) {
                try { await currentRecorder.dispose(); } catch (error) { failure = failure || reportRecordingError(error); }
            }
            if (failure) return { ok: false, status: 'stopped', error: failure, take };
            return { ok: true, status: 'stopped', take };
        }

        function beginLifecycle(kind) {
            if (lifecyclePromise) return lifecyclePromise;
            const pendingStart = startPromise;
            active = false;
            const pending = (pendingStart ? pendingStart.catch(() => {}) : Promise.resolve())
                .then(() => kind === 'dispose' ? disposeInternal() : stopInternal());
            lifecyclePromise = pending;
            pending.finally(() => {
                if (lifecyclePromise === pending) lifecyclePromise = null;
            }).catch(() => {});
            return pending;
        }

        const stop = () => beginLifecycle('stop');
        const dispose = () => beginLifecycle('dispose');

        return {
            handle(message) {
                if (message?.type === 'pitch_playback') return updatePlayback(message);
                if (message?.type === 'pitch_start') return start(message);
                if (message?.type === 'pitch_stop') return stop();
                if (message?.type === 'pitch_dispose') return dispose();
                return { ok: false, error: 'unsupported-message' };
            },
            isActive: () => active,
            getPlayback: () => playback,
        };
    }

    return {
        createKaraokePitchRecorder,
        createDryRecordingController,
        createMicrophonePitchController,
        normalizePitchPlayback,
        normalizePitchFrame,
    };
}));
