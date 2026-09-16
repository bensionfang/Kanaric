const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const {
  parsePairingString,
  normalizeSocketCommand,
  normalizeSocketLyrics,
  normalizeSocketLyricsStatus,
  createLatestMessageRelay,
  createRevisionTracker,
  buildYouTubeWatchUrl,
  ensureYouTubeTab,
  activateFromApp,
  canActivate,
} = require('../src/service-worker.js');
const { normalizeYouTubeLyricPayload } = require('../src/youtube-content.js');

test('Task 4 keeps App discovery and reconnect while removing standalone providers', () => {
  const source = fs.readFileSync(require.resolve('../src/service-worker.js'), 'utf8');
  assert.match(source, /discoverKanaricApp/);
  assert.match(source, /new WebSocket/);
  assert.doesNotMatch(source, /fetchStandalone|standaloneLyricsJobs|standaloneCandidateStore/);
  assert.doesNotMatch(source, /lrclib|u\.y\.qq|c\.y\.qq|music\.163|kugou/i);
  assert.equal(fs.existsSync(require('node:path').join(__dirname, '..', 'src', 'standalone-lyrics-source.js')), false);
});

test('only an authenticated App load can activate a YouTube session', () => {
  assert.equal(canActivate({ appConnected: false, action: 'load' }), false);
  assert.equal(activateFromApp({ action: 'load', videoId: 'dQw4w9WgXcQ' }, 41), true);
  assert.equal(activateFromApp({ action: 'play' }, 41), false);
});

test('authenticated App load claims the owner and sends App activation', async () => {
  const runtime = loadServiceWorkerRuntime();
  await sendState(runtime);
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.sentToTabs.length = 0;

  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 1200 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_activation'
      && message.active === true && message.source === 'app'));
});

test('clean first App load claims the active YouTube tab without popup activation', async () => {
  const runtime = loadServiceWorkerRuntime({ storedOwnerId: null, nativeDiscovery: true });
  await connectApp(runtime, { clean: true });

  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();

  assert.ok(runtime.storageSets.some((value) => value.youtubeTabId === 17));
  assert.ok(runtime.storageSets.some((value) => value.youtubeKaraokeActive === true));
  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_activation'
      && message.active === true && message.source === 'app'));
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_activation' && message.source === 'popup'), false);
});

test('App load captures reusable tab audio before activation and queued Key delivery', async () => {
  const runtime = loadServiceWorkerRuntime({ storedOwnerId: null, nativeDiscovery: true });
  await connectApp(runtime, { clean: true });

  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'set_key', semitones: 2 },
  });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();

  const captureIndex = runtime.events.findIndex((event) => event.kind === 'offscreen'
    && event.message.type === 'capture_tab');
  const activationIndex = runtime.events.findIndex((event) => event.kind === 'tab'
    && event.message.type === 'youtube_karaoke_activation' && event.message.active === true);
  const setKeyIndex = runtime.events.findIndex((event) => event.kind === 'offscreen'
    && event.message.type === 'set_key' && event.message.semitones === 2);
  assert.ok(captureIndex >= 0);
  assert.ok(activationIndex > captureIndex);
  assert.ok(setKeyIndex > captureIndex);
  assert.equal(runtime.tabCaptureRequests.length, 1);
  assert.equal(runtime.tabCaptureRequests[0].targetTabId, 17);
});

test('audio bypass is replayed through the existing connection status', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    captureResponse: {
      ok: false,
      status: 'bypass',
      bypassed: true,
      error: { code: 'pitch-processing-unavailable', message: 'worklet failed' },
    },
  });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();

  const activationIndex = runtime.events.findIndex((event) => event.kind === 'tab'
    && event.message.type === 'youtube_karaoke_activation' && event.message.active === true);
  assert.ok(activationIndex >= 0);
  assert.ok(runtime.events.slice(activationIndex + 1).some((event) => event.kind === 'tab'
    && event.message.type === 'youtube_karaoke_connection' && event.message.error === 'worklet failed'));
});

test('App disconnect releases Key ownership and disposes tab audio once', async () => {
  const runtime = loadServiceWorkerRuntime({ storedOwnerId: null, nativeDiscovery: true });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();

  runtime.sockets[0].close();
  await settle();
  let keyResponse;
  runtime.onMessage({ type: 'youtube_karaoke_set_key', semitones: 2 }, { tab: { id: 17 } }, (value) => { keyResponse = value; });
  await settle();
  runtime.resetOwner(17);
  await settle();

  assert.equal(keyResponse?.error, 'karaoke-inactive');
  assert.equal(runtime.offscreenMessages.filter((message) => message.type === 'pitch_dispose').length, 1);
  assert.equal(runtime.sentToTabs.filter(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === false).length, 1);
});

test('owner tab removal uses common owner-loss deactivation and closes the App relay', async () => {
  const runtime = loadServiceWorkerRuntime();
  await connectApp(runtime);
  runtime.sentToTabs.length = 0;

  runtime.resetOwner(17);
  await settle();

  assert.equal(runtime.sockets[0].readyState, 3, 'owner removal must close the extension socket');
  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_activation' && message.active === false),
  'owner removal must notify the owner tab before its relay is cleared');
  assert.ok(runtime.storageRemoves.some((keys) =>
    keys.includes('youtubeTabId') && keys.includes('youtubeKaraokeActive')),
  'owner removal must clear persisted ownership through the common deactivation path');
});

test('early pitch status is replayed after the owner state is accepted', async () => {
  const runtime = loadServiceWorkerRuntime({ nativeDiscovery: true });
  const connection = runtime.worker.connectDiscoveredKanaricApp();
  for (let i = 0; i < 4 && !runtime.sockets.length; i += 1) await settle();
  runtime.sockets[0].open();
  await connection;
  runtime.sentToTabs.length = 0;

  runtime.sockets[0].message({
    type: 'youtube_karaoke_pitch_status', videoId: 'dQw4w9WgXcQ', revision: 1,
    status: 'enabled', error: null,
  });
  await settle();
  assert.equal(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_pitch_status'), false,
  'status must wait for the matching owner state');

  await sendState(runtime);
  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_pitch_status'
      && message.status === 'enabled' && message.revision === 1),
  'accepted owner state must replay the pending status');

  runtime.sockets[0].message({
    type: 'youtube_karaoke_pitch_frame', videoId: 'dQw4w9WgXcQ', revision: 1,
    frame: { timeMs: 100, hz: 440, midi: 69, cents: 0, confidence: 0.9, voiced: true, octaveWarning: false },
  });
  await settle();
  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_pitch_frame' && message.revision === 1),
  'frames after the replay must use the accepted relay identity');
});

test('owner navigation resets Key ownership, disposes once, then recaptures on completion', async () => {
  const runtime = loadServiceWorkerRuntime({ storedOwnerId: null, nativeDiscovery: true });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();

  runtime.offscreenMessages.length = 0;
  runtime.events.length = 0;
  runtime.updated(17, { status: 'loading' });
  await settle();
  assert.equal(runtime.offscreenMessages.filter((message) => message.type === 'pitch_dispose').length, 1);

  runtime.updated(17, { status: 'complete' });
  await settle();
  assert.equal(runtime.offscreenMessages.filter((message) => message.type === 'pitch_dispose').length, 1);
  assert.equal(runtime.offscreenMessages.filter((message) => message.type === 'capture_tab').length, 1);
});

