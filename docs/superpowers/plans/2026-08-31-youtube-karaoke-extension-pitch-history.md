# Kanaric YouTube Karaoke、手動升降 Key 與演唱音高紀錄實作計畫

> **歷史計畫（Tasks 0–7）**：Tasks 0–6 已成為目前 dirty worktree 的基線；本文件內的「下一步 Task 7」已過時。現在狀態、後續路線與唯一接手提示請以 `docs/CODEX_HANDOFF.md` 為準。本文件只保留原始需求、schema、測試與安全邊界供查證。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有 `/karaoke` 收斂成 YouTube-only Karaoke：在 Kanaric 搜歌、建立本次待播佇列，由 Chrome／Edge 擴充套件播放 YouTube、即時手動升降 `-6..+6 Key`，並按 YouTube 影片分別保存使用者每次演唱的音高曲線。

**Architecture:** Kanaric 保有搜尋、臨時 Queue、歌詞、畫面與音高紀錄；Chromium MV3 擴充套件只擁有一個專用 YouTube 分頁、分頁音訊與 SoundTouchJS AudioWorklet。兩端經 localhost WebSocket 的配對 token 通訊，YouTube `positionMs` 是歌詞與麥克風音高資料的唯一時間軸；原始麥克風音訊不保存、不送到擴充套件。

**Tech Stack:** Electron 33、Node.js CommonJS、Express 5、`ws`、SQLite、EJS、原生瀏覽器 JavaScript、Chrome／Edge Manifest V3、`chrome.tabCapture`、`chrome.offscreen`、Web Audio AudioWorklet、`@soundtouchjs/audio-worklet@2.1.1`（MPL-2.0）、`esbuild@0.28.2`。

**Spec:** 本檔的「核准規格」與「介面總表」章節；使用者已於 2026-08-31 在對話中核准。

## Global Constraints

- 新實作 worktree 固定為 `C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension`，branch `codex/youtube-karaoke-extension`，基線固定為 `origin/main@9bb97b6`；不得從本機 `main@01909d2` 或既有 `codex/karaoke-system-gap-closure` 開始。
- 原 checkout `C:\Users\USER\Desktop\project\Kanaric` 只保存本計畫，實作時唯讀；不得修改、pull、merge、reset、clean、checkout、restore、stash、rebase、cherry-pick 或刪除其中任何檔案。
- 未經使用者另行明確授權，不得 commit、push、PR、tag、Release、Chrome Web Store／Edge Add-ons 發布或上傳公開內容。
- 保留 Music Mode、Windows media monitor、首頁、靈動島、猜歌、既有歌詞管線與外部播放器行為；只有 `/karaoke` 改走 YouTube 專用狀態。
- Spotify 不進 Karaoke source；不得下載、解密、擷取、保存或離線分析 Spotify／YouTube 原始音訊，不得加入 yt-dlp。
- 第一版只支援本次暫存 Queue；不建命名播放清單、不跨重啟保存 Queue、不做手機／多人點歌。
- 第一版只做手動 `-6..+6 Key`；不做自動音域校準、建議 Key、歌曲批次分析、人聲分離、演唱評分或原唱／翻唱匹配。
- 麥克風只供本機即時音高偵測；不監聽回放、不保存 raw audio／FFT、不上傳、不送到擴充套件。
- 擴充套件不得載入遠端 JavaScript；所有執行碼、SoundTouch processor 與授權文字都必須進本機 extension build。
- Extension 連線不得放寬既有 CORS／origin guard；只允許通過獨立 token 驗證的 WebSocket client。
- 所有外部字串使用 `textContent`；REST／WebSocket 對 query、videoId、數字、陣列長度與 payload bytes 做 server-side validation。
- unit／contract tests 不打 YouTube、不開真麥克風、不要求 Chrome；browser、Electron、真 YouTube、真麥克風與可聽音質是分開的 runtime gates。
- 每個 Task 使用 RED → minimal GREEN → focused regression；完成後更新新 worktree 的 `docs\CODEX_HANDOFF.md`，記錄命令、exit code、測試總數／範圍、限制與下一 Task prompt，然後立即停止。

---

## 核准規格

### 使用流程

1. 使用者開啟 `/karaoke`，若擴充套件未配對，Kanaric 顯示目前 localhost URL 與一次性可複製的長 token。
2. 使用者在擴充套件 popup 貼上配對資料並按一次「連線並接管 YouTube」；這次手勢同時滿足 Chrome `tabCapture` 要求。
3. Kanaric 輸入歌名，沿用 `/api/mv/search` 與 `yt_search.py`；第一筆 `ok` 結果預選，使用者可換其他結果。
4. 「現在唱」在 Queue 空時立即載入；「加入待播」把歌曲放進記憶體 Queue。可刪除與上下移動；關閉／重整 Kanaric 即清空。
5. 擴充套件維持一個專用 YouTube 分頁，回報 load／playing／paused／buffering／ad／ended／error 與 `positionMs`／`durationMs`。
6. Kanaric 使用該 `positionMs` 驅動既有 LRC、ruby、`#TRANS#`、`#ROMAJI#`、`#WORDS#`、字幕 offset、兩行版面與逐字填色；不再讀 Spotify／Windows media state。
7. `Key -`、`Key +`、`歸零` 將整數 semitone 送到 SoundTouchJS，tempo 保持 `1.0`；換歌預設回 `0`，同一次演唱期間保留使用者手動值。
8. 使用者第一次按「啟用音高紀錄」時取得麥克風權限。之後歌曲進入 playing 就自動記錄，pause／buffering／ad／seek gap 時不寫 frame。
9. Karaoke 畫面只顯示最近 15 秒的小型音高軌；ended／skip／exit 時結束 take。有效 voiced frames 少於 20 個時顯示「資料不足」且不寫 DB。
10. 有效 take 按 YouTube `videoId` 分開保存；歌曲歷史顯示日期、當時 Key、最低／最高音、主要音域與 voiced ratio，點入才載入完整曲線。使用者可刪除單次紀錄。

