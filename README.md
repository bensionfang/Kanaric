# Floating Lyrics — 桌面浮動歌詞與聽歌統計

自動偵測 Spotify / Apple Music 正在播放的歌曲，線上抓取同步歌詞（LRC），日文歌詞自動標註假名（振り仮名），並以「靈動島」桌面懸浮視窗 + 網頁儀表板兩種形式顯示。同時記錄你的聽歌歷史，提供排行榜、統計圖表與年度回顧。

> 完整功能僅支援 Windows（媒體偵測依賴 Windows Media API）。

---

## 功能與特色

- **自動偵測播放中的歌曲** — 不用手動搜尋，切歌即換詞。支援 Spotify、Apple Music 等任何會上報 Windows 媒體資訊的播放器。
- **多來源同步歌詞** — 網易雲、QQ 音樂、Kugou、Musixmatch、Lrclib 等，可設定偏好來源；找不到時自動走備援搜尋（含 iTunes 日文原名還原，解決 Spotify 自動翻譯日文歌名的問題）。
- **日文假名標註（Furigana）** — 以 fugashi/unidic 斷詞注音，再用音樂平台的逐字羅馬音軌修正讀音；仍不對的字**點一下就能改**，修正永久記住。
- **靈動島懸浮歌詞** — C# WPF 無邊框懸浮窗，置頂顯示當前歌詞，可拖曳、平滑展開收合。
- **聽歌統計** — 累積播放 30 秒才算一次有效聆聽（防切歌灌水），提供歷史記錄、歌手/歌曲排行榜、時段分析與 Spotify Wrapped 風格年度回顧。
- **歌詞編輯器** — 歌詞或時間軸不準時可手動修正，逐首儲存時間偏移。
- **一鍵安裝** — 打包成單一 NSIS 安裝檔，對方電腦**不需要安裝 Python / Node.js / .NET**，首次啟動自動初始化。

---

## 安裝

### 一般使用者（推薦）

1. 取得 `FloatingLyrics Setup x.x.x.exe` 安裝檔。
2. 雙擊執行 — 一鍵安裝，無需系統管理員權限，裝完自動啟動並建立桌面/開始選單捷徑。
   - 安裝檔未簽章，Windows SmartScreen 可能攔截：點「其他資訊」→「仍要執行」。
3. 所有個人資料（歌詞快取、聽歌記錄、設定）存在 `%APPDATA%/FloatingLyrics/`，解除安裝不會刪除。

### 開發者（從原始碼執行）

需求：Node.js、Python 3.10+、.NET 8 SDK（只有要編譯靈動島才需要）。

```bash
# Python 依賴（建議 venv,server 會自動偵測 repo 根目錄的 venv/）
pip install -r requirements.txt

# Node 依賴與啟動（一切從 web-app/ 出發）
cd web-app
npm install
npm start        # 只跑網頁後台 http://localhost:3000
npm run app      # Electron 桌面殼:後台 + 儀表板視窗 + 系統匣 + 靈動島,一鍵全開

# 打包安裝檔（產出在 web-app/release/）
npm run dist
```

---

## 使用說明

### 開始使用

1. 開啟 Floating Lyrics（桌面捷徑）。
2. 用 Spotify 或 Apple Music 播放任何歌曲。
3. 儀表板自動顯示歌曲資訊與同步歌詞；日文歌自動標註假名。
4. 關閉視窗 = 縮到系統匣（不會結束程式）。系統匣圖示：雙擊叫回視窗，右鍵可開啟儀表板、重啟靈動島或結束。

### 主播放頁

- 歌詞隨播放進度自動捲動、高亮當前行；點任一行可跳播（seek）。
- 播放列有播放控制、歌詞來源切換（歌詞選項）、靈動島開關、假名編輯等按鈕。

### 修正假名讀音

1. 點播放列的**筆型按鈕**進入編輯模式。
2. 點任何一個注音字 → 直接輸入羅馬拼音（即時轉假名），Enter 儲存、Esc 取消。
3. 雙擊該字 = 還原成自動讀音。
4. 修正以「歌手 + 歌名 + 單字」為單位永久儲存，重播同曲自動套用，靈動島同步更新。