test('rapid App loads activate and navigate only the latest command', async () => {
  const runtime = loadServiceWorkerRuntime({ deferTabLookup: true });
  await connectApp(runtime);

  const load = (videoId, positionMs) => runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId, positionMs },
  });
  load('dQw4w9WgXcQ', 1000);
  load('kJQP7kiw5Fk', 2000);
  await settle();
  assert.equal(runtime.tabLookupRequests.length, 2);

  runtime.resolveTabLookup(1, { id: 17, url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' });
  await settle();
  runtime.updated(17, { status: 'complete' });
  runtime.resolveTabLookup(0, { id: 17, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await settle();

  const urls = runtime.tabUpdates.filter(([, value]) => value.url).map(([, value]) => value.url);
  assert.deepEqual(urls, ['https://www.youtube.com/watch?v=kJQP7kiw5Fk&t=2s']);
  const loads = runtime.sentToTabs.filter(({ message }) => message.action === 'load');
  assert.deepEqual(loads.map(({ message }) => message.videoId), ['kJQP7kiw5Fk']);
});

test('App load queues play/seek until activation and load delivery', async () => {
  const runtime = loadServiceWorkerRuntime({ deferTabLookup: true });
  await connectApp(runtime);
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  runtime.sockets[0].message({ type: 'youtube_karaoke_command', command: { action: 'play' } });
  runtime.sockets[0].message({ type: 'youtube_karaoke_command', command: { action: 'pause' } });
  runtime.sockets[0].message({ type: 'youtube_karaoke_command', command: { action: 'seek', positionMs: 2500 } });
  await settle();
  assert.equal(runtime.sentToTabs.some(({ message }) => message.action === 'play'), false);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.action === 'pause'), false);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.action === 'seek'), false);

  runtime.resolveTabLookup(0, { id: 17, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();

  const actions = runtime.sentToTabs.map(({ message }) => message.action || message.type);
  const loadIndex = actions.indexOf('load');
  assert.ok(loadIndex >= 0);
  assert.deepEqual(actions.slice(loadIndex + 1).filter((action) => ['play', 'pause', 'seek'].includes(action)), ['play', 'pause', 'seek']);
});

test('full YouTube reload reactivates the App-owned session with an accepted source', async () => {
  const runtime = loadServiceWorkerRuntime();
  await connectApp(runtime);
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  runtime.updated(17, { status: 'complete' });
  runtime.sentToTabs.length = 0;

  runtime.updated(17, { status: 'loading' });
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();
  await settle();

  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true && message.source === 'app'));
  assert.equal(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true && message.source === 'youtube'), false);
});

test('disconnect during App owner lookup leaves no persisted active owner', async () => {
  const runtime = loadServiceWorkerRuntime({ deferTabQuery: true });
  await connectApp(runtime);
  runtime.setStoredOwnerId(null);
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  assert.equal(runtime.tabQueryRequests.length, 1);

  runtime.sockets[0].close();
  runtime.resolveTabQuery(0, [{ id: 17, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
  await settle();

  assert.equal(runtime.storageSets.some((value) => value.youtubeTabId !== undefined || value.youtubeKaraokeActive !== undefined), false);
  assert.equal(runtime.tabUpdates.some(([, value]) => value.active === true), false);
});

test('disconnect during owner storage commit rolls back memory and persistence before focus', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    deferStorageSet: true,
  });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  assert.equal(runtime.storageSetRequests.length, 1);
  assert.equal(runtime.tabUpdateRequests.length, 0);

  runtime.sockets[0].close();
  runtime.resolveStorageSet(0);
  await settle();

  assert.equal(await runtime.readOwner(), null);
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.equal(runtime.tabUpdates.some(([, value]) => value.active === true), false);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_activation' && message.active === true), false);
});

test('disconnect during tab-focus commit rolls back memory, persistence, and focus', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    deferTabUpdate: true,
  });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();
  assert.ok(runtime.storageSets.some((value) => value.youtubeTabId === 17 && value.youtubeKaraokeActive === true));
  assert.equal(runtime.tabUpdateRequests.length, 1);

  runtime.sockets[0].close();
  runtime.resolveAllTabUpdates();
  await settle();
  runtime.resolveAllTabUpdates();
  await settle();

  assert.equal(await runtime.readOwner(), null);
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.equal(runtime.focusedTabId(), null);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_activation' && message.active === true), false);
});

test('pending-load App disconnect clears owner activation before worker restore', async () => {
  const runtime = loadServiceWorkerRuntime({ storedOwnerId: null, nativeDiscovery: true });
  await connectApp(runtime, { clean: true });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 },
  });
  await settle();

  assert.ok(runtime.storageSets.some((value) => value.youtubeTabId === 17 && value.youtubeKaraokeActive === true));
  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true));

  runtime.sockets[0].close();
  await settle();
  assert.equal(await runtime.readOwner(), null, 'pending disconnect clears in-memory owner');
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === false));
  assert.equal(runtime.offscreenMessages.filter((message) => message.type === 'pitch_dispose').length, 1);

  const restored = loadServiceWorkerRuntime({
    pairing: false,
    storedOwnerId: runtime.persistedStorage.youtubeTabId ?? null,
  });
  restored.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision: 1, videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', state: 'playing', positionMs: 0 },
  }, { tab: { id: 17 } });
  await settle();
  assert.equal(restored.reconnectTimers.length, 0, 'worker restore without App cannot resurrect karaoke');
  assert.equal(restored.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_activation' && message.active === true), false);
});

test('overlapping claims clean late storage and focus after the newest claim disconnects', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    deferStorageSet: true,
    deferTabUpdate: true,
  });
  await connectApp(runtime, { clean: true });
  const load = (videoId) => runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId, positionMs: 0 },
  });

  load('dQw4w9WgXcQ');
  await settle();
  load('kJQP7kiw5Fk');
  await settle();
  assert.equal(runtime.storageSetRequests.length, 2);

  runtime.resolveStorageSet(1);
  await settle();
  assert.equal(runtime.tabUpdateRequests.length, 1);

  load('9bZkp7q19f0');
  await settle();
  assert.equal(runtime.storageSetRequests.length, 3);

  runtime.sockets[0].close();
  runtime.resolveAllTabUpdates();
  await settle();
  runtime.resolveStorageSet(2);
  await settle();
  runtime.resolveAllTabUpdates();
  await settle();
  runtime.resolveStorageSet(0);
  await settle();
  runtime.resolveAllTabUpdates();
  await settle();

  assert.equal(await runtime.readOwner(), null);
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.equal(runtime.focusedTabId(), null);
  assert.equal(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true), false);
});

