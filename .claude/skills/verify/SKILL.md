---
name: verify
description: How to build, launch, and drive Floating Lyrics web UI for end-to-end verification
---

# Verify Floating Lyrics (web dashboard)

## Launch

```powershell
cd web-app
Start-Process node -ArgumentList "server.js" -WindowStyle Hidden
# wait ~4s, then http://localhost:3000 (also /stats /leaderboard /editor)
```

Kill after: `Get-NetTCPConnection -LocalPort 3000 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`

## Drive (Playwright)

- Install into scratchpad (not the repo): `npm i playwright; npx playwright install chromium`. Browsers cache at `%LOCALAPPDATA%\ms-playwright`.
- **`waitUntil: 'networkidle'` never resolves** — page keeps WebSocket + 15s leaderboard polling. Use `waitUntil: 'load'` + `waitForSelector`.
- Playwright headless defaults to `prefers-color-scheme: light`, so theme "系統" renders light-mode.

## Gotchas

- **Back up `settings.json` (repo root) before driving settings UI** — server persists every settings POST there. Restore after.
- Settings flow: control onclick → localStorage + POST `/api/settings` → on reload, DOMContentLoaded in `footer.ejs` restores from localStorage, then fetch(`/api/settings`) overrides (island_lines, font_size, show_furigana come from server).
- Settings menu: `#menu-dots-btn` (sidebar top-left) toggles `#settings-menu`; hotkeys/about live in `#hotkeys-modal` / `#about-modal`.
- EJS views not cached in dev — edit .ejs, refresh, no server restart needed. CSS needs `?v=` bump in header.ejs.

## Worth driving

Theme segmented (html.light-mode class), furigana toggle (html.hide-furigana), font size (`--lyrics-fs` var, clamps 14–32), align (#lyrics-scroll align-left/right, index only), hotkey rebind (click input → "請按下按鍵..." → keypress; ESC cancels), reload persistence.

**Assert rendered outcome, not plumbing**: for font size, measure `getComputedStyle(document.querySelector('.lyrics-line')).fontSize` — checking only that `--lyrics-fs` got set once passed while the lyrics never changed (no rule consumed the var until v27).
