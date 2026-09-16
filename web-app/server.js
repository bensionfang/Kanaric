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
const net = require('net');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { toTraditional, toSimplified } = require('./s2t');   // 簡體歌詞轉繁 (日文歌會跳過,見該檔註解)
const { youtubeCnSourceOrder, shouldAcceptYoutubeCnResult } = require('./youtube-lyrics-source');
const { badLyric } = require('./lyric-quality');            // 內嵌注音 / 羅馬字轉寫的爛歌詞,抓取階段就換下一家
const { cleanBrowserQuery, isMusicAppSource } = require('./browser-query');   // 瀏覽器來源的影片標題去噪
const { autoMarkTitleLines, normalizeLrcTime } = require('./title-lines');   // 製作人員/版權列標記 #TITLE#
const { mergeTranslations } = require('./translations');   // 中文譯文合併 #TRANS# (注音之後才做)
const { mergeRomaji } = require('./romaji');               // 羅馬拼音合併 #ROMAJI# (讀音直接取自注音結果)
const { mergeWordTimes } = require('./word-times');        // 逐字時間合併 #WORDS# (卡拉OK填色)
const { pickDistractors, filterArtistTracks } = require('./game');   // 猜歌遊戲:選項與提示句的挑選規則
const { titleKey } = require('./public/js/song-key');                // 曲目池去重 (前後端共用那份)
const {
  buildYouTubeLyricsPayload,
  createYouTubeLyricsCoordinator,
  resolveYouTubeLyricsStatus,
} = require('./youtube-karaoke-lyrics');
const {
  normalizeExtensionState,
  normalizeKaraokePitchStatus,
  normalizeKaraokePitchFrame,
  normalizeKaraokeLyricsSearch,
  normalizeKaraokeLyricsPrefetch,
  normalizeKaraokeCommand,
  readOrCreateExtensionToken,
  tokenMatches,
} = require('./youtube-karaoke-protocol');
const {
  PitchTakeValidationError,
  createPitchTakeStore,
} = require('./karaoke-pitch-takes');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5720;
// 雲端唯讀模式 (Render)。這台沒有媒體監控 (startMediaMonitor 已經在非 Windows 上早退),
// 只服務行動版的兩件事:靜態頁與 GET /api/lyrics。差異集中在四處,都以這個旗標為閘門,
// **桌面模式的行為一個字都不變**:B1 允許清單、B2 綁 0.0.0.0、B3 PUBLIC_ORIGIN、B4 關掉 WebSocket。
const CLOUD = process.env.CLOUD_MODE === '1';
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
// 任一網頁,那個網頁就能打這裡的 API —— 跨站 POST /api/settings 改設定、
// /api/db-clear 砍掉聆聽紀錄,都不需要使用者做任何事。
//
// 兩層都要,少一層就有破口:
//   Origin        —— fetch/XHR 一定帶;但 <script src>/<img> 這類不帶。
//   Sec-Fetch-Site —— 瀏覽器對「所有」請求都帶,包含 <script src>,補上上面那個破口。
// 非瀏覽器客戶端兩個 header 都沒有,照常放行 (能在本機跑程式的攻擊者早就贏了)。
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
// B3:雲端那台的頁面是它自己服務的,所以是同源 —— Safari 對同源 GET 多半不送 Origin,
// 但送了就會撞上面那道守門 (localhost 不是它的來源)。加進去才穩。
if (CLOUD && process.env.PUBLIC_ORIGIN) ALLOWED_ORIGINS.add(process.env.PUBLIC_ORIGIN);

// 外部來源 (不是 localhost 的頁面) 一律由設定 mobile_origin 明確指定,一次只能一個。
// 行動版現在是雲端那台自己服務的 (見 B3),桌面這台預設沒有任何外部來源 —— 空字串就是關著。
// **不可以改成「Origin 等於請求的 Host 就放行」** —— 攻擊者把自己
// 網域的 A record 指到 127.0.0.1 就能讓兩者相符 (DNS rebinding),整道守門形同虛設。
// 空字串 = 沒設定 = 一個外部來源都不放行。
let mobileOrigin = '';
// 使用者多半整條網址貼進來,URL.origin 正好只留 scheme://host[:port] (尾斜線、路徑都會消失)
const normOrigin = (v) => { try { return v ? new URL(v).origin : ''; } catch (e) { return ''; } };
// middleware 與 WebSocket 的 verifyClient 共用同一個判斷,不要各寫一份
const isAllowedOrigin = (o) => ALLOWED_ORIGINS.has(o) || (!!mobileOrigin && o === mobileOrigin);

// 行動版 shell 裡不在 /mobile/ 底下的那幾支。**與 public/mobile/sw.js 的 EXTRA_PATHS 是
// 同一份清單**,加檔案時兩邊一起改 (漏掉的症狀見下面 B1 那段註解)。
const MOBILE_SHELL_EXTRA = new Set(['/js/karaoke.js', '/js/scroll-zone.js']);

// B1:雲端唯讀模式的允許清單。**這是整台機器的攻擊面** —— /api/settings、/api/restore、
// /api/db-clear、/api/restore 在這裡直接變成 404,連被試探的機會都沒有,不必為此做帳號系統。
// 放在同源守門之前:先判「這條路存不存在」再判「你是誰」。
if (CLOUD) {
  app.set('trust proxy', true);   // Render 在前面,req.ip 要從 X-Forwarded-For 取才不是同一個內網位址

  // 每次 cache miss 都會打三家平台 + spawn 一個 Python 程序做注音。被洗會吃光 512MB 那台的 CPU,
  // 還可能害這台的 IP 被三家封鎖 —— 所以限流是必要的,不是防禦性程式。
  // 前端 poll() 本來就看得懂 429 + Retry-After。
  // ponytail: 單一程序的記憶體計數,Render 免費方案只有一個 instance;要多台再換 Redis
  // 沒設定 MOBILE_TOKEN 時**一律 401**,不能因為兩邊都是 undefined 就相等而放行 ——
  // 那等於設定漏了就變成公開的免費歌詞 API,而且不會有任何徵兆
  const TOKEN = process.env.MOBILE_TOKEN || '';
  if (!TOKEN) console.error('[cloud] 未設定 MOBILE_TOKEN,/api/lyrics 會一律回 401');

  const makeLimiter = (windowMs, max) => {
    const hits = new Map();
    return (req, res, next) => {
      const now = Date.now();
      const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Too many requests' });
      }
      recent.push(now);
      hits.set(req.ip, recent);
      if (hits.size > 1000) for (const [ip, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(ip);
      next();
    };
  };

  // 需要 token 的 GET 端點 → 它的限流桶 (null = 不計入)。**用 Map 不用物件**:
  // `'constructor' in obj` 是 true,拿物件當查表會讓幾個怪路徑意外通過 token 那關。
  const GATED = new Map([
    ['/api/lyrics', makeLimiter(60000, 30)],
    // 一次注音,跟 /api/lyrics 同級 —— 但要自己一個桶,不然查歌詞會吃掉套用的額度
    ['/api/lyrics/pick', makeLimiter(60000, 30)],
    // 整台機器最貴的請求:spawn Python + 打三家平台,單次實測 25.7 秒
    ['/api/lyrics/options', makeLimiter(300000, 5)],
    // **不計入**:O(1) 的 Map 查詢,而一次搜尋要輪詢十幾次,算進 30/分那個桶會自己把自己擋掉
    ['/api/lyrics/options/state', null],
  ]);

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).end();
    // 雲端那台只有行動版一個頁面,根路徑轉過去 —— 使用者記一個網域就好,不必記 /mobile/。
    // **是轉址不是把頁面搬到根路徑**:搬過去的話 redirect_uri 會變成 origin + '/',而
    // <script src="pkce.js"> 那三支相對路徑會指到 /pkce.js (檔案在 /mobile/) 全部 404。
    // 302 不是 301:301 會被瀏覽器硬快取,以後想改就改不動了。
    // /mobile (少了結尾斜線) 一起收 —— 它不符合下面的 startsWith('/mobile/'),不轉就是 404。
    if (req.path === '/' || req.path === '/mobile') return res.redirect('/mobile/');
    if (GATED.has(req.path)) {
      if (!TOKEN || req.get('X-Kanaric-Token') !== TOKEN) return res.status(401).end();
      const limiter = GATED.get(req.path);
      return limiter ? limiter(req, res, next) : next();
    }
    // 行動版的 shell 有兩支不在 /mobile/ 底下的檔案:逐字填色 (public/js/karaoke.js) 與
    // 自動捲動判定 (public/js/scroll-zone.js)。兩支都是與歌詞區/靈動島共用的一份,刻意不
    // 複製進 /mobile/。這裡漏放行是**兩個靜默失敗**:
    // <script> 404 → karaokePaint / nextScrollState 未定義 → frame() 的 rAF 迴圈一碰到就
    // 丟例外,而 requestAnimationFrame 在函式最後一行,例外一丟就再也沒有下一幀 (整頁凍住);
    // 同時 sw.js 的 caches.addAll(SHELL) 遇 404 會整批 reject,SW 從此裝不起來。
    // 這條清單與 sw.js 的 SHELL_EXTRA 是同一份,加檔案時兩邊一起改。
    if (req.path.startsWith('/mobile/') || MOBILE_SHELL_EXTRA.has(req.path)) return next();
    return res.status(404).end();
  });
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  const site = req.get('Sec-Fetch-Site');
  // 使用者從別的頁面 (README、聊天視窗、書籤以外的任何連結) 點進來是 cross-site 的
  // 「頂層導覽」—— 擋掉它只會讓人看到一行 JSON 錯誤,而放行不開任何洞:跨站 form POST
  // 的 dest 也是 document,但方法是 POST,照樣被下面擋住。GET/HEAD 沒有副作用。
  // 只認 dest 不認 mode:`<img>`/`<script src>` 的 dest 是 image/script,iframe 內嵌是
  // iframe,只有真正的頂層導覽才會是 document —— mode 再比一次沒有多擋到任何東西。
  const isTopLevelGet = (req.method === 'GET' || req.method === 'HEAD')
    && req.get('Sec-Fetch-Dest') === 'document';
  if (site && site !== 'same-origin' && site !== 'none' && !isTopLevelGet) {
    return res.status(403).json({ error: 'Cross-site requests are not allowed' });
  }
  next();
});
// gzip:本機看不出來,雲端那台的行動網路才是重點 —— 手機首載的 index.html 67KB、
// 每首歌帶 <ruby> 的歌詞幾十 KB,都是純文字,壓完剩約四分之一。
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// vendor/ 底下是版本固定的第三方字型與圖示,檔名一變就是新網址,直接讓瀏覽器永久快取
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '1y', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 使用者資料目錄 (打包後由 Electron 指向 %APPDATA%,開發模式維持專案根目錄)
const DATA_DIR = process.env.DATA_DIR || PARENT_DIR;
const YOUTUBE_EXTENSION_TOKEN = process.env.YOUTUBE_EXTENSION_TOKEN
  || readOrCreateExtensionToken({ dataDir: DATA_DIR });
const YOUTUBE_EXTENSION_ID = process.env.KANARIC_EXTENSION_ID || '';

// Python Environment Detection
const venvPythonPath = path.join(PARENT_DIR, 'venv', 'Scripts', 'python.exe');
const pythonCmd = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

// 打包模式下改用 PyInstaller 產出的 pytools.exe;開發模式用 python pytools.py
const PYTOOLS_EXE = process.env.PYTOOLS_EXE || '';
function spawnPy(args, opts = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
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
    // 使用者親手標記「這首各大網站都沒有歌詞」的清單:擋掉 /api/lyrics/fetch 的自動搜尋與重新快取,
    // 否則刪掉錯的歌詞後,下次播放又會抓到同一首撞名的錯歌詞寫回 cache。屬使用者資料,清除/備份比照 word_corrections。
    // rejected_hash = 標記當下那份(錯的)歌詞指紋;last_check = 上次背景重查時間。
    // 之後播放時每隔一陣子重查,搜到「指紋不同」的結果(= 真的被收錄了)就自動解除標記並套用。
    db.run(`CREATE TABLE IF NOT EXISTS no_lyrics (artist TEXT, title TEXT, rejected_hash TEXT, last_check INTEGER, PRIMARY KEY (artist, title))`, () => {
      // 上一版沒這兩欄的舊表補欄位 (欄位已存在會報錯,callback 吞掉)
      db.run('ALTER TABLE no_lyrics ADD COLUMN rejected_hash TEXT', () => {});
      db.run('ALTER TABLE no_lyrics ADD COLUMN last_check INTEGER', () => {});
    });
    // 中文譯文快取 (data 為 JSON: {正規化後的日文行: 譯文};空 {} = 查過但沒有來源附翻譯)。
    // Python 端 db.py 也會建同一張,改一邊要改兩邊
    db.run(`CREATE TABLE IF NOT EXISTS lyrics_translations (artist TEXT, title TEXT, data TEXT, PRIMARY KEY (artist, title))`);
    // 逐字時間快取 (data 為 JSON: {flow, ms} = 整首歌的字元流與每字毫秒;空 {} = 三家都問過、沒有逐字)。
    // Python 端 db.py 也會建同一張,改一邊要改兩邊
    db.run(`CREATE TABLE IF NOT EXISTS word_times (artist TEXT, title TEXT, data TEXT, PRIMARY KEY (artist, title))`);
    // 卡拉OK模式的 MV 背景:每首歌一支使用者親手挑的 YouTube 影片 + 影片偏移 (秒)。
    // **屬使用者資料** (跟 search_overrides 同類):不進 CLEAR_TARGETS,任何清除路徑都不准碰。
    // Python 端不碰這張表,所以 db.py 不必跟著建。
    db.run(`CREATE TABLE IF NOT EXISTS mv_choices (artist TEXT, title TEXT, video_id TEXT, offset REAL, PRIMARY KEY (artist, title))`);
    // 猜歌遊戲的每題紀錄。Python 端不碰這張表,所以 db.py 不必跟著建。
    db.run(`CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      played_at TEXT DEFAULT (datetime('now')),
      artist TEXT, title TEXT,
      correct INTEGER, hints INTEGER, answer_ms INTEGER, mode TEXT
    )`);
  }
});
const pitchTakeStore = createPitchTakeStore(db);

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

