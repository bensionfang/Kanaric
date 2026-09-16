# Kanaric YouTube Karaoke Extension — Canonical Handoff

最後更新：2026-09-11
目前關卡：canonical roadmap Task 9 final closure
驗收狀態：`PARTIAL`
下一步：`USER RUNTIME GATES REQUIRED`

## 1. 接手結論

Phase 1R 已取得直接 Chrome runtime 證據並通過驗收，視為凍結基線。不要再次把 Phase 1R 改回待驗證，也不要自動沿用舊文件中的 Task 7。

2026-09-09 使用者已明確授權依 [2026-09-09-chrome-karaoke-four-part-roadmap.md](./superpowers/plans/2026-09-09-chrome-karaoke-four-part-roadmap.md) 由 Task 3 執行至 Task 9；本次授權已 supersede 原先的 read-only next-stage gate。Phase 1R 仍維持凍結基線，不因後續 Task 改寫。

2026-09-09 standalone 路徑已停止：多來源 provider 不再接受新修正；App-required path 是唯一產品路徑；另一個任務若恢復，不得繼續 standalone Tasks。

歷史計畫 [2026-08-31-youtube-karaoke-extension-pitch-history.md](./superpowers/plans/2026-08-31-youtube-karaoke-extension-pitch-history.md) 僅供背景參考：

- Tasks 0–6 已屬目前 dirty worktree 的既有基線。
- 舊 Task 7 已過時，不是下一階段的自動授權。
- 若歷史計畫與本文件衝突，以本文件為準。

## 2. Repository 與硬性邊界

- 工作目錄：`C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension`
- 分支：`codex/youtube-karaoke-extension`
- 記錄時 HEAD：`830767c25335c2807c9a77a04d057dcd985f057e`
- 原始主程式：`C:\Users\USER\Desktop\project\Kanaric`，只讀參考
- 必須保留所有既有 dirty / untracked 修改。
- 不得執行 reset、clean、restore、stash、merge、rebase、cherry-pick、commit、push、PR 或 release。
- 不得讀取、輸出或修改 pairing token。
- 不得自行建立新的 YouTube 視窗；runtime 驗證只使用使用者授權的 owner tab。
- 未取得對應平台的直接 runtime 證據，不可宣稱該平台完成。

開始任何新工作前，先重新確認 Git root、branch、HEAD、status；上述狀態可能已變動。

## 3. Phase 1R 已完成能力

- Chrome MV3 extension 可與本機 Kanaric server 配對及回報 YouTube 播放狀態。
- YouTube content script 可呈現同步歌詞 overlay。
- 播放、暫停、seek、恢復播放不會清除同影片已載入歌詞。
- YouTube SPA 換歌會切換到新歌詞，不殘留上一首。
- 非歌曲／直播頁面不會沿用上一首歌詞。
- extension reload 後，既有 YouTube tab 重新整理即可建立新 content-script context。
- source 與 isolated dist 已完成一致性檢查。

## 4. Phase 1R 最後核心修正

1. Overlay slot identity
   - 歌詞列以 `data-slot` 維持穩定位置，不再用易碰撞的文字內容辨識。
2. Service Worker metadata replay
   - metadata retry payload 與送出順序已修正，延遲 title/channel 不會被 dedupe 吃掉。
3. Track reset
   - coordinator 的 `resetActive()` 與 server state reset 已補齊，換歌或離開有效歌曲時會清除舊狀態。
4. Same-video payload retention
   - 同影片的 status replay 會保留 `loaded` 歌詞，不會再次把 `.kanaric-lyrics-lines` 設為 hidden。

## 5. 直接 runtime 驗收證據

Chrome owner tab 已驗證：

- Lemon 在同一分頁刷新後載入 55 行歌詞 payload，畫面可見兩行 ruby 歌詞。
- 暫停約 22.7 秒、seek 約 62.7 秒、再次播放約 64.1 秒，歌詞持續維持 loaded 且可見。
- 在同一有效 YouTube context 由「春雷」SPA 切換至「Lemon」，歌詞正確切換，未殘留上一首。
- extension popup、YouTube overlay 與 server payload/connection 均有直接證據。

注意：重新載入 extension 會讓舊 content-script context 失效；必須重新整理同一個 YouTube tab。這是 Chrome extension lifecycle，不是歌詞搜尋失敗。

## 6. 最近一次自動驗證

