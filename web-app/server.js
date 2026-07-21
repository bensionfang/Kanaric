/**
 * Kanaric 網頁管理後台 (Node.js + Express)
 * 負責提供網頁版的介面，包含：
 * 1. 橋接與攔截 Python 媒體監聽腳本的輸出。
 * 2. 將即時媒體狀態透過 WebSocket 廣播給網頁前端與動態島。
 * 3. 處理 SQLite 資料庫的存取 (聽歌歷史、歌詞快取)。
 * 4. 提供 RESTful API 供前端介面使用。
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5720;
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || '../lyrics_data.db');
const PARENT_DIR = path.join(__dirname, '..');

// Global media state continuously updated by python script
let currentMediaState = {
  title: "",
  artist: "",
  position: 0.0,
  is_playing: false
};

// Middleware
// 這台伺服器綁 127.0.0.1、沒有任何 auth,所有正當客戶端都是同源的 (網頁後台) 或
// 根本不是瀏覽器 (C# 靈動島用 HttpClient)。所以不開 CORS,而且主動擋掉任何從別的
// 網站發過來的請求 —— 綁 localhost 擋不住這種攻擊:使用者只要在開著 Kanaric 時瀏覽
// 任一網頁,那個網頁就能打這裡的 API (把 llm_base_url 改成攻擊者的位址,再觸發
// /api/llm-models,BYOK 的 API key 就送出去了)。
//
// 兩層都要,少一層就有破口:
//   Origin        —— fetch/XHR 一定帶;但 <script src>/<img> 這類不帶。
//   Sec-Fetch-Site —— 瀏覽器對「所有」請求都帶,包含 <script src>,補上上面那個破口。
// 非瀏覽器客戶端兩個 header 都沒有,照常放行 (能在本機跑程式的攻擊者早就贏了)。
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-site requests are not allowed' });
  }
  next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 使用者資料目錄 (打包後由 Electron 指向 %APPDATA%,開發模式維持專案根目錄)
const DATA_DIR = process.env.DATA_DIR || PARENT_DIR;

// Python Environment Detection
const venvPythonPath = path.join(PARENT_DIR, 'venv', 'Scripts', 'python.exe');
const pythonCmd = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

// --- LLM API key (BYOK) ---
// key 絕不放 settings.json (GET /api/settings 會整份吐回)。獨立存 DATA_DIR/secrets.json,
// 打包版經 Electron safeStorage (DPAPI) 加密;dev 模式 (純 node) 明文 + 警告。
// 只透過 spawnPy 的環境變數傳給 Python,不進 log、不進 URL。
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
let safeStorage = null;
try {
  const electron = require('electron');
  if (electron && electron.safeStorage) safeStorage = electron.safeStorage;
} catch (e) {}

function canEncrypt() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}

function loadLlmKey() {
  try {
    const s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    if (s.llm_api_key_enc && canEncrypt()) {
      return safeStorage.decryptString(Buffer.from(s.llm_api_key_enc, 'base64'));
    }
    if (s.llm_api_key) return s.llm_api_key;
  } catch (e) {}
  return '';
}
let llmApiKey = loadLlmKey();

function saveLlmKey(key) {
  llmApiKey = key || '';
  if (!llmApiKey) {
    try { fs.unlinkSync(SECRETS_FILE); } catch (e) {}
    return;
  }
  let payload;
  if (canEncrypt()) {
    payload = { llm_api_key_enc: safeStorage.encryptString(llmApiKey).toString('base64') };
  } else {
    console.warn('[llm] safeStorage 不可用,API key 以明文寫入 secrets.json (dev 模式)');
    payload = { llm_api_key: llmApiKey };
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(payload), 'utf8');
}

// 打包模式下改用 PyInstaller 產出的 pytools.exe;開發模式用 python pytools.py
const PYTOOLS_EXE = process.env.PYTOOLS_EXE || '';
function spawnPy(args, opts = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (llmApiKey) env.LLM_API_KEY = llmApiKey;
  const base = { env, windowsHide: true, ...opts };
  if (PYTOOLS_EXE) {
    return spawn(PYTOOLS_EXE, args, { cwd: path.dirname(PYTOOLS_EXE), ...base });
  }
  return spawn(pythonCmd, [path.join(PARENT_DIR, 'pytools.py'), ...args], { cwd: PARENT_DIR, ...base });
}

// Database initialization
console.log(`Connecting to SQLite database at: ${DB_PATH}`);
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('✓ Connected to SQLite database');
    db.run('PRAGMA journal_mode=WAL;');
    
    db.run(`
      CREATE TABLE IF NOT EXISTS listening_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        duration INTEGER DEFAULT 180,
        played_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {
      // Alter table to add album column if it doesn't exist
      db.run('ALTER TABLE listening_history ADD COLUMN album TEXT', (err) => {
        if (!err) console.log('✓ Added album column to listening_history');
      });
      // 統計用的版本無關歌名:剝掉第一個括號起的尾綴 ((Live) / (feat. …) / (Dome Tour …))。
      // virtual generated column,不佔空間也不用改任何寫入端;快取類的表刻意不加這欄,
      // 那些是歌詞資料,Live 版跟錄音室版必須分開。instr > 1 是為了歌名本身就以括號開頭時不被清空。
      db.run(`ALTER TABLE listening_history ADD COLUMN base_title TEXT
              GENERATED ALWAYS AS (
                TRIM(CASE WHEN instr(replace(title, '（', '('), '(') > 1
                     THEN substr(title, 1, instr(replace(title, '（', '('), '(') - 1)
                     ELSE title END)
              ) VIRTUAL`, (err) => {
        if (!err) console.log('✓ Added base_title column to listening_history');
      });
    });

    // 全新安裝時建立其餘資料表 (schema 與 db.py 一致)
    db.run(`CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))`);
    db.run(`CREATE TABLE IF NOT EXISTS word_corrections (artist TEXT, title TEXT, word TEXT, hira TEXT, PRIMARY KEY (artist, title, word))`);
    db.run(`CREATE TABLE IF NOT EXISTS sync_offsets (artist TEXT, title TEXT, offset REAL, PRIMARY KEY (artist, title))`);
    // 別名快取要等建表的 callback 才載入 —— node-sqlite3 不保證 db.run/db.all 依序執行,
    // 全新 DB 上先發 SELECT 會撞 "no such table"
    db.run(`CREATE TABLE IF NOT EXISTS artist_aliases (alias TEXT PRIMARY KEY, true_name TEXT)`, () => loadAliases());
    db.run(`CREATE TABLE IF NOT EXISTS search_overrides (raw_artist TEXT, raw_title TEXT, search_artist TEXT, search_title TEXT, PRIMARY KEY (raw_artist, raw_title))`);
  }
});

// 歌手正規名對照。handleMediaUpdate 是同步的,不能在那裡等 db.get,所以整張表
// (數列而已) 開機載入進記憶體,/api/aliases 寫入後同步更新這份快取。
const artistAliases = new Map();
function loadAliases() {
  db.all('SELECT alias, true_name FROM artist_aliases', [], (err, rows) => {
    if (err) return console.error('載入歌手別名失敗:', err.message);
    artistAliases.clear();
    for (const r of rows || []) if (r.true_name) artistAliases.set(r.alias, r.true_name);
  });
}
const canonicalArtist = (a) => artistAliases.get(a) || a;

// 平假名/片假名 (日文獨有,中文沒有) —— 用來判斷字串是不是日文
const hasKana = (s) => /[぀-ヿ]/.test(s || '');

// --- iTunes JP Resolution Cache ---
const itunesCache = new Map();

async function getResolvedMetadata(title, artist, duration) {
  const key = `${title}-${artist}`;
  if (itunesCache.has(key)) return itunesCache.get(key);

  // 先寫入原始資料避免重複發送請求
  itunesCache.set(key, { title, artist });

  // 標題已含假名 = 已經是日文,Spotify 沒翻譯,不用還原 —— 硬查日區只會被別的版本
  // (Live/Remix 常是搜尋第一個 hit) 蓋掉。還原只該處理 Spotify 把日文譯成中文漢字 (無假名) 的情況。
  if (hasKana(title)) return { title, artist };

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(title + ' ' + artist)}&country=JP&entity=song&limit=1`;
    const resp = await fetch(url, { timeout: 3000 });
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      const hit = data.results[0];
      const result = {
        title: hit.trackName || title,
        artist: hit.artistName || artist
      };
      // 採用還原的條件二選一:
      //  (1) 結果含假名 → 確定是日文 (中文歌沒假名,擋掉污染)
      //  (2) 時長吻合 ±3s → 確定是同一首,不管字是全漢字還是什麼都信任 (補回全漢字日文歌)
      const hitDur = hit.trackTimeMillis ? hit.trackTimeMillis / 1000 : null;
      const durOk = !!(duration && hitDur && Math.abs(hitDur - duration) <= 3);
      if (hasKana(result.title) || hasKana(result.artist) || durOk) {
        itunesCache.set(key, result);
        return result;
      }
    }
  } catch (e) {
    console.error("iTunes API error:", e.message);
  }
  
  return { title, artist };
}

// Start Media Monitor Bridge
let lastPlayedSongId = '';
let playTimer = null;
let songLogged = false;
let accumulatedMs = 0;
let lastResumeTime = 0;

global.handleMediaUpdate = function(rawState) {
  try {
    // iTunes 跨區還原攔截器
    if (rawState.title && rawState.artist) {
      const key = `${rawState.title}-${rawState.artist}`;
      if (!itunesCache.has(key)) {
         getResolvedMetadata(rawState.title, rawState.artist, rawState.duration);
      } else {
         const resolved = itunesCache.get(key);
         rawState.original_title = rawState.title;
         rawState.original_artist = rawState.artist;
         rawState.title = resolved.title;
         rawState.artist = resolved.artist;
      }
    }
    
    // 歌手別名收斂。這裡是所有下游資料的唯一入口,在這改一次,cache 的鍵、
    // listening_history 的寫入、Python 端的讀音提示就全部只認正規名 —— 同一首歌
    // 不會因為 Spotify 給「魚韻」、YouTube 給「サカナクション」而分裂成兩筆。
    if (rawState.artist) {
      const canon = canonicalArtist(rawState.artist);
      if (canon !== rawState.artist) {
        if (!rawState.original_artist) rawState.original_artist = rawState.artist;
        rawState.artist = canon;
      }
    }

    // 沒有播放來源時,上一首的 iTunes 原名也要跟著清掉 (合併是淺層的,不清就會留著)
    if (!rawState.title) {
      rawState.original_title = '';
      rawState.original_artist = '';
    }

    const state = rawState;
    currentMediaState = { ...currentMediaState, ...state };
    
    if (global.broadcast) {
      global.broadcast({ type: 'media_state', state: currentMediaState });
    }
    
    if (state.is_playing && state.title && state.artist) {
      const songId = `${state.title}-${state.artist}`;
      
      // 換新歌
      if (songId !== lastPlayedSongId) {
        lastPlayedSongId = songId;
        songLogged = false;
        accumulatedMs = 0;
        lastResumeTime = Date.now();
        if (playTimer) clearTimeout(playTimer);
        
        playTimer = setTimeout(() => {
          songLogged = true;
          db.run(
            'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
            [state.artist, state.title, state.album || null, Math.round(state.duration) || 180]
          );
        }, 30000);
      } 
      // 同一首歌暫停後又繼續播放
      else if (!songLogged && !playTimer) {
        lastResumeTime = Date.now();
        const remainingMs = Math.max(0, 30000 - accumulatedMs);
        playTimer = setTimeout(() => {
          songLogged = true;
          db.run(
            'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
            [state.artist, state.title, state.album || null, Math.round(state.duration) || 180]
          );
        }, remainingMs);
      }
    } else if (!state.is_playing) {
      // 暫停時取消計時，並累加已播放時間
      if (playTimer) {
        clearTimeout(playTimer);
        playTimer = null;
        if (!songLogged && lastResumeTime > 0) {
          accumulatedMs += (Date.now() - lastResumeTime);
        }
      }
      if (!state.title) {
        lastPlayedSongId = '';
        songLogged = false;
        accumulatedMs = 0;
      }
    }
  } catch (e) {
    console.error("Error processing media update:", e);
  }
};

/**
 * 啟動 Python 媒體監聽橋接器
 * 將 media_monitor.py 作為子進程啟動，並攔截其 stdout 輸出。
 */
