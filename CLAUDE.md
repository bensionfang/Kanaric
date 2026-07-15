# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop floating-lyrics system (Windows-only for full functionality): it auto-detects what Spotify/Apple Music is playing via the Windows Media API, fetches synced lyrics from external sources, annotates Japanese kanji with furigana, and displays lyrics in a C# "Dynamic Island" overlay plus a web dashboard with listening stats. README.md and most code comments are in Traditional Chinese.

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

- Web dashboard: http://localhost:3000
- C# overlay: auto-launched by `npm run app`; standalone dev run: `DynamicIslandUI/bin/Release/net8.0-windows/DynamicIslandUI.exe` (build with `dotnet build DynamicIslandUI`; requires .NET 8 SDK).
- There are no tests or linters configured.

## Architecture

One Node.js backend, multiple thin clients, with Python scripts as helpers spawned as child processes:

- **`web-app/server.js`** (~1200 lines, the whole backend): Express + WebSocket server owning all business logic — REST API routes, lyrics fetching (order driven by the `preferred_source` setting, with caching), artist-alias substitution, iTunes JP name resolution (undoes Spotify's auto-translation of Japanese titles), a 30-second "valid listen" state machine before writing history, and WebSocket broadcast of the current media state to all clients.
- **Python scripts (repo root)** are stateless workers `server.js` spawns via `child_process`, always through the **`pytools.py` dispatcher** (`spawnPy()` in server.js): `pytools.py monitor|furigana|fallback|cnlyrics|romaji|minimize|seek|media-action|diff`. In dev it runs `venv python pytools.py <sub>`; in the packaged app the `PYTOOLS_EXE` env var points at the PyInstaller-built `pytools.exe`. The underlying modules:
  - `media_monitor.py` — long-running; polls Windows Media API via `winrt` and emits one JSON line per state change on stdout. `server.js` parses these lines and auto-restarts the process on exit (unless `global.isShuttingDown`).
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

Don't re-run this. The errors that remain are mostly single-kanji on'yomi/kun'yomi coin-flips (談 はなし/だん, 角 かど/かく, 相 あい/そう) that no dictionary can settle without context. The two levers that *do* work are **better source data** (adding QQ's romaji track fixed 私, which fugashi and Kugou both got wrong) and, if ever needed, an **LLM pass for homograph disambiguation** cached per song in `romaji_hints` (two of the reference projects do this with DeepSeek).

### Credit / title lines

Lines like `作詞：米津玄師` and copyright boilerplate are prefixed with `#TITLE#` so clients can style or skip them. `autoMarkTitleLines()` in `server.js` is the **only** implementation — a duplicate Python copy in `utils.py` was deleted; don't reintroduce one. It keyword-matches (`CREDIT_KEYWORDS`, simplified/traditional pairs) with a "does this look like a label" guard, plus `isCopyrightClaim()`, which scores declaration words ("未經/許可/授權/不得…") because those lines are long and colon-less and would otherwise slip through.

`config.py` holds the DB path for standalone Python use; `settings.json` (repo root) holds UI settings served via `/api/settings`.