- `node --test browser-extension/tests/phase1.test.js`：62/62 PASS
- `node tests/test_youtube_karaoke_lyrics.js`：PASS
- `node tests/test_youtube_karaoke_server.js`：PASS
- 相關 JavaScript syntax checks：PASS
- `git diff --check`：exit 0；僅既有 LF/CRLF warnings

Phase 1R 因此為 `ACCEPTED: YES`。這些結果是 Phase 1R 基線，不等同下一階段驗收。

## 6A. Task 1 — Chrome playback / Key owner-tab 修復（2026-09-08）

- 使用者已直接重現 Task 1 runtime RED：在有效的 Chrome `https://www.youtube.com/...` 分頁按 extension popup 的 Connect，第一次連線回覆 `youtube-owner-tab-required`。
- 根因：popup message 沒有 `sender.tab`；fresh install 又沒有已儲存 owner，舊的 `ensureYouTubeTab()` 因而無法認領目前 YouTube tab。既有測試錯誤地把 popup sender 模擬成 YouTube tab。
- 最小修復：保留 preferred tab 與 stored owner 的既有優先順序；兩者皆無效時，`tabs.query({ active: true, currentWindow: true })` 只透過 YouTube URL/id 驗證後認領、儲存並 activate 該 tab。非 YouTube active tab 仍回覆 `youtube-owner-tab-required`；不建立新 tab。
- 修改：`browser-extension/src/service-worker.js`、`browser-extension/dist/service-worker.js`、`browser-extension/tests/protocol.test.js`。dist 僅手術式同步 owner-tab fallback，未執行 build，也未改動 zip/hash 或其他 dist artifact。
- RED：`node --test --test-name-pattern="active YouTube tab when popup sender" browser-extension/tests/protocol.test.js` → exit 1，預期 `youtube-owner-tab-required`。
- GREEN：同一命令 → exit 0，1/1 PASS；`node browser-extension/tests/protocol.test.js` → 21/21 PASS。Task 1 全回歸與 syntax checks 均 PASS，詳見 task report。
- 直接 Chrome post-fix retest：**UNVERIFIED / required**。不得把 automated GREEN 視為 Chrome Connect、load/play/pause/seek/Key/Queue 或 audible DSP 的直接通過證據。
- Loaded-bundle parity repair：runtime RED 顯示 Python 注音成功但 overlay 停在「搜尋歌詞」；原因是 dist content/worker 遺漏 src 的 watchdog、reset/retain 與 waiting metadata completion 路徑。以暫存 esbuild 僅同步 `dist/youtube-content.js`、`dist/service-worker.js`，新增 1 個 bundle parity RED/GREEN test 後，Task 1 回歸全數 PASS；Chrome reload/retry 仍為 **UNVERIFIED / required**。
- QQ source round（2026-09-08）：YouTube `searchBestLyric` 在 `NetEase`、`Kugou`、`QQMusic` 偏好下都會先嘗試 QQ；僅 QQ 自身回傳 `QQMusic` 且 `word=true` 時才採用。QQ 無逐字或內部 fallback 不佔位，會讓後續來源接手。direct Chrome runtime 仍為 **UNVERIFIED / required**；Phase 1R 的 `ACCEPTED: YES` 凍結不變。唯讀 parity audit 尚未處理的項目為：`no_lyrics` guard/background recheck、persisted `sync_offsets`；YouTube cache 的 `wordTimesMismatch` 已由 6G 補上。
- Phase 1R 保持 `ACCEPTED: YES`；本 Task 1 runtime gate 不改寫其凍結結論。沒有 commit、package 或 Git 歷史操作。

## 6B. Task 2 — Chrome microphone / realtime pitch（2026-09-08）

- Task 2 僅完成 automated/static closure：`tests/test_pitch_analysis.js`、`tests/test_karaoke_pitch_recorder.js`、`tests/test_karaoke_mode.js` 均 PASS。
- `youtube_karaoke_state.positionMs` 維持唯一 karaoke/pitch clock；`getUserMedia` 只會在 `enablePitchRecording()` 的使用者動作後呼叫。
- 已核對本機圖為 `getUserMedia → MediaStreamAudioSourceNode → AnalyserNode`，不連接 `AudioContext.destination`、extension 或 network/raw-audio payload。
- 已核對僅 `state === 'playing'` 寫入 100 ms compact frames；pause／buffering／ad／error／seek gaps 均維持缺口，15 秒曲線不插值；既有 Electron same-origin audio-only permission boundary 亦已 trace。
- 沒有可重現 RED，因此沒有產品或測試修改。Task 3、Edge、Electron runtime 與 package 均未開始。
- 直接 Chrome microphone gate：**UNVERIFIED / required**。必須由使用者授權並完成實測後，才能接受 220／440／880 Hz、octave/confidence、playing-only、gap 與 DevTools network 無 raw-audio payload 的 runtime 結果。

