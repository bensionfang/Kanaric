# Kanaric — 桌面浮動歌詞與聽歌統計

> by **Resuaumis**

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

目前只能從原始碼執行（安裝檔還沒釋出），需要 Windows 10 或 11。全程用「終端機」打指令，沒寫過程式也能照做——每一步的指令直接整段複製貼上，按 Enter 就好。

> **怎麼開終端機**：按 `Win + X`，選「終端機」或「Windows PowerShell」。跑到一半視窗看起來卡住不動是正常的，那是在下載東西，等它跑完再打下一步。

1. **裝四個工具。** Kanaric 用到 Git（下載原始碼）、Node.js（主程式）、Python（歌詞與假名處理）、.NET（桌面上那顆浮動的靈動島）。Windows 10/11 內建 `winget`，一行就能裝完，過程中如果跳出使用者帳戶控制視窗，按「是」。

   ```bat
   winget install Git.Git OpenJS.NodeJS.LTS Python.Python.3.12
   ```

   .NET 只有在你要改靈動島的程式碼、或要自己打包安裝檔時才需要，只是想跑起來可以跳過：

   ```bat
   winget install Microsoft.DotNet.SDK.8
   ```

   Python 指定 3.12 不是隨便挑的：假名處理用到的 fugashi、unidic-lite 這兩個套件，在更新的 Python 版本上常常沒有現成的安裝包，會變成要你自己編譯，非常麻煩。

2. **關掉終端機，重新開一個。** 剛裝好的工具要等新視窗才認得。開好後打這行確認：

   ```bat
   node -v & python --version & git --version
   ```

   三行版本號都印出來就成功了。如果出現「不是內部或外部命令」，代表那個工具沒裝好，回第 1 步重裝。

3. **把原始碼抓下來。** 下面第一行會在你目前的位置建一個 `Kanaric` 資料夾（想放桌面的話，先打 `cd Desktop`），第二行是進到那個資料夾裡面。

   ```bat
   git clone https://github.com/bensionfang/Kanaric.git
   cd Kanaric
   ```

   **之後每一步都要在這個資料夾裡執行**，中途關掉終端機的話，記得重開後再 `cd` 回來。

4. **裝 Python 需要的套件。** 第一行建一個叫 `venv` 的獨立環境，讓這個專案的套件不會跟你電腦上其他 Python 程式打架；第二行進入它；第三行把 `requirements.txt` 列的套件一次裝好（會跑一兩分鐘）。

   ```bat
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```

   venv 不是強制的，但強烈建議照做：程式只會自動去找專案資料夾裡的 `venv\`，建在別的地方就得自己處理 PATH。

5. **裝 Node.js 需要的套件。** 這行的意思是「進 web-app 資料夾、裝套件、再退回來」，一樣要跑個幾分鐘。

   ```bat
   cd web-app && npm install && cd ..
   ```

6. **啟動。** 在檔案總管裡對著專案資料夾的 `dev.bat` 點兩下，或在終端機打：

   ```bat
   dev.bat
   ```

   儀表板視窗會自己開起來，右下角系統匣出現圖示，螢幕上方出現靈動島。接著打開你的音樂播放器（Spotify、YouTube Music 等）放首歌，歌詞就會自己跟上。關掉視窗只是縮到系統匣，要完全結束請從系統匣圖示右鍵離開。

以上都做完後，之後每次要用，只要點 `dev.bat` 就好，前面五步不用再做一次。

### 其他啟動方式

以下指令要先 `cd web-app` 再執行：

```bash
npm start        # 只跑網頁後台 http://localhost:5720,不開桌面視窗與靈動島
npm run dev      # 同上,改動程式碼會自動重啟
npm run dist     # 打包成安裝檔,產出在 web-app/release/
```

從原始碼跑的時候，歌詞快取、聽歌記錄、設定都存在專案資料夾裡（`lyrics_data.db`、`settings.json`），跟安裝版的 `%APPDATA%/Kanaric/` 分開，兩邊資料不會互相影響。

---

## 使用說明

### 開始使用

1. 開啟 Kanaric（桌面捷徑）。
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
Kanaric/
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

## 致謝

懸浮歌詞島的概念啟發自 [Lyricify](https://github.com/WXRIW/Lyricify-App) 的
**灵动词岛 / Dynamic Lyrics Island**（作者 WXRIW / XY Wang，採 CC BY-SA 4.0 授權）。
本專案的介面與程式碼皆為獨立實作。

`qrc_decrypt.py` 中的 QQ QRC 解密實作移植自 Lyricify 的 `DESHelper.cs`
（Copyright 2023 XY Wang, WXRIW，Apache License 2.0），已由 C# 改寫為 Python。
授權全文見 [`third_party/Lyricify-LICENSE-Apache-2.0.txt`](third_party/Lyricify-LICENSE-Apache-2.0.txt)。

---

© 2026 Resuaumis. All rights reserved.
