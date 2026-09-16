function offsetSongKey(title, artist) {
    return `${artist || ''}|||${title || ''}`;
}

function offsetFromMessage(currentKey, message) {
    if (!message || message.type !== 'sync_offset_updated') return null;
    return offsetSongKey(message.title, message.artist) === currentKey
        ? message.offset || 0 : null;
}

function createOffsetSaver(send, delayMs = 500) {
    const pending = new Map();
    function save(title, artist, offset) {
        if (!title) return;
        const key = offsetSongKey(title, artist);
        clearTimeout(pending.get(key)?.timer);
        const payload = { title, artist: artist || '', offset };
        const timer = setTimeout(() => {
            pending.delete(key);
            send(payload);
        }, delayMs);
        pending.set(key, { timer, payload });
    }
    save.flush = () => {
        for (const [key, item] of pending) {
            clearTimeout(item.timer);
            pending.delete(key);
            send(item.payload);
        }
    };
    return save;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
    offsetSongKey, offsetFromMessage, createOffsetSaver,
};
