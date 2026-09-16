const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = require('../src/service-worker.js');

assert.deepEqual(worker.createNativeDiscoveryRequest(), {
  type: 'discover',
  protocol: 'kanaric-youtube-v1',
});

assert.deepEqual(worker.normalizeNativeDiscoveryRequest({
  type: 'discover',
  protocol: 'kanaric-youtube-v1',
}), {
  type: 'discover',
  protocol: 'kanaric-youtube-v1',
});

const now = 1_700_000_000_000;
const valid = {
  ok: true,
  baseUrl: 'http://127.0.0.1:5720',
  token: 'synthetic-discovery-token',
  expiresAt: now + 60_000,
  pid: 1234,
};

assert.deepEqual(worker.normalizeNativeDiscoveryResponse(valid, now), valid);
assert.equal(worker.normalizeNativeDiscoveryResponse({
  ...valid,
  baseUrl: 'https://127.0.0.1:5720',
}, now), null);
assert.equal(worker.normalizeNativeDiscoveryResponse({
  ...valid,
  baseUrl: 'http://192.168.1.2:5720',
}, now), null);
assert.equal(worker.normalizeNativeDiscoveryResponse({
  ...valid,
  expiresAt: now,
}, now), null);
assert.equal(worker.normalizeNativeDiscoveryResponse({
  ...valid,
  token: '',
}, now), null);

const manifest = require('../src/manifest.json');
assert.deepEqual(manifest.host_permissions, [
  'https://www.youtube.com/*',
  'http://127.0.0.1/*',
]);
assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'standalone-lyrics-source.js')), false);

console.log('native-discovery.test: OK');