function startMediaMonitor() {
  if (os.platform() !== 'win32') {
    console.log("Running in Cloud Mode (Non-Windows). Bypassing local media monitor spawn.");
    return;
  }

  console.log(`Starting media monitor bridge (${PYTOOLS_EXE || pythonCmd})`);
  const monitorProcess = spawnPy(['monitor']);
  global.monitorProcess = monitorProcess; // Electron 殼結束時需要收掉這個子進程
  
  let stdoutBuffer = '';

  monitorProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Keep the last incomplete part in the buffer
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const rawState = JSON.parse(line.trim());
          global.handleMediaUpdate(rawState);
        } catch (e) {
          // ignore JSON parsing errors
        }
      }
    }
  });
  
  monitorProcess.stderr.on('data', (data) => {
    console.error('Media Monitor Error:', data.toString('utf-8'));
  });
  
  monitorProcess.on('close', (code) => {
    if (global.isShuttingDown) return; // App 正在結束,不要重生
    console.log(`Media monitor bridge exited with code ${code}. Restarting in 3 seconds...`);
    setTimeout(startMediaMonitor, 3000);
  });
}

startMediaMonitor();

// 每次換頁都是整頁重載,播放列若等前端輪詢才填值就會閃一下 (--、0:00、預設封面)。
// 直接把目前播放狀態渲染進 HTML,畫面一出來就是對的。
app.use((req, res, next) => {
  const m = currentMediaState || {};
  res.locals.media = {
    title: m.title || '',
    artist: m.artist || '',
    position: m.position || 0,
    duration: m.duration || 0,
    is_playing: !!m.is_playing,
    thumbnail: m.thumbnail || '',
    shuffle: !!m.shuffle,
    repeat: m.repeat || 0
  };
  // 備選歌詞按鈕的狀態也一起渲染,否則會先畫成未搜尋、等前端問完 server 才變綠 (閃一下)
  const job = optionJobs.get(jobKey(m.artist, m.title));
  res.locals.optState = {
    status: job ? job.status : 'idle',
    count: job && job.status === 'done' ? job.options.length : 0
  };
  next();
});

// Pages
app.get('/', (req, res) => {
  res.render('index', { activePage: 'home' });
});

app.get('/stats', (req, res) => {
  res.render('stats', { activePage: 'stats' });
});

app.get('/leaderboard', (req, res) => {
  res.render('leaderboard', { activePage: 'leaderboard' });
});

app.get('/wrapped', (req, res) => {
  res.render('wrapped', { activePage: 'wrapped' });
});

app.get('/editor', (req, res) => {
  res.render('editor', { activePage: 'editor' });
});

// REST APIs
// 1. 取得目前音樂的狀態 (供前端初次載入時同步)
app.get('/api/current-media', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(currentMediaState);
});

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