### 明確不做

- 不把 YouTube iframe 留在 Kanaric 當播放器；iframe 跨來源無法可靠接 Web Audio。
- 不自動安裝擴充套件、不繞過 Chrome／Edge 的使用者手勢／權限要求。
- 不跳過或封鎖廣告；廣告期間 UI 顯示「廣告播放中」，歌詞與音高時間軸暫停跟隨。
- 不比較原唱曲線、不計算準確率／分數、不宣稱真假唱或音準能力。
- 不把 gap-closure 的 SongLibrary、persistent Queue、Session、Stage、MPV、Remote、stem separator 搬回來。

### 驗收條件

- 兩首 YouTube 影片可在同一專用 tab 依 Queue 連續播放；seek near end 後 `ended` 只前進一次，最後回 idle。
- `-6`、`0`、`+6` 指令與 UI／extension readback 一致；synthetic 440 Hz offline test 的 `+12` 量測接近 880 Hz，`-12` 接近 220 Hz，證明 DSP 不是只改標籤。
- 實際歌曲在 Chrome 與 Edge 至少各完成一次 load／play／pause／seek／Key／ended；音質與爆音由人工另記，不能由 unit test 代替。
- 歌詞在播放、暫停、seek、buffering、廣告與換歌後仍跟 extension `positionMs` 對齊；Music Mode regression 不變。
- 真麥克風 220／440／880 Hz 或可控音源 gate 能辨識正確 octave（允許 ±50 cents）；實際人聲可能八度誤判，UI 必須顯示信心不足／缺口，不補畫猜測線。
- 同一 `videoId` 兩次演唱保存兩筆；另一影片不混入；完整曲線只在 detail API 讀取；刪除單筆後其他紀錄仍存在。
- DB 與 REST 中不存在原始音訊；network observation 不得出現 microphone blob／PCM／FFT payload。

## 介面總表

### App ↔ Extension WebSocket

```js
// Kanaric page -> extension
{ type: 'youtube_karaoke_command', commandId, action: 'load', videoId }
{ type: 'youtube_karaoke_command', commandId, action: 'play' }
{ type: 'youtube_karaoke_command', commandId, action: 'pause' }
{ type: 'youtube_karaoke_command', commandId, action: 'seek', positionMs }
{ type: 'youtube_karaoke_command', commandId, action: 'set_key', semitones }

// extension -> Kanaric page
{
  type: 'youtube_karaoke_state',
  revision,
  videoId,
  title,
  channel,
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ad' | 'ended' | 'error',
  positionMs,
  durationMs,
  keySemitones,
  error: null | { code, message }
}
```

- `videoId` 必須符合 `/^[A-Za-z0-9_-]{11}$/`。
- `commandId` 是 page 產生的遞增安全整數；extension 回 state 時保留最新 applied command id。
- `revision` 每次 load 增加，舊 revision／舊 videoId state 不得推進 Queue。
- `positionMs`／`durationMs` 是非負安全整數；`semitones` 是 `-6..6` 整數。
- WebSocket 使用 subprotocol `kanaric-youtube-v1`；第二個 protocol 值是 base64url token。Server 只回選 `kanaric-youtube-v1`，token 只存在 `%APPDATA%\Kanaric\youtube-karaoke-token` 或開發 DATA_DIR 對應檔案，絕不進 `/api/settings`。

### Transient Queue

```js
createYouTubeKaraokeQueue() -> {
  add(item), remove(queueId), move(queueId, delta),
  start(queueId?), advance(expectedRevision), clear(), snapshot()
}

QueueItem = {
  queueId: string,
  videoId: string,
  title: string,
  channel: string,
  durationSec: number,
  thumb: string
}
```

- Queue 純前端記憶體；不新增 DB table／localStorage／server Queue API。
- `advance()` 只有目前 `videoId` 的新 `ended` revision 可呼叫一次。

### Pitch frames 與 take

```js
PitchFrame = { timeMs, hz, midi, cents, confidence, voiced }
StoredFrame = [timeMs, midiTimes100, confidenceTimes1000]

PitchTakeInput = {
  videoId,
  title,
  channel,
  keySemitones,
  durationMs,
  frames: StoredFrame[]
}
```

- 取樣 bucket 為 100 ms；同一 bucket 只留 confidence 較高者。
- `frames.length <= 4500`、request body `<= 96 KiB`、`title <= 200`、`channel <= 200`。100 ms bucket 可涵蓋 7.5 分鐘；超長歌曲先停止新增 frame、仍保存已收集部分。
- Server 重新驗證、排序、去重並從 frames 計算 summary；不信任 client 傳 summary。

```sql
CREATE TABLE IF NOT EXISTS karaoke_pitch_takes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  performed_at TEXT NOT NULL DEFAULT (datetime('now')),
  key_semitones INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  voiced_ratio REAL NOT NULL,
  lowest_midi REAL,
  highest_midi REAL,
  comfortable_low_midi REAL,
  comfortable_high_midi REAL,
  frames TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_karaoke_pitch_takes_video_time
ON karaoke_pitch_takes(video_id, performed_at DESC, id DESC);
```

REST：