## 6C. Task 3 — Chrome pitch history / privacy（2026-09-09）

- Task 3 僅完成 automated/static closure。Task 1 focused regression 維持 PASS；`test_karaoke_pitch_takes.js`、`test_backup_restore.js`、`test_origin_guard.js` 均在 temporary SQLite/HTTP state 下 PASS。checkout 缺少本地 `sqlite3`／`ws`，測試只透過 process-local `NODE_PATH` 使用既有主工作區依賴；未安裝、複製或修改 dependency。
- 已核對 `finishPitchTake()` 僅在 recorder `ready` 時提交 compact frames；server 驗證並重算 summary，依 videoId list 不含 `frames`，detail lazy 回傳 `frames`，delete 只接受正 safe integer id。
- 已核對限制為 4500 frames、96 KiB、title/channel 200、Key -6..6、至少 20 frames；同影片多筆、跨影片隔離、單筆刪除、SQL failure non-destructive、backup/restore preservation 和 cache-clear 不刪 pitch takes 均由 focused tests 覆蓋。
- `karaoke_pitch_takes` 只保存 compact frames，backup test 確認表沒有 raw-audio／PCM／FFT 欄位；history UI 的外部文字經 `textContent`。沒有新增 scoring、comparison 或 recommendation。
- 沒有可重現 RED，因此沒有產品或測試修改。Task 4／Edge、Electron runtime 與 package 均未開始。
- 直接 Chrome history/privacy gate：**UNVERIFIED / required**。使用者仍須完成同影片兩筆、另一影片一筆的 runtime 流程，驗證 summary、list isolation、lazy detail、單筆 delete、保留其餘資料及 network／DB 無 raw-audio 欄位/payload。Phase 1R 的 `ACCEPTED: YES` 不變。

## 6D. Task 4 — Edge runtime（read-only / automated，2026-09-09）

- 未開啟或操作 Edge，因使用者未提供可控制的 Edge runtime session。所有 Edge connection、load/play/pause/seek、Key -2／+2／0、Queue/disconnect、lyrics、microphone/pitch take 與 history list/detail/delete gates 均為 **UNVERIFIED / required**；automated PASS 不得視為 Edge PASS。
- 現有 `browser-extension` zip 為 39,592 bytes，SHA-256 `6DB9C37F75E8506D21AFCD24DAC9473D46E78A73A5C756D39440B1E131C30602`，與相鄰 `.zip.sha256` 相符。source/dist manifest byte-identical，仍為同一 MV3 build；README 正確指示 Chrome/Edge 都載入同一 `dist`，未建立 Edge fork。
- 但 current loaded `dist/service-worker.js` 與 `dist/youtube-content.js` 不符合 `dist.sha256` 記錄；其餘列出檔案相符。因此 current loaded dist／packaging input 為 **UNVERIFIED**，不得 rebuild、覆寫或開始瀏覽器 gate。
- extension 與 Tasks 1–3 focused suites 均 PASS（Task 3 仍只用 process-local `NODE_PATH` 的既有依賴，未安裝 dependency）。無可重現 Edge RED，沒有產品/測試/README 修改；Task 5 未開始。Phase 1R `ACCEPTED: YES` 不變。

## 6E. Task 5 — non-destructive final closure（2026-09-09）