app.get('/api/settings', (req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.island_lines === undefined) data.island_lines = 2;
      res.json(data);
    } else {
      res.json({ island_lines: 2 });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    let currentSettings = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
    const newSettings = { ...currentSettings, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 4), 'utf8');
    if (global.broadcast) {
      global.broadcast({ type: 'settings_updated', settings: newSettings });
    }
    res.json({ success: true, settings: newSettings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LLM key 端點只寫不讀:POST 設定/清除,GET 只回有沒有設定 + 後四碼
app.get('/api/llm-key', (req, res) => {
  res.json({ set: !!llmApiKey, last4: llmApiKey ? llmApiKey.slice(-4) : '' });
});

// 依 key 前綴猜供應商,再實際拿 key 驗證。長前綴排前面 (sk-ant-/sk-or- 也符合 sk-)。
// 驗證端點預設 /models;OpenRouter 的 /models 是公開端點 (不帶 key 也回 200,亂打的
// key 會被誤判有效),所以它改用需要認證的 /auth/key。
// prefer 撞不到時退回模型清單裡第一個,所以供應商改版模型名也不會壞。
const LLM_PROVIDERS = [
  { name: 'Anthropic',  base: 'https://api.anthropic.com/v1',  prefer: 'claude-haiku-4-5',        match: k => k.startsWith('sk-ant-') },
  { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1',  prefer: 'deepseek/deepseek-chat',  match: k => k.startsWith('sk-or-'),
    auth: 'https://openrouter.ai/api/v1/auth/key' },
  { name: 'Groq',       base: 'https://api.groq.com/openai/v1', prefer: 'llama-3.3-70b-versatile', match: k => k.startsWith('gsk_') },
  { name: 'Gemini',     base: 'https://generativelanguage.googleapis.com/v1beta/openai', prefer: 'gemini-2.5-flash', match: k => k.startsWith('AIza') },
  { name: 'DeepSeek',   base: 'https://api.deepseek.com/v1',   prefer: 'deepseek-chat',           match: k => k.startsWith('sk-') },
  { name: 'OpenAI',     base: 'https://api.openai.com/v1',     prefer: 'gpt-4o-mini',             match: k => k.startsWith('sk-') },
];

async function detectLlmProvider(key) {
  const matched = LLM_PROVIDERS.filter(p => p.match(key));
  for (const p of (matched.length ? matched : LLM_PROVIDERS)) {
    try {
      const headers = { Authorization: `Bearer ${key}` };
      const auth = await fetch(p.auth || (p.base + '/models'), { headers, signal: AbortSignal.timeout(6000) });
      if (!auth.ok) continue;
      // key 驗過了,再抓模型清單挑 model (抓不到就用 prefer)
      let ids = [];
      try {
        const r = await fetch(p.base + '/models', { headers, signal: AbortSignal.timeout(6000) });
        const data = r.ok ? await r.json() : null;
        if (data && Array.isArray(data.data)) ids = data.data.map(m => m.id);
      } catch (e) {}
      const model = ids.find(id => id === p.prefer) || ids.find(id => id.includes(p.prefer)) || ids[0] || p.prefer;
      return { name: p.name, base_url: p.base, model };
    } catch (e) {}
  }
  return null;
}

// Model 欄的 datalist 建議清單:用現設 Base URL + 已存 key 打 /models (key 不出 server)。
// 沒 key 也試 (Ollama 不用 key);失敗回空陣列,前端 datalist 空著、輸入框照常手打。
app.get('/api/llm-models', async (req, res) => {
  try {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
    if (!cur.llm_base_url) return res.json({ models: [] });
    const headers = llmApiKey ? { Authorization: `Bearer ${llmApiKey}` } : {};
    const r = await fetch(cur.llm_base_url.replace(/\/$/, '') + '/models', { headers, signal: AbortSignal.timeout(6000) });
    const data = r.ok ? await r.json() : null;
    const models = (data && Array.isArray(data.data)) ? data.data.map(m => m.id) : [];
    res.json({ models, error: r.ok ? undefined : `HTTP ${r.status}` });
  } catch (e) {
    res.json({ models: [], error: e.message });
  }
});

// 檢查 GitHub Releases 是否有新版:GitHub API 對匿名請求限 60 次/小時/IP,
// 每頁載入都打會很容易超,所以結果快取 1 小時。
// ponytail: 版本比較是單純字串不等於 (不是 semver),假設版號只會手動往上調;
// 開發環境本機版號領先 tag 時會誤報有更新,無傷大雅。
const APP_VERSION = require('./package.json').version;
const GITHUB_REPO = 'bensionfang/Kanaric';
let updateCheckCache = null;

// 側欄頁尾的版號/署名要用,掛 locals 讓每個 res.render 都拿得到,不用逐條 route 傳
app.locals.appVersion = APP_VERSION;
app.locals.githubRepo = GITHUB_REPO;

app.get('/api/update-check', async (req, res) => {
  try {
    if (!updateCheckCache || Date.now() - updateCheckCache.checkedAt > 3600_000) {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      updateCheckCache = {
        checkedAt: Date.now(),
        latest: (data.tag_name || '').replace(/^v/, ''),
        url: data.html_url
      };
    }
    res.json({
      current: APP_VERSION,
      latest: updateCheckCache.latest,
      url: updateCheckCache.url,
      hasUpdate: !!updateCheckCache.latest && updateCheckCache.latest !== APP_VERSION
    });
  } catch (e) {
    res.json({ current: APP_VERSION, latest: null, url: null, hasUpdate: false });
  }
});

app.post('/api/llm-key', async (req, res) => {
  try {
    saveLlmKey((req.body.key || '').trim());

    // 存 key 順便偵測供應商,自動帶入 Base URL / Model —— 只填空欄位,不蓋使用者設定
    let detected = null;
    if (llmApiKey) {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
      if (!cur.llm_base_url || !cur.llm_model) {
        detected = await detectLlmProvider(llmApiKey);
        if (detected) {
          if (cur.llm_base_url) detected.base_url = cur.llm_base_url;
          if (cur.llm_model) detected.model = cur.llm_model;
          fs.writeFileSync(SETTINGS_FILE, JSON.stringify(
            { ...cur, llm_base_url: detected.base_url, llm_model: detected.model }, null, 4), 'utf8');
        }
      }
    }
    res.json({ success: true, set: !!llmApiKey, detected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 目前系統上有哪些媒體來源 (設定選單的「音訊來源」用)。每次打開子選單才掃一次。
app.get('/api/media-sources', async (req, res) => {
  if (os.platform() !== 'win32') return res.json({ current: 'auto', sources: [] });
  const result = await spawnPyJson(['sessions'], { timeoutMs: 5000, onJson: (j) => j });
  res.json(result || { current: 'auto', sources: [] });
});

// 製作人員/職位名。繁簡成對列出,因為中國平台的日文歌詞混用兩種寫法。
const CREDIT_KEYWORDS = [
  "作詞", "作词", "作曲", "編曲", "编曲", "製作", "制作", "混音", "演唱", "原唱",
  "和聲", "和声", "企劃", "企划", "監製", "监制", "發行", "发行", "出品", "統籌", "统筹",
  "錄音", "录音", "母帶", "母带", "翻譯", "翻译", "編集", "编辑", "校對", "校对",
  "吉他", "貝斯", "贝斯", "鼓手", "鋼琴", "钢琴", "鍵盤", "键盘", "弦樂", "弦乐", "提琴",
  "合唱", "伴奏", "配唱", "封面", "設計", "设计", "曲繪", "曲绘", "調校", "调校",
  "厂牌", "廠牌", "工作室", "鳴謝", "鸣谢",
  "vocal", "lyric", "music", "arrange", "mix", "mastering", "master", "compose",
  "produce", "producer", "engineer", "record", "guitar", "bass", "drum", "piano",
  "strings", "chorus", "keyboard", "synth", "programming"
];

// 版權聲明行 (「未經著作權人許可不得使用」之類)。這種行通常又長又沒冒號,
// 過不了上面那套「像不像標籤」的判斷,所以獨立計分:命中夠多個宣告用詞就算。
function isCopyrightClaim(text) {
  const words = ["未經", "未经", "許可", "许可", "授權", "授权", "不得", "請勿", "请勿", "使用", "版權", "版权", "翻唱", "轉載", "转载"];
  const hits = words.filter(w => text.includes(w)).length;
  return hits >= 3;
}

function autoMarkTitleLines(lrcText) {
  if (!lrcText) return lrcText;
  const lines = lrcText.split('\n');
  const newLines = [];
  for (let line of lines) {
    let stripped = line.trim();
    if (!stripped) {
      newLines.push(line);
      continue;
    }
    const match = stripped.match(/^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$/);
    if (match) {
      const tags = match[1];
      let text = match[2].trim();
      if (!text.startsWith("#TITLE#")) {
        const lowerText = text.toLowerCase();
        let isTitle = isCopyrightClaim(text);
        for (let kw of CREDIT_KEYWORDS) {
          if (isTitle) break;
          if (lowerText.includes(kw) && text.length < 40) {
            // Ensure it's acting like a label
            const kwRegex = new RegExp(`${kw}\\s+`, 'i');
            if (/[:：]/.test(text) || kwRegex.test(lowerText) || text.length < kw.length + 5) {
              isTitle = true;
            }
          }
        }
        if (isTitle) {
          text = "#TITLE#" + text;
        }
      }
      newLines.push(`${tags}${text}`);
    } else {
      newLines.push(stripped);
    }
  }
  return newLines.join('\n');
}

// 注音一次要開一個 python 進程 (fugashi + unidic 每次重載,打包版還要解壓 exe),
// 換頁回歌詞頁就得再等一次。同一份歌詞的結果存起來,只有歌詞本身變了才重跑。
// 使用者改假名 (word_corrections) 時由 rebroadcastLyrics() 那條路徑清掉。
const furiganaCache = new Map();   // key = artist|||title -> { src, out }
const FURIGANA_CACHE_MAX = 50;

function furiganaKey(artist, title) { return `${artist}|||${title}`; }

function invalidateFurigana(artist, title) {
  furiganaCache.delete(furiganaKey(artist, title));
}

// meta (選填) 是 out-param:force 重跑時 Python 回報的 LLM 失敗原因放 meta.llmError
function injectFurigana(artist, title, lyrics, forceLlm = false, meta = null) {
  const key = furiganaKey(artist, title);
  const hit = furiganaCache.get(key);
  if (!forceLlm && hit && hit.src === lyrics) return Promise.resolve(hit.out);

  return new Promise((resolve) => {
    console.log("injectFurigana called for:", title, artist);
    const pyProcess = spawnPy(['furigana']);

    pyProcess.stdin.write(JSON.stringify({ artist, title, lyrics, force_llm: forceLlm }));
    pyProcess.stdin.end();
    
    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    
    pyProcess.on('close', (code) => {
      console.log('Python script exited with code:', code, 'Output:', output.substring(0, 200));
      try {
        const parsed = JSON.parse(output);
        if (meta && parsed.llm_error) meta.llmError = parsed.llm_error;
        if (parsed.success && parsed.lyrics) {
          if (furiganaCache.size >= FURIGANA_CACHE_MAX) {
            furiganaCache.delete(furiganaCache.keys().next().value);   // 丟最舊的
          }
          furiganaCache.set(key, { src: lyrics, out: parsed.lyrics });
          resolve(parsed.lyrics);
        } else {
          console.error("Python script failed:", parsed.error);
          resolve(lyrics);
        }
      } catch (e) {
        console.error('Error parsing furigana output:', e);
        console.error('Raw output was:', output);
        resolve(lyrics);
      }
    });
  });
}

// 正在播的這首歌的長度 (秒)。搜尋結果撞名/翻唱時拿來當佐證,只有查詢的就是當前曲目才算數。
function currentDuration(title, artist) {
  const s = currentMediaState;
  if (!s || !s.duration) return null;
  if (s.title !== title || s.artist !== artist) return null;
  return s.duration;
}

// 正在播這首歌的來源 app id;只有查詢的就是當前曲目才算數 (比照 currentDuration)
function currentSource(title, artist) {
  const s = currentMediaState;
  if (!s || !s.source) return null;
  if (s.title !== title || s.artist !== artist) return null;
  return s.source;
}

// ponytail: 手動鏡射 media_monitor.py 的 MUSIC_APPS (兩份 4 個字串);那邊改了這邊要跟
const MUSIC_APPS = ['spotify', 'applemusic', 'itunes', 'zunemusic'];
function isMusicAppSource(source) {
  if (!source) return true; // 未知來源當音樂 app,不去噪 (保守)
  const s = source.toLowerCase();
  return MUSIC_APPS.some(a => s.includes(a));
}

// 瀏覽器/影片來源:剝掉影片名常見噪音 (【MV】、(Official Music Video) 之類) 與頻道尾綴。
// 保守 —— 只剝含明確噪音關鍵字的整塊括號,不拆 Artist - Song。
const _NOISE_KW = /(mv|pv|official|music\s*video|lyric[s]?|audio|hd|4k|full|live|cover|feat\.?|カラオケ|歌ってみた|フル|字幕)/i;
function cleanBrowserQuery(title, artist) {
  const t = (title || '')
    .replace(/[【［(\[（][^】］)\]）]*[】］)\]）]/g, (m) => _NOISE_KW.test(m) ? '' : m)
    .replace(/\s{2,}/g, ' ')
    .trim();
  const a = (artist || '')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/\s*VEVO\s*$/i, '')
    .replace(/\s*Official\s*$/i, '')
    .trim();
  return { title: t || title, artist: a || artist };
}

// 統一算出查詢用字串。優先序:明確 searchTitle/searchArtist 參數 > 存的 per-song 覆蓋 >
// 非音樂 app 去噪 > (最後一律) feat/Live/Remastered 剝除 + 歌手別名。
async function buildSearchQuery(title, artist, searchTitle, searchArtist) {
  const explicit = !!(searchTitle || searchArtist);
  let qTitle = searchTitle || title;
  let qArtist = searchArtist || artist;

  if (!explicit) {
    const ov = await new Promise((resolve) => {
      db.get('SELECT search_title, search_artist FROM search_overrides WHERE raw_title=? AND raw_artist=?',
        [title, artist], (e, row) => resolve(row));
    });
    if (ov) {
      if (ov.search_title) qTitle = ov.search_title;
      if (ov.search_artist) qArtist = ov.search_artist;
    } else if (!isMusicAppSource(currentSource(title, artist))) {
      const c = cleanBrowserQuery(qTitle, qArtist);
      qTitle = c.title; qArtist = c.artist;
    }
  }

  // handleMediaUpdate 已經收斂過播放中那首的歌手名,這裡是為了手動指定的
  // searchArtist 與非播放路徑 (歌詞選單) 再套一次
  const trueArtist = canonicalArtist(qArtist);

  const cleanTitle = qTitle.replace(/\(feat\..*?\)|\- Remastered.*|\- Live.*/ig, '').trim();
  return { qTitle, qArtist, trueArtist, cleanTitle };
}

// 網易雲 / 酷狗:歌詞與日文讀音提示在同一次請求裡拿到,提示由 Python 端直接寫進 DB
// python 端被外部網路卡住時 (syncedlyrics 的來源很常這樣),'close' 永遠不會來,
// 這個 Promise 就永遠不 resolve。給每個子進程一個上限,超時就砍掉當作沒找到。
const PY_TIMEOUT_MS = 30000;

function spawnPyJson(args, { stdin = null, timeoutMs = PY_TIMEOUT_MS, onJson }) {
  return new Promise((resolve) => {
    const pyProcess = spawnPy(args);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { pyProcess.kill(); } catch (e) {}
      console.warn(`pytools ${args[0]} 逾時 (${timeoutMs}ms),已中止`);
      finish(null);
    }, timeoutMs);

    if (stdin !== null) {
      pyProcess.stdin.write(stdin);
      pyProcess.stdin.end();
    }

    let output = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    pyProcess.on('error', () => finish(null));
    pyProcess.on('close', () => {
      try {
        finish(onJson(JSON.parse(output)));
      } catch (e) {
        finish(null);
      }
    });
  });
}

function fetchCnLyrics({ title, artist, searchTitle, searchArtist, source = 'auto' }) {
  const duration = currentDuration(title, artist);
  return spawnPyJson(['cnlyrics'], {
    stdin: JSON.stringify({ title, artist, searchTitle, searchArtist, source, duration }),
    onJson: (parsed) => {
      if (!parsed.success) return null;
      if (source === 'all') return parsed.results || [];
      return parsed.lyrics ? { lyrics: parsed.lyrics, source: parsed.source } : null;
    }
  });
}

function fetchFallback(title, artist, fetchAll = false) {
  const args = ['fallback', title, artist];
  if (fetchAll) args.push('--all');
  return spawnPyJson(args, {
    onJson: (parsed) => {
      if (fetchAll && parsed.success && parsed.results) return parsed.results;
      if (!fetchAll && parsed.success && parsed.lyrics) {
        return { lyrics: parsed.lyrics, source: parsed.source || 'Fallback' };
      }
      return null;
    }
  });
}

// 修正發音後,若正在播這首歌就立刻重新注音並推播
function rebroadcastLyrics(artist, title) {
  // 讀音改了,注音快取一定要作廢 —— 這行要在下面那個「不是正在播的歌就不推播」的
  // 提早 return 之前,否則在編輯器改別首歌會留下過期的快取
  invalidateFurigana(artist, title);
  if (!currentMediaState || currentMediaState.title !== title || currentMediaState.artist !== artist) return;
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (!err && row && row.lyrics) {
      const injected = await injectFurigana(artist, title, row.lyrics);
      if (global.broadcast) {
        global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
      }
    }
  });
}

