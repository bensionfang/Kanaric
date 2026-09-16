# Kanaric 卡拉 OK 開發計畫

> **給執行工作的開發者／代理：** 每次只執行一個里程碑中的一個可驗收工作項目。開始實作前先讀本文件、`AGENTS.md` 與相關測試；完成後更新勾選狀態、驗證結果與最後完成提交。若使用 Superpowers，實作時使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。

**目標：** 在保留 Kanaric 現有桌面歌詞功能的前提下，逐步建立一套 Windows 本機日式卡拉 OK 系統，最終完成本機曲庫、自有播放器、預約佇列、手機點歌、麥克風處理、音高顯示與基礎採分。

**架構：** Music Mode 繼續監看 Spotify、Apple Music、YouTube 等外部播放器；Karaoke Mode 先完成外部播放器字幕機，再新增可替換的本機播放來源。所有 Karaoke 顯示都由同一播放時間推導，逐字填色維持單一共用實作；手機遙控使用獨立、受限的區網服務，不暴露現有桌面 API。

**技術棧：** Electron 33、Node.js、Express、WebSocket、SQLite、EJS、瀏覽器 JavaScript、Python／Windows Media API；需要低延遲音訊時再依量測決定 Web Audio、WASAPI 或原生 sidecar。

**規格：** 本文件同時是產品規格、長期 Roadmap、跨電腦協作規則與階段驗收清單。每個大型里程碑開始前，另建立一份只涵蓋該里程碑的詳細實作計畫。

## 全域限制

- 完整功能以 Windows 10／11 為目標；Music Mode 不得因 Karaoke 開發而退化。
- 現有桌面 server 維持只綁 `127.0.0.1`；在沒有真正認證前，不得改成 `0.0.0.0`。
- 不得把手機遙控直接接到含設定、備份、API key 等能力的桌面 API。
- 音訊、歌詞、MV 與音高顯示不得各自維護 authoritative time；本機播放器完成後以 Audio Clock 為唯一主時鐘。
- 外部播放器模式只允許以 `performance.now()` 做短時間 UI 內插，收到播放器位置後必須重新校時。
- `web-app/public/js/karaoke.js` 繼續作為歌詞頁、Karaoke、靈動島與行動版唯一的逐字填色實作，不得複製第四份。
- 中文譯文、羅馬字、逐字時間的既有資料管線與快取邊界不得被 Karaoke 曲庫破壞。
- 使用者手動修正的歌詞、假名、字幕偏移與 MV 選擇都屬不可任意清除的資料。
- 新功能先寫失敗測試，再做最小實作；每個工作項目必須能獨立驗收與提交。
- 不在同一個提交混入不相關重構、格式化、依賴升級或 UI 改版。
- 任何公開發版、GitHub Release、tag 或安裝檔上傳都由使用者親自確認後執行。

---

## 1. 文件使用方式

### 狀態符號

- `[x]`：已完成且有測試或人工驗證證據。
- `[ ]`：尚未完成。
- `[~]`：部分完成；必須在同一行寫清楚缺口。
- `[!]`：被阻擋；必須寫出阻擋原因與解除條件。

### 每次工作開始前

1. 執行 `git status --short --branch`，確認所在分支與未提交內容。
2. 執行 `git pull --ff-only origin main`，確認基線最新。
3. 從最新 `main` 建立單一目的的分支。
4. 在本文件的「目前進行中」登記分支、電腦與工作項目。
5. 只修改該工作項目列出的檔案；發現範圍擴大時先停止並更新計畫。

### 每次工作結束前

1. 執行工作項目的指定測試。
2. 執行 `git diff --check`。
3. 確認 `git diff --stat` 沒有無關檔案。
4. 建立清楚、單一目的的提交。
5. 推送分支，確認 GitHub 能看到提交。
6. 更新本文件中的狀態、驗證結果與最後完成提交。

---

## 2. 目前基線

**基準日期：** 2026-08-24

**基準提交：** `3f2ff92`

**目前定位：** 可實際使用的外部播放器日 K 字幕機，尚不是自有音訊引擎的 Karaoke 主機。

### 已完成

