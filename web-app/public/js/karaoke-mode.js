/*
 * YouTube 卡拉OK App controller (/karaoke) 的頁面邏輯。
 *
 * YouTube 頁面是唯一的播放與歌詞 stage；這裡只維護選曲、佇列、控制命令、
 * lyric payload relay 與本機音高紀錄。控制列是自己一條 (#karaoke-bar),不是 footer 的播放列。
 * 播放列是播放器版面
 *    (封面/歌名/隨機/循環/上一首/進度條),唱歌時一項都用不到;這一頁要的是點歌機遙控器:
 *    重唱、切歌、字幕早晚。播放列整條 display:none —— 舊版不敢這樣做是因為備選歌詞浮層
 *    position:absolute 錨在它裡面那顆按鈕上,解法是把整塊 .lyrics-opt-wrap 搬進
 *    #kbar-tools (錨點跟著搬,浮層的 CSS 一個字都不用改)。
 */
// **一定要等 DOMContentLoaded**:這一頁的 <script> 排在 include('footer') 之前,而
// window.onMediaMessage (WebSocket 的 handler 註冊點) 與備選歌詞那塊都在 footer 裡,
// 立即執行的話是 `onMediaMessage is not a function`,整支腳本死掉、頁面空白。
// app.js 也是同樣的理由把初始化放在 DOMContentLoaded 裡。
const KARAOKE_PITCH_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const KARAOKE_PITCH_STATUSES = new Set(['enabled', 'stopped', 'error']);
const KARAOKE_PITCH_MAX_TIME_MS = 86400000;

function createKaraokePitchRelayStatus(videoId, revision, status, error = null) {
    if (!KARAOKE_PITCH_VIDEO_ID_RE.test(videoId || '')
        || !Number.isSafeInteger(revision) || revision < 1
        || !KARAOKE_PITCH_STATUSES.has(status)) return null;
    let normalizedError = null;
    if (error !== null && error !== undefined) {
        const code = typeof error === 'string' ? error : error?.code;
        const message = typeof error === 'string' ? error : error?.message;
        if (typeof error === 'object' && (Array.isArray(error) || Object.keys(error).length !== 2
            || Object.keys(error).some((key) => !['code', 'message'].includes(key)))) return null;
        if (typeof code !== 'string' || !code || code.length > 100
            || typeof message !== 'string' || !message || message.length > 500) return null;
        normalizedError = { code, message };
    }
    if (status === 'error' ? !normalizedError : normalizedError) return null;
    return { type: 'youtube_karaoke_pitch_status', videoId, revision, status, error: normalizedError };
}

function createKaraokePitchRelayFrame(videoId, revision, frame) {
    if (!KARAOKE_PITCH_VIDEO_ID_RE.test(videoId || '')
        || !Number.isSafeInteger(revision) || revision < 1
        || !frame || typeof frame !== 'object' || Array.isArray(frame)
        || Object.keys(frame).length !== 7
        || Object.keys(frame).some((key) => !['timeMs', 'hz', 'midi', 'cents', 'confidence', 'voiced', 'octaveWarning'].includes(key))
        || !Number.isSafeInteger(frame.timeMs) || frame.timeMs < 0 || frame.timeMs > KARAOKE_PITCH_MAX_TIME_MS
        || ![frame.hz, frame.midi, frame.cents].every((value) => value === null || typeof value === 'number' && Number.isFinite(value))
        || (frame.hz !== null && (frame.hz < 0 || frame.hz > 5000))
        || (frame.midi !== null && (frame.midi < 0 || frame.midi > 200))
        || (frame.cents !== null && (frame.cents < -1200 || frame.cents > 1200))
        || typeof frame.confidence !== 'number' || !Number.isFinite(frame.confidence)
        || frame.confidence < 0 || frame.confidence > 1
        || typeof frame.voiced !== 'boolean' || typeof frame.octaveWarning !== 'boolean') return null;
    return {
        type: 'youtube_karaoke_pitch_frame',
        videoId,
        revision,
        frame: {
            timeMs: frame.timeMs,
            hz: frame.hz,
            midi: frame.midi,
            cents: frame.cents,
            confidence: frame.confidence,
            voiced: frame.voiced,
            octaveWarning: frame.octaveWarning,
        },
    };
}

function createKaraokePitchLifecycle({
    createRecorder,
    createDryRecording = null,
    getCurrentSong = () => null,
    isStarted = () => true,
    finishTake = null,
    onRecordingReady = () => {},
    onRecordingError = () => {},
    onStateChange = () => {},
} = {}) {
    let recorder = null;
    let dryRecording = null;
    let pendingRecording = null;
    let active = false;
    let lifecyclePromise = Promise.resolve();
    let startPromise = null;
    let stopPromise = null;
    let generation = 0;

    function notifyState() {
        try {
            onStateChange({
                enabled: active,
                recorder,
                dryRecording,
                pendingRecording,
            });
        } catch {}
    }

    function enqueue(task) {
        const next = lifecyclePromise.then(task, task);
        lifecyclePromise = next.catch(() => {});
        return next;
    }

    function errorCode(error, fallback = 'microphone-recording-failed') {
        const named = error?.name || error?.message;
        return typeof named === 'string' && named ? named : typeof error === 'string' && error ? error : fallback;
    }

    async function disposeRecorder(currentRecorder) {
        await Promise.resolve(currentRecorder?.dispose?.()).catch(() => {});
    }

    async function startInternal(item, requestGeneration) {
        if (requestGeneration !== generation) return { ok: false, error: 'cancelled' };
        if (pendingRecording) return { ok: false, error: 'pending-recording' };
        if (!isStarted() || !item) return { ok: false, error: 'song-required' };
        let currentRecorder = null;
        try {
            currentRecorder = typeof createRecorder === 'function' ? createRecorder() : null;
            if (!currentRecorder) return { ok: false, error: 'microphone-unavailable' };
            recorder = currentRecorder;
            notifyState();
            const result = await currentRecorder.enable();
            const currentSong = getCurrentSong?.() || item;
            if (requestGeneration !== generation || recorder !== currentRecorder
                || !isStarted() || currentSong?.videoId !== item?.videoId) {
                await disposeRecorder(currentRecorder);
                if (recorder === currentRecorder) {
                    recorder = null;
                    notifyState();
                }
                return { ok: false, error: 'cancelled' };
            }
            if (!result?.enabled) {
                await disposeRecorder(currentRecorder);
                if (recorder === currentRecorder) {
                    recorder = null;
                    notifyState();
                }
                return { ok: false, error: result?.error || 'microphone-denied' };
            }
            currentRecorder.startTake(item);
            if (typeof createDryRecording === 'function') {
                let candidate = null;
                try {
                    candidate = createDryRecording({
                        onError: (error) => {
                            try { onRecordingError(errorCode(error)); } catch {}
                        },
                    });
                    const recording = candidate?.start?.(currentRecorder.getStream?.(), item);
                    if (recording?.ok) dryRecording = candidate;
                    else {
                        try { onRecordingError(recording?.error || 'media-recorder-unavailable'); } catch {}
                        await Promise.resolve(candidate?.discard?.()).catch(() => {});
                    }
                } catch (error) {
                    try { onRecordingError(errorCode(error)); } catch {}
                    await Promise.resolve(candidate?.discard?.()).catch(() => {});
                }
            }
            active = true;
            notifyState();
            return { ok: true, status: 'enabled' };
        } catch (error) {
            await disposeRecorder(currentRecorder);
            if (recorder === currentRecorder) {
                recorder = null;
                notifyState();
            }
            return { ok: false, error: errorCode(error, 'microphone-denied') };
        }
    }

    function start(item = getCurrentSong?.()) {
        if (active) return stop();
        if (startPromise) return startPromise;
        const requestGeneration = ++generation;
        const pending = enqueue(() => startInternal(item, requestGeneration));
        const guarded = pending.finally(() => {
            if (startPromise === guarded) startPromise = null;
        });
        startPromise = guarded;
        return guarded;
    }

    function stop({ discardRecording = false } = {}) {
        const requestGeneration = ++generation;
        if (stopPromise) return stopPromise;
        const currentAtRequest = recorder;
        const cancelPendingEnable = !active && currentAtRequest
            ? disposeRecorder(currentAtRequest)
            : Promise.resolve();
        const pending = enqueue(async () => {
            await cancelPendingEnable;
            const currentRecorder = recorder;
            const recordingController = dryRecording;
            let take = null;
            let saved = null;
            let failure = null;
            if (active && currentRecorder && typeof finishTake === 'function') {
                try { take = finishTake(currentRecorder); } catch (error) { failure = errorCode(error, 'pitch-finish-failed'); }
            }
            try {
                if (recordingController) {
                    if (discardRecording) await recordingController.discard?.();
                    else saved = await recordingController.stop?.();
                }
            } catch (error) {
                failure = failure || errorCode(error, 'recording-stop-failed');
            }
            await disposeRecorder(currentRecorder);
            if (saved && !discardRecording) {
                if (!pendingRecording) {
                    pendingRecording = { recording: saved, controller: recordingController };
                    try { onRecordingReady(pendingRecording); } catch {}
                } else {
                    await Promise.resolve(recordingController?.discard?.()).catch(() => {});
                }
            }
            recorder = null;
            dryRecording = null;
            active = false;
            notifyState();
            const result = { ok: !failure, status: 'stopped', take };
            if (failure) result.error = failure;
            if (saved && !discardRecording && !failure) result.recording = saved;
            return result;
        });
        const guarded = pending.finally(() => {
            if (stopPromise === guarded) stopPromise = null;
        });
        stopPromise = guarded;
        void requestGeneration;
        return guarded;
    }

    function savePending() {
        const pending = pendingRecording;
        if (!pending) return false;
        try {
            if (pending.controller?.download?.(pending.recording) === false) return false;
            pendingRecording = null;
            notifyState();
            return true;
        } catch {
            return false;
        }
    }

    async function discardPending() {
        const pending = pendingRecording;
        if (!pending) return true;
        pendingRecording = null;
        try {
            await pending.controller?.discard?.();
            notifyState();
            return true;
        } catch {
            pendingRecording = pending;
            notifyState();
            return false;
        }
    }

    return {
        start,
        stop,
        savePending,
        discardPending,
        pause: () => recorder?.pause?.(),
        resume: () => recorder?.resume?.(),
        setCurrentSong(item) {
            if (!active || !recorder) return false;
            recorder.startTake?.(item);
            return true;
        },
        isEnabled: () => active,
        getRecorder: () => recorder,
        getDryRecording: () => dryRecording,
        getPendingRecording: () => pendingRecording,
    };
}