- Protected checkout baseline 保留：root、branch `codex/youtube-karaoke-extension` 與 HEAD `830767c25335c2807c9a77a04d057dcd985f057e` 未改；pre-existing dirty baseline 未正規化，細節不在 handoff 列出。沒有 commit、package、build、release、dependency install、pairing secret 或 production DB 操作。
- 完整 Tasks 1–3 Node focused suites、5 個 extension suites 與 `test_yt_search.py` 均 PASS；Node/SQLite tests 只用 process-local 主工作區 `NODE_PATH`，Python test 只用既有主工作區 venv。Electron/server/pitch/extension source+dist syntax checks PASS；`git diff --check` exit 0（僅既有 LF/CRLF warnings）。
- 靜態 Electron boundary：僅 same-origin localhost/127.0.0.1 audio-only media 可獲 permission，foreign origin 與 camera/video 皆拒絕；packaged data path 先導至 userData，extension 未列入 Electron `extraResources`。Electron runtime 未啟動。
- Packaging 為 **BLOCKED / UNVERIFIED**：current loaded `dist/service-worker.js`、`dist/youtube-content.js` 與 `dist.sha256` 不符，且 `browser-extension/build.mjs` 會 `rmSync` 現有 dirty `dist`。不具安全可重現的 current loaded dist，也沒有覆寫授權。
- Failure matrix：Node/Python/extension contracts PASS；Chrome Phase 1R 凍結 `ACCEPTED: YES` 不變；Chrome Task 1 post-fix、real microphone、history/privacy、Edge、Electron runtime、audible Key 與 direct privacy evidence 均 **UNVERIFIED / required**。Task 5 不宣稱 `ACCEPTED`，亦未開始新功能。

## 6F. Canonical roadmap Task 3–9 final closure（2026-09-09）

本節 supersede 6E 中「Task 5 未開始」等歷史 snapshot；6E 保留作為先前交接紀錄，不是目前狀態。

### Task 狀態

| Task | 結論 | 直接證據與限制 |
|---|---|---|
| 3 備選歌詞 | `PARTIAL` | source、strict schema、stale revision、textContent 與 server option apply 的自動驗證 PASS；`lyrics-options.test.js`、extension suite、lyric-quality、s2t、word-times、lyrics-delete、syntax、isolated build 均 PASS。Chrome YouTube 內候選搜尋／套用未驗證。 |
| 4 standalone LRCLIB | `PARTIAL` | HTTPS/JSON/size guard、clean query、單次 fetch、canonical payload、App 優先與 stale owner contract PASS；`standalone-lyrics.test.js` 與 full extension suite PASS。Chrome network/CORS/standalone runtime 未驗證。 |
| 5 Native Messaging discovery | `PARTIAL` | 固定 manifest key 對應 extension ID `majmclipplgfbommldfilmkmbnanjbec`；request/response validation、4-byte framing、unknown/oversize/origin/app-not-running negative cases、Electron runtime discovery writer、popup 無 port/token input 均完成並通過自動測試。乾淨安裝後 HKCU registry、實際 host handshake、uninstall removal 未驗證；未執行 package/install。 |
| 6 麥克風音高 | `PARTIAL` | `microphone-pitch.test.js`、既有 pitch-analysis/recorder、extension 77/77 PASS；只在明確 `pitch_start` 才取 mic，relay 不含 raw audio/PCM/FFT，pause/buffer/ad/seek gap 與停止釋放 contract 已測。真麥克風 permission、音名穩定度、Chrome mic indicator、可聽 DSP 未驗證。 |
| 7 去人聲 benchmark | `NOT STARTED` | 只建立不下載、不掃描資料夾的 harness；缺少使用者提供的 3–5 首合法音檔、工具/model source/license/size approval，因此沒有 benchmark result，也沒有 Go claim。negative harness exit 2 並寫出 `NOT STARTED`。 |
| 8 去人聲 product slice | `NO-GO / NOT STARTED` | Task 7 沒有 Go benchmark；依 roadmap 不修改 product code、不下載模型、不建立本機輸出功能。 |
| 9 final closure | `PARTIAL` | final isolated dist、完整自動回歸與本 handoff 更新完成；所有未直接看見的 Chrome、安裝、mic、audio 與 benchmark gate 仍保留上述狀態。 |

### Task 9 command evidence

- `npm.cmd --prefix browser-extension test`：exit 0，81/81 PASS。
- Focused：`lyrics-options.test.js`、`standalone-lyrics.test.js`、`microphone-pitch.test.js`、`native-discovery.test.js`：各 exit 0；`python tests/test_native_messaging_host.py`：exit 0。
- Root Node regression：`tests/test_*.js` sequential runner，35/35 exit 0。需要 `ws`/`sqlite3` 的 target tests 使用既有主工作區 `C:\Users\USER\Desktop\project\Kanaric\web-app\node_modules` 作 `NODE_PATH`；沒有安裝、複製或修改 dependency。
- Python regression：`test_pick_session.py`、`test_furigana_hint.py`、`test_yt_search.py`、`test_native_messaging_host.py`：4/4 exit 0；前 3 支使用既有主工作區 venv。
- Syntax：`node --check` service-worker/offscreen/youtube-content/popup/server/electron exit 0；不落地 `compile(open(...),'pytools.py','exec')` exit 0；manifest JSON parse PASS。
- `git diff --check`：exit 0；只見既有 LF/CRLF warnings。
- Final isolated dist：`C:\Users\USER\AppData\Local\Temp\kanaric-final-isolated-dist-runtime-20260909`，11 files，build exit 0；vendor 含 SoundTouch JS 兩支與授權檔。沒有執行會 `rmSync` dirty `browser-extension/dist` 的 normal build，也沒有產生正式 package。
- Task 7 harness negative run：exit 2，原因是明確檔案不存在，結果為 `NOT STARTED`；沒有下載模型、package 或 binary。

