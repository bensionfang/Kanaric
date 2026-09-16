# Kanaric

Windows 桌面歌詞、卡拉 OK 字幕與聽歌統計工具。

Kanaric 會偵測 Spotify、Apple Music、YouTube Music 或其他支援 Windows 媒體控制的播放器，自動尋找同步歌詞，替日文漢字標註假名，並把歌詞顯示在桌面靈動島或完整儀表板中。

> 完整功能僅支援 Windows 10／11。媒體偵測依賴 Windows Media API。

## 你可以用它做什麼

- **自動同步歌詞**：切歌後自動搜尋，不必手動輸入歌名。
- **日文假名**：自動替漢字加上振假名，特殊讀音仍可直接手動修正並永久保存。
- **逐字填色**：有逐字時間資料時，歌詞與假名會跟著演唱進度逐字填色；沒有資料時自動退回整句高亮。
- **卡拉 OK 模式**：JOYSOUND 風格的上下雙行大字幕、前奏／間奏倒數、可選 YouTube MV 背景與獨立控制視窗。
- **桌面靈動島**：透明置頂歌詞，可拖曳、吸附螢幕頂端，並記住每台螢幕的位置。
- **翻譯與羅馬拼音**：可在日文歌詞下顯示中文翻譯或羅馬拼音。
- **聽歌統計**：記錄有效聆聽、排行榜、活躍時段與熱力圖，也能匯出 CSV。
- **歌詞工具**：備選來源、手動編輯、逐首時間校正、段落循環、猜歌遊戲、備份與還原。

歌詞會依序嘗試多個來源，包括網易雲、QQ 音樂、酷狗、Musixmatch 與 Lrclib。找不到或品質不佳時，Kanaric 會自動改用其他來源。

## 安裝