function createKaraokeCompactStartGate({
    bridge,
    schedule = setTimeout,
    cancel = clearTimeout,
    getSettings = () => ({}),
    onStarted = () => {},
    onError = () => {},
} = {}) {
    let pendingVideoId = null;
    let activeVideoId = null;
    let timer = null;
    let generation = 0;

    function settings() {
        let value = {};
        try { value = getSettings?.() || {}; } catch {}
        return { compact: value.compact !== false, top: value.top !== false };
    }

    function clear() {
        if (timer !== null) cancel(timer);
        timer = null;
        pendingVideoId = null;
    }

    function invalidate() {
        generation += 1;
        clear();
        activeVideoId = null;
    }

    function launch(bounds = null) {
        if (!pendingVideoId || typeof bridge?.startCollapsed !== 'function' || !settings().compact) return;
        const requestGeneration = generation;
        const videoId = pendingVideoId;
        activeVideoId = videoId;
        clear();
        const options = { compact: true, top: settings().top };
        if (bounds) options.ownerWindowBounds = bounds;
        Promise.resolve(bridge.startCollapsed?.(options)).then((result) => {
            if (requestGeneration !== generation || activeVideoId !== videoId) return;
            if (result?.ok === false) {
                activeVideoId = null;
                void bridge.finish?.();
                onError(result.error);
            }
            else onStarted(result);
        }).catch(() => {
            if (requestGeneration !== generation || activeVideoId !== videoId) return;
            activeVideoId = null;
            void bridge.finish?.();
            onError('window-start-failed');
        });
    }

    return {
        arm(videoId) {
            invalidate();
            if (!bridge || typeof bridge.startCollapsed !== 'function' || !videoId || !settings().compact) return;
            pendingVideoId = videoId;
        },
        onState(state) {
            if (state?.videoId === activeVideoId && state.state === 'error') {
                invalidate();
                void bridge?.finish?.();
                return;
            }
            if (!pendingVideoId || state?.videoId !== pendingVideoId
                || !Number.isSafeInteger(state.revision) || state.revision < 0) return;
            if (state.state === 'error') { invalidate(); return; }
            if (!hasOwnerWindowBounds(state.ownerWindowBounds)) return;
            launch(state.ownerWindowBounds);
        },
        finish() {
            invalidate();
            return bridge?.finish?.();
        },
    };
}

function hasOwnerWindowBounds(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 4
        && Object.keys(value).every((key) => ['x', 'y', 'width', 'height'].includes(key))
        && [value.x, value.y, value.width, value.height].every(Number.isSafeInteger)
        && value.width >= 1 && value.width <= 32768
        && value.height >= 1 && value.height <= 32768;
}

function createKaraokeWindowBlocker({ onBlocked = () => {}, onClear = () => {} } = {}) {
    const reasons = new Set();

    function set(blocked, reason = 'error') {
        const wasBlocked = reasons.size > 0;
        if (blocked) {
            reasons.add(reason);
            try { onBlocked(reasons); } catch {}
            return true;
        }
        if (reason) reasons.delete(reason);
        else reasons.clear();
        if (wasBlocked && !reasons.size) {
            try { onClear(); } catch {}
        }
        return reasons.size > 0;
    }

    return {
        set,
        clear: () => set(false, ''),
        isBlocked: () => reasons.size > 0,
        reasons: () => new Set(reasons),
    };
}

function createKaraokeCollapseController({
    bridge,
    getState = () => ({}),
    schedule = setTimeout,
    cancel = clearTimeout,
    onCollapsed = () => {},
    onExpanded = () => {},
    onError = () => {},
} = {}) {
    let timer = null;
    let collapsed = false;
    let pendingCollapse = null;
    let pendingExpand = null;

    function state() {
        try { return getState?.() || {}; } catch { return { blockingError: true }; }
    }

    function clear() {
        if (timer !== null) {
            try { cancel(timer); } catch {}
            timer = null;
        }
    }

    function reportError(error, fallback) {
        try { onError(error || fallback); } catch {}
    }

    function invoke(method, fallback, onSuccess, onFailure) {
        let result;
        try {
            result = typeof bridge?.[method] === 'function' ? bridge[method]() : { ok: false, error: fallback };
        } catch (error) {
            return onFailure(error?.message || fallback);
        }
        const settle = (value) => {
            if (value?.ok === false) return onFailure(value.error || fallback, value);
            try { onSuccess(value); } catch {}
            return value || { ok: true };
        };
        if (result && typeof result.then === 'function') {
            return result.then(settle).catch((error) => onFailure(error?.message || fallback));
        }
        return settle(result);
    }

    function expand(force = false) {
        clear();
        if (pendingExpand) return pendingExpand.result;
        if (pendingCollapse) {
            pendingCollapse = null;
            force = true;
        }
        if (!force && !collapsed) return { ok: true };
        const operation = { result: null };
        pendingExpand = operation;
        const result = invoke('expand', 'window-expand-failed', (value) => {
            if (pendingExpand !== operation) return;
            pendingExpand = null;
            collapsed = false;
            try { onExpanded(value); } catch {}
        }, (error) => {
            if (pendingExpand !== operation) return { ok: false, error: error || 'window-expand-failed' };
            pendingExpand = null;
            reportError(error, 'window-expand-failed');
            return { ok: false, error: error || 'window-expand-failed' };
        });
        operation.result = result;
        return result;
    }

    function canCollapse() {
        const current = state();
        return Boolean(
            bridge?.collapse
            && !collapsed
            && current.started !== false
            && current.nativeStarted !== false
            && current.compact !== false
            && current.autoCollapse !== false
            && !pendingExpand
            && current.pinned !== true
            && current.interacting !== true
            && current.focused !== true
            && current.blockingError !== true
            && current.error !== true,
        );
    }

    function collapse() {
        if (pendingCollapse) return pendingCollapse.result;
        if (!canCollapse()) return { ok: false, error: 'collapse-suppressed' };
        const operation = { result: null };
        pendingCollapse = operation;
        const result = invoke('collapse', 'window-collapse-failed', (value) => {
            if (pendingCollapse !== operation) return;
            pendingCollapse = null;
            collapsed = true;
            try { onCollapsed(value); } catch {}
        }, (error) => {
            if (pendingCollapse !== operation) return { ok: false, error: error || 'window-collapse-failed' };
            pendingCollapse = null;
            reportError(error, 'window-collapse-failed');
            // A failed native collapse must leave the renderer in the expanded state.
            return expand(true);
        });
        operation.result = result;
        return result;
    }

    function arm() {
        clear();
        if (!canCollapse()) return false;
        try { timer = schedule(() => { timer = null; return collapse(); }, 3000); }
        catch (error) { reportError(error?.message, 'collapse-timer-failed'); return false; }
        return true;
    }

    function block() {
        clear();
        return collapsed || pendingCollapse ? expand(true) : { ok: true };
    }

    function finish() {
        clear();
        pendingCollapse = null;
        pendingExpand = null;
        if (collapsed) {
            collapsed = false;
            try { onExpanded(); } catch {}
        }
        return { ok: true };
    }

    function markCollapsed() {
        clear();
        pendingCollapse = null;
        pendingExpand = null;
        if (!collapsed) {
            collapsed = true;
            try { onCollapsed(); } catch {}
        }
        return { ok: true };
    }

    return {
        arm,
        clear,
        collapse,
        expand,
        block,
        finish,
        markCollapsed,
        isCollapsed: () => collapsed,
    };
}