- `POST /api/karaoke/pitch-takes`：驗證／重算／存一筆，回 `{ id, summary }`。
- `GET /api/karaoke/pitch-takes?videoId=...`：只回該影片 summary list，不回 `frames`。
- `GET /api/karaoke/pitch-takes/:id`：回單筆 metadata＋frames。
- `DELETE /api/karaoke/pitch-takes/:id`：刪單筆，回 `{ success: true }`。

---

## Task 0：建立乾淨 worktree、基線與 handoff

**Files:**

- Read: `C:\Users\USER\Desktop\project\Kanaric\AGENTS.md`
- Read: 本 Plan
- Create in new worktree: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Consumes: `origin/main@9bb97b6` 與原 checkout 的實際 Git state。
- Produces: `codex/youtube-karaoke-extension` 隔離 worktree；不修改產品檔。

- [ ] **Step 1: 只讀確認原 checkout**

```powershell
git status --short --branch
git log -1 --oneline
git rev-parse origin/main
git merge-base --is-ancestor 9bb97b6 origin/main
git worktree list --porcelain
```

Expected: `origin/main` 仍解析到 `9bb97b6` 或其 descendant，且目標 worktree／branch 尚不存在。若 ref 漂移、branch 已存在、路徑已有非空內容或任何狀態不明，停止回報，不覆蓋。

- [ ] **Step 2: 使用 `superpowers:using-git-worktrees` 建立隔離 worktree**

```powershell
git worktree add -b codex/youtube-karaoke-extension C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension 9bb97b6
```

- [ ] **Step 3: 在新 worktree 跑原始基線**

```powershell
git status --short --branch
git log -1 --oneline
node tests/test_karaoke_mode.js
node tests/test_origin_guard.js
node tests/test_search_query.js
venv\Scripts\python.exe tests\test_yt_search.py
```

若 venv 不存在，記為 environment blocker；不得先安裝或改測試來讓 gate 通過。

- [ ] **Step 4: 建立 handoff**

記錄 worktree、branch、HEAD、所有基線命令與 exit code、已知環境限制及 Task 1 prompt。

**Task 0 stop:** 沒有產品修改、沒有 dependency install、沒有 commit／push。

## Task 1：純 protocol、配對 token 與暫存 Queue

**Files:**

- Create: `web-app/youtube-karaoke-protocol.js`
- Create: `web-app/public/js/youtube-karaoke-queue.js`
- Create: `tests/test_youtube_karaoke_protocol.js`
- Create: `tests/test_youtube_karaoke_queue.js`
- Modify: `web-app/server.js`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Produces: `normalizeExtensionState(raw)`, `normalizeKaraokeCommand(raw)`, `readOrCreateExtensionToken({ dataDir, randomBytes })`。
- Produces: `createYouTubeKaraokeQueue()`，介面依本檔「介面總表」。
- Produces: authenticated extension WebSocket role；尚不建立 Chrome extension。

- [ ] **Step 1: 寫 protocol RED tests**

覆蓋 valid state／command、bad videoId、NaN／負時間、非整數 Key、過長字串、未知 action、舊 revision、token 32 bytes base64url、token 檔案 `wx` 建立與重讀一致、token 不出現在 settings／一般 init broadcast。

- [ ] **Step 2: 寫 Queue RED tests**

覆蓋 add、唯一 queueId、remove、move 邊界、start、正常 ended advance、重複 ended 不前進、錯 videoId／舊 revision 不前進、clear 回空。

- [ ] **Step 3: 確認 RED**

```powershell
node tests/test_youtube_karaoke_protocol.js
node tests/test_youtube_karaoke_queue.js
```

Expected: `MODULE_NOT_FOUND`。

- [ ] **Step 4: 實作最小 pure modules**

Queue 使用陣列與單一 integer revision；protocol 使用顯式 allowlist／clamp，不建立 class hierarchy、provider abstraction 或 persistent Queue。

- [ ] **Step 5: 接 WebSocket 驗證**

現有同源 client 維持原 `verifyClient`。只有 subprotocol 第一值為 `kanaric-youtube-v1` 且第二值 token 通過 timing-safe compare 時，允許 Chromium 實際使用的 `chrome-extension://<extension-id>` origin 並標記 `ws.isYouTubeExtension=true`；未驗證 extension 不得收到 `init`、settings 或 media state。

Server 只允許一個 active extension；新 authenticated connection 取代舊 connection並關閉舊 socket。一般頁面的 command 只 forward 給該 socket；extension state 經 normalize 後只 broadcast 給 `ws.isKaraoke` clients。

- [ ] **Step 6: GREEN 與 regression**

```powershell
node tests/test_youtube_karaoke_protocol.js
node tests/test_youtube_karaoke_queue.js
node tests/test_origin_guard.js
node --check web-app/server.js
node --check web-app/youtube-karaoke-protocol.js
```

**Task 1 stop:** protocol／token／Queue contract 存在；尚無 extension、YouTube 控制或 UI。

## Task 2：Manifest V3 擴充套件、配對與 YouTube player state

**Files:**

- Create: `browser-extension/package.json`
- Create: `browser-extension/package-lock.json`
- Create: `browser-extension/build.mjs`
- Create: `browser-extension/src/manifest.json`
- Create: `browser-extension/src/service-worker.js`
- Create: `browser-extension/src/youtube-content.js`
- Create: `browser-extension/src/popup.html`
- Create: `browser-extension/src/popup.js`
- Create: `browser-extension/src/popup.css`
- Create: `browser-extension/tests/protocol.test.js`
- Create: `browser-extension/tests/youtube-state.test.js`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Consumes: Task 1 WebSocket protocol。
- Produces: unpacked extension `browser-extension/dist/`；一個專用 YouTube tab；load/play/pause/seek/state/ad/ended/error。
- Does not produce: pitch shifting（Task 3）。