test('completed newer claim disconnects before cleaning a late older storage completion', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    deferStorageSet: true,
    deferTabUpdate: true,
  });
  await connectApp(runtime, { clean: true });
  const load = (videoId) => runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId, positionMs: 0 },
  });

  load('dQw4w9WgXcQ');
  await settle();
  load('kJQP7kiw5Fk');
  await settle();
  assert.equal(runtime.storageSetRequests.length, 2);

  runtime.resolveStorageSet(1);
  await settle();
  assert.equal(runtime.tabUpdateRequests.length, 1);
  runtime.resolveAllTabUpdates();
  await settle();
  runtime.updated(17, { status: 'complete' });
  await settle();
  const activationCount = runtime.sentToTabs.filter(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true).length;

  runtime.sockets[0].close();
  runtime.resolveAllTabUpdates();
  await settle();
  runtime.resolveStorageSet(0);
  await settle();
  runtime.resolveAllTabUpdates();
  await settle();

  assert.equal(await runtime.readOwner(), 17);
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.equal(runtime.focusedTabId(), 17);
  assert.equal(runtime.sentToTabs.filter(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true).length, activationCount);
  assert.equal(runtime.tabUpdates.some(([, value]) => value.active === false), false);
});

test('completed newer claim preserves focus after a late older focus completion', async () => {
  const runtime = loadServiceWorkerRuntime({
    storedOwnerId: null,
    nativeDiscovery: true,
    deferStorageSet: true,
    deferTabUpdate: true,
  });
  await connectApp(runtime, { clean: true });
  const load = (videoId) => runtime.sockets[0].message({
    type: 'youtube_karaoke_command',
    command: { action: 'load', videoId, positionMs: 0 },
  });

  load('dQw4w9WgXcQ');
  await settle();
  runtime.resolveStorageSet(0);
  await settle();
  const claimAFocus = runtime.tabUpdateRequests.find(({ id, value }) =>
    id === 17 && value.active === true && value.url === undefined);
  assert.ok(claimAFocus);

  runtime.setStoredOwnerId(18);
  load('kJQP7kiw5Fk');
  await settle();
  assert.equal(runtime.storageSetRequests.length, 2);
  runtime.resolveStorageSet(1);
  await settle();
  const claimBFocus = runtime.tabUpdateRequests.find(({ id, value }) =>
    id === 18 && value.active === true && value.url === undefined);
  assert.ok(claimBFocus);
  claimBFocus.resolve();
  await settle();
  const claimBNavigation = runtime.tabUpdateRequests.find(({ id, value }) =>
    id === 18 && typeof value.url === 'string');
  assert.ok(claimBNavigation);
  claimBNavigation.resolve();
  await settle();
  runtime.updated(18, { status: 'complete' });
  await settle();

  const activationCount = runtime.sentToTabs.filter(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true).length;
  assert.equal(await runtime.worker.restoreStoredYouTubeTabId({ tab: { id: 18 } }), 18);
  assert.equal(runtime.focusedTabId(), 18);
  assert.equal(runtime.persistedStorage.youtubeTabId, 18);

  runtime.sockets[0].close();
  claimAFocus.resolve();
  await settle();
  const restoreBFoc = runtime.tabUpdateRequests.at(-1);
  assert.equal(restoreBFoc?.id, 18);
  assert.equal(restoreBFoc?.value?.active, true);
  assert.equal(restoreBFoc?.value?.url, undefined);
  restoreBFoc.resolve();
  await settle();

  assert.equal(await runtime.worker.restoreStoredYouTubeTabId({ tab: { id: 18 } }), 18);
  assert.equal(runtime.focusedTabId(), 18);
  assert.equal(runtime.tabUpdates.at(-1)?.[0], 18);
  assert.equal(runtime.tabUpdates.some(([, value]) => value.active === false), false);
  assert.equal(runtime.persistedStorage.youtubeTabId, undefined);
  assert.equal(runtime.persistedStorage.youtubeKaraokeActive, undefined);
  assert.equal(runtime.sentToTabs.filter(({ message }) =>
    message.type === 'youtube_karaoke_activation' && message.active === true).length, activationCount);
  assert.equal(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_activation' && message.active === true), false);
});

test('lyrics status rejects removed provider source labels', () => {
  const base = { type: 'youtube_karaoke_lyrics_status', videoId: 'dQw4w9WgXcQ', status: 'loaded', error: null };
  assert.deepEqual(normalizeSocketLyricsStatus(base), base);
  assert.equal(normalizeSocketLyricsStatus({ ...base, source: 'legacy' }), null);
});

test('same-video revision changes reset App relay state before the next request', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const state = (revision) => ({
    type: 'youtube_karaoke_state',
    state: {
      revision,
      videoId: 'dQw4w9WgXcQ',
      title: 'Artist - Song',
      channel: 'Artist',
      state: 'playing',
      positionMs: 0,
    },
  });
  runtime.onMessage(state(1), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sentToTabs.length = 0;
  runtime.onMessage(state(2), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_lyrics_reset' && message.videoId === 'dQw4w9WgXcQ'));
});

test('state reports bounds from the owner tab window only', async () => {
  const runtime = loadServiceWorkerRuntime({
    ownerWindowBounds: { windowId: 23, left: -1920, top: 0, width: 1920, height: 1080 },
  });
  await sendState(runtime);
  runtime.reconnectTimers[0].fn();
  await settle();
  runtime.sockets[0].open();
  await settle();

  const stateMessage = runtime.socketMessages.find((message) => message.type === 'youtube_karaoke_state');
  assert.deepEqual(stateMessage?.state?.ownerWindowBounds, {
    x: -1920, y: 0, width: 1920, height: 1080,
  });
  assert.deepEqual(runtime.tabGetIds(), [17]);
  assert.deepEqual(runtime.windowGetIds(), [23]);
});

test('revision changes clear and refresh the owner bounds cache', async () => {
  const ownerWindowBounds = { windowId: 23, left: -1920, top: 0, width: 1920, height: 1080 };
  const runtime = loadServiceWorkerRuntime({ ownerWindowBounds });
  await sendState(runtime);
  runtime.reconnectTimers[0].fn();
  await settle();
  runtime.sockets[0].open();
  await settle();

  ownerWindowBounds.left = -1280;
  ownerWindowBounds.width = 1280;
  runtime.socketMessages.length = 0;
  await sendState(runtime, 2);

  const stateMessage = runtime.socketMessages.at(-1);
  assert.deepEqual(stateMessage?.state?.ownerWindowBounds, {
    x: -1280, y: 0, width: 1280, height: 1080,
  });
  assert.deepEqual(runtime.tabGetIds(), [17, 17]);
  assert.deepEqual(runtime.windowGetIds(), [23, 23]);
});

test('late bounds from an old revision cannot replace the current owner bounds', async () => {
  const runtime = loadServiceWorkerRuntime({
    ownerWindowBounds: { windowId: 23, left: 0, top: 0, width: 1920, height: 1080 },
    deferWindowLookup: true,
  });
  await sendState(runtime, 1);
  await sendState(runtime, 2);
  assert.equal(runtime.windowLookupRequests.length, 2);
  runtime.windowLookupRequests[1].resolve({ left: -1280, top: 0, width: 1280, height: 1024 });
  await settle();
  runtime.windowLookupRequests[0].resolve({ left: 0, top: 0, width: 1920, height: 1080 });
  await settle();
  runtime.reconnectTimers[0].fn();
  await settle();
  runtime.sockets[0].open();
  await settle();
  const stateMessage = runtime.socketMessages.find((message) => message.type === 'youtube_karaoke_state');
  assert.deepEqual(stateMessage?.state?.ownerWindowBounds, {
    x: -1280, y: 0, width: 1280, height: 1024,
  });
});

test('invalid owner window bounds stay absent from the state', async () => {
  const runtime = loadServiceWorkerRuntime({
    ownerWindowBounds: { windowId: 23, left: 0, top: 0, width: 0, height: 1080 },
  });
  await sendState(runtime);
  runtime.reconnectTimers[0].fn();
  await settle();
  runtime.sockets[0].open();
  await settle();

  const stateMessage = runtime.socketMessages.find((message) => message.type === 'youtube_karaoke_state');
  assert.equal(stateMessage?.state?.ownerWindowBounds, undefined);
});

test('normalize and replay lyrics messages at the service-worker boundary', () => {
  const lyricsMessage = {
    type: 'youtube_karaoke_lyrics',
    lyrics: {
      videoId: 'dQw4w9WgXcQ', offsetMs: -200,
      lines: [{ timeMs: 1000, text: 'line', words: [[0, 0], [1, 500]] }],
    },
  };
  assert.deepStrictEqual(normalizeSocketLyrics(lyricsMessage), lyricsMessage);
  assert.strictEqual(normalizeSocketLyrics({ ...lyricsMessage, lyrics: { ...lyricsMessage.lyrics, videoId: 'bad' } }), null);
  const relayed = [];
  const relay = createLatestMessageRelay((message) => relayed.push(message));
  assert.strictEqual(relay.receive(lyricsMessage), true);
  assert.strictEqual(relay.replay(), true);
  assert.deepStrictEqual(relayed, [lyricsMessage, lyricsMessage]);
  relay.clear();
  assert.strictEqual(relay.replay(), false);
});

test('normalizeSocketLyrics rejects non-string video IDs', () => {
  const lyricsMessage = {
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [] },
  };
  assert.equal(normalizeSocketLyrics({ ...lyricsMessage, lyrics: { ...lyricsMessage.lyrics, videoId: 12345678901 } }), null);
  assert.equal(normalizeSocketLyrics({ ...lyricsMessage, lyrics: { ...lyricsMessage.lyrics, videoId: ['dQw4w9WgXcQ'] } }), null);
});

test('content accepts only App ruby and complete word timing', () => {
  const payload = {
    type: 'youtube_karaoke_lyrics',
    lyrics: {
      videoId: 'dQw4w9WgXcQ',
      offsetMs: 0,
      lines: [{ timeMs: 0, text: '<ruby>未<rt>み</rt></ruby>', words: [[0, 0], [1, 420]] }],
    },
  };
  assert.deepEqual(normalizeYouTubeLyricPayload(payload), payload.lyrics);
  assert.equal(normalizeYouTubeLyricPayload({
    ...payload,
    lyrics: { ...payload.lyrics, lines: [{ timeMs: 0, text: '<script>alert(1)</script>', words: null }] },
  }), null);
  assert.equal(normalizeYouTubeLyricPayload({
    ...payload,
    lyrics: { ...payload.lyrics, lines: [{ timeMs: 0, text: 'x', words: [[0, 0]] }] },
  }), null);
});

test('socket message handler guards parsed JSON before reading type', () => {
  const source = fs.readFileSync(require.resolve('../src/service-worker.js'), 'utf8');
  const parseIndex = source.indexOf('message = JSON.parse(event.data)');
  const typeIndex = source.indexOf("message.type === 'youtube_karaoke_lyrics'", parseIndex);
  const guardIndex = source.indexOf("typeof message !== 'object' || Array.isArray(message)", parseIndex);
  assert.ok(parseIndex >= 0 && guardIndex > parseIndex && guardIndex < typeIndex);

  const updatedIndex = source.indexOf('chrome.tabs.onUpdated.addListener');
  const pendingSendIndex = source.indexOf('sendToTab(command);', updatedIndex);
  const lyricsReplayIndex = source.indexOf('lyricsRelay.replay();', updatedIndex);
  assert.ok(updatedIndex >= 0 && pendingSendIndex < lyricsReplayIndex);
});

test('parsePairingString accepts exact localhost pairing format', () => {
  assert.deepEqual(parsePairingString('http://127.0.0.1:5720#abc_DEF-123'), {
    baseUrl: 'http://127.0.0.1:5720',
    token: 'abc_DEF-123',
    wsUrl: 'ws://127.0.0.1:5720',
  });
});

test('parsePairingString rejects hostname https path and invalid tokens', () => {
  assert.equal(parsePairingString('http://localhost:5720#abc_DEF-123'), null);
  assert.equal(parsePairingString('https://127.0.0.1:5720#abc_DEF-123'), null);
  assert.equal(parsePairingString('http://127.0.0.1:0#abc_DEF-123'), null);
  assert.equal(parsePairingString('http://127.0.0.1:65536#abc_DEF-123'), null);
  assert.equal(parsePairingString('http://127.0.0.1:5720/watch#abc_DEF-123'), null);
  assert.equal(parsePairingString('http://127.0.0.1:5720#abc/DEF'), null);
  assert.equal(parsePairingString('http://127.0.0.1:5720#abc=DEF'), null);
});

test('normalizeSocketCommand maps supported commands to tab actions', () => {
  assert.deepEqual(
    normalizeSocketCommand({ type: 'youtube_karaoke_command', command: { action: 'play', revision: 3 } }),
    { action: 'play', revision: 3 }
  );
  assert.deepEqual(
    normalizeSocketCommand({ type: 'youtube_karaoke_command', command: { action: 'seek', revision: 4, seconds: 9.5 } }),
    { action: 'seek', revision: 4, positionMs: 9500 }
  );
  assert.deepEqual(
    normalizeSocketCommand({
      type: 'youtube_karaoke_command',
      command: { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 1200 },
    }),
    { action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 1200 }
  );
  assert.deepEqual(
    normalizeSocketCommand({
      type: 'youtube_karaoke_command',
      command: { action: 'set_key', semitones: -6 },
    }),
    { action: 'set_key', semitones: -6 }
  );
  assert.equal(normalizeSocketCommand({
    type: 'youtube_karaoke_command',
    command: { action: 'set_key', semitones: 7 },
  }), null);
});

test('createRevisionTracker increments only on load', () => {
  const tracker = createRevisionTracker();
  assert.equal(tracker.current(), 0);
  assert.equal(tracker.apply({ action: 'play', revision: 3 }), 0);
  assert.equal(tracker.apply({ action: 'load', videoId: 'dQw4w9WgXcQ', positionMs: 0 }), 1);
  assert.equal(tracker.apply({ action: 'seek', revision: 9, positionMs: 1000 }), 1);
  assert.equal(tracker.apply({ action: 'load', videoId: 'kJQP7kiw5Fk', positionMs: 0 }), 2);
  assert.equal(tracker.current(), 2);
});

test('load URL preserves the requested start position', () => {
  assert.equal(buildYouTubeWatchUrl('dQw4w9WgXcQ', 1250), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1.25s');
});

test('ensureYouTubeTab reuses only the extension-owned tab', async () => {
  const calls = [];
  const api = {
    storage: { local: {
      get: async () => ({ youtubeTabId: 17 }),
      set: async (value) => calls.push(['set', value]),
    } },
    tabs: {
      get: async (id) => ({ id, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      update: async (id, value) => calls.push(['update', id, value]),
      create: async () => { throw new Error('must not create when owned tab exists'); },
    },
  };
  const tab = await ensureYouTubeTab(api);
  assert.equal(tab.id, 17);
  assert.deepStrictEqual(calls, [['update', 17, { active: true }]]);
});

test('ensureYouTubeTab claims the popup sender YouTube tab without opening another one', async () => {
  const calls = [];
  const api = {
    storage: { local: {
      get: async () => ({ youtubeTabId: 17 }),
      set: async (value) => calls.push(['set', value]),
    } },
    tabs: {
      get: async (id) => ({ id, url: 'chrome://extensions/' }),
      update: async (id, value) => calls.push(['update', id, value]),
      create: async () => { throw new Error('must not create a YouTube tab'); },
    },
  };

  const tab = await ensureYouTubeTab(api, { id: 18, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(tab.id, 18);
  assert.deepStrictEqual(calls, [
    ['set', { youtubeTabId: 18 }],
    ['update', 18, { active: true }],
  ]);
});

test('ensureYouTubeTab claims the active YouTube tab when popup sender and stored owner are unavailable', async () => {
  const calls = [];
  const api = {
    storage: { local: {
      get: async () => ({ youtubeTabId: 17 }),
      set: async (value) => calls.push(['set', value]),
    } },
    tabs: {
      get: async () => ({ id: 17, url: 'chrome://extensions/' }),
      query: async (query) => {
        calls.push(['query', query]);
        return [{ id: 18, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
      },
      update: async (id, value) => calls.push(['update', id, value]),
      create: async () => { throw new Error('must not create a YouTube tab'); },
    },
  };

  const tab = await ensureYouTubeTab(api);
  assert.equal(tab.id, 18);
  assert.deepStrictEqual(calls, [
    ['query', { active: true, currentWindow: true }],
    ['set', { youtubeTabId: 18 }],
    ['update', 18, { active: true }],
  ]);
});

test('loaded bundle retains non-committing owner discovery', () => {
  const bundle = fs.readFileSync(require.resolve('../dist/service-worker.js'), 'utf8');
  assert.ok(bundle.includes('async function ensureYouTubeTab(api = chrome, preferredTab = null, { commit = true } = {})'));
  assert.ok(bundle.includes('ensureYouTubeTab(chrome, null, { commit: false })'));
});

test('ensureYouTubeTab requires an existing YouTube owner tab', async () => {
  const api = {
    storage: { local: {
      get: async () => ({ youtubeTabId: 17 }),
      set: async () => {},
    } },
    tabs: {
      get: async () => ({ id: 17, url: 'chrome://extensions/' }),
      query: async () => [{ id: 18, url: 'https://example.com/' }],
      update: async () => {},
      create: async () => { throw new Error('must not create a YouTube tab'); },
    },
  };

  await assert.rejects(() => ensureYouTubeTab(api), /youtube-owner-tab-required/);
});

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function connectApp(runtime, { clean = false } = {}) {
  if (clean) {
    const connection = runtime.worker.connectDiscoveredKanaricApp();
    for (let i = 0; i < 4 && !runtime.sockets.length; i += 1) await settle();
    runtime.sockets[0].open();
    await connection;
    return;
  }
  await sendState(runtime);
  runtime.reconnectTimers[0].fn();
  await settle();
  runtime.sockets[0].open();
}

function loadServiceWorkerRuntime({ pairing = true, storedOwnerId = 17, deferTabLookup = false, deferTabQuery = false, deferWindowLookup = false, nativeDiscovery = false, deferStorageSet = false, deferTabUpdate = false, ownerWindowBounds = null, captureResponse = { ok: true, status: 'ready', keySemitones: 0, tempo: 1 } } = {}) {
  const source = fs.readFileSync(require.resolve('../src/service-worker.js'), 'utf8');
  const stateListeners = [];
  const sentToTabs = [];
  const reconnectTimers = [];
  const sockets = [];
  const socketMessages = [];
  const storageSets = [];
  const storageRemoves = [];
  const storageSetRequests = [];
  const persistedStorage = {};
  const tabUpdates = [];
  const tabUpdateRequests = [];
  const tabLookupRequests = [];
  const tabQueryRequests = [];
  const tabGetIds = [];
  const windowGetIds = [];
  const windowLookupRequests = [];
  const offscreenMessages = [];
  const tabCaptureRequests = [];
  const events = [];
  let offscreenOpen = false;
  let offscreenCloseCount = 0;
  let ownerStorageReads = 0;
  let configuredOwnerId = storedOwnerId;
  let removedListener = null;
  let storageChangeListener = null;
  let updatedListener = null;
  let timerId = 0;
  let focusedTabId = null;

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    message(value) {
      this.emit('message', { data: JSON.stringify(value) });
    }

    send(value) {
      socketMessages.push(JSON.parse(value));
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', { code });
    }
  }

  const chrome = {
    storage: { local: {
      get: async (keys) => (keys.includes('youtubeTabId')
        ? (ownerStorageReads += 1, configuredOwnerId === null ? {} : { youtubeTabId: configuredOwnerId })
        : (pairing ? { baseUrl: 'http://127.0.0.1:5720', token: 'test-token' } : {})),
      set: async (value) => {
        const defer = deferStorageSet
          && (value.youtubeTabId !== undefined || value.youtubeKaraokeActive !== undefined);
        if (!defer) {
          storageSets.push(value);
          Object.assign(persistedStorage, value);
          return;
        }
        return new Promise((resolve) => storageSetRequests.push({
          value,
          resolve: () => {
            storageSets.push(value);
            Object.assign(persistedStorage, value);
            resolve();
          },
        }));
      },
      remove: async (keys) => {
        storageRemoves.push(keys);
        for (const key of keys) delete persistedStorage[key];
      },
    }, onChanged: { addListener: (listener) => { storageChangeListener = listener; } } },
    runtime: {
      onMessage: { addListener: (listener) => stateListeners.push(listener) },
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => offscreenOpen ? [{}] : [],
      sendMessage: async (message) => {
        offscreenMessages.push(message);
        events.push({ kind: 'offscreen', message });
        if (message.type === 'capture_tab') return captureResponse;
        if (message.type === 'set_key') return { ok: true, semitones: message.semitones, tempo: 1 };
        if (message.type === 'pitch_dispose') return { ok: true };
        return null;
      },
      sendNativeMessage: nativeDiscovery
        ? async () => ({ ok: true, baseUrl: 'http://127.0.0.1:5720', token: 'test-token', expiresAt: Date.now() + 60000, pid: 1 })
        : undefined,
    },
    offscreen: {
      createDocument: async () => { offscreenOpen = true; },
      closeDocument: async () => { offscreenOpen = false; offscreenCloseCount += 1; },
    },
    tabCapture: {
      getMediaStreamId: async (options) => {
        tabCaptureRequests.push(options);
        return 'stream-1';
      },
    },
    tabs: {
      sendMessage: (tabId, message) => {
        sentToTabs.push({ tabId, message });
        events.push({ kind: 'tab', tabId, message });
        return Promise.resolve();
      },
      get: async (id) => {
        tabGetIds.push(id);
        if (!deferTabLookup) return {
          id,
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          ...(ownerWindowBounds ? { windowId: ownerWindowBounds.windowId } : {}),
        };
        return new Promise((resolve) => tabLookupRequests.push({ id, resolve }));
      },
      query: async (query) => {
        if (!deferTabQuery) return [{ id: 17, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
        return new Promise((resolve) => tabQueryRequests.push({ query, resolve }));
      },
      update: async (id, value) => {
        if (!deferTabUpdate) {
          tabUpdates.push([id, value]);
          if (value.active === true) focusedTabId = id;
          else if (focusedTabId === id) focusedTabId = null;
          return;
        }
        return new Promise((resolve) => tabUpdateRequests.push({
          id,
          value,
          resolve: () => {
            tabUpdates.push([id, value]);
            if (value.active === true) focusedTabId = id;
            else if (focusedTabId === id) focusedTabId = null;
            resolve();
          },
        }));
      },
      onRemoved: { addListener: (listener) => { removedListener = listener; } },
      onUpdated: { addListener: (listener) => { updatedListener = listener; } },
    },
    ...(ownerWindowBounds ? {
      windows: {
        get: async (id) => {
          windowGetIds.push(id);
          if (deferWindowLookup) return new Promise((resolve) => windowLookupRequests.push({ id, resolve }));
          return {
            left: ownerWindowBounds.left,
            top: ownerWindowBounds.top,
            width: ownerWindowBounds.width,
            height: ownerWindowBounds.height,
          };
        },
      },
    } : {}),
  };
  const context = {
    module: { exports: {} },
    exports: {},
    require,
    chrome,
    WebSocket: FakeWebSocket,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, id: ++timerId };
      reconnectTimers.push(timer);
      return timer.id;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    console,
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    Date,
    Promise,
    JSON,
    Number,
    Object,
    Array,
    Error,
    Math,
  };
  vm.runInNewContext(source, context, { filename: require.resolve('../src/service-worker.js') });
  return {
    worker: context.module.exports,
    onMessage: stateListeners[0],
    reconnectTimers,
    ownerStorageReads: () => ownerStorageReads,
    sentToTabs,
    sockets,
    socketMessages,
    storageSets,
    storageRemoves,
    storageSetRequests,
    persistedStorage,
    tabUpdates,
    tabUpdateRequests,
    tabLookupRequests,
    tabQueryRequests,
    tabGetIds: () => tabGetIds,
    windowGetIds: () => windowGetIds,
    windowLookupRequests,
    offscreenMessages,
    tabCaptureRequests,
    events,
    offscreenCloseCount: () => offscreenCloseCount,
    setStoredOwnerId: (tabId) => { configuredOwnerId = tabId; },
    resolveTabLookup: (index, tab) => tabLookupRequests[index]?.resolve(tab),
    resolveTabQuery: (index, tabs) => tabQueryRequests[index]?.resolve(tabs),
    resolveStorageSet: (index) => storageSetRequests[index]?.resolve(),
    resolveAllTabUpdates: () => {
      while (tabUpdateRequests.length) tabUpdateRequests.shift().resolve();
    },
    focusedTabId: () => focusedTabId,
    readOwner: () => context.module.exports.restoreStoredYouTubeTabId({ tab: { id: 17 } }),
    storageChange: (...args) => storageChangeListener?.(...args),
    resetOwner: (tabId) => removedListener?.(tabId),
    updated: (...args) => updatedListener?.(...args),
  };
}

async function sendState(runtime, revision = 1, videoId = 'dQw4w9WgXcQ') {
  runtime.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision, videoId, title: 'Song', channel: 'Artist', state: 'playing', positionMs: 0 },
  }, { tab: { id: 17 } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function optionsRequest(revision = 1, videoId = 'dQw4w9WgXcQ') {
  return { type: 'youtube_karaoke_lyrics_options_request', videoId, revision, title: 'Song', artist: 'Artist' };
}

function optionSelect(optionId, revision = 1, videoId = 'dQw4w9WgXcQ') {
  return { type: 'youtube_karaoke_lyrics_option_select', videoId, revision, optionId };
}

test('closed socket refuses options and reports that the App is required', async () => {
  const runtime = loadServiceWorkerRuntime();
  await sendState(runtime);
  let responseValue;
  assert.equal(runtime.onMessage(optionsRequest(), { tab: { id: 17 } }, (value) => { responseValue = value; }), true);
  assert.equal(responseValue?.ok, false);
  assert.equal(responseValue?.error, 'app-required');
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_lyrics_options'), false);
});

test('open socket keeps the App options request path', async () => {
  const runtime = loadServiceWorkerRuntime();
  runtime.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision: 1, videoId: 'dQw4w9WgXcQ', title: '', channel: '', state: 'playing', positionMs: 0 },
  }, { tab: { id: 17 } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision: 1, videoId: 'dQw4w9WgXcQ', title: 'Song', channel: 'Artist', state: 'playing', positionMs: 0 },
  }, { tab: { id: 17 } });
  await new Promise((resolve) => setImmediate(resolve));
  let responseValue;
  assert.equal(runtime.onMessage(optionsRequest(), { tab: { id: 17 } }, (value) => { responseValue = value; }), true);
  assert.equal(responseValue?.ok, true);
  assert.deepEqual(runtime.socketMessages.at(-1), optionsRequest());
});

test('disconnected options requests require the App', async () => {
  const runtime = loadServiceWorkerRuntime();
  await sendState(runtime);
  let firstResponse;
  let secondResponse;
  assert.equal(runtime.onMessage(optionsRequest(), { tab: { id: 17 } }, (value) => { firstResponse = value; }), true);
  assert.equal(runtime.onMessage(optionsRequest(), { tab: { id: 17 } }, (value) => { secondResponse = value; }), true);
  assert.equal(firstResponse?.ok, false);
  assert.equal(firstResponse?.error, 'app-required');
  assert.equal(secondResponse?.ok, false);
  assert.equal(secondResponse?.error, 'app-required');
});

test('legacy start is rejected without claiming a YouTube tab', async () => {
  const runtime = loadServiceWorkerRuntime();
  let startResponse;
  assert.equal(runtime.onMessage({ type: 'start_karaoke' }, {
    tab: { id: 17, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  }, (value) => { startResponse = value; }), true);
  assert.equal(startResponse?.ok, false);
  assert.equal(startResponse?.error, 'app-required');
  assert.equal(runtime.sentToTabs.length, 0);
});

test('disconnected options and selection reject stale owner, revision, malformed, and arbitrary requests', async () => {
  const runtime = loadServiceWorkerRuntime();
  await sendState(runtime);
  runtime.sentToTabs.length = 0;
  for (const [message, sender] of [
    [optionsRequest(), { tab: { id: 18 } }],
    [optionsRequest(2), { tab: { id: 17 } }],
    [{ type: 'youtube_karaoke_lyrics_options_request' }, { tab: { id: 17 } }],
    [optionSelect('arbitrary'), { tab: { id: 17 } }],
  ]) {
    let responseValue;
    assert.equal(runtime.onMessage(message, sender, (value) => { responseValue = value; }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responseValue?.ok, false);
  }
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_lyrics' && message.lyrics), false);
});

test('disconnected selection cannot relay lyrics', async () => {
  const runtime = loadServiceWorkerRuntime();
  await sendState(runtime);
  let responseValue;
  assert.equal(runtime.onMessage(optionSelect('candidate'), { tab: { id: 17 } }, (value) => { responseValue = value; }), true);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_lyrics'), false);
  assert.equal(responseValue?.ok, false);
  assert.equal(responseValue?.error, 'app-required');
});

test('popup activation is rejected at the service-worker boundary', async () => {
  const runtime = loadServiceWorkerRuntime();
  let response;
  const handled = runtime.onMessage({
    type: 'youtube_karaoke_activation',
    active: true,
    source: 'popup',
  }, { tab: { id: 18, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }, (value) => {
    response = value;
  });

  assert.equal(handled, true);
  assert.equal(response?.ok, false);
  assert.equal(response?.error, 'app-required');
  assert.equal(runtime.sentToTabs.length, 0);
});

test('disconnected state does not become invalid-pairing without an App pairing', async () => {
  const runtime = loadServiceWorkerRuntime({ pairing: false });
  runtime.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision: 1, videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: 0 },
  }, { tab: { id: 17 } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.reconnectTimers.length, 1);
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_connection' && message.error === 'invalid-pairing'), false);
  assert.equal(runtime.sentToTabs.some(({ message }) => message.type === 'youtube_karaoke_lyrics_reset'), false);
});

test('cold-start state restores the stored owner before relay and never lets another tab steal it', async () => {
  const runtime = loadServiceWorkerRuntime();
  assert.equal(typeof runtime.worker.restoreStoredYouTubeTabId, 'function');

  const state = {
    type: 'youtube_karaoke_state',
    state: { videoId: 'dQw4w9WgXcQ', state: 'playing', positionMs: 1000 },
  };
  const sendState = async (tabId) => {
    runtime.onMessage(state, tabId == null ? { tab: {} } : { tab: { id: tabId } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState(null);
  await sendState(18);
  assert.equal(runtime.reconnectTimers.length, 0);
  assert.equal(runtime.ownerStorageReads(), 1);

  await sendState(17);
  assert.equal(runtime.reconnectTimers.length, 1);
  assert.equal(runtime.ownerStorageReads(), 2);
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.sockets.length, 1);

  runtime.onMessage(state, { tab: { id: 17 } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.sockets.length, 1);
  runtime.sockets[0].open();
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: 'dQw4w9WgXcQ',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'dQw4w9WgXcQ', offsetMs: 0, lines: [] },
  });

  const tabMessages = runtime.sentToTabs.map(({ tabId, message }) => ({ tabId, type: message.type, state: message.state }));
  assert.ok(tabMessages.some((item) => item.tabId === 17 && item.type === 'youtube_karaoke_connection' && item.state === 'connecting'));
  assert.ok(tabMessages.some((item) => item.tabId === 17 && item.type === 'youtube_karaoke_connection' && item.state === 'connected'));
  assert.ok(tabMessages.some((item) => item.tabId === 17 && item.type === 'youtube_karaoke_lyrics_status'));
  assert.ok(tabMessages.some((item) => item.tabId === 17 && item.type === 'youtube_karaoke_lyrics'));
  assert.ok(tabMessages.some((item) => item.tabId === 17 && item.type === undefined));
  assert.ok(runtime.sentToTabs.every(({ tabId }) => tabId === 17));

  runtime.resetOwner(17);
  await settle();
  const socketCountAfterOwnerLoss = runtime.sockets.length;
  const socketMessageCount = runtime.socketMessages.length;
  const ownerStorageReadsAfterOwnerLoss = runtime.ownerStorageReads();
  const reconnectCountAfterOwnerLoss = runtime.reconnectTimers.length;

  // Owner-loss deactivation intentionally closes the old App relay and clears
  // its cached messages; recovery belongs to the next owner connection test.
  await sendState(18);
  assert.equal(runtime.sockets.length, socketCountAfterOwnerLoss);
  assert.equal(runtime.socketMessages.length, socketMessageCount);
  assert.equal(runtime.ownerStorageReads(), ownerStorageReadsAfterOwnerLoss + 1);

  await sendState(17);
  assert.equal(runtime.sockets.length, socketCountAfterOwnerLoss);
  assert.equal(runtime.socketMessages.length, socketMessageCount);
  assert.equal(runtime.ownerStorageReads(), ownerStorageReadsAfterOwnerLoss + 2);
  assert.equal(runtime.reconnectTimers.length, reconnectCountAfterOwnerLoss + 1);
});

test('a reconnect accepts a lower revision after the previous extension socket closes', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const state = (revision, videoId) => ({
    type: 'youtube_karaoke_state',
    state: { revision, videoId, state: 'ad', positionMs: 0 },
  });

  runtime.onMessage(state(5, 'dQw4w9WgXcQ'), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.sockets[0].emit('close', { code: 1000 });

  runtime.reconnectTimers.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[1].open();
  runtime.onMessage(state(1, 'kJQP7kiw5Fk'), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.socketMessages.at(-1)?.state?.videoId, 'kJQP7kiw5Fk');
});

test('owner navigation resets relays so a fresh content script can use a lower revision', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const state = (revision, videoId) => ({
    type: 'youtube_karaoke_state',
    state: { revision, videoId, state: 'ad', positionMs: 0 },
  });

  runtime.onMessage(state(5, 'dQw4w9WgXcQ'), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.socketMessages.length = 0;

  runtime.updated(17, { status: 'loading' });
  assert.deepEqual(runtime.socketMessages, [{ type: 'youtube_karaoke_state_reset' }]);

  runtime.onMessage(state(1, 'kJQP7kiw5Fk'), sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.socketMessages.at(-1).state.videoId, 'kJQP7kiw5Fk');
});

test('SPA video changes clear relays before replaying the new owner state', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const sendState = async (state) => {
    runtime.onMessage({ type: 'youtube_karaoke_state', state }, sender);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState({
    revision: 1,
    videoId: 'SX_ViT4Ra7k',
    title: '米津玄師 - Lemon',
    channel: 'Kenshi Yonezu',
    state: 'playing',
    positionMs: 1000,
  });
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: 'SX_ViT4Ra7k',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'SX_ViT4Ra7k', offsetMs: 0, lines: [{ timeMs: 0, text: 'Lemon', words: null }] },
  });
  runtime.sentToTabs.length = 0;

  await sendState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 - 春雷',
    channel: 'Kenshi Yonezu 米津玄師',
    state: 'playing',
    positionMs: 500,
  });

  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_lyrics_reset'
      && message.videoId === 'zkNzxsaCunU'));
  assert.equal(runtime.sentToTabs.some(({ message }) => message.lyrics?.lines?.[0]?.text === 'Lemon'), false);
  assert.equal(runtime.socketMessages.at(-1)?.state?.videoId, 'zkNzxsaCunU');
});

