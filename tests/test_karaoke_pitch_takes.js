'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const {
  MAX_BYTES,
  MAX_FRAMES,
  MIN_FRAMES,
  createPitchTakeStore,
  normalizePitchTake,
  summarizePitchTake,
} = require('../web-app/karaoke-pitch-takes');

const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'ABCDEFGHIJK';
let serverModule = null;

function frames(count = 20, start = 0) {
  return Array.from({ length: count }, (_, index) => [
    start + index * 100,
    6000 + (index % 5) * 100,
    700 + (index % 3) * 100,
  ]);
}

function take(videoId = VIDEO_A, overrides = {}) {
  return {
    videoId,
    title: '測試歌曲',
    channel: '測試頻道',
    keySemitones: 2,
    durationMs: 10000,
    frames: frames(),
    ...overrides,
  };
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db));
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  }));
}

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/karaoke/pitch-takes?videoId=${VIDEO_A}`);
      if (response.status === 200) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('pitch take server did not start');
}

async function testValidationAndSummary() {
  assert.throws(() => normalizePitchTake(take('short')), /videoId/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { keySemitones: 7 })), /keySemitones/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { keySemitones: 1.5 })), /keySemitones/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { durationMs: -1 })), /durationMs/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { frames: frames(MIN_FRAMES - 1) })), /20/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { frames: frames(MAX_FRAMES + 1) })), /4500/);
  assert.throws(() => normalizePitchTake(take(VIDEO_A, { title: 'x'.repeat(201) })), /title/);

  const oversized = take(VIDEO_A, { title: 'x'.repeat(MAX_BYTES) });
  assert.throws(() => normalizePitchTake(oversized), /96 KiB/);

  const unordered = frames().reverse();
  unordered.push([50, 9999, 950]);
  const normalized = normalizePitchTake(take(VIDEO_A, { frames: unordered, summary: { lowestMidi: -999 } }));
  assert.strictEqual(normalized.frames.length, MIN_FRAMES);
  assert.deepStrictEqual(normalized.frames[0], [0, 9999, 950]);
  assert.strictEqual(normalized.summary.frameCount, MIN_FRAMES);
  assert.strictEqual(normalized.summary.voicedRatio, 0.2);
  assert.strictEqual(normalized.summary.lowestMidi, 60);
  assert.strictEqual(normalized.summary.highestMidi, 99.99);
  assert.strictEqual(normalized.summary.comfortableLowMidi, 61);
  assert.strictEqual(normalized.summary.comfortableHighMidi, 64);

  const direct = summarizePitchTake(frames(20).map((frame, index) => [frame[0], 4000 + index * 1000, 800]), 2000);
  assert.strictEqual(direct.voicedRatio, 1);
  assert.strictEqual(direct.comfortableLowMidi, 70);
  assert.strictEqual(direct.comfortableHighMidi, 190);
}

async function testStore() {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-pitch-')), 'takes.sqlite');
  const db = await openDatabase(filename);
  const store = createPitchTakeStore(db);
  await store.ready;

  const schema = await query(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'karaoke_pitch_takes'");
  assert.strictEqual(schema.length, 1);
  const index = await query(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_karaoke_pitch_takes_video_time'");
  assert.strictEqual(index.length, 1);

  const first = await store.save(take(VIDEO_A, { keySemitones: -6 }));
  const second = await store.save(take(VIDEO_A, { keySemitones: 6, frames: frames(20, 2000) }));
  await store.save(take(VIDEO_B, { keySemitones: 0 }));

  const listA = await store.list(VIDEO_A);
  assert.strictEqual(listA.length, 2);
  assert.ok(listA.every(row => !Object.prototype.hasOwnProperty.call(row, 'frames')));
  assert.deepStrictEqual(listA.map(row => row.id), [second.id, first.id]);
  assert.ok(listA.every(row => row.videoId === VIDEO_A));
  assert.strictEqual((await store.list(VIDEO_B)).length, 1);

  const detail = await store.detail(first.id);
  assert.strictEqual(detail.keySemitones, -6);
  assert.strictEqual(detail.frames.length, MIN_FRAMES);
  assert.strictEqual(detail.summary.frameCount, MIN_FRAMES);
  assert.strictEqual(await store.delete(first.id), true);
  assert.strictEqual(await store.detail(first.id), null);
  assert.strictEqual((await store.list(VIDEO_A)).length, 1);
  assert.strictEqual(await store.delete(first.id), false);

  await run(db, "CREATE TRIGGER pitch_test_failure BEFORE INSERT ON karaoke_pitch_takes BEGIN SELECT RAISE(ABORT, 'triggered failure'); END;");
  await assert.rejects(store.save(take(VIDEO_B)), /triggered failure/);
  assert.strictEqual((await store.list(VIDEO_B)).length, 1);

  await closeDatabase(db);
}

async function testApi() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-pitch-api-'));
  const dbPath = path.join(dataDir, 'kanaric.sqlite');
  process.env.PORT = '5746';
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = dataDir;
  global.isShuttingDown = true;
  serverModule = require('../web-app/server');
  const baseUrl = 'http://127.0.0.1:5746';
  await waitForServer(baseUrl);

  const payload = take(VIDEO_A, { keySemitones: -6, summary: { lowestMidi: -999 } });
  const createdResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.strictEqual(created.summary.lowestMidi, 60);
  assert.strictEqual(created.summary.frameCount, MIN_FRAMES);

  const listResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes?videoId=${VIDEO_A}`);
  assert.strictEqual(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.strictEqual(listed.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(listed[0], 'frames'));

  const detailResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes/${created.id}`);
  assert.strictEqual(detailResponse.status, 200);
  const detailed = await detailResponse.json();
  assert.strictEqual(detailed.frames.length, MIN_FRAMES);
  assert.strictEqual(detailed.keySemitones, -6);

  const badIdResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes/1.5`, { method: 'DELETE' });
  assert.strictEqual(badIdResponse.status, 400);
  const deleteResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes/${created.id}`, { method: 'DELETE' });
  assert.strictEqual(deleteResponse.status, 200);
  const missingResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes/${created.id}`);
  assert.strictEqual(missingResponse.status, 404);

  const insufficientResponse = await fetch(`${baseUrl}/api/karaoke/pitch-takes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(take(VIDEO_A, { frames: frames(MIN_FRAMES - 1) })),
  });
  assert.strictEqual(insufficientResponse.status, 400);
  const afterInsufficient = await (await fetch(`${baseUrl}/api/karaoke/pitch-takes?videoId=${VIDEO_A}`)).json();
  assert.strictEqual(afterInsufficient.length, 0);
}

async function closeServer() {
  if (!serverModule) return;
  global.isShuttingDown = true;
  if (global.monitorProcess) global.monitorProcess.kill();
  for (const client of serverModule.wss.clients) client.terminate();
  await new Promise(resolve => serverModule.wss.close(() => resolve()));
  await new Promise(resolve => serverModule.server.close(() => resolve()));
  await new Promise(resolve => serverModule.db.close(() => resolve()));
}

(async () => {
  try {
    await testValidationAndSummary();
    await testStore();
    await testApi();
    console.log('test_karaoke_pitch_takes: OK');
  } finally {
    await closeServer();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
