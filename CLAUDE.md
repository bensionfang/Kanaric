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

# Distribution (single NSIS installer, target machine needs no Python/Node/.NET)
npm run dist     # = build:py (PyInstaller → dist-py/) + build:island (dotnet publish → dist-island/) + electron-builder (→ web-app/release/)
```

- Web dashboard: http://localhost:5720 (預設值;被占用時自動改用空閒 port,靈動島從命令列參數收到實際 port)

### 發版 (GitHub Release)

前端有一個更新提醒 (`GET /api/update-check` in server.js,`checkForUpdate()` in footer.ejs):
比對 `web-app/package.json` 的 `version` 跟 GitHub `releases/latest` 的 tag,不一致就跳吐司提醒使用者
去下載。要讓這個機制動,每次發版都要照下面流程放 release,tag 要打對:

```bash
# 1. 改版號
#    web-app/package.json 的 "version" 改成新版號 (例如 1.1.0)

# 2. build 安裝檔
cd web-app && npm run dist   # 產物在 web-app/release/

# 3. 打 tag、推、建 release、附安裝檔
git tag v1.1.0                # 一定要帶 v 前綴,server.js 用 /^v/ 剝掉再跟 package.json 比對
git push origin v1.1.0
gh release create v1.1.0 "web-app/release/FloatingLyrics Setup 1.1.0.exe" \
  --title "v1.1.0" --notes "..."