// 1.4 Update Furigana Correction
app.post('/api/furigana/correct', (req, res) => {
  const { artist, title, orig, hira } = req.body;
  if (!artist || !title || !orig) return res.status(400).json({ error: 'Missing parameters' });

  let finalHira = hira || '';
  if (finalHira) {
    const pyProcess = spawnPy(['romaji', finalHira]);

    let out = '';
    pyProcess.stdout.on('data', (d) => out += d.toString());
    pyProcess.on('close', () => {
      finalHira = out.trim();
      saveCorrection();
    });
  } else {
    saveCorrection();
  }

  function saveCorrection() {
    db.run(
      'INSERT OR REPLACE INTO word_corrections (artist, title, word, hira) VALUES (?, ?, ?, ?)',
      [artist, title, orig, finalHira],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, hira: finalHira });
        rebroadcastLyrics(artist, title);
      }
    );
  }
});

// 1.5 Reset Furigana Correction — 刪掉自訂讀音,回到自動判讀的結果
app.post('/api/furigana/reset', (req, res) => {
  const { artist, title, orig } = req.body;
  if (!artist || !title || !orig) return res.status(400).json({ error: 'Missing parameters' });

  db.run(
    'DELETE FROM word_corrections WHERE artist = ? AND title = ? AND word = ?',
    [artist, title, orig],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, removed: this.changes });
      rebroadcastLyrics(artist, title);
    }
  );
});

