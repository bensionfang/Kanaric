const assert = require('assert');
const {
  createYouTubeLyricsCoordinator,
  resolveYouTubeLyricsStatus,
  shouldKeepYouTubeLyrics,
} = require('../web-app/youtube-karaoke-lyrics.js');

const trackA = { videoId: 'dQw4w9WgXcQ', title: 'Song A', channel: 'Artist A', revision: 1 };
const trackB = { videoId: 'kJQP7kiw5Fk', title: 'Song B', channel: 'Artist B', revision: 2 };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const injectedLyrics = [
    '[00:00.00]<ruby>未<rt>み</rt></ruby>来',
    '[00:00.00]#WORDS#0:0,1:420,2:900',
    '[00:01.00]plain',
  ].join('\n');
  const payloadCoordinator = createYouTubeLyricsCoordinator({
    search: async () => injectedLyrics,
    publish: () => {},
  });
  const payload = await payloadCoordinator.fetchForTest({
    videoId: 'abcdefghijk',
    title: '未来',
    channel: 'Artist',
  });
  assert.match(payload.lines[0].text, /<ruby>未<rt>み<\/rt><\/ruby>/);
  assert.deepStrictEqual(payload.lines[0].words, [[0, 0], [1, 420], [2, 900]]);
  assert.strictEqual(payload.lines[1].words, null);

  const revisionJobs = [];
  const revisionPublished = [];
  const revisionCoordinator = createYouTubeLyricsCoordinator({
    search: () => {
      const job = deferred();
      revisionJobs.push(job);
      return job.promise;
    },
    publish: (message) => revisionPublished.push(message),
  });
  assert.equal(revisionCoordinator.request({ ...trackA, revision: 10 }), true);
  assert.equal(revisionCoordinator.request({ ...trackA, revision: 11 }), true, 'new revision supersedes same-video lookup');
  await Promise.resolve();
  await Promise.resolve();
  revisionJobs[0].resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'stale revision' });
  revisionJobs[1].resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'current revision' });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);
  assert.equal(revisionPublished.some((message) => message.lyrics === 'stale revision'), false,
    'stale same-video revision cannot publish');
  assert.equal(revisionPublished.at(-1).lyrics, 'current revision');

  const correctionJobs = [];
  const correctionPublished = [];
  const correctionCoordinator = createYouTubeLyricsCoordinator({
    search: () => {
      const job = deferred();
      correctionJobs.push(job);
      return job.promise;
    },
    publish: (message) => correctionPublished.push(message),
  });
  assert.equal(correctionCoordinator.request({ ...trackA, revision: 20, title: 'Stale title' }), true);
  assert.equal(correctionCoordinator.request({ ...trackA, revision: 20, title: 'Correct title' }), true,
    'same-revision metadata correction replaces the active lookup');
  await Promise.resolve();
  await Promise.resolve();
  correctionJobs[0].resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'stale metadata' });
  correctionJobs[1].resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'correct metadata' });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);
  assert.equal(correctionPublished.some((message) => message.lyrics === 'stale metadata'), false,
    'late same-revision metadata result cannot publish');
  assert.equal(correctionPublished.at(-1).lyrics, 'correct metadata');

  const revisionAdvanceCases = [
    { name: 'ad', state: 'ad', title: 'Song A', channel: 'Artist A' },
    { name: 'error', state: 'error', title: 'Song A', channel: 'Artist A' },
    { name: 'missing metadata', state: 'playing', title: '', channel: '' },
  ];
  for (const testCase of revisionAdvanceCases) {
    const jobs = [];
    const published = [];
    const coordinator = createYouTubeLyricsCoordinator({
      search: () => {
        const job = deferred();
        jobs.push(job);
        return job.promise;
      },
      publish: (message) => published.push(message),
    });
    const previousState = { ...trackA, revision: 30, state: 'playing' };
    const advancedState = {
      ...trackA,
      revision: 31,
      state: testCase.state,
      title: testCase.title,
      channel: testCase.channel,
    };
    assert.equal(coordinator.request(previousState), true, `${testCase.name}: pending lookup starts`);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jobs.length, 1, `${testCase.name}: lookup is pending before revision advance`);
    assert.ok(advancedState.revision > previousState.revision);
    coordinator.resetActive();
    assert.equal(coordinator.status(previousState.videoId), null,
      `${testCase.name}: revision advance invalidates the active generation`);
    jobs[0].resolve({ status: 'loaded', videoId: previousState.videoId, lyrics: `stale-${testCase.name}` });
    await Promise.resolve();
    await Promise.resolve();
    await waitMs(0);
    assert.equal(published.some((message) => message.lyrics === `stale-${testCase.name}`), false,
      `${testCase.name}: late revision-1 lyrics cannot publish`);
    assert.equal(published.some((message) => message.status === 'loaded'), false,
      `${testCase.name}: late revision-1 status cannot publish`);
  }

  const pending = new Map();
  const published = [];
  const coordinator = createYouTubeLyricsCoordinator({
    search: (state) => {
      const job = deferred();
      pending.set(state.videoId, job);
      return job.promise;
    },
    publish: (message) => published.push(message),
  });

  assert.strictEqual(coordinator.request(trackA), true, 'new video starts one lookup');
  assert.strictEqual(coordinator.request(trackA), false, 'same video is not searched twice');
  assert.deepStrictEqual(published, [{ videoId: trackA.videoId, status: 'searching' }]);

  assert.strictEqual(coordinator.request(trackB), true, 'new video supersedes the old lookup');
  await Promise.resolve();
  await Promise.resolve();
  pending.get(trackA.videoId).resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'old' });
  pending.get(trackB.videoId).resolve({ status: 'loaded', videoId: trackB.videoId, lyrics: 'new' });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);
  assert.deepStrictEqual(published, [
    { videoId: trackA.videoId, status: 'searching' },
    { videoId: trackB.videoId, status: 'searching' },
    { videoId: trackB.videoId, status: 'loaded', lyrics: 'new' },
  ], 'stale result cannot publish over the new video');

  assert.strictEqual(coordinator.request(trackA), true, 'a stale lookup can be retried after returning to its video');
  await Promise.resolve();
  await Promise.resolve();
  pending.get(trackA.videoId).resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'retry' });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);

  assert.strictEqual(coordinator.request(trackB, { force: true }), true, 'manual re-search bypasses completed lookup');
  assert.strictEqual(coordinator.request(trackB, { force: true }), false, 'manual clicks do not overlap a lookup');
  await Promise.resolve();
  await Promise.resolve();
  pending.get(trackB.videoId).resolve({ status: 'no_lyrics', videoId: trackB.videoId });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);
  assert.strictEqual(published.at(-1).status, 'no_lyrics');
  assert.strictEqual(coordinator.request({ ...trackA, title: '', channel: '' }), false, 'metadata is required before lookup');

  const reloadPublished = [];
  const reloadCoordinator = createYouTubeLyricsCoordinator({
    search: async () => ({ status: 'loaded', lyrics: 'cached' }),
    publish: (message) => reloadPublished.push(message),
  });
  assert.equal(reloadCoordinator.request(trackA), true);
  await waitMs(0);
  reloadPublished.length = 0;
  reloadCoordinator.resetActive?.();
  assert.equal(reloadCoordinator.request(trackA), false, 'same-video reload reuses the completed lookup');
  assert.equal(reloadPublished.length, 1, 'same-video reload publishes exactly one cached result');
  assert.deepStrictEqual(reloadPublished.at(-1), {
    videoId: trackA.videoId,
    status: 'loaded',
    lyrics: 'cached',
  }, 'same-video reload republishes cached lyrics after the active page resets');

  const timeoutPublished = [];
  const timeoutCoordinator = createYouTubeLyricsCoordinator({
    timeoutMs: 10,
    search: () => new Promise(() => {}),
    publish: (message) => timeoutPublished.push(message),
  });
  assert.strictEqual(timeoutCoordinator.request(trackA), true, 'lookup starts before its deadline');
  await waitMs(30);
  assert.deepStrictEqual(timeoutPublished.at(-1), {
    videoId: trackA.videoId,
    status: 'error',
    error: { code: 'lyrics-search-timeout', message: 'lyrics search timed out' },
  });

  assert.equal(shouldKeepYouTubeLyrics(
    { videoId: trackA.videoId, lines: [{ timeMs: 0, text: 'cached' }] },
    { videoId: trackA.videoId, status: 'no_lyrics' },
  ), true, 'a failed force search keeps same-video cached lyrics');
  assert.equal(resolveYouTubeLyricsStatus(
    { videoId: trackA.videoId, lines: [{ timeMs: 0, text: 'cached' }] },
    { videoId: trackA.videoId, status: 'no_lyrics' },
  ), 'loaded', 'a failed same-video retry cannot downgrade visible lyrics to no_lyrics');
  assert.equal(resolveYouTubeLyricsStatus(
    { videoId: trackA.videoId, lines: [{ timeMs: 0, text: 'old' }] },
    { videoId: trackB.videoId, status: 'no_lyrics' },
  ), 'no_lyrics', 'a new video still clears the previous video status');

  const supersedeJobs = [];
  const supersedePublished = [];
  const supersedeCoordinator = createYouTubeLyricsCoordinator({
    search: () => {
      const job = deferred();
      supersedeJobs.push(job);
      return job.promise;
    },
    publish: (message) => supersedePublished.push(message),
  });
  assert.equal(supersedeCoordinator.request(trackA), true);
  assert.equal(supersedeCoordinator.request({ ...trackA, title: 'Correct title' }, { force: true }), true,
    'metadata correction supersedes an unfinished stale lookup');
  await Promise.resolve();
  await Promise.resolve();
  supersedeJobs[0].resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'stale' });
  supersedeJobs[1].resolve({ status: 'no_lyrics', videoId: trackA.videoId });
  await Promise.resolve();
  await Promise.resolve();
  await waitMs(0);
  assert.equal(supersedePublished.some((message) => message.lyrics === 'stale'), false,
    'the stale lookup cannot publish after metadata correction');
  assert.equal(shouldKeepYouTubeLyrics(
    { videoId: trackA.videoId, lines: [{ timeMs: 0, text: 'cached' }] },
    { videoId: trackB.videoId, status: 'searching' },
  ), false, 'a new video clears the old lyrics');

  const sharedJobs = [];
  const sharedCoordinator = createYouTubeLyricsCoordinator({
    search: (state, options) => {
      const job = deferred();
      sharedJobs.push({ state, options, job });
      return job.promise;
    },
    publish: () => {},
  });
  const prefetchState = { videoId: trackA.videoId, title: trackA.title, channel: trackA.channel };
  const prefetchPromise = sharedCoordinator.prefetch(prefetchState);
  assert.ok(prefetchPromise && typeof prefetchPromise.then === 'function', 'prefetch returns a promise');
  assert.equal(sharedCoordinator.status(trackA.videoId), 'searching');
  assert.equal(sharedCoordinator.request({ ...prefetchState, revision: 99 }), true,
    'canonical lookup can attach to a prefetch before owner revision exists');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sharedJobs.length, 1, 'prefetch and canonical share one source lookup');
  assert.deepStrictEqual(sharedJobs[0].options, { force: false });
  sharedJobs[0].job.resolve({ status: 'loaded', videoId: trackA.videoId, lyrics: 'shared' });
  const prefetchResult = await prefetchPromise;
  assert.deepStrictEqual(prefetchResult, { videoId: trackA.videoId, status: 'loaded' },
    'prefetch never returns raw lyrics');
  await Promise.resolve();
  await Promise.resolve();

  const forceJobs = [];
  const forceCoordinator = createYouTubeLyricsCoordinator({
    search: (state, options) => {
      const job = deferred();
      forceJobs.push({ state, options, job });
      return job.promise;
    },
    publish: () => {},
  });
  const forceState = { ...trackB, revision: 101 };
  const first = forceCoordinator.prefetch(forceState);
  await Promise.resolve();
  forceJobs[0].job.resolve({ status: 'no_lyrics', videoId: trackB.videoId });
  assert.deepStrictEqual(await first, { videoId: trackB.videoId, status: 'no_lyrics' });
  assert.equal(forceCoordinator.request(forceState), true, 'initial canonical does not skip a prefetch no-lyrics result');
  await Promise.resolve();
  assert.equal(forceJobs.length, 2);
  assert.deepStrictEqual(forceJobs[1].options, { force: false });
  forceJobs[1].job.resolve({ status: 'no_lyrics', videoId: trackB.videoId });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(forceCoordinator.request(forceState, { force: true }), true, 'explicit reload forces a new lookup');
  await Promise.resolve();
  assert.equal(forceJobs.length, 3);
  assert.deepStrictEqual(forceJobs[2].options, { force: true });
  forceJobs[2].job.resolve({ status: 'loaded', videoId: trackB.videoId, lyrics: 'forced' });
  await Promise.resolve();
  await Promise.resolve();

  const negativeJobs = [];
  const negativeCoordinator = createYouTubeLyricsCoordinator({
    search: (state, options) => {
      const job = deferred();
      negativeJobs.push({ state, options, job });
      return job.promise;
    },
    publish: () => {},
  });
  const negativeState = { ...trackA, revision: 202 };
  const firstNegative = negativeCoordinator.prefetch(negativeState);
  await Promise.resolve();
  negativeJobs[0].job.resolve({ status: 'no_lyrics', videoId: trackA.videoId });
  assert.deepStrictEqual(await firstNegative, { videoId: trackA.videoId, status: 'no_lyrics' });
  const secondNegative = negativeCoordinator.prefetch(negativeState);
  await Promise.resolve();
  assert.equal(negativeJobs.length, 2, 'completed no_lyrics does not permanently suppress a retry');
  negativeJobs[1].job.resolve({ status: 'no_lyrics', videoId: trackA.videoId });
  assert.deepStrictEqual(await secondNegative, { videoId: trackA.videoId, status: 'no_lyrics' });

  const errorJobs = [];
  const errorCoordinator = createYouTubeLyricsCoordinator({
    search: (state, options) => {
      const job = deferred();
      errorJobs.push({ state, options, job });
      return job.promise;
    },
    publish: () => {},
  });
  const errorState = { ...trackB, revision: 203 };
  const firstError = errorCoordinator.prefetch(errorState);
  await Promise.resolve();
  errorJobs[0].job.resolve({
    status: 'error', videoId: trackB.videoId,
    error: { code: 'upstream-failed', message: 'upstream failed' },
  });
  assert.deepStrictEqual(await firstError, {
    videoId: trackB.videoId, status: 'error', error: { code: 'upstream-failed' },
  });
  const secondError = errorCoordinator.prefetch(errorState);
  await Promise.resolve();
  assert.equal(errorJobs.length, 2, 'completed error does not permanently suppress a retry');
  errorJobs[1].job.resolve({
    status: 'error', videoId: trackB.videoId,
    error: { code: 'upstream-failed', message: 'upstream failed' },
  });
  assert.deepStrictEqual(await secondError, {
    videoId: trackB.videoId, status: 'error', error: { code: 'upstream-failed' },
  });

  console.log('test_youtube_karaoke_lyrics: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