// --- iTunes 的歌手名可不可信 ---
// iTunes JP 會把西洋歌手音譯成片假名 (Coldplay → コールドプレイ、Juice WRLD → ジュース・ワールド),
// 而舊版的採用條件是「結果含假名就收」—— 片假名也算假名,所以那批全部會被改名寫進快取鍵與排行榜。
// 分辨音譯與真的日文原名,靠的不是歌詞也不是時長 (Coldplay / Yellow 是對的歌,時長完全吻合,
// 只是那份名字是音譯),而是字形:**音譯永遠是純片假名**,帶平假名或漢字就不可能是音譯。
const KATAKANA_ONLY = /^[ァ-ヴー・\s]+$/;
const hasHiraganaOrKanji = (s) => /[ぁ-ゟ一-龯々]/.test(s || '');
const isAscii = (s) => /^[\x00-\x7F]+$/.test(s || '');
// J-Pop/アニメ 只能當「命中就採用」的正面訊號,反過來不成立 ——
// 實測 サカナクション 是「ロック」、ずっと真夜中でいいのに。也是「ロック」、LiSA 是「アニメ」。
const JP_GENRE = /^(J-Pop|J-Rock|アニメ|演歌|歌謡曲|ボーカロイド)/i;

/**
 * iTunes 回來的歌手名要不要採用。三條依序,猜錯的代價都只是「維持原名」:
 *  1. 原歌手名帶 CJK (魚韻、綠黃色社會) —— 被翻譯過的特徵,結果一定是還原
 *  2. 結果帶平假名或漢字 (なとり、藤井 風) —— 音譯不可能長這樣
 *  3. 結果是純片假名 + 原名純 ASCII —— 只有這裡分不出 レトロリロン 與 コールドプレイ,用曲風賭一把
 */
function acceptsItunesArtist(incoming, resolved, genre) {
  if (!resolved || resolved === incoming) return false;
  if (!isAscii(incoming)) return true;
  if (hasHiraganaOrKanji(resolved)) return true;
  return KATAKANA_ONLY.test(resolved) && JP_GENRE.test(genre || '');
}

// --- iTunes JP Resolution Cache ---
const itunesCache = new Map();

// 查詢失敗後多久可以再試。**失敗與「查過了,確定不用還原」必須分開** —— 混為一談的話,
// 一次 3 秒逾時就會讓那首歌在整個 process 生命週期都不再嘗試還原,而期間抓的歌詞會用
// 未還原的名字寫進 cache 與 listening_history,永久分裂成兩筆 (TUYU / ツユ 各存四首)。
const ITUNES_RETRY_MS = Number(process.env.ITUNES_RETRY_MS) || 60000;

/** 取快取,但把「過了冷卻時間的失敗」當成沒查過,好讓呼叫端重試 */
function cachedResolution(key) {
  const hit = itunesCache.get(key);
  if (hit && hit.failedAt && Date.now() - hit.failedAt >= ITUNES_RETRY_MS) return undefined;
  return hit;
}

async function getResolvedMetadata(title, artist, duration) {
  const key = `${title}-${artist}`;
  const cached = cachedResolution(key);
  if (cached) return cached;

  // 先寫入原始資料避免重複發送請求。pending 代表「查詢還沒回來,名字可能還會變」——
  // handleMediaUpdate 靠它告訴前端先別抓歌詞,否則會用舊名抓一次、還原後再抓一次
  itunesCache.set(key, { title, artist, pending: true });

  // 標題**或歌手**已含假名 = 這筆本來就是日文原文、Spotify 沒翻譯,不用還原 ——
  // 硬查日區只會被別的版本 (Live/Remix 常是第一個 hit) 或同名別曲蓋掉。
  // Spotify 翻譯時標題與歌手會「一起」變成中文漢字 (魚韻/サカナクション 兩者都被譯),
  // 所以歌手還帶假名 (秘めごと) 就代表沒被翻譯過 —— 標題 AIAIAI 是原文,不該被 iTunes
  // 亂配成 愛愛愛 / Kizuna AI。還原只該處理標題與歌手「雙雙無假名」的中譯情況。
  // 每條 return 前都要覆寫掉 pending 佔位,不然這首歌的 resolving 會永遠是 true。
  if (hasKana(title) || hasKana(artist)) {
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
      // カラオケ 音源整筆丟掉:羅馬字歌名很容易搜到翻唱版 (Yorushika / Haru Dorobou
      // 的第一個 hit 是「歌っちゃ王」),而那種結果歌名歌手都有假名,下面的閘門攔不住
      if (!/カラオケ/.test(hit.primaryGenreName || '')) {
        const result = {
          title: hit.trackName || title,
          artist: hit.artistName || artist
        };
        // 歌手不可信 (西洋歌手的片假名音譯) 就只留歌名的還原,不動歌手
        const artistOk = acceptsItunesArtist(artist, result.artist, hit.primaryGenreName);
        if (!artistOk) result.artist = artist;
        // 採用還原的條件三選一:
        //  (1) 結果歌名含假名 → 確定是日文 (中文歌沒假名,擋掉污染)
        //  (2) 歌手名通過上面那三條 → 歌名沒假名也值得收 (魚韻 / Aoi → サカナクション)
        //  (3) 時長吻合 ±3s → 確定是同一首,不管字是全漢字還是什麼都信任 (補回全漢字日文歌)
        const hitDur = hit.trackTimeMillis ? hit.trackTimeMillis / 1000 : null;
        const durOk = !!(duration && hitDur && Math.abs(hitDur - duration) <= 3);
        if (hasKana(result.title) || artistOk || durOk) {
          itunesCache.set(key, result);
          return result;
        }
      }
    }
  } catch (e) {
    // 逾時/連不出去是暫時性的,標記時間讓冷卻後能重試 (仍然不是 pending —— 這一次就先用
    // 原名放歌詞,不能讓使用者為了一次網路抖動一直等)
    console.error("iTunes API error:", e.message);
    const failed = { title, artist, failedAt: Date.now() };
    itunesCache.set(key, failed);
    return failed;
  }

  // 查得到但沒有更好的名字 (無結果 / 條件不符) 是確定的結論,永久快取,重試也不會變
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
  // 猜歌遊戲中的播放不算聆聽:題目是隨機切出來的歌,記進去會污染統計與排行榜
  if (isGameActive()) return;
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

// media_state 廣播的節流。media_monitor 每 0.1 秒就推一次,而 currentMediaState 是淺層
// 合併的 —— 一旦收到封面就一直留在裡面,不處理的話等於每秒把幾十 KB 的 base64 PNG 廣播
// 十次。本機看不出來,**遠端客戶端走行動網路就是每小時幾十 MB**。
//   - 只有 position 在動時降到 1 秒一次:島、猜歌、行動版都自己內插,不靠廣播密度。
//   - position 以外的欄位一變 (換歌、暫停、封面補到) 立刻送,暫停圖示不能延遲一秒。
// 新連上的客戶端拿的是 'init',那份仍然是完整狀態,不受這裡影響。
let lastBroadcastRest = null, lastBroadcastThumb = null, lastBroadcastAt = 0;
function broadcastMediaState() {
  if (!global.broadcast) return;
  const { position, thumbnail, ...rest } = currentMediaState;
  const restJson = JSON.stringify(rest);
  if (restJson === lastBroadcastRest && thumbnail === lastBroadcastThumb
      && Date.now() - lastBroadcastAt < 1000) return;
  const payload = { ...currentMediaState };
  // 沒變就整個不送。島與行動版都判斷 `thumbnail !== undefined` 才動封面,漏送不會清掉畫面
  if (thumbnail === lastBroadcastThumb) delete payload.thumbnail;
  lastBroadcastRest = restJson;
  lastBroadcastThumb = thumbnail;
  lastBroadcastAt = Date.now();
  global.broadcast({ type: 'media_state', state: payload });
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
      // 走 cachedResolution 而不是直接 get:上次查詢失敗且已過冷卻時,要當成沒查過再試一次
      const resolved = cachedResolution(key);
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
    
    broadcastMediaState();

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
    // 封面**不內嵌**,只渲染成一個網址 —— base64 封面實測 175 KB,佔整份 currentMediaState 的
    // 99.8%,內嵌等於每換一次頁就重傳一次 (而且 base64 的 PNG 幾乎壓不掉,gzip 也救不了)。
    // 換成 /api/current-media/cover 之後瀏覽器會拿 ETag revalidate,同一首歌重載只回 304。
    hasCover: !!m.thumbnail,
    shuffle: !!m.shuffle,
    repeat: m.repeat || 0
  };
  // 側欄要靠 track_history 決定顯不顯示統計/排行榜,等前端問完 API 才隱藏會閃一下
  res.locals.settings = readSettings();
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

app.get('/editor', (req, res) => {
  res.render('editor', { activePage: 'editor' });
});

app.get('/game', (req, res) => {
  res.render('game', { activePage: 'game' });
});

// 卡拉OK字幕機模式 (兩行大字 + 逐字填色 + 可選的 MV 背景)
app.get('/karaoke', (req, res) => {
  // YouTube Karaoke 不讀取一般媒體的初始狀態；footer 仍提供共用歌詞工具，但不可把 Spotify/Windows
  // 的目前歌曲閃進這一頁。
  res.render('karaoke', {
    activePage: 'karaoke',
    media: { title: '', artist: '', position: 0, duration: 0, is_playing: false, hasCover: false, shuffle: false, repeat: 0 },
  });
});

// /karaoke 需要同一份純函式的瀏覽器影片標題去噪；檔案本身也仍供 server require。
app.get('/browser-query.js', (req, res) => res.sendFile(path.join(__dirname, 'browser-query.js')));

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