// 1.6 魔杖:強制重跑 LLM 讀音校正 (無視模式與快取,成功後覆寫 llm_hints) 並推播
app.post('/api/llm-furigana/run', (req, res) => {
  const { artist, title } = req.body;
  if (!artist || !title) return res.status(400).json({ error: 'Missing parameters' });
  if (!llmApiKey) return res.status(400).json({ error: 'API key 未設定' });

  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err || !row || !row.lyrics) return res.status(404).json({ error: '這首歌沒有快取歌詞' });
    const meta = {};
    const injected = await injectFurigana(artist, title, row.lyrics, true, meta);
    if (global.broadcast && currentMediaState.title === title && currentMediaState.artist === artist) {
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
    if (meta.llmError) {
      // 原始錯誤 (含 URL 的 requests 例外字串) 太吵,收斂成人話;細節 Python 已印在 stderr
      const e = meta.llmError;
      const friendly = /401|403/.test(e) ? 'API Key 無效或與供應商不符'
        : /404/.test(e) ? 'Base URL 或 Model 有誤'
        : /timed?\s?out|connection|max retries/i.test(e) ? '無法連線至端點，請檢查 Base URL'
        : /[一-鿿]/.test(e) ? e   // Python 端給的中文訊息本來就簡短,直接用
        : '請檢查填入的資料';
      return res.json({ success: false, error: `LLM 請求失敗：${friendly}` });
    }
    // ponytail: 以 ruby 顆數近似「處」,okurigana 拆多顆的詞會多算;要精確再改 Python 輸出計數
    const changed = (injected.match(/llm-ruby/g) || []).length;
    res.json({ success: true, changed });
  });
});

// 2. Fetch lyrics (checks DB, if missing fetches from lrclib)

app.get('/api/lyrics/offset', (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Missing parameters' });
  db.get('SELECT offset FROM sync_offsets WHERE title = ? AND artist = ?', [title, artist], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ offset: row ? row.offset : 0.0 });
  });
});

app.post('/api/lyrics/offset', (req, res) => {
  const { title, artist, offset } = req.body;
  if (!title || !artist || typeof offset !== 'number') return res.status(400).json({ error: 'Missing parameters' });
  db.run('INSERT OR REPLACE INTO sync_offsets (artist, title, offset) VALUES (?, ?, ?)', [artist, title, offset], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (global.broadcast) {
      global.broadcast({ type: 'sync_offset_updated', title, artist, offset });
    }
    
    res.json({ success: true, offset });
  });
});

app.post('/api/seek', express.json(), (req, res) => {
  const { position } = req.body;
  if (position === undefined) return res.status(400).json({ error: 'Missing position' });
  spawnPy(['seek', position.toString()]);
  res.json({ success: true });
});

