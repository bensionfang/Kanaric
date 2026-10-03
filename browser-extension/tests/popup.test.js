const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { formatConnectionStatus } = require('../src/popup.js');

test('formatConnectionStatus exposes truthful lifecycle text', () => {
  assert.equal(formatConnectionStatus('connecting'), '連接中');
  assert.equal(formatConnectionStatus('connected'), '已連接');
  assert.equal(formatConnectionStatus('error', 'WebSocket failed'), 'App 未啟動: WebSocket failed');
  assert.equal(formatConnectionStatus('disconnected'), 'App 未啟動');
});

test('initPopup reflects the connection lifecycle from click and storage events', async () => {
  const originalDocument = global.document;
  const originalChrome = global.chrome;
  let onChanged;
  let runtimeResult = { ok: false, error: 'WebSocket failed' };
  const controls = {
    status: { textContent: '' },
    connect: { addEventListener: (_, handler) => { controls.connect.click = handler; } },
  };

  global.document = { getElementById: (id) => controls[id] };
  global.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: (handler) => { onChanged = handler; } },
    },
    runtime: { sendMessage: async () => runtimeResult },
  };

  try {
    const { initPopup } = require('../src/popup.js');
    initPopup();
    const click = controls.connect.click();
    assert.equal(controls.status.textContent, '連接中');
    await click;
    assert.equal(controls.status.textContent, 'App 未啟動: WebSocket failed');

    runtimeResult = { ok: true };
    onChanged({ connectionState: { newValue: 'connected' }, connectionError: { newValue: '' } });
    assert.equal(controls.status.textContent, '已連接');
    onChanged({ connectionState: { newValue: 'disconnected' }, connectionError: { newValue: '' } });
    assert.equal(controls.status.textContent, 'App 未啟動');
  } finally {
    global.document = originalDocument;
    global.chrome = originalChrome;
  }
});

test('popup exposes App status and retry discovery only', async () => {
  const source = fs.readFileSync(require.resolve('../src/popup.html'), 'utf8');
  assert.equal(source.includes('在此影片啟動'), false);
  assert.equal(source.includes('獨立模式'), false);

  const originalDocument = global.document;
  const originalChrome = global.chrome;
  const messages = [];
  const controls = {
    status: { textContent: '' },
    connect: { addEventListener: (_, handler) => { controls.connect.click = handler; } },
  };
  global.document = { getElementById: (id) => controls[id] };
  global.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
  };

  try {
    const { initPopup } = require('../src/popup.js');
    initPopup();
    await controls.connect.click();
    assert.deepEqual(messages, [{ type: 'connect_karaoke_app' }]);
    assert.equal(messages.some((message) => message.type === 'youtube_karaoke_activation'), false);
  } finally {
    global.document = originalDocument;
    global.chrome = originalChrome;
  }
});
