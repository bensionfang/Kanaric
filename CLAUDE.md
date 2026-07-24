# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop floating-lyrics system (Windows-only for full functionality): it picks a playing media session via the Windows Media API (music apps preferred, or a user-chosen app), fetches synced lyrics from external sources, annotates Japanese kanji with furigana, and displays lyrics in a C# "Dynamic Island" overlay plus a web dashboard with listening stats. README.md and most code comments are in Traditional Chinese.

## Commands

```bash
# Python deps (repo root; a venv/ exists and is auto-detected by server.js)
pip install -r requirements.txt

# Node deps + run (everything starts from web-app/)
cd web-app
npm install
npm start        # node server.js — also spawns the Python media monitor on Windows
npm run dev      # nodemon
npm run app      # Electron shell: server + dashboard window + tray + island, one command

# Distribution (single NSIS installer, target machine needs no Python/Node)
npm run dist     # = build:py (PyInstaller → dist-py/) + electron-builder (→ web-app/release/)
```

- Web dashboard: http://localhost:5720 (預設值;被占用時自動改用空閒 port,靈動島視窗直接載入同一個 port 的 `/island`)

### 發版 (GitHub Release)

更新有**兩條路,不要合併**:打包版由 `electron-updater` 自己下載安裝 (`setupAutoUpdate()` in electron.js,
只在 `app.isPackaged` 時啟用);`npm start` 純 node 模式沒有主進程,只剩 `GET /api/update-check` 跳吐司
叫使用者自己去下載。`/api/update-check` 因此多回 `autoUpdate`/`ready` 兩個旗標,`checkForUpdate()`
(footer.ejs) 靠它決定要顯示哪一種提示 —— **打包版不該再叫人去手動下載**,那是錯的指示。

```bash
# 1. 改版號
#    web-app/package.json 的 "version" 改成新版號 (例如 1.1.0)

# 2. build 安裝檔
cd web-app && npm run dist   # 產物在 web-app/release/

# 3. 打 tag、推、建 release、附安裝檔 + latest.yml
git tag v1.1.0                # 一定要帶 v 前綴,server.js 用 /^v/ 剝掉再跟 package.json 比對
git push origin v1.1.0
gh release create v1.1.0 \
  "web-app/release/Kanaric-Setup-1.1.0.exe" \
  "web-app/release/latest.yml" \
  --title "v1.1.0" --notes "..."
```

**`latest.yml` 一定要一起上傳** —— electron-updater 是靠它比對版本的,漏了自動更新就完全不會發生
(而且不會報錯,只是安靜地什麼都沒做)。`build.publish` 設成 github provider 才會產出這個檔。
tag 沒帶 `v` 或漏推,純 node 模式的更新提醒也抓不到新版。安裝檔未簽章,`gh release create` 會直接
公開發布,屬於「發布公開內容」的動作,不要自動執行,要使用者自己按。
- 靈動島 = Electron 的一個視窗 (`web-app/island.js`),由 `npm run app` 一起帶起,沒有獨立進程也沒有 build 步驟。
- 沒有 test runner 或 linter。零星的獨立測試檔直接用直譯器跑:`node test_origin_guard.js` (同源守門)、`node test_s2t.js` (簡轉繁)、`node test_search_query.js` (繁轉簡 + 瀏覽器標題去噪)、`node test_title_lines.js` (製作人員/版權列標記)、`node test_translations.js` (中文譯文合併)、`node test_itunes_resolving.js` (iTunes 原名還原的時序)、`node test_history_toggle.js` (聆聽紀錄開關 + 清除白名單)、`node test_backup_restore.js` (備份/還原 + 還原前的驗證守門)、`node test_scroll_zone.js` (歌詞自動捲動的三段判定)、`python test_pick_session.py`、`python test_furigana_hint.py` (Python 的要用 `venv/Scripts/python.exe`,系統 python 沒裝 fugashi)。
- `ROADMAP.md` (repo 根,**本機檔案,不進版控**) 記著 v1.0.0 之後的規劃與**明確不做的事**。動到「未來要做什麼」的討論先看它,免得重新提案已經否決過的方向 (雲端同步、換 tokenizer、離線辭典、Steam 式強制更新)。clone 下來沒有這個檔屬正常。
  主軸是**歌詞體驗**,不是學日文 —— 翻譯/查詞這類功能要進來,得先過「它讓歌詞更好讀嗎」這一關。

## Architecture

One Node.js backend, multiple thin clients, with Python scripts as helpers spawned as child processes:

- **`web-app/server.js`** (~1200 lines, the whole backend): Express + WebSocket server owning all business logic — REST API routes, lyrics fetching (order driven by the `preferred_source` setting, with caching), artist-alias substitution, iTunes JP name resolution (undoes Spotify's auto-translation of Japanese titles), a 30-second "valid listen" state machine before writing history, and WebSocket broadcast of the current media state to all clients. `server.listen` binds `127.0.0.1` explicitly, not `0.0.0.0`, and **there is no auth on any route** — 安全性完全靠「只有本機、且只有同源」這兩條。
  - 同源守門是 server.js 的第一個 middleware,`cors()` 已經移除 (開 CORS 等於自己拆掉這道牆)。它同時看 `Origin` 與 `Sec-Fetch-Site`,兩層都必要:`Origin` 只有 fetch/XHR 會帶,`<script src>` 這類不帶,而 `Sec-Fetch-Site` 瀏覽器對所有請求都帶。兩個 header 都沒有 = 非瀏覽器客戶端 (curl、腳本),放行;靈動島現在是 Electron 視窗,兩個 header 都會帶,走的是同源那條。WebSocket 的 upgrade 不經過 express middleware,所以 `verifyClient` 要再擋一次。
  - **綁 127.0.0.1 擋不住跨站攻擊**,這是這道守門存在的理由:使用者開著 Kanaric 時瀏覽任一網頁,那個網頁就能打這裡的 API —— 跨站 POST `/api/settings` 把 `llm_base_url` 改成攻擊者的位址,再觸發 `/api/llm-models` 或 `/api/llm-furigana/run`,BYOK 的 API key 就送出去了。`<form>` POST 屬於 simple request,不觸發 preflight,所以光靠 CORS 設定擋不住。
  - **跨站的「頂層導覽」是例外,要放行** (`GET`/`HEAD` + `Sec-Fetch-Dest: document`):使用者從 README、聊天視窗點 `http://localhost:5720` 連結進來就是這種請求,擋掉只會讓人看到一行 JSON 錯誤。放行不開洞 —— 跨站 `<form>` POST 的 dest 也是 document,但方法是 POST,照樣擋住;`<img>`/`<script src>` 的 dest 是 image/script,iframe 內嵌是 iframe,都不是 document。**只認 dest 不要再比 mode**:mode 多擋不到東西,而且 undici 會把 fetch 的 `Sec-Fetch-Mode` 硬改成 `cors`,測試根本設不進去。
  - 回歸測試:`node test_origin_guard.js` (repo 根目錄,自己帶起一份 server)。動到這段 middleware、`ALLOWED_ORIGINS`、或 WebSocket 的 `verifyClient` 就跑它。
  - 簡轉繁 = `web-app/s2t.js` 的 `toTraditional()` (opencc-js `cn`→`tw`)。掛在**四個 `SELECT lyrics FROM cache` 的讀取點**,外加寫入前的兩個外部歌詞入口 (自動抓取、`/api/lyrics/custom` —— 它同時是「套用備選歌詞」的入口)。**讀取時轉是必要的**:只在寫入時轉的話,改版前就存在快取裡的歌詞永遠不會變繁體,使用者重載/重開都沒用。編輯器的 `/api/lyrics/update`、`/api/lyrics/save` 是使用者自己打的字,寫入時刻意不轉。
    - **日文歌詞本體絕不能過這個轉換** (日文漢字大量與簡體同形,`声`→`聲`、`学校`→`學校`),所以有假名就跳過 —— 跟 `furigana_inject.py` 是同一條假名分界規則。唯一的例外是已標 `#TITLE#` 的製作人員列:網易連日文歌都給簡體的 `作词 : …`,那幾列照轉。
    - 回歸測試 `node test_s2t.js`。邏輯獨立成一個檔案就是為了讓測試 require 得到而不必啟動 server。
    - 反向的 `toSimplified()` 只給**查中國平台**用:三家的搜尋結果標題是簡體,`cn_music._title_matches` 是正規化後互相包含,繁體歌名 (告白氣球) 永遠對不上簡體結果 (告白气球),整首歌 MISS。**不能無條件轉** —— 純漢字的日文歌名 (新宝島 → 新宝岛) 轉了反而查不到,所以 `fetchCnLyricsS2()` (server.js) 是「原名先查、全 MISS 且轉換後真的不同才用簡體重試一次」,成功路徑零額外請求。快取鍵不受影響:`pytools.py cnlyrics` 的 `searchTitle/searchArtist` 與存 DB 用的 `title/artist` 本來就分開。
  - **中文譯文 (`web-app/translations.js`) 絕對不能存進 `cache`,只能在注音之後才併進廣播內容。** 理由是 `s2t.js` 的簡轉繁與 `furigana_inject.process_lrc` 的注音,**兩個 kana gate 都是「整份有沒有假名」而不是逐行**:譯文混進去會 (a) 不被轉繁 (b) 被 fugashi 標上一堆亂七八糟的音讀。所以譯文獨立存 `lyrics_translations` 表 (與 `romaji_hints`/`llm_hints` 同形,空 `{}` 是負快取),由 `mergeTranslations()` 在 `injectFurigana()` 之後插成 `[同一個時間戳]#TRANS#譯文` 行。
    - **`translations.js` 的 `normalizeLine()` 必須與 `cn_music.normalize_line` 產生逐字相同的字串**,對不上就是靜默失效 (沒有錯誤、沒有 log)。Python 的 `\w` 對 str 是 Unicode 感知的,JS 的 `\w` 只有 `[A-Za-z0-9_]`,所以 JS 那份要明寫 `\p{L}\p{N}\p{M}`。比對前還要 `stripRuby()` 把 `<rt>` 的內容**整塊**刪掉 —— 只脫標籤的話「夢<rt>ゆめ</rt>」會變成「夢ゆめ」,永遠對不上。
    - **歌詞來源常把兩三個短句併成一行 (中間全形空白),譯文的鍵卻是逐句的** —— 整行比對就整行 MISS,而且靜默。`lookupTranslation()` 因此在整行對不上時把行拆段、由長到短貪婪比對 (段落本身可能要合起來才是一個鍵:`いつしか海に流れ着いて 光って`),**任一段查不到就整行放棄** (只翻半句更難讀)。實測全庫 2612 行缺譯文 173 → 114 行,`米津玄師 / 春雷` 缺 38 → 13、`back number / 水平線` 缺 11 → 0。
    - 合併刻意在 `furiganaCache` **之外**:切換「顯示翻譯」不必重跑 python,快取也不用多一個比對維度 (對照 `kata` 那個旗標)。
    - 譯文只在抓歌詞時搭便車存下來,所以改版前的舊快取一首都沒有。`ensureTranslations()` 會在開了設定卻查無資料時背景補抓一次。**`translationJobs` 成功失敗都留著鍵** —— 抓失敗時 pytools 不會寫負快取,鍵一刪就變成「補抓 → rebroadcast → 還是沒有 → 再補抓」的無窮迴圈。
    - 三家的譯文位置:網易 `tlyric` (自帶時間戳)、酷狗 krc `language` 軌 `type=1` (行序對齊)、QQ `contentts`。**QQ 那條是明文 LRC 而非加密 QRC**,所以走 `_qq_plain_track()` 不走 `_qq_track()`;而且那支端點不回 charset,`requests` 會猜成 ISO-8859-1 把譯文變亂碼,`r.encoding = "utf-8"` 不能拿掉 (主歌詞軌是 hex ASCII 所以看不出問題)。
    - 回歸測試 `node test_translations.js`。
  - **瀏覽器 (YouTube) 來源的三道處理都以 `web-app/browser-query.js` 的 `isMusicAppSource()` 為閘門** (`MUSIC_APPS` 是 `media_monitor.py` 那份的手動鏡射;未知來源保守當音樂 app)。
    - 歌名去噪 `cleanBrowserQuery()`:含噪音關鍵字的整塊括號、`「」`/`『』`/`【】` 內文優先當歌名、無括號的尾綴噪音 (Official Music Video / MV / 中文字幕…)、尾段確實等於歌手時的 `歌名／歌手`、開頭確實等於歌手時的 `歌手 - 歌名` (YouTube 最常見的形狀,不剝的話快取鍵是「ヨルシカ - 春泥棒」,跟 Spotify 聽的「春泥棒」分裂成兩筆)、歌手的 `- Topic`/`VEVO` 尾綴。全部剝光時退回原始標題。`歌名／歌手` 與 `歌手 - 歌名` 用同一條判準 (正規化後互相包含),對不上就原樣留著 —— 所以歌名本身帶連字號的 (`怪獣の花唄 - replica -`) 不受影響。
    - **套用點是 `handleMediaUpdate` 的第一步 (去噪 → iTunes 還原 → `canonicalArtist` 別名收斂)**,不是只洗搜尋字串:每張表的鍵都是 (artist, title),不進場洗的話「Chevon-シェボン / ダンス・デカダンス／Chevon 【Lyric Video】」會跟 Spotify 聽的同一首在 cache 與排行榜分裂成兩筆 (`base_title` 只剝圓括號,`【】` 不在範圍)。原字串留在 `original_title`/`original_artist`。音樂 app 來源一個字都不動 —— `(Live)`/`(feat. …)` 是真的版本資訊。
    - `global.logListen` 對瀏覽器來源多一道閘門:**cache 裡沒有這首的歌詞就不記錄**。YouTube 上聽歌與看雜談影片是同一個 session,不擋的話「第1回ぶいすぽスポーツテストを見て…」這種影片會混進統計與排行榜。副作用是在 YouTube 聽的、真的找不到歌詞的冷門歌也不會被記錄。
    - `currentDuration()` 對瀏覽器來源回 `null`:YouTube 的 MV 含前奏/對白/outro 比音源長,而 `_pick_song` 在歌手對不上時要求 ±3 秒才收,拿影片長度當證據只會把正確的歌退貨。同理 `getResolvedMetadata` 也不吃瀏覽器來源的時長。
    - 回歸測試:`node test_search_query.js` (去噪規則 + `isMusicAppSource` + `toSimplified`)、`node test_history_toggle.js` (logListen 的瀏覽器閘門)、`node test_itunes_resolving.js` (進場去噪與音樂 app 不去噪)。
  - 不要為了「手機/別台電腦也能連」把 bind 改寬 —— 那要先做真正的 auth,同源守門對區網另一台機器沒有意義。
- **Python scripts (repo root)** are stateless workers `server.js` spawns via `child_process`, always through the **`pytools.py` dispatcher** (`spawnPy()` in server.js): `pytools.py monitor|furigana|fallback|cnlyrics|romaji|minimize|seek|media-action|sessions|diff`. In dev it runs `venv python pytools.py <sub>`; in the packaged app the `PYTOOLS_EXE` env var points at the PyInstaller-built `pytools.exe`.
  - **`main()` 開頭把 stdin **與** stdout 都 `reconfigure(encoding='utf-8')` —— 兩行都必要,少一行就是 bug。** 打包的 `pytools.exe` **不吃 `PYTHONIOENCODING`** (spawnPy 有設也沒用),stdio 編碼跟著 OS codepage 走。node 一律以 UTF-8 寫含日文的 JSON 進 stdin,所以在非 UTF-8 codepage 的機器 (**繁中 Windows 預設 cp950**) 上,stdin 會用 Big5 解 → 日文變亂碼 → `json.loads` 崩 → **假名整份消失** (furigana/cnlyrics/diff 都讀 stdin,全中)。曾經只補了 stdout,漏掉 stdin,害兩個不同使用者的打包版假名全掛。**開發機若開了 Windows「Beta: 使用 Unicode UTF-8」(codepage 65001) 會完全遮掉這個 bug** —— 打包版在你機器上跑得好、cp950 使用者卻壞,`chcp 950` 也模擬不出來 (系統層設定蓋不掉);要嘛在真 cp950 機器測,要嘛信這條。clone 跑原始碼不受影響:一般 `python.exe` (非 frozen) 對重導向 stdin 預設就給 UTF-8。
  - The underlying modules:
  - `media_monitor.py` — long-running; polls Windows Media API via `winrt` and emits one JSON line per state change on stdout. `server.js` parses these lines and auto-restarts the process on exit (unless `global.isShuttingDown`).
    - **`pick_session()` is the single source-selection rule**, shared by the monitor loop and the one-shot `seek` / `media-action` / `sessions` subcommands — don't inline a session filter anywhere else (all four used to hardcode `"spotify"` separately). The `media_source` setting holds either `'auto'` or an exact `source_app_user_model_id`. Auto = playing music app (`MUSIC_APPS`) > paused music app > any playing session; the paused-music tier deliberately outranks other playing sessions so a background video can't steal the lyrics while Spotify is paused. An explicitly chosen app that isn't running yields nothing rather than silently falling back.
    - The monitor re-reads `settings.json` when its mtime changes, so switching source takes effect live — there is no "restart the monitor on settings change" path and none should be added.
    - The empty (no session) payload must keep listing **every** field, because `handleMediaUpdate` merges shallowly (`server.js:146`); an omitted key leaves the previous song's value on screen.
  - `furigana_inject.py` — one-shot; JSON in via stdin, lyrics with furigana out via stdout. Readings come from fugashi/unidic-lite, then get corrected in three layers, each beating the last: `apply_hint()` (romaji hints from `cn_music`, aligned to the tokens with difflib) → `_COMMON_READING` (a tiny table of words *every* source gets wrong, currently just 私 → わたし) → `word_corrections` from the DB (user's manual edits, always final).
    - **「有沒有假名」是日文歌/中文歌的分界線,兩個地方共用這條規則**:`process_lrc()` 整份沒假名就原文回傳 (中文歌的漢字丟給 fugashi 只會得到亂七八糟的音讀,也順便省掉 `get_hints()` 的網路請求);`web-app/s2t.js` 的簡轉繁同理只在沒假名時動手。
    - `katakana_ruby` 設定 (預設關) 讓純片假名的詞也標平假名 ruby (`class='kata-ruby'`,刻意不是 `editable-ruby`:純字形轉換,不進 `word_corrections`)。讀音直接用 `kata2hira()`,不查字典,長音符 `ー` 保留。旗標由 server.js 讀 `settings.json` 後隨 stdin JSON 傳進來 —— 因此 `furiganaCache` 的命中條件除了歌詞本身還要比對這個旗標,`/api/settings` 收到它時也要 `rebroadcastLyrics()`,否則切換設定要等換歌才生效。
    - `build_ruby_html()` 裡「讀音 = 原文」的詞 (unidic 查不到的字,中文歌整行都是) 削掉前後綴後 `root_orig` 會變空字串 —— 那個分支必須把 `orig` 原樣 append 回去,否則整個詞會從畫面上消失。這就是舊版「中文歌缺字」的成因,回歸測試在 `test_furigana_hint.py`。
  - `cn_music.py` — client for NetEase / QQMusic / Kugou. One API call per platform yields both the LRC **and** a per-syllable romaji track (NetEase `romalrc`, QQ QRC `contentroma`, Kugou krc `type=0`), which is converted back to kana and used to fix readings unidic-lite gets wrong (e.g. 君 くん → きみ). Only readings that still differ after equivalence-normalization are overridden, since romaji can't distinguish づ/ず or は/わ.
    - **`_SOURCES` order is the hint priority** (first source with any romaji wins), and QQ deliberately sits ahead of Kugou: both are machine-generated, but Kugou tends to agree with unidic-lite's mistakes (both say 私 = わたくし) while QQ gets it right (わたし). QQ's *search* endpoint (`u.y.qq.com`) rate-limits hard and starts returning empty results after a burst — that's expected, it just falls through to Kugou.
    - `_pick_song()` gates every source's search results: the title must match, then artist and duration (±3s) break ties. 歌手不合時**時長是唯一的證據**,所以要落在同一個 ±3 秒才收 —— 單憑歌手不合就退貨會誤殺太多 (あいみょん 在 QQ 叫「爱缪」),但放寬到 ±10 秒等於沒把關:神はサイコロを振らない 的「初恋」(239 秒) 就那樣被判成林志美的粵語同名曲 (230 秒)。沒有時長資訊時照舊放行。回歸測試 `test_pick_song.py`。 Duration comes from `currentMediaState` in server.js and is what stops the 147-second preview clips QQ loves to return.
  - `qrc_decrypt.py` — pure-Python 3DES for QQ's QRC lyrics. **Do not replace this with a crypto library**: QQ uses a widely-copied C DES implementation with two typo'd S-box entries (sbox2 has a 15 that should be 2; sbox4 has a 10 that should be 13), so standard DES cannot decrypt it. Ported from Lyricify's `DESHelper.cs`.
  - `search_fallback.py` — one-shot fallback lyrics scraper (syncedlyrics providers + iTunes JP-title retry) when the preferred source misses. QQ is not fetched here; `cn_music._fetch_qqmusic` (working `musicu.fcg` endpoint) owns QQ. The old `fetch_qqmusic()` here (dead `client_search_cp` endpoint, HTTP 500) was removed.
- **靈動島 (`web-app/island.js` + `preload-island.js` + `views/island.ejs` + `public/css/island.css`)** — Electron 的 frameless 透明置頂視窗,載入 server 的 `/island`,靠 WebSocket 廣播吃資料,是純顯示端。
  - **視窗歸主進程管,頁面只負責畫。** 拖曳時 renderer 只在 mousedown/mouseup 各送一次 IPC,移動期間由主進程自己輪詢 `screen.getCursorScreenPoint()` 並 `setBounds` —— 逐幀送 IPC 會掉幀,`-webkit-app-region: drag` 則沒有拖曳結束事件、做不了吸附判定。吸附動畫是 easeOutQuart,沿用舊 C# 島的曲線。
  - 島也是**設定的寫入方** (拖曳結束存 `island_x/island_y/island_docked`),所以主進程走 `global.updateSettings()` —— 那是 `POST /api/settings` 的同一支實作,才會一起發 `settings_updated`,不會島與網頁各存各的。同理主進程讀設定用 `global.readSettings`。
  - 網頁的島開關 (`/api/island/status`、`/api/island/toggle`) 只是轉呼叫主進程掛上來的 `global.openIsland/closeIsland/isIslandOpen`。**純 node (`npm start`) 沒有主進程,回 `available:false`**,前端吐司提示需要桌面版 —— 不要為了讓純 node 也能開島而把島改回獨立進程。
  - preload 暴露的物件叫 **`window.islandBridge` 而不是 `island`**:頁面裡有 `<div id="island">`,瀏覽器的具名元素會占用 `window.island`,讓「不在 Electron 裡就降級成空實作」的判斷失效 (直接用瀏覽器開 `/island` 除錯就會壞)。
  - 舊的 C# WPF 島 (`DynamicIslandUI/`) 已刪除,要回頭參考就翻 git 歷史 (commit `ca16b66` 之前)。
  - **歌詞是外部來源的字串,而前端 (`app.js` 的 `pane.innerHTML`) 與靈動島都是 innerHTML 畫的 —— 送到畫面上的每一段外部文字都必須逃逸。** 不逃逸的話,網易/QQ/酷狗上任何人上傳一份帶 `<img onerror=…>` 的歌詞,就能在同源執行腳本:改 `llm_base_url` 再觸發 `/api/llm-furigana/run`,BYOK 的 key 就送出去了。同源守門完全擋不到,因為腳本本來就在同源裡跑。
    - 逃逸點分兩處,**因為歌詞本體要自己產 `<ruby>`,逃逸必須在產標籤之前**:`furigana_inject.py` 在分詞前 `html.escape(text)` (`build_ruby_html`、中文歌的提早退出、`#TITLE#` 列、`[ar:]` meta 列四條路徑都要);譯文不經過 python,由 `translations.js` 的 `escapeHtml()` 自己來。
    - 連帶的坑:譯文的比對鍵是 python 用**未逃逸**的原文算的,所以 `stripRuby()` 要把實體字串解回來 —— 不解的話 `Don't` → `Don&#x27;t` → 正規化成 `Donx27t`,含 `'` 或 `&` 的行永遠對不上譯文,而且是靜默失效。
    - 回歸測試:`python test_furigana_hint.py` 第 7 組、`node test_translations.js`。
- **`web-app/views/*.ejs` + `web-app/public/`** — web frontend (lyrics editor, leaderboard, stats).
- **`lyrics_data.db`** (repo root, SQLite, WAL mode): tables `cache` (lyrics keyed by artist+title), `listening_history`, `sync_offsets`, `word_corrections` (user furigana overrides), `artist_aliases` (maps Spotify's translated artist names back to originals, e.g. 魚韻 → サカナクション), `romaji_hints` (per-song reading hints from `cn_music`; an empty `{}` is a negative-cache entry meaning "already looked, no source has it"). Path configurable via `DB_PATH` env var. The .db file is gitignored (`*.db`),每台機器各自初始化。
  - **歌手名收斂在 `handleMediaUpdate` 做,只此一處。** 每張表的鍵都是 (artist, title),而不同播放 app 對同一位歌手給不同寫法 (Spotify 給「魚韻」、YouTube 給「サカナクション」),同一首歌就會分裂成兩筆。解法是進 `handleMediaUpdate` 時就用 `artistAliases` Map (開機載入 `artist_aliases` 全表,`/api/aliases` 增刪後同步更新;`handleMediaUpdate` 是同步的,不能在那等 `db.get`) 把名字換成正規名,下游的 cache、listening_history、Python 端讀音提示全部自動一致。**不要在各處寫入點各包一次,也不要為了「分開不同來源」把 source 加進主鍵** —— 實測重複全來自 metadata 字串,加 source 一列都修不掉,反而讓五張表都要改鍵。舊資料用 `scripts/merge_aliases.py` 一次性收斂 (預設 dry-run,`--apply` 才寫入並自動備份)。
  - `listening_history` 另有 `base_title` (virtual generated column,剝掉第一個括號起的尾綴):統計/排行榜一律 GROUP BY 它,讓 `(Live)`/`(feat. …)` 算同一首。**歌詞類的表刻意不加這欄** —— Live 版歌詞本來就不同,必須分開快取。定義同時寫在 server.js 建表處與 `db.py`,改一邊要改兩邊。
  - **`track_history` 設定 (預設 true) 的閘門只在 `global.logListen`,不要在別處再判斷一次。** `listening_history` 只有這一個寫入點 (換新歌、暫停後續播兩條計時器路徑共用);判斷刻意放在計時器「觸發時」而非排程時,使用者播到一半關掉就真的不會被記錄。關閉時側欄的統計數據/排行榜也一起隱藏 (`.nav-stats-item`,SSR 靠 `res.locals.settings` 決定,不然會閃一下才隱藏),但**路由保留** —— 關掉是「不記錄 / 不礙眼」,不是鎖起來。舊的 `/api/play-event` 是雲端同步時代的遺留、沒有任何呼叫者,已刪除,不要為了「外部 agent 也能回報」加回來。
  - **清除功能 (`/api/db-clear`) 的白名單寫死在 `CLEAR_TARGETS`,只碰得到可重建的資料。** `cache`/`romaji_hints`/`llm_hints` 清掉只是下次重抓;`word_corrections`、`sync_offsets`、`artist_aliases`、`search_overrides` 是使用者親手打的,**任何清除路徑都不准碰**,`/api/db-usage` 只顯示筆數。清 `lyrics` 要一併清記憶體的 `furiganaCache` 與 `itunesCache`,否則已刪的歌詞還會被吐出來;最後一定要 `VACUUM`,不然檔案不會真的變小。`romaji_hints`/`llm_hints` 是 Python 端 (`db.py`) 建的,**全新安裝上可能不存在** —— 這幾條 `db.run` 的 callback 不能省,沒 callback 的 "no such table" 會被 node-sqlite3 丟成未捕捉例外、整個 server 掛掉。回歸測試 `node test_history_toggle.js`。
  - **備份/還原 (`/api/backup`、`/api/restore`) 是那批「不可重建」資料唯一的救生艇。** 備份 = **單一 `.db` 檔**:`VACUUM INTO` 產生壓實且與 WAL 一致的快照 (所以不必打包 `-wal`/`-shm`,也不必引入 zip 函式庫),再把 `settings.json` 的內容寫進備份檔自己的 `_backup_meta` 表。**`secrets.json` (LLM API key) 刻意不進備份** —— 備份檔會被隨手複製傳送。還原走 `express.raw`,前端直接把 File 當 body 送,不為了一支路由裝 multer;**動現有資料前一定要先驗 `_backup_meta.app === 'Kanaric'`**,否則隨便一個 sqlite 檔都能蓋掉使用者心血,而且要先複製一份 `.bak-restore-*` 救援檔。還原成功後 `db.close()` 已經執行,這支 server 不能再服務,靠 `global.relaunchApp()` (electron.js 掛的) 重開;純 node 模式沒有它,改成請使用者手動重啟。回歸測試 `node test_backup_restore.js`。
  - 體積實測 (2026-07,393 首歌 / 349 筆紀錄 = 1.7 MB):`cache` 每首約 1.2 KB、`romaji_hints` 每首約 0.9 KB,而 `listening_history` 每筆只有 31 bytes (佔全庫 0.6%)。**要談資料庫大小,施力點是歌詞快取,不是聆聽紀錄。**

### Desktop packaging (Electron)

`web-app/electron.js` is the desktop shell: it injects env vars (`DATA_DIR`, `DB_PATH`, `LYRICS_DB_PATH`, `LYRICS_SETTINGS_PATH`, `PYTOOLS_EXE`), then `require('./server.js')` in the main process, opens a BrowserWindow on the chosen port, adds a tray icon (右上角 X = 直接結束 app,不再縮到系統匣;托盤仍留著「結束」與更新安裝入口 + 雙擊顯示視窗), and wires the island window (`wireIsland()` → `global.openIsland/closeIsland/isIslandOpen`). **In packaged mode all user data lives in `%APPDATA%/Kanaric/`**; in dev mode (`npm run app`) no paths are overridden, so the repo-root DB/settings are used. Cloud/Render deployment was removed (the old `/api/sync-state` endpoint is gone); the sqlite3/Node version pins for Render GLIBC no longer apply.

### 品牌:Kanaric (kana + lyric),作者 Resuaumis

產品名 **Kanaric**、appId `com.resuaumis.kanaric`、著作權 `Copyright © 2026 Resuaumis`。

`productName` 是主動因:它決定安裝的 exe、安裝資料夾、桌面/開始選單捷徑名,以及 `app.getPath('userData')` 指向的 `%APPDATA%/Kanaric/`。島已經是 app 的視窗,不再有第二份資料夾名要同步。

setup 的檔名則由 `build.nsis.artifactName` 決定,**刻意寫死成 `Kanaric-Setup-<version>.exe`,不要拿掉也不要加空格**:預設檔名帶空格,而 GitHub 上傳資產時會把空格換成句點,`latest.yml` 裡的 `path` 又是連字號,三邊對不上 electron-updater 就抓 404 —— 一樣是靜默失敗 (見上面發版那節)。

GitHub repo 也已改名 `bensionfang/Kanaric`,`server.js` 的 `GITHUB_REPO` 跟著改了 —— 這個常數是 update-check 打 API 用的,跟 repo 名綁定(不是產品名),repo 再改名就要一起改,不然抓不到 release。

**Icon 待辦**:`build.win.icon` 目前**還沒設**,electron-builder 用預設 Electron 圖示。等使用者給圖檔後:轉多尺寸 `.ico` 放 `web-app/build/icon.ico` 並在 `build.win` 補 `"icon"`;256px png 放 `web-app/public/img/icon.png`,`electron.js` 的 `TRAY_ICON` 從寫死的 base64 改 `createFromPath` 讀它(視窗圖示、系統匣、啟動畫面三處都吃這一個常數)。要細調 setup 本身的圖示再於 `build.nsis` 加 `installerIcon`/`uninstallerIcon`/`installerHeaderIcon`。

**啟動畫面**:`electron.js` 的 `createSplash()` —— frameless 透明小窗,icon 脈動 + 字樣淡入,圖直接吃 `TRAY_ICON.toDataURL()`。主視窗改成 `show: false`,`did-finish-load` 時才 reveal(不是 `ready-to-show`:`did-fail-load` 重試後它不會再觸發),另壓 8 秒 timeout 保底。

改完重跑 `npm run dist`,新 setup 出在 `web-app/release/`。安裝檔未簽章 (SmartScreen 會擋,屬預期)。

`build.files` 是**白名單**:新增 repo 根層的 js 檔 (`s2t.js`、`island.js`、`preload-island.js` 這類 server 端 require 得到的檔案) 一定要同步加進去,否則 dev 正常、打包版一啟動就 MODULE_NOT_FOUND。

### Data flow (the key sequence)

1. `media_monitor.py` (or an edge agent) reports a track change → `handleMediaUpdate` → WebSocket broadcast to all clients.
2. Lyrics are lazy-loaded: the **web frontend** reacts to the broadcast by calling `GET /api/lyrics/fetch`; the server checks the SQLite cache, applies artist aliases, fetches externally on miss, runs furigana injection, then broadcasts the result — the C# island never fetches on its own.
   - **iTunes 查詢「失敗」與「查過了,確定不用還原」不能混為一談。** `getResolvedMetadata` 的失敗路徑寫的是 `{ ..., failedAt }`,`cachedResolution()` 會把過了 `ITUNES_RETRY_MS` (預設 60 秒) 的失敗當成沒查過。舊版失敗也寫成一般結果,一次 3 秒逾時就讓那首歌**整個 process 生命週期**都不再嘗試還原,期間抓的歌詞用未還原的名字寫進 `cache` 與 `listening_history`,永久分裂 (實測 TUYU / ツユ 底下各存了同樣四首歌,排行榜也跟著錯)。冷卻**不能設成 0** —— 媒體監控每 0.1 秒更新一次,不擋就是請求風暴,而且永遠不定案。回歸測試 `node test_itunes_resolving.js` 有一組驗這個 (用 `ITUNES_RETRY_MS` 縮短等待)。
   - **iTunes JP 給的「歌手名」要另外把關,不能沿用「含假名就收」** —— 它會把西洋歌手音譯成純片假名 (`Coldplay` → `コールドプレイ`、`Juice WRLD` → `ジュース・ワールド`),而片假名也算假名,舊版因此會把整批西洋歌改名寫進 `cache` 的鍵與排行榜。判準在 `acceptsItunesArtist()`,三條依序:(1) 原歌手名帶 CJK = 被翻譯過,結果一定是還原 (`魚韻` → `サカナクション`,曲風是「ロック」也照收);(2) 結果帶平假名或漢字 (`なとり`、`藤井 風`) —— **音譯永遠是純片假名**,帶平假名漢字就不可能是音譯;(3) 純片假名 + 原名純 ASCII 才看 `primaryGenreName`,`J-Pop`/`アニメ` 才收 (`レトロリロン` ✅ / `コールドプレイ` ❌)。
     - **曲風只能當正面訊號,反過來不成立**:實測 `サカナクション` 是「ロック」、`ずっと真夜中でいいのに。` 也是「ロック」、`LiSA` 是「アニメ」。
     - `primaryGenreName` 是 `カラオケ` 的整筆丟掉:羅馬字歌名很容易搜到翻唱版 (`Yorushika / Haru Dorobou` 的第一個 hit 是「歌っちゃ王」),那種結果歌名歌手都有假名,別的閘門攔不住。
     - 歌手不可信時**只丟掉歌手、歌名的還原照留**。**時長幫不上這個忙** —— `Coldplay / Yellow` 是對的歌、時長完全吻合,只是那份名字是音譯;時長證明的是「同一首歌」,不是「名字是原名」。
     - 這一切只在 `hasKana(title)` 早退**沒有**觸發時才跑,所以歌名有假名的 (`きらり`、`10月無口な君を忘れる`) 仍然不查歌手 —— `artist_aliases` 補的正是這個盲區,加上 iTunes 給不了的純偏好 (`Jay Chou` → `周杰倫`,iTunes 自己就登記羅馬字)。
     - 舊資料用 `scripts/restore_jp_titles.py` 一次性收斂 (預設 dry-run,`--apply` 才寫入並備份)。**它的採用條件刻意比 server.js 嚴**:線上判錯只是一時標錯,批次判錯是合併資料列、不可逆。實測 iTunes JP 會把西洋歌音譯成片假名 (`Juice WRLD` → `ジュース・ワールド`),「含假名」擋不住,所以要「時長 ±3 秒吻合」或「新歌名含**平假名**」兩條之一,其餘列進人工確認清單。
   - **`state.resolving` 是「歌名還沒定案」的旗標,前端必須等它變 false 才抓歌詞。** iTunes 日文原名還原 (`getResolvedMetadata`) 是非同步的,`handleMediaUpdate` 不能等,所以換歌後頭幾百毫秒 state 帶的是原始歌名、幾秒後才換成日文原名。前端是靠「title 變了」判斷換歌的,沒有這個旗標就會用兩個不同的鍵各抓一次歌詞 —— 第二次多半撞到來源限流拿到空的,把已經抓對的歌詞蓋成「找不到歌詞」,要重新載入才好。
   - `itunesCache` 的佔位項帶 `pending: true`,`getResolvedMetadata` **每一條 return 前都要覆寫掉它** (含假名早退、查到、例外三條)。漏掉任何一條,那首歌的 `resolving` 永遠是 true,歌詞就完全不會抓。回歸測試 `node test_itunes_resolving.js`。
   - 前端 (`app.js`) 用 `lastLyricsKey` 判斷要不要抓,跟 `lastMediaTitle` 分開:換歌時 `lastMediaTitle` 會變兩次 (原名 → 還原後),歌詞只該抓最後定案的那次。自動搜尋備選歌詞也綁在同一個判斷裡,理由相同。
3. A track is only written to `listening_history` after 30 seconds of accumulated actual playback (pause/resume-aware timer in `server.js`).

### 歌詞自動捲動 (三段規則)

判定在 `web-app/public/js/scroll-zone.js` 的 `scrollZoneAction()` (純函式,獨立成檔是為了測試不必起瀏覽器),
呼叫點只有 `app.js` 的 `applyAutoScroll()` (換行時)。畫面依活動行位置分三段:**中間帶 (中線 ±15% 高度,下限一行高) 置中**、
**上半/下半只換高亮不捲動** (行隨換句往下漂,漂進中間帶就恢復逐句置中)、**離開畫面才停手並跳出「恢復同步」按鈕**。
中間帶**刻意不對稱**:上緣 35%、下緣 90% (下半部只剩最後 10%) —— 上面是「往下漂進同步」的緩衝,下面是「已經偏低了」,不需要那麼長。
兩邊各保底容得下一行 (`中線 ∓ 一行高`),否則一次換句就可能整個跨過中間帶。

- **置中是黏著狀態 (`autoCenter`),不是每句重算幾何** —— 置中後下一句的中心必定往下偏一行 (行高 + 行距),
  帶譯文的高行會落在中間帶外,純幾何判定就變成「置中一次又往下漂,最後漂出畫面」。`nextScrollState()` 因此在
  `autoCenter` 為 true 時直接置中不看幾何,只有使用者自己捲才脫離,漂回中間帶才黏回去。
- **滾輪/觸控不再停掉同步** —— 手動捲動只掛 `scroll` listener 更新按鈕可見性 (`updateSyncPanel()`) 與解除 `autoCenter`,
  捲回畫面內按鈕自己消失。刻意不在 scroll 裡置中:使用者手指還在滑時把畫面搶走很難用。
  **scroll 事件必須配合「最近 1 秒內有手勢」(wheel/touch/pointerdown/keydown) 才算使用者捲動** —— scroll 事件本身分不出誰捲的,
  移動或縮放視窗、點別的元素造成的重排都會發 scroll,只看 scroll 就會在使用者什麼都沒做時脫離同步、歌詞一句句漂到下半部。
  自己的平滑捲動另外靠 `programmaticScrollUntil` (scrollend + 500ms 保底) 濾掉,不濾就等於置中完立刻自我解除。
  視窗 `resize` 時若還在同步模式就重新置中 (行會被重排推偏)。
- `adjacent` (新行號 = 舊行號 +1) 這個參數要**先於** offscreen 判斷:seek / 換歌 / 重畫的目標行常在畫面外,一律置中,
  否則點歌詞跳轉會變成「不捲過去還跳出按鈕」。
- `scrollLocked` 只剩兩個硬鎖來源:編輯假名中 (`startRubyEdit`)、鍵盤上下鍵手動切行 (`handleManualScroll`),都靠 `resumeSync()` 解鎖。
- 回歸測試 `node test_scroll_zone.js`。

### Furigana editing (web frontend)

The pen button in the player bar toggles **ruby edit mode** (`toggleRubyEditMode()` in `app.js`, which puts `ruby-edit-mode` on `<body>`). There is no modal — editing happens inline on the lyrics themselves:

- CSS suppresses the normal whole-line hover (the Spotify-style white + underline that means "click to seek") and instead highlights only the hovered `ruby.editable-ruby`.
- **Click** makes that ruby's `<rt>` `contentEditable` and selects it. Typing romaji converts to kana live (`romajiToHiragana()`). Enter or blur saves, Escape cancels. Auto-scroll is paused during editing (`scrollLocked = true`) so the line doesn't slide away mid-edit; `resumeSync()` on exit.
- **Double-click** resets the word to its automatic reading via `POST /api/furigana/reset`, which DELETEs the `word_corrections` row. This is not the same as saving an empty string — an empty correction means "this word has no furigana" and is a stored override.
- The edit unit is the whole morpheme (`ruby.dataset.orig`), not the single kanji clicked, matching the `word_corrections` primary key `(artist, title, word)`. But one morpheme can render as *several* rubies when okurigana splits it (噛み締め → 噛(か) + 締(し)), so each ruby also carries `data-hs`/`data-hlen`: the offset and length of the slice of the whole-word reading it owns. Clicking edits only that slice in place; on save `finishRubyEdit()` splices it back into `data-hira` before POSTing. Getting this wrong makes clicking one kanji visibly corrupt its neighbour's reading.
- Both save and reset call `rebroadcastLyrics()` server-side, which re-injects and pushes to every client (web + island) when the edited song is the one playing.
- The global hotkey handler must keep ignoring `isContentEditable` targets, or arrow keys typed into a ruby would fire the sync-offset hotkeys.

### Furigana accuracy: what has already been tried

Reading errors are **not** a tokenizer problem, and swapping dictionaries is a dead end. Measured against the user's hand-made `word_corrections` rows as ground truth:

| engine | hits |
|---|---|
| unidic-lite (current) | 28/48 |
| full unidic 3.1.0 (775 MB) | 28/48 — *identical on every single word* |
| ipadic | 26/48 |
| Sudachi (core, mode C) | 26/48 |

Don't re-run this. The errors that remain are mostly single-kanji on'yomi/kun'yomi coin-flips (談 はなし/だん, 角 かど/かく, 相 あい/そう) that no dictionary can settle without context. The two levers that *do* work are **better source data** (adding QQ's romaji track fixed 私, which fugashi and Kugou both got wrong) and, if ever needed, an **LLM pass for homograph disambiguation** — designed below, not yet implemented.

### LLM 同形詞消歧 (BYOK, 已實作 2026-07)

實作:`llm_furigana.py` (請求/解析/模式與快取決策)、`db.py` 的 `llm_hints` 表、`furigana_inject.py` 的 `get_hints()` 回傳 (羅馬字, LLM) 兩層、server.js 的 `/api/llm-key` 與 `/api/llm-furigana/run`、header.ejs「AI 讀音校正」小節、footer.ejs 魔杖按鈕。以下設計說明即現行行為。

**資料流**
- 掛在 `furigana_inject.py get_hints()`,羅馬字 hint 解析完之後。模式 `llm_furigana`: `off` (預設) / `fallback` (羅馬字 hint 全空才自動觸發,另有介面手動按鈕) / `always` (每首都跑,當第四層蓋在羅馬字 hint 之後)。
- 一首歌一次請求:送 歌名+歌手+全部歌詞行 (去時間標籤),要求回傳每行完整平假名讀音 (JSON、temperature 0,提示詞點名同形詞要看語境)。回傳轉成 `{normalize_line(行): 假名}` —— 與羅馬字 hint 同格式,直接走現成 `apply_hint()` 及其安全 guard,下游零改動;`_COMMON_READING` 與 `word_corrections` 仍在其上。
- API 用 **OpenAI 相容格式** (可設定 base URL + model + key),一條路徑通吃 DeepSeek/OpenAI/Ollama (本機零隱私)/Anthropic 相容端點。HTTP 用既有 requests,timeout 30s,失敗記 stderr、視同無 hint。
- 快取:**新表 `llm_hints` (artist, title, data)**,不塞 `romaji_hints` (保住其負快取 `{}` 語意)。只快取成功結果,錯誤不進快取。手動按鈕強制重跑並覆寫快取,完成走 `rebroadcastLyrics()`。

**Key 安全 (BYOK,實作時不可省)**
- key **絕不放 `settings.json`** —— `GET /api/settings` 會整份吐回。獨立存 `DATA_DIR/secrets.json`,打包版用 Electron `safeStorage` (DPAPI) 加密,dev 模式明文 + stderr 警告。
- key 端點只寫不讀:`POST /api/llm-key` 設定/清除,GET 只回 `{set, last4}`;UI 用 password 欄位。
- key 不進 log、不進 URL query,只走 Authorization header;傳給 Python 走 `spawnPy` 環境變數 (`LLM_API_KEY` 等)。`llm_base_url`/`llm_model`/`llm_furigana` 不敏感,照常放 `settings.json`。
- 功能預設關,設定開關旁註明「啟用後會將歌名與歌詞送至你設定的 LLM 服務」。

**成本與模型選擇** (估算 2026-07)
- 一首歌一次請求 ≈ 2k in / 2k out tokens。DeepSeek V4 Flash ($0.14/$0.28 per M) ≈ $0.0008/首;Claude Haiku 4.5 ($1/$5) ≈ $0.012/首。加 per-song 快取後成本可忽略 (重度使用一年 < US$1)。
- 免費路線:Gemini free tier 有 OpenAI 相容端點,直接吃 BYOK 設計;Ollama 本機零成本零隱私,但 8B 級日文讀音品質要實測 (定位為隱私優先選項)。
- flash 級雲端模型準確率足夠:參考專案用 DeepSeek 做同一件事;輸出過 `apply_hint()` 既有 guard,爛輸出退回 fugashi 不會更糟;`word_corrections` 永遠最上層。推薦文案:DeepSeek 或 Gemini 免費端點,Ollama 為本機選項。

**UI (與使用者定案 2026-07)**
- 設定入口:⋯ 設定選單新增「AI 讀音校正」可折疊小節,套自訂快捷鍵同款 pattern (`menu-sub` + chevron,header.ejs)。內容:模式 [關閉(預設)/自動(=fallback)/總是]、Base URL、Model (存 settings.json)、API Key password 欄 (只寫不讀,顯示「已設定 •••後四碼」),底部一行隱私揭露。
- 手動觸發:播放列魔杖 ✨ 按鈕,與編輯假名筆按鈕並排。已設定 key 才顯示;狀態 平常可按 → 執行中轉圈 → 完成亮起;完成後再按 = 強制重跑 (覆寫 `llm_hints`)。同時是 fallback 模式的手動入口;不做歌詞區 inline 提示句。

**驗證狀態**:mock OpenAI 端點整合測試通過 (hint 套用/快取命中零呼叫/force 重跑/off 不呼叫);`GET /api/settings` 不含 key、dev 模式明文警告、清除 key 會刪 secrets.json 均已驗。**未做**:真實端點 (Ollama/DeepSeek) 全流程、word_corrections 48 條 ground truth 量測 —— 需使用者提供端點後執行。

### Credit / title lines

Lines like `作詞：米津玄師` and copyright boilerplate are prefixed with `#TITLE#` so clients can style or skip them. `autoMarkTitleLines()` in **`web-app/title-lines.js`** is the **only** implementation — a duplicate Python copy in `utils.py` was deleted; don't reintroduce one. (It lived inline in `server.js` until it got its own file, for the same reason as `s2t.js`: so the test can require it without starting a server.)

三條規則,順序無所謂但職責不同:

- **`isCreditLabel()` — 標籤式 (`作詞 : 某某`)。判斷的是冒號前那一段,`{1,8}` 字,不是整行長度。** 這是最容易寫錯的地方:製作人員多的時候值會很長 (實測有 109 字的 `编曲 : A/B/…/T`),舊版用 `text.length < 40` 當守門,那批全部漏標。標籤上限 8 字 + 必須含關鍵字,兩關一起才擋得住日文歌詞裡的真冒號 (`Q:本日の出来栄えは…`、`目が開いてく4:30 A.M.`、`Give me "5:00上がり"`、`16:9の端を…`)。
- **`isCreditPlain()` — 無冒號式 (`Vocal 初音ミク`)**,這條才需要 `length < 40`。
- **`isCopyrightClaim()`** — 版權聲明獨立計分 (命中 ≥3 個「未經/許可/授權/不得…」),因為那種行又長又沒冒號,兩條規則都接不住。
- **`isSongNameLine()` — 歌名行 (整行就是歌名)。判準是「前面每一行都已經是製作人員列」,不是行號、也不是時間戳。** 兩個都實測過都錯:ヨルシカ「あぶく」第 4 行 (t=23.6s) 是唱出來的歌名,前面三行是真歌詞;反過來 muque「TIME」的歌名行在 t=11.6s,但前後都是製作人員列,是真標頭。還要求前面**至少有一行**製作人員列 —— 第 1 行就是歌名時無從判斷是標頭還是開口唱歌名 (WurtS「分かってないよ」第 1、2 行都是歌名),寧可漏標。這條規則需要歌名,所以 `autoMarkTitleLines(lrcText, songTitle)` 有第二個參數,**五個呼叫點都要傳**;沒傳就整條跳過。

`CREDIT_KEYWORDS` 與 `LABEL_ONLY_KEYWORDS` **刻意分成兩張表**:單字的 `詞`/`曲`/`鼓`/`唱` 只能在標籤位置比對 (中文歌常見 `词：周杰伦`),放進 `isCreditPlain` 會把「この曲が終わる前に」這種正文整批誤殺。回歸測試 `node test_title_lines.js`,案例全部取自真實快取。

`config.py` holds the DB path for standalone Python use; `settings.json` (repo root) holds UI settings served via `/api/settings`.