// 目前這首歌的封面 (SSR 用,見 res.locals.media 的說明)。express 會自己依內容算 ETag,
// no-cache = 「可以快取但每次要 revalidate」,所以換頁重載同一首歌只會拿到 304。
app.get('/api/current-media/cover', (req, res) => {
  const b64 = currentMediaState && currentMediaState.thumbnail;
  if (!b64) return res.redirect('/img/cover-placeholder.svg');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('jpeg').send(Buffer.from(b64, 'base64'));
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

// 同源守門要用的行動版來源。**初始化只能寫在這裡** —— SETTINGS_FILE 是上面那個 const,
// 在檔案上半部 (守門那段) 呼叫 readSettings() 會撞到 TDZ。
mobileOrigin = normOrigin(readSettings().mobile_origin);

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
  // 改了立刻生效,不必重開 server (守門是每個請求現查這個變數)
  if ('mobile_origin' in patch) mobileOrigin = normOrigin(newSettings.mobile_origin);
  if (global.broadcast) {
    global.broadcast({ type: 'settings_updated', settings: newSettings });
  }
  // 這幾個都是「產出內容」而非純樣式,改了要重新推播,不然要等換歌才看得到。
  // 片假名 ruby 在注音時就決定;譯文在注音之後才併進去;島的第二行來源決定要不要帶譯文。
  const REBROADCAST_KEYS = ['katakana_ruby', 'show_translation', 'show_romaji', 'island_line2'];
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
const translationJobs = new Map();

/**
 * 譯文只在抓歌詞時搭便車存下來,所以改版前就存在快取裡的歌一首都沒有。開了「顯示翻譯」
 * 卻查無資料時,背景補抓一次再推播。**不可阻塞歌詞顯示** —— 歌詞先出來,譯文晚幾秒補上。
 *
 * 負快取 (空 {}) 由 pytools 那邊寫入,所以「查過但沒翻譯」的歌不會每次播都重抓。
 */
// quiet:抓完不要 rebroadcast。行動版的 /api/lyrics 走這條 —— 那支端點刻意不廣播,
// 手機查一首歌不該去動桌面與靈動島上顯示的內容。
function ensureTranslations(artist, title, quiet) {
  const key = furiganaKey(artist, title);
  const existing = translationJobs.get(key);
  if (existing) return existing;

  // 查詢字串一定要過 buildSearchQuery,不能直接拿 cache 的 key 去搜 —— 那些 key 是播放
  // app 給的寫法,歌手可能是別名 (「神不擲骰子」查無結果,「神はサイコロを振らない」有 29 筆譯文)。
  // 走 fetchCnLyricsS2 而不是自己 spawn:簡體重試那層邏輯只該有一份。歌詞本身用不到
  // (cache 裡已經有了),要的是 pytools 順手寫進 lyrics_translations 的那筆。
  const job = buildSearchQuery(title, artist)
    .then(({ trueArtist, cleanTitle }) => fetchCnLyricsS2({
      title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: 'all'
    }))
    .then(() => { if (!quiet) rebroadcastLyrics(artist, title); })
    .catch(() => {});
  translationJobs.set(key, job);
  return job;
}

/**
 * 譯文/羅馬字要不要併進廣播。**島的第二行選了它也算要** —— 那兩行是同一份廣播內容,
 * 只看歌詞區的開關的話,島設成「本句翻譯」卻關著「顯示中文翻譯」時島上永遠是空的。
 */
function wantsExtraLine(kind) {
  const s = readSettings();
  return s[kind === 'romaji' ? 'show_romaji' : 'show_translation'] === true || s.island_line2 === kind;
}

/**
 * 注音完的 HTML 併上譯文。關閉設定時逐字原樣回傳,開啟但查無資料時觸發背景補抓。
 *
 * force:不看桌面的 `show_translation` 設定,一律併。行動版走這條 —— 雲端那台的
 * settings.json 是預設值 (全關),而且手機有自己的顯示開關,譯文要不要畫由前端決定。
 */
function applyTranslations(artist, title, html, force) {
  if (!force && !wantsExtraLine('translation')) return Promise.resolve(html);
  return new Promise((resolve) => {
    db.get('SELECT data FROM lyrics_translations WHERE artist = ? AND title = ?', [artist, title], (err, row) => {
      // 建表是非同步的,全新 DB 上這支 SELECT 可能先到 —— 有 callback 就不會炸成未捕捉例外
      if (err || !row) {
        if (!err) ensureTranslations(artist, title, force);
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

/**
 * 注音完的 HTML 併上逐字時間 (#WORDS#)。形狀與 applyTranslations 完全一致。
 *
 * **沒有開關,有逐字就套。** 卡拉OK填色不是「多顯示一行資訊」(那才需要 show_romaji /
 * show_translation 那種開關),而是同一行歌詞的高亮方式 —— 有逐字資料就逐字亮、沒有就
 * 整句勻速亮,兩者都是同一件事的不同精度,使用者沒有理由要去選。
 *
 * 逐字時間只有 QQ 的 QRC 有,而 `fetch()` 拿到網易的歌詞就不會再問 QQ —— 所以查無資料時
 * 走的是同一支 ensureTranslations (它是 source:'all',三家都跑、pytools 一次把讀音提示/
 * 譯文/逐字時間全寫進去)。**不要另外開一條抓取路徑。**
 */
/**
 * 「有逐字資料,但快取裡的歌詞本體與它對不上」—— 對不上就回傳那份逐字資料 (呼叫端要拿它
 * 去驗重抓回來的新本體),對得上、沒資料、或資料是負快取就回 null。
 *
 * 比對直接餵原始 LRC 而不是注音後的 HTML:`mergeWordTimes` 本來就會 `stripRuby`,
 * 兩者算出來的字元流相同,而這裡在注音之前就要判斷 (判完可能整份本體都要換掉)。
 */
function wordTimesMismatch(artist, title, lrc) {
  return new Promise((resolve) => {
    db.get('SELECT data FROM word_times WHERE artist = ? AND title = ?', [artist, title], (err, row) => {
      if (err || !row) return resolve(null);
      try {
        const wt = JSON.parse(row.data);
        if (!wt || !wt.flow || !wt.flow.length) return resolve(null);   // 空 {} 是負快取
        resolve(mergeWordTimes(lrc, wt) === lrc ? wt : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function applyWordTimes(artist, title, html, { waitForData = false } = {}) {
  return new Promise((resolve) => {
    db.get('SELECT data FROM word_times WHERE artist = ? AND title = ?', [artist, title], (err, row) => {
      // 建表是非同步的,全新 DB 上這支 SELECT 可能先到 —— 有 callback 就不會炸成未捕捉例外
      if (err) return resolve(html);
      if (!row) {
        const job = ensureTranslations(artist, title, waitForData);
        if (waitForData) {
          return Promise.resolve(job)
            .then(() => applyWordTimes(artist, title, html, { waitForData: false }))
            .then(resolve);
        }
        // 沒有資料時維持原本的背景補抓行為,桌面播放器不必被網路延遲卡住。
        return resolve(html);
      }
      try {
        resolve(mergeWordTimes(html, JSON.parse(row.data)));
      } catch (e) {
        resolve(html);
      }
    });
  });
}

/**
 * @param {object} opts  行動版專用的兩個覆寫 (桌面一律不傳):
 *   force — 不看桌面的 show_translation / show_romaji,譯文與羅馬字一律併進來。
 *           雲端那台的 settings.json 是預設值 (全關),而手機有自己的顯示開關。
 *   kata  — 蓋掉設定裡的 katakana_ruby。這一項改到的是注音本體,沒辦法像另外兩行那樣
 *           用 CSS 藏,所以要重跑 python (手機那邊的快取鍵也跟著分開)。
 */
function injectFurigana(artist, title, lyrics, opts = {}) {
  // 時間戳統一成 `[mm:ss.xx]`。這是所有客戶端 (歌詞區/靈動島/行動版) 唯一的匯流點,
  // 改版前就寫進快取的冒號式歌詞也在這裡被救回來 —— 不必 migration。
  lyrics = normalizeLrcTime(lyrics);
  return injectFuriganaRaw(artist, title, lyrics, opts.kata)
    .then((html) => applyTranslations(artist, title, html, opts.force))
    // 羅馬字要在譯文之後 —— 兩者都插在歌詞行後面,後插的會排在前面,順序才是 歌詞/羅馬字/譯文
    .then((html) => ((opts.force || wantsExtraLine('romaji')) ? mergeRomaji(html) : html))
    // 逐字時間排最後:它不是要顯示的行,插在最貼著歌詞的位置最省事,
    // 而且 mergeTranslations / mergeRomaji 的跳過清單就不必多認一種標記
    .then((html) => applyWordTimes(artist, title, html, { waitForData: opts.waitForWordTimes === true }));
}

// 譯文刻意不進 furiganaCache:切換「顯示翻譯」就不必重跑 python,快取也不用多一個比對維度
function injectFuriganaRaw(artist, title, lyrics, kataOverride) {
  const key = furiganaKey(artist, title);
  // 產出會隨「片假名標平假名」設定不同,所以旗標要一起比對,否則切換設定後會拿到舊 HTML
  const kataRuby = kataOverride === undefined ? readSettings().katakana_ruby === true : !!kataOverride;
  const hit = furiganaCache.get(key);
  if (hit && hit.src === lyrics && hit.kata === kataRuby) return Promise.resolve(hit.out);

  return new Promise((resolve) => {
    console.log("injectFurigana called for:", title, artist);
    const pyProcess = spawnPy(['furigana']);

    pyProcess.stdin.write(JSON.stringify({ artist, title, lyrics, katakana_ruby: kataRuby }));
    pyProcess.stdin.end();
    
    let output = '';
    let errOutput = '';
    pyProcess.stdout.on('data', (data) => { output += data.toString('utf-8'); });
    pyProcess.stderr.on('data', (data) => { errOutput += data.toString('utf-8'); });

    pyProcess.on('close', (code) => {
      console.log('Python script exited with code:', code, 'Output:', output.substring(0, 200));
      // 打包版 fugashi/unidic 載入失敗時 exe 直接非零退出、stdout 空 —— 沒有這行就完全查不到原因
      if (errOutput) console.error('furigana stderr:', errOutput);
      try {
        const parsed = JSON.parse(output);
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
  // explicit 一路傳出去是為了擋「搭便車的快取寫入」—— 見 searchOptions 的 stash 註解
  return { qTitle, qArtist, trueArtist, cleanTitle, explicit };
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

function remainingSearchTimeout(deadlineAt) {
  if (deadlineAt == null) return PY_TIMEOUT_MS;
  return Math.max(0, Math.min(PY_TIMEOUT_MS, deadlineAt - Date.now()));
}

function fetchCnLyrics({ title, artist, searchTitle, searchArtist, source = 'auto', stash = true }, { timeoutMs = PY_TIMEOUT_MS } = {}) {
  const duration = currentDuration(title, artist);
  return spawnPyJson(['cnlyrics'], {
    timeoutMs,
    stdin: JSON.stringify({ title, artist, searchTitle, searchArtist, source, duration, stash }),
    onJson: (parsed) => {
      if (!parsed.success) return null;
      if (source === 'all') return parsed.results || [];
      return parsed.lyrics ? { lyrics: parsed.lyrics, source: parsed.source, word: !!parsed.word } : null;
    }
  });
}

// 中國三家的搜尋結果標題是簡體,繁體歌名 (告白氣球) 過不了 cn_music._title_matches 的比對,
// 整首歌就 MISS。但**不能一律轉簡體**:純漢字的日文歌名 (新宝島 -> 新宝岛) 轉了反而查不到。
// 所以原名先查,全 MISS 且轉換後真的不一樣時才用簡體重試一次 —— 只在既有的失敗路徑上多一次請求。
async function fetchCnLyricsS2(q, { deadlineAt = null } = {}) {
  const firstTimeout = remainingSearchTimeout(deadlineAt);
  if (!firstTimeout) return null;
  const first = await fetchCnLyrics(q, { timeoutMs: firstTimeout });
  if (first && (!Array.isArray(first) || first.length)) return first;

  const sTitle = toSimplified(q.searchTitle);
  const sArtist = toSimplified(q.searchArtist);
  if (sTitle === q.searchTitle && sArtist === q.searchArtist) return first;
  const retryTimeout = remainingSearchTimeout(deadlineAt);
  return retryTimeout ? fetchCnLyrics({ ...q, searchTitle: sTitle, searchArtist: sArtist }, { timeoutMs: retryTimeout }) : first;
}

function fetchFallback(title, artist, fetchAll = false, { timeoutMs = PY_TIMEOUT_MS } = {}) {
  const args = ['fallback', title, artist];
  if (fetchAll) args.push('--all');
  return spawnPyJson(args, {
    timeoutMs,
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
  const { title, artist, offset, videoId, revision } = req.body;
  const hasVideoId = videoId !== undefined;
  const hasRevision = revision !== undefined;
  if (!title || !artist || typeof offset !== 'number'
    || hasVideoId !== hasRevision
    || (hasVideoId && (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)
      || !Number.isSafeInteger(revision) || revision < 0))) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  db.run('INSERT OR REPLACE INTO sync_offsets (artist, title, offset) VALUES (?, ?, ?)', [artist, title, offset], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    // The controller may persist an offset, but only the canonical, revision-bound
    // server payload may relay it to the owner tab.  An unversioned offset update
    // remains a normal shared preference and cannot identify a YouTube session.
    if (hasVideoId && currentYouTubeExtensionState?.videoId === videoId
      && currentYouTubeExtensionState.revision === revision
      && currentYouTubeLyrics?.videoId === videoId
      && normalizeYouTubeRevision(currentYouTubeLyrics.revision) === revision) {
      currentYouTubeLyrics = { ...currentYouTubeLyrics, offsetMs: Math.round(offset * 1000) };
      sendYouTubeLyricsToExtension(currentYouTubeLyrics);
    }
    
    if (global.broadcast) {
      global.broadcast({ type: 'sync_offset_updated', title, artist, offset });
    }
    
    res.json({ success: true, offset });
  });
});

app.post('/api/seek', (req, res) => {
  const { position } = req.body;
  if (position === undefined) return res.status(400).json({ error: 'Missing position' });
  spawnPy(['seek', position.toString()]);
  res.json({ success: true });
});

app.post('/api/media-control', (req, res) => {
  const { action } = req.body;
  if (!['play', 'pause', 'playpause', 'next', 'prev', 'shuffle', 'repeat'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  spawnPy(['media-action', action]);
  res.json({ success: true });
});

// 使用者標記「此歌無歌詞」的整列查詢 (含 rejected_hash / last_check),沒有回 null
function getNoLyrics(artist, title) {
  return new Promise((resolve) => {
    db.get('SELECT rejected_hash, last_check FROM no_lyrics WHERE artist=? AND title=?', [artist, title],
      (e, row) => resolve(row || null));
  });
}

// 歌詞內容指紋:比對「這次搜到的跟標記時那份錯的是不是同一份」。djb2,夠分辨即可,不必密碼學強度
function hashLyric(s) {
  let h = 5381;
  for (let i = 0; i < (s || '').length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// 跑完整來源串接,回傳「會寫進 cache 的那份歌詞字串」(轉繁 + 標記製作人員列 + source 標籤),
// 找不到回空字串。**不寫 cache、不廣播** —— 純搜尋,給 performFetch 與無歌詞背景重查共用。
async function searchBestLyric(title, artist, searchTitle, searchArtist, { deadlineMs = null, youtube = false } = {}) {
  const deadlineAt = deadlineMs == null ? null : Date.now() + deadlineMs;
  const { qArtist, trueArtist, cleanTitle } = await buildSearchQuery(title, artist, searchTitle, searchArtist);

  let preferredSource = 'NetEase';
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.preferred_source) preferredSource = s.preferred_source;
    }
  } catch (e) {}

  let bestLyric = "";
  let plainBackup = "";
  let fallbackSearched = false;
  let finalSource = "";

  // 每一家回來的候選都先過這道:內嵌注音 (漢字後面黏著讀音) 與羅馬字轉寫的版本整份沒救,
  // 當作沒抓到,讓後面的來源接手 (網易 → fallback → lrclib)。全部都這樣才真的沒歌詞,
  // 那也比一份標爛的好。全部來源都只有這種版本時,擋到最後會變成「找不到歌詞」——
  // 那比一份難讀的歌詞更糟,所以擋下來的第一份留著當墊底,跑完整條鏈都沒有乾淨的才拿出來用。
  let rejectedBackup = "";
  let rejectedSource = "";
  let rejectedReason = "";
  const usable = (lyric, src) => {
    const reason = badLyric(lyric, title);
    if (!reason) return true;
    console.log(`歌詞${reason},判為不可用略過:${src} / ${title}`);
    if (!rejectedBackup) { rejectedBackup = lyric; rejectedSource = src; rejectedReason = reason; }
    return false;
  };

  // 網易/酷狗:歌詞與日文讀音提示一次抓回,注音時就不用再打一次網路。
  // cn_music.fetch() 自己會在「這家沒歌詞」時往下一家問,但**它不知道內嵌注音這回事** (那個判斷
  // 只有 JS 這一份,不複製到 Python),所以被擋下來時要由這裡指定另一家再問一次 —— 實測
  // モザイクロール 網易是內嵌注音版、酷狗那份乾淨,不重問就會白白掉到 fallback。
  // 這個迴圈只有在被擋掉時才會多打,成功路徑跟以前一樣一次。
  const cnOrder = youtubeCnSourceOrder(preferredSource, { youtube });
  if (cnOrder.length) {
    // **QQ 排在偏好來源前面,但只有「它自己那份帶逐字」時才佔位。** 逐字時間只有 QQ 的 QRC 有,
    // 而歌詞本體多半來自網易 —— 兩份不同源就有幾行對不上,`mergeWordTimes` 是全有或全無,
    // 那首歌就整個沒有卡拉OK。本體也用 QQ 那份的話,行覆蓋率天生 100%。
    // 沒有 QRC 時它那份不佔位:QQ 會把兩三個短句併成一長行,讀起來比網易差。
    // 成本是**只在快取 miss 時**多打一次 QQ 搜尋,而且常常不會多 —— `cn_music.fetch` 在
    // 「這家沒有」時自己就往下一家問,回來的 source 剛好是偏好來源的話就直接用。
    const tried = new Set();
    for (const src of cnOrder) {
      if (tried.has(src)) continue;
      tried.add(src);
      if (!remainingSearchTimeout(deadlineAt)) break;
      const cnData = await fetchCnLyricsS2({
        title, artist, searchTitle: cleanTitle, searchArtist: trueArtist, source: src
      }, { deadlineAt });
      if (!cnData || !cnData.lyrics) {
        if (src === 'QQMusic') continue;
        break;              // 一家都沒有 = 三家都沒有 (cn_music 內部已經問過)
      }
      if (!usable(cnData.lyrics, cnData.source)) continue;
      if (!shouldAcceptYoutubeCnResult(src, cnData)) continue;
      // QQ 那份沒有逐字 = 沒有留下它的理由,讓給偏好來源 (它內部已經掉到別家的話就照收)
      if (/\[\d{2}:\d{2}/.test(cnData.lyrics)) { bestLyric = cnData.lyrics; finalSource = cnData.source; }
      else if (!plainBackup) { plainBackup = cnData.lyrics; finalSource = cnData.source; }
      break;
    }
  }

  if (!bestLyric && preferredSource !== 'Lrclib') {
    const timeoutMs = remainingSearchTimeout(deadlineAt);
    const fbData = timeoutMs ? await fetchFallback(cleanTitle, qArtist, false, { timeoutMs }) : null;
    fallbackSearched = true;
    if (fbData && fbData.lyrics && usable(fbData.lyrics, fbData.source)) {
      if (/\[\d{2}:\d{2}/.test(fbData.lyrics)) { bestLyric = fbData.lyrics; finalSource = fbData.source; }
      else { plainBackup = fbData.lyrics; finalSource = fbData.source; }
    }
  }

  // lrclib 連不上 (被牆/離線) 時 fetch 會 throw。不接住的話會跳到最外層的 catch,
  // 把前面已經拿到的 plainBackup 一起丟掉 —— 有無時間軸的歌詞也比「找不到歌詞」好。
  if (!bestLyric) try {
    const apiUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(trueArtist)}&track_name=${encodeURIComponent(cleanTitle)}`;
    const timeoutMs = remainingSearchTimeout(deadlineAt);
    if (!timeoutMs) throw Object.assign(new Error('lyrics search timed out'), { code: 'lyrics-search-timeout' });
    const fetchOptions = { headers: { "User-Agent": "Kanaric/1.0 (https://github.com/bensionfang/Kanaric)" } };
    if (deadlineAt != null) fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    const lrclibResp = await fetch(apiUrl, fetchOptions);
    if (lrclibResp.ok) {
      const data = await lrclibResp.json();
      // 時長守門:lrclib 只用歌名+歌手字串比對,撞名會回別首歌。回傳帶 duration,
      // 跟播放中時長差超過 3 秒就當撞名丟掉。瀏覽器來源 currentDuration 回 null,照舊放行。
      const ourDur = currentDuration(title, artist);
      const durOff = !!(ourDur && data.duration && Math.abs(data.duration - ourDur) > 3);
      if (durOff) {
        console.log('Lrclib 時長不符,判為撞名略過:', data.duration, 'vs', ourDur);
      } else if (data.syncedLyrics && usable(data.syncedLyrics, 'Lrclib')) { bestLyric = data.syncedLyrics; finalSource = 'Lrclib'; }
      else if (data.plainLyrics && !plainBackup && usable(data.plainLyrics, 'Lrclib')) { plainBackup = data.plainLyrics; finalSource = 'Lrclib'; }
    }
  } catch (e) {
    console.warn('Lrclib 查詢失敗,略過:', e.message);
  }

  if (!bestLyric && !fallbackSearched) {
    const timeoutMs = remainingSearchTimeout(deadlineAt);
    const fbData = timeoutMs ? await fetchFallback(cleanTitle, qArtist, false, { timeoutMs }) : null;
    if (fbData && fbData.lyrics && usable(fbData.lyrics, fbData.source)) {
      if (/\[\d{2}:\d{2}/.test(fbData.lyrics) || !plainBackup) { bestLyric = fbData.lyrics; finalSource = fbData.source; }
    }
  }

  if (!bestLyric && plainBackup) bestLyric = plainBackup;
  if (!bestLyric && rejectedBackup) {
    console.log(`只找得到${rejectedReason}的版本,照用:${rejectedSource} / ${title}`);
    bestLyric = rejectedBackup;
    finalSource = rejectedSource;
  }
  if (!bestLyric && deadlineAt != null && Date.now() >= deadlineAt) {
    throw Object.assign(new Error('lyrics search timed out'), { code: 'lyrics-search-timeout' });
  }
  if (!bestLyric) return { lyric: "", source: "" };

  const sourceName = finalSource || 'Fallback';
  const finalLyric = autoMarkTitleLines(toTraditional(`[source:${sourceName}]\n${bestLyric}`), title);
  return { lyric: finalLyric, source: sourceName };
}

// 快取裡是內嵌注音、已經重抓過一次的歌 (見 /api/lyrics/fetch);重開 app 會再試一次,那是刻意的:
// 來源網站之後補上乾淨版本的話,重開就換得到。
const inlineRetried = new Set();
// YouTube's old cache can contain an empty word_times row from a prior miss or rate limit.
// Recheck it once per process so a later QQ result can populate the existing song.
const youtubeWordTimesRetried = new Set();

function retryYouTubeNegativeWordTimes(artist, title) {
  const key = furiganaKey(artist, title);
  if (youtubeWordTimesRetried.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    db.get('SELECT data FROM word_times WHERE artist = ? AND title = ?', [artist, title], (err, row) => {
      if (err || !row) return resolve();
      let data;
      try { data = JSON.parse(row.data); } catch { return resolve(); }
      if (data?.flow?.length) return resolve();
      youtubeWordTimesRetried.add(key);
      Promise.resolve(ensureTranslations(artist, title, true)).then(resolve, resolve);
    });
  });
}

// 無歌詞背景重查:搜到「跟標記時那份不同」的非空結果 = 真的被收錄了 → 解除標記、寫快取、廣播套用。
const NOLYRICS_RECHECK_MS = Number(process.env.NOLYRICS_RECHECK_MS) || 7 * 24 * 3600 * 1000;
const recheckInFlight = new Set();   // 避免同一首同時被多次播放觸發重複搜尋
async function recheckNoLyrics(artist, title, rejectedHash) {
  const key = `${artist}|||${title}`;
  if (recheckInFlight.has(key)) return;
  recheckInFlight.add(key);
  try {
    const { lyric, source } = await searchBestLyric(title, artist);
    if (lyric && hashLyric(lyric) !== (rejectedHash || '')) {
      // 出現不同結果:自動解除標記 + 寫快取 + 廣播(前端會即時換上)
      await new Promise((r) => db.run('DELETE FROM no_lyrics WHERE artist=? AND title=?', [artist, title], r));
      await new Promise((r) => db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyric], r));
      const injected = await injectFurigana(artist, title, lyric);
      // 寫回 cache + 廣播:靈動島 (有 WebSocket) 即時換上;網頁下次播放/重載時自然帶出。
      if (global.broadcast) global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
      console.log('無歌詞重查:找到新歌詞,已自動套用', artist, '-', title, `(${source})`);
    }
  } catch (e) {
    console.warn('無歌詞重查失敗:', e.message);
  } finally {
    recheckInFlight.delete(key);
  }
}

app.get('/api/lyrics/fetch', async (req, res) => {
  const { title, artist, force, searchTitle, searchArtist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });

  // 標記為無歌詞的:直接回空,不搜尋也不寫快取 (force 重載也照擋)。
  // 但每隔 NOLYRICS_RECHECK_MS 背景重查一次:真的被收錄了 (搜到不同結果) 就自動解除並套用。
  // 手動的備選歌詞搜尋 (/api/lyrics/options) 不受此擋,使用者仍可主動去找。
  const nl = await getNoLyrics(artist, title);
  if (nl) {
    const now = Date.now();
    if (now - (nl.last_check || 0) > NOLYRICS_RECHECK_MS) {
      db.run('UPDATE no_lyrics SET last_check=? WHERE artist=? AND title=?', [now, artist, title]);  // 先記時,避免每次播都觸發
      recheckNoLyrics(artist, title, nl.rejected_hash);   // 背景跑,不 await;有結果會自己廣播
    }
    if (global.broadcast) global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
    return res.json({ lyrics: "", source: 'no_lyrics' });
  }

  const performFetch = async () => {
    try {
      const { lyric: bestLyric, source: sourceName } = await searchBestLyric(title, artist, searchTitle, searchArtist);

      if (bestLyric) {
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
      // 改版前抓的爛歌詞 (內嵌注音、羅馬字轉寫):重抓一次,別家有乾淨版本就換掉。
      // `cache` 沒有時間戳也不會自己重驗,所以一份壞歌詞寫進去之後就永遠是它 ——
      // 這條是它唯一的出口 (羅馬字那種尤其:來源網站現在多半已經給得出正常日文版了)。
      // **一個 process 只試一首一次** (`inlineRetried`):只有這種版本的歌重抓也還是同一份,
      // 沒有這道記號就會變成「每次播都重抓」。也**不先刪快取** —— 重抓沒有更好的話還要靠它顯示。
      // **`[source:ManualEdit]` 不碰**:那是使用者自己編輯或親手套用的備選歌詞,即使是爛版本
      // 也是他選的 (整個網路只有這種版本時就得這樣用),自動換掉等於推翻他的決定。
      // 第二個重抓的理由:**逐字時間抓到了,但本體與它對不上**。逐字只有 QQ 的 QRC 有,
      // 而改版前存下來的本體多半是網易的 —— 兩份不同源就有幾行對不上,`mergeWordTimes`
      // 是全有或全無,那首歌就整個不逐字。`searchBestLyric` 的 `cnOrder` 早就會在「QQ 那份
      // 帶逐字」時改用 QQ 的本體,但那只發生在**快取 miss** 時,所以舊歌再聽一百次也不會換
      // (全庫實測 352 首有逐字資料,177 首卡在這裡)。這條是它們唯一的出口。
      const inlineKey = `${artist}|||${title}`;
      const retriable = !row.lyrics.startsWith('[source:ManualEdit]') && !inlineRetried.has(inlineKey);
      const reason = retriable && badLyric(row.lyrics, title);
      // 對得上就不要白重抓 —— 只有真的對不上才拿它當理由 (回傳的就是要拿去驗新本體的那份)
      const wt = retriable && !reason ? await wordTimesMismatch(artist, title, row.lyrics) : null;
      if (reason || wt) {
        inlineRetried.add(inlineKey);
        console.log(`快取裡的歌詞${reason ? `是${reason}` : '與逐字時間對不上'},重抓一次看有沒有更好的:`, artist, title);
        const { lyric } = await searchBestLyric(title, artist, searchTitle, searchArtist);
        // 換本體是有代價的 (斷句會變),所以新的那份要真的解決問題才換:壞歌詞那條看它不壞,
        // 逐字這條看它真的併得進去 —— 不驗的話會為了一份同樣對不上的本體白換一次。
        if (lyric && !badLyric(lyric, title) && (reason || mergeWordTimes(lyric, wt) !== lyric)) {
          db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyric]);
          invalidateFurigana(artist, title);
          row.lyrics = lyric;
        }
      }
      row.lyrics = toTraditional(row.lyrics);
      const injected = await injectFurigana(artist, title, row.lyrics);
      return res.json({ lyrics: injected, source: 'cache' });
    }
    
// Not found, fetch
    return performFetch();
  });
});

// 行動版 (PWA) 專用的無狀態查詢。刻意不共用 /api/lyrics/fetch,差別有兩個:
//  1. **不廣播** —— 手機在播的歌不該把桌面/靈動島上正在顯示的歌詞換掉。
//  2. 自己做歌名還原 (canonicalArtist + iTunes),手機這條路沒有 handleMediaUpdate ——
//     Spotify 給的是 Haru Dorobou / 魚韻,不還原就跟桌面的 cache 鍵分裂、日文歌也查不到。
// 回的 lyrics 是桌面版同一份「帶 <ruby> 的 LRC 字串」,不是規格 §4.1 寫的 tokens 陣列:
// 注音 HTML 已經產好了,前端 innerHTML 畫得出來,不必為此給 furigana_inject.py 加輸出模式。
app.get('/api/lyrics', async (req, res) => {
  const { title, artist, duration_ms } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });

  try {
    const seconds = Number(duration_ms) > 0 ? Number(duration_ms) / 1000 : null;
    const resolved = await getResolvedMetadata(title, canonicalArtist(artist), seconds);
    // 還原出來的日文原名本身也可能是別名的來源,再收斂一次才跟桌面同一個鍵
    const a = canonicalArtist(resolved.artist);
    const t = resolved.title;
    const meta = { title: t, artist: a };

    if (await getNoLyrics(a, t)) return res.json({ ...meta, lyrics: '', source: 'no_lyrics' });

    const row = await new Promise((resolve) =>
      db.get('SELECT lyrics FROM cache WHERE title = ? AND artist = ?', [t, a], (e, r) => resolve(r)));

    let lyric = row && row.lyrics ? toTraditional(row.lyrics) : '';
    let source = 'cache';
    if (!lyric) {
      const found = await searchBestLyric(t, a);
      if (!found.lyric) return res.json({ ...meta, lyrics: '', source: 'not_found' });
      db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [a, t, found.lyric]);
      lyric = found.lyric;
      source = found.source;
    }
    // 譯文與羅馬拼音一律併進來 (force),要不要畫由手機自己的開關決定 —— 這樣切換開關不必
    // 重打一次端點,前端快取裡的那份也永遠是完整的。查無譯文時 ensureTranslations 會背景
    // 補抓,但**不 rebroadcast** (quiet),手機查歌不該動到桌面顯示的內容。
    const html = await injectFurigana(a, t, lyric, { force: true, kata: req.query.kata === '1' });
    res.json({ ...meta, lyrics: html, source });
  } catch (e) {
    console.error('行動版查歌詞失敗:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 備選歌詞的搜尋放在 server 端當背景工作,網頁換頁 (JS 被殺掉) 也不會中斷。
// key = artist|||title;客戶端用 /api/lyrics/options/state 查進度,任何頁面都能接回結果。
const optionJobs = new Map();
const jobKey = (artist, title) => `${artist}|||${title}`;
const youtubeOptionSelections = new Map();

function normalizeYouTubeLyricsOptionsRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'title', 'artist'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_options_request'
    || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId)
    || !Number.isSafeInteger(message.revision) || message.revision < 0
    || typeof message.title !== 'string' || !message.title.trim() || message.title.length > 200
    || typeof message.artist !== 'string' || !message.artist.trim() || message.artist.length > 200) return null;
  return { videoId: message.videoId, revision: message.revision, title: message.title.trim(), artist: message.artist.trim() };
}

function normalizeYouTubeLyricsOptionSelect(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some((key) => !['type', 'videoId', 'revision', 'optionId'].includes(key))
    || message.type !== 'youtube_karaoke_lyrics_option_select'
    || !/^[A-Za-z0-9_-]{11}$/.test(message.videoId)
    || !Number.isSafeInteger(message.revision) || message.revision < 0
    || typeof message.optionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.optionId)) return null;
  return { videoId: message.videoId, revision: message.revision, optionId: message.optionId };
}

function summarizeYouTubeOption(option, job, request) {
  const optionId = randomUUID().replace(/-/g, '');
  youtubeOptionSelections.set(optionId, { job, index: job.options.indexOf(option), ...request });
  while (youtubeOptionSelections.size > 200) youtubeOptionSelections.delete(youtubeOptionSelections.keys().next().value);
  const preview = String(option.lyrics || '')
    .replace(/^\[source:[^\]]+\]\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' / ')
    .slice(0, 500);
  return {
    optionId,
    source: String(option.provider || 'Unknown').slice(0, 100),
    format: option.hasWords ? '逐字' : (option.isSynced ? 'LRC' : 'TXT'),
    preview,
    hasWords: !!option.hasWords,
  };
}

function buildYouTubeLyricsOptionsMessage(job, request, status = job.status, error = null) {
  const message = {
    type: 'youtube_karaoke_lyrics_options',
    videoId: request.videoId,
    revision: request.revision,
    status,
    options: (job.options || []).map((option) => summarizeYouTubeOption(option, job, request)),
  };
  if (error) message.error = String(error).slice(0, 500);
  return message;
}

function startOptionsJob(q) {
  const key = jobKey(q.artist, q.title);
  const existing = optionJobs.get(key);
  if (existing && existing.status === 'searching') return existing;   // 同一首正在搜就別重複打

  const job = { status: 'searching', options: [], startedAt: Date.now() };
  optionJobs.set(key, job);
  // 這個 Map 本來只增不減,而每個 job 帶著五份完整歌詞。桌面開幾天沒事,雲端那台是
  // 512MB 的公開端點,放著就是慢性漏。Map 的鍵有插入順序,丟最舊的就好。
  while (optionJobs.size > 20) optionJobs.delete(optionJobs.keys().next().value);
  if (global.broadcast) global.broadcast({ type: 'lyrics_options_searching', title: q.title, artist: q.artist });

  // 外部來源 (lrclib / 網易 / 酷狗 / Python fallback) 偶爾會沒有回應,
  // 沒有逾時的話這個工作會永遠卡在 searching,按鈕就一直轉圈
  const OPTIONS_TIMEOUT_MS = 60000;
  // 逐來源回報:每問完一家就把目前累積的結果寫回 job,不必等五個來源全問完才有東西可看
  // (單次完整搜尋實測 25.7 秒)。/api/lyrics/options/state 輪詢就能拿到「已完成的來源」。
  const onProgress = (partial) => {
    job.options = partial;
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_options_progress', title: q.title, artist: q.artist, count: partial.length });
    }
  };
  const withTimeout = Promise.race([
    searchOptions(q, onProgress),
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
  const { title, artist, brief } = req.query;
  const job = optionJobs.get(jobKey(artist, title));
  if (!job) return res.json({ status: 'idle', options: [] });
  // searching 中也給目前已完成來源的結果。brief=1 (行動版) 把歌詞本體拔掉:一次搜尋要輪詢
  // 十幾次,每次都夾帶五份完整歌詞就是幾百 KB 的行動網路流量,而手機在按下去之前不需要內文。
  const options = brief ? job.options.map(({ lyrics, ...o }) => o) : job.options;
  res.json({ status: job.status, options });
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

// 行動版套用備選歌詞的入口。桌面走 POST /api/lyrics/custom (寫 cache + 廣播),手機不行:
// 雲端那台是 GET-only,而且它的 DB 是暫時的、也不該被手機寫。所以這支只把記憶體裡那份選項
// 算成「可以直接畫的 HTML」回去,**不寫 DB 也不廣播** —— 跟 /api/lyrics 同一條規矩,
// 手機換歌詞不能動到桌面與靈動島上顯示的內容。持久化由手機寫進自己的 localStorage 快取。
app.get('/api/lyrics/pick', async (req, res) => {
  const { title, artist, index } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required' });

  const job = optionJobs.get(jobKey(artist, title));
  const opt = job && job.options[Number(index) || 0];
  // 409 = 工作不見了 (server 重啟、或被上面那個 20 筆上限淘汰),手機看到就重跑一次搜尋
  if (!opt) return res.status(409).json({ error: 'options expired' });

  try {
    // autoMarkTitleLines 重跑是安全的:已標過 #TITLE# 的行有 `already` 旗標擋著,不會標兩次。
    // 刻意不加 [source:ManualEdit] 前綴 —— 那個標記是保護 cache 裡的歌詞不被自動重抓蓋掉,
    // 這條路根本不寫 cache。
    const lyric = autoMarkTitleLines(toTraditional(opt.lyrics), title);
    const html = await injectFurigana(artist, title, lyric, { force: true, kata: req.query.kata === '1' });
    res.json({ title, artist, lyrics: html, source: opt.provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function searchOptions({ title, artist, searchTitle, searchArtist }, onProgress) {
  {
    const { qTitle, qArtist, trueArtist, cleanTitle, explicit } = await buildSearchQuery(title, artist, searchTitle, searchArtist);
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + trueArtist)}`;

    // 三家**並行**問,不要改回依序 await。這支跟 searchBestLyric 不一樣:那邊抓到好歌詞就早退,
    // 依序是省請求;這邊要收集全部候選、沒有早退,依序就只是把延遲加起來 —— 實測 25.7 秒,
    // 並行後 ≈ 最慢那家。代價是 cn 與 fallback 兩個 spawnPy 會同時存在 (桌面無感;雲端那台
    // 這支端點本來就限流 5 次/5 分鐘)。
    //
    // 各家收在自己的桶子裡、最後**依固定順序**串起來:finalizeOptions 的排序遇到同分是穩定的
    // (網易/酷狗與大部分 fallback 都是 1500),照完成先後 push 的話前 5 筆會每次跑都不一樣。
    const cnBucket = [], fbBucket = [], lrcBucket = [];
    const collected = () => [...cnBucket, ...fbBucket, ...lrcBucket];
    // 每問完一家就回報目前累積的結果 (已排序/去重過),不必等三家都問完
    const report = () => { if (onProgress) onProgress(finalizeOptions(collected(), cleanTitle, artist, title)); };

    // 網易 / 酷狗 (自家 client,不經過 syncedlyrics)
    const cnTask = (async () => {
    try {
      // **手動輸入關鍵字時不准搭便車寫快取** (`stash: false`)。pytools 的 `_stash` 是用
      // 「DB 鍵 (title, artist)」存譯文與逐字時間,而查的是 searchTitle/searchArtist ——
      // 平常兩者是同一首歌的不同寫法所以正確,但備選歌詞視窗讓使用者**打任何歌名**,
      // 那時等於把別首歌的譯文/逐字時間蓋到正在播的這首上 (實測踩過:muque 那首的
      // word_times 變成 ヨルシカ/春泥棒 的字元流,而且因為「全有或全無」只表現成
      // 「這首突然不逐字了」,完全沒有錯誤訊息)。
      // 存起來的 per-song 覆蓋 (`search_overrides`) 不受影響 —— 那是「同一首歌換個名字查」,
      // 走的是 explicit=false 那條路,照舊要 stash。
      const cnResults = await fetchCnLyricsS2({
        title, artist, searchTitle: cleanTitle, searchArtist: trueArtist,
        source: 'all', stash: !explicit
      });
      if (Array.isArray(cnResults)) {
        for (const cn of cnResults) {
          cnBucket.push({
            title: qTitle,
            artist: qArtist,
            album: '',
            duration: 0,
            lyrics: autoMarkTitleLines(`[source:${cn.source}]\n${cn.lyrics}`, title),
            isSynced: /\[\d{2}:\d{2}/.test(cn.lyrics),
            // 這一份原始檔帶不帶逐字時間 (只有 QQ 的 QRC 有)。標的是**這份候選的格式**,
            // 不是「選了它就有卡拉OK」—— 逐字時間是整首歌一份、跨來源比對回來的
            hasWords: !!cn.word,
            provider: cn.source,
            score: 1500
          });
        }
      }
    } catch(e) {}
    report();
    })();

    // Fetch from all fallback options
    const fbTask = (async () => {
    try {
      const fbResults = await fetchFallback(qTitle, qArtist, true);
      if (fbResults && Array.isArray(fbResults)) {
        for (const fb of fbResults) {
            fbBucket.push({
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
    report();
    })();

    // Lrclib 掛掉/沒回應時,別把前面幾個來源已經找到的結果一起賠掉
    const lrcTask = (async () => {
    let data = [];
    try {
      const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) data = await resp.json();
    } catch (e) {}

    for (const t of data) {
      const best = t.syncedLyrics || t.plainLyrics;
      if (best) {
        lrcBucket.push({
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
    report();
    })();

    // 三個 task 各自把例外吞在裡面了,但 allSettled 比 all 保險 —— 哪天有人在 task 裡
    // 加了一段沒包 try 的程式碼,用 all 會讓整支搜尋連同已經找到的結果一起賠掉
    await Promise.allSettled([cnTask, fbTask, lrcTask]);

    return finalizeOptions(collected(), cleanTitle, artist, title);
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
      isSynced: x.isSynced,
      hasWords: !!x.hasWords
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

app.post('/api/aliases', (req, res) => {
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
app.post('/api/search-override', (req, res) => {
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

async function saveManualLyrics(title, artist, lyrics) {
  const finalLyrics = autoMarkTitleLines(toTraditional(`[source:ManualEdit]\n${lyrics}`), title);
  await new Promise((resolve, reject) => {
    db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, finalLyrics], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const injected = await injectFurigana(artist, title, finalLyrics);
  if (global.broadcast) global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: injected });
  return { finalLyrics, injected };
}

app.post('/api/lyrics/custom', async (req, res) => {
  const { title, artist, lyrics } = req.body;
  if (!title || !artist || !lyrics) return res.status(400).json({ error: 'Missing parameters' });
  
  try {
    const { injected } = await saveManualLyrics(title, artist, lyrics);
    res.json({ success: true, lyrics: injected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lyrics/save', async (req, res) => {
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

// 刪除某首歌的快取歌詞。只碰可重抓的 cache —— word_corrections/sync_offsets 那些
// 使用者親手打的不動。一併清記憶體的 furiganaCache/itunesCache,否則已刪的歌詞會被
// 再吐回來 (與 /api/db-clear 清 lyrics 時同款處理)。回歸測試 node test_lyrics_delete.js。
app.post('/api/lyrics/delete', (req, res) => {
  const { title, artist } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });
  db.run('DELETE FROM cache WHERE artist=? AND title=?', [artist, title], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    invalidateFurigana(artist, title);
    itunesCache.delete(`${title}-${artist}`);
    if (global.broadcast) {
      global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
    }
    res.json({ success: true, deleted: this.changes });
  });
});

// 標記/取消標記「此歌無歌詞」。marked=true 同時把現有(錯的)快取清掉,下次播放也不再自動搜尋。
// marked=false 只是解除標記,之後就恢復自動搜尋。屬使用者資料,清除白名單碰不到。
app.post('/api/lyrics/no-lyrics', (req, res) => {
  const { title, artist, marked } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });
  if (marked) {
    // 先把現有(錯的)快取指紋記下來,之後背景重查靠它分辨「還是同一份錯的」還是「真的收錄了」
    db.get('SELECT lyrics FROM cache WHERE artist=? AND title=?', [artist, title], (e, row) => {
      const rejected = row && row.lyrics ? hashLyric(row.lyrics) : '';
      db.run('INSERT OR REPLACE INTO no_lyrics (artist, title, rejected_hash, last_check) VALUES (?, ?, ?, ?)',
        [artist, title, rejected, Date.now()], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        // 一併清掉錯的快取與記憶體,畫面立刻退回「找不到歌詞」
        db.run('DELETE FROM cache WHERE artist=? AND title=?', [artist, title], () => {
          invalidateFurigana(artist, title);
          itunesCache.delete(`${title}-${artist}`);
          if (global.broadcast) global.broadcast({ type: 'lyrics_updated', title, artist, lyrics: "" });
          res.json({ success: true, marked: true });
        });
      });
    });
  } else {
    db.run('DELETE FROM no_lyrics WHERE artist=? AND title=?', [artist, title], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, marked: false });
    });
  }
});

// 查某首是否被標記為無歌詞 (編輯器載入時決定按鈕狀態)
app.get('/api/lyrics/no-lyrics', async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });
  res.json({ marked: !!(await getNoLyrics(artist, title)) });
});

// 3. Get all cached songs
app.get('/api/songs', (req, res) => {
  db.all('SELECT artist, title, SUBSTR(lyrics, 1, 100) AS lyric_snippet FROM cache', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/karaoke/lyrics-search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 80) return res.status(400).json({ error: 'bad_query' });
  db.all(
    'SELECT artist, title FROM cache WHERE instr(lyrics, ?) > 0 ORDER BY artist, title LIMIT 20',
    [q],
    (err, items) => err
      ? res.status(500).json({ error: 'search_failed' })
      : res.json({ scope: 'cached', items }),
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

// 聽歌熱力圖:近一年每天一格。**只回有資料的那幾天** —— 前端本來就要照日曆長出整個網格,
// 補零那 300 多天由它自己 lookup 時當 0 即可,不必送過來。
// `'localtime'` 兩處都要:played_at 存的是 UTC,不轉的話跨日的那幾筆會落在錯的格子。
app.get('/api/stats/heatmap', (req, res) => {
  db.all(`
    SELECT strftime('%Y-%m-%d', played_at, 'localtime') AS play_date,
           COUNT(*) AS play_count, SUM(duration) AS duration_sum
    FROM listening_history
    WHERE date(played_at, 'localtime') >= date('now', 'localtime', '-365 days')
    GROUP BY play_date`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({
      date: r.play_date,
      count: r.play_count,
      mins: Math.round((r.duration_sum || 0) / 60),
    })));
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

// 5a-2. 猜歌遊戲。
// 遊戲狀態 (分數、題號、模式) 全在前端,server 只做三件事:給干擾選項、給提示句、記結果。
// 播放控制沿用現成的 /api/media-control (shuffle / next),不另外開端點。
const gameQuery = (sql, params = []) => new Promise(
  (resolve) => db.all(sql, params, (err, rows) => resolve(err ? [] : rows))
);
const shuffle = (a) => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(p => p[1]);

app.post('/api/game/options', async (req, res) => {
  const { title, artist } = req.body || {};
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });

  // 使用者指定的歌手曲目 (POST /api/game/artist 抓回來的那份) 排第一順位:
  // 四個選項全是同一位歌手,才不能靠「歌手不對」刷掉。
  // 前端傳來的東西照樣要洗:只留字串、上限 200 筆
  const pool = (Array.isArray(req.body.pool) ? req.body.pool : [])
    .filter((s) => s && typeof s.artist === 'string' && typeof s.title === 'string')
    .slice(0, 200);

  // 其餘三個池子:同歌手 → 常聽 → 全庫隨機。挑選規則在 game.js,
  // SQL 只負責撈 (常聽的那份取前 40 名再洗牌,否則每一題的干擾項都是同樣那幾首)
  const [same, popular, rand] = await Promise.all([
    gameQuery('SELECT artist, title FROM cache WHERE artist = ? ORDER BY RANDOM() LIMIT 20', [artist]),
    gameQuery(`SELECT artist, base_title AS title FROM listening_history
               GROUP BY artist, base_title ORDER BY COUNT(*) DESC LIMIT 40`),
    gameQuery('SELECT artist, title FROM cache ORDER BY RANDOM() LIMIT 20'),
  ]);

  // 排除清單裡「就是答案本身」的那筆。**要連 iTunes 還原前的原名一起排除** ——
  // 清單給的是 Spotify 原字串 (Haru Dorobou),播放狀態早就被還原成日文原名 (春泥棒),
  // 只比對還原後的名字會讓答案以另一個寫法混進干擾項,四選一變成兩個都對
  const exclude = [{ artist, title }];
  if (req.body.original_title) {
    exclude.push({ artist: req.body.original_artist || artist, title: req.body.original_title });
  }

  const picked = pickDistractors(exclude, shuffle(pool), same, shuffle(popular), rand);
  if (!picked) return res.json({ error: 'not_enough' });
  res.json({ options: shuffle([...picked, { artist, title }]) });
});

// 歌手模式:給一個歌手名 → iTunes 抓他的曲目當干擾選項的來源。
// **country=JP 不能改成別的 storefront** —— tw/us 會把日文歌手與歌名換成羅馬字/英譯
// (`ヨルシカ / 晴る` → `Yorushika / Sunny`),整份干擾項就變成使用者不認得的名字。
// 這也是 getResolvedMetadata 用 JP 的同一個理由。
//
// **一次載入 = 2 次 iTunes 請求 (search + lookup)**,而 iTunes Search API 沒有 key、
// 也沒有配額,只有「約 20 次/分鐘/IP」的節流 (超過回 403)。同一個 process 裡歌名還原
// (getResolvedMetadata) 也在打同一支 API,所以這裡放一層記憶體快取 —— 前端的「最近三位」
// chip 點下去就是重跑這支,不快取的話反覆點就是反覆打。曲目清單幾天不變,TTL 給 6 小時。
const gameArtistCache = new Map();
const GAME_ARTIST_TTL = 6 * 60 * 60 * 1000;

app.post('/api/game/artist', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'bad_name' });

  const cacheKey = name.toLowerCase();
  const hit0 = gameArtistCache.get(cacheKey);
  if (hit0 && Date.now() - hit0.at < GAME_ARTIST_TTL) return res.json(hit0.body);

  const itunes = async (path) => {
    const r = await fetch(`https://itunes.apple.com/${path}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`itunes ${r.status}`);
    return r.json();
  };

  try {
    // **入口用 entity=song 而不是 entity=musicArtist**:artist entity 的 artistName 是羅馬字
    // (`Yorushika`),曲目列才帶日文原名 (`ヨルシカ`) —— 這正是別的猜歌網站歌名不對的成因。
    const found = await itunes(`search?term=${encodeURIComponent(name)}&entity=song&limit=1&country=JP`);
    const hit = (found.results || [])[0];
    if (!hit || !hit.artistId) return res.json({ error: 'no_artist' });

    // **lookup 抓不到連動曲** —— artistId 的曲目列只有「這位歌手掛主名」的歌,別人主掛的
    // 聯名曲 (`Chevon & ヨルシカ`) 不在裡面,但別人做的「全曲目播放清單」都會收。少了它們,
    // 那些歌不算進覆蓋率,而且答案的歌手欄會寫著別人的名字。所以再打一次 search 補回來。
    const [songs, more] = await Promise.all([
      itunes(`lookup?id=${hit.artistId}&entity=song&limit=200&country=JP`),
      itunes(`search?term=${encodeURIComponent(name)}&entity=song&limit=200&country=JP`).catch(() => ({})),
    ]);
    // lookup 的第一筆是歌手本身而不是歌曲,filterArtistTracks 會因為沒有 trackName 自己跳過
    const tracks = filterArtistTracks(songs.results);
    if (!tracks.length) return res.json({ error: 'no_tracks' });

    // 歌手名取「曲目列裡出現最多次的那個寫法」,再收斂成正規名 (魚韻 → サカナクション),
    // 才跟 cache 與播放狀態同一個寫法
    const tally = new Map();
    for (const t of tracks) tally.set(t.artist, (tally.get(t.artist) || 0) + 1);
    const common = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const artist = canonicalArtist(common);

    // search 回來的東西什麼都有,**只收 artistName 含這位歌手的**。刻意不比對 trackName ——
    // 翻唱版的歌名常常寫著原唱 (`春泥棒 (ヨルシカ)`),比歌名會把整批翻唱收進來。
    // 代價是「完全掛在別人名下、聯名寫法也沒出現」的客串曲仍然抓不到,那條沒有安全的判準。
    const norm = (x) => String(x || '').replace(/[\s　]+/g, '').toLowerCase();
    const want = [norm(common), norm(artist), norm(name)].filter(Boolean);
    const collabs = filterArtistTracks((more.results || []).filter((r) => {
      const a = norm(r && r.artistName);
      return a && want.some((w) => a.includes(w)) && !want.includes(a);   // 純本人的已經在 lookup 裡
    }));
    // 合併去重 (filterArtistTracks 只在各自那批內去重)。**比歌名不比歌手** ——
    // 待會所有曲目的歌手都會被改寫成正規名,聯名寫法在這裡比不出東西。
    // 補進來的標 `extra: true`:**只當干擾選項,不算進「全曲目」的分母** —— search 撈到的
    // 東西沒有 lookup 那麼乾淨 (客串、合輯、別人的翻唱漏網),拿它當必須考完的清單只會讓
    // 覆蓋率永遠差幾首。題目本來就只看使用者播放清單裡實際播到的歌。
    const seen = new Set(tracks.map(titleKey));
    const own = tracks.length;
    for (const c of collabs) {
      const k = titleKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      tracks.push({ ...c, extra: true });
    }
    // 照片:iTunes 沒有歌手像,拿搜尋首選那首歌的專輯封面當代表 (100x100 換成 400x400)
    const image = String(hit.artworkUrl100 || '').replace('100x100', '400x400');
    // count 只算本人的曲目 (連動曲是干擾項,不是「要考完的清單」)
    const body = { artist, image, count: own, tracks: tracks.map((t) => ({ ...t, artist })) };
    gameArtistCache.set(cacheKey, { at: Date.now(), body });   // 失敗不進快取,下次照樣重試
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: 'fetch_failed', message: e.message });
  }
});


// ── 卡拉OK模式的 MV 背景 ──────────────────────────────────────────────
// 一次搜尋 = 一個 Python 程序 + 一次對 YouTube 的請求,而挑選面板每開一次就會問一次
// (使用者會反覆開來換影片)。所以跟 gameArtistCache 一樣放一層記憶體快取,TTL 也一樣 6 小時。
const mvSearchCache = new Map();
const MV_SEARCH_TTL = 6 * 60 * 60 * 1000;

app.get('/api/mv/search', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  if (!title) return res.status(400).json({ error: 'bad_title' });

  const key = `${artist}|||${title}`.toLowerCase();
  const hit = mvSearchCache.get(key);
  if (hit && Date.now() - hit.at < MV_SEARCH_TTL) return res.json({ results: hit.results });

  const hasDuration = Object.prototype.hasOwnProperty.call(req.query, 'duration');
  const duration = hasDuration ? Number(req.query.duration) : (currentDuration(title, artist) || null);
  if (hasDuration && (!Number.isFinite(duration) || duration < 0)) {
    return res.status(400).json({ error: 'bad_duration' });
  }
  const results = await spawnPyJson(['ytsearch'], {
    stdin: JSON.stringify({ title, artist, duration }),
    onJson: (parsed) => (Array.isArray(parsed) ? parsed : []),
  });
  if (!results) return res.status(502).json({ error: 'search_failed' });
  mvSearchCache.set(key, { at: Date.now(), results });   // 失敗不進快取
  res.json({ results });
});

app.get('/api/mv', (req, res) => {
  const title = String(req.query.title || '');
  const artist = String(req.query.artist || '');
  db.get('SELECT video_id, offset FROM mv_choices WHERE title=? AND artist=?', [title, artist], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row ? { videoId: row.video_id, offset: row.offset || 0 } : {});
  });
});

app.post('/api/mv', (req, res) => {
  const { title, artist, videoId, offset } = req.body || {};
  if (!title) return res.status(400).json({ error: 'bad_title' });
  // videoId 空字串 = 取消這首歌的 MV。**存成空字串的一列,不要 DELETE** ——
  // 沒挑過的歌現在會自動套用搜尋結果的第一支,刪掉列就跟「從沒挑過」分不出來,
  // 下次播到同一首又會自動套一支回來,「取消」等於沒有用。
  db.run('INSERT OR REPLACE INTO mv_choices (artist, title, video_id, offset) VALUES (?, ?, ?, ?)',
    [artist || '', title, videoId || '', Number(offset) || 0], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/game/result', (req, res) => {
  const { title, artist, correct, hints, answer_ms, mode } = req.body || {};
  if (!title || !artist) return res.status(400).json({ error: 'title and artist are required' });
  db.run(
    `INSERT INTO game_history (artist, title, correct, hints, answer_ms, mode) VALUES (?, ?, ?, ?, ?, ?)`,
    [artist, title, correct ? 1 : 0, hints || 0, answer_ms || 0, mode || ''],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// YouTube 卡拉 OK 的使用者音高歷史。只保存 compact pitch frames，不保存音訊或分析原始資料。
const pitchTakeError = (res, error) => {
  if (error instanceof PitchTakeValidationError) {
    return res.status(400).json({ error: error.message });
  }
  console.error('音高歷史失敗:', error.message);
  return res.status(500).json({ error: error.message });
};
const parsePitchTakeId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

app.post('/api/karaoke/pitch-takes', async (req, res) => {
  try {
    const saved = await pitchTakeStore.save(req.body);
    res.status(201).json(saved);
  } catch (error) {
    pitchTakeError(res, error);
  }
});

app.get('/api/karaoke/pitch-takes', async (req, res) => {
  try {
    res.json(await pitchTakeStore.list(req.query.videoId));
  } catch (error) {
    pitchTakeError(res, error);
  }
});

app.get('/api/karaoke/pitch-takes/:id', async (req, res) => {
  const id = parsePitchTakeId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid id' });
  try {
    const take = await pitchTakeStore.detail(id);
    if (!take) return res.status(404).json({ error: 'not found' });
    res.json(take);
  } catch (error) {
    pitchTakeError(res, error);
  }
});

app.delete('/api/karaoke/pitch-takes/:id', async (req, res) => {
  const id = parsePitchTakeId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'invalid id' });
  try {
    if (!(await pitchTakeStore.delete(id))) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (error) {
    pitchTakeError(res, error);
  }
});

// 5b. 資料用量與清除。
// 資料分兩類,清除只碰得到第一類:
//   可重建 —— cache / romaji_hints / utaten_hints / lyrics_translations,清掉只是下次重抓
//              (要時間、要網路,不會永久失去)
//   不可重建 —— word_corrections (使用者手改的假名)、sync_offsets、artist_aliases、
//              search_overrides。這些是使用者親手打的,任何清除功能都不准碰,只顯示筆數。
// listening_history 自成一類:可清但清了回不來,前端要二次確認。
// game_history 與 listening_history 同一類 (可清但清了回不來),但刻意是獨立的 target ——
// 猜歌成績與聆聽紀錄是兩件事,清一個不該順手把另一個清掉
const CLEAR_TARGETS = {
  history: ['listening_history'],
  lyrics: ['cache', 'romaji_hints', 'utaten_hints', 'lyrics_translations', 'word_times'],
  game: ['game_history'],
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
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM utaten_hints`),
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM lyrics_translations`),
    one(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM word_times`),
    one(`SELECT COUNT(*) AS rows,
                COALESCE(SUM(LENGTH(artist) + LENGTH(title) + LENGTH(COALESCE(album, '')) + 12), 0) AS bytes
         FROM listening_history`),
    one(`SELECT (SELECT COUNT(*) FROM word_corrections)
              + (SELECT COUNT(*) FROM sync_offsets)
              + (SELECT COUNT(*) FROM artist_aliases)
              + (SELECT COUNT(*) FROM search_overrides) AS rows, 0 AS bytes`),
    one(`SELECT COUNT(*) AS rows, 0 AS bytes FROM game_history`),
  ]).then(([cache, romaji, uta, trans, words, history, manual, game]) => {
    // 對使用者而言「歌詞快取」就是一首歌的全部衍生資料,提示/譯文/逐字時間不另外列一項
    const lyrics = { rows: cache.rows, bytes: cache.bytes + romaji.bytes + uta.bytes + trans.bytes + words.bytes };
    // 實際佔用要含 WAL —— 剛寫入的資料還在 -wal 裡,只看主檔會少算
    let file = 0;
    for (const p of [DB_PATH, DB_PATH + '-wal']) {
      try { file += fs.statSync(p).size; } catch (e) {}
    }
    res.json({ file, lyrics, history, manual, game });
  });
});

app.post('/api/db-clear', (req, res) => {
  const tables = CLEAR_TARGETS[req.body && req.body.target];
  if (!tables) return res.status(400).json({ error: 'Invalid target' });

  db.serialize(() => {
    // callback 不能省:romaji_hints / utaten_hints 是 Python 端建的,Python 還沒跑過的
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
const BACKUP_META = '_backup_meta';
// 還原後這支 server 的 db 連線已經關掉,任何後續查詢都會炸;擋在最前面比讓它半死不活好
let restoring = false;

// 聆聽紀錄匯出成 CSV。**跟 `/api/backup` 是兩件事**:那個是給程式還原的整庫快照 (二進位、
// 含使用者手打的資料),這個是給人讀的一張表 —— 丟進 Excel 或自己寫腳本分析都行。
// 直接串流成字串不落地:一筆 31 bytes,幾千筆也才幾百 KB。
app.get('/api/history.csv', (req, res) => {
  db.all(`SELECT played_at, artist, title, base_title, album, duration
          FROM listening_history ORDER BY played_at ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // 逗號、引號、換行三種都要處理 —— 日文歌名裡的全形逗號無所謂,但譯名/備註可能有半形的
    const q = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // base_title 是剝掉 `(Live)`/`(feat. …)` 尾綴的 generated column,統計都 GROUP BY 它 ——
    // 一起匯出,自己算的時候才跟站上的排行榜對得起來
    const head = ['played_at', 'artist', 'title', 'base_title', 'album', 'duration_sec'];
    const body = rows.map(r => [r.played_at, r.artist, r.title, r.base_title, r.album, r.duration].map(q).join(','));
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `Kanaric-history-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    // **BOM 不能省**:Excel 開沒有 BOM 的 UTF-8 CSV 會用系統 codepage 解,日文歌名整片亂碼
    res.send('﻿' + [head.join(','), ...body].join('\r\n'));
  });
});

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
let currentYouTubeLyrics = null;
let currentYouTubeLyricsStatus = null;
let currentYouTubeExtensionState = null;

function pitchRelayIdentityMatches(message, state = currentYouTubeExtensionState) {
  return !!state && message?.videoId === state.videoId
    && message?.revision === state.revision && message.revision > 0;
}

function sendYouTubePitchRelayToExtension(message) {
  if (!message || global.activeYouTubeExtension?.readyState !== 1) return false;
  global.activeYouTubeExtension.send(JSON.stringify(message));
  return true;
}

function stopPitchRelayForSocket(ws) {
  const identity = ws?.pitchRelayIdentity;
  if (!ws) return false;
  ws.pitchRelayIdentity = null;
  ws.pitchRelayEnabled = false;
  ws.pitchRelayStatus = null;
  ws.pendingPitchRelayStatus = null;
  if (!identity) return false;
  return sendYouTubePitchRelayToExtension({
    type: 'youtube_karaoke_pitch_status',
    videoId: identity.videoId,
    revision: identity.revision,
    status: 'stopped',
    error: null,
  });
}

function stopAllPitchRelays() {
  wss?.clients?.forEach((client) => {
    if (client.isKaraoke) stopPitchRelayForSocket(client);
  });
}

function replayPitchRelayStatuses() {
  const state = currentYouTubeExtensionState;
  wss?.clients?.forEach((client) => {
    if (!client.isKaraoke) return;
    const pending = client.pendingPitchRelayStatus;
    if (pending) {
      client.pendingPitchRelayStatus = null;
      if (!pitchRelayIdentityMatches(pending, state)) return;
      handleKaraokePitchRelay(client, pending);
      return;
    }
    if (client.pitchRelayStatus && pitchRelayIdentityMatches(client.pitchRelayStatus, state)) {
      sendYouTubePitchRelayToExtension(client.pitchRelayStatus);
    }
  });
}

function handleKaraokePitchRelay(ws, raw) {
  if (!ws?.isKaraoke) return false;
  const status = normalizeKaraokePitchStatus(raw);
  if (status) {
    if (!currentYouTubeExtensionState) {
      const pending = ws.pendingPitchRelayStatus;
      if (pending && (pending.videoId !== status.videoId || pending.revision !== status.revision)) return false;
      ws.pendingPitchRelayStatus = status;
      return true;
    }
    if (!pitchRelayIdentityMatches(status)) return false;
    const current = ws.pitchRelayIdentity;
    if (current && (current.videoId !== status.videoId || current.revision !== status.revision)) return false;
    ws.pendingPitchRelayStatus = null;
    ws.pitchRelayIdentity = { videoId: status.videoId, revision: status.revision };
    ws.pitchRelayEnabled = status.status === 'enabled';
    ws.pitchRelayStatus = status;
    if (status.status === 'stopped') ws.pitchRelayIdentity = null;
    const forwarded = sendYouTubePitchRelayToExtension(status);
    if (status.status === 'stopped') ws.pitchRelayStatus = null;
    return forwarded;
  }
  const frame = normalizeKaraokePitchFrame(raw);
  if (!frame || !ws.pitchRelayEnabled || !ws.pitchRelayIdentity
    || ws.pitchRelayIdentity.videoId !== frame.videoId
    || ws.pitchRelayIdentity.revision !== frame.revision
    || !pitchRelayIdentityMatches(frame)) return false;
  return sendYouTubePitchRelayToExtension(frame);
}

function normalizeYouTubeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function withYouTubeRevision(value, revision) {
  const normalized = normalizeYouTubeRevision(revision);
  return value && normalized !== null ? { ...value, revision: normalized } : value;
}

function withoutYouTubeRevision(value) {
  if (!value || typeof value !== 'object') return value;
  const { revision, ...wire } = value;
  return wire;
}

function currentYouTubeRevision(videoId) {
  if (currentYouTubeExtensionState?.videoId === videoId) return currentYouTubeExtensionState.revision;
  if (currentYouTubeLyrics?.videoId === videoId) {
    const revision = normalizeYouTubeRevision(currentYouTubeLyrics.revision);
    if (revision !== null) return revision;
  }
  if (currentYouTubeLyricsStatus?.videoId === videoId) {
    const revision = normalizeYouTubeRevision(currentYouTubeLyricsStatus.revision);
    if (revision !== null) return revision;
  }
  return null;
}

function cachedYouTubeRevision() {
  return normalizeYouTubeRevision(currentYouTubeLyrics?.revision)
    ?? normalizeYouTubeRevision(currentYouTubeLyricsStatus?.revision);
}

function hasCurrentYouTubeLyrics(state) {
  if (!currentYouTubeLyrics || currentYouTubeLyrics.videoId !== state.videoId) return false;
  const revision = normalizeYouTubeRevision(currentYouTubeLyrics.revision);
  return revision === null || revision === state.revision;
}

function sendYouTubeLyricsStatusToExtension(status) {
  if (!status || global.activeYouTubeExtension?.readyState !== 1) return false;
  global.activeYouTubeExtension.send(JSON.stringify(withoutYouTubeRevision(status)));
  return true;
}

function publishYouTubeLyricsStatus(videoId, status, error = null, revision = currentYouTubeRevision(videoId)) {
  currentYouTubeLyricsStatus = withYouTubeRevision({
    type: 'youtube_karaoke_lyrics_status', videoId, status, error: error || null,
  }, revision);
  return sendYouTubeLyricsStatusToExtension(currentYouTubeLyricsStatus);
}

function getCachedYouTubeLyrics(artist, title) {
  return new Promise((resolve, reject) => {
    db.all('SELECT artist, lyrics FROM cache WHERE title = ?', [title], (err, rows) => {
      if (err) return reject(err);
      const wantedArtist = artist.replace(/\s+/g, ' ').trim();
      const row = (rows || []).find((candidate) =>
        typeof candidate.artist === 'string'
        && candidate.artist.replace(/\s+/g, ' ').trim() === wantedArtist);
      resolve(row?.lyrics ? toTraditional(row.lyrics) : '');
    });
  });
}

function getCachedYouTubeOffset(artist, title) {
  return new Promise((resolve) => {
    db.get('SELECT offset FROM sync_offsets WHERE title = ? AND artist = ?', [title, artist], (err, row) => {
      resolve(!err && row && typeof row.offset === 'number' && Number.isFinite(row.offset) ? row.offset : null);
    });
  });
}

async function findYouTubeOffset(candidates) {
  const seen = new Set();
  for (const [candidateArtist, candidateTitle] of candidates) {
    const key = `${candidateArtist}\u0000${candidateTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const offset = await getCachedYouTubeOffset(candidateArtist, candidateTitle);
    if (offset !== null) return offset;
  }
  return 0;
}

function cacheYouTubeLyrics(artist, title, lyrics) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR REPLACE INTO cache (artist, title, lyrics) VALUES (?, ?, ?)', [artist, title, lyrics], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function loadYouTubeLyrics(state, { force = false } = {}) {
  const rawTitle = state.title.trim();
  const rawArtist = state.channel.trim();
  // Match the main media path: YouTube metadata is browser noise, not a
  // music-app track key. Clean it before the cache miss reaches search.
  const cleaned = cleanBrowserQuery(rawTitle, rawArtist);
  const title = cleaned.title;
  const artist = canonicalArtist(cleaned.artist);
  const query = await buildSearchQuery(title, artist);
  let cachedRaw = await getCachedYouTubeLyrics(rawArtist, rawTitle);
  if (!cachedRaw) {
    const compactTitle = rawTitle.replace(/\s{2,}/g, ' ');
    if (compactTitle !== rawTitle) cachedRaw = await getCachedYouTubeLyrics(rawArtist, compactTitle);
  }
  if (!cachedRaw && (cleaned.title !== rawTitle || cleaned.artist !== rawArtist)) {
    cachedRaw = await getCachedYouTubeLyrics(cleaned.artist, cleaned.title);
  }
  if (!cachedRaw && (query.cleanTitle !== title || query.trueArtist !== artist)) {
    cachedRaw = await getCachedYouTubeLyrics(query.trueArtist, query.cleanTitle);
  }
  let raw = force ? '' : cachedRaw;
  await retryYouTubeNegativeWordTimes(artist, title);
  // YouTube used to accept an older non-QQ cache entry even after word_times had
  // been found. Reuse the main cache repair rule so a QQ word track can replace
  // only the mismatched lyric body (manual edits remain untouched).
  const retryKey = `${artist}|||${title}`;
  if (raw && !force && !raw.startsWith('[source:ManualEdit]') && !inlineRetried.has(retryKey)) {
    const wt = await wordTimesMismatch(artist, title, raw);
    if (wt) {
      inlineRetried.add(retryKey);
      const found = await searchBestLyric(title, artist, query.cleanTitle, query.trueArtist, {
        deadlineMs: 20000, youtube: true
      });
      if (found.lyric && mergeWordTimes(found.lyric, wt) !== found.lyric) {
        raw = found.lyric;
        await cacheYouTubeLyrics(artist, title, raw);
        invalidateFurigana(artist, title);
      }
    }
  }
  if (!raw) {
    // Reuse the main player query path: overrides, artist aliases, browser noise and
    // feat/Live/Remastered cleanup must apply to extension-originated video metadata too.
    const found = await searchBestLyric(title, artist, query.cleanTitle, query.trueArtist, { deadlineMs: 20000, youtube: true });
    raw = found.lyric;
    if (raw) await cacheYouTubeLyrics(artist, title, raw);
    else if (force) raw = cachedRaw;
  }
  if (!raw) return { videoId: state.videoId, status: 'no_lyrics' };
  const injected = await injectFurigana(artist, title, raw, { waitForWordTimes: true });
  const lyrics = buildYouTubeLyricsPayload(state.videoId, injected);
  const offset = await findYouTubeOffset([
    [rawArtist, rawTitle],
    [cleaned.artist, cleaned.title],
    [artist, title],
    [query.trueArtist, query.cleanTitle],
  ]);
  if (lyrics) lyrics.offsetMs = Math.round(offset * 1000);
  return lyrics?.lines.length
    ? { videoId: state.videoId, status: 'loaded', lyrics }
    : { videoId: state.videoId, status: 'no_lyrics' };
}

const youtubeLyricsCoordinator = createYouTubeLyricsCoordinator({
  search: loadYouTubeLyrics,
  publish(message) {
    const revision = currentYouTubeRevision(message.videoId);
    if (message.status === 'loaded' && message.lyrics) {
      currentYouTubeLyrics = withYouTubeRevision(message.lyrics, revision);
      publishYouTubeLyricsStatus(message.videoId, 'loaded', null, revision);
      sendYouTubeLyricsToExtension(currentYouTubeLyrics);
      return;
    }
    const status = resolveYouTubeLyricsStatus(currentYouTubeLyrics, message, revision);
    if (status !== 'loaded') currentYouTubeLyrics = null;
    publishYouTubeLyricsStatus(message.videoId, status, status === 'loaded' ? null : message.error, revision);
  },
});

// WebSocket 的 upgrade 不會經過 express middleware,同源守門要在這裡再擋一次 ——
// 否則惡意網頁還是能連上來收播放狀態廣播 (你正在聽什麼)。靈動島用 C# ClientWebSocket,
// 不帶 Origin,照常放行。
function isYouTubeExtensionHandshake(info) {
  const origin = info.origin || info.req?.headers?.origin || '';
  const originIsFixed = YOUTUBE_EXTENSION_ID
    ? origin === `chrome-extension://${YOUTUBE_EXTENSION_ID}`
    : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (!originIsFixed) return false;
  const protoHeader = info.req?.headers?.['sec-websocket-protocol'] || '';
  const protocols = protoHeader.split(',').map((s) => s.trim()).filter(Boolean);
  return protocols[0] === 'kanaric-youtube-v1' && tokenMatches(protocols[1], YOUTUBE_EXTENSION_TOKEN);
}

function sendYouTubeLyricsToExtension(lyrics) {
  if (!lyrics || lyrics !== currentYouTubeLyrics) return false;
  const latest = currentYouTubeExtensionState;
  const revision = normalizeYouTubeRevision(lyrics.revision);
  if (latest && (lyrics.videoId !== latest.videoId || revision !== latest.revision)) return false;
  if (global.activeYouTubeExtension?.readyState !== 1) return false;
  global.activeYouTubeExtension.send(JSON.stringify({
    type: 'youtube_karaoke_lyrics', lyrics: withoutYouTubeRevision(lyrics),
  }));
  return true;
}

function sendYouTubeLyricsOptionsToExtension(message) {
  if (!message || global.activeYouTubeExtension?.readyState !== 1) return false;
  global.activeYouTubeExtension.send(JSON.stringify(message));
  return true;
}

async function applyYouTubeLyricsOption(request, selection) {
  const latest = currentYouTubeExtensionState;
  if (!latest || latest.videoId !== request.videoId || latest.revision !== request.revision) return false;
  const option = selection.job.options[selection.index];
  if (!option) return false;
  const { injected } = await saveManualLyrics(request.title, request.artist, option.lyrics);
  const current = currentYouTubeExtensionState;
  if (!current || current.videoId !== request.videoId || current.revision !== request.revision) return false;
  const lyrics = buildYouTubeLyricsPayload(request.videoId, injected);
  if (!lyrics) return false;
  currentYouTubeLyrics = withYouTubeRevision(lyrics, request.revision);
  publishYouTubeLyricsStatus(request.videoId, 'loaded', null, request.revision);
  sendYouTubeLyricsToExtension(currentYouTubeLyrics);
  return true;
}

function clearCurrentYouTubeLyrics() {
  const videoId = currentYouTubeLyrics?.videoId || currentYouTubeExtensionState?.videoId;
  if (!videoId) return false;
  currentYouTubeLyrics = currentYouTubeLyrics?.videoId === videoId
    ? { ...currentYouTubeLyrics, lines: [] }
    : withYouTubeRevision({ videoId, offsetMs: 0, lines: [] }, currentYouTubeRevision(videoId));
  sendYouTubeLyricsToExtension(currentYouTubeLyrics);
  return true;
}

const wss = new WebSocketServer({
  server,
  // B4:雲端那台沒有媒體監控,也沒有任何正當的 WebSocket 客戶端 (行動版只打 /api/lyrics),
  // 一律拒絕。upgrade 不經過 express middleware,所以上面那道允許清單擋不到這裡。
  verifyClient: (info) => !CLOUD && (
    !info.origin && !info.req?.headers?.origin
      ? true
      : isAllowedOrigin(info.origin || info.req?.headers?.origin || '') || isYouTubeExtensionHandshake(info)
  ),
  handleProtocols: (protocols, req) => {
    const offered = Array.from(protocols);
    if (isYouTubeExtensionHandshake({ req }) && offered[0] === 'kanaric-youtube-v1') return 'kanaric-youtube-v1';
    return false;
  },
});

wss.on('connection', (ws) => {
  ws.isYouTubeExtension = ws.protocol === 'kanaric-youtube-v1';
  if (ws.isYouTubeExtension) {
    if (global.activeYouTubeExtension && global.activeYouTubeExtension.readyState === 1 && global.activeYouTubeExtension !== ws) {
      try { global.activeYouTubeExtension.close(4000, 'replaced'); } catch (e) {}
    }
    global.activeYouTubeExtension = ws;
    sendYouTubeLyricsStatusToExtension(currentYouTubeLyricsStatus);
    sendYouTubeLyricsToExtension(currentYouTubeLyrics);
    replayPitchRelayStatuses();
    console.log('WebSocket client connected (YouTube Karaoke Extension)');
  } else {
    console.log('WebSocket client connected (Dynamic Island)');
  }
  
  let currentSettings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try { currentSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
  }
  if (currentSettings.island_lines === undefined) currentSettings.island_lines = 2;
  
  if (!ws.isYouTubeExtension) {
    ws.send(JSON.stringify({ type: 'init', state: currentMediaState, settings: currentSettings }));
    ws.send(JSON.stringify({ type: 'game_state', active: isGameActive() }));
  }

  // 「猜歌遊戲進行中」與「卡拉OK頁開著」都綁在那一頁自己的連線上,不用旗標檔也不用逾時 ——
  // 關頁/重整/當掉都會斷線,旗標自動歸零,不會卡成「聆聽紀錄永久停寫」或「島再也不回來」。
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (ws.isYouTubeExtension) {
      if (msg.type === 'youtube_karaoke_state_reset') {
        stopAllPitchRelays();
        currentYouTubeExtensionState = null;
        currentYouTubeLyrics = null;
        currentYouTubeLyricsStatus = null;
        youtubeLyricsCoordinator.resetActive();
        broadcastToKaraoke({ type: 'youtube_karaoke_owner_lost' });
        return;
      }
      if (msg.type === 'youtube_karaoke_state') {
        const state = normalizeExtensionState(msg.state || msg);
        const previousState = currentYouTubeExtensionState;
        if (!state) return;
        if (previousState && (state.videoId !== previousState.videoId || state.revision !== previousState.revision)) {
          stopAllPitchRelays();
        }
        const videoChanged = previousState && state.videoId !== previousState.videoId;
        const cachedRevision = cachedYouTubeRevision();
        const revisionAdvanced = !!((previousState && state.revision > previousState.revision)
          || (!previousState && cachedRevision !== null && state.revision > cachedRevision));
        const freshNavigation = revisionAdvanced || (videoChanged && state.state === 'loading');
        if (currentYouTubeExtensionState && !freshNavigation
          && (state.revision < currentYouTubeExtensionState.revision
            || (state.revision === currentYouTubeExtensionState.revision
              && state.videoId !== currentYouTubeExtensionState.videoId))) return;
        if (revisionAdvanced) youtubeLyricsCoordinator.resetActive();
        if (freshNavigation) {
          if (revisionAdvanced && !videoChanged) {
            currentYouTubeLyrics = null;
            currentYouTubeLyricsStatus = null;
          } else if (!currentYouTubeLyrics || currentYouTubeLyrics.videoId !== state.videoId) {
            currentYouTubeLyrics = null;
            currentYouTubeLyricsStatus = null;
          }
        }
        const metadataChanged = previousState
          && state.videoId === previousState.videoId
          && state.revision === previousState.revision
          && (state.title !== previousState.title || state.channel !== previousState.channel);
        if (metadataChanged) {
          currentYouTubeLyrics = null;
          currentYouTubeLyricsStatus = null;
        }
        currentYouTubeExtensionState = state;
        replayPitchRelayStatuses();
        broadcastToKaraoke({ type: 'youtube_karaoke_state', ...state });
        if (!['ad', 'error'].includes(state.state) && state.title && state.channel
          && !hasCurrentYouTubeLyrics(state)) {
          youtubeLyricsCoordinator.request(state, { force: metadataChanged });
        }
      }
      if (msg.type === 'youtube_karaoke_search') {
        const latest = currentYouTubeExtensionState;
        if (!latest) return;
        const request = normalizeKaraokeLyricsSearch(msg, latest);
        if (!request) return;
        youtubeLyricsCoordinator.request({ ...latest, title: request.title, channel: request.channel }, {
          force: request.force === undefined ? true : request.force,
        });
      }
      if (msg.type === 'youtube_karaoke_lyrics_options_request') {
        const request = normalizeYouTubeLyricsOptionsRequest(msg);
        const latest = currentYouTubeExtensionState;
        if (!request || !latest || request.videoId !== latest.videoId || request.revision !== latest.revision) return;
        const job = startOptionsJob({ title: request.title, artist: request.artist });
        sendYouTubeLyricsOptionsToExtension(buildYouTubeLyricsOptionsMessage(job, request, job.status));
        Promise.resolve(job.promise).then(() => {
          const current = currentYouTubeExtensionState;
          if (current?.videoId === request.videoId && current.revision === request.revision) {
            sendYouTubeLyricsOptionsToExtension(buildYouTubeLyricsOptionsMessage(job, request, 'done'));
          }
        });
      }
      if (msg.type === 'youtube_karaoke_lyrics_option_select') {
        const selectionRequest = normalizeYouTubeLyricsOptionSelect(msg);
        const latest = currentYouTubeExtensionState;
        const selection = selectionRequest && youtubeOptionSelections.get(selectionRequest.optionId);
        if (!selectionRequest || !selection || !latest
          || selectionRequest.videoId !== latest.videoId || selectionRequest.revision !== latest.revision
          || selection.videoId !== latest.videoId || selection.revision !== latest.revision
          || optionJobs.get(jobKey(selection.artist, selection.title)) !== selection.job) return;
        applyYouTubeLyricsOption(selectionRequest, selection).catch(() => false).then((applied) => {
          if (!applied && currentYouTubeExtensionState?.videoId === selectionRequest.videoId
            && currentYouTubeExtensionState.revision === selectionRequest.revision) {
            sendYouTubeLyricsOptionsToExtension(buildYouTubeLyricsOptionsMessage(
              selection.job, selectionRequest, 'error', '套用備選歌詞失敗'));
          }
        });
      }
      return;
    }
    if (msg.type === 'youtube_karaoke_pitch_status' || msg.type === 'youtube_karaoke_pitch_frame') {
      handleKaraokePitchRelay(ws, msg);
      return;
    }
    if (msg.type === 'youtube_karaoke_command') {
      const command = normalizeKaraokeCommand(msg.command);
      if (!command || !global.activeYouTubeExtension || global.activeYouTubeExtension.readyState !== 1) return;
      global.activeYouTubeExtension.send(JSON.stringify({ type: 'youtube_karaoke_command', command }));
      return;
    }
    if (msg.type === 'youtube_karaoke_search') {
      if (!ws.isKaraoke) return;
      const latest = currentYouTubeExtensionState;
      if (!latest) return;
      const request = normalizeKaraokeLyricsSearch(msg, latest);
      if (!request) return;
      youtubeLyricsCoordinator.request({ ...latest, title: request.title, channel: request.channel }, {
        force: request.force === undefined ? true : request.force,
      });
      return;
    }
    if (msg.type === 'youtube_karaoke_lyrics_prefetch') {
      if (!ws.isKaraoke) return;
      const request = normalizeKaraokeLyricsPrefetch(msg);
      if (!request) return;
      ws.send(JSON.stringify({
        type: 'youtube_karaoke_lyrics_prefetch_status',
        videoId: request.videoId,
        status: 'searching',
      }));
      youtubeLyricsCoordinator.prefetch(request).then((result) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'youtube_karaoke_lyrics_prefetch_status',
          ...result,
        }));
      });
      return;
    }
    if (msg.type === 'game_active') {
      const active = !!msg.active;
      if (ws.isGame === active) return;
      ws.isGame = active;
      // game_state 只跟猜歌有關 (島上的字要換成「猜歌中」),卡拉OK不發這則
      global.broadcast({ type: 'game_state', active: isGameActive() });
      syncIslandHidden();
      return;
    }
    if (msg.type === 'karaoke_active') {
      const active = !!msg.active;
      if (!active) stopPitchRelayForSocket(ws);
      if (ws.isKaraoke === active) return;
      const wasKaraoke = ws.isKaraoke;
      ws.isKaraoke = active;
      if (wasKaraoke && !active && !isKaraokeActive()) clearCurrentYouTubeLyrics();
      syncIslandHidden();
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (ws.isYouTubeExtension && global.activeYouTubeExtension === ws) {
      stopAllPitchRelays();
      global.activeYouTubeExtension = null;
      currentYouTubeExtensionState = null;
      broadcastToKaraoke({ type: 'youtube_karaoke_owner_lost' });
    }
    if (!ws.isYouTubeExtension) stopPitchRelayForSocket(ws);
    const wasKaraoke = ws.isKaraoke;
    ws.isKaraoke = false;
    // 那兩種頁直接關掉時,島要自己開回來 (猜歌還要解除遮蔽)
    if (ws.isGame) global.broadcast({ type: 'game_state', active: isGameActive() });
    if (wasKaraoke && !isKaraokeActive()) clearCurrentYouTubeLyrics();
    if (ws.isGame || wasKaraoke) syncIslandHidden();
  });
});

// 任何一個連線掛著旗標就算進行中 (同時開兩個遊戲頁/卡拉OK頁不會互相取消)
function isGameActive() {
  for (const c of wss.clients) if (c.isGame && c.readyState === 1) return true;
  return false;
}
function isKaraokeActive() {
  for (const c of wss.clients) if (c.isKaraoke && c.readyState === 1) return true;
  return false;
}

// 猜歌開始、或卡拉OK頁開著,就把靈動島整個收起來。
//   猜歌:島上的字雖然已經換成「猜歌中」,但它是置頂視窗,遊戲期間擋在畫面上沒有任何用處。
//   卡拉OK:那一頁本身就是一個更大的歌詞畫面,島是重複的,而且它置頂會蓋在上面。
// **只有「是我們收起來的」才自動開回來** —— 使用者本來就沒開島的話,離開時不該自作主張
// 生一個出來。兩個來源共用同一個旗標:先進猜歌再進卡拉OK也只會開回來一次。
let islandHiddenByPage = false;
function syncIslandHidden() {
  if (typeof global.isIslandOpen !== 'function') return;   // 純 node (npm start) 沒有主進程
  const hide = isGameActive() || isKaraokeActive();
  try {
    if (hide && global.isIslandOpen()) {
      islandHiddenByPage = true;
      global.closeIsland();
    } else if (!hide && islandHiddenByPage) {
      islandHiddenByPage = false;
      global.openIsland();
    }
  } catch (e) { console.error('切換靈動島失敗:', e.message); }
}

global.broadcast = function(message) {
  const msgStr = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* WebSocket.OPEN */ && !client.isYouTubeExtension) {
      client.send(msgStr);
    }
  });
};

function broadcastToKaraoke(message) {
  const msgStr = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.isKaraoke) client.send(msgStr);
  });
}

// 只綁 127.0.0.1,不綁 0.0.0.0:API 全無認證,同網段的人若能打進來就能改設定、
// 清資料庫、把備份還原成別的東西。靈動島與網頁前端都走 localhost,不受影響。
// 純 node (npm start) 沒有 electron 的 findFreePort,5720 被占會直接 EADDRINUSE 崩
// (而且是 WebSocketServer 那邊先炸)。先探一次:preferred 空就用它,被占就讓 OS 指派。
// 先探再 listen 一次,避開 bind 後才拋 error 的處理。electron 已先設好空閒 PORT,所以
// 打包版第一探就中、行為不變。ALLOWED_ORIGINS 要跟著加實際 port,否則同源守門會把
// dashboard 自己的 /api 當跨站擋掉。
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const t = net.createServer();
    t.once('error', () => {
      const t2 = net.createServer();
      t2.listen(0, '127.0.0.1', () => { const p = t2.address().port; t2.close(() => resolve(p)); });
    });
    // ponytail: close→listen 之間有極小 TOCTOU 窗口,單機桌面 app 可忽略 (同 electron.js)
    t.listen(preferred, '127.0.0.1', () => {
      const p = t.address().port;
      t.close(() => resolve(p));
    });
  });
}
// B2:雲端模式綁 0.0.0.0 且用 Render 指定的那個 PORT (換一個 port 它就探測不到、判定部署失敗),
// 所以**不能**走 findFreePort。上面那段「不綁 0.0.0.0」的理由在雲端不成立:允許清單已經把
// 所有寫入路由與 /api/settings 變成 404,那台除了可重建的歌詞快取什麼都沒有。
if (CLOUD) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[cloud] 唯讀歌詞服務 listening on 0.0.0.0:${PORT}`);
  });
} else {
  findFreePort(PORT).then((p) => {
    ALLOWED_ORIGINS.add(`http://localhost:${p}`);
    ALLOWED_ORIGINS.add(`http://127.0.0.1:${p}`);
    server.listen(p, '127.0.0.1', () => {
      console.log(`Web Server & WebSocket running on http://localhost:${p}`);
    });
  });
}

module.exports = { app, db, pitchTakeStore, server, wss };