### 6G. YouTube QQ 逐字歌詞 cache 修正（2026-09-09）

- 使用者 runtime 回報「本首有 QQ 逐字歌詞，但目前 payload 沒有逐字」。source trace 找到兩個缺口：YouTube cache hit 沒有沿用既有 `wordTimesMismatch` 修復；偏好來源為 LRCLIB 時也不會進 QQ chain。另有首輪補抓的非同步 race：`word_times` 尚未完成時，YouTube payload 會先送出且背景補抓只重播一般桌面媒體。
- 最小修正：YouTube 搜尋在非中文偏好下仍走 `QQMusic → NetEase → Kugou`；cache hit 只在非手動歌詞與已存在逐字流不匹配時重抓並驗證可合併；YouTube 首輪缺 `word_times` 時等待既有 `source:'all'` 補抓一次，無資料安全回退；一般桌面播放器維持背景補抓不阻塞。
- RED：新增 `tests/test_youtube_lyrics_source.js` 的 LRCLIB/YouTube source-order assertion，修正前實際取得 `[]`，命令 exit 1。
- GREEN/focused：`test_youtube_lyrics_source.js`、`test_youtube_karaoke_lyrics.js`、`test_youtube_karaoke_server.js`、`test_word_times.js` PASS；`npm.cmd test` 81/81 PASS。
- Full regression：root `tests/test_*.js` 35/35 PASS；`tests/test_yt_search.py` PASS；`node --check` server/source PASS；`git diff --check` exit 0（僅既有 LF/CRLF warnings）。
- Isolated runtime bundle：重建 `C:\Users\USER\AppData\Local\Temp\kanaric-final-isolated-dist-runtime-20260909` PASS；4 個 runtime bundles syntax PASS，11-file inventory 與 vendor PASS。沒有覆寫 dirty dist、沒有 package/install/release。
- Direct Chrome / QQ network response / actual word-filled payload / microphone / audio gates：仍為 **UNVERIFIED**；自動測試不替代直接 runtime 證據。

### Final runtime matrix

- Platform：Chrome-only；Chrome version、loaded path 的 direct runtime：`UNVERIFIED`。Final source-built path 已記錄於上方，但沒有把它載入現有瀏覽器。
- Fixed extension ID：manifest key 對應 `majmclipplgfbommldfilmkmbnanjbec`；實際 Chrome loaded ID：`UNVERIFIED`。
- Kanaric dynamic port：source 仍支援非 5720 free port；App/native discovery 的實際自動 port：`UNVERIFIED`。
- Chrome lyrics options、standalone lyrics、Native Messaging handshake：`UNVERIFIED`。
- Microphone permission/device/indicator、pitch stability、pause/seek gaps、audible Key DSP：`UNVERIFIED`。
- Task 7 model/benchmark machine and legal tracks：`NOT STARTED`；Task 8：`NO-GO / NOT STARTED`。
- Pairing token：本次未讀取、未輸出、未寫入 handoff、test fixture 或 artifact。

### 6H. YouTube runtime 回報的最小 UI 修正（2026-09-09）

