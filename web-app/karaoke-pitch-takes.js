'use strict';

const MAX_BYTES = 96 * 1024;
const MAX_FRAMES = 4500;
const MIN_FRAMES = 20;
const BUCKET_MS = 100;

class PitchTakeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PitchTakeValidationError';
    this.code = 'INVALID_PITCH_TAKE';
  }
}

function invalid(message) {
  throw new PitchTakeValidationError(message);
}

function assertVideoId(videoId) {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    invalid('videoId must be exactly 11 characters');
  }
}

function assertFrame(frame) {
  if (!Array.isArray(frame) || frame.length !== 3) invalid('invalid compact frame');
  const [timeMs, midiTimes100, confidence] = frame;
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 ||
      !Number.isSafeInteger(midiTimes100) ||
      !Number.isSafeInteger(confidence) || confidence < 0 || confidence > 1000) {
    invalid('invalid compact frame values');
  }
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizePitchTake(frames, durationMs) {
  const voiced = frames.filter(frame => Array.isArray(frame) && frame.length === 3 && frame[2] > 0);
  const midis = voiced.map(frame => frame[1] / 100).sort((a, b) => a - b);
  const durationBuckets = Math.ceil(Math.max(0, durationMs) / BUCKET_MS);
  return {
    frameCount: frames.length,
    voicedRatio: durationBuckets ? Math.min(1, Number((voiced.length / durationBuckets).toFixed(3))) : 0,
    lowestMidi: midis.length ? midis[0] : null,
    highestMidi: midis.length ? midis[midis.length - 1] : null,
    comfortableLowMidi: midis.length ? percentile(midis, 0.2) : null,
    comfortableHighMidi: midis.length ? percentile(midis, 0.8) : null,
  };
}

function normalizePitchTake(payload) {
  let payloadBytes;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (_) {
    invalid('payload is not serializable');
  }
  if (payloadBytes > MAX_BYTES) invalid('payload exceeds 96 KiB');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('payload must be an object');

  assertVideoId(payload.videoId);
  if (typeof payload.title !== 'string' || payload.title.length > 200 || !payload.title.trim()) {
    invalid('title must be 1-200 characters');
  }
  if (typeof payload.channel !== 'string' || payload.channel.length > 200) {
    invalid('channel must be 0-200 characters');
  }
  if (!Number.isInteger(payload.keySemitones) || payload.keySemitones < -6 || payload.keySemitones > 6) {
    invalid('keySemitones must be an integer from -6 to 6');
  }
  if (!Number.isSafeInteger(payload.durationMs) || payload.durationMs < 0) {
    invalid('durationMs must be a non-negative integer');
  }
  if (!Array.isArray(payload.frames) || payload.frames.length > MAX_FRAMES) {
    invalid('frames must contain at most 4500 items');
  }

  const buckets = new Map();
  for (const frame of payload.frames) {
    assertFrame(frame);
    const bucket = Math.floor(frame[0] / BUCKET_MS) * BUCKET_MS;
    const compact = [bucket, frame[1], frame[2]];
    const previous = buckets.get(bucket);
    if (!previous || compact[2] > previous[2]) buckets.set(bucket, compact);
  }
  const frames = Array.from(buckets.values()).sort((a, b) => a[0] - b[0]);
  if (frames.length < MIN_FRAMES) invalid('at least 20 compact frames are required');

  return {
    videoId: payload.videoId,
    title: payload.title,
    channel: payload.channel,
    keySemitones: payload.keySemitones,
    durationMs: payload.durationMs,
    frames,
    summary: summarizePitchTake(frames, payload.durationMs),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS karaoke_pitch_takes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  performed_at TEXT NOT NULL DEFAULT (datetime('now')),
  key_semitones INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  voiced_ratio REAL NOT NULL,
  lowest_midi REAL,
  highest_midi REAL,
  comfortable_low_midi REAL,
  comfortable_high_midi REAL,
  frames TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_karaoke_pitch_takes_video_time
  ON karaoke_pitch_takes(video_id, performed_at DESC, id DESC);
`;

function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function dbGet(db, sql, params) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function summaryFromRow(row) {
  return {
    frameCount: row.frame_count,
    voicedRatio: row.voiced_ratio,
    lowestMidi: row.lowest_midi,
    highestMidi: row.highest_midi,
    comfortableLowMidi: row.comfortable_low_midi,
    comfortableHighMidi: row.comfortable_high_midi,
  };
}

function rowFromDb(row, includeFrames) {
  const result = {
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    performedAt: row.performed_at,
    keySemitones: row.key_semitones,
    durationMs: row.duration_ms,
    summary: summaryFromRow(row),
  };
  if (includeFrames) result.frames = JSON.parse(row.frames);
  return result;
}

function createPitchTakeStore(db) {
  const ready = new Promise((resolve, reject) => db.exec(SCHEMA, error => error ? reject(error) : resolve()));

  return {
    ready,
    async save(payload) {
      await ready;
      const take = normalizePitchTake(payload);
      const result = await dbRun(db, `INSERT INTO karaoke_pitch_takes
        (video_id,title,channel,key_semitones,duration_ms,frame_count,voiced_ratio,
         lowest_midi,highest_midi,comfortable_low_midi,comfortable_high_midi,frames)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
        take.videoId,
        take.title,
        take.channel,
        take.keySemitones,
        take.durationMs,
        take.summary.frameCount,
        take.summary.voicedRatio,
        take.summary.lowestMidi,
        take.summary.highestMidi,
        take.summary.comfortableLowMidi,
        take.summary.comfortableHighMidi,
        JSON.stringify(take.frames),
      ]);
      return { id: result.id, summary: take.summary };
    },
    async list(videoId) {
      await ready;
      assertVideoId(videoId);
      const rows = await dbAll(db, `SELECT id,video_id,title,channel,performed_at,key_semitones,duration_ms,
        frame_count,voiced_ratio,lowest_midi,highest_midi,comfortable_low_midi,comfortable_high_midi
        FROM karaoke_pitch_takes WHERE video_id=? ORDER BY performed_at DESC, id DESC`, [videoId]);
      return rows.map(row => rowFromDb(row, false));
    },
    async detail(id) {
      await ready;
      const row = await dbGet(db, `SELECT id,video_id,title,channel,performed_at,key_semitones,duration_ms,
        frame_count,voiced_ratio,lowest_midi,highest_midi,comfortable_low_midi,comfortable_high_midi,frames
        FROM karaoke_pitch_takes WHERE id=?`, [id]);
      return row ? rowFromDb(row, true) : null;
    },
    async delete(id) {
      await ready;
      const result = await dbRun(db, 'DELETE FROM karaoke_pitch_takes WHERE id=?', [id]);
      return result.changes === 1;
    },
  };
}

module.exports = {
  MAX_BYTES,
  MAX_FRAMES,
  MIN_FRAMES,
  PitchTakeValidationError,
  createPitchTakeStore,
  normalizePitchTake,
  summarizePitchTake,
};