test('corrected SPA metadata drops a same-video payload found from stale metadata', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const sendState = async (state) => {
    runtime.onMessage({ type: 'youtube_karaoke_state', state }, sender);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState({
    revision: 1,
    videoId: '6OC92oxs4gA',
    title: '米津玄師 - Lemon',
    channel: 'Kenshi Yonezu',
    state: 'playing',
    positionMs: 1000,
  });
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: '6OC92oxs4gA',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: '6OC92oxs4gA', offsetMs: 0, lines: [{ timeMs: 0, text: 'Lemon', words: null }] },
  });
  runtime.sentToTabs.length = 0;

  await sendState({
    revision: 1,
    videoId: '6OC92oxs4gA',
    title: '永遠是深夜有多好。 – 餘命數 Music Video',
    channel: 'ずっと真夜中でいいのに。 ZUTOMAYO',
    state: 'playing',
    positionMs: 200,
  });

  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_lyrics_reset' && message.videoId === '6OC92oxs4gA'));
  assert.equal(runtime.sentToTabs.some(({ message }) => message.lyrics?.lines?.[0]?.text === 'Lemon'), false);
});

test('missing pairing closes the loaded socket and reports invalid-pairing', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  runtime.onMessage({
    type: 'youtube_karaoke_state',
    state: { revision: 1, videoId: 'SX_ViT4Ra7k', state: 'playing', positionMs: 0 },
  }, sender);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: 'SX_ViT4Ra7k',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'SX_ViT4Ra7k', offsetMs: 0, lines: [{ timeMs: 0, text: 'Lemon', words: null }] },
  });
  runtime.sentToTabs.length = 0;

  runtime.storageChange({
    baseUrl: { newValue: undefined },
    token: { newValue: undefined },
  }, 'local');

  assert.equal(runtime.sockets[0].readyState, 3);
  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_connection'
      && message.state === 'error' && message.error === 'invalid-pairing'));
  assert.ok(runtime.sentToTabs.some(({ tabId, message }) =>
    tabId === 17 && message.type === 'youtube_karaoke_lyrics_reset'
      && message.videoId === 'SX_ViT4Ra7k'));
  assert.equal(runtime.reconnectTimers.filter(({ ms }) => ms === 1000).length, 1);
});