- [x] `/karaoke` 獨立頁面與全螢幕演唱模式。
- [x] JOYSOUND 風格上下雙槽字幕。
- [x] 長句共同縮小字級，維持上下兩句一致。
- [x] QQ QRC 逐字時間跨來源對齊。
- [x] 漢字與假名同步逐字填色。
- [x] 無逐字資料時退回整行高亮，不猜平均字速。
- [x] 前奏與長間奏倒數。
- [x] 曲名、歌手與製作資訊顯示。
- [x] 重唱、播放／暫停、下一首與退出控制。
- [x] 逐首字幕偏移、快捷鍵、延遲儲存與跨頁同步。
- [x] YouTube MV 自動搜尋、手動選擇、取消與逐首記憶。
- [x] MV 偏移調整與定期重新同步。
- [x] 控制列可拆成同一台電腦上的獨立小視窗。
- [x] `test_karaoke_mode.js`、`test_offset_sync.js`、`test_word_times.js`、`test_lrc_time.js` 通過。
- [x] `/karaoke` 介紹頁可啟動，瀏覽器 console 無 warning／error。

### 尚未完成

- [ ] 自有本機歌曲播放器與 Audio Master Clock。
- [ ] Karaoke 曲庫與本機媒體匯入。
- [ ] Karaoke Session、預約佇列與演唱者管理。
- [ ] 手機 QR 配對與區網點歌。
- [ ] 自動依 Queue 播放下一首。
- [ ] Key Shift、Tempo 與不變調處理。
- [ ] 麥克風低延遲監聽與效果器。
- [ ] 主旋律資料、即時音高線與採分。

### 現有時間模型的限制

目前位置仍來自外部播放器：

```text
Spotify／YouTube／Apple Music
        ↓
Windows Media API
        ↓
media_monitor.py 內插
        ↓
Node 每秒位置廣播
        ↓
Karaoke 前端短時間內插與校正
```

這個模式適合字幕機，但不能宣稱系統誤差小於 ±50ms。現階段驗收要區分：

- **固定偏移：** 由逐首字幕 offset 修正。
- **歌詞來源誤差：** 不算系統 drift，但必須能手動修正或換來源。
- **系統 drift：** 偏差隨播放時間持續增加；這是失敗。
- **MV 誤差：** YouTube IFrame 目前以 0.5 秒作為重新 seek 門檻，不能當成精密同步證據。

---

## 3. 目標架構

```text
                              KANARIC
                                 │
                 ┌───────────────┴───────────────┐
                 │                               │
             Music Mode                     Karaoke Mode
                 │                               │
       ExternalMediaAdapter           ┌──────────┴──────────┐
       Windows Media API              │                     │
                                      │                     │
                            ExternalMediaAdapter     LocalAudioAdapter
                                      │                     │
                                      └──────────┬──────────┘
                                                 │
                                          PlaybackClock
                                                 │
                         ┌───────────────────────┼──────────────────────┐
                         │                       │                      │
                      Lyrics                    MV                  Pitch Guide
                         │                       │                      │
                         └───────────────────────┴──────────┬───────────┘
                                                           │
                                                   Karaoke Session
                                                           │
                                       ┌───────────────────┴──────────────────┐
                                       │                                      │
                                  Local Queue                         Paired Remote Server
                                                                              │
                                                                         Phone Remote
```

### 必要介面

每個播放來源最後都必須符合相同概念介面：

```js
PlaybackAdapter = {
  kind: 'external' | 'local',
  getTrack(): { id, title, artist, durationSec } | null,
  getPositionSec(): number,
  isPlaying(): boolean,
  play(): Promise<void>,
  pause(): Promise<void>,
  seek(positionSec): Promise<void>,
  next(): Promise<void>
}
```

顯示端只讀取 adapter，不得知道位置來自 Windows Media API 或 `<audio>`。本機模式的 `getPositionSec()` 必須直接取 Audio Engine 的 media position，不得使用 `position += deltaTime` 當真正時間。

---

## 4. 里程碑總覽