app.post('/api/media-control', express.json(), (req, res) => {
  const { action } = req.body;
  if (!['play', 'pause', 'playpause', 'next', 'prev', 'shuffle', 'repeat'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  spawnPy(['media-action', action]);
  res.json({ success: true });
});

app.get('/api/lyrics/fetch', async (req, res) => {
  const { title, artist, force, searchTitle, searchArtist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });
  
  const performFetch = async () => {
    try {
      const { qTitle, qArtist, trueArtist, cleanTitle } = await buildSearchQuery(title, artist, searchTitle, searchArtist);

      let preferredSource = 'NetEase';
      try {
        if (fs.existsSync(SETTINGS_FILE)) {
          const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
          if (s.preferred_source) preferredSource = s.preferred_source;
        }
      } catch (e) {}

      let bestLyric = "";
      let isLrclib = false;
      let plainBackup = "";
      let fallbackSearched = false;
      let finalSource = "";

      // 網易/酷狗:歌詞與日文讀音提示一次抓回,注音時就不用再打一次網路
      if (preferredSource === 'NetEase' || preferredSource === 'Kugou') {
        const cnData = await fetchCnLyrics({
          title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: preferredSource
        });
        if (cnData && cnData.lyrics) {
          if (/\[\d{2}:\d{2}/.test(cnData.lyrics)) {
            bestLyric = cnData.lyrics;
            finalSource = cnData.source;
          } else if (!plainBackup) {
            plainBackup = cnData.lyrics;
            finalSource = cnData.source;
          }
        }
      }

      if (!bestLyric && preferredSource !== 'Lrclib') {
          const fbData = await fetchFallback(cleanTitle, qArtist);
          fallbackSearched = true;
          if (fbData && fbData.lyrics) {
              const fbIsSynced = /\[\d{2}:\d{2}/.test(fbData.lyrics);
              if (fbIsSynced) {
                  bestLyric = fbData.lyrics;
                  isLrclib = false;
                  finalSource = fbData.source;
              } else {
                  plainBackup = fbData.lyrics;
                  finalSource = fbData.source;
              }
          }
      }

      if (!bestLyric) {
          const apiUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(trueArtist)}&track_name=${encodeURIComponent(cleanTitle)}`;
          const lrclibResp = await fetch(apiUrl, {
            headers: { "User-Agent": "Kanaric/1.0 (https://github.com/bensionfang/Kanaric)" }
          });
          if (lrclibResp.ok) {
            const data = await lrclibResp.json();
            if (data.syncedLyrics) {
              bestLyric = data.syncedLyrics;
              isLrclib = true;
              finalSource = 'Lrclib';
            } else if (data.plainLyrics && !plainBackup) {
              plainBackup = data.plainLyrics;
              finalSource = 'Lrclib';
            }
          }
      }
      
      if (!bestLyric && !fallbackSearched) {
        const fbData = await fetchFallback(cleanTitle, qArtist);
        if (fbData && fbData.lyrics) {
          const fbIsSynced = /\[\d{2}:\d{2}/.test(fbData.lyrics);
          if (fbIsSynced || !plainBackup) {
            bestLyric = fbData.lyrics;
            isLrclib = false;
            finalSource = fbData.source;
          }
        }
      }
      
      if (!bestLyric && plainBackup) {
          bestLyric = plainBackup;
      }
      
      // Save to DB under ORIGINAL title/artist
      if (bestLyric) {
        const sourceName = finalSource || 'Fallback';
        bestLyric = `[source:${sourceName}]\n${bestLyric}`;
        bestLyric = autoMarkTitleLines(bestLyric);
        await new Promise((resolve, reject) => {
          db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, bestLyric], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        const injected = await injectFurigana(artist, title, bestLyric);
        if (global.broadcast) {
            global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
        }
        return res.json({ lyrics: injected, source: sourceName });
      }
      
      if (global.broadcast) {
        global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
      }
      return res.json({ lyrics: "", source: 'not_found' });
    } catch (e) {
      console.error('Error fetching lyrics:', e);
      if (global.broadcast) {
        global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
      }
      return res.json({ lyrics: "", source: 'error' });
    }
  };

  if (force === 'true') {
    return performFetch();
  }
  
  // 1. Check DB first
  console.log("Querying DB for:", title, artist);
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    console.log("DB returned:", row ? "found" : "not found");
    if (row && row.lyrics) {
      const injected = await injectFurigana(artist, title, row.lyrics);
      return res.json({ lyrics: injected, source: 'cache' });
    }
    
// Not found, fetch
    return performFetch();
  });
});

// 備選歌詞的搜尋放在 server 端當背景工作,網頁換頁 (JS 被殺掉) 也不會中斷。
// key = artist|||title;客戶端用 /api/lyrics/options/state 查進度,任何頁面都能接回結果。
const optionJobs = new Map();
const jobKey = (artist, title) => `${artist}|||${title}`;

function startOptionsJob(q) {
  const key = jobKey(q.artist, q.title);
  const existing = optionJobs.get(key);
  if (existing && existing.status === 'searching') return existing;   // 同一首正在搜就別重複打

  const job = { status: 'searching', options: [], startedAt: Date.now() };
  optionJobs.set(key, job);
  if (global.broadcast) global.broadcast({ type: 'lyrics_options_searching', title: q.title, artist: q.artist });

  // 外部來源 (lrclib / 網易 / 酷狗 / Python fallback) 偶爾會沒有回應,
  // 沒有逾時的話這個工作會永遠卡在 searching,按鈕就一直轉圈
  const OPTIONS_TIMEOUT_MS = 60000;
  const withTimeout = Promise.race([
    searchOptions(q),
    new Promise((_, reject) => setTimeout(() => reject(new Error('搜尋逾時')), OPTIONS_TIMEOUT_MS))
  ]);

  job.promise = withTimeout.then((options) => {
    job.status = 'done';
    job.options = options;
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_options_ready', title: q.title, artist: q.artist, count: options.length });
    }
    return options;
  }).catch((e) => {
    job.status = 'done';
    job.options = [];
    job.error = e.message;
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_options_ready', title: q.title, artist: q.artist, count: 0 });
    }
    return [];
  });
  return job;
}

// 查目前這首歌的搜尋狀態 (換頁後靠這支把按鈕狀態接回來)
app.get('/api/lyrics/options/state', (req, res) => {
  const { title, artist } = req.query;
  const job = optionJobs.get(jobKey(artist, title));
  if (!job) return res.json({ status: 'idle', options: [] });
  res.json({ status: job.status, options: job.status === 'done' ? job.options : [] });
});

app.get('/api/lyrics/options', async (req, res) => {
  const { title, artist, searchTitle, searchArtist, force } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });

  if (force) optionJobs.delete(jobKey(artist, title));
  const job = startOptionsJob({ title, artist, searchTitle, searchArtist });
  try {
    const options = await job.promise;
    res.json({ options });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function searchOptions({ title, artist, searchTitle, searchArtist }) {
  {
    const { qTitle, qArtist, trueArtist, cleanTitle } = await buildSearchQuery(title, artist, searchTitle, searchArtist);
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + trueArtist)}`;
    
    let valid_lyrics = [];

    // 網易 / 酷狗 (自家 client,不經過 syncedlyrics)
    try {
      const cnResults = await fetchCnLyrics({
        title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: 'all'
      });
      if (Array.isArray(cnResults)) {
        for (const cn of cnResults) {
          valid_lyrics.push({
            title: qTitle,
            artist: qArtist,
            album: '',
            duration: 0,
            lyrics: autoMarkTitleLines(`[source:${cn.source}]\n${cn.lyrics}`),
            isSynced: /\[\d{2}:\d{2}/.test(cn.lyrics),
            provider: cn.source,
            score: 1500
          });
        }
      }
    } catch(e) {}

    // Fetch from all fallback options
    try {
      const fbResults = await fetchFallback(qTitle, qArtist, true);
      if (fbResults && Array.isArray(fbResults)) {
        for (const fb of fbResults) {
            valid_lyrics.push({
              title: qTitle,
              artist: qArtist,
              album: '',
              duration: 0,
              lyrics: autoMarkTitleLines(`[source:${fb.source}]\n${fb.lyrics}`),
              isSynced: /\[\d{2}:\d{2}/.test(fb.lyrics),
              provider: fb.source,
              score: fb.source === 'Musixmatch' ? 2000 : 1500
            });
        }
      }
    } catch(e) {}
    
    // Lrclib 掛掉/沒回應時,別把前面幾個來源已經找到的結果一起賠掉
    let data = [];
    try {
      const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) data = await resp.json();
    } catch (e) {}

    for (const t of data) {
      const best = t.syncedLyrics || t.plainLyrics;
      if (best) {
        valid_lyrics.push({
          title: t.trackName || '',
          artist: t.artistName || '',
          album: t.albumName || '',
          duration: t.duration || 0,
          lyrics: autoMarkTitleLines(`[source:Lrclib]\n${best}`),
          isSynced: !!t.syncedLyrics,
          provider: 'Lrclib'
        });
      }
    }
    
    return finalizeOptions(valid_lyrics, cleanTitle, artist, title);
  }
}

// 現場版標記:歌名或專輯名出現這些字就當作 Live 版
const LIVE_KEYWORDS = ['live', 'ライブ', 'ライヴ', '演唱会', '演唱會', '現場', '现场', 'concert', 'unplugged'];
const isLiveText = (text) => LIVE_KEYWORDS.some(kw => (text || '').toLowerCase().includes(kw));

// 排序 + 取前 5 筆 (原本內嵌在 route 裡)
// originalTitle = 播放中那首歌的原始歌名 —— cleanTitle 已經把 "- Live..." 洗掉了,判斷不出現場版
function finalizeOptions(valid_lyrics, cleanTitle, artist, originalTitle = '') {
  {
    // Scoring logic (matching python fetcher.py)
    const penalty_keywords = ['translated', 'translation', 'romanized', '翻譯', '中文版', 'english version'];
    // 播的是錄音室版,現場版就往後排 (Live 歌詞常多出喊話/安可,時間軸也對不上)
    const wantLive = isLiveText(originalTitle);
    valid_lyrics.forEach(item => {
      let score = 0;
      const iTitle = item.title.toLowerCase();
      const iArtist = item.artist.toLowerCase();
      const tTitle = cleanTitle.toLowerCase();
      const tArtist = artist.toLowerCase();
      
      if (tTitle === iTitle) score += 1000;
      else if (iTitle.includes(tTitle) || tTitle.includes(iTitle)) score += 500;
      
      if (tArtist === iArtist) score += 500;
      else if (iArtist.includes(tArtist) || tArtist.includes(iArtist)) score += 200;
      
      if (/[\u3040-\u30FF]/.test(item.lyrics)) score += 100;
      
      if (penalty_keywords.some(kw => iTitle.includes(kw))) score -= 800;
      if (penalty_keywords.some(kw => item.album.toLowerCase().includes(kw))) score -= 500;

      // 原曲不是 Live 版,候選卻是 → 降權
      if (!wantLive && (isLiveText(item.title) || isLiveText(item.album))) score -= 600;

      const lowerLyrics = item.lyrics.toLowerCase();
      if (lowerLyrics.includes('english translation') || lowerLyrics.includes('romanized') || lowerLyrics.includes('translation by')) score -= 800;
      
      item.score = score;
    });
    
    valid_lyrics.sort((a, b) => {
      if (a.isSynced !== b.isSynced) return b.isSynced ? 1 : -1;
      return b.score - a.score;
    });
    return valid_lyrics.slice(0, 5).map(x => ({
      title: x.title,
      artist: x.artist,
      album: x.album,
      duration: x.duration,
      lyrics: x.lyrics,
      score: x.score,
      provider: x.provider,
      isSynced: x.isSynced
    }));
  }
}

// --- Alias Management APIs ---
app.get('/api/aliases', (req, res) => {
  db.all('SELECT alias, true_name FROM artist_aliases ORDER BY alias ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/aliases', express.json(), (req, res) => {
  const { alias, true_name } = req.body;
  if (!alias || !true_name) return res.status(400).json({ error: 'alias and true_name are required' });
  db.run('INSERT OR REPLACE INTO artist_aliases (alias, true_name) VALUES (?, ?)', [alias, true_name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    artistAliases.set(alias, true_name);
    res.json({ success: true });
  });
});

app.delete('/api/aliases/:alias', (req, res) => {
  const alias = req.params.alias;
  db.run('DELETE FROM artist_aliases WHERE alias = ?', [alias], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    artistAliases.delete(alias);
    res.json({ success: true });
  });
});

// per-song 搜尋覆蓋:髒標題 (瀏覽器影片名等) 手動填正確歌名/歌手,下次自動套用。
// 空字串 = 清除該首覆蓋。存完清歌詞快取,前端隨後重抓即會用新關鍵字。
app.post('/api/search-override', express.json(), (req, res) => {
  const { title, artist, searchTitle, searchArtist } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });
  const st = (searchTitle || '').trim();
  const sa = (searchArtist || '').trim();
  const done = (err, cleared) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run('DELETE FROM cache WHERE artist=? AND title=?', [artist, title], () => res.json({ success: true, cleared: !!cleared }));
  };
  if (!st && !sa) {
    db.run('DELETE FROM search_overrides WHERE raw_title=? AND raw_artist=?', [title, artist], (err) => done(err, true));
  } else {
    db.run('INSERT OR REPLACE INTO search_overrides (raw_artist, raw_title, search_artist, search_title) VALUES (?, ?, ?, ?)',
      [artist, title, sa, st], (err) => done(err, false));
  }
});

app.post('/api/lyrics/custom', async (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing parameters' });
  
  try {
    const finalLyrics = autoMarkTitleLines(`[source:ManualEdit]\n${lyrics}`);
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, finalLyrics], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const injected = await injectFurigana(artist, title, finalLyrics);
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
    res.json({ success: true, lyrics: injected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lyrics/save', express.json(), async (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing parameters' });
  
  try {
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    const injected = await injectFurigana(artist, title, lyrics);
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
    res.json({ success: true, lyrics: injected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Get all cached songs
app.get('/api/songs', (req, res) => {
  db.all('SELECT artist, title, SUBSTR(lyrics, 1, 100) AS lyric_snippet FROM cache', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 4. Record play event
app.post('/api/play-event', (req, res) => {
  const { artist, title, album, duration } = req.body;
  if (!artist || !title) return res.status(400).json({ error: 'Artist and Title required' });
  const songDuration = duration || 180;
  
  db.run(
    'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
    [canonicalArtist(artist), title, album || null, songDuration],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 5. Stats APIs
app.get('/api/stats/summary', (req, res) => {
  const query = `
    SELECT 
      COUNT(*) AS totalPlays,
      COALESCE(SUM(duration), 0) AS totalTime,
      COUNT(DISTINCT artist) AS totalArtists,
      COUNT(DISTINCT(base_title || ' - ' || artist)) AS totalSongs,
      COUNT(DISTINCT strftime('%Y-%m-%d', played_at, 'localtime')) AS activeDays,
      -- Estimate unique albums (approx 75% of unique songs, minimum 1 if songs > 0)
      CASE 
        WHEN COUNT(DISTINCT(base_title || ' - ' || artist)) > 0 
        THEN CAST(COUNT(DISTINCT(base_title || ' - ' || artist)) * 0.75 + 0.5 AS INTEGER) 
        ELSE 0 
      END AS totalAlbums
    FROM listening_history
  `;
  db.get(query, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const activeDays = row.activeDays || 1;
    const totalPlays = row.totalPlays || 0;
    const totalTime = row.totalTime || 0;
    
    const dailyAvgPlays = (totalPlays / activeDays).toFixed(1);
    const dailyAvgMinutes = (totalTime / 60 / activeDays).toFixed(1);
    
    res.json({
      totalPlays,
      totalSongs: row.totalSongs || 0,
      totalTime,
      totalArtists: row.totalArtists || 0,
      totalAlbums: row.totalAlbums || 0,
      dailyAvgPlays: parseFloat(dailyAvgPlays),
      dailyAvgMinutes: parseFloat(dailyAvgMinutes),
      appUptime: process.uptime(),
      activeDays: row.activeDays || 0
    });
  });
});

app.get('/api/stats/top-songs', (req, res) => {
  const query = `
    SELECT artist, base_title AS title, COUNT(*) AS play_count, SUM(duration) AS total_duration
    FROM listening_history
    GROUP BY artist, base_title
    ORDER BY play_count DESC
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/stats/top-artists', (req, res) => {
  const query = `
    SELECT artist, COUNT(*) AS play_count, SUM(duration) AS total_duration
    FROM listening_history
    GROUP BY artist
    ORDER BY play_count DESC
    LIMIT 5
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/stats/timeline', (req, res) => {
  const query = `
    SELECT strftime('%Y-%m-%d', played_at, 'localtime') AS play_date, COUNT(*) AS play_count, SUM(duration) AS duration_sum
    FROM listening_history
    WHERE date(played_at, 'localtime') >= date('now', 'localtime', '-7 days')
    GROUP BY play_date
    ORDER BY play_date ASC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const timelineData = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}`;
      timelineData[dateString] = { count: 0, duration: 0 };
    }
    rows.forEach(row => {
      if (timelineData[row.play_date] !== undefined) {
        timelineData[row.play_date] = { count: row.play_count, duration: Math.round(row.duration_sum / 60) || 0 };
      }
    });
    
    const formattedData = Object.keys(timelineData).map(date => ({
      play_date: date,
      play_count: timelineData[date].count,
      duration_mins: timelineData[date].duration
    }));
    res.json(formattedData);
  });
});

app.get('/api/stats/advanced', (req, res) => {
  const p1 = new Promise((resolve) => {
    db.get('SELECT MAX(cnt) AS maxLoop FROM (SELECT COUNT(*) AS cnt FROM listening_history GROUP BY artist, base_title)', [], (err, row) => resolve(row ? row.maxLoop : 0));
  });
  const p2 = new Promise((resolve) => {
    db.all("SELECT strftime('%H', played_at, 'localtime') AS hour, COUNT(*) AS count FROM listening_history GROUP BY hour ORDER BY hour", [], (err, rows) => resolve(rows || []));
  });
  const p3 = new Promise((resolve) => {
    db.all("SELECT strftime('%w', played_at, 'localtime') AS dow, COUNT(*) AS count FROM listening_history GROUP BY dow ORDER BY dow", [], (err, rows) => resolve(rows || []));
  });
  
  Promise.all([p1, p2, p3]).then(results => {
    res.json({
      maxLoopCount: results[0] || 0,
      hourlyData: results[1],
      dowData: results[2]
    });
  });
});

app.get('/api/leaderboard', (req, res) => {
  const { type, range } = req.query;
  const validTypes = ['tracks', 'artists', 'albums'];
  const validRanges = ['all', 'year', '6m', '3m', '1m', '7d'];
  
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type parameter' });
  if (!validRanges.includes(range)) return res.status(400).json({ error: 'Invalid range parameter' });
  
  let dateFilter = '';
  if (range === '6m') {
    dateFilter = "WHERE datetime(played_at, 'localtime') >= datetime('now', 'localtime', '-180 days')";
  } else if (range === '3m') {
    dateFilter = "WHERE datetime(played_at, 'localtime') >= datetime('now', 'localtime', '-90 days')";
  } else if (range === '1m') {
    dateFilter = "WHERE datetime(played_at, 'localtime') >= datetime('now', 'localtime', '-30 days')";
  } else if (range === '7d') {
    dateFilter = "WHERE datetime(played_at, 'localtime') >= datetime('now', 'localtime', '-7 days')";
  } else if (range === 'year') {
    dateFilter = "WHERE strftime('%Y', played_at, 'localtime') = strftime('%Y', 'now', 'localtime')";
  }
  
  let query = '';
  if (type === 'tracks') {
    query = `
      SELECT artist, base_title AS title, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY artist, base_title
      ORDER BY count DESC
      LIMIT 50
    `;
  } else if (type === 'artists') {
    query = `
      SELECT artist, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY artist
      ORDER BY count DESC
      LIMIT 50
    `;
  } else if (type === 'albums') {
    query = `
      SELECT COALESCE(album, title || ' - Single') AS album, artist, COUNT(*) AS count, SUM(duration) AS duration
      FROM listening_history
      ${dateFilter}
      GROUP BY album, artist
      ORDER BY count DESC
      LIMIT 50
    `;
  }
  
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 6. Launch/Toggle PyQt6
app.get('/api/desktop-status', (req, res) => {
  const pidFile = path.join(DATA_DIR, 'app.pid');
  let isRunning = false;
  if (fs.existsSync(pidFile)) {
    try {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      process.kill(existingPid, 0);
      isRunning = true;
    } catch (e) {
      isRunning = false;
    }
  }
  res.json({ isRunning });
});

app.post('/api/launch-pyqt6', (req, res) => {
  try {
    const pidFile = path.join(DATA_DIR, 'app.pid');
    let isRunning = false;
    let existingPid = null;
    
    if (fs.existsSync(pidFile)) {
      try {
        existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        process.kill(existingPid, 0); // Check if process exists
        isRunning = true;
      } catch (e) {
        isRunning = false;
      }
    }
    
    if (isRunning) {
      try {
        process.kill(existingPid); // Terminate the process
      } catch (e) {}
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      return res.json({ success: true, action: 'stopped' });
    }

    const exePath = process.env.ISLAND_EXE || path.join(PARENT_DIR, 'DynamicIslandUI', 'bin', 'Release', 'net8.0-windows', 'DynamicIslandUI.exe');
    if (!fs.existsSync(exePath)) return res.status(404).json({ error: 'C# UI not found. Please build it first.' });

    // Minimize the active window (browser) using ctypes
    spawnPy(['minimize']);

    // 必須把實際 port 傳進去,否則預設 port 被占用改用別的 port 時靈動島會連不上
    const child = spawn(exePath, [String(PORT)], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
    child.unref();
    fs.writeFileSync(pidFile, child.pid.toString());
    res.json({ success: true, pid: child.pid, action: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Editor APIs
app.get('/api/lyrics/raw', (req, res) => {
  const { title, artist, plain } = req.query;
  db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [title, artist], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row && row.lyrics) {
      let showFurigana = true;
      if (fs.existsSync(SETTINGS_FILE)) {
        try {
          const setts = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
          if (setts.show_furigana === false || setts.show_furigana === "false") {
            showFurigana = false;
          }
        } catch(e) {}
      }
      if (plain === 'true' || !showFurigana) {
        res.json({ lyrics: row.lyrics });
      } else {
        const injected = await injectFurigana(artist, title, row.lyrics);
        res.json({ lyrics: injected });
      }
    } else {
      res.json({ lyrics: "" });
    }
  });
});

app.post('/api/lyrics/update', (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (global.broadcast) {
      const injected = await injectFurigana(artist, title, lyrics);
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
    }
    res.json({ success: true });
  });
});

app.post('/api/lyrics/diff', (req, res) => {
  const { current, reference } = req.body;
  if (!current || !reference) return res.status(400).json({ error: 'Missing lyrics' });

  const pyProcess = spawnPy(['diff']);
  let outData = '';
  let errData = '';

  pyProcess.stdout.on('data', (data) => outData += data.toString());
  pyProcess.stderr.on('data', (data) => errData += data.toString());

  pyProcess.on('close', (code) => {
    if (code !== 0) {
      console.error("Diff Error:", errData);
      return res.status(500).json({ error: 'Diff processing failed' });
    }
    try {
      const diffs = JSON.parse(outData);
      res.json({ diffs });
    } catch (e) {
      res.status(500).json({ error: 'Invalid diff output' });
    }
  });

  pyProcess.stdin.write(JSON.stringify({ current, reference }));
  pyProcess.stdin.end();
});

// 8. Export Playlist API
app.get('/api/export-playlist', (req, res) => {
  const query = `
    SELECT artist, base_title AS title
    FROM listening_history
    GROUP BY artist, base_title
    ORDER BY COUNT(*) DESC
    LIMIT 50
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).send('Database Error');
    let m3uContent = "#EXTM3U\n";
    rows.forEach(row => {
      m3uContent += `#EXTINF:-1,${row.artist} - ${row.title}\n${row.artist} - ${row.title}.mp3\n`;
    });
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="top50.m3u"');
    res.send(m3uContent);
  });
});

const server = http.createServer(app);
// WebSocket 的 upgrade 不會經過 express middleware,同源守門要在這裡再擋一次 ——
// 否則惡意網頁還是能連上來收播放狀態廣播 (你正在聽什麼)。靈動島用 C# ClientWebSocket,
// 不帶 Origin,照常放行。
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => !origin || ALLOWED_ORIGINS.has(origin),
});

wss.on('connection', (ws) => {
  console.log('WebSocket client connected (Dynamic Island)');
  
  let currentSettings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try { currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
  }
  if (currentSettings.island_lines === undefined) currentSettings.island_lines = 2;
  
  ws.send(JSON.stringify({ type: 'init', state: currentMediaState, settings: currentSettings }));

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

global.broadcast = function(message) {
  const msgStr = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(msgStr);
    }
  });
};

// 只綁 127.0.0.1,不綁 0.0.0.0:API 全無認證,同網段的人若能打進來,可先用
// /api/settings 把 llm_base_url 指向自己的伺服器,再觸發 /api/llm-models 或
// /api/llm-furigana/run,server 就會把 API key 放進 Authorization header 送出去。
// 靈動島與網頁前端都走 localhost,不受影響。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Web Server & WebSocket running on http://localhost:${PORT}`);
});
