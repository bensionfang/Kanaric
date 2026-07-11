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

- **`web-app/server.js`** (~1200 lines, the whole backend): Express + WebSocket server owning all business logic — REST API routes, lyrics fetching (Lrclib first, with caching), artist-alias substitution, iTunes JP name resolution (undoes Spotify's auto-translation of Japanese titles), a 30-second "valid listen" state machine before writing history, and WebSocket broadcast of the current media state to all clients.
- **Python scripts (repo root)** are stateless workers `server.js` spawns via `child_process`, always through the **`pytools.py` dispatcher** (`spawnPy()` in server.js): `pytools.py monitor|furigana|fallback|kana|romaji|minimize`. In dev it runs `venv python pytools.py <sub>`; in the packaged app the `PYTOOLS_EXE` env var points at the PyInstaller-built `pytools.exe`. The underlying modules:
  - `media_monitor.py` — long-running; polls Windows Media API via `winrt` and emits one JSON line per state change on stdout. `server.js` parses these lines and auto-restarts the process on exit (unless `global.isShuttingDown`).
  - `furigana_inject.py` — one-shot; JSON in via stdin, lyrics with furigana out via stdout (pykakasi + user corrections from DB).
  - `search_fallback.py` — one-shot fallback lyrics scraper (QQMusic etc.) when Lrclib misses.
- **`DynamicIslandUI/`** — C# WPF overlay; display-only client that receives WebSocket pushes from the server.
- **`web-app/views/*.ejs` + `web-app/public/`** — web frontend (lyrics editor, leaderboard, stats, "wrapped").
- **`lyrics_data.db`** (repo root, SQLite, WAL mode): tables `cache` (lyrics keyed by artist+title), `listening_history`, `sync_offsets`, `word_corrections` (user furigana overrides), `artist_aliases` (maps Spotify's translated artist names back to originals, e.g. 魚韻 → サカナクション). Path configurable via `DB_PATH` env var. Note: the .db file is committed to git.

### Desktop packaging (Electron)

`web-app/electron.js` is the desktop shell: it injects env vars (`DATA_DIR`, `DB_PATH`, `LYRICS_DB_PATH`, `LYRICS_SETTINGS_PATH`, `PYTOOLS_EXE`, `ISLAND_EXE`), then `require('./server.js')` in the main process, opens a BrowserWindow on localhost:3000, adds a tray icon (close = minimize to tray), and spawns the island exe (writing `app.pid` so the web UI's toggle button stays aware of it). **In packaged mode all user data lives in `%APPDATA%/FloatingLyrics/`**; in dev mode (`npm run app`) no paths are overridden, so the repo-root DB/settings are used. Cloud/Render deployment was removed (the old `/api/sync-state` endpoint is gone); the sqlite3/Node version pins for Render GLIBC no longer apply.

### Data flow (the key sequence)

1. `media_monitor.py` (or an edge agent) reports a track change → `handleMediaUpdate` → WebSocket broadcast to all clients.
2. Lyrics are lazy-loaded: the **web frontend** reacts to the broadcast by calling `GET /api/lyrics/fetch`; the server checks the SQLite cache, applies artist aliases, fetches externally on miss, runs furigana injection, then broadcasts the result — the C# island never fetches on its own.
3. A track is only written to `listening_history` after 30 seconds of accumulated actual playback (pause/resume-aware timer in `server.js`).

`config.py` holds the DB path for standalone Python use; `settings.json` (repo root) holds UI settings served via `/api/settings`.