| 里程碑 | 交付成果 | 狀態 | 進入下一階段條件 |
|---|---|---|---|
| v0.5 | 外部播放器 Karaoke 字幕機穩定化 | 進行中 | 長歌、seek、暫停、切歌與降級測試通過 |
| v0.6 | 本機 Session 與人工預約清單 | 尚未開始 | 能完成建立 Session → 排隊 → 演唱 → 完成 |
| v0.7 | 安全的手機點歌 | 尚未開始 | QR 配對、權限隔離與攻擊面測試通過 |
| v1.0 | 本機曲庫、自有播放器、Master Audio Clock | 尚未開始 | 不開 Spotify 也能完整唱完多首歌 |
| v1.1 | Queue 自動播放與 Session 收尾 | 尚未開始 | Queue 可無人工搜尋連續播放 |
| v1.2 | Key／Tempo | 尚未開始 | 時間軸不漂、音質與 CPU 驗收通過 |
| v1.5 | 麥克風監聽與效果 | 尚未開始 | 可接受延遲、穩定性與回授保護通過 |
| v2.0 | 音高線與基礎採分 | 尚未開始 | 參考旋律、即時 F0 與可解釋分數完成 |

---

## 5. v0.5：字幕機穩定化

### 目標

把目前功能從「已能使用」提升成「可作為後續引擎的穩定顯示層」。本階段不新增播放器、Queue、Mic 或採分。

### 工作項目

#### K05-1：進場 Ready Check

**修改：**

- `web-app/views/karaoke.ejs`
- `web-app/public/js/karaoke-mode.js`
- `web-app/public/css/style.css`
- `tests/test_karaoke_mode.js`

**畫面必須顯示：**

- 播放來源與目前歌曲。
- 是否有同步歌詞。
- 是否有完整逐字資料。
- MV 狀態。
- 目前字幕偏移。
- 無法開始的明確原因。

**驗收：**

- 無播放來源時「開始」不可造成空白全螢幕。
- 有歌但無歌詞時可進入降級畫面，且能直接開備選歌詞。
- Ready Check 在 1280×720 不需捲動即可看到主要開始按鈕。

#### K05-2：抽出可測試的外部播放時鐘校正

**建立：**

- `web-app/public/js/karaoke-clock.js`
- `tests/test_karaoke_clock.js`

**修改：**

- `web-app/public/js/karaoke-mode.js`
- `web-app/views/karaoke.ejs`

**介面：**

```js
createExternalClock(initialState)
clock.applyMediaState({ position, is_playing, title })
clock.positionAt(performanceNowMs)
clock.reset(positionSec)
```

**測試情境：**

- 正常播放的一秒廣播間隔。
- 暫停 30 秒後位置不前進。
- 小幅位置修正不倒退抖動。
- seek 超過 1.5 秒時立即硬對齊。
- 切歌時不得沿用上一首位置。
- `performance.now()` 倒退或跳躍時不產生負值。

#### K05-3：完整人工 Timing QA

**測試歌曲：** 至少一首 5 分鐘日文歌，必須同時具備逐字時間與長間奏。

**驗收步驟：**

1. 在 0:30、2:30、4:30 記錄音訊與填色偏差。
2. 暫停 30 秒再繼續，偏差不得因暫停時間增加。
3. 隨機 seek 20 次，字幕必須在下一次 server 校時後重新鎖定。
4. 從頭重唱 5 次，第一句進場位置必須一致。
5. 快速切歌 20 次，不得出現上一首歌詞、offset 或 MV。
6. 無逐字歌詞必須整行高亮，不得生成假逐字掃光。

**通過標準：**

- 不出現持續累積 drift。
- 外部播放器模式 seek 後 1.2 秒內重新鎖定。
- 固定歌詞偏移可用 100ms 級距修正並永久保存。
- MV 誤差維持現行約 ±0.5 秒等級；本階段不把它提高成音訊級精度。

### 自動驗證

```powershell
node tests/test_karaoke_mode.js
node tests/test_karaoke_clock.js
node tests/test_offset_sync.js
node tests/test_word_times.js
node tests/test_lrc_time.js
node tests/test_origin_guard.js
```

### 停止條件

Ready Check、時鐘單元測試與一次完整人工 Timing QA 通過後停止，不在本階段加入 Queue 或重寫播放器。

---

## 6. v0.6：Session 與人工預約清單

### 目標

建立「正在唱／下一首／已完成」的 Karaoke Session。因為聲音仍由外部播放器提供，本階段的 Queue 是可操作的預約板，不承諾自動搜尋並播放任意歌曲。

### 建議檔案邊界

- 建立 `web-app/karaoke-session.js`：Session 與 Queue 規則，不依賴 Express。
- 建立 `web-app/public/js/karaoke-session.js`：Karaoke 頁面的 Session UI。
- 建立 `tests/test_karaoke_session.js`：狀態機與排序測試。
- 修改 `web-app/server.js`：只負責路由、DB 呼叫與 WebSocket 廣播。
- 修改 `web-app/views/karaoke.ejs`：待機、Queue 與演唱者 UI。

