function formatConnectionStatus(state, error = '') {
  const labels = {
    connecting: '連接中',
    connected: '已連接',
    disconnected: 'App 未啟動',
    error: 'App 未啟動',
  };
  const label = labels[state] || state || 'App 未啟動';
  return error ? `${label}: ${error}` : label;
}

function initPopup() {
  const connectButton = document.getElementById('connect');
  const statusText = document.getElementById('status');
  const setStatus = (state, error = '') => { statusText.textContent = formatConnectionStatus(state, error); };

  chrome.storage.local.get(['connectionState', 'connectionError']).then((stored) => {
    if (stored.connectionState) setStatus(stored.connectionState, stored.connectionError || '');
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.connectionState) setStatus(changes.connectionState.newValue, changes.connectionError?.newValue || '');
  });

  connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    setStatus('connecting');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'connect_karaoke_app' });
      if (!result?.ok) setStatus('error', result?.error || 'connection failed');
    } catch (error) {
      setStatus('error', error.message);
    } finally {
      connectButton.disabled = false;
    }
  });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') initPopup();

if (typeof module !== 'undefined') module.exports = { formatConnectionStatus, initPopup };
