function cloneItem(item) {
  return { ...item };
}

function createYouTubeKaraokeQueue() {
  let items = [];
  let currentQueueId = null;
  let revision = 0;
  let nextQueueId = 1;

  const snapshot = () => ({
    revision,
    currentQueueId,
    items: items.map(cloneItem),
  });
  const bump = () => { revision += 1; };

  return {
    add(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const required = ['videoId', 'title', 'channel', 'durationSec', 'thumb'];
      if (required.some((key) => typeof item[key] !== 'string' && key !== 'durationSec')) return null;
      if (!Number.isFinite(item.durationSec) || item.durationSec < 0) return null;
      const queued = {
        queueId: `q-${nextQueueId++}`,
        videoId: item.videoId,
        title: item.title,
        channel: item.channel,
        durationSec: item.durationSec,
        thumb: item.thumb,
      };
      items = [...items, queued];
      if (currentQueueId === null) currentQueueId = queued.queueId;
      bump();
      return cloneItem(queued);
    },

    remove(queueId) {
      const index = items.findIndex((item) => item.queueId === queueId);
      if (index < 0) return null;
      const [removed] = items.splice(index, 1);
      if (currentQueueId === queueId) currentQueueId = items[index]?.queueId ?? items[index - 1]?.queueId ?? null;
      bump();
      return cloneItem(removed);
    },

    move(queueId, delta) {
      const index = items.findIndex((item) => item.queueId === queueId);
      if (index < 0 || !Number.isInteger(delta) || delta === 0) return snapshot();
      const target = Math.max(0, Math.min(items.length - 1, index + delta));
      if (target === index) return snapshot();
      const [moved] = items.splice(index, 1);
      items.splice(target, 0, moved);
      bump();
      return snapshot();
    },

    start(queueId) {
      const target = queueId === undefined ? items[0] : items.find((item) => item.queueId === queueId);
      if (!target) return null;
      currentQueueId = target.queueId;
      bump();
      return cloneItem(target);
    },

    advance(expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) return null;
      const index = items.findIndex((item) => item.queueId === currentQueueId);
      if (index < 0 || !items[index + 1]) return null;
      currentQueueId = items[index + 1].queueId;
      bump();
      return cloneItem(items[index + 1]);
    },

    clear() {
      items = [];
      currentQueueId = null;
      bump();
      return snapshot();
    },

    snapshot,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createYouTubeKaraokeQueue };
if (typeof window !== 'undefined') window.createYouTubeKaraokeQueue = createYouTubeKaraokeQueue;