### 資料模型

```text
karaoke_sessions
  id, status, started_at, ended_at

karaoke_queue
  id, session_id, title, artist, requested_by,
  key_shift, state, ordinal, created_at, completed_at
```

`state` 只能是 `queued`、`singing`、`completed`、`skipped`。同一 Session 最多一筆 `singing`。

### 工作項目

- [ ] K06-1：建立 Session、結束 Session 與 crash recovery 測試。
- [ ] K06-2：新增、刪除、插播、重排 Queue。
- [ ] K06-3：將 Queue 第一首標成正在唱，完成後移到歷史。
- [ ] K06-4：顯示演唱者、下一首與預約首數。
- [ ] K06-5：切歌時不把外部播放器的未知歌曲錯誤標成 Queue 完成。
- [ ] K06-6：Session 結束後保留歷史，但清空 runtime 狀態。

### 驗收

- 建立 Session → 加入三首 → 插播第四首 → 跳過一首 → 完成 Session 全流程可重現。
- server 重啟後未完成 Queue 可恢復。
- Queue 變更透過 WebSocket 即時同步，不靠高頻輪詢。
- DB 錯誤時不丟失畫面上已有的 Queue，並顯示可操作的錯誤。
- 不修改 Music Mode 的 listening history 規則。

### 停止條件

桌面上能完成一次完整人工 Session 即停止；自動播放與手機點歌分別留給 v1.1 與 v0.7。

---

## 7. v0.7：安全手機點歌

### 目標

手機掃 QR 後只能操作當前 Karaoke Session 與 Queue，不能存取桌面設定、備份、歌詞編輯、API key 或資料庫管理功能。

### 安全架構

不要把現有 Express app 直接改綁區網。建立獨立受限服務：

```text
Desktop API
127.0.0.1:5720
完整功能，不對區網開放

Paired Remote Server
選定的 LAN 位址:隨機 port
只提供 remote shell、配對、Queue 與最小播放控制
```

### 建議檔案邊界

- 建立 `web-app/karaoke-remote-server.js`：獨立 listener 與路由白名單。
- 建立 `web-app/karaoke-pairing.js`：配對碼、token、到期與撤銷。
- 建立 `web-app/public/karaoke-remote/`：手機專用 shell。
- 建立 `tests/test_karaoke_pairing.js`。
- 建立 `tests/test_karaoke_remote_guard.js`。
- 修改 `web-app/electron.js`：啟停 remote server 與顯示 QR。

### 配對規則

- 每次 Session 產生至少 128-bit 隨機 token。
- QR 只包含 LAN URL 與一次性配對資訊。
- 成功配對後換發 Session-scoped token。
- Session 結束、使用者撤銷或超時後 token 立即失效。
- token 不寫入 Git、不出現在 server log、不放進查詢字串的長期歷史。
- Remote server 預設關閉，使用者明確啟用後才監聽區網。

### Remote API 白名單

- 讀取目前 Session 與 Queue。
- 搜尋 Kanaric 已知歌曲。
- 新增、刪除自己預約的歌曲。
- 主持人權限可插播、重排、跳過與停止。
- 不提供 `/api/settings`、`/api/restore`、`/api/db-clear`、`/api/llm-*` 或任意代理請求。

### 驗收

- 未配對手機得到 401／403，不能讀取 Queue。
- 一般使用者不能刪除別人的預約。
- 主持人 token 與一般 token 權限分離。
- Session 結束後舊 token 無法再次使用。
- 惡意 Origin、錯誤 Host、DNS rebinding 形狀與 WebSocket upgrade 都被擋。
- 關閉 Remote 後 LAN port 不再監聽，桌面 app 照常工作。
- 同一區網兩支手機可同時預約，排序一致。

### 停止條件

只交付搜尋、Queue 與最小播放控制；手機歌詞、聊天、帳號、雲端同步與社交功能不進本階段。

---

## 8. v1.0：本機曲庫與自有播放器

### 目標

關閉 Spotify、Apple Music 與 YouTube Music 後，Kanaric 仍能從本機曲庫選歌、播放音訊、顯示字幕、同步 MV 並唱完整首歌。

### 第一版範圍