- [ ] **Step 1: 建立最小 package 與 deterministic build**

```json
{
  "private": true,
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test tests"
  },
  "dependencies": {
    "@soundtouchjs/audio-worklet": "2.1.1"
  },
  "devDependencies": {
    "esbuild": "0.28.2"
  }
}
```

Task 2 可安裝鎖定 dependency，但不使用 SoundTouch；Task 3 才接 DSP。`build.mjs` 清空並重建 `dist/`，bundle service worker／content／popup，copy manifest、HTML、CSS；不得下載 runtime code。

- [ ] **Step 2: 寫 RED tests**

測試 pairing string 只接受 `http://127.0.0.1:<1..65535>#<base64url-token>`、不得接受 hostname／https／path token；command mapping；YouTube DOM adapter 將 player／ad flags 投影成核准 state；revision load 遞增；ended 只發一次。

- [ ] **Step 3: 實作 popup 與 service worker**

Popup 儲存 `{baseUrl, token}` 到 `chrome.storage.local`，顯示 disconnected／connecting／connected。按「連線並接管 YouTube」才建立或聚焦專用 `youtube.com/watch` tab 並建立 WebSocket；不掃 localhost ports、不讀 browser history。

- [ ] **Step 4: 實作 content script adapter**

只在 `https://www.youtube.com/*` 執行。load 使用正常 watch URL；play／pause／seek 使用頁面 `<video>`／player 可觀察介面。每 250 ms 回報 state，但 state 未變且 position drift 小於 200 ms 時不洪泛；SPA navigation、ad、buffering、video unavailable、age/sign-in block 都投影成 typed state/error，不點廣告、不繞過限制。

- [ ] **Step 5: 驗證 build 與 contract**

```powershell
cd browser-extension
npm.cmd ci
npm.cmd test
npm.cmd run build
cd ..
node --check browser-extension/dist/service-worker.js
```

手動檢查 `dist/manifest.json` 只有 `storage`, `tabs`, `activeTab`, `scripting`, `tabCapture`, `offscreen` 與必要 YouTube／localhost host permissions；不得有 `<all_urls>`、remote script 或 eval。

**Task 2 stop:** extension 能配對並控制／回報 YouTube；Key 仍固定 0，Kanaric 尚未有新 Queue UI。

## Task 3：tabCapture、offscreen AudioWorklet 與手動 Key

**Files:**

- Create: `browser-extension/src/offscreen.html`
- Create: `browser-extension/src/offscreen.js`
- Create: `browser-extension/tests/key-control.test.js`
- Modify: `browser-extension/src/manifest.json`
- Modify: `browser-extension/src/service-worker.js`
- Modify: `browser-extension/build.mjs`
- Create: `browser-extension/THIRD_PARTY_NOTICES.md`
- Copy during build: SoundTouchJS MPL-2.0 license and pre-bundled processor into `dist/vendor/`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Consumes: authenticated `set_key` command。
- Produces: `setKey(semitones)`、state `keySemitones` readback、DSP metrics／typed failure。

- [ ] **Step 1: 寫 Key RED tests**

測試 `-6..6` 整數、越界拒絕、換歌回 0、offscreen message acknowledgment、AudioWorklet init failure 回 `pitch-processing-unavailable`、DSP fail-safe bypass 不造成無聲。

- [ ] **Step 2: 以使用者手勢取得 tab stream**

Popup 的「連線並接管」手勢觸發 `chrome.tabCapture.getMediaStreamId({ targetTabId })`。Service worker 建立 offscreen document，將 streamId 傳入；不可在背景自行重試權限或捕捉其他 tab。

- [ ] **Step 3: 建立最小 audio graph**

```text
tab MediaStreamSource -> SoundTouchNode -> GainNode -> AudioContext.destination
```

註冊本機 `vendor/soundtouch-processor.js`，`pitchSemitones.value` 接整數 Key，`playbackRate` 固定 1。Key 0 仍走同一 graph；worklet 初始化失敗則 source 直接接 destination，state truthful 顯示 Key unavailable。

- [ ] **Step 4: synthetic offline check**

使用 SoundTouchJS offline API／可注入 fake worklet：440 Hz `+12` 的 dominant frequency 約 880 Hz、`-12` 約 220 Hz（±2%）；產品 UI 仍只開放 `-6..6`。此 test 不以單純 parameter assertion 代替 DSP 輸出。

- [ ] **Step 5: build／license／tests**

```powershell
cd browser-extension
npm.cmd test
npm.cmd run build
cd ..
rg -n "MPL-2.0|SoundTouch" browser-extension/dist browser-extension/THIRD_PARTY_NOTICES.md
```

**Task 3 stop:** 真正升降 Key path 完成；尚未改 Kanaric Karaoke UI／歌詞來源。

## Task 4：YouTube-only Karaoke 搜尋、臨時 Queue 與權威時間軸

**Files:**

- Modify: `web-app/views/karaoke.ejs`
- Create: `web-app/public/js/youtube-karaoke.js`
- Modify: `web-app/public/js/karaoke-mode.js`
- Modify or retire from `/karaoke`: `web-app/public/js/karaoke-mv.js`
- Modify: `web-app/public/css/style.css`
- Modify: `web-app/server.js`
- Modify: `web-app/browser-query.js`
- Modify: `tests/test_youtube_karaoke_queue.js`
- Modify: `tests/test_karaoke_mode.js`
- Modify: `tests/test_search_query.js`
- Modify: `tests/test_origin_guard.js`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Consumes: `/api/mv/search` result與 Task 1 Queue／protocol。
- Produces: YouTube-only setup/search/results/current/next Queue UI；extension state 驅動既有 Karaoke renderer。