- 使用者回報三個現象：麥克風錯誤時沒有明確的權限引導、YouTube 歌詞看不到漢字上方的假名、歌詞層會蓋住控制面板。
- 最小修正集中在 `browser-extension/src/youtube-content.js`：保留既有 `NotAllowedError` 錯誤分類，新增 `role="alertdialog"` 的麥克風提示與重試按鈕；提示說明 Chrome 原生權限提示及網址列網站設定。原生 Chrome prompt 不能由 extension 自行樣式化，故沒有宣稱它一定會彈出。
- 歌詞 payload 與 sanitizer 已確認保留 `<ruby>/<rt>`；新增 YouTube overlay 的明確 `ruby-position`、`ruby-text`、可見性規則。控制 root、panel、permission prompt 增加高於歌詞層的 stacking/pointer-events 規則。
- RED：`youtube-controls.test.js` 新增的三項提示／ruby／stacking assertions 在修改前 6 pass、3 fail；GREEN 後 focused extension suites PASS。
- 驗證：extension full regression `83/83 PASS`；root Node regression 使用既有 `web-app/node_modules` 的 process-local `NODE_PATH` 為 `35/35 PASS`；root Python regression 使用既有 canonical venv 為 `8/8 PASS`；changed source `node --check` PASS；isolated build exit 0，11 files，產物在 `C:\Users\USER\AppData\Local\Temp\kanaric-final-isolated-dist-fix-1788955500251`，未覆寫 dirty `browser-extension/dist`。

### 6I. YouTube runtime 回報後的三項根因修正（2026-09-09）

- 使用者新增回報：網站已允許麥克風仍無法啟用、QQ 逐字歌詞未出現、Kanaric 控制按鈕必須先按載入才出現。
- 最小修正：`youtube-content.js` 在未啟動時也掛載 `.ytp-right-controls` 的按鈕並持續觀察 YouTube chrome 重建；按鈕第一次開啟面板時向 service worker 請求目前分頁 activation。控制 root 在退出 Karaoke 後保留，避免按鈕消失。
- 麥克風改由 YouTube content context 建立既有 `createMicrophonePitchController`，在同一個使用者 click task 併發 `getUserMedia` 與背景頁 claim；service worker 只驗證 owner/video/revision、轉送 frame、接收受限的 compact take 並保存，舊 `pitch_start/stop` route 保留相容性。未新增 manifest microphone permission。
- YouTube lyric cache 若 `word_times` 是空負快取，新增每個 process 每首歌一次的 `source:'all'` 重查；已有逐字流或手動歌詞不被替換。實際 QQ 網路回應與 payload 仍未宣稱已取得。
- RED：新增的 native-button、content mic claim/release、negative-word-cache assertions 在修正前各自 fail；GREEN 後 focused suites PASS。
- 驗證：extension full regression `84/84 PASS`；root Node `35/35 PASS`（既有主工作區 `web-app/node_modules` process-local `NODE_PATH`）；root Python `8/8 PASS`（既有 canonical venv）；changed source `node --check` PASS；`git diff --check` exit 0（僅既有 LF/CRLF warnings）。
- 最新 isolated build：`C:\Users\USER\AppData\Local\Temp\kanaric-final-isolated-dist-fix-1788957126713`，11 files，vendor 含 SoundTouch JS 兩支與授權檔；bundle JS syntax、manifest parse PASS。沒有覆寫 dirty `browser-extension/dist`，沒有 package/install/release。
- Task 9 只讀 Chrome observation：目前 YouTube 分頁的 accessibility tree 已看到 `Kanaric Karaoke` 與 `Toggle Livestreams Theater Mode` 同列於原生控制列，故目前載入版本的直接按鈕可見性 `PASS`；沒有證據表示該分頁已載入最新 isolated path。
- 狀態矩陣：自動化按鈕掛載／mic claim-release／空負快取重查 `PASS`；目前載入版本的 Chrome 控制列按鈕可見性 `PASS`；實際網站 mic permission/device/indicator、QQ 逐字 payload、漢字假名顯示、控制面板遮擋與音訊聽感 `UNVERIFIED`；Task 7 `NOT STARTED`；Task 8 `NO-GO / NOT STARTED`；目前沒有 `BLOCKED` 項目。不得以 automated PASS 取代上述 runtime gate。
- Chrome 目前未重新載入此 isolated dist，故麥克風 native permission、YouTube 內部層疊與假名實際畫面仍是 **UNVERIFIED**；不可把上述 automated evidence 當成 runtime PASS。

### 6J. 麥克風請求無回應的最小修正（2026-09-09）