test('corrected SPA metadata retries after the mixed search finishes and suppresses its lyrics', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const sendState = async (state) => {
    runtime.onMessage({ type: 'youtube_karaoke_state', state }, sender);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState({
    revision: 1,
    videoId: 'SX_ViT4Ra7k',
    title: '米津玄師  Kenshi Yonezu  - Lemon',
    channel: 'Kenshi Yonezu  米津玄師',
    state: 'playing',
    positionMs: 1000,
  });
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.socketMessages.length = 0;

  await sendState({
    revision: 2,
    videoId: '6OC92oxs4gA',
    title: '米津玄師  Kenshi Yonezu  - Lemon',
    channel: 'ときどチャンネル / Tokido',
    state: 'playing',
    positionMs: 250,
  });
  await sendState({
    revision: 2,
    videoId: '6OC92oxs4gA',
    title: '永遠是深夜有多好。 – 餘命數 Music Video  (ZUTOMAYO - Time Left)',
    channel: 'ときどチャンネル / Tokido',
    state: 'playing',
    positionMs: 500,
  });

  assert.deepEqual(runtime.socketMessages.at(-1), {
    type: 'youtube_karaoke_search',
    videoId: '6OC92oxs4gA',
    title: '永遠是深夜有多好。 – 餘命數 Music Video  (ZUTOMAYO - Time Left)',
    channel: 'ときどチャンネル / Tokido',
    revision: 2,
  });

  runtime.socketMessages.length = 0;
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: '6OC92oxs4gA',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: '6OC92oxs4gA', offsetMs: 0, lines: [{ timeMs: 0, text: 'Lemon', words: null }] },
  });
  assert.equal(runtime.socketMessages.length, 1);
  assert.equal(runtime.socketMessages[0].type, 'youtube_karaoke_search');
  assert.equal(runtime.sentToTabs.some(({ message }) => message.lyrics?.lines?.[0]?.text === 'Lemon'), false);

  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: '6OC92oxs4gA',
    status: 'searching',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: '6OC92oxs4gA',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: '6OC92oxs4gA', offsetMs: 0, lines: [{ timeMs: 0, text: 'corrected', words: null }] },
  });
  assert.ok(runtime.sentToTabs.some(({ message }) => message.lyrics?.lines?.[0]?.text === 'corrected'));
});