- 使用者自行提供合法取得的本機音訊檔。
- 支援 MP3、M4A、WAV、FLAC；實際格式以 Electron／Chromium 解碼能力驗證為準。
- 匯入歌曲 metadata、封面與既有歌詞關聯。
- LocalAudioAdapter 與 ExternalMediaAdapter 共用 PlaybackAdapter 介面。
- 本機模式以音訊元素的 media position 作為 Master Clock。
- 暫不做 Key Shift、Tempo、Mic、採分與自動拆伴奏。

### 建議檔案邊界

- 建立 `web-app/karaoke-library.js`：曲庫資料與檔案驗證。
- 建立 `web-app/public/js/karaoke-player.js`：LocalAudioAdapter。
- 建立 `web-app/public/js/playback-adapter.js`：共用介面與來源切換。
- 建立 `tests/test_karaoke_library.js`。
- 建立 `tests/test_playback_adapter.js`。
- 修改 `web-app/electron.js` 與 preload：安全檔案選擇與媒體路徑橋接。
- 修改 `web-app/server.js`：曲庫 API 與 local media state 廣播。
- 修改 `web-app/views/karaoke.ejs`：曲庫與來源選擇。

### 曲庫資料模型

```text
karaoke_tracks
  id, title, artist, album, duration_sec,
  audio_path, cover_path, lyrics_artist, lyrics_title,
  created_at, updated_at, missing
```

- DB 儲存使用者選擇的絕對路徑，不把媒體檔複製進 Git repo。
- 啟動時不掃描整顆硬碟；只驗證已登記路徑。
- 找不到檔案時標記 `missing`，不得自動刪除曲庫資料。

### Master Clock 規則

```text
MasterTime = audio.currentTime
LyricsTime = MasterTime + SongLyricsOffset + DisplayCompensation
VideoTime  = MasterTime + SongVideoOffset
```

- rAF 只負責每幀讀取 `audio.currentTime` 並繪製。
- Pause 時 `audio.currentTime` 不變，所有顯示自然凍結。
- Seek 後下一個 render frame 必須從新 position 重新推導畫面。
- 不允許歌詞 renderer 從第一行逐步跑狀態；任意時間點都必須可直接算出上下槽與填色。

### 工作項目

- [ ] K10-1：曲庫 schema、匯入、遺失檔案與重連測試。
- [ ] K10-2：PlaybackAdapter contract 與 ExternalMediaAdapter 包裝。
- [ ] K10-3：LocalAudioAdapter 的 play、pause、seek、duration、ended。
- [ ] K10-4：Karaoke 顯示改讀 PlaybackAdapter，不直接讀外部 `pos`。
- [ ] K10-5：本機歌曲與現有歌詞、offset、MV 選擇建立穩定鍵值。
- [ ] K10-6：播放結束事件與手動下一首。
- [ ] K10-7：打包版媒體權限、路徑與安裝後驗證。

### Timing 驗收

- 五分鐘歌曲在 0:30、2:30、4:30 不出現累積 drift。
- 系統自身歌詞時間誤差目標小於 ±50ms；歌詞來源標註誤差另計。
- Pause 30 秒後 Resume，偏差不得增加。
- 隨機 seek 20 次，下一幀字幕與逐字位置正確。
- Restart 20 次，第一句觸發位置一致。
- 連播 20 首，第 20 首不比第 1 首更不準。
- 音訊裝置切換失敗時停止播放並顯示錯誤，不讓字幕繼續跑。

### 停止條件

能只靠使用者本機音訊完成「選歌 → 播放 → 唱完 → 下一首」後停止。不得在此階段加入 DSP 或採分。

---

## 9. v1.1：Queue 自動播放

### 目標

把 v0.6 的人工預約板接到 v1.0 本機曲庫，形成完整的自動 Session。

### 工作項目

- [ ] Queue item 必須關聯有效 `karaoke_tracks.id`。
- [ ] 開始 Session 時自動載入 Queue 第一首。
- [ ] 歌曲 ended 後顯示短暫過場，再播放下一首。
- [ ] 插播只改下一首，不中斷正在演唱的歌曲。
- [ ] 跳過會記錄原因並前進，不刪除歷史。
- [ ] 遺失或無法解碼的媒體自動標成 failed，繼續下一首。
- [ ] Queue 清空時進入待機畫面，不重播最後一首。

### 驗收

