# Kanaric 開發路線圖

v1.0.0 之後的規劃。這份是**方向與理由**的紀錄，不是承諾的時程。

## 定位

**給朋友／小圈子用**，不追求規模。所有資料留在使用者自己的電腦上，沒有帳號、沒有雲端、沒有遙測。

產品目前把「**把正在播的日文歌，帶假名地顯示出來**」做完了。下一段的價值不在把同一件事做得更準（假名準確度的天花板已經量測過，見〈明確不做〉），而在**從「讀得出來」跨到「看得懂、記得住」**。

---

## 階段 1：交付基礎建設 — ✅ 已完成

給別人用之前的最低責任。

- **自動更新**（`electron-updater` + GitHub provider）。取代原本「跳吐司叫你自己去下載」。
  發版時 `latest.yml` **必須**跟 exe 一起上傳，否則更新抓不到。
- **資料備份／還原**。單一 `.db` 檔（`VACUUM INTO` 快照 + `_backup_meta` 表夾帶 `settings.json`），
  不引入 zip 函式庫。API key 刻意不進備份。還原前會留救援檔。
- **年度回顧接回導覽**。`/wrapped` 本來就完整，只是沒有入口；順手補了空資料庫的空狀態與離開按鈕。
- **移除 `/api/export-playlist`**。產出的 m3u 指向不存在的 `.mp3`，無法使用，且零呼叫者。

---

## 階段 2：看得懂（學日文，最高優先）

### 2a. 翻譯歌詞

**資料早就抓回來了，只是被丟掉**——這是整份路線圖裡投報率最高的一項：

| 來源 | 翻譯在哪 | 現況 |
|---|---|---|
| 網易雲 | 回應的 `tlyric` | 請求已帶 `tv=-1`，回應整份丟掉（`cn_music.py:128`） |
| Kugou | krc `language` 軌 `type=1` | 只讀 `type=0`（羅馬字）（`cn_music.py:224`） |
| QQ | 另一條翻譯軌 | 程式碼註解已預期它存在（`cn_music.py:254`） |

- 存放跟現成慣例走：新表 `lyrics_translations (artist, title, data)`，與 `romaji_hints`／`llm_hints` 同形。
  **不要往 `cache` 加欄**——那張表有四個讀取點都要過簡轉繁，動它成本最高。
  建表要同時寫 `server.js` 與 `db.py` 兩邊。
- **翻譯一定要過 `s2t.js` 的簡轉繁**：網易給的是簡體。翻譯是純中文、沒有假名，
  正好落在 `toTraditional()` 現有假名分界規則的「該轉」那一側，不需要改 `s2t.js`。
- 顯示：原文下方一行灰色譯文，設定選單加 `show_translation` 開關。
  靈動島先不做（一行變兩行會把島撐胖，等階段 4 的展開模式）。

### 2b. 點詞查義（線上查，不打包辭典）

- **點擊單位已經現成**：`furigana_inject.py` 產生的 `ruby.editable-ruby[data-orig]` 就是一個詞素，
  正是 `word_corrections` 的主鍵單位。
- **但純假名詞現在沒有外框**（只有含漢字的詞才包 ruby），所以 `build_ruby_html` 要把純假名詞素
  也包成 `<span class="word" data-orig=...>`。這會動到假名管線，`test_furigana_hint.py` 要跟著擴充。
- **順便輸出 `data-lemma`**：fugashi 的 token 有辭書形，用辭書形查字典命中率遠高於活用形。
- 互動：`app.js` 的歌詞點擊是乾淨的模式鏈（`isRubyEditMode` → `isLoopMode` → seek），加第三個分支。
  工具列按鈕與快捷鍵**必須註冊進 `TOOLBAR_HOTKEYS` 與 `TOOLBAR_TOOLS`**，那兩張表是單一真相源。
- 後端：`GET /api/dict/lookup?word=` 代理 Jisho（免 key），結果進新表 `dict_cache`。
  快取同時解掉延遲與隱私兩個缺點——同一個詞只外流一次。
- **隱私揭露**：照抄 LLM 小節那行的寫法，寫明查詞會把該詞送到外部服務。

### 2c. 生詞本 + Anki 匯出

- 新表 `vocab (word, reading, meaning, artist, title, added_at)`。
- 匯出 **TSV** 就夠 Anki 匯入，不要為了 `.apkg` 引入函式庫。
- 生詞本屬於「使用者親手建立的資料」：要進備份，且**排除在 `CLEAR_TARGETS` 之外**。

---

## 階段 3：統計玩法

- **年度回顧升級**：三支 stats API 目前都是全時段，加 `range` 參數支援年／月切換，
  前端沿用排行榜既有的「統計時間」下拉樣式。
- **聽歌熱力圖**：GitHub 貢獻圖風格的日曆。`listening_history` 有 timestamp，
  一支 GROUP BY date 的 API 加一段前端就夠。