const YOUTUBE_LYRICS_PREFETCH_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const KARAOKE_ACTIVE_STICKY_KEY = 'karaoke-active';

function youtubeLyricsPrefetchIdentity(item) {
    if (!item || !YOUTUBE_LYRICS_PREFETCH_VIDEO_ID_RE.test(item.videoId || '')) return null;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const channel = typeof item.channel === 'string' ? item.channel.trim() : '';
    if (!title || title.length > 200 || !channel || channel.length > 200) return null;
    return `${item.videoId}\u0000${title}\u0000${channel}`;
}

function youtubeLyricsStatusLabel(status) {
    return {
        searching: '搜尋歌詞中',
        loaded: '歌詞已載入',
        no_lyrics: '找不到歌詞',
        error: '歌詞查詢失敗',
    }[status] || '等待歌詞';
}

function createYouTubeLyricsPrefetchController({
    send = () => {},
    onState = () => {},
} = {}) {
    const jobs = new Map();
    const rows = new Map();

    function emit(row, job) {
        try {
            const state = { queueId: row.queueId, identity: job.identity, videoId: job.videoId, status: job.status };
            if (job.error) state.error = { code: job.error.code };
            onState(state);
        } catch {}
    }

    function prefetch(item) {
        const identity = youtubeLyricsPrefetchIdentity(item);
        if (!identity || !item.queueId) return false;
        const row = { queueId: String(item.queueId), identity };
        const previousRow = rows.get(row.queueId);
        if (previousRow?.identity !== identity) rows.delete(row.queueId);
        rows.set(row.queueId, row);
        let job = jobs.get(identity);
        if (job) {
            emit(row, job);
            return false;
        }
        job = {
            identity,
            videoId: item.videoId,
            title: item.title.trim(),
            channel: item.channel.trim(),
            status: 'searching',
            error: null,
        };
        jobs.set(identity, job);
        emit(row, job);
        try {
            send({
                type: 'youtube_karaoke_lyrics_prefetch',
                videoId: job.videoId,
                title: job.title,
                channel: job.channel,
            });
        } catch {}
        return true;
    }

    function remove(queueId) {
        return rows.delete(String(queueId));
    }

    function receiveStatus(message) {
        if (!message || !['youtube_karaoke_lyrics_prefetch_status', 'youtube_karaoke_lyrics_status'].includes(message.type)
            || !YOUTUBE_LYRICS_PREFETCH_VIDEO_ID_RE.test(message.videoId || '')
            || !['searching', 'loaded', 'no_lyrics', 'error'].includes(message.status)) return false;
        const candidates = Array.from(jobs.values()).filter((job) => job.videoId === message.videoId);
        if (!candidates.length) return false;
        const errorCode = typeof message.error?.code === 'string'
            && /^[A-Za-z0-9._-]{1,100}$/.test(message.error.code) ? message.error.code : null;
        for (const job of candidates) {
            job.status = message.status;
            job.error = message.status === 'error' && errorCode ? { code: errorCode } : null;
            for (const row of rows.values()) if (row.identity === job.identity) emit(row, job);
        }
        return true;
    }

    return {
        prefetch,
        remove,
        receiveStatus,
        status(item) {
            const identity = youtubeLyricsPrefetchIdentity(item);
            return identity ? jobs.get(identity)?.status || null : null;
        },
    };
}