- 預約五首後可以不碰外部播放器連續唱完。
- 第三首損壞時顯示錯誤並繼續第四首。
- Session 中途重啟 app 後可詢問使用者是否恢復。
- 手機與桌面顯示的 Queue 順序、目前歌曲與狀態一致。

---

## 10. v1.2：Key Shift 與 Tempo

### 原則

- Key Shift 不得改變 media timeline。
- Tempo 改變真實經過時間，但 lyrics 仍查詢原始 media timeline position。
- 在選擇原生引擎前先量測 Chromium／Web Audio 的音質、延遲、CPU 與穩定性。

### 交付順序

1. Key Shift 離線或非即時原型，確認音質。
2. 即時 Key Shift，保留原始 position。
3. Tempo 0.8×–1.2× 且不變調。
4. Queue 逐首儲存 key／tempo 偏好。
5. 若 Web Audio 無法通過驗收，再建立 native sidecar；不預先導入 Rust/C++。

### 驗收

- Key -6 到 +6 半音，字幕與 MV 時間不變。
- Tempo 0.8×、1.0×、1.2× 各播放五分鐘，不出現累積 drift。
- 一般目標機器 CPU 長時間穩定，不發生可聽見爆音。
- 切歌、seek、pause 後效果參數與 position 正確。

---

## 11. v1.5：麥克風與 DSP

### 目標

提供適合家庭 Karaoke 的低延遲監聽。評分分析吃 Dry Mic，使用者聽到 Processed Mic。

```text
Mic Input
   ├── Dry → Pitch Analysis（v2.0）
   └── Gain → HPF → Gate → EQ → Compressor → Reverb → Output
```

### 實作前量測

- 列出 WASAPI 輸入／輸出裝置。
- 量測 input、processing、output 與 round-trip latency。
- 測試 Web Audio 能否在目標機器連續運作 30 分鐘。
- 記錄 buffer size、sample rate、dropout 次數與 CPU。
- 只有無法達成驗收時才批准 native sidecar。

### 第一版範圍

- 單一麥克風。
- WASAPI shared mode 優先。
- Gain、HPF、Noise Gate、簡單 EQ、Compressor、Reverb。
- Mic mute 與裝置失效保護。
- 顯示／輸入 latency 各自校正；Mic latency 不得拿去改歌詞時間。

### 驗收

- 目標機器 round-trip latency 以低於 40ms 為通過目標；未達成時必須顯示實測值，不能假裝低延遲。
- 連續使用 30 分鐘無累積延遲、無崩潰、無持續爆音。
- 拔除麥克風後立即靜音並顯示錯誤，不產生尖銳輸出。
- Pitch 分析支線取得效果器前的 Dry Mic。
- 所有效果都有安全預設值與總 bypass。

### 延後項目

- ASIO。
- 雙麥克風與玩家 A／B 分離。
- 自動防回授模型。
- AI 降噪與伴奏洩漏分離。

---

## 12. v2.0：音高線與基礎採分

### 先制定 Melody Format

```json
{
  "version": 1,
  "trackId": "local-track-id",
  "offsetMs": 0,
  "notes": [
    { "startMs": 23450, "endMs": 23920, "midi": 67, "lyric": "きょ" },
    { "startMs": 23920, "endMs": 24310, "midi": 69, "lyric": "う" }
  ]
}
```

- 一個歌詞字元不等於一個音符。
- 漢字、ruby、mora 與 note 必須允許一對多／多對一。
- Key Shift 只平移 reference MIDI，不改時間。
- Melody 與 Lyrics 分開儲存與編輯。

### 交付順序

- [ ] K20-1：Melody Format schema、parser、validation 與版本測試。
- [ ] K20-2：匯入使用者提供的 MIDI／JSON，不做自動轉錄。
- [ ] K20-3：只畫 reference pitch guide，不接麥克風。
- [ ] K20-4：從 Dry Mic 產生時間戳記 F0 curve。
- [ ] K20-5：顯示即時演唱音高，不先計總分。
- [ ] K20-6：實作音準、節奏、長音、穩定度四個可解釋分項。
- [ ] K20-7：建立結果頁、原始數據與測試樣本。

### 基礎分數原則

- 每個分項可追溯到明確量測，不使用神祕 AI bonus。
- 無聲、雜音、八度錯誤與未演唱區段有明確規則。
- 先以合成音與固定測試錄音校驗，再做真人測試。
- 不宣稱與 DAM／JOYSOUND 分數等價。