- **CSV 匯出**：把聽歌紀錄倒出來給人看，跟階段 1 的整庫備份是兩件事（一個給人讀，一個給程式還原）。

---

## 階段 4：靈動島進化

- **滑鼠移上去顯示播放控制**：`/api/media-control`、`/api/seek` 都已存在，島目前是純顯示端。
  **注意 `island.ejs` 的 mousedown 會啟動拖曳**，按鈕要在那個 handler 裡用
  `e.target.closest('button')` 排除，否則按不下去。
- **多螢幕位置記憶**：現在 `island_x/island_y` 只有單一組座標，換螢幕靠 `clampToScreen` 硬拉回來。
  改成以 `display.id` 為鍵的位置表，找不到才 fallback 到現有邏輯。
- **展開模式**：多行＋進度條。視窗尺寸本來就由頁面量完內容回報（`island:resize`），
  所以主要是 CSS 加一個模式旗標，不用維護尺寸對照表。

---

## 階段 5：逐字卡拉OK（最後做）

抓資料是免費的，**難的是對齊**：

- `cn_music.py` 目前用 `re.sub(r'<[^>]*>', '', ...)` 把 krc 的逐字時間標記洗掉；QRC 也是同樣形狀。
  保留它們只是「不要洗」。
- 真正的工程在於：逐字時間是對著**原始字元**的，而畫面上的 HTML 是 `furigana_inject.py` 重組過的 ruby。
  要讓 `build_ruby_html` 對每個詞素多輸出字元起點與長度（`data-cs`／`data-clen`），
  **照抄現有 `data-hs`／`data-hlen` 的做法**——那組屬性正是為了處理送假名拆成多顆 ruby 而存在的，
  同一個問題的同一種解法。
- 五個來源只有兩個有逐字資料，必須能乾淨地退回行級高亮。
- 島要同步的話，等階段 4 的展開模式做完再接。

---

## 明確不做（以及為什麼）

- **雲端同步／帳號／多裝置** — 與現在「只綁 `127.0.0.1` + 同源守門」的安全模型直接衝突。
  沒有真正的 auth 之前，把 bind 放寬等於自己拆牆。
- **社群功能／公開排行榜** — 需要伺服器與個資，跟「純本機、無遙測」的定位相反。
- **換 tokenizer 或辭典來提升假名準確度** — 已量測：full unidic（775 MB）與 unidic-lite
  在 48 個詞上**逐字相同**，Sudachi 與 ipadic 更差。有效的槓桿是更好的來源資料與 LLM 消歧，不是換字典。
- **離線日文辭典** — 會讓安裝檔再長 60～100 MB。線上查 + 本地快取已經夠用。
- **macOS** — 要換掉整套 winrt 媒體偵測。小圈子定位下投入產出比太差。
- **程式碼簽章** — 一年幾千塊只為了讓 SmartScreen 安靜。README 說明就夠。

---

## 建議順序與規模感

| 順序 | 項目 | 規模 |
|---|---|---|
| ~~1~~ | ~~階段 1 全部~~ | ✅ 已完成 |
| 2 | 翻譯歌詞 | 小～中 |
| 3 | 點詞查義（含 `data-lemma`、純假名詞包框） | 中 |
| 4 | 生詞本 + Anki 匯出 | 小 |
| 5 | 統計玩法（range、熱力圖、CSV） | 中，獨立可插隊 |
| 6 | 靈動島（控制列、多螢幕、展開） | 中，三件可拆開做 |
| 7 | 逐字卡拉OK | 大，對齊是真工程 |

---

## 每個階段的驗證方式

1. **既有回歸測試全跑**：
   `node test_origin_guard.js`、`test_s2t.js`、`test_itunes_resolving.js`、
   `test_history_toggle.js`、`test_backup_restore.js`；
   `venv\Scripts\python.exe` 跑 `test_pick_session.py`、`test_furigana_hint.py`、`test_pick_song.py`。
   動到假名管線（2b）與簡轉繁（2a）時，這幾支是主要防線。
2. **新邏輯各留一支 runnable 檢查**，跟現有測試同風格（無框架、直接 `node`／`python` 跑）。
   查詞那支照抄 LLM 的 mock 端點測試：驗快取命中時零外部呼叫。
3. **空資料庫實測**：新頁面／新區塊都要用一顆全新的空 DB 跑一次
   （`DB_PATH` 指到暫存檔起 server），確認不是一片空白。
4. **打包版實測**：牽涉 `%APPDATA%` 路徑或 `build.files` 白名單的改動，
   **只在 dev 模式驗過不算數**，要 `npm run dist` 後啟動 `release/win-unpacked` 實測。
   新增的 repo 根層 js 檔要記得加進 `build.files`，否則 dev 正常、打包版 MODULE_NOT_FOUND。