- [ ] **Step 1: 寫 UI／state RED contracts**

以純函式測試 search result → QueueItem、第一筆 `ok` 預選、全部 `ok:false` 不自動開唱、ended revision exactly-once advance、pause／buffering／ad 不累加位置、seek 硬對齊、換歌清 Key 至 0、最後一首 ended 回 idle。

- [ ] **Step 2: 重用搜尋，不建第二套 provider**

搜尋框把整個 query 傳 `/api/mv/search?title=<query>&artist=`。結果沿用 `videoId/title/channel/durationSec/thumb/ok`；顯示外部資料全部 `textContent`。選中後用 `cleanBrowserQuery(result.title, result.channel)` 取得歌詞 query，但畫面仍顯示原 YouTube metadata。

- [ ] **Step 3: 建立臨時 Queue UI**

包含「現在唱」「加入待播」、目前歌曲、待播清單、刪除、上移、下移。Queue state 只在 `youtube-karaoke-queue.js` 一份；DOM 不作 state source。關頁不發 persistence API。

- [ ] **Step 4: 把 Karaoke clock 切到 extension state**

`karaoke-mode.js` 在 `/karaoke` 只接 `youtube_karaoke_state`。使用 `positionMs / 1000` 餵既有 `karaokeSlots`／`karaokePaint`；不再呼叫 `/api/playpause`、`/api/seek` 或讀 `/api/current-media`。Play／pause／restart／seek／Key 變成 `youtube_karaoke_command`。

- [ ] **Step 5: 保留歌詞能力，移除重複 MV 同步**

現有 YouTube iframe 不再是靜音背景，`karaoke-mv.js` 的 player／offset sync 不可同時執行。保留／搬移人工換片 picker 所需 result UI，但只有 extension tab 播放聲音與影片；Kanaric 主畫面可以顯示縮圖／狀態，不假裝 iframe 是音訊 owner。

- [ ] **Step 6: regression**

```powershell
node tests/test_youtube_karaoke_queue.js
node tests/test_karaoke_mode.js
node tests/test_search_query.js
node tests/test_origin_guard.js
venv\Scripts\python.exe tests\test_yt_search.py
node --check web-app/public/js/youtube-karaoke.js
node --check web-app/public/js/karaoke-mode.js
node --check web-app/server.js
```

**Task 4 stop:** Kanaric 可搜歌、排待播、驅動 extension 與同步歌詞；尚未啟用麥克風／保存音高。

## Task 5：本機麥克風音高偵測與 15 秒即時曲線

**Files:**

- Port minimally from gap branch: `web-app/public/js/pitch-analysis.js`
- Create: `web-app/public/js/karaoke-pitch-recorder.js`
- Modify: `web-app/views/karaoke.ejs`
- Modify: `web-app/public/css/style.css`
- Modify: `web-app/electron.js`
- Create: `tests/test_pitch_analysis.js`
- Create: `tests/test_karaoke_pitch_recorder.js`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Produces: `detectPitchFrame(audioFrame, sampleRate, timeMs)`、`summarizeRange(frames)`。
- Produces: `createKaraokePitchRecorder({ mediaDevices, AudioContext, getPlaybackState, onFrame })` with `enable()`, `startTake(song)`, `pause()`, `resume()`, `finishTake()`, `dispose()`。
- Produces: compact `StoredFrame[]`，不產生 raw audio。

- [ ] **Step 1: port pure detector with RED/GREEN fixtures**

先複製／收斂 gap branch 已有純 detector，不搬 Pitch Lab reference-file、recommendKey、monitoring effects或 localStorage。Tests 包含 silence、220／440／880 Hz、low-confidence、octave ambiguity、range summary。

- [ ] **Step 2: 寫 recorder state RED tests**

Fake media stream／clock 覆蓋：未經 enable 不取權限；playing 才寫；paused／buffering／ad／error 不寫；100 ms bucket；同 bucket 留較高 confidence；seek backward 不產生未排序資料；finish 少於 20 voiced frames 回 `insufficient-data`；dispose 停 tracks／close context。

- [ ] **Step 3: 實作無監聽 microphone graph**

```text
getUserMedia -> MediaStreamAudioSourceNode -> AnalyserNode
```

Constraints 使用 `echoCancellation:false`, `noiseSuppression:false`, `autoGainControl:false`；不得接 `AudioContext.destination`。使用者按「啟用音高紀錄」才 request permission，成功後本 session 自動用於每首 take。

- [ ] **Step 4: Electron permission boundary**

在 `electron.js` 對 Kanaric 自身 `http://127.0.0.1:<PORT>`／`http://localhost:<PORT>` 的 `media` permission 明確 allow；其他 origin／permission deny。純瀏覽器 localhost 照 browser permission；不得全域放行 camera。

- [ ] **Step 5: 15 秒 Canvas**

固定只畫最近 15 秒，Y 軸 MIDI 36..84；voiced gap 斷線，不插值。顯示目前音名、confidence warning 與麥克風狀態；Canvas 不遮兩行歌詞且可關閉顯示，但 recorder 啟用狀態不由 Canvas visibility 決定。

- [ ] **Step 6: tests**

```powershell
node tests/test_pitch_analysis.js
node tests/test_karaoke_pitch_recorder.js
node tests/test_karaoke_mode.js
node --check web-app/public/js/pitch-analysis.js
node --check web-app/public/js/karaoke-pitch-recorder.js
node --check web-app/electron.js
```

**Task 5 stop:** 音高可即時畫但尚未進 DB；自動 Key 建議仍不做。

## Task 6：每首歌多次演唱紀錄、完整曲線與刪除

**Files:**