```

tag 沒帶 `v` 或漏推,更新提醒就抓不到新版。安裝檔未簽章,`gh release create` 會直接公開發布,屬於
「發布公開內容」的動作,不要自動執行,要使用者自己按。
- C# overlay: auto-launched by `npm run app`; standalone dev run: `DynamicIslandUI/bin/Release/net8.0-windows/DynamicIslandUI.exe` (build with `dotnet build DynamicIslandUI`; requires .NET 8 SDK).
- There are no tests or linters configured.

## Architecture

One Node.js backend, multiple thin clients, with Python scripts as helpers spawned as child processes:

- **`web-app/server.js`** (~1200 lines, the whole backend): Express + WebSocket server owning all business logic — REST API routes, lyrics fetching (order driven by the `preferred_source` setting, with caching), artist-alias substitution, iTunes JP name resolution (undoes Spotify's auto-translation of Japanese titles), a 30-second "valid listen" state machine before writing history, and WebSocket broadcast of the current media state to all clients. `server.listen` binds `127.0.0.1` explicitly, not `0.0.0.0` — there is no auth on any route, and the BYOK LLM key flow can be tricked into exfiltrating the key to an attacker-controlled `llm_base_url` (set via `/api/settings`, then triggered via `/api/llm-models` or `/api/llm-furigana/run`). Anyone who can reach the port can do this. Don't widen the bind for "access from phone/other device" asks without adding auth first.
- **Python scripts (repo root)** are stateless workers `server.js` spawns via `child_process`, always through the **`pytools.py` dispatcher** (`spawnPy()` in server.js): `pytools.py monitor|furigana|fallback|cnlyrics|romaji|minimize|seek|media-action|sessions|diff`. In dev it runs `venv python pytools.py <sub>`; in the packaged app the `PYTOOLS_EXE` env var points at the PyInstaller-built `pytools.exe`. The underlying modules:
  - `media_monitor.py` — long-running; polls Windows Media API via `winrt` and emits one JSON line per state change on stdout. `server.js` parses these lines and auto-restarts the process on exit (unless `global.isShuttingDown`).
    - **`pick_session()` is the single source-selection rule**, shared by the monitor loop and the one-shot `seek` / `media-action` / `sessions` subcommands — don't inline a session filter anywhere else (all four used to hardcode `"spotify"` separately). The `media_source` setting holds either `'auto'` or an exact `source_app_user_model_id`. Auto = playing music app (`MUSIC_APPS`) > paused music app > any playing session; the paused-music tier deliberately outranks other playing sessions so a background video can't steal the lyrics while Spotify is paused. An explicitly chosen app that isn't running yields nothing rather than silently falling back.
    - The monitor re-reads `settings.json` when its mtime changes, so switching source takes effect live — there is no "restart the monitor on settings change" path and none should be added.
    - The empty (no session) payload must keep listing **every** field, because `handleMediaUpdate` merges shallowly (`server.js:146`); an omitted key leaves the previous song's value on screen.
  - `furigana_inject.py` — one-shot; JSON in via stdin, lyrics with furigana out via stdout. Readings come from fugashi/unidic-lite, then get corrected in three layers, each beating the last: `apply_hint()` (romaji hints from `cn_music`, aligned to the tokens with difflib) → `_COMMON_READING` (a tiny table of words *every* source gets wrong, currently just 私 → わたし) → `word_corrections` from the DB (user's manual edits, always final).
  - `cn_music.py` — client for NetEase / QQMusic / Kugou. One API call per platform yields both the LRC **and** a per-syllable romaji track (NetEase `romalrc`, QQ QRC `contentroma`, Kugou krc `type=0`), which is converted back to kana and used to fix readings unidic-lite gets wrong (e.g. 君 くん → きみ). Only readings that still differ after equivalence-normalization are overridden, since romaji can't distinguish づ/ず or は/わ.
    - **`_SOURCES` order is the hint priority** (first source with any romaji wins), and QQ deliberately sits ahead of Kugou: both are machine-generated, but Kugou tends to agree with unidic-lite's mistakes (both say 私 = わたくし) while QQ gets it right (わたし). QQ's *search* endpoint (`u.y.qq.com`) rate-limits hard and starts returning empty results after a burst — that's expected, it just falls through to Kugou.
    - `_pick_song()` gates every source's search results: the title must match, then artist and duration (±3s) break ties. A candidate is only rejected outright when artist AND duration both disagree — artist names vary too much across platforms (あいみょん is "爱缪" on QQ) to reject on that alone. Duration comes from `currentMediaState` in server.js and is what stops the 147-second preview clips QQ loves to return.
  - `qrc_decrypt.py` — pure-Python 3DES for QQ's QRC lyrics. **Do not replace this with a crypto library**: QQ uses a widely-copied C DES implementation with two typo'd S-box entries (sbox2 has a 15 that should be 2; sbox4 has a 10 that should be 13), so standard DES cannot decrypt it. Ported from Lyricify's `DESHelper.cs`.
  - `search_fallback.py` — one-shot fallback lyrics scraper (syncedlyrics providers + iTunes JP-title retry) when the preferred source misses. QQ is not fetched here; `cn_music._fetch_qqmusic` (working `musicu.fcg` endpoint) owns QQ. The old `fetch_qqmusic()` here (dead `client_search_cp` endpoint, HTTP 500) was removed.
- **`DynamicIslandUI/`** — C# WPF overlay; display-only client that receives WebSocket pushes from the server.
- **`web-app/views/*.ejs` + `web-app/public/`** — web frontend (lyrics editor, leaderboard, stats, "wrapped").
- **`lyrics_data.db`** (repo root, SQLite, WAL mode): tables `cache` (lyrics keyed by artist+title), `listening_history`, `sync_offsets`, `word_corrections` (user furigana overrides), `artist_aliases` (maps Spotify's translated artist names back to originals, e.g. 魚韻 → サカナクション), `romaji_hints` (per-song reading hints from `cn_music`; an empty `{}` is a negative-cache entry meaning "already looked, no source has it"). Path configurable via `DB_PATH` env var. Note: the .db file is committed to git.

### Desktop packaging (Electron)

`web-app/electron.js` is the desktop shell: it injects env vars (`DATA_DIR`, `DB_PATH`, `LYRICS_DB_PATH`, `LYRICS_SETTINGS_PATH`, `PYTOOLS_EXE`, `ISLAND_EXE`), then `require('./server.js')` in the main process, opens a BrowserWindow on localhost:3000, adds a tray icon (close = minimize to tray), and spawns the island exe (writing `app.pid` so the web UI's toggle button stays aware of it). **In packaged mode all user data lives in `%APPDATA%/FloatingLyrics/`**; in dev mode (`npm run app`) no paths are overridden, so the repo-root DB/settings are used. Cloud/Render deployment was removed (the old `/api/sync-state` endpoint is gone); the sqlite3/Node version pins for Render GLIBC no longer apply.

### 待做:改名與 App Icon (未實作,等使用者提供名稱與圖檔)

打算把專案改名並換掉 app icon,重新產出 setup 安裝檔。動工前需使用者給:**新顯示名稱**、選填 **appId** (反向網域,不給就照新名生)、**icon 圖檔** (Windows 打包用 `.ico` 256×256 多尺寸;只有 png 就先轉 ico)。

`productName` 是主動因:改它會連帶換掉 setup 檔名 (`<productName> Setup <version>.exe`)、安裝的 exe、安裝資料夾、桌面/開始選單捷徑名,以及 `app.getPath('userData')` 指向的 `%APPDATA%/<productName>/` 資料夾。icon 目前**完全沒設** (electron-builder 用預設 Electron 圖示),要在 build 設定補 `win.icon`。

要動的檔案:
- `web-app/package.json` — `productName`、`appId`、`name`,並在 `build.win` 加 `"icon": "<路徑>.ico"` (此圖預設也會套到 setup 檔本身的圖示;要細調再於 `build.nsis` 加 `installerIcon`/`uninstallerIcon`/`installerHeaderIcon`)
- `web-app/electron.js` — 系統匣 `setToolTip` 文字;`TRAY_ICON` (寫死的 base64 PNG,同時是視窗與匣圖示) 換成新圖
- 頁面顯示文字 — `web-app/views/header.ejs`、`wrapped.ejs`、`stats.ejs` 的 `<title>`/標題字串
- 選改:`server.js:669` User-Agent、README、註解 (純文字,不影響功能)

改完重跑 `npm run dist`,新 setup 出在 `web-app/release/`。安裝檔未簽章 (SmartScreen 會擋,屬預期)。

### Data flow (the key sequence)

1. `media_monitor.py` (or an edge agent) reports a track change → `handleMediaUpdate` → WebSocket broadcast to all clients.
2. Lyrics are lazy-loaded: the **web frontend** reacts to the broadcast by calling `GET /api/lyrics/fetch`; the server checks the SQLite cache, applies artist aliases, fetches externally on miss, runs furigana injection, then broadcasts the result — the C# island never fetches on its own.
3. A track is only written to `listening_history` after 30 seconds of accumulated actual playback (pause/resume-aware timer in `server.js`).

### Furigana editing (web frontend)

The pen button in the player bar toggles **ruby edit mode** (`toggleRubyEditMode()` in `app.js`, which puts `ruby-edit-mode` on `<body>`). There is no modal — editing happens inline on the lyrics themselves:

- CSS suppresses the normal whole-line hover (the Spotify-style white + underline that means "click to seek") and instead highlights only the hovered `ruby.editable-ruby`.
- **Click** makes that ruby's `<rt>` `contentEditable` and selects it. Typing romaji converts to kana live (`romajiToHiragana()`). Enter or blur saves, Escape cancels. Auto-scroll is paused during editing (`isUserScrolling = true`) so the line doesn't slide away mid-edit; `resumeSync()` on exit.
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

Lines like `作詞：米津玄師` and copyright boilerplate are prefixed with `#TITLE#` so clients can style or skip them. `autoMarkTitleLines()` in `server.js` is the **only** implementation — a duplicate Python copy in `utils.py` was deleted; don't reintroduce one. It keyword-matches (`CREDIT_KEYWORDS`, simplified/traditional pairs) with a "does this look like a label" guard, plus `isCopyrightClaim()`, which scores declaration words ("未經/許可/授權/不得…") because those lines are long and colon-less and would otherwise slip through.

`config.py` holds the DB path for standalone Python use; `settings.json` (repo root) holds UI settings served via `/api/settings`.