正式安裝版會放在 [GitHub Releases](https://github.com/bensionfang/Kanaric/releases)，並包含執行所需元件，不必另外安裝 Python、Node.js 或 .NET。

> 目前專案尚未發布公開 Release。現在要使用請依照[從原始碼執行](#從原始碼執行)；請勿從其他網站下載來路不明的安裝檔。

正式版發布後的安裝方式：

1. 到 Releases 下載最新的 `Kanaric-Setup-x.y.z.exe`。
2. 執行安裝檔。
3. 開啟 Spotify、YouTube Music 或其他播放器，播放一首歌。
4. Kanaric 會自動顯示歌曲資訊與同步歌詞。

安裝檔目前沒有數位簽章，因此 Windows SmartScreen 可能顯示「已保護您的電腦」。確認檔案來自本專案的 GitHub Releases 後，選擇「其他資訊」→「仍要執行」。

右上角 `X` 會結束整個程式。系統匣圖示可用來叫回視窗、顯示／隱藏靈動島、安裝已下載的更新或結束程式。

## 第一次使用

### 一般歌詞頁

播放音樂後，首頁會自動顯示封面、歌曲資訊與同步歌詞。

- 點歌詞可跳到該時間。
- 右下角 `− 0 ms +` 可校正歌詞早晚，每首歌分開保存。
- 備選歌詞可更換來源；重新載入可重新搜尋目前歌曲。
- 編輯模式可直接修正假名讀音：輸入羅馬拼音，按 Enter 儲存、Esc 取消，雙擊還原自動讀音。
- 段落循環可反覆播放想練習的區間。

### 卡拉 OK 模式

從左側選單進入「卡拉 OK」，再按「開始」。

- 上下字幕槽各維持一列；長句會讓兩行使用相同的縮小字級。
- 有逐字資料時，紅色填色會跟著每個字與假名移動。
- 前奏或較長間奏會在下一句左上角顯示倒數。
- 每首歌可自動搭配靜音的 YouTube MV；聲音仍由原本的播放器提供。
- 控制列可拆成獨立小視窗，方便把字幕投到電視、控制留在電腦上。
- 字幕校正沿用一般歌詞頁的快捷鍵，預設 `←` 提早、`→` 延後，每次 100ms。

校正值會立即同步到卡拉 OK 與靈動島。快速切歌或校正後立刻切頁，也不會把數值存到錯誤歌曲或漏掉最後一次調整。

### 靈動島

- 拖曳即可移動；靠近螢幕頂端放開會自動吸附。
- 滑鼠移上去可展開播放控制與進度條。
- 第二行可選擇下一句、本句翻譯或本句羅馬拼音。
- 多螢幕環境會分別記住位置。

## 常用快捷鍵

所有按鍵都能在設定選單的「自訂快捷鍵」修改。

| 預設按鍵 | 功能 |
|---|---|
| `←` / `→` | 歌詞提前／延後 100ms |
| `↑` / `↓` | 上一行／下一行純文字歌詞 |
| `A` | A-B 段落循環 |
| `E` | 假名編輯模式 |
| `L` | 備選歌詞 |
| `R` | 重新載入歌詞 |
| `D` | 靈動島開關 |
| `F` | 放大模式 |

## 設定與資料

設定選單可調整歌詞字體、對齊方式、偏好來源、媒體來源、翻譯、羅馬拼音、假名顯示、靈動島樣式與工具列按鈕。

安裝版資料位於：

```text
%APPDATA%\Kanaric\
```

其中包含歌詞快取、設定、聽歌記錄、假名修正與逐首校正。解除安裝不會自動刪除這些資料。

設定頁可備份成單一 `.db` 檔、從備份還原、匯出聽歌記錄 CSV，或只清除可以重新下載的快取。使用者手動建立的假名修正、時間校正、歌手別名與搜尋關鍵字不會被一般快取清除功能刪除。

Kanaric 沒有帳號或內建雲端同步；聽歌記錄保存在本機。搜尋歌詞時，歌曲名稱與歌手名稱會送往所選的外部歌詞來源。

## 常見問題

### 沒有顯示目前歌曲

確認播放器會出現在 Windows 的媒體控制面板，並在 Kanaric 設定中選擇正確的音訊來源。瀏覽器播放器通常必須先實際播放過音訊。

### 歌詞不準或找錯版本

先用 `←`／`→` 校正時間；內容錯誤時開啟「備選歌詞」更換來源，或到歌詞編輯器手動修改。

### 日文讀音不正確

進入假名編輯模式，點選該注音後輸入正確讀音。使用者修正的優先順序最高，重播同一首歌時會自動套用。

### 關閉聽歌記錄會怎樣

之後不再新增聆聽紀錄，統計與排行榜也會從側欄隱藏；既有資料不會因此被刪除。

## 從原始碼執行

開發環境需要 Windows 10／11、Git、Node.js LTS 與 Python 3.12。

```bat
winget install Git.Git OpenJS.NodeJS.LTS Python.Python.3.12
git clone https://github.com/bensionfang/Kanaric.git
cd Kanaric
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd web-app
npm install
cd ..
dev.bat
```

`dev.bat` 是日常開發入口，會清除上一輪殘留的 Kanaric 進程，再啟動完整 Electron 桌面版。

其他指令需在 `web-app` 目錄執行：

```bash
npm start      # 只啟動本機網頁後端
npm run dev    # 使用 nodemon 啟動後端
npm run app    # Electron 視窗、系統匣與靈動島
npm run dist   # 建立 Windows NSIS 安裝檔
```

預設儀表板網址是 `http://localhost:5720`；連接埠被占用時會自動改用可用的本機連接埠。開發模式資料位於專案根目錄，與安裝版的 `%APPDATA%\Kanaric\` 分開。

## 架構

```text
Windows Media API
        ↓
media_monitor.py
        ↓
Node.js / Express / WebSocket / SQLite
        ├── 網頁儀表板
        ├── 卡拉 OK 字幕機
        ├── Electron 靈動島
        └── Python 歌詞與假名工具
```

- `web-app/server.js`：本機後端、歌詞來源、快取、設定與聽歌紀錄。
- `web-app/electron.js`：桌面視窗、系統匣與自動更新。
- `web-app/public/js/karaoke.js`：一般歌詞、卡拉 OK、靈動島與行動版共用的逐字填色。
- `media_monitor.py`：讀取 Windows 媒體狀態。
- `furigana_inject.py`：日文斷詞、假名標註與使用者修正。
- `cn_music.py`：網易雲、QQ 音樂與酷狗歌詞來源。
- `tests/`：可直接以 Node.js 或專案虛擬環境中的 Python 執行的獨立回歸測試。

## 行動版

`web-app/public/mobile/` 另有 iOS PWA 歌詞頁，使用 Spotify OAuth PKCE 取得播放狀態。它不會連回桌面版，必須自行部署後端並設定 Spotify redirect URI；專案提供 `Dockerfile` 與 `render.yaml` 作為唯讀雲端服務範本。

## 致謝

桌面懸浮歌詞概念啟發自 [Lyricify](https://github.com/WXRIW/Lyricify-App) 的 Dynamic Lyrics Island。本專案的介面與主要程式碼為獨立實作。

`qrc_decrypt.py` 的 QQ QRC 解密邏輯移植自 Lyricify 的 `DESHelper.cs`，並由 C# 改寫為 Python。原作 Copyright 2023 XY Wang／WXRIW，採 Apache License 2.0；授權全文見 [`third_party/Lyricify-LICENSE-Apache-2.0.txt`](third_party/Lyricify-LICENSE-Apache-2.0.txt)。

## 授權

Kanaric 採 [GNU General Public License v3.0 或更新版本](LICENSE)。你可以使用、研究、修改與散布；若散布修改版本，也必須依 GPL 提供對應原始碼。

Copyright © 2026 Resuaumis