### 快捷鍵（預設關閉，設定選單開啟）

| 鍵 | 功能 |
|---|---|
| ← / → | 歌詞時間軸提前 / 延後 |
| ↑ / ↓ | 上一行 / 下一行純文字歌詞 |
| A | A-B 循環 |
| E | 假名編輯模式 |
| L | 歌詞選項 |
| R | 重新載入歌詞 |
| D | 靈動島開關 |
| F | 全螢幕 |

### 頁面

- **首頁** — 播放器與同步歌詞。
- **統計** — 聽歌時數、活躍時段等圖表。
- **排行榜** — 歌曲/歌手播放次數排名。
- **編輯器** — 手動貼上或修改歌詞、調整時間軸。
- **Wrapped**（`/wrapped`）— 年度聽歌回顧。

### 設定（右上 ⋯ 選單）

字體大小、假名顯示開關、偏好歌詞來源、靈動島行數、自訂快捷鍵等。歌手名稱被平台翻譯錯誤時（如 サカナクション 顯示成「魚韻」），可設定歌手別名對應。

---

## 專案結構

```
Floating-Lyrics/
├── web-app/                  # Node.js 後端 + 網頁前端 + Electron 桌面殼（一切從這裡啟動）
│   ├── server.js             # 核心後端:Express + WebSocket,歌詞抓取/快取、聽歌記錄、API
│   ├── electron.js           # Electron 殼:視窗、系統匣、路徑注入、靈動島啟動、port 自動遞補
│   ├── package.json          # 指令與 electron-builder 打包設定
│   ├── views/                # EJS 頁面模板（首頁/統計/排行榜/編輯器/Wrapped）
│   └── public/               # 前端靜態資源
│       ├── js/app.js         # 主頁邏輯:歌詞同步捲動、假名編輯、快捷鍵、WebSocket 接收
│       ├── js/lyrics-tools.js# 歌詞工具（選項彈窗等）
│       └── css/style.css     # 全站樣式
├── DynamicIslandUI/          # C# WPF 靈動島懸浮窗（純顯示端,經 WebSocket 收歌詞推播）
├── pytools.py                # Python 工具統一入口,server.js 以子進程呼叫各子指令
├── media_monitor.py          # 常駐:輪詢 Windows Media API,回報播放狀態
├── furigana_inject.py        # 假名標註:斷詞注音 + 羅馬音修正 + 使用者修正覆蓋
├── cn_music.py               # 網易雲 / QQ / Kugou 歌詞客戶端（含逐字羅馬音軌）
├── qrc_decrypt.py            # QQ QRC 歌詞解密（特製 3DES,勿用標準函式庫取代）
├── search_fallback.py        # 備援歌詞搜尋（syncedlyrics 多來源 + iTunes 日文原名重試）
├── db.py / config.py         # Python 端 SQLite 存取與路徑設定
├── utils.py                  # 共用字串工具（羅馬拼音 ↔ 假名轉換等）
├── lyrics_data.db            # SQLite 資料庫（歌詞快取、聽歌歷史、假名修正…,不進版控）
├── settings.json             # 介面設定（開發模式用;打包版在 %APPDATA%）
└── requirements.txt          # Python 依賴
```

### 架構一句話

一個 Node.js 後端（`server.js`）持有全部業務邏輯；Python 腳本是它按需喚起的無狀態工人；網頁前端與 C# 靈動島都只是吃 WebSocket 推播的顯示端。

### 資料庫主要資料表

| 資料表 | 用途 |
|---|---|
| `cache` | 歌詞快取（歌手 + 歌名為鍵） |
| `listening_history` | 聽歌歷史（累積播放 30 秒才寫入） |
| `word_corrections` | 使用者的假名讀音修正 |
| `sync_offsets` | 逐首歌的時間軸偏移 |
| `artist_aliases` | 歌手別名對應（還原平台翻譯） |
| `romaji_hints` | 各平台逐字羅馬音的讀音提示快取 |
