(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.youtubeKaraoke = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
    const ACTIONS = new Set(['load', 'play', 'pause', 'seek', 'set_key']);
    const DURATION_TOLERANCE_SEC = 30;

    function classifyYouTubeCandidate(item) {
        const official = item?.official === true ? true
            : item?.official === false ? false : null;
        const durationDeltaSec = Number.isFinite(item?.durationDeltaSec)
            && item.durationDeltaSec >= 0 ? item.durationDeltaSec : null;
        if (official === false) return { official, needsConfirmation: true, reason: 'not-official' };
        if (item?.ok === false) return { official, needsConfirmation: true, reason: 'not-ok' };
        if (durationDeltaSec !== null && durationDeltaSec > DURATION_TOLERANCE_SEC) {
            return { official, needsConfirmation: true, reason: 'duration-mismatch' };
        }
        if (typeof item?.needsConfirmation === 'boolean') {
            return {
                official,
                needsConfirmation: item.needsConfirmation,
                reason: item.needsConfirmation ? 'needs-confirmation' : null,
            };
        }
        return { official, needsConfirmation: false, reason: null };
    }

    function toYouTubeQueueItem(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (!VIDEO_ID_RE.test(raw.videoId)) return null;
        if (![raw.title, raw.channel, raw.thumb].every((v) => typeof v === 'string')) return null;
        if (!Number.isFinite(raw.durationSec) || raw.durationSec < 0) return null;
        const item = {
            videoId: raw.videoId,
            title: raw.title,
            channel: raw.channel,
            durationSec: raw.durationSec,
            thumb: raw.thumb,
            ok: raw.ok !== false,
        };
        if (Object.prototype.hasOwnProperty.call(raw, 'official')
            || Object.prototype.hasOwnProperty.call(raw, 'durationDeltaSec')
            || Object.prototype.hasOwnProperty.call(raw, 'needsConfirmation')
            || raw.ok === false) {
            const classification = classifyYouTubeCandidate(raw);
            item.official = classification.official;
            item.durationDeltaSec = Number.isFinite(raw.durationDeltaSec)
                && raw.durationDeltaSec >= 0 ? raw.durationDeltaSec : null;
            item.needsConfirmation = classification.needsConfirmation;
        }
        return item;
    }

    function pickInitialYouTubeResult(results) {
        if (!Array.isArray(results)) return null;
        const items = results.map(toYouTubeQueueItem).filter(Boolean);
        // Python already ranks title relevance before official-channel status;
        // keep that order instead of letting a later unrelated official result win.
        const firstOk = items.find((item) => item.ok);
        if (!firstOk) return null;
        return typeof firstOk.needsConfirmation === 'boolean'
            ? firstOk
            : { ...firstOk, needsConfirmation: true };
    }

    function createYouTubeCommand(action, payload = {}, commandId) {
        if (!ACTIONS.has(action) || !Number.isSafeInteger(commandId) || commandId < 0) return null;
        const command = { type: 'youtube_karaoke_command', commandId, action };
        if (action === 'load') {
            if (!VIDEO_ID_RE.test(payload.videoId)) return null;
            command.videoId = payload.videoId;
            command.positionMs = payload.positionMs === undefined ? 0 : payload.positionMs;
        } else if (action === 'seek') {
            command.positionMs = payload.positionMs;
        } else if (action === 'set_key') {
            command.semitones = payload.semitones;
        }
        if ((action === 'load' || action === 'seek')
            && (!Number.isSafeInteger(command.positionMs) || command.positionMs < 0)) return null;
        if (action === 'set_key'
            && (!Number.isSafeInteger(command.semitones) || command.semitones < -6 || command.semitones > 6)) return null;
        return command;
    }

    function createYouTubeLyricsMessage(videoId, offset, lines) {
        if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)
            || !Number.isFinite(offset) || !Array.isArray(lines)) return null;
        return {
            type: 'youtube_karaoke_lyrics',
            lyrics: {
                videoId,
                offsetMs: Math.round(offset * 1000),
                lines: lines.map((line) => ({
                    timeMs: Math.max(0, Math.round(Number.isFinite(line?.time) ? line.time * 1000 : 0)),
                    text: typeof line?.text === 'string' ? line.text : '',
                    words: Array.isArray(line?.words) ? line.words : null,
                })),
            },
        };
    }

    function startYouTubeSong(previous = {}, item) {
        return {
            ...previous,
            videoId: item.videoId,
            title: item.title,
            channel: item.channel,
            durationMs: Math.round(item.durationSec * 1000),
            positionMs: 0,
            state: 'loading',
            keySemitones: 0,
            endedRevision: previous.endedRevision ?? null,
            endedVideoId: previous.endedVideoId ?? null,
        };
    }

    function readYouTubeState(message) {
        if (!message || typeof message !== 'object') return null;
        return message.state && typeof message.state === 'object' ? message.state : message;
    }

    function applyYouTubeState(previous = {}, incoming) {
        if (!incoming || typeof incoming !== 'object') return previous;
        if (previous.videoId && incoming.videoId && previous.videoId !== incoming.videoId) return previous;
        if (Number.isSafeInteger(previous.revision) && Number.isSafeInteger(incoming.revision)
            && incoming.revision < previous.revision) return previous;
        return {
            ...previous,
            ...incoming,
            positionMs: incoming.positionMs,
            durationMs: incoming.durationMs,
            keySemitones: incoming.keySemitones,
        };
    }

    function applyYouTubeKey(previous = {}, semitones) {
        if (!Number.isSafeInteger(semitones) || semitones < -6 || semitones > 6) return previous;
        return { ...previous, keySemitones: semitones };
    }

    function handleYouTubeEnded(queue, previous, incoming) {
        if (!queue || typeof queue.advance !== 'function' || !incoming || incoming.state !== 'ended') {
            return { state: previous, item: null, advanced: false };
        }
        if (previous.endedRevision === incoming.revision && previous.endedVideoId === incoming.videoId) {
            return { state: previous, item: null, advanced: false };
        }
        const ended = {
            ...applyYouTubeState(previous, incoming),
            endedRevision: incoming.revision,
            endedVideoId: incoming.videoId,
        };
        const item = queue.advance(queue.snapshot().revision);
        if (!item) return { state: { ...ended, state: 'idle' }, item: null, advanced: false };
        return { state: startYouTubeSong(ended, item), item, advanced: true };
    }

    function buildQueueView(snapshot) {
        const items = Array.isArray(snapshot?.items) ? snapshot.items.map((item) => ({ ...item })) : [];
        const currentIndex = items.findIndex((item) => item.queueId === snapshot.currentQueueId);
        return {
            current: currentIndex >= 0 ? items[currentIndex] : null,
            upcoming: currentIndex >= 0 ? items.slice(currentIndex + 1) : items,
            items,
        };
    }

    return {
        classifyYouTubeCandidate,
        toYouTubeQueueItem,
        pickInitialYouTubeResult,
        createYouTubeCommand,
        createYouTubeLyricsMessage,
        readYouTubeState,
        applyYouTubeState,
        applyYouTubeKey,
        startYouTubeSong,
        handleYouTubeEnded,
        buildQueueView,
    };
});