- 直接 Chrome observation：YouTube 面板在「正在請求麥克風權限…」停留超過 14 秒，沒有 resolved/rejected 結果；這證明目前 runtime 是 pending hang，不是已取得 permission 的直接證據。
- RED：`microphone-pitch.test.js` 新增永不 resolve 的 `getUserMedia()` case，修改前因沒有 timeout 而失敗；另新增 timeout 錯誤訊息 assertion。
- GREEN：`web-app/public/js/karaoke-pitch-recorder.js` 對 `getUserMedia()` 加 10 秒 timeout；逾時或 dispose 後才晚到的 MediaStream 會立即停止，content UI 顯示「Chrome 沒有回應麥克風請求，請重新整理 YouTube 分頁後再重試」。
- 驗證：focused recorder tests PASS；extension full regression `84/84 PASS`；root Node regression `35/35 PASS`；root Python regression `8/8 PASS`；changed source 與 4 個 bundle `node --check` PASS；manifest parse PASS；`git diff --check` exit 0（僅既有 LF/CRLF warnings）。
- 最新 isolated dist：`C:\Users\USER\AppData\Local\Temp\kanaric-final-isolated-dist-mic-1788960000000`，11 files，vendor 3 files；未覆寫 dirty `browser-extension/dist`。Chrome 尚未載入此新產物，因此 native prompt、實際 device 與音高 frame 仍是 **UNVERIFIED**。

### 6K. Task 8 — isolated candidate and final acceptance matrix（2026-09-11）

- Binding brief：`.superpowers/sdd/2026-09-09-app-centered-youtube-karaoke-convergence/task-8-brief.md`，已完整閱讀；完整逐命令證據見同目錄 `task-8-report.md`。
- 結論：`PARTIAL`。extension automated suite `117/117 PASS`；指定 Node/Python regression 在既有 process-local dependency/venv 路徑下均 PASS；isolated build PASS。四個 exact-path dependency attempts 先回 `MODULE_NOT_FOUND`/venv 不存在，再以同一 checkout 已存在的 `web-app/node_modules` 與 sibling canonical venv 重跑 PASS；沒有安裝 dependency。
- Isolated output：`C:\Users\USER\AppData\Local\Temp\kanaric-app-centered-karaoke-1789059515267`；11 files；4 個 runtime bundles syntax PASS；manifest parse PASS；host permissions 只有 `https://www.youtube.com/*`、`http://127.0.0.1/*`；source/output 均無 standalone provider URL 或 symbol。
- `browser-extension\build.mjs` 的 Task 8 observed regression：原本 hardcode、`rmSync` dirty `dist`；新增 fresh-only `KANARIC_OUT_DIR` 路徑，RED→GREEN 已記錄。原本 dirty `browser-extension\dist` 的 11 個 SHA-256 與 Git status build 前後完全相同（0 mismatch），未覆寫 loaded dist。
- Chrome runtime 1–9：全部 `UNVERIFIED / required`。沒有 Chrome process、Chrome target 或已載入 isolated extension；Computer Use 只有無 tab 的 Codex In-app Browser，Edge 不代替 Chrome。故未宣稱 dormant activation、dynamic Native Messaging port、MV/lyrics ruby/逐字填色、rescue/offset、可聽 Key、mic indicator、30 秒錄音/raw-audio privacy 或 owner/service-worker lifecycle。
- 可用環境資料：source manifest key 推導固定 ID `majmclipplgfbommldfilmkmbnanjbec`；實際 loaded ID、Chrome version、loaded path、App dynamic port、microphone device 均 `UNVERIFIED`。
- 舊 `web-app/public/js/karaoke-mv.js`：保留，`NOT STARTED`。九個 direct runtime gates 未全部 PASS，不符合刪除條件；未做 cleanup。
- Key recommendation：`NOT STARTED`，待足夠 valid pitch takes 後另案規劃 confidence／insufficient-data。Vocal separation：`NOT STARTED`，只保留合法 local-file benchmark gate；本輪無下載模型、YouTube 下載、realtime separation、package/install/release。

## 7. 可重用 artifact

- Isolated extension dist：
  `C:\Users\USER\.codex\visualizations\2026\09\04\01a06b3b-5664-76e3-b6b4-d2f1a3bc10af\isolated-extension-build\dist`
- v12 ZIP：
  - size：40954 bytes
  - SHA-256：`82B436D92FF74765E163FC743122C42EE4FE2D1A2A91E5B61B82052928A5B533`
- dist inventory：11 files，無 trace artifact。
- source rebuild 與 dist `youtube-content.js` SHA-256：
  `9E9AC839034C09E94C20C68DAA11DFE50D915D7B68F12B4CC2E1D3F457656B42`

最近一次 server 曾位於 `127.0.0.1:62174`（PID 10688），此資訊會漂移，接手時必須重新確認，不能直接沿用。

## 8. 後續 gate 與授權邊界

Canonical roadmap 的 source 與 automated work 已收尾；以下不是自動宣稱完成的項目：