- Create: `web-app/karaoke-pitch-takes.js`
- Create: `web-app/public/js/karaoke-pitch-history.js`
- Modify: `web-app/server.js`
- Modify: `web-app/views/karaoke.ejs`
- Modify: `web-app/public/css/style.css`
- Create: `tests/test_karaoke_pitch_takes.js`
- Modify: `tests/test_backup_restore.js`
- Modify: `docs/CODEX_HANDOFF.md`

**Interfaces:**

- Consumes: Task 5 `StoredFrame[]`。
- Produces: `normalizePitchTake(payload)`, `summarizePitchTake(frames, durationMs)`, `createPitchTakeStore(db)`。
- Produces: 本檔定義的 POST／GET list／GET detail／DELETE APIs。

- [ ] **Step 1: 寫 DB／validation RED tests**

使用 temp SQLite，覆蓋 schema/index、videoId、title/channel 長度、Key、duration、96 KiB、4500 frames、排序／去重、server 重算 summary、同影片兩筆、跨影片隔離、list 不含 frames、detail 有 frames、delete one、SQL error non-destructive。

- [ ] **Step 2: 實作 pure normalize 與 store**

Frames 存 compact JSON；summary 欄位供 list query，不在 list 解析大 JSON。`comfortable` 使用有效 MIDI 的 20th／80th percentile；voiced ratio 使用 voiced buckets／歌曲 duration buckets。少於 20 frames server 也拒絕。

- [ ] **Step 3: 接 REST routes**

所有 routes 只在 localhost Admin app；既有 origin middleware 保護。沿用 Express 預設 JSON 上限，不調高全域；route 再拒絕超過 96 KiB 的 compact payload。DELETE 只刪 exact integer id；不存在回 404。

- [ ] **Step 4: 完整歷史 UI**

唱完自動 POST，成功後顯示本次摘要。歷史 modal 先 GET list；點一筆才 GET detail 並 Canvas 畫完整時間軸，Y 軸依 frames min/max 加 3 semitones padding。顯示日期、Key、音名範圍、主要音域、有效比例；刪除前要求確認，成功後只移除該 row。

- [ ] **Step 5: backup／privacy regression**

既有 DB backup 若是整庫備份，測試證明 table 隨 DB 保存／還原；不得把 pitch takes 加進 cache clear targets。掃描 network payload／DB schema，確認沒有 blob／audio／pcm／fft 欄位。

- [ ] **Step 6: tests**

```powershell
node tests/test_karaoke_pitch_takes.js
node tests/test_backup_restore.js
node tests/test_origin_guard.js
node --check web-app/karaoke-pitch-takes.js
node --check web-app/public/js/karaoke-pitch-history.js
node --check web-app/server.js
```

**Task 6 stop:** 每首歌歷次音高已保存／可看／可刪；不加入評分、原唱曲線或推薦 Key。

## Task 7：整合、擴充套件交付、Chrome／Edge／Electron 實測與 handoff

**Files:**

- Modify: `browser-extension/README.md`
- Modify: `web-app/package.json` only if extension artifact must be included in Electron resources
- Modify: `README.md` only for user-visible install／pairing instructions
- Modify: `docs/CODEX_HANDOFF.md`
- Do not create: Chrome Web Store／Edge Add-ons listing or public Release

**Interfaces:**

- Consumes: Tasks 1–6。
- Produces: locally installable extension build、可重現測試證據與未誇大的 acceptance table。

- [ ] **Step 1: focused suites**

```powershell
node tests/test_youtube_karaoke_protocol.js
node tests/test_youtube_karaoke_queue.js
node tests/test_karaoke_mode.js
node tests/test_search_query.js
node tests/test_pitch_analysis.js
node tests/test_karaoke_pitch_recorder.js
node tests/test_karaoke_pitch_takes.js
node tests/test_backup_restore.js
node tests/test_origin_guard.js
venv\Scripts\python.exe tests\test_yt_search.py
cd browser-extension
npm.cmd ci
npm.cmd test
npm.cmd run build
cd ..
```

- [ ] **Step 2: development Electron + Chrome**

以隔離 DB／settings 啟動 `npm.cmd run app`。手動 Load unpacked `browser-extension/dist`，完成配對。使用兩首可嵌入／可播放的普通 YouTube 歌曲：第一首 play／pause／seek／`-2`／`+2`／0，seek near end 觸發第二首；最後一首 ended 回 idle。記錄 extension state readback、歌詞時間、Queue 與人耳音質分開。

- [ ] **Step 3: Edge compatibility**

在 Edge 載入同一 `dist`，重做 connect、play、Key、ended 最小 gate。Chrome PASS 不可推論 Edge PASS。

- [ ] **Step 4: 真麥克風與 pitch history**

明確點擊啟用麥克風，唱／播放可控 220／440／880 Hz 參考，再完成同影片兩次、另一影片一次。驗證即時軌、ended 保存、歷史隔離、detail lazy load、刪單筆、其他紀錄保留。使用 DevTools network 確認沒有 raw audio／PCM／FFT 傳輸。

- [ ] **Step 5: failure gates**

逐一驗證 extension 未安裝、token 錯誤、extension disconnect、YouTube unavailable、buffering、ad（若實際出現）、worklet init failure、mic denied、mic disconnect、歌詞找不到。每個 failure 必須保留仍可用的較小功能，且 UI truthful。

- [ ] **Step 6: packaging boundary**

建立 extension zip／dist checksum 供本機安裝說明；Electron installer 不能自動安裝 Chromium extension。若把 extension artifact 放進 `extraResources`，需跑 package contents test；未跑 clean installer 時只標 `PARTIAL`。

- [ ] **Step 7: final regression and handoff**