if (typeof module === 'object' && module.exports) module.exports = {
    createKaraokePitchLifecycle,
    createKaraokePitchRelayStatus,
    createKaraokePitchRelayFrame,
    createKaraokeCompactStartGate,
    createKaraokeWindowBlocker,
    createKaraokeCollapseController,
    createYouTubeLyricsPrefetchController,
    youtubeLyricsPrefetchIdentity,
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', function () {
    const stage = document.getElementById('karaoke-stage');
    if (!stage) return;

    // App 只負責要求 server 的 canonical producer 重新載入；歌詞 payload 與填色都在 owner tab。
    let canonicalRefreshPending = false;

    // ── YouTube Karaoke 狀態 ──
    const youtube = window.youtubeKaraoke;
    const queue = window.createYouTubeKaraokeQueue();
    let playing = false;
    let extensionState = { state: 'idle', videoId: '', positionMs: 0, durationMs: 0, keySemitones: 0, revision: 0 };
    let commandId = 0;
    let searchResults = [];
    let selectedResult = null;
    let searchGeneration = 0;
    let currentItem = null;
    let warnedCandidateVideoId = '';
    let pendingCandidate = null;
    let syncOffset = 0;
    let title = '';
    let artist = '';
    const lyricStates = new Map();
    const lyricPrefetch = createYouTubeLyricsPrefetchController({
        send: (message) => window.sendMediaSocket(message),
        onState: (state) => {
            lyricStates.set(state.queueId, state);
            renderQueue();
        },
    });

    function requestCanonicalLyrics(force = false) {
        if (!currentItem || extensionState.videoId !== currentItem.videoId
            || !Number.isSafeInteger(extensionState.revision) || !title || !artist) {
            canonicalRefreshPending = true;
            return false;
        }
        canonicalRefreshPending = false;
        const request = {
            type: 'youtube_karaoke_search',
            videoId: extensionState.videoId,
            title,
            channel: artist,
            revision: extensionState.revision,
            force: force === true,
        };
        window.sendMediaSocket(request);
        return true;
    }

    function prefetchQueuedLyrics(item) {
        lyricPrefetch.prefetch(item);
    }

    window.karaokeReloadLyrics = function () {
        if (!currentItem) {
            if (typeof noSongToast === 'function') noSongToast();
            return false;
        }
        if (typeof showToast === 'function') showToast(`重新載入: ${currentItem.title}`, 'fa-solid fa-rotate', 2000);
        canonicalRefreshPending = true;
        return requestCanonicalLyrics(true);
    };

    // ── 本機音高紀錄 (只在使用者按鈕後啟用) ──
    const pitchCanvas = document.getElementById('karaoke-pitch-canvas');
    const pitchContext = pitchCanvas?.getContext?.('2d') || null;
    const pitchNoteEl = document.getElementById('karaoke-pitch-note');
    const pitchConfidenceEl = document.getElementById('karaoke-pitch-confidence');
    const pitchStatusEl = document.getElementById('karaoke-pitch-status');
    const pitchEnableEl = document.getElementById('karaoke-pitch-enable');
    const pitchRecordingEl = document.getElementById('karaoke-pitch-recording');
    const pitchRecordingStatusEl = document.getElementById('karaoke-pitch-recording-status');
    const pitchRecordingSaveEl = document.getElementById('karaoke-pitch-recording-save');
    const pitchRecordingDiscardEl = document.getElementById('karaoke-pitch-recording-discard');
    const pitchNotes = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    let pitchRecorder = null;
    let dryRecording = null;
    let pendingRecording = null;
    let pitchLifecycle = null;
    let pitchStopPromise = null;
    let pitchEnabled = false;
    let pitchFrames = [];
    let lastPitchFrame = null;
    let pitchTakeFinished = false;
    const pitchHistory = window.KanaricPitchHistory?.createKaraokePitchHistory();
    let pitchRelayIdentity = null;

    function currentPitchRelayIdentity() {
        if (!currentItem || extensionState.videoId !== currentItem.videoId
            || !KARAOKE_PITCH_VIDEO_ID_RE.test(extensionState.videoId || '')
            || !Number.isSafeInteger(extensionState.revision) || extensionState.revision < 1) return null;
        return { videoId: extensionState.videoId, revision: extensionState.revision };
    }

    function sendPitchRelayStatus(status, error = null, identity = currentPitchRelayIdentity()) {
        if (!identity) return false;
        const message = createKaraokePitchRelayStatus(identity.videoId, identity.revision, status, error);
        if (!message) return false;
        window.sendMediaSocket(message);
        return true;
    }

    function stopPitchRelay() {
        const identity = pitchRelayIdentity;
        pitchRelayIdentity = null;
        return identity ? sendPitchRelayStatus('stopped', null, identity) : false;
    }

    function enablePitchRelay() {
        const identity = currentPitchRelayIdentity();
        if (!identity) return stopPitchRelay();
        if (pitchRelayIdentity?.videoId === identity.videoId
            && pitchRelayIdentity.revision === identity.revision) return true;
        stopPitchRelay();
        pitchRelayIdentity = identity;
        return sendPitchRelayStatus('enabled', null, identity);
    }

    function sendPitchRelayError(error) {
        const identity = currentPitchRelayIdentity();
        if (!identity) return false;
        const code = typeof error === 'string' && error ? error : error?.name || 'microphone-recording-failed';
        const message = typeof error?.message === 'string' && error.message ? error.message : String(code);
        return sendPitchRelayStatus('error', { code: String(code).slice(0, 100), message: String(message).slice(0, 500) }, identity);
    }

    function sendPitchRelayFrame(frame) {
        if (!pitchEnabled || !pitchRelayIdentity) return false;
        const identity = currentPitchRelayIdentity();
        if (!identity || identity.videoId !== pitchRelayIdentity.videoId || identity.revision !== pitchRelayIdentity.revision) {
            stopPitchRelay();
            return false;
        }
        const message = createKaraokePitchRelayFrame(identity.videoId, identity.revision, frame);
        if (!message) return false;
        window.sendMediaSocket(message);
        return true;
    }

    function formatPitchNote(midi) {
        if (!Number.isFinite(Number(midi))) return '—';
        const rounded = Math.round(Number(midi));
        return `${pitchNotes[(rounded % 12 + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
    }

    function drawPitchTrail() {
        if (!pitchContext || !pitchCanvas) return;
        const width = pitchCanvas.width;
        const height = pitchCanvas.height;
        const latest = Number(lastPitchFrame?.timeMs ?? extensionState.positionMs ?? 0);
        const start = Math.max(0, latest - 15000);
        pitchContext.clearRect(0, 0, width, height);
        pitchContext.strokeStyle = 'rgba(255,255,255,0.12)';
        pitchContext.lineWidth = 1;
        for (const midi of [36, 60, 84]) {
            const y = height - ((midi - 36) / 48) * height;
            pitchContext.beginPath();
            pitchContext.moveTo(0, y + 0.5);
            pitchContext.lineTo(width, y + 0.5);
            pitchContext.stroke();
        }
        pitchContext.strokeStyle = '#6ee7b7';
        pitchContext.lineWidth = 2;
        let previous = null;
        for (const frame of pitchFrames) {
            if (frame.timeMs < start || !frame.voiced || !Number.isFinite(Number(frame.midi))) {
                previous = null;
                continue;
            }
            const x = Math.max(0, Math.min(width, ((frame.timeMs - start) / 15000) * width));
            const y = height - (Math.max(36, Math.min(84, frame.midi)) - 36) / 48 * height;
            const gapMs = previous ? frame.timeMs - previous.timeMs : Infinity;
            if (!previous || gapMs > 150 || gapMs < 0) pitchContext.moveTo(x, y);
            else pitchContext.lineTo(x, y);
            previous = frame;
        }
        pitchContext.stroke();
    }

    function paintPitchFrame(frame) {
        if (!frame) return;
        lastPitchFrame = frame;
        pitchFrames.push(frame);
        const cutoff = Number(frame.timeMs) - 15000;
        pitchFrames = pitchFrames.filter((item) => item.timeMs >= cutoff);
        if (pitchNoteEl) pitchNoteEl.textContent = `目前音名 ${frame.voiced ? formatPitchNote(frame.midi) : '—'}`;
        if (pitchConfidenceEl) {
            const confidence = Math.round(Math.max(0, Math.min(1, Number(frame.confidence) || 0)) * 100);
            pitchConfidenceEl.textContent = `信心度 ${confidence}%`;
        }
        if (pitchStatusEl) {
            pitchStatusEl.textContent = frame.octaveWarning || !frame.voiced
                ? '麥克風已啟用 · 信心不足'
                : '麥克風已啟用';
        }
        drawPitchTrail();
    }

    function setPitchPlaybackStatus(state) {
        if (!pitchEnabled || !pitchStatusEl || state === 'playing') return;
        const labels = { paused: '已暫停', buffering: '緩衝中', ad: '廣告播放中', error: '播放錯誤' };
        pitchStatusEl.textContent = `麥克風已啟用 · ${labels[state] || '等待播放'}`;
    }

    function paintPitchRecording(message = '') {
        const hasPending = Boolean(pendingRecording);
        pitchRecordingEl?.classList.toggle('hidden', !hasPending);
        if (pitchRecordingStatusEl) {
            pitchRecordingStatusEl.textContent = message
                || (hasPending ? '乾聲錄音已停止，請選擇儲存或捨棄' : '乾聲錄音已停止');
        }
        if (pitchRecordingSaveEl) pitchRecordingSaveEl.disabled = !hasPending;
        if (pitchRecordingDiscardEl) pitchRecordingDiscardEl.disabled = !hasPending;
    }

    function finishPitchTake() {
        if (!pitchRecorder || !pitchEnabled || !currentItem || pitchTakeFinished) return null;
        pitchTakeFinished = true;
        const result = pitchRecorder.finishTake();
        if (result.status === 'insufficient-data' && pitchStatusEl) {
            pitchStatusEl.textContent = '麥克風已啟用 · 資料不足';
        }
        if (result.status === 'ready') {
            pitchHistory?.save({
                videoId: currentItem.videoId,
                title: currentItem.title,
                channel: currentItem.channel || '',
                keySemitones: Number(extensionState.keySemitones) || 0,
                durationMs: Number(extensionState.durationMs) || Math.round(Number(currentItem.durationSec) * 1000) || 0,
                frames: result.frames,
            });
        }
        return result;
    }

    function createPitchRecorder() {
        return window.KanaricPitchRecorder?.createKaraokePitchRecorder({
            mediaDevices: navigator.mediaDevices,
            AudioContext: window.AudioContext || window.webkitAudioContext,
            getPlaybackState: () => extensionState,
            onFrame: (frame) => {
                paintPitchFrame(frame);
                sendPitchRelayFrame(frame);
            },
        });
    }

    function syncPitchLifecycle(state = {}) {
        pitchRecorder = state.recorder || null;
        dryRecording = state.dryRecording || null;
        pendingRecording = state.pendingRecording || null;
        pitchEnabled = state.enabled === true;
        if (!pitchEnabled) pitchTakeFinished = false;
        if (!pitchEnabled) stopPitchRelay();
        paintPitchRecording();
    }

    pitchLifecycle = createKaraokePitchLifecycle({
        createRecorder: createPitchRecorder,
        createDryRecording: (options) => {
            const factory = window.KanaricPitchRecorder?.createDryRecordingController;
            return typeof factory === 'function' ? factory(options) : null;
        },
        getCurrentSong: () => currentItem,
        isStarted: () => started,
        finishTake: () => finishPitchTake(),
        onRecordingError: (error) => {
            sendPitchRelayError(error);
            setWindowBlocked(true, 'microphone');
            if (pitchStatusEl) pitchStatusEl.textContent = '本機錄音無法啟用';
            return error;
        },
        onStateChange: syncPitchLifecycle,
    });

    function stopPitchRecording({ discardRecording = false } = {}) {
        if (pitchStopPromise) return pitchStopPromise;
        stopPitchRelay();
        const operation = Promise.resolve(pitchLifecycle.stop({ discardRecording })).then((result) => {
            syncPitchLifecycle();
            if (pitchEnableEl) {
                pitchEnableEl.disabled = false;
                pitchEnableEl.textContent = '啟用音高紀錄';
            }
            if (pitchStatusEl) pitchStatusEl.textContent = '麥克風未啟用';
            paintPitchRecording(result?.ok === false ? '本機錄音已停止，但部分資源未正常釋放' : '');
            return result;
        });
        const guarded = operation.finally(() => {
            if (pitchStopPromise === guarded) pitchStopPromise = null;
        });
        pitchStopPromise = guarded;
        return guarded;
    }

    let pitchEnablePromise = null;
    function enablePitchRecording() {
        if (pitchEnablePromise) return pitchEnablePromise;
        if (pitchEnabled) return stopPitchRecording();
        if (pitchStopPromise) return pitchStopPromise;
        if (pendingRecording) {
            if (pitchStatusEl) pitchStatusEl.textContent = '請先儲存或捨棄上一段乾聲錄音';
            return Promise.resolve({ ok: false, error: 'pending-recording' });
        }
        const item = currentItem;
        const operation = Promise.resolve().then(() => {
            if (!started || !currentItem) {
                if (pitchStatusEl) pitchStatusEl.textContent = '請先選擇並開始歌曲';
                return { ok: false, error: 'song-required' };
            }
            if (pitchEnableEl) pitchEnableEl.disabled = true;
            if (pitchStatusEl) pitchStatusEl.textContent = '正在請求麥克風權限…';
            pitchFrames = [];
            lastPitchFrame = null;
            pitchTakeFinished = false;
            drawPitchTrail();
            return pitchLifecycle.start(item);
        }).then((result) => {
            syncPitchLifecycle();
            if (!result?.ok) {
                sendPitchRelayError(result?.error || 'microphone-denied');
                setWindowBlocked(true, 'microphone');
                if (pitchStatusEl) pitchStatusEl.textContent = '麥克風無法啟用';
                if (pitchEnableEl) {
                    pitchEnableEl.disabled = false;
                    pitchEnableEl.textContent = result?.error === 'pending-recording' ? '啟用音高紀錄' : '重試音高紀錄';
                }
                paintPitchRecording();
                return result;
            }
            setWindowBlocked(false, 'microphone');
            if (pitchEnableEl) {
                pitchEnableEl.disabled = false;
                pitchEnableEl.textContent = '停止音高紀錄';
            }
            if (pitchStatusEl) pitchStatusEl.textContent = '麥克風已啟用 · 等待播放';
            enablePitchRelay();
            paintPitchRecording();
            return result;
        });
        const guarded = operation.finally(() => {
            if (pitchEnablePromise === guarded) pitchEnablePromise = null;
        });
        pitchEnablePromise = guarded;
        return guarded;
    }

    pitchEnableEl?.addEventListener('click', enablePitchRecording);
    pitchRecordingSaveEl?.addEventListener('click', () => {
        if (!pendingRecording) return;
        if (pitchLifecycle.savePending() === false) {
            paintPitchRecording('儲存錄音失敗，請再試一次');
            return;
        }
        syncPitchLifecycle();
        paintPitchRecording();
    });
    pitchRecordingDiscardEl?.addEventListener('click', async () => {
        if (!pendingRecording) return;
        if (!await pitchLifecycle.discardPending()) {
            paintPitchRecording('捨棄錄音失敗，請再試一次');
            return;
        }
        syncPitchLifecycle();
        paintPitchRecording();
    });
    paintPitchRecording();
    window.addEventListener('pagehide', () => {
        void stopPitchRecording({ discardRecording: true });
    });
    function sendYouTubeCommand(action, payload = {}) {
        const command = youtube.createYouTubeCommand(action, payload, ++commandId);
        if (!command) return false;
        const { type, ...body } = command;
        window.sendMediaSocket({ type, command: body });
        return true;
    }

    function formatDuration(seconds) {
        const value = Math.max(0, Math.round(Number(seconds) || 0));
        return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
    }

    function setSearchStatus(text) {
        const el = document.getElementById('youtube-karaoke-search-status');
        if (el) el.textContent = text || '';
    }

    function setPickerPane(pane) {
        const next = pane === 'queue' ? 'queue' : 'search';
        const picker = document.getElementById('karaoke-song-picker');
        picker?.setAttribute('data-pane', next);
        const searchTab = document.getElementById('karaoke-picker-tab-search');
        const queueTab = document.getElementById('karaoke-picker-tab-queue');
        searchTab?.classList.toggle('active', next === 'search');
        queueTab?.classList.toggle('active', next === 'queue');
        searchTab?.setAttribute('aria-selected', String(next === 'search'));
        queueTab?.setAttribute('aria-selected', String(next === 'queue'));
    }

    function clearCandidateWarning() {
        const banner = document.getElementById('youtube-karaoke-warning');
        if (banner) banner.classList.add('hidden');
    }

    function showCandidateWarning(item) {
        const banner = document.getElementById('youtube-karaoke-warning');
        const message = document.getElementById('youtube-karaoke-warning-message');
        if (!banner || !message || !item?.needsConfirmation) {
            clearCandidateWarning();
            return;
        }
        if (warnedCandidateVideoId === item.videoId) return;
        warnedCandidateVideoId = item.videoId;
        const delta = Number.isFinite(item.durationDeltaSec) ? Math.round(item.durationDeltaSec) : null;
        message.textContent = item.official && delta !== null
            ? `官方影片與歌曲時長相差 ${delta} 秒，可能是不同版本。`
            : '找不到官方頻道候選，這支影片可能是不同版本。';
        banner.classList.remove('hidden');
    }

    function pickResult(item, confirmed = false) {
        const replaceCurrent = item?.replaceCurrent === true;
        const candidate = youtube.toYouTubeQueueItem(item);
        if (!candidate) return null;
        if (replaceCurrent) candidate.replaceCurrent = true;
        if (candidate.needsConfirmation && !confirmed) {
            pendingCandidate = candidate;
            selectSearchResult(candidate);
            showCandidateWarning(candidate);
            setSearchStatus('請確認影片版本後再開始');
            return null;
        }
        pendingCandidate = null;
        clearCandidateWarning();
        if (!started || replaceCurrent) {
            const result = window.karaokeStart(candidate);
            return result === undefined ? candidate : result;
        }
        const queued = queue.snapshot().items.find((entry) => entry.videoId === candidate.videoId)
            || queue.add(candidate);
        if (!queued) return null;
        prefetchQueuedLyrics(queued);
        selectSearchResult(candidate);
        renderQueue();
        setSearchStatus('已加入本次待播');
        return queued;
    }

    function selectSearchResult(item) {
        selectedResult = item;
        document.querySelectorAll('.k-youtube-result').forEach((el) => {
            const key = item?.videoId || '';
            el.classList.toggle('selected', el.dataset.resultKey === key);
        });
        const wrap = document.getElementById('youtube-karaoke-selected');
        const name = document.getElementById('youtube-karaoke-selected-title');
        const channel = document.getElementById('youtube-karaoke-selected-channel');
        if (!wrap || !name || !channel) return;
        wrap.classList.toggle('hidden', !item || !started);
        if (!item) return;
        name.textContent = item.title;
        channel.textContent = `${item.channel || '未知頻道'} · ${formatDuration(item.durationSec)}`;
        const warning = !item.ok
            ? '（此結果可能不是原版，請確認後再開始）'
            : item.needsConfirmation ? '（播放時會提示確認版本）' : '';
        setSearchStatus(warning);
    }

    function renderSearchResults(items) {
        const list = document.getElementById('youtube-karaoke-results');
        if (!list) return;
        list.textContent = '';
        for (const item of items) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'k-youtube-result';
            row.dataset.videoId = item.videoId || '';
            row.dataset.resultKey = item.videoId;
            const info = document.createElement('span');
            info.className = 'k-youtube-result-info';
            const name = document.createElement('span');
            name.className = 'k-youtube-result-title';
            name.textContent = item.title;
            const meta = document.createElement('span');
            meta.className = 'k-youtube-result-meta';
            const image = document.createElement('img');
            image.src = item.thumb || '';
            image.alt = '';
            image.loading = 'lazy';
            row.appendChild(image);
            meta.textContent = `${item.channel || '未知頻道'} · ${formatDuration(item.durationSec)}`;
            if (!item.ok) meta.textContent += ' · 可能不可靠';
            info.append(name, meta);
            row.appendChild(info);
            row.addEventListener('click', () => pickResult(item));
            list.appendChild(row);
        }
        selectSearchResult(youtube.pickInitialYouTubeResult(items));
    }

    function renderQueue() {
        const currentEl = document.getElementById('youtube-karaoke-current');
        const queueEl = document.getElementById('youtube-karaoke-queue');
        if (!currentEl || !queueEl) return;
        const view = youtube.buildQueueView(queue.snapshot());
        currentEl.textContent = '';
        queueEl.textContent = '';
        if (view.current) {
            const label = document.createElement('strong');
            label.textContent = '現在唱';
            const name = document.createElement('span');
            name.textContent = `${view.current.title} · ${view.current.channel || '未知頻道'}`;
            currentEl.append(label, name);
            const status = lyricStates.get(view.current.queueId);
            if (status && status.identity === youtubeLyricsPrefetchIdentity(view.current)) {
                const statusEl = document.createElement('span');
                statusEl.className = 'k-youtube-queue-status';
                statusEl.textContent = youtubeLyricsStatusLabel(status.status);
                currentEl.appendChild(statusEl);
            }
        }
        if (!view.upcoming.length) return;
        const heading = document.createElement('strong');
        heading.textContent = '待播';
        queueEl.appendChild(heading);
        view.upcoming.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'k-youtube-queue-row';
            row.dataset.queueId = item.queueId;
            const name = document.createElement('span');
            name.textContent = `${item.title} · ${item.channel || '未知頻道'}`;
            const lyricState = lyricStates.get(item.queueId);
            if (lyricState && lyricState.identity === youtubeLyricsPrefetchIdentity(item)) {
                const status = document.createElement('span');
                status.className = 'k-youtube-queue-status';
                status.textContent = youtubeLyricsStatusLabel(lyricState.status);
                name.appendChild(status);
            }
            const actions = document.createElement('span');
            actions.className = 'k-youtube-queue-actions';
            [['↑', -1, '上移'], ['↓', 1, '下移']].forEach(([text, delta, labelText]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = text;
                button.title = labelText;
                button.addEventListener('click', () => { queue.move(item.queueId, delta); renderQueue(); });
                actions.appendChild(button);
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '刪除';
            remove.addEventListener('click', () => removeQueueItem(item.queueId));
            actions.appendChild(remove);
            row.append(name, actions);
            queueEl.appendChild(row);
        });
    }

    function lyricQuery(item) {
        const clean = window.cleanBrowserQuery
            ? window.cleanBrowserQuery(item.title, item.channel)
            : { title: item.title, artist: item.channel || '' };
        return { title: clean.title || item.title, artist: clean.artist || item.channel || '' };
    }

    function paintConsoleSong(item) {
        const consoleTitle = document.getElementById('karaoke-console-title');
        const consoleArtist = document.getElementById('karaoke-console-artist');
        if (consoleTitle) consoleTitle.textContent = item?.title || '尚未開始';
        if (consoleArtist) consoleArtist.textContent = item?.channel || '先從下方點歌';
    }

    function paintConsoleState(state) {
        const stateEl = document.getElementById('karaoke-console-state');
        if (!stateEl) return;
        const labels = {
            loading: '載入中', playing: '播放中', paused: '已暫停', buffering: '緩衝中',
            ad: '廣告播放中', ended: '已結束', error: '播放錯誤', idle: '等待選歌',
            'app-disconnected': 'App 連線中斷，請等待重連或退出',
            'owner-lost': 'YouTube 已斷線，請重新選歌或退出',
        };
        const label = labels[state?.state] || '等待選歌';
        if (stateEl.textContent !== label) stateEl.textContent = label;
    }

    function setCurrentSong(item) {
        const query = lyricQuery(item);
        title = query.title;
        artist = query.artist;
        paintConsoleSong(item);
        paintConsoleState({ state: 'loading' });
        window.currentSongInfo = { title, artist };
        window.currentMediaDuration = item.durationSec || 0;
        document.getElementById('youtube-karaoke-current').dataset.videoId = item.videoId;
        pitchFrames = [];
        lastPitchFrame = null;
        pitchTakeFinished = false;
        drawPitchTrail();
        if (pitchEnabled) pitchRecorder?.startTake(item);
        pitchHistory?.load(item.videoId);
        canonicalRefreshPending = true;
        syncOffset = 0;
        paintOffset();
        const requestedOffsetKey = offsetSongKey(title, artist);
        fetch(`/api/lyrics/offset?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)
            .then((r) => r.json()).then((o) => {
                if (offsetSongKey(title, artist) !== requestedOffsetKey) return;
                syncOffset = o.offset || 0;
                paintOffset();
                // canonical refresh
                requestCanonicalLyrics();
            }).catch(() => {});
    }

    function loadYouTubeItem(item, autoplay = true) {
        if (!item) return;
        if (typeof stopPitchRelay === 'function') stopPitchRelay();
        warnedCandidateVideoId = '';
        clearCandidateWarning();
        const queued = queue.snapshot().items.find((x) => x.videoId === item.videoId)
            || queue.add(item);
        if (!queued) return;
        prefetchQueuedLyrics(queued);
        const candidate = Object.prototype.hasOwnProperty.call(item, 'official')
            ? { ...queued, official: item.official, durationDeltaSec: item.durationDeltaSec ?? null,
                needsConfirmation: item.needsConfirmation === true }
            : queued;
        queue.start(queued.queueId);
        extensionState = youtube.startYouTubeSong(extensionState, candidate);
        currentItem = queued;
        if (candidate !== queued) currentItem = candidate;
        playing = false;
        paintPlayBtn();
        setCurrentSong(queued);
        renderQueue();
        if (started) setPickerPane('queue');
        sendYouTubeCommand('load', { videoId: queued.videoId, positionMs: 0 });
        if (autoplay) sendYouTubeCommand('play');
    }

    function removeQueueItem(queueId) {
        const removed = queue.remove(queueId);
        if (!removed) return;
        lyricPrefetch.remove(removed.queueId);
        lyricStates.delete(removed.queueId);
        if (currentItem?.queueId === removed.queueId) {
            stopPitchRelay();
            finishPitchTake();
            sendYouTubeCommand('pause');
            currentItem = null;
            extensionState = { ...extensionState, state: 'idle', videoId: '', positionMs: 0, durationMs: 0 };
            playing = false;
            paintConsoleSong(null);
            paintConsoleState(extensionState);
        }
        renderQueue();
    }

    function nextYouTubeSong() {
        const item = queue.advance(queue.snapshot().revision);
        if (item) loadYouTubeItem(item);
    }

    async function searchYouTube(queryOverride = '') {
        const generation = ++searchGeneration;
        const input = document.getElementById('youtube-karaoke-query');
        const button = document.getElementById('youtube-karaoke-search');
        const query = queryOverride || input?.value.trim() || '';
        if (!query) {
            setSearchStatus('請輸入歌手、歌名或 YouTube 網址');
            if (generation === searchGeneration && button) button.disabled = false;
            return;
        }
        setSearchStatus('搜尋中...');
        if (button) button.disabled = true;
        try {
            const searchDuration = Math.round(window.currentMediaDuration || currentItem?.durationSec || 0);
            const r = await fetch(`/api/mv/search?title=${encodeURIComponent(query)}`
                + `&artist=&duration=${searchDuration}`);
            if (generation !== searchGeneration) return;
            const data = r.ok ? await r.json() : null;
            if (generation !== searchGeneration) return;
            searchResults = (data?.results || []).map(youtube.toYouTubeQueueItem).filter(Boolean);
            renderSearchResults(searchResults);
            if (!searchResults.length) setSearchStatus('找不到 YouTube 影片');
            else if (!selectedResult) setSearchStatus('沒有可靠候選；請手動選擇後再開始');
        } catch (e) {
            if (generation !== searchGeneration) return;
            searchResults = [];
            renderSearchResults([]);
            setSearchStatus('YouTube 搜尋失敗');
        } finally {
            if (generation === searchGeneration && button) button.disabled = false;
        }
    }

    // ===================== 播放狀態 =====================

    // 播放鍵自己更新:common.js 的 syncPlayerBar 改的是播放列裡那顆,那條在這一頁是藏著的
    function paintPlayBtn() {
        const icon = document.getElementById('kbar-play-icon');
        if (!icon) return;
        icon.className = 'fa-solid ' + (playing ? 'fa-pause' : 'fa-play');
        document.getElementById('kbar-play-label').textContent = playing ? '暫停' : '播放';
    }

    function applyState(message) {
        const incoming = youtube.readYouTubeState(message);
        if (!incoming || !incoming.videoId) return;
        if (currentItem && incoming.videoId !== currentItem.videoId) return;
        const next = youtube.applyYouTubeState(extensionState, incoming);
        const recoveringWindow = windowBlocker.reasons().has('owner')
            || windowBlocker.reasons().has('app-socket');
        if (next.state !== 'error' && recoveringWindow && !nativeStarted) compactGate.arm(next.videoId);
        if (next.state !== 'error') setWindowBlocked(false, 'owner');
        setWindowBlocked(false, 'app-socket');
        if (next === extensionState) { compactGate.onState(next); return; }
        const blockWindow = typeof setWindowBlocked === 'function' ? setWindowBlocked : null;
        if (next.state === 'error' || next.error) {
            if (typeof nativeStarted !== 'undefined') nativeStarted = false;
            if (typeof collapseController !== 'undefined') collapseController.finish?.();
            blockWindow?.(true, 'playback');
        } else blockWindow?.(false, 'playback');
        compactGate.onState(next);
        if (next.state === 'ended') {
            stopPitchRelay();
            paintConsoleState(next);
            finishPitchTake();
            const ended = youtube.handleYouTubeEnded(queue, extensionState, incoming);
            extensionState = ended.state;
            if (ended.item) {
                currentItem = ended.item;
                warnedCandidateVideoId = '';
                clearCandidateWarning();
                setCurrentSong(ended.item);
                renderQueue();
                sendYouTubeCommand('load', { videoId: ended.item.videoId, positionMs: 0 });
                sendYouTubeCommand('play');
                showCandidateWarning(ended.item);
            } else {
                playing = false;
                paintPlayBtn();
                paintConsoleSong(null);
                paintConsoleState({ state: 'idle' });
                setSearchStatus('本次待播完成');
            }
            return;
        }
        extensionState = next;
        if (typeof pitchEnabled !== 'undefined' && pitchEnabled
            && typeof enablePitchRelay === 'function') enablePitchRelay();
        paintConsoleState(next);
        playing = next.state === 'playing';
        if (playing) showCandidateWarning(currentItem);
        if (playing) pitchRecorder?.resume();
        else pitchRecorder?.pause();
        setPitchPlaybackStatus(next.state);
        paintPlayBtn();

        const seek = document.getElementById('kbar-seek');
        if (seek) {
            seek.max = String(next.durationMs || currentItem?.durationSec * 1000 || 0);
            seek.value = String(next.positionMs || 0);
        }
        const keyValue = document.getElementById('kbar-key-value');
        if (keyValue) keyValue.textContent = String(next.keySemitones || 0);
        if (canonicalRefreshPending && !['ad', 'error'].includes(next.state)) requestCanonicalLyrics();
    }

    // ===================== 進入 / 離開 =====================
    //
    // 這一頁是「完整點歌首頁 + 同頁控台」兩個布局，`body.karaoke-page` 只切換控台顯示。
    let started = false;
    let nativeStarted = false;
    let windowPinned = false;
    let overBar = false;
    let dragging = false;

    function getWindowSettings() {
        const configured = window.__karaokeWindowSettings || {};
        return {
            compact: configured.compact !== false,
            top: configured.top !== false,
            autoCollapse: configured.autoCollapse !== false,
        };
    }

    function isWindowInteracting() {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement
            && active.matches?.('input,textarea,select,[contenteditable="true"]')) return true;
        if (overBar || dragging) return true;
        const picker = document.getElementById('karaoke-song-picker');
        const resultsPane = document.getElementById('karaoke-picker-results-pane');
        const results = document.getElementById('youtube-karaoke-results');
        const resultsVisible = results && results.children.length > 0
            && (!picker || picker.dataset.pane !== 'queue')
            && (!resultsPane || resultsPane.offsetParent !== null || resultsPane.getClientRects?.().length > 0);
        if (resultsVisible) return true;
        const queuePane = document.getElementById('karaoke-picker-queue-pane');
        const queueVisible = picker?.dataset.pane === 'queue'
            && queuePane
            && (queuePane.offsetParent !== null || queuePane.getClientRects?.().length > 0);
        if (queueVisible || active?.closest?.('.k-youtube-queue-row')) return true;
        return Boolean(document.querySelector(
            '#settings-menu.show, #settings-menu.open, .menu-sub.show,'
            + ' .sel-pop, .lyrics-options-modal.show, [role="dialog"]:not(.hidden)',
        ));
    }

    function setWindowBlocked(blocked, reason = 'error') {
        return windowBlocker.set(blocked, reason);
    }

    let collapseController = null;
    const windowBlocker = createKaraokeWindowBlocker({
        onBlocked: () => collapseController?.block?.(),
        onClear: () => { if (started) collapseController?.arm?.(); },
    });
    collapseController = createKaraokeCollapseController({
        bridge: window.karaokeWindow,
        getState: () => {
            const settings = getWindowSettings();
            return {
                started,
                nativeStarted,
                compact: settings.compact,
                autoCollapse: settings.autoCollapse,
                pinned: windowPinned,
                interacting: isWindowInteracting(),
                blockingError: windowBlocker.isBlocked(),
            };
        },
        onCollapsed: () => document.body.classList.add('karaoke-collapsed'),
        onExpanded: () => document.body.classList.remove('karaoke-collapsed'),
        onError: () => setSearchStatus('無法縮小 App 視窗；仍可在完整頁面繼續唱歌'),
    });
    window.karaokeWindow?.onHandleExpanded?.(() => { void collapseController.expand(true); });

    const compactGate = createKaraokeCompactStartGate({
        bridge: window.karaokeWindow,
        getSettings: getWindowSettings,
        onStarted: () => {
            nativeStarted = true;
            collapseController.markCollapsed?.();
        },
        onError: () => {
            nativeStarted = false;
            collapseController.clear();
            setSearchStatus('無法縮小 App 視窗；仍可在完整頁面繼續唱歌');
        },
    });
    window.addEventListener('pagehide', () => { void compactGate.finish(); });
    window.addEventListener('karaoke-window-settings-changed', (event) => {
        const settings = event.detail || getWindowSettings();
        if (settings.autoCollapse === false) collapseController.clear();
        else if (started && nativeStarted) collapseController.arm();
    });

    window.karaokeStart = function (item = selectedResult) {
        if (started) {
            if (!item || item.videoId === currentItem?.videoId) return;
            document.body.classList.add('karaoke-page');
            setWindowBlocked(false, 'owner');
            compactGate.arm(item.videoId);
            loadYouTubeItem(item);
            showBar();
            return;
        }
        if (!item) {
            if (!item) setSearchStatus('請先選擇可靠的 YouTube 結果');
            return;
        }
        started = true;
        if (window.__mediaSocketAlive === false) setWindowBlocked(true, 'app-socket');
        document.body.classList.add('karaoke-page');
        setPickerPane('queue');
        // 控台本身就是 App 的播放／音高／Queue 表面,置頂的靈動島是重複的而且會蓋在上面 —— 請 server
        // 把它收起來 (離開/重整/當掉時連線一斷,server 自己開回來,見 syncIslandHidden)。
        // **sticky**:連線斷掉重連後要重送,否則旗標歸零、島自己跑回來。
        window.sendMediaSocket({ type: 'karaoke_active', active: true }, KARAOKE_ACTIVE_STICKY_KEY);
        if (window.__mediaSocketAlive !== false) compactGate.arm(item.videoId);
        loadYouTubeItem(item);
        showBar();
    };

    window.karaokeExit = async function () {
        if (!started) return;
        warnedCandidateVideoId = '';
        clearCandidateWarning();
        started = false;
        nativeStarted = false;
        windowBlocker.clear();
        collapseController.finish();
        // 離開就停:頁面不再唱歌,而 Queue 只存在這個頁面的記憶體裡。
        const stopPromise = stopPitchRecording();
        sendYouTubeCommand('pause');
        playing = false;
        paintPlayBtn();
        document.body.classList.remove('karaoke-page');
        setPickerPane('search');
        window.sendMediaSocket({ type: 'karaoke_active', active: false }, KARAOKE_ACTIVE_STICKY_KEY);
        try { await stopPromise; } finally { await compactGate.finish(); }
    };

    window.addEventListener('kanaric-media-socket-open', () => {
        if (pitchEnabled) enablePitchRelay();
    });
    window.addEventListener('kanaric-media-socket-close', () => {
        stopPitchRelay();
        void stopPitchRecording({ discardRecording: true });
        if (started) {
            setWindowBlocked(true, 'app-socket');
            nativeStarted = false;
            collapseController.finish();
            void compactGate.finish();
            paintConsoleState({ state: 'app-disconnected' });
        }
    });
    window.onMediaMessage((msg) => {
        if (msg.type === 'youtube_karaoke_lyrics_prefetch_status'
            || msg.type === 'youtube_karaoke_lyrics_status') {
            lyricPrefetch.receiveStatus(msg);
            return;
        }
        if (msg.type === 'youtube_karaoke_owner_lost') {
            if (!started) return;
            stopPitchRelay();
            void stopPitchRecording({ discardRecording: true });
            nativeStarted = false;
            collapseController.finish();
            setWindowBlocked(true, 'owner');
            void compactGate.finish();
            paintConsoleState({ state: 'owner-lost' });
            return;
        }
        if (msg.type === 'youtube_karaoke_state') { applyState(msg); return; }
        const liveOffset = offsetFromMessage(offsetSongKey(title, artist), msg);
        if (liveOffset !== null) {
            syncOffset = liveOffset;
            paintOffset();
            canonicalRefreshPending = true;
            requestCanonicalLyrics();
            return;
        }
        if (msg.type !== 'lyrics_updated' || !msg.lyrics) return;
        if (msg.title !== title || msg.artist !== artist) return;
        canonicalRefreshPending = true;
        requestCanonicalLyrics(true);
    });

    // ===================== 控制列 (#karaoke-bar) =====================

    // 備選歌詞那顆連同它的浮層整塊搬過來:浮層是 absolute 錨在 .lyrics-opt-wrap 上,
    // 搬 wrapper 而不是只搬按鈕,錨點才跟著走 (只搬按鈕的話浮層會留在藏起來的播放列裡)。
    const tools = document.getElementById('kbar-tools');
    const optWrap = document.querySelector('.lyrics-opt-wrap');
    if (tools && optWrap) {
        tools.prepend(optWrap);
        // data-tip 在這一頁是常駐標籤 (見 style.css 的 #kbar-tools .ctrl-btn::before),
        // 而 server render 的字是「搜尋/查看備選歌詞」且之後只更新 title、不更新 data-tip ——
        // 留著就會是一個永遠停在初始狀態的標籤,改成固定名稱
        const optBtn = optWrap.querySelector('.ctrl-btn');
        if (optBtn) optBtn.dataset.tip = '備選歌詞';
    }

    // 頭出し與播放控制都只送給 YouTube 擴充套件；畫面位置以它回傳的 state 為準。
    window.karaokeRestart = function () {
        sendYouTubeCommand('seek', { positionMs: 0 });
    };

    function setYouTubeKey(value) {
        const semitones = Math.max(-6, Math.min(6, Math.trunc(Number(value) || 0)));
        if (!sendYouTubeCommand('set_key', { semitones })) return;
        extensionState = youtube.applyYouTubeKey(extensionState, semitones);
    }

    document.getElementById('kbar-restart')?.addEventListener('click', window.karaokeRestart);
    document.getElementById('kbar-play')?.addEventListener('click', () => {
        sendYouTubeCommand(playing ? 'pause' : 'play');
    });
    document.getElementById('kbar-next')?.addEventListener('click', nextYouTubeSong);
    document.getElementById('kbar-key-down')?.addEventListener('click', () => setYouTubeKey((extensionState.keySemitones || 0) - 1));
    document.getElementById('kbar-key-value')?.addEventListener('click', () => setYouTubeKey(0));
    document.getElementById('kbar-key-up')?.addEventListener('click', () => setYouTubeKey((extensionState.keySemitones || 0) + 1));
    document.getElementById('kbar-seek')?.addEventListener('change', (e) => {
        sendYouTubeCommand('seek', { positionMs: Number(e.target.value) });
    });

    const searchButton = document.getElementById('youtube-karaoke-search');
    searchButton?.addEventListener('click', () => searchYouTube());
    const searchInput = document.getElementById('youtube-karaoke-query');
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchYouTube();
    });
    document.getElementById('karaoke-picker-tab-search')?.addEventListener('click', () => setPickerPane('search'));
    document.getElementById('karaoke-picker-tab-queue')?.addEventListener('click', () => setPickerPane('queue'));
    document.getElementById('youtube-karaoke-now')?.addEventListener('click', () => {
        if (!selectedResult) return;
        if (started) pickResult({ ...selectedResult, replaceCurrent: true });
        else pickResult(selectedResult);
    });
    document.getElementById('youtube-karaoke-warning-continue')?.addEventListener('click', () => {
        const candidate = pendingCandidate;
        pendingCandidate = null;
        if (candidate) pickResult(candidate, true);
        else clearCandidateWarning();
    });
    document.getElementById('youtube-karaoke-warning-other')?.addEventListener('click', () => {
        pendingCandidate = null;
        warnedCandidateVideoId = '';
        clearCandidateWarning();
        selectSearchResult(null);
        setSearchStatus('目前仍在播放；請選擇其他影片');
        document.getElementById('youtube-karaoke-query')?.focus();
    });
    renderQueue();

    // 字幕早晚 = 這首歌的 sync offset,跟首頁共用同一筆 (存 DB)。每次調整都同步給 owner。
    const offsetEl = document.getElementById('kbar-offset');
    const saveOffsetLater = createOffsetSaver((payload) => {
        fetch('/api/lyrics/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload,
                ...(currentItem && extensionState.videoId === currentItem.videoId
                    && Number.isSafeInteger(extensionState.revision)
                    ? { videoId: extensionState.videoId, revision: extensionState.revision } : {}) }),
            keepalive: true,
        }).catch(() => {});
    });
    window.addEventListener('pagehide', saveOffsetLater.flush);

    function paintOffset() {
        const ms = Math.round(syncOffset * 1000);
        offsetEl.textContent = ms > 0 ? `+${ms} ms` : `${ms} ms`;
    }
    window.karaokePaintOffset = paintOffset;

    function saveOffset() {
        saveOffsetLater(title, artist, syncOffset);
    }

    window.karaokeAdjustOffset = function (delta) {
        syncOffset = Math.round((syncOffset + delta) * 10) / 10;   // 0.1 的浮點殘渣
        paintOffset();
        canonicalRefreshPending = true;
        requestCanonicalLyrics();
        saveOffset();
    };

    window.karaokeResetOffset = function () {
        syncOffset = 0;
        paintOffset();
        canonicalRefreshPending = true;
        requestCanonicalLyrics();
        saveOffset();
    };

    function offsetKeydown(e) {
        if (!started) return;
        const delta = karaokeOffsetHotkey(e,
            localStorage.getItem('hk-advance') || 'ArrowLeft',
            localStorage.getItem('hk-delay') || 'ArrowRight');
        if (delta === null) return;
        e.preventDefault();
        karaokeAdjustOffset(delta);
        showBar();
    }
    window.karaokeOffsetKeydown = offsetKeydown;
    document.addEventListener('keydown', offsetKeydown);

    function showBar() {
        document.body.classList.add('bar-visible');
        if (started && nativeStarted) collapseController.arm();
    }
    window.karaokeShowBar = showBar;

    document.addEventListener('mousemove', showBar);
    const bar = document.getElementById('karaoke-bar');
    if (bar) {
        bar.addEventListener('mouseenter', () => { overBar = true; collapseController.clear(); });
        bar.addEventListener('mouseleave', () => { overBar = false; showBar(); });
    }

    const pin = document.getElementById('karaoke-pin-expand');
    pin?.addEventListener('click', () => {
        windowPinned = !windowPinned;
        pin.setAttribute('aria-pressed', String(windowPinned));
        pin.classList.toggle('active', windowPinned);
        if (windowPinned) collapseController.expand();
        else showBar();
    });

    document.addEventListener('focusin', () => {
        if (started) collapseController.clear();
    });
    document.addEventListener('focusout', () => {
        if (started) showBar();
    });
    const dragRegion = document.querySelector('.win-drag');
    dragRegion?.addEventListener('pointerdown', () => {
        dragging = true;
        collapseController.clear();
    });
    window.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        showBar();
    });
    showBar();

    // ESC 離開。浮層開著時先讓它們吃掉這一下 (備選歌詞的浮層自己有 ESC handler)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !started) return;
        const opt = document.getElementById('lyrics-options-modal');
        if (opt && opt.classList.contains('show')) return;
        karaokeExit();
    });

    // 降級提示上那顆「找別份歌詞」:露出控制列再跑既有的備選歌詞流程 (lyrics-tools.js)
    window.karaokeFindLyrics = function () {
        showBar();
        searchLyricsOptions();
    };

});
