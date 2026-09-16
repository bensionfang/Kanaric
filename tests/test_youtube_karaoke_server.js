const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('C:/Users/USER/Desktop/project/Kanaric/web-app/node_modules/sqlite3').verbose();
const WebSocket = require('C:/Users/USER/Desktop/project/Kanaric/web-app/node_modules/ws');
const { readOrCreateExtensionToken } = require('../web-app/youtube-karaoke-protocol.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanaric-youtube-server-'));
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const YOUTUBE_REVISION_CASES = [
  {
    name: 'ad', lookupTitle: 'youtube-revision-ad', state: 'ad',
    title: 'youtube-revision-ad', channel: 'Revision Test Artist',
  },
  {
    name: 'error', lookupTitle: 'youtube-revision-error', state: 'error',
    title: 'youtube-revision-error', channel: 'Revision Test Artist',
  },
  {
    name: 'missing-metadata', lookupTitle: 'youtube-revision-missing-metadata',
    state: 'playing', title: '', channel: '',
  },
];

const SERVER_TEST_BOOTSTRAP = `
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const controlDir = process.env.YOUTUBE_TEST_CONTROL_DIR;

function keyFor(title) {
  return String(title).replace(/[^A-Za-z0-9_-]/g, '_');
}

function fakeMonitor() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => {};
  return process;
}

function fakeCnLyrics() {
  const process = fakeMonitor();
  process.stdin = {
    write() {},
    end() {
      setImmediate(() => {
        process.stdout.emit('data', Buffer.from(JSON.stringify({ success: false })));
        process.emit('close', 0);
      });
    },
  };
  return process;
}

function fakeFurigana() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  let input = '';
  let timer = null;
  let closed = false;
  process.stdin = {
    write(chunk) {
      input += chunk.toString();
    },
    end() {
      let request;
      try {
        request = JSON.parse(input);
      } catch {
        process.emit('close', 1);
        return;
      }
      const key = keyFor(request.title);
      if (!String(request.title).startsWith('youtube-revision-')) {
        setImmediate(() => {
          if (closed) return;
          closed = true;
          process.stdout.emit('data', Buffer.from(JSON.stringify({ success: true, lyrics: request.lyrics })));
          process.emit('close', 0);
        });
        return;
      }
      fs.writeFileSync(path.join(controlDir, 'pending-' + key), '');
      const releasePath = path.join(controlDir, 'release-' + key);
      timer = setInterval(() => {
        if (closed || !fs.existsSync(releasePath)) return;
        closed = true;
        clearInterval(timer);
        process.stdout.emit('data', Buffer.from(JSON.stringify({ success: true, lyrics: request.lyrics })));
        process.emit('close', 0);
      }, 5);
    },
  };
  process.kill = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    process.emit('close', -9);
  };
  return process;
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  if (Array.isArray(args) && args.includes('monitor')) return fakeMonitor();
  if (Array.isArray(args) && args.includes('furigana')) return fakeFurigana();
  if (Array.isArray(args) && args.includes('cnlyrics')) return fakeCnLyrics();
  return realSpawn(command, args, options);
};

require('./server.js');
`;

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('socket closed before open')));
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout: ${ws._messages.map((m) => `${m.type}:${m.videoId || m.lyrics?.videoId || ''}`).join(',')}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

function waitForRecordedMessage(ws, predicate, timeoutMs = 5000) {
  const recorded = ws._messages.find(predicate);
  return recorded ? Promise.resolve(recorded) : waitForMessage(ws, predicate, timeoutMs);
}

function waitForRecordedMessageAfter(ws, startIndex, predicate, timeoutMs = 5000) {
  const recorded = ws._messages.slice(startIndex).find(predicate);
  return recorded ? Promise.resolve(recorded) : waitForMessage(ws, predicate, timeoutMs);
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await waitMs(10);
  if (!fs.existsSync(file)) throw new Error(`timeout waiting for ${path.basename(file)}`);
}