```powershell
git diff --check
git status --short --branch
git diff --stat
```

Handoff 分欄記錄 Node、Python、extension unit、Chrome、Edge、Electron、真麥克風、可聽 Key、packaging。只有全部必要 gate 都有直接證據才寫 `ACCEPTED`；否則 `PARTIAL／UNVERIFIED／BLOCKED`，不得用 unit tests 代替。

**Task 7 stop:** 不發布、不 push、不做 deferred features。

---

## 每階段可直接貼上的提示詞

### Prompt — Task 0：worktree 與基線

```text
請只執行 Task 0，不要執行 Task 1 以後。

規劃來源是 C:\Users\USER\Desktop\project\Kanaric\docs\superpowers\plans\2026-08-31-youtube-karaoke-extension-pitch-history.md。先完整讀取該計畫與 C:\Users\USER\Desktop\project\Kanaric\AGENTS.md，並使用 superpowers:using-git-worktrees。

目標是從明確基線 origin/main@9bb97b6 建立 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。先只讀檢查原 checkout 的 status、HEAD、origin/main、worktree list；若 target branch/path 已存在、ref 不符或狀態不明，立即停止，不覆蓋、不自行選別的 base。

建立後在新 worktree 跑計畫列出的四個 baseline tests。不得修改原 checkout、不得用本機 main@01909d2、不得使用 codex/karaoke-system-gap-closure、不得 reset/clean/checkout/restore/stash/merge/rebase/cherry-pick/delete，也不得安裝 dependency、commit、push、PR。

在新 worktree 建立 docs\CODEX_HANDOFF.md，記錄 branch、HEAD、dirty state、每個命令與 exit code、限制，以及完整 Task 1 prompt。完成 Task 0 後立即停止並回報；不要開始 protocol 或產品程式。
```

### Prompt — Task 1：protocol、token、Queue

```text
請只執行計畫 Task 1，不要執行 Task 2 以後。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，確認 Task 0 gate、branch、HEAD、dirty state 相符。若不符立即停止。使用 TDD：先建立 tests/test_youtube_karaoke_protocol.js 與 tests/test_youtube_karaoke_queue.js，確認 RED，再最小實作 web-app/youtube-karaoke-protocol.js、web-app/public/js/youtube-karaoke-queue.js 與 server WebSocket authenticated extension role。

嚴格照計畫介面與限制：videoId/command/state allowlist、-6..6 整數、revision、base64url token、token 獨立檔案、timing-safe compare；未驗證 extension 不得收到 init/settings/media state。Queue 只在前端記憶體，不加 DB/localStorage/API，不做 persistent Queue、Session、Stage、MPV、Remote。

跑計畫列出的 focused tests、origin guard、node --check，記錄 exit code。不得修改 Music Mode、不得放寬一般 origin guard、不得安裝 dependency、commit、push、PR。更新 docs\CODEX_HANDOFF.md，附完整 Task 2 prompt，然後立即停止。
```

### Prompt — Task 2：MV3 extension 與 YouTube 控制

```text
請只執行計畫 Task 2，不要執行 Task 3 以後。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，重跑 Task 1 focused tests並確認基線。建立 browser-extension 獨立 package，版本精確鎖定 @soundtouchjs/audio-worklet@2.1.1 與 esbuild@0.28.2；建立 deterministic build、MV3 manifest、service worker、YouTube content script、popup 與 Node tests。這一 Task 只做 pairing、專用 tab、load/play/pause/seek、state/ad/ended/error；SoundTouch Key 留給 Task 3。

先寫 pairing parser、command mapping、YouTube state adapter、revision 與 ended exactly-once RED tests，再最小 GREEN。Extension 不得掃 localhost ports、讀 browser history、使用 <all_urls>、遠端 script、eval、跳廣告或繞過登入/年齡限制。npm install 是本 Task 唯一允許的新 dependency 動作，必須產生 lockfile。

跑 npm.cmd ci、npm.cmd test、npm.cmd run build 與 syntax/manifest 檢查，記錄 exit code。不得改 Kanaric Karaoke UI、不得 commit/push/PR。更新 docs\CODEX_HANDOFF.md，附完整 Task 3 prompt，然後立即停止。
```

### Prompt — Task 3：真正升降 Key

```text
請只執行計畫 Task 3，不要執行 Task 4 以後。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，重跑 extension Task 2 tests/build。先寫 Key range、換歌歸零、offscreen acknowledgment、worklet failure/bypass 與 synthetic DSP RED tests，再建立 offscreen document、tabCapture user-gesture flow、SoundTouchJS AudioWorklet graph與 set_key readback。

Key UI contract 只允許 -6..6 整數，tempo 永遠 1.0。不得用 playbackRate 假裝升降 Key。Worklet 失敗要 truthful 回 pitch-processing-unavailable 並讓未處理音訊 bypass，不可無聲。所有 processor/code 必須本機打包，加入 MPL-2.0 授權與 THIRD_PARTY_NOTICES；不得載遠端 JS。

用 synthetic 440 Hz 輸出證明 +12 接近 880 Hz、-12 接近 220 Hz；產品仍只開 -6..6。跑完整 extension tests/build/license scan，記錄 exit code。不得改 Kanaric UI、不得 commit/push/PR。更新 docs\CODEX_HANDOFF.md，附完整 Task 4 prompt，然後立即停止。
```

### Prompt — Task 4：YouTube-only Karaoke 與臨時待播