### 驗收

- 合成正確音高得到穩定高分。
- 固定偏離 50、100 cents 的測試樣本呈單調降分。
- 提早／延後的測試樣本只影響節奏相關項目。
- Key Shift 後 reference 與顯示同步平移。
- 同一錄音重跑的總分差異在可接受浮點誤差內。

---

## 13. 明確不做的事

以下項目不是目前 Roadmap，除非先修改本文件並說明理由：

- 不複製 DAM／JOYSOUND 的品牌、素材、專有畫面或私有採分公式。
- 不承諾同一演唱在 DAM 得幾分，Kanaric 就得到相同分數。
- 不提供未授權歌曲、伴奏、MV 或大型公開曲庫下載。
- 不自動下載 YouTube 音訊或繞過平台限制。
- v1.0 不做自動 stem separation、AI 伴奏、人聲移除或 melody transcription。
- v1.0 不做 Key Shift、Tempo、Mic 或 Scoring。
- v1.5 不做雙麥克風、ASIO 與商用等級 feedback suppression。
- v2.0 不做 AI 感性、しゃくり、こぶし、フォール與複雜 vibrato 評分。
- 不為逐字填色新增使用者開關；有可靠逐字資料就使用，沒有就整行高亮。
- 不把逐字、ruby 或 Karaoke renderer 複製到每個端各維護一份。
- 不為手機點歌開放完整桌面 API。
- 不把現有 server 直接改綁 `0.0.0.0`。
- 不做帳號社交、公開排行榜、聊天室與雲端歌曲同步。
- 不在 Karaoke 開發中順便更換日文 tokenizer、加入離線辭典或改寫整個歌詞來源系統。
- 不做 Steam 式強制更新；維持現有打包版自動更新與純 Node 手動提醒兩條路。

---

## 14. 兩台電腦的 GitHub 協作流程

### 核心規則

1. `main` 只接收已驗證工作；不在兩台電腦直接同時修改 `main`。
2. 一個分支只做一個工作項目，例如 `K05-1`。
3. 同一時間不要讓兩台電腦修改同一分支與同一批檔案。
4. 換電腦前一定 commit 並 push；到另一台先 fetch／pull 再開始。
5. 透過 GitHub Pull Request 合併，不 force-push `main`。
6. `settings.json`、`lyrics_data.db`、本機媒體、API key、`release/` 與 build 產物不進 Git。
7. `package.json`／`package-lock.json` 的依賴修改由同一台電腦在同一分支完成。

### 分支命名

```text
karaoke/v05-ready-check
karaoke/v05-clock
karaoke/v06-session
karaoke/v07-pairing
karaoke/v10-player
```

### 電腦 A：開始新工作

```powershell
git switch main
git pull --ff-only origin main
git switch -c karaoke/v05-ready-check
git status --short --branch
```

完成一個可驗收單位後：

```powershell
git add web-app/views/karaoke.ejs web-app/public/js/karaoke-mode.js web-app/public/css/style.css tests/test_karaoke_mode.js 卡拉OK開發計畫.md
git commit -m "feat(karaoke): add readiness check"
git push -u origin karaoke/v05-ready-check
```

### 電腦 B：接續同一分支

只有電腦 A 已 push 且停止修改時才這樣做：

```powershell
git fetch origin
git switch --track origin/karaoke/v05-ready-check
git status --short --branch
```

若電腦 B 已經有該分支：

```powershell
git switch karaoke/v05-ready-check
git pull --rebase origin karaoke/v05-ready-check
```

完成後同樣 commit 與 push。回到電腦 A 前，先確定 B 已完成 push。

### 兩台電腦平行開發

平行工作必須使用不同分支與低重疊檔案，例如：

| 電腦 | 分支 | 工作 | 主要檔案 |
|---|---|---|---|
| A | `karaoke/v05-clock` | 時鐘抽取與測試 | `karaoke-clock.js`、`test_karaoke_clock.js` |
| B | `karaoke/v05-ready-check` | 進場狀態 UI | `karaoke.ejs`、`style.css` |

如果兩個工作都需要大量修改 `karaoke-mode.js`，不要平行，依序完成。

### Pull Request 合併