function seedCache(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openError) => {
      if (openError) return reject(openError);
      db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS word_times (artist TEXT, title TEXT, data TEXT, PRIMARY KEY (artist, title))');
        db.run('CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))', (createError) => {
          if (createError) return reject(createError);
          const rows = [
            [
              'Kenshi Yonezu  米津玄師',
              '米津玄師 Kenshi Yonezu - Lemon',
              '[00:00.00]hello',
            ],
            [
              'Kenshi Yonezu 米津玄師',
              'Lemon revision two',
              '[00:00.00]revision-two',
            ],
            ...YOUTUBE_REVISION_CASES
              .map((testCase) => [
                'Revision Test Artist',
                testCase.lookupTitle,
                `[00:00.00]stale-${testCase.name}`,
              ]),
            [
              'Canonical Artist',
              'Canonical convergence',
              '[00:00.00]<ruby>未<rt>み</rt></ruby>来\n[00:00.00]#WORDS#0:0,1:420,2:900\n[00:01.00]plain',
            ],
            [
              'Keyword Test Artist',
              '夜の花',
              '[00:00.00]夜に咲く花',
            ],
          ];
          rows.forEach(([artist, title]) => {
            db.run('INSERT OR REPLACE INTO word_times (artist, title, data) VALUES (?, ?, ?)', [artist, title, '{}']);
          });
          let firstInsertError = null;
          rows.forEach((row) => {
            db.run('INSERT INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', row, (insertError) => {
              if (insertError && !firstInsertError) firstInsertError = insertError;
            });
          });
          db.close((closeError) => {
            if (firstInsertError || closeError) reject(firstInsertError || closeError);
            else resolve();
          });
        });
      });
    });
  });
}