1. 使用者需提供可控制的既有 Chrome YouTube owner tab，才能驗證候選歌詞、standalone LRCLIB、Native Messaging 與 dynamic-port runtime。
2. 使用者需明確授權真麥克風 permission，才能驗證音名、cents、confidence、pause/seek gap、停止後 indicator 與可聽 Key DSP。
3. 若要開始 Task 7 benchmark，使用者需提供 3–5 首合法測試音檔，並先核准工具/model source、license、download size 與 disk requirement。
4. 乾淨安裝、registry、uninstall 與正式 package 仍需另行明確授權；本輪沒有 package/install/release。
5. Git commit、push、PR、tag、release 仍需另行明確授權。

## 9. 下一階段執行模板

1. Read-only inventory
   - 讀本文件、確認 Git 狀態、列出與目標直接相關的既有實作與測試。
2. Scope lock
   - 將目標、非目標、允許修改檔案、runtime 平台及驗收證據寫清楚。
3. RED
   - 以最小測試或直接 runtime reproduction 證明缺口。
4. Minimal GREEN
   - 優先重用主程式與現有 extension helper，只改負責該問題的最窄層。
5. Focused regression
   - 先跑目標測試，再跑受影響的 Phase 1R regression。
6. Runtime gate
   - 只在指定平台取得直接證據；沒有證據就維持 `ACCEPTED: NO`。
7. Handoff
   - 更新本文件的目前階段、證據、限制與下一步，移除已失效敘述。

## 10. 永久契約

- WebSocket / REST / extension message schema 變更必須保持相容或有明確 migration。
- 搜尋不到歌詞時，先追 title、artist、videoId、cache、request、response 與狀態更新路徑；不要先重寫搜尋演算法。
- 換歌、直播、離開 watch page 或空 payload 時，舊歌詞不得殘留。
- 同影片的 metadata/status replay 不得清除已載入歌詞。
- pairing secret 不進 log、test fixture、screenshot、artifact 或 handoff。
- dirty worktree 中未被本階段點名的內容一律視為使用者資料。

## 11. 重要檔案

- `browser-extension/src/youtube-content.js`
- `browser-extension/src/service-worker.js`
- `browser-extension/tests/phase1.test.js`
- `web-app/server.js`
- `web-app/youtube-karaoke-coordinator.js`
- `web-app/youtube-karaoke-lyrics.js`
- `tests/test_youtube_karaoke_lyrics.js`
- `tests/test_youtube_karaoke_server.js`
- `web-app/public/js/pitch-analysis.js`
- `web-app/public/js/karaoke-pitch-recorder.js`
- `web-app/karaoke-pitch-takes.js`
- `web-app/public/js/karaoke-pitch-history.js`

## 12. 建議 skills

- 需求仍未定義：`superpowers:brainstorming`
- 範圍確認後寫計畫：`superpowers:writing-plans`
- 新功能或 bugfix：`superpowers:test-driven-development`
- 非預期 runtime 行為：`superpowers:systematic-debugging`
- 高風險整合但要求最小改動：`caveman:lean-build`
- 宣稱完成前：`superpowers:verification-before-completion`

## 13. 下一個對話提示詞

```text
請繼續 Kanaric YouTube Karaoke Extension 的後續 runtime gate 或新階段。

專案：
C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension

先完整閱讀：
C:\Users\USER\Desktop\project\Kanaric-youtube-karaoke-extension\docs\CODEX_HANDOFF.md

目前 canonical roadmap 已完成 source/automated closure；尚未完成的是本文件 6F 列出的 `UNVERIFIED` runtime gate。

若要進行新修改，請先填：
- 階段名稱：<填寫>
- 單一目標：<填寫>
- 包含平台：<填寫>
- 明確非目標：<填寫>
- runtime gate：<填寫>

硬性邊界：
- Phase 1R 已 ACCEPTED: YES，視為凍結基線。
- 保留所有 dirty/untracked 修改。
- 不要 reset、clean、restore、stash、merge、rebase、cherry-pick、commit、push、開 PR 或 release。
- 不可讀取、輸出或修改 pairing token。
- 沒有直接 runtime 證據時維持 ACCEPTED: NO。
- 不要把未完成的 runtime gate 或 Task 7/8 `NOT STARTED` 當成已驗收；需沿用本文件的狀態與授權邊界。

若上述 scope 尚未填完整，只做 read-only inventory，然後提出一個必要的範圍問題；不要開始實作。
```