1. GitHub 建立 PR，base 選 `main`。
2. 確認 PR 只包含一個工作項目。
3. 貼上執行過的測試與人工驗證結果。
4. 先更新分支再解衝突，不直接在 GitHub 隨意選「ours／theirs」。
5. 合併後兩台電腦都執行：

```powershell
git switch main
git pull --ff-only origin main
```

6. 確認新 HEAD 一致後再建立下一個分支。

### 發生分岔時

先停下來蒐集證據：

```powershell
git status --short --branch
git fetch origin
git rev-list --left-right --count HEAD...origin/main
git log --oneline --decorate --graph --max-count=24 --all
git cherry -v origin/main HEAD
```

- 不要立刻使用 `git reset --hard`。
- 不要在不清楚提交是否已進遠端時 force-push。
- `git cherry` 顯示 `-` 代表等價 patch 已存在遠端，可考慮安全 rebase。
- `git cherry` 顯示 `+` 代表本機仍有遠端沒有的內容，先建立備份分支再處理。

### 建議的工作分配

- **電腦 A：** backend、DB、播放器、媒體與自動測試。
- **電腦 B：** Karaoke UI、Remote UI、人工 Timing QA、文件與 PR 檢查。
- 若同一人輪流使用兩台電腦，以「一個工作項目只在一台電腦完成」為優先，減少交接成本。

---

## 15. 驗證矩陣

| 類別 | 必跑驗證 |
|---|---|
| Karaoke 雙槽／倒數／字級 | `node tests/test_karaoke_mode.js` |
| 外部時鐘校正 | `node tests/test_karaoke_clock.js`（K05-2 建立後） |
| 字幕偏移同步 | `node tests/test_offset_sync.js` |
| 逐字跨來源對齊 | `node tests/test_word_times.js` |
| LRC 時間解析 | `node tests/test_lrc_time.js` |
| 同源與 Remote 安全 | `node tests/test_origin_guard.js`、K07 新測試 |
| Session／Queue | `node tests/test_karaoke_session.js`（K06 建立後） |
| 曲庫／Player | K10 新測試 + 實際音訊 E2E |
| Python 媒體來源 | `venv/Scripts/python.exe tests/test_pick_session.py` |
| 打包版 | `cd web-app; npm run dist`，只在里程碑候選版執行 |

### 每個里程碑的最低完成證據

- 測試命令與完整 PASS 結果。
- 一項人工端到端流程。
- `git diff --check` 通過。
- 沒有無關檔案或使用者資料進入提交。
- 本文件狀態與最後完成提交已更新。

---

## 16. 目前進行中

| 欄位 | 內容 |
|---|---|
| 目前里程碑 | v0.5 字幕機穩定化 |
| 下一個工作 | K05-1 進場 Ready Check |
| 工作分支 | 尚未建立 |
| 使用電腦 | 尚未指定 |
| 負責者 | 專案擁有者 |
| 開始提交 | `3f2ff92` |
| 最後完成提交 | `3f2ff92` |
| 驗證狀態 | 現有四組 Karaoke 相關測試通過；完整歌曲 E2E 尚未記錄 |

## 17. 決策紀錄

| 日期 | 決策 | 理由 |
|---|---|---|
| 2026-08-24 | 先完成字幕機穩定化，再做 Session | 現有 Presentation 已成熟，先建立可靠基線 |
| 2026-08-24 | Session Queue 第一版採人工預約板 | 外部播放器無法保證依歌名自動播放任意歌曲 |
| 2026-08-24 | 手機遙控使用獨立受限 LAN server | 現有桌面 API 無認證，不可直接對區網開放 |
| 2026-08-24 | v1.0 先用可替換 PlaybackAdapter | 保留 Music Mode，避免一次重寫全部播放管線 |
| 2026-08-24 | Audio Clock 是本機 Karaoke 唯一主時鐘 | 消除長時間累積 drift，簡化 seek／pause／tempo |
| 2026-08-24 | Mic 與 Scoring 分階段 | Dry Mic、Processed Mic、Pitch 與評分是不同責任 |
| 2026-08-24 | 不先決定 Rust／C++ sidecar | 先量測 Web Audio／WASAPI，只有不達標才增加複雜度 |

---

## 18. 下一步

下一次開發只處理 **K05-1：進場 Ready Check**。完成、驗證、提交並合併後，再開始 K05-2。不得同時啟動 v0.6、手機 Remote 或自有播放器。