async function waitForServer(getBase, getLogs) {
  for (let i = 0; i < 60; i++) {
    try {
      const base = getBase();
      if (!base) throw new Error('no base yet');
      const r = await fetch(base + '/api/settings');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start\n${getLogs()}`);
}

async function connect(base, origin, protocols) {
  const ws = new WebSocket(base.replace('http', 'ws'), protocols, origin ? { origin } : {});
  ws._messages = [];
  ws.on('message', (raw) => {
    try { ws._messages.push(JSON.parse(raw)); } catch {}
  });
  await waitForOpen(ws);
  return ws;
}

async function waitForClosed(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CLOSING) {
    await new Promise((resolve) => ws.once('close', resolve));
    return;
  }
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.once('error', resolve);
  });
}

async function main() {
  let logs = '';
  let base = '';
  const dbPath = path.join(TMP, 'lyrics.db');
  const controlDir = path.join(TMP, 'youtube-control');
  fs.mkdirSync(controlDir, { recursive: true });
  await seedCache(dbPath);
  const server = spawn(process.execPath, ['-e', SERVER_TEST_BOOTSTRAP], {
    cwd: path.join(__dirname, '..', 'web-app'),
    env: {
      ...process.env,
      NODE_PATH: path.join('C:\\Users\\USER\\Desktop\\project\\Kanaric\\web-app\\node_modules'),
      PORT: '0',
      DATA_DIR: TMP,
      DB_PATH: dbPath,
      LYRICS_SETTINGS_PATH: path.join(TMP, 'settings.json'),
      MOBILE_TOKEN: 'test-token',
      YOUTUBE_TEST_CONTROL_DIR: controlDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { logs += d.toString(); });
  server.stderr.on('data', (d) => { logs += d.toString(); });
  server.stdout.on('data', (d) => {
    const m = d.toString().match(/running on http:\/\/localhost:(\d+)/i);
    if (m) base = `http://127.0.0.1:${m[1]}`;
  });

  try {
    await Promise.race([
      waitForServer(() => base, () => logs),
      new Promise((resolve, reject) => {
        server.once('exit', (code) => reject(new Error(`server exited ${code}\n${logs}`)));
      }),
    ]);
    const token = readOrCreateExtensionToken({ dataDir: TMP, randomBytes: (n) => Buffer.alloc(n, 1) });
    if (!base) base = 'http://127.0.0.1:5720';

    const lyricSearch = await fetch(base + '/api/karaoke/lyrics-search?q=' + encodeURIComponent('夜に咲く花'));
    assert.equal(lyricSearch.status, 200);
    assert.deepStrictEqual((await lyricSearch.json()).items.map((item) => item.title), ['夜の花']);

    const shortLyricSearch = await fetch(base + '/api/karaoke/lyrics-search?q=' + encodeURIComponent('夜'));
    assert.equal(shortLyricSearch.status, 400);

    const wildcardLyricSearch = await fetch(base + '/api/karaoke/lyrics-search?q=' + encodeURIComponent('%%'));
    assert.equal(wildcardLyricSearch.status, 200);
    assert.deepStrictEqual((await wildcardLyricSearch.json()).items, []);

    const bad = new WebSocket(base.replace('http', 'ws'), ['kanaric-youtube-v1', 'wrong-token'], { origin: EXT_ORIGIN });
    await assert.rejects(waitForOpen(bad));
    await waitForClosed(bad);

    const oversizedSettings = await fetch(base + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parserProbe: 'x'.repeat(256000) }),
    });
    assert.notStrictEqual(oversizedSettings.status, 413, 'parser must accept protocol-sized JSON payloads');

    let ext = await connect(base, EXT_ORIGIN, ['kanaric-youtube-v1', token]);
    const karaoke = await connect(base, null);
    const page = await connect(base, null);
    karaoke.send(JSON.stringify({ type: 'karaoke_active', active: true }));

    await waitMs(500);
    assert.deepStrictEqual(ext._messages, [], 'extension must not receive init');

    page.send(JSON.stringify({ type: 'settings_updated', settings: { show_romaji: true } }));
    await waitMs(200);
    assert.deepStrictEqual(ext._messages, [], 'extension must not receive settings');

    page.send(JSON.stringify({ type: 'media_state', state: { title: 'x' } }));
    await waitMs(200);
    assert.deepStrictEqual(ext._messages, [], 'extension must not receive general broadcast');

    const earlyPitchStart = ext._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_status', videoId: 'SX_ViT4Ra7k', revision: 1,
      status: 'enabled', error: null,
    }));
    await waitMs(150);
    assert.equal(ext._messages.slice(earlyPitchStart).some((m) =>
      m.type === 'youtube_karaoke_pitch_status'), false,
    'pitch status waits for the matching extension state');

    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 1,
        videoId: 'SX_ViT4Ra7k',
        title: '米津玄師 Kenshi Yonezu - Lemon',
        channel: 'Kenshi Yonezu 米津玄師',
        state: 'paused',
        positionMs: 0,
        durationMs: 274000,
        keySemitones: 0,
        error: null,
      },
    }));
    const lemonStatus = await waitForRecordedMessage(ext,
      (m) => m.type === 'youtube_karaoke_lyrics_status' && m.videoId === 'SX_ViT4Ra7k' && m.status === 'loaded', 2000);
    assert.strictEqual(lemonStatus.status, 'loaded', 'cache lookup must tolerate artist whitespace');
    const lemonLyrics = await waitForRecordedMessage(ext,
      (m) => m.type === 'youtube_karaoke_lyrics' && m.lyrics.videoId === 'SX_ViT4Ra7k', 2000);
    assert.strictEqual(lemonLyrics.lyrics.lines[0].text, 'hello');
    await waitForRecordedMessageAfter(ext, earlyPitchStart,
      (m) => m.type === 'youtube_karaoke_pitch_status' && m.videoId === 'SX_ViT4Ra7k'
        && m.revision === 1 && m.status === 'enabled', 2000);

    const pitchFrame = {
      timeMs: 1200, hz: 440, midi: 69, cents: 0,
      confidence: 0.91, voiced: true, octaveWarning: false,
    };
    const pitchStart = ext._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_status', videoId: 'SX_ViT4Ra7k', revision: 1,
      status: 'enabled', error: null,
    }));
    await waitForRecordedMessageAfter(ext, pitchStart,
      (m) => m.type === 'youtube_karaoke_pitch_status' && m.videoId === 'SX_ViT4Ra7k'
        && m.revision === 1 && m.status === 'enabled', 2000);
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_frame', videoId: 'SX_ViT4Ra7k', revision: 1,
      frame: pitchFrame,
    }));
    const relayedPitchFrame = await waitForRecordedMessageAfter(ext, pitchStart,
      (m) => m.type === 'youtube_karaoke_pitch_frame' && m.videoId === 'SX_ViT4Ra7k'
        && m.revision === 1, 2000);
    assert.deepStrictEqual(relayedPitchFrame.frame, pitchFrame);
    page.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_frame', videoId: 'SX_ViT4Ra7k', revision: 1,
      frame: pitchFrame,
    }));
    await waitMs(150);
    assert.equal(page._messages.some((m) => m.type === 'youtube_karaoke_pitch_frame'), false,
      'non-Karaoke page must not receive pitch relay');
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_status', videoId: 'SX_ViT4Ra7k', revision: 1,
      status: 'stopped', error: null,
    }));
    await waitForRecordedMessageAfter(ext, pitchStart,
      (m) => m.type === 'youtube_karaoke_pitch_status' && m.status === 'stopped', 2000);
    const stalePitchStart = ext._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_frame', videoId: 'SX_ViT4Ra7k', revision: 1,
      frame: pitchFrame,
    }));
    await waitMs(150);
    assert.equal(ext._messages.slice(stalePitchStart).some((m) => m.type === 'youtube_karaoke_pitch_frame'), false,
      'stopped pitch session rejects late frames');
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_pitch_status', videoId: 'SX_ViT4Ra7k', revision: 0,
      status: 'enabled', error: null,
    }));
    await waitMs(150);
    assert.equal(ext._messages.slice(stalePitchStart).some((m) => m.type === 'youtube_karaoke_pitch_status' && m.revision === 0), false,
      'invalid pitch revision is rejected');

    const prefetchStart = karaoke._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_lyrics_prefetch', videoId: 'SX_ViT4Ra7k',
      title: '米津玄師 Kenshi Yonezu - Lemon', channel: 'Kenshi Yonezu 米津玄師',
    }));
    const prefetchStatus = await waitForRecordedMessageAfter(karaoke, prefetchStart,
      (m) => m.type === 'youtube_karaoke_lyrics_prefetch_status' && m.videoId === 'SX_ViT4Ra7k'
        && m.status === 'loaded', 2000);
    assert.ok(karaoke._messages.slice(prefetchStart).some((m) =>
      m.type === 'youtube_karaoke_lyrics_prefetch_status' && m.videoId === 'SX_ViT4Ra7k'
        && m.status === 'searching'), 'prefetch reports searching before its final status');
    assert.deepStrictEqual(prefetchStatus, {
      type: 'youtube_karaoke_lyrics_prefetch_status', videoId: 'SX_ViT4Ra7k', status: 'loaded',
    }, 'prefetch returns status only, never raw lyrics');
    assert.equal(karaoke._messages.slice(prefetchStart).some((m) => m.lyrics), false,
      'prefetch socket never receives lyric payload');
    const invalidPrefetchStart = karaoke._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_lyrics_prefetch', videoId: 'SX_ViT4Ra7k', title: '',
      channel: 'Kenshi Yonezu 米津玄師',
    }));
    await waitMs(150);
    assert.equal(karaoke._messages.slice(invalidPrefetchStart).some((m) =>
      m.type === 'youtube_karaoke_lyrics_prefetch_status'), false,
      'invalid prefetch metadata is rejected by the strict schema');
    const nonKaraokePrefetchStart = page._messages.length;
    page.send(JSON.stringify({
      type: 'youtube_karaoke_lyrics_prefetch', videoId: 'SX_ViT4Ra7k',
      title: '米津玄師 Kenshi Yonezu - Lemon', channel: 'Kenshi Yonezu 米津玄師',
    }));
    await waitMs(150);
    assert.equal(page._messages.slice(nonKaraokePrefetchStart).some((m) =>
      m.type === 'youtube_karaoke_lyrics_prefetch_status'), false,
    'a non-Karaoke page cannot use the prefetch route');

    const ownerLostStart = karaoke._messages.length;
    ext.close();
    await waitForClosed(ext);
    await waitForRecordedMessageAfter(karaoke, ownerLostStart,
      (m) => m.type === 'youtube_karaoke_owner_lost');
    ext = await connect(base, EXT_ORIGIN, ['kanaric-youtube-v1', token]);
    const replayStatus = await waitForRecordedMessageAfter(ext, 0,
      (m) => m.type === 'youtube_karaoke_lyrics_status'
        && m.videoId === 'SX_ViT4Ra7k' && m.status === 'loaded', 2000);
    const replayLyrics = await waitForRecordedMessageAfter(ext, 0,
      (m) => m.type === 'youtube_karaoke_lyrics' && m.lyrics.videoId === 'SX_ViT4Ra7k', 2000);
    assert.strictEqual(replayStatus.status, 'loaded');
    assert.strictEqual(replayStatus.revision, undefined, 'revision stays internal to the cached status');
    assert.strictEqual(replayLyrics.lyrics.revision, undefined, 'revision stays internal to the lyrics protocol');
    assert.strictEqual(replayLyrics.lyrics.lines[0].text, 'hello',
      'same-video reconnect replays the revision-1 payload');
    const sameRevisionReconnectStart = ext._messages.length;
    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 1,
        videoId: 'SX_ViT4Ra7k',
        title: '米津玄師 Kenshi Yonezu - Lemon',
        channel: 'Kenshi Yonezu 米津玄師',
        state: 'playing',
        positionMs: 1000,
        durationMs: 274000,
        keySemitones: 0,
        error: null,
      },
    }));
    await waitMs(200);
    assert.equal(ext._messages.slice(sameRevisionReconnectStart).some((m) =>
      m.type === 'youtube_karaoke_lyrics_status' && m.status === 'searching'), false,
    'same-revision reconnect does not refetch');

    ext.close();
    await waitForClosed(ext);
    ext = await connect(base, EXT_ORIGIN, ['kanaric-youtube-v1', token]);
    await waitForRecordedMessageAfter(ext, 0,
      (m) => m.type === 'youtube_karaoke_lyrics' && m.lyrics.videoId === 'SX_ViT4Ra7k', 2000);
    const revision2Start = ext._messages.length;
    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 2,
        videoId: 'SX_ViT4Ra7k',
        title: 'Lemon revision two',
        channel: 'Kenshi Yonezu 米津玄師',
        state: 'playing',
        positionMs: 1000,
        durationMs: 274000,
        keySemitones: 0,
        error: null,
      },
    }));
    const revision2Searching = await waitForRecordedMessageAfter(ext, revision2Start,
      (m) => m.type === 'youtube_karaoke_lyrics_status'
        && m.videoId === 'SX_ViT4Ra7k' && m.status === 'searching', 2000);
    const revision2Status = await waitForRecordedMessageAfter(ext, revision2Start,
      (m) => m.type === 'youtube_karaoke_lyrics_status'
        && m.videoId === 'SX_ViT4Ra7k' && m.status === 'loaded', 2000);
    const revision2Lyrics = await waitForRecordedMessageAfter(ext, revision2Start,
      (m) => m.type === 'youtube_karaoke_lyrics' && m.lyrics.videoId === 'SX_ViT4Ra7k'
        && m.lyrics.lines[0]?.text === 'revision-two', 2000);
    assert.strictEqual(revision2Searching.status, 'searching',
      'revision 2 starts a fresh lookup after reconnect');
    assert.strictEqual(revision2Status.status, 'loaded');
    assert.strictEqual(revision2Lyrics.lyrics.lines[0].text, 'revision-two',
      'revision 2 furnishes its own payload rather than replaying revision 1');
    assert.equal(ext._messages.slice(revision2Start).some((m) =>
      m.type === 'youtube_karaoke_lyrics' && m.lyrics.lines[0]?.text === 'hello'), false,
    'revision 2 does not replay the stale revision-1 payload');

    const revisionAdvanceFailures = [];
    for (const testCase of YOUTUBE_REVISION_CASES) {
      ext.send(JSON.stringify({ type: 'youtube_karaoke_state_reset' }));
      await waitMs(20);
      const key = testCase.lookupTitle.replace(/[^A-Za-z0-9_-]/g, '_');
      const pendingPath = path.join(controlDir, `pending-${key}`);
      const releasePath = path.join(controlDir, `release-${key}`);
      for (const file of [pendingPath, releasePath]) {
        try { fs.unlinkSync(file); } catch {}
      }

      const lookupStart = ext._messages.length;
      ext.send(JSON.stringify({
        type: 'youtube_karaoke_state',
        state: {
          revision: 40,
          videoId: 'SX_ViT4Ra7k',
          title: testCase.lookupTitle,
          channel: 'Revision Test Artist',
          state: 'playing',
          positionMs: 1000,
          durationMs: 10000,
          keySemitones: 0,
          error: null,
        },
      }));
      await waitForRecordedMessageAfter(ext, lookupStart,
        (m) => m.type === 'youtube_karaoke_lyrics_status'
          && m.videoId === 'SX_ViT4Ra7k' && m.status === 'searching', 2000);
      await waitForFile(pendingPath, 2000);

      const advanceStart = ext._messages.length;
      const karaokeAdvanceStart = karaoke._messages.length;
      ext.send(JSON.stringify({
        type: 'youtube_karaoke_state',
        state: {
          revision: 41,
          videoId: 'SX_ViT4Ra7k',
          title: testCase.title,
          channel: testCase.channel,
          state: testCase.state,
          positionMs: 1000,
          durationMs: 10000,
          keySemitones: 0,
          error: null,
        },
      }));
      await waitForRecordedMessageAfter(karaoke, karaokeAdvanceStart,
        (m) => m.type === 'youtube_karaoke_state'
          && m.videoId === 'SX_ViT4Ra7k' && m.revision === 41, 2000);

      fs.writeFileSync(releasePath, '');
      await waitMs(1000);
      const afterAdvance = ext._messages.slice(advanceStart);
      if (afterAdvance.some((m) =>
        m.type === 'youtube_karaoke_lyrics_status' && ['loaded', 'no_lyrics', 'error'].includes(m.status))) {
        revisionAdvanceFailures.push(
          `${testCase.name}: late revision-40 status published after revision-41 ${testCase.state}`,
        );
      }
      if (afterAdvance.some((m) =>
        m.type === 'youtube_karaoke_lyrics'
          && m.lyrics?.lines?.[0]?.text === `stale-${testCase.name}`)) {
        revisionAdvanceFailures.push(
          `${testCase.name}: late revision-40 lyrics published after revision-41 ${testCase.state}`,
        );
      }
    }
    assert.deepStrictEqual(revisionAdvanceFailures, [], revisionAdvanceFailures.join('\n'));

    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 1,
        videoId: 'kJQP7kiw5Fk',
        title: '',
        channel: '',
        state: 'loading',
        positionMs: 0,
        durationMs: 0,
        keySemitones: 0,
        error: null,
      },
    }));
    const navigationState = await waitForRecordedMessage(karaoke,
      (m) => m.type === 'youtube_karaoke_state' && m.videoId === 'kJQP7kiw5Fk', 2000);
    assert.strictEqual(navigationState.revision, 1,
      'a fresh navigation loading state may restart its content-script revision');

    page.send(JSON.stringify({ type: 'youtube_karaoke_command', command: { commandId: 1, action: 'play' } }));
    const forwarded = await waitForRecordedMessage(ext, (m) => m.type === 'youtube_karaoke_command');
    assert.deepStrictEqual(forwarded.command, { commandId: 1, action: 'play' });

    page.send(JSON.stringify({ type: 'youtube_karaoke_command', command: { commandId: 2, action: 'set_key', semitones: 7 } }));
    await waitMs(200);
    assert.strictEqual(ext._messages.filter((m) => m.type === 'youtube_karaoke_command').length, 1,
      'invalid command must not forward');

    const controllerLyricsMessage = {
      type: 'youtube_karaoke_lyrics',
      lyrics: {
        videoId: 'dQw4w9WgXcQ', offsetMs: 300,
        lines: [{ timeMs: 1000, text: 'line', words: [[0, 0], [1, 500]] }],
      },
    };
    page.send(JSON.stringify(controllerLyricsMessage));
    await waitMs(200);
    assert.strictEqual(ext._messages.filter((m) => m.type === 'youtube_karaoke_lyrics'
      && m.lyrics.videoId === controllerLyricsMessage.lyrics.videoId).length, 0,
      'non-Karaoke page must not publish lyrics');

    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 2,
        videoId: 'dQw4w9WgXcQ',
        title: 'Song',
        channel: 'Channel',
        state: 'playing',
        positionMs: 1000,
        durationMs: 10000,
        keySemitones: 0,
        error: null,
      },
    }));
    const karaokeState = await waitForRecordedMessage(karaoke,
      (m) => m.type === 'youtube_karaoke_state' && m.videoId === 'dQw4w9WgXcQ');
    assert.deepStrictEqual(karaokeState, {
      type: 'youtube_karaoke_state',
      revision: 2,
      videoId: 'dQw4w9WgXcQ',
      title: 'Song',
      channel: 'Channel',
      state: 'playing',
      positionMs: 1000,
      durationMs: 10000,
      keySemitones: 0,
      error: null,
    });

    const boundsStateStart = karaoke._messages.length;
    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 2,
        videoId: 'dQw4w9WgXcQ',
        title: 'Song',
        channel: 'Channel',
        state: 'playing',
        positionMs: 1100,
        durationMs: 10000,
        keySemitones: 0,
        error: null,
        ownerWindowBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      },
    }));
    const karaokeBoundsState = await waitForRecordedMessageAfter(karaoke, boundsStateStart,
      (m) => m.type === 'youtube_karaoke_state' && m.videoId === 'dQw4w9WgXcQ'
        && m.positionMs === 1100, 2000);
    assert.deepStrictEqual(karaokeBoundsState.ownerWindowBounds, {
      x: -1920, y: 0, width: 1920, height: 1080,
    });

    const canonicalStateStart = ext._messages.length;
    ext.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 50,
        videoId: '9bZkp7q19f0',
        title: 'Canonical convergence',
        channel: 'Canonical Artist',
        state: 'playing',
        positionMs: 1000,
        durationMs: 10000,
        keySemitones: 0,
        error: null,
      },
    }));
    const canonicalLyrics = await waitForRecordedMessageAfter(ext, canonicalStateStart,
      (m) => m.type === 'youtube_karaoke_lyrics'
        && m.lyrics.videoId === '9bZkp7q19f0'
        && m.lyrics.lines[0]?.text?.includes('<ruby>未<rt>み</rt></ruby>'), 2000);
    assert.deepStrictEqual(canonicalLyrics.lyrics.lines[0].words, [[0, 0], [1, 420], [2, 900]],
      'canonical server payload retains validated word timing');
    const canonicalStart = ext._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_lyrics',
      lyrics: {
        videoId: '9bZkp7q19f0', offsetMs: 900,
        lines: [{ timeMs: 0, text: 'late controller wordless', words: null }],
      },
    }));
    await waitMs(200);
    assert.strictEqual(ext._messages.slice(canonicalStart).some((m) =>
      m.type === 'youtube_karaoke_lyrics' && m.lyrics.lines[0]?.text === 'late controller wordless'), false,
      'late controller wordless payload must not replace canonical lyrics');
    assert.strictEqual(ext._messages.at(-1).lyrics.lines[0].text.includes('<ruby>未<rt>み</rt></ruby>'), true,
      'canonical ruby payload remains current after controller payload');

    const beforeInvalid = ext._messages.length;
    karaoke.send(JSON.stringify({
      type: 'youtube_karaoke_lyrics',
      lyrics: { ...controllerLyricsMessage.lyrics, videoId: 'bad' },
    }));
    await waitMs(200);
    assert.strictEqual(ext._messages.length, beforeInvalid, 'invalid lyrics must not forward');

    ext.close();
    await waitForClosed(ext);
    const replayExt = await connect(base, EXT_ORIGIN, ['kanaric-youtube-v1', token]);
    const replayedLyrics = await waitForRecordedMessage(replayExt, (m) => m.type === 'youtube_karaoke_lyrics');
    assert.strictEqual(replayedLyrics.lyrics.videoId, '9bZkp7q19f0', 'latest canonical lyrics replay after extension reconnect');
    assert.match(replayedLyrics.lyrics.lines[0].text, /<ruby>未<rt>み<\/rt><\/ruby>/);
    assert.deepStrictEqual(replayedLyrics.lyrics.lines[0].words, [[0, 0], [1, 420], [2, 900]]);

    replayExt.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 1,
        videoId: 'kJQP7kiw5Fk',
        title: 'New video',
        channel: 'Channel',
        state: 'ad',
        positionMs: 0,
        durationMs: 10000,
        keySemitones: 0,
        error: null,
      },
    }));
    const recoveredState = await waitForRecordedMessage(karaoke, (m) =>
      m.type === 'youtube_karaoke_state' && m.videoId === 'kJQP7kiw5Fk');
    assert.equal(recoveredState.revision, 1, 'lower revision is accepted after extension reconnect');

    const canonicalReplayStateStart = karaoke._messages.length;
    replayExt.send(JSON.stringify({
      type: 'youtube_karaoke_state',
      state: {
        revision: 50,
        videoId: '9bZkp7q19f0',
        title: 'Canonical convergence',
        channel: 'Canonical Artist',
        state: 'playing',
        positionMs: 1000,
        durationMs: 10000,
        keySemitones: 0,
        error: null,
      },
    }));
    await waitForRecordedMessageAfter(karaoke, canonicalReplayStateStart,
      (m) => m.type === 'youtube_karaoke_state' && m.videoId === '9bZkp7q19f0' && m.revision === 50);

    karaoke.send(JSON.stringify({ type: 'karaoke_active', active: false }));
    const clearedByInactive = await waitForRecordedMessage(replayExt,
      (m) => m.type === 'youtube_karaoke_lyrics' && m.lyrics.lines.length === 0);
    assert.strictEqual(clearedByInactive.lyrics.videoId, '9bZkp7q19f0',
      'deactivating the last Karaoke page must clear the overlay');

    karaoke.close();
    await waitForClosed(karaoke);

    page.close();
    replayExt.close();
    await Promise.allSettled([page, replayExt].map(waitForClosed));
    console.log('test_youtube_karaoke_server: OK');
  } finally {
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