test('metadata retry does not drop a loaded payload when the retry socket is already closed', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const sendState = async (state) => {
    runtime.onMessage({ type: 'youtube_karaoke_state', state }, sender);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState({
    revision: 1,
    videoId: 'SX_ViT4Ra7k',
    title: '米津玄師 - Lemon',
    channel: 'Kenshi Yonezu',
    state: 'playing',
    positionMs: 1000,
  });
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();

  await sendState({
    revision: 1,
    videoId: 'SX_ViT4Ra7k',
    title: '米津玄師  Kenshi Yonezu - Lemon',
    channel: 'Kenshi Yonezu  米津玄師',
    state: 'playing',
    positionMs: 1200,
  });
  runtime.sockets[0].readyState = 3;
  runtime.sentToTabs.length = 0;

  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics_status',
    videoId: 'SX_ViT4Ra7k',
    status: 'loaded',
    error: null,
  });
  runtime.sockets[0].message({
    type: 'youtube_karaoke_lyrics',
    lyrics: { videoId: 'SX_ViT4Ra7k', offsetMs: 0, lines: [{ timeMs: 0, text: 'Lemon', words: null }] },
  });

  assert.ok(runtime.sentToTabs.some(({ message }) =>
    message.type === 'youtube_karaoke_lyrics_status' && message.status === 'loaded'));
  assert.ok(runtime.sentToTabs.some(({ message }) => message.lyrics?.lines?.[0]?.text === 'Lemon'));
});

test('incomplete metadata correction does not start a duplicate force search', async () => {
  const runtime = loadServiceWorkerRuntime();
  const sender = { tab: { id: 17 } };
  const sendState = async (state) => {
    runtime.onMessage({ type: 'youtube_karaoke_state', state }, sender);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  await sendState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 Kenshi Yonezu - Shunrai',
    channel: '',
    state: 'playing',
    positionMs: 250,
  });
  runtime.reconnectTimers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.sockets[0].open();
  runtime.socketMessages.length = 0;

  await sendState({
    revision: 1,
    videoId: 'zkNzxsaCunU',
    title: '米津玄師 - 春雷 Kenshi Yonezu - Shunrai',
    channel: 'Kenshi Yonezu 米津玄師',
    state: 'playing',
    positionMs: 500,
  });

  assert.equal(runtime.socketMessages.filter((message) => message.type === 'youtube_karaoke_search').length, 0);
});