```text
請只執行計畫 Task 4，不要執行 Task 5 以後。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，重跑 Tasks 1–3 focused tests。把既有 /karaoke 收斂為 YouTube-only：重用 /api/mv/search 與 yt_search.py，建立搜尋結果、現在唱、加入待播、刪除、上下移動；Queue 只在記憶體，關頁清空。第一筆 ok 預選，全部不可靠時不得自動開唱，外部字串只能 textContent。

以 youtube_karaoke_state.positionMs 作唯一 Karaoke clock；play/pause/restart/seek/Key 全走 youtube_karaoke_command，不讀 /api/current-media、不呼叫 Spotify/Windows player APIs。保留既有 LRC/ruby/#TRANS#/#ROMAJI#/#WORDS#/offset/two-line/word fill。移除或停用重複的靜音 YouTube iframe player，不讓兩個 player 同時存在。

先寫 state/Queue/UI pure RED tests，再 minimal GREEN。跑計畫列出的 Node/Python regression 與 syntax checks，記錄 exit code。不得加 persistent playlist、SongLibrary、Session、Stage、MPV、Remote、mic、pitch history、commit/push/PR。更新 docs\CODEX_HANDOFF.md，附完整 Task 5 prompt，然後立即停止。
```

### Prompt — Task 5：即時音高紀錄

```text
請只執行計畫 Task 5，不要執行 Task 6 以後。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，確認 Task 4 YouTube clock contracts 綠。從 gap branch 只最小移植純 pitch-analysis detector；不要搬 Pitch Lab reference import、recommendKey、monitoring/effects 或 localStorage。先寫 220/440/880、silence、confidence、octave/range 與 recorder playing/pause/ad/seek/bucket/dispose RED tests。

麥克風只能在使用者按「啟用音高紀錄」後 getUserMedia；graph 只接 AnalyserNode，不接 destination，不監聽回放。只在 YouTube state=playing 時以 positionMs 寫 100ms compact frame；pause/buffering/ad/error 不寫，缺口不插值。Electron 只放行 Kanaric same-origin 的 media/microphone，不放行 camera 或外部 origin。

Karaoke 畫面只加最近 15 秒小型 Canvas、目前音名與 confidence/mic 狀態，不遮歌詞。這一 Task 不寫 DB、不做歷史、評分、原唱比較、自動 Key 建議。跑計畫 tests/checks，更新 docs\CODEX_HANDOFF.md，附完整 Task 6 prompt，然後立即停止；不得 commit/push/PR。
```

### Prompt — Task 6：按歌曲保存歷次音高

```text
請只執行計畫 Task 6，不要執行 Task 7。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，重跑 Task 5 pitch tests。先以 temp SQLite 寫 karaoke_pitch_takes schema、validation、summary recompute、同影片多筆、跨影片隔離、list/detail lazy frames、delete one、backup/privacy RED tests，再 minimal GREEN。

嚴格使用計畫 schema/API/limits：videoId 11 chars、Key -6..6、<=4500 compact frames、<=96KiB、server 排序去重並重算摘要、少於20 frames不存。list 不回 frames，detail 才回。歷史 UI 顯示日期、當時 Key、音域與有效比例，點入才畫完整曲線；刪除只刪 exact id。不得保存 raw audio/PCM/FFT，不得把 table 加到 cache clear targets。

跑計畫列出的 DB/API/backup/origin/syntax tests，記錄 exit code。不得加評分、原唱曲線、推薦 Key、人聲分離、commit/push/PR。更新 docs\CODEX_HANDOFF.md，附完整 Task 7 prompt，然後立即停止。
```

### Prompt — Task 7：完整 runtime gate 與交付

```text
請只執行計畫 Task 7；不要做任何 deferred feature。工作位置固定為 C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension、branch codex/youtube-karaoke-extension。

先讀 AGENTS.md、完整計畫、docs\CODEX_HANDOFF.md，確認 Tasks 1–6 已有實際 RED/GREEN 證據。串行跑計畫的全部 Node、Python、extension unit/build tests；再用隔離 DB/settings 跑 development Electron、Chrome、Edge、兩首真 YouTube、play/pause/seek/Key/ended Queue、真麥克風與三筆跨影片 pitch history。Chrome、Edge、Electron、麥克風、可聽 Key、network privacy、packaging 證據必須分開。

驗證 extension missing/bad token/disconnect、YouTube unavailable/buffering/ad、worklet failure、mic denied/disconnect、lyrics missing。不得跳廣告、繞過平台限制、下載音訊或用 unit test 冒充實機。產生本機 extension dist/zip/checksum 與安裝配對說明，但不得自動安裝 extension、不得 Chrome Web Store/Edge Add-ons 發布、不得 commit/push/PR/tag/Release。

最後跑 git diff --check/status/diff stat，更新 docs\CODEX_HANDOFF.md：逐項列命令、exit code、PASS/PARTIAL/UNVERIFIED/BLOCKED、限制與是否 ACCEPTED。任何 Chrome/Edge/真 mic/可聽 DSP/歌詞同步/資料隔離 gate 沒有直接證據時不得宣稱完成。回報後立即停止。
```

## 最終停止條件

- 基線／worktree／branch／dirty state 不符：立即停止，不自行修復或改 base。
- Chrome／Edge 不允許 tabCapture、offscreen、extension permission 或實際 YouTube state：保留 contract 證據並標 `BLOCKED／UNVERIFIED`，不改成下載音訊。
- SoundTouchJS 有明顯爆音／underrun 或 license/build 不完整：Key gate 不通過；YouTube 原調播放可保留，但不得宣稱 Key ready。
- 麥克風權限、sample rate、octave 或 confidence 不可靠：曲線顯示缺口／warning；不得補畫猜測、不得宣稱評分準確。
- 自動建議 Key、音域校準、批次分析、人聲分離、Spotify、多人點歌是下一輪候選，不得以「順便」名義加入本計畫。
