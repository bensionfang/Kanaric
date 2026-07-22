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
const { toTraditional, toSimplified } = require('./s2t');   // 簡體歌詞轉繁 (日文歌會跳過,見該檔註解)
const { cleanBrowserQuery, isMusicAppSource } = require('./browser-query');   // 瀏覽器來源的影片標題去噪
const { autoMarkTitleLines } = require('./title-lines');   // 製作人員/版權列標記 #TITLE#
const { mergeTranslations } = require('./translations');   // 中文譯文合併 #TRANS# (注音之後才做)
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
    // 中文譯文快取 (data 為 JSON: {正規化後的日文行: 譯文};空 {} = 查過但沒有來源附翻譯)。
    // Python 端 db.py 也會建同一張,改一邊要改兩邊
    db.run(`CREATE TABLE IF NOT EXISTS lyrics_translations (artist TEXT, title TEXT, data TEXT, PRIMARY KEY (artist, title))`);
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

  // 先寫入原始資料避免重複發送請求。pending 代表「查詢還沒回來,名字可能還會變」——
  // handleMediaUpdate 靠它告訴前端先別抓歌詞,否則會用舊名抓一次、還原後再抓一次
  itunesCache.set(key, { title, artist, pending: true });

  // 標題已含假名 = 已經是日文,Spotify 沒翻譯,不用還原 —— 硬查日區只會被別的版本
  // (Live/Remix 常是搜尋第一個 hit) 蓋掉。還原只該處理 Spotify 把日文譯成中文漢字 (無假名) 的情況。
  // 每條 return 前都要覆寫掉 pending 佔位,不然這首歌的 resolving 會永遠是 true
  if (hasKana(title)) {
    itunesCache.set(key, { title, artist });
    return { title, artist };
  }

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(title + ' ' + artist)}&country=JP&entity=song&limit=1`;
    // 原生 fetch 不認 { timeout },要用 AbortSignal,否則這裡可能卡很久
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
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

  itunesCache.set(key, { title, artist });
  return { title, artist };
}

// Start Media Monitor Bridge
let lastPlayedSongId = '';
let playTimer = null;
let songLogged = false;
let accumulatedMs = 0;
let lastResumeTime = 0;

// listening_history 的唯一寫入點 (換新歌、暫停後續播兩條計時器路徑都走這裡)。
// track_history 的閘門只寫在這裡 —— 不要在呼叫端各判斷一次。
// 判斷放在計時器「觸發時」而不是排程時,使用者播到一半關掉開關就真的不會被記錄。
global.logListen = function(state) {
  songLogged = true;
  if (readSettings().track_history === false) return;
  // 瀏覽器來源:抓不到歌詞的就不記錄。YouTube 上聽歌與看雜談影片是同一個 session,
  // 不擋的話「第1回ぶいすぽスポーツテストを見て…」這種影片會混進統計與排行榜。
  // 談話性影片幾乎都抓不到歌詞;副作用是在 YouTube 聽的冷門歌 (真的沒有歌詞) 也不會被記錄。
  if (!isMusicAppSource(state.source)) {
    return db.get('SELECT 1 FROM cache WHERE artist = ? AND title = ?', [state.artist, state.title],
      (err, row) => { if (!err && row) writeListen(state); });
  }
  writeListen(state);
};

function writeListen(state) {
  db.run(
    'INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)',
    [state.artist, state.title, state.album || null, Math.round(state.duration) || 180],
    // 沒有 callback 的話,node-sqlite3 會把錯誤丟成未捕捉例外整個 server 掛掉
    // (開機頭幾秒建表還沒跑完就撞上這裡的話就是 "no such table")
    (err) => { if (err) console.error('logListen 寫入失敗:', err.message); }
  );
}

global.handleMediaUpdate = function(rawState) {
  try {
    // iTunes 跨區還原攔截器。查詢是非同步的 (handleMediaUpdate 不能等),所以換歌後的
    // 頭幾百毫秒名字還是原始的、之後才會被換成日文原名。前端看到 title 變就當作換歌重抓
    // 歌詞,會用兩個不同的鍵各抓一次 (第二次多半撞到來源限流而變成「找不到歌詞」)。
    // resolving=true 就是叫前端等名字定案再抓,整首歌只抓一次。
    // 瀏覽器來源:影片標題與頻道名進場就洗乾淨,而不是只洗搜尋字串。鍵是 (artist, title),
    // 不洗的話「Chevon-シェボン / ダンス・デカダンス／Chevon 【Lyric Video】」跟 Spotify 聽的
    // 同一首會在 cache 與排行榜分裂成兩筆。順序是 去噪 → iTunes 還原 → 別名收斂:
    // artist_aliases 的鍵是乾淨名,iTunes 查詢也該拿乾淨名去查。
    if (rawState.title && !isMusicAppSource(rawState.source)) {
      const c = cleanBrowserQuery(rawState.title, rawState.artist);
      if (c.title !== rawState.title || c.artist !== rawState.artist) {
        rawState.original_title = rawState.title;
        rawState.original_artist = rawState.artist;
        rawState.title = c.title;
        rawState.artist = c.artist;
      }
    }

    rawState.resolving = false;
    if (rawState.title && rawState.artist) {
      const key = `${rawState.title}-${rawState.artist}`;
      const resolved = itunesCache.get(key);
      if (!resolved) {
         // 瀏覽器來源的時長是影片長度 (含前奏/對白),拿去跟 iTunes 的曲目長度比只會誤判,傳 null
         getResolvedMetadata(rawState.title, rawState.artist,
           isMusicAppSource(rawState.source) ? rawState.duration : null);
         rawState.resolving = true;
      } else if (resolved.pending) {
         rawState.resolving = true;
      } else {
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
        
        playTimer = setTimeout(() => global.logListen(state), 30000);
      }
      // 同一首歌暫停後又繼續播放
      else if (!songLogged && !playTimer) {
        lastResumeTime = Date.now();
        const remainingMs = Math.max(0, 30000 - accumulatedMs);
        playTimer = setTimeout(() => global.logListen(state), remainingMs);
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
  // 側欄要靠 track_history 決定顯不顯示統計/排行榜,等前端問完 API 才隱藏會閃一下
  res.locals.settings = readSettings();
  // 魔杖鈕只在設好 API key 時出現;交給前端問 /api/llm-key 再隱藏會先閃一下
  res.locals.llmKeySet = !!llmApiKey;
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

// 靈動島視窗的內容 (由 Electron 主進程的 island.js 載入,見該檔說明)
app.get('/island', (req, res) => {
  res.render('island');
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

// 讀不到 / 壞掉一律當空物件,呼叫端自己給預設值
// 靈動島視窗 (Electron 主進程,見 island.js) 也要讀設定,掛上 global 共用同一份實作
global.readSettings = readSettings;
function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

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

// 設定的唯一寫入點:網頁走 POST /api/settings,靈動島視窗 (Electron 主進程) 直接呼叫
// global.updateSettings。兩邊共用才會一起發 settings_updated,島跟網頁不會各存各的。
global.updateSettings = function (patch) {
  let currentSettings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
  const newSettings = { ...currentSettings, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 4), 'utf8');
  if (global.broadcast) {
    global.broadcast({ type: 'settings_updated', settings: newSettings });
  }
  // 這幾個都是「產出內容」而非純樣式,改了要重新推播,不然要等換歌才看得到。
  // 片假名 ruby 在注音時就決定;譯文在注音之後才併進去;島的第二行來源決定要不要帶譯文。
  const REBROADCAST_KEYS = ['katakana_ruby', 'show_translation', 'island_line2'];
  if (REBROADCAST_KEYS.some((k) => k in patch) && currentMediaState.title) {
    rebroadcastLyrics(currentMediaState.artist, currentMediaState.title);
  }
  return newSettings;
};

app.post('/api/settings', (req, res) => {
  try {
    res.json({ success: true, settings: global.updateSettings(req.body) });
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
      hasUpdate: !!updateCheckCache.latest && updateCheckCache.latest !== APP_VERSION,
      // 打包版由 electron-updater 自己下載安裝,前端就不該再叫使用者去下載;
      // ready 是「已經下載完、等著裝」的版號 (不能進上面那份 1 小時快取,它隨時會變)
      autoUpdate: global.autoUpdateEnabled === true,
      ready: global.updateReadyVersion || null
    });
  } catch (e) {
    res.json({
      current: APP_VERSION, latest: null, url: null, hasUpdate: false,
      autoUpdate: global.autoUpdateEnabled === true,
      ready: global.updateReadyVersion || null
    });
  }
});

// 立刻套用已下載好的更新 (結束 app → 裝新版 → 自己重開)。純 node 模式沒有主進程,回 available:false
app.post('/api/update-install', (req, res) => {
  if (typeof global.quitAndInstallUpdate !== 'function') {
    return res.json({ success: false, available: false });
  }
  res.json({ success: true });
  setTimeout(() => global.quitAndInstallUpdate(), 300);
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

// autoMarkTitleLines 已移到 web-app/title-lines.js (見檔頭 require),
// 獨立成檔是為了讓 test_title_lines.js 測得到而不必啟動 server。

// 注音一次要開一個 python 進程 (fugashi + unidic 每次重載,打包版還要解壓 exe),
// 換頁回歌詞頁就得再等一次。同一份歌詞的結果存起來,只有歌詞本身變了才重跑。
// 使用者改假名 (word_corrections) 時由 rebroadcastLyrics() 那條路徑清掉。
const furiganaCache = new Map();   // key = artist|||title -> { src, out }
const FURIGANA_CACHE_MAX = 50;

function furiganaKey(artist, title) { return `${artist}|||${title}`; }

function invalidateFurigana(artist, title) {
  furiganaCache.delete(furiganaKey(artist, title));
}

// 這一次執行期間已經補抓過譯文的歌。**成功失敗都留著**,不只是 in-flight 去重:
// 抓失敗時 (沒網路) pytools 不會寫入負快取,鍵一刪就會變成
// 補抓 -> rebroadcast -> 還是查無資料 -> 再補抓 的無窮迴圈。
const translationJobs = new Set();

/**
 * 譯文只在抓歌詞時搭便車存下來,所以改版前就存在快取裡的歌一首都沒有。開了「顯示翻譯」
 * 卻查無資料時,背景補抓一次再推播。**不可阻塞歌詞顯示** —— 歌詞先出來,譯文晚幾秒補上。
 *
 * 負快取 (空 {}) 由 pytools 那邊寫入,所以「查過但沒翻譯」的歌不會每次播都重抓。
 */
function ensureTranslations(artist, title) {
  const key = furiganaKey(artist, title);
  if (translationJobs.has(key)) return;
  translationJobs.add(key);

  // 查詢字串一定要過 buildSearchQuery,不能直接拿 cache 的 key 去搜 —— 那些 key 是播放
  // app 給的寫法,歌手可能是別名 (「神不擲骰子」查無結果,「神はサイコロを振らない」有 29 筆譯文)。
  // 走 fetchCnLyricsS2 而不是自己 spawn:簡體重試那層邏輯只該有一份。歌詞本身用不到
  // (cache 裡已經有了),要的是 pytools 順手寫進 lyrics_translations 的那筆。
  buildSearchQuery(title, artist)
    .then(({ trueArtist, cleanTitle }) => fetchCnLyricsS2({
      title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: 'all'
    }))
    .then(() => rebroadcastLyrics(artist, title));
}

/** 注音完的 HTML 併上譯文。關閉設定時逐字原樣回傳,開啟但查無資料時觸發背景補抓。 */
function applyTranslations(artist, title, html) {
  if (readSettings().show_translation !== true) return Promise.resolve(html);
  return new Promise((resolve) => {
    db.get('SELECT data FROM lyrics_translations WHERE artist = ? AND title = ?', [artist, title], (err, row) => {
      // 建表是非同步的,全新 DB 上這支 SELECT 可能先到 —— 有 callback 就不會炸成未捕捉例外
      if (err || !row) {
        if (!err) ensureTranslations(artist, title);
        return resolve(html);
      }
      try {
        resolve(mergeTranslations(html, JSON.parse(row.data)));
      } catch (e) {
        resolve(html);
      }
    });
  });
}

// meta (選填) 是 out-param:force 重跑時 Python 回報的 LLM 失敗原因放 meta.llmError
function injectFurigana(artist, title, lyrics, forceLlm = false, meta = null) {
  return injectFuriganaRaw(artist, title, lyrics, forceLlm, meta)
    .then((html) => applyTranslations(artist, title, html));
}

// 譯文刻意不進 furiganaCache:切換「顯示翻譯」就不必重跑 python,快取也不用多一個比對維度
function injectFuriganaRaw(artist, title, lyrics, forceLlm = false, meta = null) {
  const key = furiganaKey(artist, title);
  // 產出會隨「片假名標平假名」設定不同,所以旗標要一起比對,否則切換設定後會拿到舊 HTML
  const kataRuby = readSettings().katakana_ruby === true;
  const hit = furiganaCache.get(key);
  if (!forceLlm && hit && hit.src === lyrics && hit.kata === kataRuby) return Promise.resolve(hit.out);

  return new Promise((resolve) => {
    console.log("injectFurigana called for:", title, artist);
    const pyProcess = spawnPy(['furigana']);

    pyProcess.stdin.write(JSON.stringify({ artist, title, lyrics, force_llm: forceLlm, katakana_ruby: kataRuby }));
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
          furiganaCache.set(key, { src: lyrics, out: parsed.lyrics, kata: kataRuby });
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
// **瀏覽器來源不給時長**:YouTube 的 MV 含前奏/對白/outro,普遍比音源長,而 cn_music._pick_song
// 在歌手對不上時要求 ±3 秒才收 —— 拿影片長度當證據只會把正確的歌退貨。代價是失去擋 QQ 147 秒
// preview 的防護,但那道防護對 YouTube 本來就常誤判。
function currentDuration(title, artist) {
  const s = currentMediaState;
  if (!s || !s.duration) return null;
  if (s.title !== title || s.artist !== artist) return null;
  if (!isMusicAppSource(s.source)) return null;
  return s.duration;
}

// 正在播這首歌的來源 app id;只有查詢的就是當前曲目才算數 (比照 currentDuration)
function currentSource(title, artist) {
  const s = currentMediaState;
  if (!s || !s.source) return null;
  if (s.title !== title || s.artist !== artist) return null;
  return s.source;
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

// 中國三家的搜尋結果標題是簡體,繁體歌名 (告白氣球) 過不了 cn_music._title_matches 的比對,
// 整首歌就 MISS。但**不能一律轉簡體**:純漢字的日文歌名 (新宝島 -> 新宝岛) 轉了反而查不到。
// 所以原名先查,全 MISS 且轉換後真的不一樣時才用簡體重試一次 —— 只在既有的失敗路徑上多一次請求。
async function fetchCnLyricsS2(q) {
  const first = await fetchCnLyrics(q);
  if (first && (!Array.isArray(first) || first.length)) return first;

  const sTitle = toSimplified(q.searchTitle);
  const sArtist = toSimplified(q.searchArtist);
  if (sTitle === q.searchTitle && sArtist === q.searchArtist) return first;
  return fetchCnLyrics({ ...q, searchTitle: sTitle, searchArtist: sArtist });
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
      row.lyrics = toTraditional(row.lyrics);
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
    row.lyrics = toTraditional(row.lyrics);
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
        const cnData = await fetchCnLyricsS2({
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

      // lrclib 連不上 (被牆/離線) 時 fetch 會 throw。不接住的話會跳到最外層的 catch,
      // 把前面已經拿到的 plainBackup 一起丟掉 —— 有無時間軸的歌詞也比「找不到歌詞」好。
      if (!bestLyric) try {
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
      } catch (e) {
          console.warn('Lrclib 查詢失敗,略過:', e.message);
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
        bestLyric = autoMarkTitleLines(toTraditional(bestLyric), title);
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
      row.lyrics = toTraditional(row.lyrics);
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
      const cnResults = await fetchCnLyricsS2({
        title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: 'all'
      });
      if (Array.isArray(cnResults)) {
        for (const cn of cnResults) {
          valid_lyrics.push({
            title: qTitle,
            artist: qArtist,
            album: '',
            duration: 0,
            lyrics: autoMarkTitleLines(`[source:${cn.source}]\n${cn.lyrics}`, title),
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
              lyrics: autoMarkTitleLines(`[source:${fb.source}]\n${fb.lyrics}`, title),
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
          lyrics: autoMarkTitleLines(`[source:Lrclib]\n${best}`, title),
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
    // 這條路徑同時是「套用備選歌詞」的入口 (lyrics-tools.js applyLyricsOption),
    // 抓回來的簡體歌詞也走這裡,所以一樣要轉繁
    const finalLyrics = autoMarkTitleLines(toTraditional(`[source:ManualEdit]\n${lyrics}`), title);
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

// 5b. 資料用量與清除。
// 資料分兩類,清除只碰得到第一類:
//   可重建 —— cache / romaji_hints / llm_hints / lyrics_translations,清掉只是下次重抓
//              (要時間、要網路,不會永久失去)
//   不可重建 —— word_corrections (使用者手改的假名)、sync_offsets、artist_aliases、
//              search_overrides。這些是使用者親手打的,任何清除功能都不准碰,只顯示筆數。
// listening_history 自成一類:可清但清了回不來,前端要二次確認。
const CLEAR_TARGETS = {
  history: ['listening_history'],
  lyrics: ['cache', 'romaji_hints', 'llm_hints', 'lyrics_translations'],
};

// 這個 sqlite3 build 沒編 dbstat,所以用 length() 加總估算。全表掃描在幾萬筆下仍是毫秒級,不必快取
app.get('/api/db-usage', (req, res) => {
  const one = (sql) => new Promise((resolve) => {
    db.get(sql, [], (err, row) => resolve(err ? { rows: 0, bytes: 0 } : {
      rows: row.rows || 0, bytes: row.bytes || 0
    }));
  });

  // 提示/譯文那幾張表 Python 端 (db.py) 也會建,順序不保證 —— 所以分開查,
  // 少一張表只會少算那一份,不會把歌詞的數字一起吃掉
  Promise.all([
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(artist) + LENGTH(title) + LENGTH(lyrics)), 0) AS bytes FROM cache`),
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM romaji_hints`),
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM llm_hints`),
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM lyrics_translations`),
    one(`SELECT COUNT(*) AS rows,
                COALESCE(SUM(LENGTH(artist) + LENGTH(title) + LENGTH(COALESCE(album, '')) + 12), 0) AS bytes
         FROM listening_history`),
    one(`SELECT (SELECT COUNT(*) FROM word_corrections)
              + (SELECT COUNT(*) FROM sync_offsets)
              + (SELECT COUNT(*) FROM artist_aliases)
              + (SELECT COUNT(*) FROM search_overrides) AS rows, 0 AS bytes`),
  ]).then(([cache, romaji, llm, trans, history, manual]) => {
    // 對使用者而言「歌詞快取」就是一首歌的全部衍生資料,提示與譯文不另外列一項
    const lyrics = { rows: cache.rows, bytes: cache.bytes + romaji.bytes + llm.bytes + trans.bytes };
    // 實際佔用要含 WAL —— 剛寫入的資料還在 -wal 裡,只看主檔會少算
    let file = 0;
    for (const p of [DB_PATH, DB_PATH + '-wal']) {
      try { file += fs.statSync(p).size; } catch (e) {}
    }
    res.json({ file, lyrics, history, manual });
  });
});

app.post('/api/db-clear', express.json(), (req, res) => {
  const tables = CLEAR_TARGETS[req.body && req.body.target];
  if (!tables) return res.status(400).json({ error: 'Invalid target' });

  db.serialize(() => {
    // callback 不能省:romaji_hints / llm_hints 是 Python 端建的,Python 還沒跑過的
    // 全新安裝上不存在。沒 callback 的話 node-sqlite3 會把 "no such table" 丟成
    // 未捕捉例外,整個 server 就掛了 —— 少一張表當作已經清乾淨即可
    for (const t of tables) db.run(`DELETE FROM ${t}`, [], () => {});
    // 記憶體快取沒清的話,已刪的歌詞還是會被吐出來
    if (req.body.target === 'lyrics') {
      furiganaCache.clear();
      itunesCache.clear();
    }
    // 不 VACUUM 的話 SQLite 只把頁面標成可重用,檔案不會變小 —— 使用者按清除就是要看到變小
    db.run('VACUUM', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, cleared: tables });
    });
  });
});

// 5c. 備份與還原。
// 資料只存在這台電腦上,沒有雲端同步 —— 換電腦或重灌時,不可重建的那一類 (手改的假名、
// 時間軸校正、歌手別名、搜尋覆寫) 全部會消失。備份就是為了那些東西存在的。
//
// 做法刻意不引入 zip 函式庫:`VACUUM INTO` 產生一份壓實過、且與 WAL 一致的單檔快照,
// 再把 settings.json 的內容塞進那個檔案自己的一張 meta 表 —— 備份因此仍然是「一個 .db 檔」。
// secrets.json (LLM API key) 不進備份:備份檔會被隨手複製、傳送,key 不該跟著跑。
const BACKUP_META = '_backup_meta';
// 還原後這支 server 的 db 連線已經關掉,任何後續查詢都會炸;擋在最前面比讓它半死不活好
let restoring = false;

app.get('/api/backup', (req, res) => {
  if (restoring) return res.status(503).json({ error: '正在還原,請重新啟動 Kanaric' });
  // 暫存檔放在 DB 旁邊而不是系統 temp:同一個磁碟區才能用 rename,也不會被防毒中途攔走
  const tmp = `${DB_PATH}.backup-${Date.now()}`;
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) {} };

  db.run('VACUUM INTO ?', [tmp], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const meta = new sqlite3.Database(tmp, (e) => {
      if (e) { cleanup(); return res.status(500).json({ error: e.message }); }
      meta.serialize(() => {
        meta.run(`CREATE TABLE IF NOT EXISTS ${BACKUP_META} (key TEXT PRIMARY KEY, value TEXT)`);
        const put = meta.prepare(`INSERT OR REPLACE INTO ${BACKUP_META} (key, value) VALUES (?, ?)`);
        put.run('app', 'Kanaric');
        put.run('version', APP_VERSION);
        put.run('created_at', new Date().toISOString());
        put.run('settings', JSON.stringify(readSettings()));
        put.finalize(() => meta.close(() => {
          // 用本地日期而不是 toISOString():台灣凌晨備份會被標成前一天,看起來像拿錯檔案
          const d = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const name = `Kanaric-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`;
          res.download(tmp, name, () => cleanup());
        }));
      });
    });
  });
});

// 上傳走 raw body 而不是 multipart:前端直接把 File 當 body 送,就不必為了一支路由裝 multer
app.post('/api/restore', express.raw({ type: 'application/octet-stream', limit: '1gb' }), (req, res) => {
  if (restoring) return res.status(503).json({ error: '正在還原,請重新啟動 Kanaric' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '沒有收到檔案' });

  const incoming = `${DB_PATH}.incoming-${Date.now()}`;
  try { fs.writeFileSync(incoming, req.body); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  const drop = () => { try { fs.unlinkSync(incoming); } catch (e) {} };

  // 先驗證再動現有資料:隨便一個 .db 檔 (或根本不是 db 的檔案) 都不該蓋掉使用者的東西
  const probe = new sqlite3.Database(incoming, sqlite3.OPEN_READONLY, (e) => {
    if (e) { drop(); return res.status(400).json({ error: '這不是有效的資料庫檔案' }); }
    probe.get(`SELECT value FROM ${BACKUP_META} WHERE key = 'app'`, [], (e2, row) => {
      probe.close();
      if (e2 || !row || row.value !== 'Kanaric') {
        drop();
        return res.status(400).json({ error: '這不是 Kanaric 的備份檔' });
      }
      probe2();
    });
  });

  function probe2() {
    const p = new sqlite3.Database(incoming, sqlite3.OPEN_READONLY);
    p.get(`SELECT value FROM ${BACKUP_META} WHERE key = 'settings'`, [], (e, row) => {
      p.close(() => swap(row && row.value));
    });
  }

  function swap(settingsJson) {
    restoring = true;
    // 現有資料先留一份再蓋 —— 還原是不可逆動作,使用者選錯檔案時要有東西可以救。
    // .bak-* 已在 .gitignore 裡
    const rescue = `${DB_PATH}.bak-restore-${Date.now()}`;
    db.close((closeErr) => {
      if (closeErr) { restoring = false; drop(); return res.status(500).json({ error: closeErr.message }); }
      try {
        fs.copyFileSync(DB_PATH, rescue);
        fs.copyFileSync(incoming, DB_PATH);
        // WAL/SHM 是舊資料庫的日誌,留著會讓 SQLite 拿舊內容覆蓋剛還原的檔案
        for (const suffix of ['-wal', '-shm']) {
          try { fs.unlinkSync(DB_PATH + suffix); } catch (e) {}
        }
        if (settingsJson) {
          try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(JSON.parse(settingsJson), null, 4), 'utf8'); } catch (e) {}
        }
      } catch (e) {
        drop();
        return res.status(500).json({ error: e.message });
      }
      drop();
      // 連線已關,這支 server 不能再服務了。桌面版自己重開,純 node 只能請使用者動手
      const canRelaunch = typeof global.relaunchApp === 'function';
      res.json({ success: true, rescue: path.basename(rescue), relaunching: canRelaunch });
      if (canRelaunch) setTimeout(() => global.relaunchApp(), 800);
    });
  }
});

// 6. 靈動島開關
// 島是 Electron 主進程的一個視窗 (web-app/island.js),不是獨立進程,所以這裡只轉呼叫
// 主進程掛上來的 global。純 node (npm start) 沒有主進程,回 available:false 讓 UI 自己說明。
app.get('/api/island/status', (req, res) => {
  res.json({
    available: typeof global.isIslandOpen === 'function',
    isRunning: typeof global.isIslandOpen === 'function' ? global.isIslandOpen() : false
  });
});

app.post('/api/island/reset-position', (req, res) => {
  if (typeof global.resetIslandPosition !== 'function') {
    return res.json({ success: false, available: false });
  }
  global.resetIslandPosition();
  res.json({ success: true });
});

app.post('/api/island/toggle', (req, res) => {
  if (typeof global.isIslandOpen !== 'function') {
    return res.json({ success: false, available: false, error: '靈動島需要桌面版 Kanaric' });
  }
  try {
    const open = global.isIslandOpen();
    if (open) global.closeIsland(); else global.openIsland();
    res.json({ success: true, available: true, action: open ? 'stopped' : 'started' });
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
      row.lyrics = toTraditional(row.lyrics);
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
