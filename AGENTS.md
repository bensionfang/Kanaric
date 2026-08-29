# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A desktop floating-lyrics system (Windows-only for full functionality): it picks a playing media session via the Windows Media API (music apps preferred, or a user-chosen app), fetches synced lyrics from external sources, annotates Japanese kanji with furigana, and displays lyrics in a C# "Dynamic Island" overlay plus a web dashboard with listening stats. README.md and most code comments are in Traditional Chinese.

## Commands

```bash
# 日常開發的入口:repo 根的 dev.bat (= scripts/dev-cleanup.ps1 清殘留進程,再 npm run app)
dev.bat

# Python deps (repo root; a venv/ exists and is auto-detected by server.js)
pip install -r requirements.txt

# Node deps + run (everything starts from web-app/)
cd web-app
npm install
npm start        # node server.js — also spawns the Python media monitor on Windows
npm run dev      # nodemon
npm run app      # Electron shell: server + dashboard window + tray + island, one command

# Distribution (single NSIS installer, target machine needs no Python/Node)
npm run dist     # = build:py (PyInstaller → dist-py/) + electron-builder (→ web-app/release/)
```

- Web dashboard: http://localhost:5720 (預設值;被占用時自動改用空閒 port,靈動島視窗直接載入同一個 port 的 `/island`)
- **`dev.bat` 刻意只有三行純 ASCII,註解與清理邏輯全在 `scripts/dev-cleanup.ps1`。** cmd 用**系統字碼頁**讀 `.bat`,UTF-8 的中文註解會被誤解碼、多位元組字的殘餘位元組把後面的 ASCII 吃掉 (`chcp 65001` 也救不回來);而 `^` 行接續又要求檔案是 CRLF,LF-only 會把續行拆散、後面的註解片段當成指令跑 (症狀:exit 255 + 幾行「'xxx' 不是內部或外部命令」)。`.gitattributes` 的 `*.bat text eol=crlf` 釘住換行 —— **`core.autocrlf` 靠不住**,直接被寫出來的檔案不經過 checkout 的 smudge。
  - 清理是必要的:每跑一次就留一份殭屍 server (連帶 media monitor),久了佔住 5720 讓新的掉到隨機 port —— **port 一變 origin 就變,localStorage 整份失憶**,症狀是「使用說明每次啟動都重播」。
  - **認人的方式是「Kanaric pytools 的 parent」而不是比對 `node server.js`** (node 的 command line 只有 `node  server.js`,認不出是哪個專案),而且 **parent 要同時認 `node` 與 `electron`**:`npm run app` 之下佔著 port 的是 electron.exe,只認 node 會變成「python 被殺、真正的殭屍留著」。
  - 那支 `.ps1` 印訊息用 `Write-Output` 不是 `Write-Host`:後者寫的是 console host,`dev.bat` 的輸出被重導向到檔案時整行會消失,看起來像清理沒執行。

### 發版 (GitHub Release)

更新有**兩條路,不要合併**:打包版由 `electron-updater` 自己下載安裝 (`setupAutoUpdate()` in electron.js,
只在 `app.isPackaged` 時啟用);`npm start` 純 node 模式沒有主進程,只剩 `GET /api/update-check` 跳吐司
叫使用者自己去下載。`/api/update-check` 因此多回 `autoUpdate`/`ready` 兩個旗標,`checkForUpdate()`
(footer.ejs) 靠它決定要顯示哪一種提示 —— **打包版不該再叫人去手動下載**,那是錯的指示。

```bash
# 1. 改版號
#    web-app/package.json 的 "version" 改成新版號 (例如 1.1.0)

# 2. build 安裝檔
cd web-app && npm run dist   # 產物在 web-app/release/

# 3. 打 tag、推、建 release、附安裝檔 + latest.yml
git tag v1.1.0                # 一定要帶 v 前綴,server.js 用 /^v/ 剝掉再跟 package.json 比對
git push origin v1.1.0
gh release create v1.1.0 \
  "web-app/release/Kanaric-Setup-1.1.0.exe" \
  "web-app/release/latest.yml" \
  --title "v1.1.0" --notes "..."
```

**`latest.yml` 一定要一起上傳** —— electron-updater 是靠它比對版本的,漏了自動更新就完全不會發生
(而且不會報錯,只是安靜地什麼都沒做)。`build.publish` 設成 github provider 才會產出這個檔。
tag 沒帶 `v` 或漏推,純 node 模式的更新提醒也抓不到新版。安裝檔未簽章,`gh release create` 會直接
公開發布,屬於「發布公開內容」的動作,不要自動執行,要使用者自己按。
- 靈動島 = Electron 的一個視窗 (`web-app/island.js`),由 `npm run app` 一起帶起,沒有獨立進程也沒有 build 步驟。
- 沒有 test runner 或 linter。零星的獨立測試檔直接用直譯器跑:`node tests/test_origin_guard.js` (同源守門)、`node tests/test_s2t.js` (簡轉繁)、`node tests/test_lyric_quality.js` (內嵌注音的歌詞守門)、`node tests/test_search_query.js` (繁轉簡 + 瀏覽器標題去噪)、`node tests/test_title_lines.js` (製作人員/版權列標記)、`node tests/test_translations.js` (中文譯文合併)、`node tests/test_romaji.js` (羅馬拼音)、`node tests/test_itunes_resolving.js` (iTunes 原名還原的時序)、`node tests/test_history_toggle.js` (聆聽紀錄開關 + 清除白名單)、`node tests/test_backup_restore.js` (備份/還原 + 還原前的驗證守門)、`node tests/test_scroll_zone.js` (歌詞自動捲動的三段判定)、`node tests/test_game.js` (猜歌的干擾選項挑選)、`node tests/test_island_position.js` (靈動島的多螢幕位置記憶)、`node tests/test_word_times.js` (逐字卡拉OK的跨來源比對)、`node tests/test_loop_end.js` (段落循環的尾段間奏防護)、`node tests/test_lrclib_duration.js` (lrclib 的時長守門)、`node tests/test_lyrics_delete.js` (單首歌詞刪除)、`node tests/test_no_lyrics.js` (標記無歌詞)、`node tests/test_cloud_guard.js` (雲端 B1~B4)、`node tests/test_pkce.js` (行動版的 OAuth PKCE)、`node tests/test_mobile_playback.js` (行動版的播放位置插值)、`node tests/test_mobile_lyrics.js` (行動版的 LRC 解析)、`node tests/test_mobile_color.js` (行動版的封面主色採樣)、`node tests/test_karaoke_mode.js` (卡拉OK模式:LRC 解析 + 兩行版面與倒數)、`python tests/test_pick_session.py`、`python tests/test_furigana_hint.py`、`python tests/test_yt_search.py` (MV 背景的 YouTube 搜尋解析) (Python 的要用 `venv/Scripts/python.exe`,系統 python 沒裝 fugashi)。
- `ROADMAP.md` (repo 根,**本機檔案,不進版控**) 記著 v1.0.0 之後的規劃與**明確不做的事**。動到「未來要做什麼」的討論先看它,免得重新提案已經否決過的方向 (雲端同步、換 tokenizer、離線辭典、Steam 式強制更新)。clone 下來沒有這個檔屬正常。
  主軸是**歌詞體驗**,不是學日文 —— 翻譯/查詞這類功能要進來,得先過「它讓歌詞更好讀嗎」這一關。

## Architecture

One Node.js backend, multiple thin clients, with Python scripts as helpers spawned as child processes:

- **`web-app/server.js`** (~2600 lines, the whole backend): Express + WebSocket server owning all business logic — REST API routes, lyrics fetching (order driven by the `preferred_source` setting, with caching), artist-alias substitution, iTunes JP name resolution (undoes Spotify's auto-translation of Japanese titles), a 30-second "valid listen" state machine before writing history, and WebSocket broadcast of the current media state to all clients. `server.listen` binds `127.0.0.1` explicitly, not `0.0.0.0`, and **there is no auth on any route** — 安全性完全靠「只有本機、且只有同源」這兩條。
  - 同源守門是 server.js 的第一個 middleware,`cors()` 已經移除 (開 CORS 等於自己拆掉這道牆)。它同時看 `Origin` 與 `Sec-Fetch-Site`,兩層都必要:`Origin` 只有 fetch/XHR 會帶,`<script src>` 這類不帶,而 `Sec-Fetch-Site` 瀏覽器對所有請求都帶。兩個 header 都沒有 = 非瀏覽器客戶端 (curl、腳本),放行;靈動島現在是 Electron 視窗,兩個 header 都會帶,走的是同源那條。WebSocket 的 upgrade 不經過 express middleware,所以 `verifyClient` 要再擋一次。
  - **綁 127.0.0.1 擋不住跨站攻擊**,這是這道守門存在的理由:使用者開著 Kanaric 時瀏覽任一網頁,那個網頁就能打這裡的 API —— 跨站 POST `/api/settings` 把 `llm_base_url` 改成攻擊者的位址,再觸發 `/api/llm-models` 或 `/api/llm-furigana/run`,BYOK 的 API key 就送出去了。`<form>` POST 屬於 simple request,不觸發 preflight,所以光靠 CORS 設定擋不住。
  - **跨站的「頂層導覽」是例外,要放行** (`GET`/`HEAD` + `Sec-Fetch-Dest: document`):使用者從 README、聊天視窗點 `http://localhost:5720` 連結進來就是這種請求,擋掉只會讓人看到一行 JSON 錯誤。放行不開洞 —— 跨站 `<form>` POST 的 dest 也是 document,但方法是 POST,照樣擋住;`<img>`/`<script src>` 的 dest 是 image/script,iframe 內嵌是 iframe,都不是 document。**只認 dest 不要再比 mode**:mode 多擋不到東西,而且 undici 會把 fetch 的 `Sec-Fetch-Mode` 硬改成 `cors`,測試根本設不進去。
  - **外部來源 (不是 localhost 的頁面) 一律由設定 `mobile_origin` 明確指定**,判斷集中在 `isAllowedOrigin()`,middleware 與 `verifyClient` 共用。空值 = 一個外部來源都不放行。**不可以改成「Origin 等於請求的 Host 就放行」** —— 攻擊者把自己網域的 A record 指到 127.0.0.1 就能讓兩者相符 (DNS rebinding),整道守門形同虛設。存進來的值走 `new URL(v).origin` 正規化 (使用者多半整條網址貼進來),`updateSettings` 改到它就即時生效,不必重開 server。**初始化那行只能放在 `readSettings()` 定義之後** —— `SETTINGS_FILE` 是後面的 `const`,在守門那段呼叫會撞 TDZ。
  - 回歸測試:`node tests/test_origin_guard.js` (repo 根目錄,自己帶起一份 server)。動到這段 middleware、`ALLOWED_ORIGINS`/`mobile_origin`、或 WebSocket 的 `verifyClient` 就跑它。
  - 簡轉繁 = `web-app/s2t.js` 的 `toTraditional()` (opencc-js `cn`→`tw`)。掛在**四個 `SELECT lyrics FROM cache` 的讀取點**,外加寫入前的兩個外部歌詞入口 (自動抓取、`/api/lyrics/custom` —— 它同時是「套用備選歌詞」的入口)。**讀取時轉是必要的**:只在寫入時轉的話,改版前就存在快取裡的歌詞永遠不會變繁體,使用者重載/重開都沒用。編輯器的 `/api/lyrics/update`、`/api/lyrics/save` 是使用者自己打的字,寫入時刻意不轉。
    - **日文歌詞本體絕不能過這個轉換** (日文漢字大量與簡體同形,`声`→`聲`、`学校`→`學校`),所以有假名就跳過 —— 跟 `furigana_inject.py` 是同一條假名分界規則。唯一的例外是已標 `#TITLE#` 的製作人員列:網易連日文歌都給簡體的 `作词 : …`,那幾列照轉。
    - 但**整行跳過會留下混進日文歌詞的簡體字** (網易的 `モザイクロール` 整份是簡體漢字打的:`爱/谁/终/伤`),所以其餘各行走 `fixStraySimplified()` **逐字**修:字在 **JIS X 0208** 裡 = 日文字,不動;不在裡面 = 不是日文字,才轉。判斷用 `TextDecoder('shift_jis')` 把整張 JIS 表倒出來當集合 (Node 的 TextDecoder 只能解碼,所以是反著建表),不必為此塞幾千字的常數進原始碼。
      - **轉的目標是新字體 (`cn`→`jp`) 不是繁體**:`弹`→`弾`、`脑`→`脳`、`摇`→`揺` 才是日文寫法,繁體形 (彈/腦/搖) 連 unidic 都查不到、注音會跟著壞。順帶把 QQ/酷狗給的傳統中文字形也收斂成日文形 (`噓`→`嘘`、`醬`→`醤`)。
      - **JIS 那道閘門不可以省** —— `cn`→`jp` 對日文本來就有的字照樣改 (`机`→`機`、`后`→`後`、`里`→`裏`、`干`→`幹`),整份直接轉會毀掉正常日文歌詞。相對地閘門也讓 `言叶` 修不成 `言葉` (`叶` 是合法日文漢字 かなう),這是刻意的取捨。
      - 全庫實測 (433 首日文歌) 只有 9 首的歌詞本體被改到,全部是真的簡體/傳統字殘留。因為掛在**讀取**點,舊快取不必 migration。
    - 回歸測試 `node tests/test_s2t.js`。邏輯獨立成一個檔案就是為了讓測試 require 得到而不必啟動 server。
    - 反向的 `toSimplified()` 只給**查中國平台**用:三家的搜尋結果標題是簡體,`cn_music._title_matches` 是正規化後互相包含,繁體歌名 (告白氣球) 永遠對不上簡體結果 (告白气球),整首歌 MISS。**不能無條件轉** —— 純漢字的日文歌名 (新宝島 → 新宝岛) 轉了反而查不到,所以 `fetchCnLyricsS2()` (server.js) 是「原名先查、全 MISS 且轉換後真的不同才用簡體重試一次」,成功路徑零額外請求。快取鍵不受影響:`pytools.py cnlyrics` 的 `searchTitle/searchArtist` 與存 DB 用的 `title/artist` 本來就分開。
  - **內嵌注音的歌詞在抓取階段就擋掉** (`web-app/lyric-quality.js` 的 `hasInlineRuby()`)。網易的使用者上傳常有「漢字後面直接黏著讀音」的版本 (`とある言葉ことばが君きみに突つき刺ささり`),那種歌詞**沒有任何自動修法**:fugashi 會把 `言葉ことば` 當沒見過的詞硬斷,注音、譯文比對、猜歌的歌名比對全部跟著錯。
    - 判準是「漢字串後面接著的平假名長度 ≥ 漢字數 ×2」的比例 ≥ **0.85** (且至少 20 個漢字串)。全庫 433 首日文歌實測:內嵌注音那首 0.93、乾淨的最高 0.75、中位數 0.47,擋下來的就那一首。**門檻是拿一份樣本配出來的**,誤判的代價只是換下一個來源,所以抓緊一點。
    - 套用點是 `searchBestLyric()` 裡的 `usable()`,每一家的候選都過 (網易/酷狗、fallback、lrclib)。**判斷只有 JS 這一份,不複製到 Python** —— 但 `cn_music.fetch()` 只有在「這家沒歌詞」時才會自己往下一家問,不知道被 JS 擋掉這回事,所以那段改成由 server 依序指定三家 (`cnOrder`) 重問;實測モザイクロール 網易是內嵌注音版、**酷狗那份乾淨**,不重問就白白掉到 fallback。成功路徑仍然只打一次。
    - **擋到最後全空的話,把擋下來的第一份拿回來用** (`inlineBackup`)。整個網路只有這種版本的歌是有的,那時「找不到歌詞」比一份難讀的歌詞更糟。
    - 讀取快取時也重抓一次 (`/api/lyrics/fetch` 的 cache 命中處):改版前存進去的爛歌詞,別家有乾淨版本就換掉。三個限制條件都是必要的:**一個 process 只試一次** (`inlineRetried`,不然每次播都重抓)、**不先刪快取** (重抓沒有更好的還要靠它顯示)、**`[source:ManualEdit]` 完全不碰** (使用者自己編輯或親手套用的備選歌詞,即使是內嵌注音版也是他選的)。
    - **沒有自動修復** (把黏著的讀音拆掉還原成正常歌詞):原型做過,複合詞可以 (`言葉ことば` → `言葉`),但帶送假名的詞會拆爛 —— `触ふれない` 變成 `触ない`、`突つき` 拆不動。要靠的是使用者手動套用備選歌詞或用編輯器改,不要重新提案自動拆詞。
    - 回歸測試 `node tests/test_lyric_quality.js`。
  - **中文譯文 (`web-app/translations.js`) 絕對不能存進 `cache`,只能在注音之後才併進廣播內容。** 理由是 `s2t.js` 的簡轉繁與 `furigana_inject.process_lrc` 的注音,**兩個 kana gate 都是「整份有沒有假名」而不是逐行**:譯文混進去會 (a) 不被轉繁 (b) 被 fugashi 標上一堆亂七八糟的音讀。所以譯文獨立存 `lyrics_translations` 表 (與 `utaten_hints`/`word_times` 同形,空 `{}` 是負快取),由 `mergeTranslations()` 在 `injectFurigana()` 之後插成 `[同一個時間戳]#TRANS#譯文` 行。
    - **`translations.js` 的 `normalizeLine()` 必須與 `cn_music.normalize_line` 產生逐字相同的字串**,對不上就是靜默失效 (沒有錯誤、沒有 log)。Python 的 `\w` 對 str 是 Unicode 感知的,JS 的 `\w` 只有 `[A-Za-z0-9_]`,所以 JS 那份要明寫 `\p{L}\p{N}\p{M}`。比對前還要 `stripRuby()` 把 `<rt>` 的內容**整塊**刪掉 —— 只脫標籤的話「夢<rt>ゆめ</rt>」會變成「夢ゆめ」,永遠對不上。
    - **歌詞來源常把兩三個短句併成一行 (中間全形空白),譯文的鍵卻是逐句的** —— 整行比對就整行 MISS,而且靜默。`lookupTranslation()` 因此在整行對不上時把行拆段、由長到短貪婪比對 (段落本身可能要合起來才是一個鍵:`いつしか海に流れ着いて 光って`),**任一段查不到就整行放棄** (只翻半句更難讀)。實測全庫 2612 行缺譯文 173 → 114 行,`米津玄師 / 春雷` 缺 38 → 13、`back number / 水平線` 缺 11 → 0。
    - 合併刻意在 `furiganaCache` **之外**:切換「顯示翻譯」不必重跑 python,快取也不用多一個比對維度 (對照 `kata` 那個旗標)。
    - 譯文只在抓歌詞時搭便車存下來,所以改版前的舊快取一首都沒有。`ensureTranslations()` 會在開了設定卻查無資料時背景補抓一次。**`translationJobs` 成功失敗都留著鍵** —— 抓失敗時 pytools 不會寫負快取,鍵一刪就變成「補抓 → rebroadcast → 還是沒有 → 再補抓」的無窮迴圈。
    - 三家的譯文位置:網易 `tlyric` (自帶時間戳)、酷狗 krc `language` 軌 `type=1` (行序對齊)、QQ `contentts`。**QQ 那條是明文 LRC 而非加密 QRC**,所以走 `_qq_plain_track()` 不走 `_qq_track()`;而且那支端點不回 charset,`requests` 會猜成 ISO-8859-1 把譯文變亂碼,`r.encoding = "utf-8"` 不能拿掉 (主歌詞軌是 hex ASCII 所以看不出問題)。
    - 回歸測試 `node tests/test_translations.js`。
  - **羅馬拼音 (`web-app/romaji.js`) 的讀音直接取自注音結果,不另外去要。** 注音後每個漢字詞都帶著 `<ruby>漢字<rt>かな</rt></ruby>`,整行的假名已經在畫面上了,假名→羅馬字是確定性轉換。反過來 (羅馬字→假名) 才有損失 (づ/ず、ぢ/じ 分不出來,助詞 は/へ/を 寫成 wa/e/o 就回不去) —— 那正是「拿平台的羅馬字軌回推讀音」那條路 2026-08-05 被砍掉的原因,**不要為了羅馬字再去要一份外部資料,那是把方向做反**。插入方式與 `#TRANS#` 完全一致,併在 `mergeTranslations` 之後,所以順序是 歌詞 / 羅馬字 / 譯文。設定 `show_romaji` (預設關) 在 server 端決定要不要併,所以它也在 `REBROADCAST_KEYS` 裡。
    - **詞的邊界靠 ruby 的 `data-hs`**:那是「這顆 ruby 佔整詞讀音的第幾個字」,`0` = 詞頭。**不能每個 ruby 邊界都斷** —— 送り仮名會把一個詞拆成好幾顆 ruby (噛み締め = 噛 + み + 締 + め,第二顆 `data-hs='2'`),每顆都斷會變成 `ka mi shi me`。
    - 夾在 ruby 之間、**整段正好是常見單字助詞**的才前後斷開 (の は が を に へ と で も や か ね よ),其餘黏著:全斷會裂開「聞こえる」,全不斷就是一長串沒空格的字母。助詞前的標點要先剝掉再判斷 (`も、` 很常見),片假名詞後面直接黏著助詞的 (`ドアを`) 另外拆一次 —— **只拆片假名**,平假名這樣拆會把 `ばか` 拆成 `ba ka`。
    - 已知取捨:助詞黏在送り仮名後面時 (`乾きの` 這種一整段 `きの`) 不會斷開,出來是 `kawakino`。要根治得讓 python 端輸出詞界,那要動 `build_ruby_html` 的核心迴圈,不值得。
    - **輸出要重新逃逸**:來源是已逃逸的歌詞,而比對讀音時會先解回實體字串,不逃逸等於把 `&lt;img&gt;` 還原成真標籤。
    - 靈動島**必須吃掉 `#ROMAJI#` 行** (`island.ejs` 的 `parseLrc`),不然每句歌詞後面會跟著一行羅馬字閃過去。收進 `romajis` 對照表後,島的「第二行顯示」多一個選項「本句羅馬拼音」(與「本句翻譯」共用 `pickLines` 那條路,沒有資料就退回「下一句歌詞」)。**`pickLines` 要先決定「第一行實際是哪一句」再挑第二行** —— 活躍位置落在空行 (間奏) 時第一行會提後面那句上來,先查譯文/羅馬字的話那次查的是空行的時間戳、查不到,第二行就掉回「下一句歌詞」:症狀是每經過一次音符符號,那句的第二行就換成下一句歌詞。
    - **要不要併進廣播由 `wantsExtraLine()` 決定:歌詞區的開關 **或** 島的第二行選了它。** 兩者是同一份廣播內容,只看歌詞區開關的話,島設成「本句翻譯/羅馬拼音」卻關著對應開關時,島上永遠是空的。
    - **但這也代表網頁的歌詞面板不能反過來看「內容裡有沒有那一行」來決定要不要畫**——島設成「本句羅馬拼音」時,即使歌詞區的「顯示羅馬拼音」是關的,廣播內容照樣帶 `#ROMAJI#`(為了島),面板若照單全收,關掉開關會沒有作用(2026-07-28 真實回報過)。修法是 `footer.ejs` 另外維護 `window.__lyricsPaneSettings`(SSR 用 `settings.show_romaji`/`show_translation` 初始化,`updateLyricsContentSetting` 切換時同步更新),`app.js` 的 `renderLyrics()` 判斷 `lyric.romaji && paneSettings.show_romaji` 才畫,不是看 `lyric.romaji` 有沒有值。
    - 樣式跟著歌詞本體走 (同字體、不斜體,只小一號):唱到那句一起反白、段落循環的綠底一起上、hover 一起變白 —— **`.lyrics-romaji` 要跟 `.lyrics-translation` 出現在同一組選擇器裡**,漏掉哪一組就是那個狀態下只有日文變、羅馬字不變。
    - 回歸測試 `node tests/test_romaji.js`。
  - **逐字卡拉OK (`web-app/word-times.js`) 的逐字時間只有 QQ 的 QRC 有,而歌詞本體 65% 來自網易 —— 兩邊斷句不同,所以比對的是「整首歌串成一條字元流」而不是逐行。** 實測 (2026-08-02):網易的 `yrc` 公開 API 拿不到 (要 eapi 加密,19 首日文歌 × 3 種端點變體全空)、Lrclib 從來沒有;QQ 的 QRC 14 首抽樣有 12 首 (86%)。整行比對只有 62% 對得上 (網易切短行、QQ 併長行:`ぶっ飛んじゃってる` vs `ぶっ飛んじゃってる 自意識過剰`),改成字元流 + 單調前進比對後**中位數 98%**。
    - QRC 的逐字標記寫在文字**後面**:`[0,529]Lemon - (0,33)米(33,66)津(99,33)`,括號是 (絕對起始ms, 長度ms),一個 token 不一定只有一個字。`cn_music._qrc_flow()` 把 token 的長度平均分給 `normalize_line` 保留下來的字元,產出 `{flow, ms}` 存進新表 `word_times` (形狀同 `lyrics_translations`,空 `{}` 是負快取)。**`_qrc_lines` 不要改** —— 主歌詞那條路仍然要去標記。
    - **負快取只有 `source:'all'` 那條路可以寫**。`fetch()` 拿到網易的歌詞就不會再問 QQ,那時寫 `{}` 等於把每一首歌都判成「沒有逐字」。`pytools._stash` 因此收 `tried_all` 參數。
    - **全有或全無:整首歌只要有一行對不上,整份就不插 `#WORDS#`** (`mergeWordTimes` 的 `matched < eligible`)。兩份資料不同源時本來就有幾行對不上 (合聲括號 `消えない（消えない）`、尾巴的 `yeah`/`oh`、斷句差太多),而使用者看到的是「這句逐字亮、下一句突然不亮」—— **那看起來像壞掉,比整首都不逐字更糟** (2026-08-04 回報)。全庫實測:有逐字資料的 27 首裡 **14 首整首對得上照舊逐字、13 首退回整行一起亮**;行級命中率本來是整體 96%、中位數 98%、最差 80%。
      - 正規化後是空的行 (純標點 `♪♪♪`) 不算進 `eligible`,不然那種行會害整首放棄。已經插好的行要算成「對上」,否則重複合併會把整首丟掉 (冪等性)。
      - **搭配的另一半是「QQ 有 QRC 時連歌詞本體也用 QQ 那份」** (`searchBestLyric` 的 `cnOrder` 把 `QQMusic` 排在偏好來源前面):本體與逐字同一份,行覆蓋率天生 100%。**QQ 那份沒有逐字時不佔位** —— 它沒有留下的理由,讓給偏好來源。判斷靠 `pytools cnlyrics` 單來源那條路多回的 `word` 旗標。
        - 成本是**只在快取 miss 時**可能多打一次 QQ 搜尋,而且常常不會多:`cn_music.fetch` 在「這家沒有」時自己就往下一家問,回來的 `source` 不是 QQ 就直接收下 (所以 `cnData.source === 'QQMusic' && !cnData.word` 才 `continue`)。
        - **「本體與逐字必須同來源才用」這條單獨拿出來會把功能整個關掉** —— 改版前全庫 27 首有逐字的歌,本體是 NetEase 14 / Lrclib 5 / 無標記 6 / ManualEdit 2,**QQ 0 首**。原因是順序:偏好來源預設 NetEase,而 `searchBestLyric` 抓到就早退,根本問不到 QQ。QQ 本體實測抓得到 (Lemon 55 行 / TATTOO 77 行 / 春雷 94 行,都帶逐字與譯文),而且斷句不見得比較長 (Lemon 平均 9.9 字/行 vs 網易 12.4)。
        - **舊快取靠 `/api/lyrics/fetch` 的 cache 命中處自己換** (`wordTimesMismatch`,與內嵌注音那條重抓共用 `inlineRetried`,一個 process 一首只試一次)。判準是「有逐字資料、但 `mergeWordTimes` 對這份本體回傳原字串」,重抓回來的還要**真的併得進去**才換 —— 不驗的話會為了一份同樣對不上的本體白換一次斷句。`cnOrder` 那條偏好只在**快取 miss** 時跑,所以沒有這個出口的話舊歌再聽一百次也不會變 (2026-08-08 實測:352 首有逐字資料,**177 首卡在這裡**,佔一半)。**`[source:ManualEdit]` 不碰。**
    - **毫秒是相對於每一行自己的時間戳**,不是絕對值:QQ 與網易是兩條時間軸,只有逐行重新對齊才對得上 (行內漂移只有幾百毫秒)。**收尾點要封頂** (前一段長度 ×2),不然接間奏的那一句最後一個字會慢慢填好幾秒 (實測 5456ms 被拉成 8362ms)。
    - 補抓沿用 **`ensureTranslations`** —— 它本來就是 `source:'all'`,pytools 一次把讀音提示/譯文/逐字時間全寫進去。**不要另外開一條抓取路徑。**
    - **ROADMAP 原本規劃的 `data-cs`/`data-clen` 不必做,`furigana_inject.py` 一行都沒動**:瀏覽器端 `TreeWalker` 略過 `<rt>` 走文字節點,得到的就是原始行的字元序 (`stripRuby` 已經在賭同一件事)。
    - **填色吃的一定要是「真實播放位置」,每一端的提前量都要自己減回去。** 島是 `now - LEAD`,網頁是 `karaokeFill` 裡的 `position - WEB_APP_LYRICS_ADVANCE` (0.25 秒);那兩個提前量是為了讓下一句早一點上畫面,不是播放位置。漏減的症狀是「逐字填色整首都比聽到的快」,而且因為換行本來就該提早,單看畫面很難指認 —— 網頁版漏了這一減直到 2026-08-08 才發現。行動版沒有提前量,所以不必減。
    - 畫面在 `app.js`:行變成 active 時就地把文字節點切成一字一顆 `<span class="kc">` (切過就打旗標,不還原),每幀只動邊界那一兩顆。**不用整行的 `background-clip` 漸層** —— 32px 的歌詞會換行,水平漸層對第二列的位置是錯的;只有「正在唱的那一個字」做局部漸層,換行天然正確。**注音也逐字填**:切分時記下每顆 ruby 蓋住的字元範圍 (`lineEl.__rubies`),唱到範圍的幾成、上面的假名就填幾成 (`みらい` 跟著 `未来` 從 0 走到 100%)。整塊一次亮的話漢字還在半途、假名已經全白,看起來像壞掉。**`rt` 可以整塊套水平漸層** —— 它很短不會換行,跟歌詞本體不同。`rt` 在當前句要 `transition: none`,不然補間會把「唱到哪」糊掉。
    - **三端的 CSS 都是「每一顆 `.kc` / `rt` 都套同一條 `background-clip: text` 漸層」,唱過的靠 `--k: 100%`、還沒唱的 `0%`。只給「正在唱的那一顆」套是錯的** —— `background-clip: text` 會關掉次像素抗鋸齒,同一個顏色畫出來就是比較細比較暗,那顆字未填的那半會比旁邊還沒唱到的字暗一截 (實測同一個字平均亮度 42.4 vs 47.4,2026-08-04 回報)。連帶地 `karaoke.js` **換掉/清掉狀態時要 `removeProperty('--k')`** —— 行內值權重比 class 高,不清的話那顆字唱過了還停在當時的百分比。
    - **沒有逐字資料就整行一起變白** (`.lyrics-line.active` 本來的行為),`karaokeFill` 直接早退、連字元 span 都不切。做過「用整句時間平均分給每個字」的勻速掃光又拿掉了:那是猜的,句中有停頓或長音就明顯對不上,而「一行一行換」至少永遠是對的。連帶地 `rt` 的 `rt-pending`/`rt-now`/`rt-sung` 三個 class 只有真的在填時才掛得上,沒有逐字的歌 rt 一個 class 都沒有、走 `.lyrics-line.active rt` 整塊變白 —— **`transition: none` 因此要寫在那三條上而不是寫在 `.lyrics-line.active rt`**,整行一起換的歌照舊要有 0.2s 補間。
    - **沒有開關,有逐字就套。** 這跟 `show_romaji`/`show_translation` 不是同一類東西:那兩個是「多顯示一行資訊」,卡拉OK填色只是同一行歌詞的高亮方式,有逐字就逐字亮、沒有就整句勻速亮,使用者沒有理由要去選。**不要為它加設定。**
    - 舊的 `.lyrics-line.active rt { color:#fff }` 已經拿掉:當前句的注音改成跟著它的漢字逐字亮,不再一次全白。
    - **填色的實作只有 `web-app/public/js/karaoke.js` 一份,三個端共用** (歌詞區 / 靈動島 / 行動版)。各寫一份就是靜默失效的來源 —— 哪一端漏掉一個狀態不會有錯誤訊息,只是那裡不會動。放 `public/js` 是為了讓瀏覽器 `<script>` 載得到,同 `scroll-zone.js`/`song-key.js` 的先例。**行動版刻意不複製一份進 `public/mobile/`**,而是 `<script src="../js/karaoke.js">` + `sw.js` 的 `SHELL_EXTRA` 放行那條路徑 (它不在 `/mobile/` 底下,`fetch` 事件的條件要跟著加,否則離線抓不到)。
    - **島與行動版的 `parseLrc` 各要認 `#WORDS#`**(同 `#ROMAJI#` 的理由):三個客戶端吃的是同一份廣播字串,不收進對照表就會多出一行數字閃過去。
    - 島的兩個坑:**`paint()` 換掉 innerHTML 時一定要把 `node.__kc`/`__kcNow` 作廢**,不然填色會去改上一句那批死掉的 span (畫面完全不動,而且沒有錯誤訊息);**填色要排在重繪之後、而且在「行沒換就早退」之外**,並且用 `now - 0.5` 而不是 `now` —— 那 0.5 秒是「提早換行抵銷淡入動畫」的補償,不是真實播放位置,拿它填色整句會快半秒。
    - 行動版的 `rejectSel` 要傳 `'rt, .tr'`:譯文在手機上是 `<p>` 的子 `<span class="tr">`,不像桌面是另一顆 div,不排除就會被切成字元、跟著填色。
    - 備選歌詞視窗的格式標籤有三種:**逐字** (黃,QQ 的 QRC) / **LRC** (綠,只有行級時間) / **TXT** (灰,沒有時間軸)。旗標 `hasWords` 由 `pytools cnlyrics` 的 `source:'all'` 逐筆帶出來 —— **不能只看 DB 有沒有 stash**,那是整首歌一份、只記第一個有的來源,分不出是哪一筆候選。標的是**那份檔案本身的格式**,不是「選了它才有卡拉OK」:逐字時間是跨來源比對回來的,選 NetEase 那份照樣會填。
    - **舊庫幾乎沒有逐字資料,而且不是抓不到,是根本沒查過** (2026-08-05 實測:429 首日文歌只有 29 首有、**0 首負快取、400 首從沒查過**)。`word_times` 只在「播到那首歌 **而且** 走 `source:'all'` 那條路」時才寫得進去,所以改版前就在庫裡的歌永遠輪不到。補全用 `venv\Scripts\python.exe scripts/backfill_word_times.py` (同 `backfill_utaten.py` 的形狀:已查過的跳過、中斷可重跑、每首之間睡 2 秒)。
      - **只問 QQ,而且配不到歌時不寫負快取** —— QQ 的搜尋端點被限流時是「靜默回空結果」,跟「這首歌 QQ 沒有」分不出來,寫下去就等於因為一次限流把整首歌**永久**判成沒有逐字。連續 8 首配不到就當作被限流、整支停下來 (`GIVE_UP_AFTER`)。只有「QQ 真的回了歌詞、那份就是沒有 QRC」才寫 `{}`。
      - 時長從 `listening_history` 的平均撈 (只是 `_pick_song` 的加分證據,沒有就算了)。配到別首歌不會亂填 —— `word-times.js` 是整首歌字元流比對,對不上就整份丟掉。
    - **酷狗不值得當第二個逐字來源** (2026-08-05 實測 18 首):QQ 78% / 酷狗 78%,而**聯集只多一首,那首還只有 1 行** (藤井風 / 旅路),湊不成整首、會被「全有或全無」擋掉。krc 行內確實有 `<offset,length,0>` 標記且長度非零,但那是**相對位移**(QRC 是絕對值)要多一套換算 —— 換算寫了也救不到任何一首。**不要重新提案。**
    - 回歸測試 `node tests/test_word_times.js`。
  - **備選歌詞視窗手動輸入關鍵字時,`pytools cnlyrics` 不准搭便車寫快取** (`stash: false`,2026-08-05)。`_stash` 存的鍵是 **(artist, title) = 正在播的那首**,查的卻是 `searchTitle/searchArtist` —— 平常兩者是同一首歌的不同寫法所以正確,但那個輸入框讓使用者打**任何**歌名,那時等於把別首歌的譯文與逐字時間蓋到現在這首上。實測踩過:在 muque 那首播放時搜 `ヨルシカ / 春泥棒`,muque 的 `word_times` 就變成春泥棒的字元流,而「全有或全無」只會表現成「這首突然不逐字了」,**沒有任何錯誤訊息**。判準是 `buildSearchQuery` 回傳的 `explicit`(= 這次請求帶了 searchTitle/searchArtist)。前端**每次**搜備選歌詞都會帶那兩個參數(沒改過就等於歌名本身),所以實際效果是**整支 `/api/lyrics/options` 都不寫快取** —— 那是刻意的:那條路的角色是「瀏覽候選」,而正規的寫入點(播放時的 `searchBestLyric`、`ensureTranslations`、`scripts/backfill_word_times.py`)一個都沒少,不必為了省一次請求去冒蓋錯歌的風險。存起來的 per-song `search_overrides` 也不受影響 —— 那是「同一首歌換個名字查」,走 `explicit=false` 的播放路徑,照舊要寫。
  - **`searchOptions` (備選歌詞) 的三家是並行的,不要改回依序 `await`。** 它跟 `searchBestLyric` 不同:
    那邊抓到好歌詞就早退,依序是省請求;這邊要收集**全部**候選、沒有早退,依序就只是把延遲加起來。
    實測同一首歌 (`ヨルシカ / 春泥棒`,真實網路):**依序 27.2 秒 → 並行 18.0 秒**,剩下的時間是最慢
    那一家 (`search_fallback.py` 內部自己還在依序問 syncedlyrics 的幾家 provider)。
    - **各家收在自己的桶子裡,最後依固定順序 (cn → fallback → lrclib) 串起來**,不要照完成先後 push:
      `finalizeOptions` 遇到同分是穩定排序,照完成順序會讓前 5 筆每次跑都不一樣。
    - 代價是 cn 與 fallback 兩個 `spawnPy` 會同時存在。桌面無感;雲端那台這支端點本來就限流 5 次/5 分鐘。
    - **`search_fallback.py` 內部的四家 provider 也是並行的** (`gather_providers`,`ThreadPoolExecutor`),
      同樣不要改回依序 `for`。它是那 18 秒剩下的主因:實測 `YOASOBI / 夜に駆ける` 的備選歌詞搜尋,
      有用的候選 4.7 秒就到齊,之後**整整 11 秒**都在等這四家依序跑完(而且那一次一筆都沒回)。
      並行後整支 15.6 秒 → **9.3 秒**;`ヨルシカ / 春泥棒` 27.2 → 18.0 → **13.0 秒**。
      - **內層的 query 變體迴圈維持依序**:那是有優先度的 (原名 → 羅馬字 → …),第一個命中就該停。
      - `gather_providers` 回 dict 而不是 list,**呼叫端一律照 `providers` 的順序重組** —— `source`
        名稱會顯示在 UI 的來源標示上,照完成先後收就是每次跑排出來不一樣。
      - `--all` 以外那條路 (主歌詞抓取) **刻意維持依序**:它抓到就早退,並行等於白打三家的請求。
      - 回歸測試 `venv\Scripts\python.exe tests/test_fallback_parallel.py` (把
        `fetch_single_provider` 換成會睡覺的假貨,不打真的網路)。
  - **`_fetch_qqmusic` 的搜尋 module 是 `DoSearchForQQMusicMobile` 不是 `...Desktop`。** Desktop 那支已經對任何字串都回 0 筆 (`code` 仍然是 0、空 list,不報錯),純中文歌 `晴天 周杰伦` 也一樣 —— 不是限流也不是日文的問題。它靜默死掉的期間 QQ 這一家等於整個不存在:歌詞快取 378 首裡 QQ 佔 0 首,羅馬字提示也少了唯一把 `私` 讀對的來源。Mobile 那支的結果在 `req.data.body.item_song`,欄位是 `title` 不是 `name`,其餘形狀相同。
  - **瀏覽器 (YouTube) 來源的三道處理都以 `web-app/browser-query.js` 的 `isMusicAppSource()` 為閘門** (`MUSIC_APPS` 是 `media_monitor.py` 那份的手動鏡射;未知來源保守當音樂 app)。
    - 歌名去噪 `cleanBrowserQuery()`:含噪音關鍵字的整塊括號、`「」`/`『』`/`【】` 內文優先當歌名、無括號的尾綴噪音 (Official Music Video / MV / 中文字幕…)、尾段確實等於歌手時的 `歌名／歌手`、開頭確實等於歌手時的 `歌手 - 歌名` (YouTube 最常見的形狀,不剝的話快取鍵是「ヨルシカ - 春泥棒」,跟 Spotify 聽的「春泥棒」分裂成兩筆)、歌手的 `- Topic`/`VEVO` 尾綴。全部剝光時退回原始標題。`歌名／歌手` 與 `歌手 - 歌名` 用同一條判準 (正規化後互相包含),對不上就原樣留著 —— 所以歌名本身帶連字號的 (`怪獣の花唄 - replica -`) 不受影響。
    - **套用點是 `handleMediaUpdate` 的第一步 (去噪 → iTunes 還原 → `canonicalArtist` 別名收斂)**,不是只洗搜尋字串:每張表的鍵都是 (artist, title),不進場洗的話「Chevon-シェボン / ダンス・デカダンス／Chevon 【Lyric Video】」會跟 Spotify 聽的同一首在 cache 與排行榜分裂成兩筆 (`base_title` 只剝圓括號,`【】` 不在範圍)。原字串留在 `original_title`/`original_artist`。音樂 app 來源一個字都不動 —— `(Live)`/`(feat. …)` 是真的版本資訊。
    - `global.logListen` 對瀏覽器來源多一道閘門:**cache 裡沒有這首的歌詞就不記錄**。YouTube 上聽歌與看雜談影片是同一個 session,不擋的話「第1回ぶいすぽスポーツテストを見て…」這種影片會混進統計與排行榜。副作用是在 YouTube 聽的、真的找不到歌詞的冷門歌也不會被記錄。
    - `currentDuration()` 對瀏覽器來源回 `null`:YouTube 的 MV 含前奏/對白/outro 比音源長,而 `_pick_song` 在歌手對不上時要求 ±3 秒才收,拿影片長度當證據只會把正確的歌退貨。同理 `getResolvedMetadata` 也不吃瀏覽器來源的時長。
    - 回歸測試:`node tests/test_search_query.js` (去噪規則 + `isMusicAppSource` + `toSimplified`)、`node tests/test_history_toggle.js` (logListen 的瀏覽器閘門)、`node tests/test_itunes_resolving.js` (進場去噪與音樂 app 不去噪)。
  - 不要為了「手機/別台電腦也能連」把 bind 改寬 —— 那要先做真正的 auth,同源守門對區網另一台機器沒有意義。
- **Python scripts (repo root)** are stateless workers `server.js` spawns via `child_process`, always through the **`pytools.py` dispatcher** (`spawnPy()` in server.js): `pytools.py monitor|furigana|fallback|cnlyrics|romaji|minimize|seek|media-action|sessions|diff`. In dev it runs `venv python pytools.py <sub>`; in the packaged app the `PYTOOLS_EXE` env var points at the PyInstaller-built `pytools.exe`.
  - **`main()` 開頭把 stdin **與** stdout 都 `reconfigure(encoding='utf-8')` —— 兩行都必要,少一行就是 bug。** 打包的 `pytools.exe` **不吃 `PYTHONIOENCODING`** (spawnPy 有設也沒用),stdio 編碼跟著 OS codepage 走。node 一律以 UTF-8 寫含日文的 JSON 進 stdin,所以在非 UTF-8 codepage 的機器 (**繁中 Windows 預設 cp950**) 上,stdin 會用 Big5 解 → 日文變亂碼 → `json.loads` 崩 → **假名整份消失** (furigana/cnlyrics/diff 都讀 stdin,全中)。曾經只補了 stdout,漏掉 stdin,害兩個不同使用者的打包版假名全掛。**開發機若開了 Windows「Beta: 使用 Unicode UTF-8」(codepage 65001) 會完全遮掉這個 bug** —— 打包版在你機器上跑得好、cp950 使用者卻壞,`chcp 950` 也模擬不出來 (系統層設定蓋不掉);要嘛在真 cp950 機器測,要嘛信這條。clone 跑原始碼不受影響:一般 `python.exe` (非 frozen) 對重導向 stdin 預設就給 UTF-8。
  - The underlying modules:
  - `media_monitor.py` — long-running; polls Windows Media API via `winrt` and emits one JSON line per state change on stdout. `server.js` parses these lines and auto-restarts the process on exit (unless `global.isShuttingDown`).
    - **`pick_session()` is the single source-selection rule**, shared by the monitor loop and the one-shot `seek` / `media-action` / `sessions` subcommands — don't inline a session filter anywhere else (all four used to hardcode `"spotify"` separately). The `media_source` setting holds either `'auto'` or an exact `source_app_user_model_id`. Auto = playing music app (`MUSIC_APPS`) > paused music app > any playing session; the paused-music tier deliberately outranks other playing sessions so a background video can't steal the lyrics while Spotify is paused. An explicitly chosen app that isn't running yields nothing rather than silently falling back.
    - The monitor re-reads `settings.json` when its mtime changes, so switching source takes effect live — there is no "restart the monitor on settings change" path and none should be added.
    - The empty (no session) payload must keep listing **every** field, because `handleMediaUpdate` merges shallowly (`currentMediaState = { ...currentMediaState, ...state }`); an omitted key leaves the previous song's value on screen.
  - `furigana_inject.py` — one-shot; JSON in via stdin, lyrics with furigana out via stdout. Readings come from fugashi/unidic-lite, then get corrected in three layers, each beating the last: `apply_hint()` (utaten 的人工注音, aligned to the tokens with difflib) → `_COMMON_READING` (a tiny table of words the automatic sources get wrong — 私 → わたし、良い/好い/善い → いい；比對的是**整個斷詞**,所以活用形 `良く` 與複合詞 `仲良く` 都不受影響,而 `格好良い`/`気持ち良い` 斷成兩詞後正好得到 かっこいい/きもちいい) → `word_corrections` from the DB (user's manual edits, always final).
    - **「有沒有假名」是日文歌/中文歌的分界線,兩個地方共用這條規則**:`process_lrc()` 整份沒假名就原文回傳 (中文歌的漢字丟給 fugashi 只會得到亂七八糟的音讀,也順便省掉 `get_hints()` 的網路請求);`web-app/s2t.js` 的簡轉繁同理只在沒假名時動手。
    - **`_SPLIT_WORD` 是「unidic 把兩個詞黏成一個罕見詞條」的拆詞表** (`道君` ドウクン、`中君` ナカノキミ)。黏詞讓兩個字**同時**標錯,要套在 `apply_hint` 之後 —— 先拆的話 hint 會按原本的黏詞邊界把錯讀音貼回來。**只能是列表,不可以寫成「名詞尾巴是君就拆」的通則**:`道君`/`中君` 與 `諸君`/`暴君`/`主君`/`若君` 全都是「名詞 普通名詞 一般」,詞性與讀音形狀都分不出來,寫通則會把 諸君(しょくん) 拆成 諸+君。實測 429 首日文歌只黏出這兩個詞,增長率低,手動加即可。回歸測試 `tests/test_furigana_hint.py` 第 8 組。
    - `katakana_ruby` 設定 (預設關) 讓純片假名的詞也標平假名 ruby (`class='kata-ruby'`,刻意不是 `editable-ruby`:純字形轉換,不進 `word_corrections`)。讀音直接用 `kata2hira()`,不查字典,長音符 `ー` 保留。旗標由 server.js 讀 `settings.json` 後隨 stdin JSON 傳進來 —— 因此 `furiganaCache` 的命中條件除了歌詞本身還要比對這個旗標,`/api/settings` 收到它時也要 `rebroadcastLyrics()`,否則切換設定要等換歌才生效。
    - `build_ruby_html()` 裡「讀音 = 原文」的詞 (unidic 查不到的字,中文歌整行都是) 削掉前後綴後 `root_orig` 會變空字串 —— 那個分支必須把 `orig` 原樣 append 回去,否則整個詞會從畫面上消失。這就是舊版「中文歌缺字」的成因,回歸測試在 `tests/test_furigana_hint.py`。
  - `cn_music.py` — client for NetEase / QQMusic / Kugou. One API call per platform yields the LRC **and** the Chinese translation track; QQ's QRC additionally carries per-character timings (`word_times`). 三樣東西一起抓回來,不用分開打網路。
    - **逐音節羅馬字那條軌 (NetEase `romalrc`、QQ `contentroma`、Kugou krc `type=0`) 已於 2026-08-05 整個移除** —— 拿 utaten 當獨立裁判量 161 首,那層動過的詞裡變對 95 / **變錯 193**,2:1 淨負。連帶刪掉的有 `cn_music.romaji_to_hira`／`fetch_hints`、`db.get/save_romaji_hints`、`pytools._stash` 的那一段,以及網易 lyric 端點的 `rv` 參數。`romaji_hints` 表與 `CLEAR_TARGETS` 的那一格**刻意留著**,單純是讓舊庫的殘留資料清得掉。**不要重新提案把它加回來。**
    - **`_SOURCES` order is the try order.** QQ deliberately sits ahead of Kugou: 只有它給得出逐字時間。QQ's *search* endpoint (`u.y.qq.com`) rate-limits hard and starts returning empty results after a burst — that's expected, it just falls through to Kugou.
    - `_pick_song()` gates every source's search results: the title must match, then artist and duration (±3s) break ties. 歌手不合時**時長是唯一的證據**,所以要落在同一個 ±3 秒才收 —— 單憑歌手不合就退貨會誤殺太多 (あいみょん 在 QQ 叫「爱缪」),但放寬到 ±10 秒等於沒把關:神はサイコロを振らない 的「初恋」(239 秒) 就那樣被判成林志美的粵語同名曲 (230 秒)。沒有時長資訊時照舊放行。回歸測試 `tests/test_pick_song.py`。 Duration comes from `currentMediaState` in server.js and is what stops the 147-second preview clips QQ loves to return.
  - `qrc_decrypt.py` — pure-Python 3DES for QQ's QRC lyrics. **Do not replace this with a crypto library**: QQ uses a widely-copied C DES implementation with two typo'd S-box entries (sbox2 has a 15 that should be 2; sbox4 has a 10 that should be 13), so standard DES cannot decrypt it. Ported from Lyricify's `DESHelper.cs`.
  - `search_fallback.py` — one-shot fallback lyrics scraper (syncedlyrics providers + iTunes JP-title retry) when the preferred source misses. QQ is not fetched here; `cn_music._fetch_qqmusic` (working `musicu.fcg` endpoint) owns QQ. The old `fetch_qqmusic()` here (dead `client_search_cp` endpoint, HTTP 500) was removed.
- **靈動島 (`web-app/island.js` + `preload-island.js` + `views/island.ejs` + `public/css/island.css`)** — Electron 的 frameless 透明置頂視窗,載入 server 的 `/island`,靠 WebSocket 廣播吃資料,是純顯示端。
  - **視窗歸主進程管,頁面只負責畫。** 拖曳時 renderer 只在 mousedown/mouseup 各送一次 IPC,移動期間由主進程自己輪詢 `screen.getCursorScreenPoint()` 並 `setBounds` —— 逐幀送 IPC 會掉幀,`-webkit-app-region: drag` 則沒有拖曳結束事件、做不了吸附判定。吸附動畫是 easeOutQuart,沿用舊 C# 島的曲線。
    - **拖曳取樣與吸附動畫的間隔跟著 `display.displayFrequency` 走 (`frameMs`),不要寫回 60Hz/16ms。** 原則 (超過螢幕更新率的取樣畫面吃不到) 沒變,但寫死等於假設所有人都是 60Hz 螢幕 —— 開發機實測 Electron 回報 **180Hz**,寫死 60 就是把畫面砍成三分之一。成本量過:一次 `setBounds` 中位數 **0.68ms**、p95 1.18ms (透明視窗、1080p),180Hz 的 5.5ms 預算裡很寬鬆。夾在 60~240Hz 之間:低的擋驅動回報 0,高的擋 4ms 以下的 timer (那時瓶頸換成 `setBounds` 本身,只是空燒 CPU)。
  - **視窗比藥丸大是刻意的,但那圈透明邊不該吃掉點擊。** 大出來的來源有兩個:左右各 `EDGE` (docked 的外擴角畫在那裡)、換行時「只長不縮」的高度。解法**不是**把視窗縮回去 —— 那正是那兩條規則要避免的閃爍 —— 而是整扇窗預設 `setIgnoreMouseEvents(true)`,游標真的落在藥丸上時才打開 (`startHitTest` in island.js)。實測:視窗 739px 寬時收合的藥丸只有 473px,兩側各 133px 從「會被島吃掉」變成穿透。
    - **命中判定是主進程輪詢游標 (30Hz),不要改用 `setIgnoreMouseEvents(true, { forward: true })` + renderer 的 mousemove。** Electron 33 實測那個選項在這個視窗上**一則 mousemove 都沒送進 renderer** (在 `ipcMain` 那端加 log 量過,0 則),而沒有 forward 就等於「一旦切成穿透就永遠回不來」,整個功能靜默失效。輪詢跟拖曳是同一招 (`screen.getCursorScreenPoint`),一次取樣只是點在不在矩形內,沒有 `setBounds` 那種成本。
    - **hover 展開因此也改由主進程驅動 (`island:hover`),不再用 `#island` 的 mouseenter/mouseleave。** 藥丸以外是穿透的、收不到事件,而且離開藥丸的那一瞬間正好會被切成穿透 —— DOM 那條有機會整個收不到 `mouseleave`,島就卡在展開狀態。用瀏覽器直接開 `/island` 除錯時沒有主進程,`if (!window.islandBridge)` 退回 DOM 事件。
    - **藥丸尺寸要另外送 (`island:pill`),不可以併進 `island:resize`**:那支有「尺寸沒變就不送」的早退,而歌詞模式下視窗寬固定為整首最寬、逐句不變,**藥丸寬卻是逐句在變的**,跟著早退就送不出去,短行的兩側會一直被當成島。
    - **貼齊頂端時要補 `EDGE` 的外擴角**:那兩塊是 `#island` 的 `::before`/`::after`,畫在藥丸矩形之外、高度只有 `EDGE`,不補的話最左最右那兩個角點不到。
    - **拖曳中 (`dragTimer` 有值) 不切換**:島被螢幕邊緣卡住時游標會滑出藥丸,那時切成穿透就收不到 `mouseup`,拖曳卡在按下狀態。
  - **`body` 是 `align-items: flex-start`,不可以改回 `center`。** 逐句換行時視窗高度是「只長不縮」的 (`island.js` 的 `growOnly`,為了不讓透明視窗每句都改尺寸而閃),所以兩行變一行之後視窗會比島高一截 —— 置中的話那一截平分到上下兩邊,吸附狀態下島就浮在螢幕頂端下面貼不上去 (2026-08-04 回報)。對齊上緣則多出來的高度全留在下面,那裡是透明的。
  - **`--island-bg` 的 alpha 就是 `--island-opacity` 本身,不要再乘係數。** 乘 0.9 的話設定裡的「100%」其實是 90%,底下的桌面永遠透出來一點。
  - **`LEAD` (提早換行的補償) 直接吃掉逐字填色的尾巴**:島提早 LEAD 秒換行,而填色用的是真實播放位置,所以每句最後 LEAD 秒永遠填不到。舊值 0.5 是 C# 島時代沿用的 (那時沒有逐字填色),快歌一句才 1.2 秒 = 最後四成的字沒亮就跳下一句。現在是 0.2,等於 `.lyric-anim` 的實際長度。**要調大之前先想清楚這件事。**
  - 島也是**設定的寫入方** (拖曳結束存 `island_x/island_y/island_docked`),所以主進程走 `global.updateSettings()` —— 那是 `POST /api/settings` 的同一支實作,才會一起發 `settings_updated`,不會島與網頁各存各的。同理主進程讀設定用 `global.readSettings`。
  - **每一行的寬度是 JS 量完寫死在元素上的 (`paint` 的 `style.width`),`#lines` 只負責置中與裁切。** 讓行寬跟著藥丸伸縮的話,那 0.32 秒的 width 補間期間裡面的 `<ruby>` 與逐字 span 每一幀都要重排,而那正是淡入動畫與卡拉OK填色在跑的時候 —— 症狀就是「換行不順」。整首歌的行寬在 `measureSong()` 換歌時一次量完存進 Map (歌詞/譯文/羅馬字,主行與第二行兩種字級各一份),換行那一幀只查表,實測 0.4ms。
    - `#measure > div` **一定要 `width: max-content`**:`#measure` 是絕對定位、寬度 shrink-to-fit,裡面的 block 子元素會全部被撐成「最寬那一行」的寬度,逐行量出來的值就全一樣了。
    - `#lines` 的 `overflow: hidden` 要配 **`padding: 5px 0` + `margin: -5px 0`**:`line-height: 1.15` 比字體實際的墨水盒窄,英文下伸部 (`g j p q y _`) 會超出行盒 3.3px、括號與逗號 2.3px,`rt` 又有 `translateY(-2px)` 往上跑 —— 切在行盒邊緣就是「第二句是英文時 g 的尾巴不見了」(2026-08-07 回報)。padding 撐開裁切框、負 margin 原數抵銷,島的高度一格都不變。**只加上下**,左右要繼續貼著藥丸切。
    - `chromeW`(封面+等化器+gap+padding)的 `gap` 要讀 `#top` 而不是 `#island`(`#island` 是直向、gap 0)。
  - **hover = 展開模式** (`.expanded`,進出各有 180/220ms 延遲,不然滑鼠掃過螢幕上緣就彈開):上一句 (`#l0`) + 控制列 (⏯⏭ 一列,打 `/api/media-control`) + 進度條 (點擊 seek,打 `/api/seek`)。三件事共用同一個狀態,因為島沒有多餘的手勢可用 (mousedown 給拖曳、單擊給切吸附)。
    - **展開時幾何要整個凍結**:藥丸寬固定成 `max(songMaxW, CTRL_MIN_W)`、換行不回報視窗尺寸、`#l0`/`#l2` 沒內容時留空位、沒有 ruby 的行用 `.no-ruby` 補上注音那一截高度。少一項,hover 期間換句時控制列就在使用者手下移位,而他正要去點它。
    - **`.no-ruby` 的高度補償不可以改用 flex + `align-items: center` 置中** —— flex 會把 `display: ruby` 的子元素 blockify,注音整個掉到漢字那一行、把漢字往下擠 (2026-08-07 回報)。補 `padding-top` 才對,而且補在**上面**,漢字的位置才跟隔壁行對齊。要靠 `.has-ruby`(整首歌真的有注音)當閘門,否則中文歌每一行都補、整個島白白高一截。
    - **上排 (`#top`) 一定要是自己一個容器,不可以改回 `#island { flex-wrap: wrap }` 讓控制列自己換行。** flex-wrap 的規則是「放不下就整行換行」而不是「先壓縮」,而島的寬度有 0.32s 的 CSS transition —— 過渡中島比內容窄的那幾幀,封面/歌詞/等化器會各自跳成一列。後果不只是難看:`fitSize` 就是在設完 `style.width` 的當下量 `offsetHeight`,量到的是換行後的高度 (實測 157px 變 242px),那個值會直接 `setBounds` 到視窗上。
    - `#lines` 要 `flex: 1` 吃掉多餘的寬度:展開時藥丸寬是固定的而本句可能短很多,不吃掉的話多出來的空間全被推到右邊,封面與歌詞擠在左半邊。
    - **`document` 的 mousedown 要 `if (e.target.closest('#ctrl')) return`** —— 不擋的話按鈕按下去是在拖島,放開還會被當成單擊去切吸附。連帶好處:`downAt` 留 null,mouseup 自己早退。
    - **進度條的位置不套 `offset`、也不套那 +0.5 秒補償** (`playPos()` 與 `frame()` 的 `now` 是兩件事):那兩個是歌詞對齊用的,不是真實播放位置。進度更新要放在 `frame()` 對 `lyrics.length` 的早退**之前**,找不到歌詞的歌也要會動。時長是 0 (瀏覽器來源,`currentDuration()` 回 null) 就整條收起來。填色用 **`transform: scaleX()` 不用 `width`**,那是每一幀都在寫的東西。
    - 「上一首」刻意拿掉,控制列是**一列**:`[⏯][⏭] 進度條 時間`。`CTRL_MIN_W` 因此要 300 而不是 240 —— 一列的話進度條要跟按鈕與時間共用寬度,240 只剩 96px 的軌道,點不太準。
    - 猜歌中 (`gameMask`) 不展開:控制列的「下一首」會打亂 `game.js` 自己的切歌流程 (同一支 API)。
  - **多螢幕位置記憶**:位置判定全在 **`web-app/island-position.js`** (純函式,不 require electron,理由同 `s2t.js`;**`build.files` 白名單要記得加**)。設定 `island_pos` 是「每台螢幕一組座標」,`island_display` 記最後用的那台。
    - **鍵是工作區幾何 (`x,y,WxH`) 而不是 `display.id`** —— Windows 的 id 是每次列舉時生成的,重開機或重接線就可能變,存進 settings.json 後對不上等於沒記。
    - 順序:記住的那台還在 → `island_pos` 裡任一還在的 → 舊的 `island_x/y` (相容) → 主螢幕上緣置中,最後一律夾進工作區。`resetIslandPosition()` **要一併清掉 `island_pos`/`island_display`**,只清 `island_x/y` 的話下次開島又跳回舊位置。
    - `screen` 的 `display-added`/`display-removed`/`display-metrics-changed` 三個事件都重跑一次落位,否則螢幕拔掉後島會留在一個不存在的座標上 (看起來就是「島不見了」)。
    - 回歸測試 `node tests/test_island_position.js`。
  - 網頁的島開關 (`/api/island/status`、`/api/island/toggle`) 只是轉呼叫主進程掛上來的 `global.openIsland/closeIsland/isIslandOpen`。**純 node (`npm start`) 沒有主進程,回 `available:false`**,前端吐司提示需要桌面版 —— 不要為了讓純 node 也能開島而把島改回獨立進程。
  - preload 暴露的物件叫 **`window.islandBridge` 而不是 `island`**:頁面裡有 `<div id="island">`,瀏覽器的具名元素會占用 `window.island`,讓「不在 Electron 裡就降級成空實作」的判斷失效 (直接用瀏覽器開 `/island` 除錯就會壞)。
  - 舊的 C# WPF 島 (`DynamicIslandUI/`) 已刪除,要回頭參考就翻 git 歷史 (commit `ca16b66` 之前)。
  - **歌詞是外部來源的字串,而前端 (`app.js` 的 `pane.innerHTML`) 與靈動島都是 innerHTML 畫的 —— 送到畫面上的每一段外部文字都必須逃逸。** 不逃逸的話,網易/QQ/酷狗上任何人上傳一份帶 `<img onerror=…>` 的歌詞,就能在同源執行腳本:改 `llm_base_url` 再觸發 `/api/llm-furigana/run`,BYOK 的 key 就送出去了。同源守門完全擋不到,因為腳本本來就在同源裡跑。
    - 逃逸點分兩處,**因為歌詞本體要自己產 `<ruby>`,逃逸必須在產標籤之前**:`furigana_inject.py` 在分詞前 `html.escape(text)` (`build_ruby_html`、中文歌的提早退出、`#TITLE#` 列、`[ar:]` meta 列四條路徑都要);譯文不經過 python,由 `translations.js` 的 `escapeHtml()` 自己來。
    - 連帶的坑:譯文的比對鍵是 python 用**未逃逸**的原文算的,所以 `stripRuby()` 要把實體字串解回來 —— 不解的話 `Don't` → `Don&#x27;t` → 正規化成 `Donx27t`,含 `'` 或 `&` 的行永遠對不上譯文,而且是靜默失效。
    - 回歸測試:`python tests/test_furigana_hint.py` 第 7 組、`node tests/test_translations.js`。
- **`web-app/views/*.ejs` + `web-app/public/`** — web frontend (lyrics editor, leaderboard, stats).
  - **第三方字型/圖示/Chart.js 一律自架在 `public/vendor/`,不准改回 CDN。** 打包版是離線桌面 app,走 CDN 的話斷網時圖示全變空框、字型退回系統預設、統計圖整個不出現。重抓/升級版本用 `scripts/fetch_vendor_assets.py` (跑完把 `?v=` 往上加)。**Chart.js 只掛在 `stats.ejs`** —— 只有那一頁用,放 header 等於每頁多載 208 KB。刻意**不做 icon subset**:全站 77 個圖示全是字面常數,subset 之後新增圖示會靜默變空框,不值得省那 100 KB。
  - **每頁共用的前端邏輯在 `public/js/common.js`,不要搬回 `footer.ejs` 內嵌。** 那 1000 行內嵌時每次換頁都要重傳 (~60 KB) 且永遠不進快取。留在 footer 的只有需要 EJS 插值的那三行 (`window.__initialMedia` 等)。那支 `<script>` **刻意不加 `defer`** —— 它要在原本內嵌的位置同步執行,順序與時機才跟改版前一致 (各頁自己的 inline script 有可能在它之後才跑)。
    - **移除一個功能時,`common.js` 的 `tourSteps` (使用說明導覽) 要一起改 —— 它是最容易被漏掉的一份文案。** LLM 讀音校正整套在 2026-08-04 刪掉,但導覽到 2026-08-05 都還在教使用者按魔杖鈕、去「AI 讀音校正」小節填 API Key,而那些元素連 DOM 都不長:導覽走的是「元素不存在 → 卡片置中不畫框」那條**正常**分支,沒有錯誤、沒有 log,只有真的點開使用說明的人看得到。同一批要看的還有 `sourceTourSteps`、`targetMissing` 那段附註文字、README。
    - **改了 `public/js/*.js` 要把對應 `<script src>` 的 `?v=` 往上加** (同 `style.css` 的先例),不然舊使用者的瀏覽器一直吃快取裡那份,症狀是「改的東西像是沒生效」。只動註解就不必加 —— 那等於叫所有人白重載一次。
  - **封面不內嵌進 HTML,SSR 只給 `media.hasCover` 這個旗標 + `/api/current-media/cover` 這個網址。** base64 封面實測 **175 KB,佔整份 `currentMediaState` 的 99.8%**,內嵌等於每換一次頁就重傳一次,而 base64 的 PNG 幾乎壓不掉、gzip 也救不了。改成端點之後瀏覽器靠 ETag revalidate,同一首歌重載只回 304。實測首頁的 gzip 後大小 **272 KB → 6.8 KB**、編輯器 282 KB → 17 KB。
  - `app.use(compression())` 在同源守門**之後**、static 之前。本機看不出來,雲端那台的行動網路才是重點 (手機首載的 `index.html` 67 KB、每首帶 `<ruby>` 的歌詞幾十 KB,壓完剩約四分之一)。
- **`lyrics_data.db`** (repo root, SQLite, WAL mode): tables `cache` (lyrics keyed by artist+title), `listening_history`, `sync_offsets`, `word_corrections` (user furigana overrides), `utaten_hints` (utaten 的人工注音,見下), `artist_aliases` (maps Spotify's translated artist names back to originals, e.g. 魚韻 → サカナクション), `romaji_hints` (**已停用**,2026-08-05 起不再讀寫;留著只為了讓舊資料清得掉), `word_times` (逐字卡拉OK的時間資料,見上面那節), `lyrics_translations` (中文譯文), `search_overrides` (逐首歌的自訂搜尋關鍵字), `no_lyrics` (標記為「各站都沒收錄」的歌), `game_history` (猜歌的每題結果). Path configurable via `DB_PATH` env var. The .db file is gitignored (`*.db`),每台機器各自初始化。
  - **歌手名收斂在 `handleMediaUpdate` 做,只此一處。** 每張表的鍵都是 (artist, title),而不同播放 app 對同一位歌手給不同寫法 (Spotify 給「魚韻」、YouTube 給「サカナクション」),同一首歌就會分裂成兩筆。解法是進 `handleMediaUpdate` 時就用 `artistAliases` Map (開機載入 `artist_aliases` 全表,`/api/aliases` 增刪後同步更新;`handleMediaUpdate` 是同步的,不能在那等 `db.get`) 把名字換成正規名,下游的 cache、listening_history、Python 端讀音提示全部自動一致。**不要在各處寫入點各包一次,也不要為了「分開不同來源」把 source 加進主鍵** —— 實測重複全來自 metadata 字串,加 source 一列都修不掉,反而讓五張表都要改鍵。舊資料用 `scripts/merge_aliases.py` 一次性收斂 (預設 dry-run,`--apply` 才寫入並自動備份)。
  - `listening_history` 另有 `base_title` (virtual generated column,剝掉第一個括號起的尾綴):統計/排行榜一律 GROUP BY 它,讓 `(Live)`/`(feat. …)` 算同一首。**歌詞類的表刻意不加這欄** —— Live 版歌詞本來就不同,必須分開快取。定義同時寫在 server.js 建表處與 `db.py`,改一邊要改兩邊。
  - **`track_history` 設定 (預設 true) 的閘門只在 `global.logListen`,不要在別處再判斷一次。** `listening_history` 只有這一個寫入點 (換新歌、暫停後續播兩條計時器路徑共用);判斷刻意放在計時器「觸發時」而非排程時,使用者播到一半關掉就真的不會被記錄。關閉時側欄的統計數據/排行榜也一起隱藏 (`.nav-stats-item`,SSR 靠 `res.locals.settings` 決定,不然會閃一下才隱藏),但**路由保留** —— 關掉是「不記錄 / 不礙眼」,不是鎖起來。舊的 `/api/play-event` 是雲端同步時代的遺留、沒有任何呼叫者,已刪除,不要為了「外部 agent 也能回報」加回來。
  - **清除功能 (`/api/db-clear`) 的白名單寫死在 `CLEAR_TARGETS`,只碰得到可重建的資料。** `cache`/`utaten_hints`/`lyrics_translations`/`word_times` 清掉只是下次重抓 (`romaji_hints` 已停用,留在清單裡只是為了讓舊資料清得掉);`word_corrections`、`sync_offsets`、`artist_aliases`、`search_overrides` 是使用者親手打的,**任何清除路徑都不准碰**,`/api/db-usage` 只顯示筆數。清 `lyrics` 要一併清記憶體的 `furiganaCache` 與 `itunesCache`,否則已刪的歌詞還會被吐出來;最後一定要 `VACUUM`,不然檔案不會真的變小。`romaji_hints`/`utaten_hints` 這幾張是 Python 端 (`db.py`) 建的,**全新安裝上可能不存在** —— 這幾條 `db.run` 的 callback 不能省,沒 callback 的 "no such table" 會被 node-sqlite3 丟成未捕捉例外、整個 server 掛掉。回歸測試 `node tests/test_history_toggle.js`。
  - **備份/還原 (`/api/backup`、`/api/restore`) 是那批「不可重建」資料唯一的救生艇。** 備份 = **單一 `.db` 檔**:`VACUUM INTO` 產生壓實且與 WAL 一致的快照 (所以不必打包 `-wal`/`-shm`,也不必引入 zip 函式庫),再把 `settings.json` 的內容寫進備份檔自己的 `_backup_meta` 表。**`secrets.json` (LLM API key) 刻意不進備份** —— 備份檔會被隨手複製傳送。還原走 `express.raw`,前端直接把 File 當 body 送,不為了一支路由裝 multer;**動現有資料前一定要先驗 `_backup_meta.app === 'Kanaric'`**,否則隨便一個 sqlite 檔都能蓋掉使用者心血,而且要先複製一份 `.bak-restore-*` 救援檔。還原成功後 `db.close()` 已經執行,這支 server 不能再服務,靠 `global.relaunchApp()` (electron.js 掛的) 重開;純 node 模式沒有它,改成請使用者手動重啟。回歸測試 `node tests/test_backup_restore.js`。
  - **`GET /api/history.csv` 是「給人讀」的匯出,跟備份是兩件事** —— 備份是二進位整庫快照、用來還原;CSV 是一張表,丟進 Excel 或自己寫腳本分析。**BOM 不能省**,Excel 開沒有 BOM 的 UTF-8 CSV 會用系統 codepage 解、日文歌名整片亂碼。一併匯出 `base_title` (統計都 GROUP BY 它),自己算才跟站上的排行榜對得起來。
  - **`GET /api/stats/heatmap` 只回有資料的那幾天**,補零的 300 多天由前端照日曆長網格時當 0 即可。`strftime`/`date` 兩處都要 `'localtime'` —— `played_at` 存的是 UTC,不轉的話跨日那幾筆會落在錯的格子。前端 (`stats.ejs` 的 `renderHeatmap`) 三個坑:組鍵**不能用 `toISOString()`** (那是 UTC,台灣時區整批差一天);分級用「該日次數 / 當期最大值」而不是寫死門檻 (聽歌量差一個數量級,寫死的話重度使用者整片最深、輕度整片最淺);補到本週週六才畫得出完整一欄,但未來的格子要 `hm-future` 透明,不然看起來像「那天沒聽歌」。網格靠 CSS `grid-auto-flow: column` + `grid-template-rows: repeat(7,...)` 自己填成 7 列,**不用 Chart.js** (它沒有這種圖,純 DOM 還天然帶 title tooltip)。
  - 體積實測 (2026-07,393 首歌 / 349 筆紀錄 = 1.7 MB):`cache` 每首約 1.2 KB、每首歌的附屬資料 (譯文/注音/逐字) 各約 1 KB 上下,而 `listening_history` 每筆只有 31 bytes (佔全庫 0.6%)。**要談資料庫大小,施力點是歌詞快取,不是聆聽紀錄。**

### Desktop packaging (Electron)

`web-app/electron.js` is the desktop shell: it injects env vars (`DATA_DIR`, `DB_PATH`, `LYRICS_DB_PATH`, `LYRICS_SETTINGS_PATH`, `PYTOOLS_EXE`), then `require('./server.js')` in the main process, opens a BrowserWindow on the chosen port, adds a tray icon (右上角 X = 直接結束 app,不再縮到系統匣;托盤仍留著「結束」與更新安裝入口 + 雙擊顯示視窗), and wires the island window (`wireIsland()` → `global.openIsland/closeIsland/isIslandOpen`). **In packaged mode all user data lives in `%APPDATA%/Kanaric/`**; in dev mode (`npm run app`) no paths are overridden, so the repo-root DB/settings are used. Cloud/Render deployment was removed (the old `/api/sync-state` endpoint is gone); the sqlite3/Node version pins for Render GLIBC no longer apply.

### 品牌:Kanaric (kana + lyric),作者 Resuaumis

產品名 **Kanaric**、appId `com.resuaumis.kanaric`、著作權 `Copyright © 2026 Resuaumis`。

`productName` 是主動因:它決定安裝的 exe、安裝資料夾、桌面/開始選單捷徑名,以及 `app.getPath('userData')` 指向的 `%APPDATA%/Kanaric/`。島已經是 app 的視窗,不再有第二份資料夾名要同步。

setup 的檔名則由 `build.nsis.artifactName` 決定,**刻意寫死成 `Kanaric-Setup-<version>.exe`,不要拿掉也不要加空格**:預設檔名帶空格,而 GitHub 上傳資產時會把空格換成句點,`latest.yml` 裡的 `path` 又是連字號,三邊對不上 electron-updater 就抓 404 —— 一樣是靜默失敗 (見上面發版那節)。

GitHub repo 也已改名 `bensionfang/Kanaric`,`server.js` 的 `GITHUB_REPO` 跟著改了 —— 這個常數是 update-check 打 API 用的,跟 repo 名綁定(不是產品名),repo 再改名就要一起改,不然抓不到 release。

**Icon 待辦**:`build.win.icon` 目前**還沒設**,electron-builder 用預設 Electron 圖示。等使用者給圖檔後:轉多尺寸 `.ico` 放 `web-app/build/icon.ico` 並在 `build.win` 補 `"icon"`;256px png 放 `web-app/public/img/icon.png`,`electron.js` 的 `TRAY_ICON` 從寫死的 base64 改 `createFromPath` 讀它(視窗圖示、系統匣、啟動畫面三處都吃這一個常數)。要細調 setup 本身的圖示再於 `build.nsis` 加 `installerIcon`/`uninstallerIcon`/`installerHeaderIcon`。

**啟動畫面**:`electron.js` 的 `createSplash()` —— frameless 透明小窗,icon 脈動 + 字樣淡入,圖直接吃 `TRAY_ICON.toDataURL()`。主視窗改成 `show: false`,`did-finish-load` 時才 reveal(不是 `ready-to-show`:`did-fail-load` 重試後它不會再觸發),另壓 8 秒 timeout 保底。

改完重跑 `npm run dist`,新 setup 出在 `web-app/release/`。安裝檔未簽章 (SmartScreen 會擋,屬預期)。

`build.files` 是**白名單**:新增 repo 根層的 js 檔 (`s2t.js`、`island.js`、`preload-island.js` 這類 server 端 require 得到的檔案) 一定要同步加進去,否則 dev 正常、打包版一啟動就 MODULE_NOT_FOUND。

**雲端部署的檔案不會被打包進安裝檔,不必特別處理。** `build.files` 的路徑是相對 `web-app/`,而 `Dockerfile`、`render.yaml`、`.dockerignore`、`tests/`、`scripts/` 全在 repo 根層、也都不在清單裡 —— 白名單天生就把它們排除了。唯一會跟著進安裝檔的行動版檔案是 `public/mobile/` 那 ~100 KB 靜態頁 (`public/**` 收得到),那是刻意留的:打包版的 server 照樣服務 `http://127.0.0.1:5720/mobile/`,而那個位址本來就是 Spotify 註冊過的 redirect URI。**不要為了「桌面版用不到行動版」把它從白名單挖掉** —— 挖了要多寫一條排除規則,省下的 100 KB 沒有意義。

### Data flow (the key sequence)

1. `media_monitor.py` (or an edge agent) reports a track change → `handleMediaUpdate` → WebSocket broadcast to all clients.
   - **廣播走 `broadcastMediaState()` 節流,不要改回直接 `global.broadcast`。** 監控每 0.1 秒推一次,
     而 `currentMediaState` 是淺層合併的 —— 封面一旦收到就一直留在裡面,直接廣播等於每秒把幾十 KB 的
     base64 PNG 送十次。實測(有歌在播):節流前 **5 秒 46 則 / 7870 KB**,節流後 **5 秒 5 則 / 1.5 KB**。
     本機看不出來,**遠端客戶端走行動網路就是每分鐘 90 MB**。
   - 規則兩條:**只有 `position` 在動時降到 1 秒一次**(島、猜歌、行動版都自己內插,不靠廣播密度);
     **`position` 以外的欄位一變就立刻送**(暫停圖示、換歌不能延遲一秒)。
   - **封面沒變就整個不送那個鍵**。四個消費端都判斷 `thumbnail !== undefined` 才動封面,漏送不會清掉畫面。
     新連上的客戶端拿的是 `init`,那份仍然是完整狀態。
   - **網頁端也吃這條廣播,不要改回輪詢 `/api/current-media`** (2026-08-04 才接上去)。那支回的是
     **整份** `currentMediaState`——含 base64 封面,實測一則 **246 KB**。改之前有**兩個**輪詢:
     `app.js` 的 `pollSystemMedia` 每 **100ms**(只有首頁),與 `footer.ejs` 的 `syncPlayerBar` 每 **1 秒**
     (**每一頁**都跑,統計/排行榜/編輯器都在內)。實測 8 秒內的 `/api/current-media` 流量:
     首頁 **82 次 / 20.2 MB**,其餘每頁 **9 次 / 2.2 MB**;改完是每頁 **1 次 / 246 KB**(那一次是
     socket 連上之前的開場)。節流那段本來就寫好了,只是網頁端一直沒接。
     - **連線開在 `footer.ejs`,每一頁只有一條。** 它暴露 `window.onMediaMessage(fn)` 讓各頁掛 handler;
       `app.js` 的 `connectLyricsSocket` 只是去登記,**不要退回自己 `new WebSocket`**。
       **那段 socket 程式碼必須放在 `if (!document.getElementById('lyrics-scroll'))` 之外** ——
       那個判斷是「非首頁」,包進去的話首頁沒有 `onMediaMessage`,`app.js` 一呼叫就 TypeError、整支死掉
       (實作時真的踩到)。
     - **`window.__mediaSocketAlive` 是必要的,不是防禦性程式**:兩個保底輪詢都要看它才早退。
       只把間隔從 100ms 改成 2 秒的話,每 2 秒仍然要拉 246 KB = 常態 123 KB/s,問題只是變小不是消失。
     - **封面的更新因此搬出「換歌」分支,自己比對前後值**(`app.js` 的 `lastThumbnail`、`footer.ejs`
       的 `barThumb`)。掛在換歌分支裡有兩個洞:廣播沒送 `thumbnail` 那幾則會走 `else` 把封面打回
       預設圖(舊判斷是 truthy 不是 `!== undefined`);而封面比歌名晚幾則才到時,換歌分支早就跑完了,
       那首歌會一直顯示上一首的封面。
     - 驗法:Playwright 換掉 `window.WebSocket` 直接餵 `media_state`——真的 ws 物件關在
       `connectMediaSocket` 的閉包裡,頁面外拿不到。流量則用 `page.on('response')` 累加真實 bytes。
2. Lyrics are lazy-loaded: the **web frontend** reacts to the broadcast by calling `GET /api/lyrics/fetch`; the server checks the SQLite cache, applies artist aliases, fetches externally on miss, runs furigana injection, then broadcasts the result. **靈動島換歌時也會自己打同一支** (`island.ejs` 的 `setLyrics` 那段,含 `/api/lyrics/offset`) —— 它不是純靠廣播的顯示端,島先開著再換歌時廣播已經發過了。同一首歌兩邊各打一次沒關係:第二次是 cache 命中。
   - **iTunes 查詢「失敗」與「查過了,確定不用還原」不能混為一談。** `getResolvedMetadata` 的失敗路徑寫的是 `{ ..., failedAt }`,`cachedResolution()` 會把過了 `ITUNES_RETRY_MS` (預設 60 秒) 的失敗當成沒查過。舊版失敗也寫成一般結果,一次 3 秒逾時就讓那首歌**整個 process 生命週期**都不再嘗試還原,期間抓的歌詞用未還原的名字寫進 `cache` 與 `listening_history`,永久分裂 (實測 TUYU / ツユ 底下各存了同樣四首歌,排行榜也跟著錯)。冷卻**不能設成 0** —— 媒體監控每 0.1 秒更新一次,不擋就是請求風暴,而且永遠不定案。回歸測試 `node tests/test_itunes_resolving.js` 有一組驗這個 (用 `ITUNES_RETRY_MS` 縮短等待)。
   - **iTunes JP 給的「歌手名」要另外把關,不能沿用「含假名就收」** —— 它會把西洋歌手音譯成純片假名 (`Coldplay` → `コールドプレイ`、`Juice WRLD` → `ジュース・ワールド`),而片假名也算假名,舊版因此會把整批西洋歌改名寫進 `cache` 的鍵與排行榜。判準在 `acceptsItunesArtist()`,三條依序:(1) 原歌手名帶 CJK = 被翻譯過,結果一定是還原 (`魚韻` → `サカナクション`,曲風是「ロック」也照收);(2) 結果帶平假名或漢字 (`なとり`、`藤井 風`) —— **音譯永遠是純片假名**,帶平假名漢字就不可能是音譯;(3) 純片假名 + 原名純 ASCII 才看 `primaryGenreName`,`J-Pop`/`アニメ` 才收 (`レトロリロン` ✅ / `コールドプレイ` ❌)。
     - **曲風只能當正面訊號,反過來不成立**:實測 `サカナクション` 是「ロック」、`ずっと真夜中でいいのに。` 也是「ロック」、`LiSA` 是「アニメ」。
     - `primaryGenreName` 是 `カラオケ` 的整筆丟掉:羅馬字歌名很容易搜到翻唱版 (`Yorushika / Haru Dorobou` 的第一個 hit 是「歌っちゃ王」),那種結果歌名歌手都有假名,別的閘門攔不住。
     - 歌手不可信時**只丟掉歌手、歌名的還原照留**。**時長幫不上這個忙** —— `Coldplay / Yellow` 是對的歌、時長完全吻合,只是那份名字是音譯;時長證明的是「同一首歌」,不是「名字是原名」。
     - 這一切只在 `hasKana(title)` 早退**沒有**觸發時才跑,所以歌名有假名的 (`きらり`、`10月無口な君を忘れる`) 仍然不查歌手 —— `artist_aliases` 補的正是這個盲區,加上 iTunes 給不了的純偏好 (`Jay Chou` → `周杰倫`,iTunes 自己就登記羅馬字)。
     - 舊資料用 `scripts/restore_jp_titles.py` 一次性收斂 (預設 dry-run,`--apply` 才寫入並備份)。**它的採用條件刻意比 server.js 嚴**:線上判錯只是一時標錯,批次判錯是合併資料列、不可逆。實測 iTunes JP 會把西洋歌音譯成片假名 (`Juice WRLD` → `ジュース・ワールド`),「含假名」擋不住,所以要「時長 ±3 秒吻合」或「新歌名含**平假名**」兩條之一,其餘列進人工確認清單。
       - **人工確認清單不會自己消化掉,`--pick` 是它唯一的出口** (dry-run 印編號,`--apply --pick 3,7` 挑著套)。曾經以為「正常聽歌累積出真實時長之後再跑一次」就會過,實測 (2026-08-04) 是錯的:那批是**孤兒列** —— 現在播放早就直接還原成日文名,英文名那列不會再進 `listening_history`;少數有進過的 `duration` 也是 **180** (`writeListen` 拿不到時長時的寫死預設),而時長閘門本來就排除它。編號要對每一筆 review 都遞增 (含被挑走的),否則挑掉幾筆之後號碼會位移。
       - **`scripts/merge_aliases.py` (歌手別名收斂) 的 `merge()` 是同一個形狀,同樣的坑要一起看** —— 兩支刻意沒合併成共用模組 (一支改 artist+title、一支只改 artist),但改任一支的改名邏輯要看另一支。
       - **`merge_one` 的負快取 (空 `{}`) 不跟著改名,直接丟掉。** `utaten_hints`/`romaji_hints`/`lyrics_translations`/`word_times` 都用 `{}` 當負快取,而它的語意是「用**舊名**查過了,那邊沒有」——改名的整個用意就是新名查得到 (utaten 只收日文歌名,英文名底下必然是 `{}`),搬過去等於讓那首歌永遠不再查,剛好抵銷這支腳本的目的。丟掉零損失,下次播到自然重查。
       - `scripts/` 底下**會印日文的腳本一律要在開頭 `sys.stdout.reconfigure(encoding='utf-8')`** —— cp950 的 console 印到長音符 `ー` 就 `UnicodeEncodeError` 整支炸掉 (同 `pytools.py` 那條坑)。
   - **`state.resolving` 是「歌名還沒定案」的旗標,前端必須等它變 false 才抓歌詞。** iTunes 日文原名還原 (`getResolvedMetadata`) 是非同步的,`handleMediaUpdate` 不能等,所以換歌後頭幾百毫秒 state 帶的是原始歌名、幾秒後才換成日文原名。前端是靠「title 變了」判斷換歌的,沒有這個旗標就會用兩個不同的鍵各抓一次歌詞 —— 第二次多半撞到來源限流拿到空的,把已經抓對的歌詞蓋成「找不到歌詞」,要重新載入才好。
   - `itunesCache` 的佔位項帶 `pending: true`,`getResolvedMetadata` **每一條 return 前都要覆寫掉它** (含假名早退、查到、例外三條)。漏掉任何一條,那首歌的 `resolving` 永遠是 true,歌詞就完全不會抓。回歸測試 `node tests/test_itunes_resolving.js`。
   - 前端 (`app.js`) 用 `lastLyricsKey` 判斷要不要抓,跟 `lastMediaTitle` 分開:換歌時 `lastMediaTitle` 會變兩次 (原名 → 還原後),歌詞只該抓最後定案的那次。自動搜尋備選歌詞也綁在同一個判斷裡,理由相同。
3. A track is only written to `listening_history` after 30 seconds of accumulated actual playback (pause/resume-aware timer in `server.js`).

### 歌詞自動捲動 (三段規則)

判定在 `web-app/public/js/scroll-zone.js` 的 `scrollZoneAction()` (純函式,獨立成檔是為了測試不必起瀏覽器),
呼叫點只有 `app.js` 的 `applyAutoScroll()` (換行時)。畫面依活動行位置分三段:**中間帶 (中線 ±15% 高度,下限一行高) 置中**、
**上半/下半只換高亮不捲動** (行隨換句往下漂,漂進中間帶就恢復逐句置中)、**離開畫面才停手並跳出「恢復同步」按鈕**。
中間帶**刻意不對稱**:上緣 35%、下緣 90% (下半部只剩最後 10%) —— 上面是「往下漂進同步」的緩衝,下面是「已經偏低了」,不需要那麼長。
兩邊各保底容得下一行 (`中線 ∓ 一行高`),否則一次換句就可能整個跨過中間帶。

- **置中是黏著狀態 (`autoCenter`),不是每句重算幾何** —— 置中後下一句的中心必定往下偏一行 (行高 + 行距),
  帶譯文的高行會落在中間帶外,純幾何判定就變成「置中一次又往下漂,最後漂出畫面」。`nextScrollState()` 因此在
  `autoCenter` 為 true 時直接置中不看幾何,只有使用者自己捲才脫離,漂回中間帶才黏回去。
- **滾輪/觸控不再停掉同步** —— 手動捲動只掛 `scroll` listener 更新按鈕可見性 (`updateSyncPanel()`) 與解除 `autoCenter`,
  捲回畫面內按鈕自己消失。刻意不在 scroll 裡置中:使用者手指還在滑時把畫面搶走很難用。
  **scroll 事件必須配合「最近 1 秒內有手勢」(wheel/touch/pointerdown/keydown) 才算使用者捲動** —— scroll 事件本身分不出誰捲的,
  移動或縮放視窗、點別的元素造成的重排都會發 scroll,只看 scroll 就會在使用者什麼都沒做時脫離同步、歌詞一句句漂到下半部。
  自己的平滑捲動另外靠 `programmaticScrollUntil` (scrollend + 500ms 保底) 濾掉,不濾就等於置中完立刻自我解除。
  視窗 `resize` 時若還在同步模式就重新置中 (行會被重排推偏)。
- `adjacent` (新行號 = 舊行號 +1) 這個參數要**先於** offscreen 判斷:seek / 換歌 / 重畫的目標行常在畫面外,一律置中,
  否則點歌詞跳轉會變成「不捲過去還跳出按鈕」。
- `scrollLocked` 只剩兩個硬鎖來源:編輯假名中 (`startRubyEdit`)、鍵盤上下鍵手動切行 (`handleManualScroll`),都靠 `resumeSync()` 解鎖。
- 回歸測試 `node tests/test_scroll_zone.js`。

### 猜歌小遊戲 (`/game`)

邊聽邊猜:題目就是**現在正在播的那首歌**,app 只做三件事 —— 控播放 (`/api/media-control` 的 `shuffle`/`next`)、
藏答案、判分。局面狀態全在前端 (`public/js/game.js`),server 只補選項/提示並記每題結果 (`game_history`)。
挑選規則 (`pickDistractors`:指定歌手的曲目 → cache 同歌手 → 常聽 → 全庫隨機) 與 iTunes 曲目清洗
(`filterArtistTracks`) 都在 `web-app/game.js`,獨立成檔的理由同 `s2t.js`:測試 require 得到而不必起 server。
歌曲身分的鍵 `songKey` 另外放 **`web-app/public/js/song-key.js`** —— 前端「全曲目」玩法要用同一份
(放 public/js 是為了瀏覽器 `<script>` 載得到,server 與測試照樣 require,同 `scroll-zone.js` 的先例)。
**兩邊各寫一份就是靜默失效**:覆蓋率永遠差幾首,沒有錯誤訊息。

- **題庫來源只有一種:指定一位歌手,而且是必填** (`POST /api/game/artist` → 前端把 tracks 當 `pool` 送回,
  沒載入之前「開始」是 disabled)。四個選項全同一位歌手,才不能靠「歌手不對」刷掉。
  - 走 iTunes,**`country=JP` 不能改**,而且**入口要用 `entity=song` 不能用 `entity=musicArtist`** ——
    artist entity 的 `artistName` 即使在 JP storefront 也是羅馬字 (`Yorushika`),只有曲目列帶日文原名
    (`ヨルシカ`)。歌手名取曲目列的眾數再過 `canonicalArtist`。曲目用 `filterArtistTracks()` 清洗:
    砍掉 `カラオケ/karaoke/instrumental` (那些是翻唱,歌名一樣但不是本人)、`trackId` 與正規化歌名兩層去重。
    實測 ヨルシカ 201 筆 → 114 首。歌手卡的照片是**搜尋首選那首歌的專輯封面** (`artworkUrl100` 換成
    400x400) —— iTunes 給不了歌手像。
  - **`lookup` 抓不到連動曲,要再打一次 `search` 補**:artistId 的曲目列只有「這位歌手掛主名」的歌,
    別人主掛的聯名曲 (`Chevon & ヨルシカ`) 不在裡面,但別人做的「全曲目播放清單」都會收 ——
    少了它們,那些歌不算進覆蓋率,而且**答案的歌手欄會寫著別人的名字,四選一一眼看破**。
    補的那批**只認 `artistName` 含這位歌手,不比 `trackName`**:翻唱版的歌名常寫著原唱
    (`春泥棒 (ヨルシカ)`),比歌名會把整批翻唱收進來。完全掛在別人名下、聯名寫法也沒出現的客串曲
    仍然抓不到 —— 那條沒有安全的判準,不要為了它放寬成比歌名。
    補進來的標 **`extra: true`,只當干擾選項,不算進「全曲目」的分母** (`mainTracks()`):
    search 撈到的沒有 lookup 乾淨,拿它當「必須考完的清單」只會讓覆蓋率永遠差幾首。
    題目本來就只看播放清單實際播到的歌,曲目池的角色是干擾項來源 —— `count` 因此也只算本人的。
  - **選項刻意不顯示歌手名**:歌手是必填的,四個選項本來就同一位,寫出來沒有資訊價值,
    反而在答案是連動曲時把答案標出來 (它的 `artist` 是聯名或別人的寫法)。
  - **一次載入 = 2 次 iTunes 請求 (search + lookup),所以要有 `gameArtistCache`** (server.js,記憶體
    Map,TTL 6 小時)。iTunes Search API 沒有 key 也沒有配額,但有「約 20 次/分鐘/IP」的節流 (超過回 403),
    而歌名還原 (`getResolvedMetadata`) 打的是同一支 API。前端的「最近三位」chip 點下去就是重跑這支端點,
    沒有這層快取就是反覆打。失敗不進快取。
  - 「最近三位」存在**前端 localStorage** (`kanaric.game.artists`,只存歌手名與封面),點了重跑載入 ——
    曲目清單不存,免得過期而使用者看不出來 (有快取擋著,重跑不花 iTunes 額度)。
  - **`pickDistractors` 的第一個參數要連 iTunes 還原前的原名一起排除** (`original_title`/`original_artist`):
    播放器給的是 Spotify 原字串 (`Haru Dorobou`),播放狀態早被還原成日文原名 (`春泥棒`) —— 只排除還原後的
    名字,答案就會以另一個寫法混進干擾項,四選一變成兩個都對。
  - 做過又**移除**的兩條,不要重新提案:**貼 Spotify/YouTube 播放清單連結**(爬網頁內嵌 JSON,最脆弱的一條;
    使用者認為「不會有人同時猜多位歌手的歌」)、**拿本局出現過的歌當干擾項**(重複出現一眼就認得,不好玩)。
    清單解析的實作細節記在 ROADMAP,那份程式碼刪除時還沒進版控。
  - Spotify **不可能**由 app 指定播哪一首 (要 OAuth + Premium + Connect API),所以歌手只決定選項,
    題目照舊是「隨機播到什麼就考什麼」—— 使用者要自己在播放器裡放那位歌手的歌。

- **「全曲目」玩法 (`mode === 'full'`) 只能做到「記錄 + 跳過」,不能保證跑得完。** app 指定不了播哪一首
  (見上一條),所以它做的是:考過的歌記進 `S.asked`、重複播到的自動送 `next` 不佔一題、
  HUD 顯示 `42 / 114 首`、結算列出還沒考到的。
  **覆蓋率的鍵是 `titleKey` 而不是 `songKey`** (兩個都在 `song-key.js`):連動曲在曲目池裡的歌手
  已收斂成正規名,播放器給的卻是聯名寫法 (`Chevon & ヨルシカ`),比歌手就永遠算沒考過。
  曲目池只有一位歌手,光比歌名不會誤判;`titleKey` 一樣吃掉 `(Live)`/`feat.` 尾綴。
  server 合併連動曲時的去重也用它 (歌手待會會被統一改寫,那時比歌手比不出東西)。
  **比對的是 iTunes 曲目清單而不是使用者的播放清單**,兩邊本來就對不齊 (清單缺歌、單曲版與專輯版),
  所以 100% 常常到不了 —— 因此「還沒考到的歌」一定要列出來,而且隨時能按結束收攤,不可以設計成
  「跑不完就沒有成績」。連續跳過超過 `FULL_SKIP_LIMIT` (25) 就吐司提示並結束,不然清單沒涵蓋全曲目時
  會無止境地按下一首。**出過就算考過 (答錯也算)** —— 不然答錯的歌會一直回來,永遠跑不完。
- **開局會把靈動島整個收起來** (`syncIslandForGame`,走 `global.closeIsland/openIsland`),結束/關頁再開回來。
  **只有「是我們收起來的」才自動開回來** —— 本來就沒開島的人,結束時不該多一個視窗跑出來。
  純 node 模式沒有那幾支 global,直接跳過。島上的遮字仍然留著:遊戲中手動開島、或用瀏覽器開 `/island` 除錯時還是要遮。
- **答案在三個地方會自己洩出去,少遮一個就白做**:靈動島 (置頂視窗,寫著歌名)、播放列的歌名與封面、
  歌詞本身 (出題時畫面上什麼都不顯示)。播放列**整條連同側欄一起 `display:none`** (`body.game-masked`,
  CSS 不是 JS —— `syncPlayerBar` 每秒把歌名寫回 DOM,靠 JS 清是清不完的),grid 的列與欄要一起收掉,
  不然會留下 90px 空行與側欄寬的空白。收掉的理由不只洩答案:播放列的上一首/下一首/進度條會把出題流程
  弄壞 (遊戲自己在切歌),側欄則等於中途把遊戲頁關掉。**離開只有「結束」一條路。**
  **提示功能 (給一句歌詞、扣分) 做過又拿掉了 —— 使用者不要**,連帶刪掉 `/api/game/hint` 與
  `pickHintLines`。要翻舊實作看 git 歷史,不要重新提案。
- **一局結束 (含中途按「結束」) 會送 `pause`**:不停的話播放器自己接著跑下一首,使用者還在看成績、
  背景卻在放沒人聽的歌。
- 計分公式在 **`web-app/public/js/game-score.js`** (`scoreFor(elapsedMs, streak)`,獨立成檔的理由同
  `scroll-zone.js`:`tests/test_game.js` require 得到,瀏覽器則當一般 script 載入 —— 記得 game.ejs 要先載它)。
  答對是三個加項相加:基本 1 + 速度 `5 × 2^(−t/10)` + 連勝 (第 2 題起每題 +1,上限 +5,答錯歸零)。
  **答錯倒扣 `WRONG_PENALTY` (1),跳過 0 —— 兩者不可以混為一談**:跳過也扣的話使用者會亂按一個
  選項而不是跳過,成績反而更沒意義。判準是 `answer()` 的 `btn` 有沒有值 (跳過鈕走 `answer('', null)`)。
  三種情況集中在 **`gainFor()`**,理由是 `game.js` 是 DOM 的 IIFE、測試 require 不到,寫在那裡就釘不住。
  **倒扣只針對答錯,答得慢照舊不扣** —— 舊版是「滿分 10 往下扣」,碼表旁邊掛一個一直變小的數字,
  看起來像在懲罰慢慢想。速度分刻意是**連續曲線而不是分段門檻** (做過又換掉,不要提案改回去):門檻會讓
  4.9 秒與 5.1 秒差一整分、5 秒到 9 秒卻完全一樣。半衰期一句話講得完 (每 10 秒剩一半) 且永遠 > 0。
  **分數因此有小數**,`scoreFor` 與累加兩處都要 `round1`,不然會長出 17.400000000000002;顯示用
  `fmtPts` (整數不印 .0),**有正負號的地方用 `fmtDelta`** (負數自己帶 `-`,補 `+` 會變成 `+-1`)。
  總分可以是負的,刻意不夾在 0 —— 夾了就看不出「錯得比對的多」。
  碼表只往上跑,**顯示到小數點後一位** (100ms 一跳),快答的差別才看得出來。
  加分的組成要寫在揭曉區,不然連勝與速度加成等於看不見。
  `game_history.hints` 這欄留著但永遠是 0 (提示功能已移除),不為了它做 migration。
- **左欄 = 大碼表 + 連勝 + 播放進度條 + 本局戰績列表** (`#game-log`,一題一列:題號/✔✘/秒數/歌名/得分)。
  進度條的資料來自 WebSocket 的 `position`/`duration`,**廣播是換狀態才來、不是每 0.1 秒**,所以要自己
  內插 (`track.at` + 暫停時不前進);沒有時長 (瀏覽器來源) 整條收起來。歌名藏著但「多長、播到哪」不算洩答案。
  `.game-listening` 底下的圖示樣式**要指名 `.game-disc`** —— 寫成 `.game-listening i` 會連連勝的火焰
  一起變成 44px 灰色還在轉。
- 起始位置 (`startMode`) 走既有的 `/api/seek`:`intro` 位置 >3 秒才跳回 0,`random` 落在 10%~95% 之間
  (均勻分布)。**沒有時長 (瀏覽器來源 `currentDuration()` 回 null) 就不 seek**,亂跳只會跑到歌尾。
  上限敢拉到 95% 是因為下一條的 `keepQuestionPlaying()` 會把歌繞回來、不會播完,但**起點要夾住、
  至少留 `MIN_TAIL_SEC` (20 秒) 的尾巴** —— 繞的那一圈比 `LOOP_MARGIN_SEC` 還短的話,一跳回去就又
  判定「快播完」,變成在最後幾秒之間來回彈。
- **作答中不能讓歌播完** (`keepQuestionPlaying()`,掛在碼表那支 100ms 的 interval 上):題目是
  「正在播的那首」,播完播放器就自己跳下一首,畫面上的問題與耳朵聽到的變成兩首歌,而且**完全沒有徵兆**。
  剩不到 5 秒就 seek 回 `S.startPos` (這題的起點) 讓它繞。餘裕要留是因為位置是內插的
  (廣播的 `position` 一秒才來一次);**`loopGuard` 不可以省** —— seek 之後 `track.base` 要等下一則
  廣播才更新,期間每一次 tick 都會判定成「快播完」,等於每 100ms 送一次 seek。
  第二層是 `onMediaState` 開頭那道「作答中歌被換掉就自動跳過」:繞不成 (分頁被凍結、廣播延遲) 時
  至少不要讓使用者對著另一首歌作答。**它走 `answer('', null)` 所以照跳過算 (0 分,但照樣扣一條命)。**
- **開局的 `shuffle` 已經開著就不要送** (`shuffleOn`,從廣播的 `m.shuffle` 讀)。`pytools.py` 那支是
  `try_change_shuffle_active_async(not is_shuffle_active)` —— **toggle 不是 setter**,對已經開著的
  播放器再送一次等於把隨機關掉,`next` 就改成照專輯順序走,走到最後一首播放器沒有下一首可播、
  自己停下來。症狀是「猜歌到一半音樂自己暫停」,而且只在「開局前本來就開著隨機」時出現。
- **`expectPlaying()` 是「我們剛送過 next/seek」的窗 (6 秒),窗內收到 `is_playing === false` 就補一次
  `play`。** 切歌途中撞到 seek、或隨機佇列走完,播放器會自己停;遊戲又只認換歌廣播,停了就永遠卡在
  「切歌中」。**補完立刻關窗、窗外一律不補** —— 使用者自己按暫停時不能跟他搶。
  遊戲對播放器**只有 `endGame()` 送 `pause`**,所以畫面還在出題卻沒聲音,一定是播放器那邊停的。
- **開局時 `S.key` 要設成「開局當下正在播的那首」而不是空字串** —— `next` 生效前監控還在推那一首,
  空字串會讓它被當成第一題:選項是上一首的,使用者聽到的卻是切過去的新歌。而 `lastKey` **只記非空狀態**,
  沒有播放來源時監控照樣推空 payload,記進去等於把要擋的那首忘掉。
- **出題必須等 `state.resolving === false`** —— iTunes 日文原名還原是非同步的,不等它答案會在作答途中被換掉。
  跟前端抓歌詞是同一條規則。
- **「遊戲進行中」綁在遊戲頁自己的 WebSocket 連線上** (`ws.isGame` + `isGameActive()`),不是設定檔也不是逾時:
  關頁/重整/當掉都會斷線,旗標自動歸零。**這條很重要** —— 旗標卡住 = `logListen` 永久停寫聆聽紀錄。
  遊戲中不記錄的閘門只寫在 `global.logListen` 裡,跟 `track_history` 同一個位置,不要在呼叫端再判斷一次。
- `game_history` 有自己的 `CLEAR_TARGETS` key (`game`),不跟 `history` 合併清 —— 猜歌成績與聆聽紀錄是兩件事。
  備份自動涵蓋 (`VACUUM INTO` 是整庫快照)。
- **這一頁三個畫面都不該出現頁面捲軸** (使用者明確要求)。要加東西就得先騰出空間,規則:
  開始畫面靠文案濃縮 + 「輸入區與歌手卡互斥」(載入成功就把輸入框、最近三位、提示收起來);
  出題畫面靠 `#game-play` 的 `height: calc(100vh - 130px)` 框住,戰績列表 `.game-log` 才會自己捲
  (**不框住的話 `overflow-y: auto` 完全沒作用** —— grid 列高是 auto,40 題就撐出 1300px);
  結算畫面靠 `.game-wrong` 的 `max-height` + `overflow-y: auto` (兩份清單都可能幾十筆)。
  `#game-setup`/`#game-over` 用 `justify-content: safe center` —— 普通的 center 在內容比容器高時
  會往上溢出蓋到頁首,而且捲不到。
- 回歸測試:`node tests/test_game.js` (干擾選項 + iTunes 曲目清洗 + 計分公式)、`node tests/test_history_toggle.js`
  最後兩項 (遊戲中不寫入 + 關頁後恢復)。

### 卡拉OK模式 (`/karaoke`)

字幕機版面照 **JOYSOUND**:**上下兩句等大,活躍句在兩槽之間交替**(唱上面那句時下面已換成
下一句、唱下面那句時上面換成再下一句),配色是**未唱黑框白字 / 唱過白框紅字**,固定位置不捲動,
間奏有倒數點,前奏放曲名畫面。
主歌詞頁本來就有逐字填色 (`public/js/karaoke.js` 三端共用),缺的不是填色而是版面 ——
那一頁是「跟著聽」的捲動式歌詞 (提前 0.25 秒換行、活動行置中、側欄與播放列常駐),
唱歌要的是「眼睛不追、知道何時開口」。獨立成一頁而不是在首頁加模式:兩者幾乎不共用顯示邏輯
(不需要 auto-scroll、ruby 編輯、段落循環、點擊 seek),塞進 `app.js` 只會讓
`renderLyrics`/`syncLyricsToTime` 到處長分支。

- **這一頁是兩個畫面:介紹頁 + 字幕機** (同 `/game` 的形狀),`body.karaoke-page` 才是字幕機那個。
  按「開始」→ 加 class、送 `karaoke_active: true`、載 MV、`requestFullscreen`;ESC / ✕ →
  `karaokeExit()` 全部反過來,**回到介紹頁而不是導去 `/`**。
  - **全螢幕只能在使用者手勢裡要**,所以 `requestFullscreen` 掛在「開始」那顆按鈕上。沒有手勢時
    Chrome 直接 reject (`TypeError: not granted`) —— 進頁面就要是絕對拿不到的。
    (CDP 合成的點擊也拿不到 activation,所以這條**沒辦法用瀏覽器自動化驗**,只能手動點。)
  - **使用者用瀏覽器自己的方式離開全螢幕 (ESC/F11) 也要回介紹頁**,靠 `fullscreenchange` ——
    全螢幕下的 ESC 被瀏覽器吃掉,`keydown` 那條收不到。
  - **按「開始」會把歌跳回 0** (`/api/seek`),而且**本地 `pos` 也要一起歸零** —— 廣播一秒才一則,
    只送 seek 的話畫面會停在原本那句、等下一則廣播才跳,看起來像沒反應。
  - **MV 刻意等到「開始」才載** (`karaokeOnSongChange` 在 `applyState` 裡要看 `started`):
    介紹頁背後偷偷播一支 YouTube 影片沒有道理。離開時傳空字串把它停掉。
  - `karaoke_active` 兩個方向都要送 —— server 端 (`syncIslandHidden`) 收 false 才會把島開回來,
    只靠關頁斷線的話停在介紹頁時島永遠不回來。
- **這一頁的 `<script>` 一定要等 `DOMContentLoaded`** (`karaoke-mode.js`、`karaoke-mv.js` 整支
  包在裡面)。它們排在 `include('footer')` 之前,而 `window.onMediaMessage` (WebSocket 的 handler
  註冊點,在 `common.js`) 與 `.player-bar` 都在 footer 裡 —— 立即執行就是
  `onMediaMessage is not a function`,**整支腳本死掉、畫面永遠停在「等待播放」**。實作時真的踩到。
  `app.js` 把初始化放在 `DOMContentLoaded` 是同一個理由。
- **這一頁沒有提前量。** `WEB_APP_LYRICS_ADVANCE` 是為了讓下一句早 0.25 秒上畫面,而字幕機的
  下一句本來就一直在畫面上。所以 `pos = 內插位置 - syncOffset`,換行與填色吃同一個值,
  不必像首頁那樣在填色前再減回去 (那一減漏掉過,整首歌填色快 0.25 秒,很難指認)。
- **整份歌詞一次渲染,靠 class 切換顯示哪兩行 (`.kline` / `.slot-top` / `.slot-bottom` / `.cur`),
  不換 `innerHTML`。** `karaokeSplit` 把字元 span memo 在 `root.__kc` 上且不還原,換行時重寫
  innerHTML 就必須手動作廢那個 memo (靈動島踩過:填色去改上一句那批死掉的 span,畫面完全不動
  且沒有錯誤訊息)。每行各自一顆就沒有這個問題,換行那一幀零重建。
  - **上下順序靠 flex 的 `order` 而不是文件順序**:活躍句坐下槽時,上槽放的是它的**下一句**
    (文件順序在它後面),照文件順序畫就上下顛倒。
  - **`renderLines` 之後兩層都要 `karaokeSplit`,只負責顯示白字的 `.kbase` 也要,而且要同一刻切。**
    只切 `.kover` 的話兩層在**換行的位置**會不一樣:Chrome 的禁則處理 (`っ`、小假名、標點不能
    在行首) 是看同一個文字 run 判斷的,拆成一字一顆 `<span>` 之後那個判斷跟著變,斷行點就差
    一個字 —— 畫面上是**換行的那一列整個重影錯開**(2026-08-09 回報,`docs/4.png`)。
    實測掃 340~1400px 共 54 種寬度:只切一層時 **8 種寬度對不上、最大偏移 293.8px**;
    兩層都切之後 **0 種**。結構一模一樣就一定排得一樣,不必去猜瀏覽器怎麼斷。
    先切一層、另一層等唱到才切也不行,中間那段時間照樣錯開。
  - **填色狀態的清除時機是「一句進場時」而不是「離場時」** —— 唱完的那句還會以 `.done`
    留在原地紅著一陣子 (見下一條),離場時清等於把那段紅字抹掉;而往回 seek 會讓同一句
    再上場一次,那時舊的填色才要抹掉。
  - **`.done`(唱完留紅)在 2026-08-09 加回來了。** 舊註解說它「永遠看不到」是因為當時
    另一槽是一換行就跟著換,那句在同一瞬間就消失;現在改成唱到一半才換,那段時間裡它
    必須繼續紅著,不然剛唱完的字會突然變回白的。CSS 是 `.kline.cur .kover,
    .kline.done .kover { opacity: 1 }`,逐字的 `--k` 停在最後一幀的值,不必重畫。
    `applySlots` 判斷「另一槽的序號 < 活躍句」= 上一句才掛,而且移除清單要一起帶 `done`。
  - **`.done` 一定要把填色補滿** (`.kline.done .kover .kc, .kline.done .kover rt
    { --k: 100% !important }`)。一句停止活躍時最後幾個字常常還沒填到底 —— 收尾點 `endMs`
    是 `word-times.js` 封頂算出來的,而換句的時機是下一句自己的時間戳,兩者沒有關係。
    舊版那句在同一瞬間就消失所以看不見,留著紅之後沒補滿就是「最後一個字不會變紅」
    (2026-08-09 回報)。**`!important` 不能省**:`karaokePaint` 寫的是行內 `--k`,權重比 class 高。
- **配色是兩層疊出來的,不是換 `color` 就好。** 每一行畫兩份 (`renderLines`):`.kbase` 是未唱的
  白字黑框,`.kover` 絕對定位疊在上面、是唱過的紅字白框,靠逐字的
  `clip-path: inset(0 calc(100% - var(--k)) 0 0)` 由左往右揭開 (`clip-path` 對 inline 元素有效,
  實測過)。理由:**描邊的顏色也要跟著填色的波前走**,而 `-webkit-text-stroke-color` 吃不到漸層。
  - **「唱過的字」直接 `clip-path: none`,還在填的字只放寬上下兩邊 (`-0.2em`)。**
    字的墨水會超出 span 的邊框盒 (0.06em 的描邊、下伸部),而 `--k: 100%` 的 inset 剛好切在
    盒子上 —— 右緣那一截描邊被削掉,底下 `.kbase` 的黑框從缺口透出來,看起來就是「這個字
    沒填滿色」(2026-08-10 回報,`docs/3.png`、`4.png` 的 道 與 ん)。
    - **左邊的 inset 一定要是 0,不可以跟著放寬。** `inset()` 的可見矩形是
      `[left, width - right]`,`--k: 0%` 時 right = 100%,左邊放成 -0.2em 就得到
      `[-0.2em, 0]` —— 一條**位在這個字左邊、寬 0.2em 的可見縫**。那條縫會把這個字
      (紅底白框) 的左側墨水畫到**前一個字**上,前一個字的黑框被白色蓋掉,同樣長得像
      「右緣被削掉」,而且**連還沒唱到的字都中招** (2026-08-10 第二次回報,`docs/5.png`、
      `6.png`)。只有右邊 (填色的波前) 需要準,上下放寬無害,左邊放寬是災難。
    - `.kline.done` 那組強制補滿的也要一起 `clip-path: none !important`。
  - **不可以改成用 `::before` 逐字疊** (做過,就是這樣壞的):絕對定位元素放在**行內**元素裡時,
    它的行盒與宿主的基線對不上,整顆字往左下偏約 0.1em —— 症狀就是「兩種顏色的字沒有疊在一起」,
    假名尤其明顯。`.kover` 是 block、`inset: 0` 與 `.kbase` 同一個內容盒,換行與置中天生一致。
  - `karaokeSplit` / `karaokePaint` / `karaokeClear` **三個都要收到 `.kover` 這同一顆元素** ——
    它們把字元 span 與「正在唱的那顆」memo 在 `root.__kc` / `root.__kcNow` 上,傳不同的根等於各記各的。
  - `.kover` 平常 `opacity: 0`,只有 `.kline.cur` 才露臉。**沒有逐字資料的歌因此自動整句變紅**
    (那種歌本來就是整行亮),不必另外寫一條規則。
  - **`paint-order: stroke fill` 不能省**:沒有它描邊會壓在筆畫內側,日文的細筆畫直接糊掉。
    改版前那句「試過 text-stroke 圈日文很醜所以什麼裝飾都不加」講的就是漏了這個屬性,不是
    text-stroke 本身的問題。
  - **描邊寬度用 `em` 不用 `px`**:`rt` 是 0.45em,同一條宣告就讓注音的框跟著變細。
  - 連帶好處是**不再需要 `background-clip: text`** —— 那個會關掉次像素抗鋸齒,舊版得靠「每一顆
    都套漸層」來迴避亮度差,現在沒有這個問題。歌詞區/靈動島/行動版仍然是漸層那條路,沒有動。
- **倒數的五個點掛在「即將唱的那一句」的左上角** (`#karaoke-countin`,`karaoke-mode.js` 的
  `paintCountdown` 每次把它 `appendChild` 進那顆 `.kline`),不是畫面上的固定位置 ——
  照 JOYSOUND,點跟著那一句走才看得出「等一下要唱的是這句」。倒數期間那一句本來就已經在
  畫面上 (`karaokeSlots` 開口前 `COUNT_IN` 秒把它提上來當活躍句),不必另外安排。
  - 點的兩個狀態刻意**跟歌詞同一套**:還沒走到 = 白底黑框 (未唱)、走過去 = 紅底白框 (唱過),
    外框用 `box-shadow` 的 spread 畫 (跟 `-webkit-text-stroke` 同一個粗細語彙),尺寸用 `em`
    跟著歌詞字級縮放。**不要加 transition** —— 那是每幀重算的離散狀態,補間只會讓「還剩幾個」
    變模糊。秒數字樣 (`#karaoke-countin-sec`) 與前奏的「前奏 3.2s」(`#ki-count`) 都已移除:
    點本身就是那個資訊 (2026-08-10 使用者要求)。
  - **`.kline` 因此要 `align-self: flex-start/flex-end`** (不是靠 `text-align` 撐滿整列):
    flex 項目的 cross size 從 stretch 變成 fit-content,盒子貼合文字,`left: 0` 才會是
    第一個字的左邊。`.kbase`/`.kover` 都是這顆盒子裡的 block,寬度一致 = 斷行一致
    (那正是「兩層都要切 span」那個重影坑的前提,不能破壞)。已知取捨:**長到要換行的句子**
    盒子會被撐滿整列,右對齊那一槽的點就會落在離文字很遠的左邊。
  - 收起來靠全站共用的 `.hidden { display: none !important }` —— 那條有 `!important`,
    所以在這個元素上寫行內 `style.display` 是蓋不掉的 (除錯時會踩到)。
- **曲名/作詞作曲的資訊卡 (`#karaoke-intro`) 貼在畫面上緣,不是一個獨佔的畫面。**
  歌詞是貼著下緣的 (`#karaoke-stage` 是 `justify-content: flex-end`),所以資訊卡絕對定位在
  `top: 3vh` 就天生不重疊,兩者可以同時在畫面上,`#karaoke-lines` 再也不必被藏起來。
  - **這個位置是解法不是裝飾。** 舊版「獨佔畫面 + 藏掉歌詞」逼出兩個互相矛盾的需求:
    前奏短的歌卡片一閃而過等於沒顯示,而為了讓第一句連同倒數的點看得到又得提早收掉卡片
    (那又讓短前奏完全看不到)。移到上緣之後兩件事同時成立 (2026-08-10 使用者要求)。
  - 顯示到 **`max(第一句的時間, INFO_MIN_SEC=3)`** —— 前奏只有一兩秒的歌固定顯示 3 秒,
    超出前奏繼續留著也不擋任何東西。`firstTime` 是 `Infinity` (整份都是間奏行) 要早退,
    否則卡片會卡住不走。
  - **字級跟著 `vh` 不是 `vw`**:這張卡與歌詞搶的是**垂直**空間 (一個在上緣一個在下緣),
    用 `vw` 的話矮而寬的視窗會把卡片撐到壓在歌詞上 (實測 1490×846 + 4 列製作人員疊了 10px)。
    上限是「4 列製作人員時仍然構不到歌詞」量出來的:1080p 全螢幕下卡片約 320px 高,
    歌詞最壞情況 (兩句各佔兩列) 的上緣約在 540px。**要再放大先量那個距離。**
  作詞/作曲來自歌詞裡的 `#TITLE#` 行:`parseLrc` 會把它們整個丟掉(那不是歌詞),所以
  `karaoke-mode.js` 自己從**原始字串**撈,判準是「有冒號」—— 那正好濾掉歌名行(沒冒號)與
  版權聲明(又長又沒冒號)。那幾行**用 `innerHTML`**(已被 `furigana_inject.py` 逃逸過,
  `textContent` 反而會把 `&amp;` 原樣印出來);曲名/歌手是播放器給的原始字串,**必須 `textContent`**。
- **控制列是自己一條 (`#karaoke-bar`),播放列在這一頁整條 `display:none`。** 播放列是
  **播放器**版面 (封面/歌名歌手/隨機/循環/上一首/進度條),唱歌時一項都用不到;這一頁要的是
  **點歌機遙控器**:重唱 (頭出し) / ⏯ / 下一首、字幕早晚、MV/備選歌詞/重新載入。
  仍然是自動隱藏的浮條 (`body.bar-visible`,滑鼠一動滑出、閒置 3 秒收回),只是改成置中膠囊。
  - **備選歌詞浮層 (`views/modals/lyrics-options.ejs`) 是 `position: absolute` 錨在
    `.lyrics-opt-wrap` 上,所以 `karaoke-mode.js` 把整塊 wrapper (按鈕+綠泡泡+浮層)
    `prepend` 進 `#kbar-tools`** —— 錨點跟著搬,浮層的 CSS 一個字都不用改。
    **只搬按鈕是錯的**,浮層會留在藏起來的播放列裡跟著消失 (舊版不敢 `display:none`
    播放列正是為了這件事)。MV 的 🎞 由 `karaoke-mv.js` 插進同一格。
  - `.player-right .ctrl-btn` 那幾條 (尺寸、`.active` 綠色 + 小綠點) 要**一起指名
    `#kbar-tools .ctrl-btn`**,漏掉的話「搜到候選 = 變綠」在這一頁靜默失效。
  - 收起來的 transform **必須把 `translateX(-50%)` 一起寫進去** (置中靠它),
    只寫 `translateY` 會把置中蓋掉、滑出來時整條偏半個寬。
  - **⏯ 的圖示與文字由 `applyState` 自己更新** —— `common.js` 的 `syncPlayerBar` 改的是
    播放列裡那顆,而那條在這一頁是藏著的。
  - 「重唱」與「開始」共用 `karaokeRestart()`:`POST /api/seek {position:0}`,**本地 `pos`
    也要歸零** —— 廣播一秒才一則,只送 seek 的話畫面會停在原本那句,看起來像沒反應。
  - **快/慢是疊起來的兩列 (`.kbar-offsets`):上字幕、下影片 (`#kbar-mv-row`,沒挑 MV 就
    `.hidden`)。兩列的「−」一律是「這東西慢了,催快一點」,顯示的數字一律是**延遲**** ——
    字幕存的 `syncOffset` 本來就是延遲 (`pos - syncOffset`),而 MV 存的 `mvOffset` 是
    `pos + mvOffset` (值越大影片跳越前面 = 越早),所以那一列顯示 `-mvOffset`、按鈕也反向套用
    (`karaokeAdjustMvOffset` 收的是**延遲**的增減)。**不要為了「跟 DB 的值一致」把它改成直接顯示
    `mvOffset`** —— 那會讓左右兩顆鈕在兩列的物理方向相反,是這次改版要修掉的東西。
  - 字幕那列 = 這首歌的 sync offset,跟首頁**共用同一筆** (`/api/lyrics/offset`,debounce 500ms)。
    改完不必自己重畫:`frame()` 每幀都吃 `pos - syncOffset`。影片那列存 `mv_choices.offset`
    (`saveChoice`),`mvSync` 下一次對齊就跳過去 (`seekGuardUntil = 0`)。
  - **進度條刻意沒有** (使用者定案):唱歌要的是「從頭再來」不是「跳到副歌」。
  - **「退出」是控制列最右邊那顆,不是右上角的 ✕** (2026-08-10 改;那個位置使用者看不到,
    舊的 `#karaoke-exit` 連同它的 CSS 已經刪掉)。它與「獨立視窗」自成一欄 (`#kbar-extra`),
    排在字幕/影片微調的右邊。ESC 那條路照舊。
- **控制列可以拆成獨立小視窗 (`public/js/karaoke-remote.js`)**,給多螢幕的人:字幕機全螢幕
  投在電視上,遙控器留在筆電那一邊。入口是控制列上的 `#kbar-detach` —— 那顆鈕自己也在
  `#kbar-tools` 裡,所以會跟著搬過去、就地變成「收回」。
  - **不是另做一個遙控頁面,是把同一顆 `#karaoke-bar` `adoptNode` 搬進 `window.open` 出來的
    空白文件** (連 `#karaoke-mv-picker` 與它的遮罩一起;備選歌詞浮層本來就在控制列裡)。
    另寫一頁等於把播放鍵圖示、字幕/影片偏移、備選歌詞浮層各再寫一份,**兩份一定會漂**,
    而漂掉的症狀是「小視窗上的數字不會動」,沒有錯誤訊息。搬節點則是節點物件沒變:
    `addEventListener` 掛的 handler 與 `karaoke-mode.js`/`karaoke-mv.js` 抓在閉包裡的
    element 參照全部照舊有效,狀態只有一份。
  - **用 `window.open` 不是 Electron 的 `BrowserWindow`**:純 node 模式 (`npm start`,瀏覽器開)
    也要能用,而靈動島那條路只有打包版才有主進程。
  - 搬過去之後會斷兩件事,各修一次:(a) **行內 `onclick` 在小視窗的 realm 求值**,那裡沒有
    `karaokeRestart` 這些全域函式 —— 解法是把主視窗 `window` 上**所有函式**原樣掛過去
    (`Object.keys` 只撈得到 app 自己定義的,內建全域是 non-enumerable),這樣連之後動態插進來的
    節點 (備選歌詞清單那些 `onclick`) 也涵蓋,不必每次重畫都回頭 rebind;(b) `lyrics-tools.js`
    那批 `document.getElementById('lyrics-options-modal')` 是**現查**的,節點已經不在主視窗的
    document 裡 —— 在主視窗的 `document` 上補一層「自己找不到就去小視窗找」,而不是把十幾個
    呼叫點各改成先存參照 (漏一處就是靜默失效)。
  - `keepPanelInView()` 量的視窗寬要取 `panel.ownerDocument.defaultView`,不能用 `window` ——
    浮層在小視窗裡時 rect 是小視窗的座標。
  - **那扇窗裡控制列是一塊長方形,不是藥丸**:圓角/外框/陰影/毛玻璃全部歸零,寬度 100%、
    底色交給 `body` (兩層深淺會在視窗邊緣露出來)。**`transition` 一定要一起關掉** ——
    那條 0.25s 的 transform/opacity 是「從畫面下緣滑出來」用的,留著會讓
    `transform: none` 變成一個跑不完的補間,整條列停在 `translateX(-50%)`、往左偏半個視窗寬。
  - **版面是直的、窄的遙控器,不是字幕機下緣那條橫的** (照使用者給的 `docs/7.png`):
    `flex-wrap: wrap` + 每一組 `width: 100%`,排成三列 ——
    **① 重唱/播放/下一首 ② 備選歌詞/MV/重新載入 ③ 字幕與影片兩排偏移 + 右邊的「收回」**。
    `.kbar-sep` 從直線變成整列的橫線;第三列是 **微調 → 收回 → 退出** (收回在中間)。
    上面兩列的六顆鈕完全一樣大 (93×46,三欄對齊):
    - **等分用 grid 的 `1fr`,不要用 `flex: 1 1 0`。** 備選歌詞那顆包在 `.lyrics-opt-wrap` 裡
      (浮層的錨點),那個 wrapper 沒有 padding 而按鈕有 —— 即使三者都是 `flex: 1 1 0`
      ＋`border-box`＋`min-width: 0`,實測仍然分成 **91/95/95** (差的正好是按鈕的左右 padding)。
    - 第一列也要走同一套 grid,而且圖示/標籤字級要跟工具鈕對齊 (`.kbar-big` 是 19/11px、
      `.ctrl-btn` 是 17/10px),最後再用 `min-height: 46px` 把剩下的 2px 差 (標籤 line-height)
      釘平。
    - **第三列那兩顆 (收回/退出) 刻意比上面六顆窄 (62px)。** 300px 寬的視窗裡,兩顆 93px
      只留給偏移排 86px,而它最省也要約 140px (標籤＋兩顆加減＋數值);要三者都等寬得把
      視窗拉到 400px 上下,那跟「窗只有按鈕那麼大」直接衝突。偏移排也跟著收小
      (gap 6、數值最小寬 50)。
    - 第三列剩下的空白由兩排偏移往右撐滿:數值那格 `flex: 1`,`+`/`−` 就落在兩端。
    - 視窗**不可調整大小** (`resizable: false`):尺寸是照控制列量出來的,拉大只會多出一片黑,
      而且無邊框視窗連拉桿都沒有。`window.open` 的 `resizable=no` 只是聊備一格,Chrome 忽略它。
    - 第三列那顆鈕在 DOM 上原本屬於 `#kbar-tools`,**CSS 搬不動同層以外的節點,所以
      `layoutRow3()` 真的搬**(包一層 `.kbar-row3`),`restore()` 用 `unlayoutRow3()` 放回去。
      **不要改成絕對定位** —— 偏移排會隨「有沒有挑 MV」變成一排或兩排,絕對定位的鈕會凸出去。
    - 搬出 `#kbar-tools` 之後**標籤會消失**:把 `data-tip` 變成常駐文字的是
      `#kbar-tools .ctrl-btn::before` 那組,所以那幾條選擇器都要一起帶 `.kbar-row3 .ctrl-btn`。
      按鈕的 `min-width` 也要放得下那兩個字,不然文字溢出、整條列長出橫向捲動
      (實測 `flex: 0 0 auto` 把它壓成 29px 而標籤要 43px);開著時的標籤因此是「收回」不是
      「收回主視窗」。
  - **桌面版把那扇窗開成無邊框** (`electron.js` 的 `setWindowOpenHandler`,只認
    `frameName === 'kanaric-remote'`,其餘一律 deny)。瀏覽器的彈出視窗一定會頂著一條顯示
    來源網址的列,**那條在純 node 模式拿不掉**,只有走主進程接手才沒有。
    - 無邊框沒有標題列可以抓,而控制列上幾乎整片都是按鈕 (按鈕必須 `no-drag`,否則按不下去)
      —— 所以視窗上面補一條 **20px 的拖曳條** (`.kbar-drag`,`build()` 插進 popup 的 body 最前面),
      不然這扇窗搬不動。控制列的底仍然掛 `-webkit-app-region: drag` 當備援
      (瀏覽器會忽略這個屬性)。
    - **`alwaysOnTop: true` 只給 'floating' 等級,壓不過全螢幕視窗** —— 而字幕機主畫面正是
      全螢幕的,遙控器一失焦就被蓋掉。要 `win.setAlwaysOnTop(true, 'screen-saver')` 才會真的
      永遠在最上面,而那個等級**只能在視窗物件上設**,`overrideBrowserWindowOptions` 給不了,
      所以另外掛 `webContents.on('did-create-window')`。
  - **小視窗只有一種尺寸,而且剛好包住按鈕、不留空白** (使用者要求)。控制列在 300px 寬下
    是 192px 高 (兩排偏移時) 再加上 20px 的拖曳條,所以 `electron.js` 的 override 給內容區
    **300×214**,而 `karaoke-remote.js` 的 `SIZE` 是 **300×271** —— 那是 `window.open` 的
    **外框**,多出來的約 57px 是瀏覽器彈出視窗的標題列 (Electron 無邊框沒有那條)。
    **兩邊要一起改。**
  - **備選歌詞與 MV 兩個浮層在那扇窗改成 `position: fixed; inset: 0` 鋪滿整個視窗、自己捲。**
    視窗只有按鈕那麼大,從按鈕往外展開的浮層一定放不下;與其為它們把視窗撐高一倍空在那裡,
    不如打開時就佔滿。這也免掉「浮層開了要 resize 視窗」那條 —— 做過,
    `resizeTo`/`resizeBy` 在 `about:blank` 子視窗上不可靠:實測撐得大、**縮不回來**,而且
    `outerWidth` 與 `innerWidth` 互相矛盾 (785 vs 880)。**不要重新提案自動縮放。**
    (`.lyrics-opt-panel` 鋪滿時要一併 `animation: none` —— `optPopIn` 的 transform 會蓋掉 `inset`。)
  - 控制列在小視窗裡**不准 `flex-wrap`** (`width: max-content`):換行的話量到的是「視窗給多寬
    就多寬」,跟尺寸互相追著跑。
  - 使用者用視窗自己的 ✕ 關掉時**輪詢 `popup.closed` 收回** (300ms) —— `unload` 期間搬 DOM 不安全。
    `karaokeExit` 被包了一層一起關,頁面 `pagehide` 也關。
  - **開這扇窗可能讓主視窗掉出全螢幕**,所以 `karaoke-mode.js` 的 `fullscreenchange` 多一道
    `karaokeRemoteIsOpen()` 閘門 —— 不擋的話開遙控器等於直接離開卡拉OK模式。
  - 已知取捨:`showToast` 仍然畫在主視窗 (那是字幕機那一側);「點浮層外面就收起來」的全域
    handler 掛在主視窗的 document 上,小視窗裡的點擊冒泡不過去,要收起來就再按一次那顆鈕。
  段落循環與編輯假名那兩顆本來就不在這條控制列上 —— 非首頁時 `common.js` 把它們接成「跳回首頁」。
- **上下兩行是交錯的:上行靠左、下行靠右,各離該側 16%** (照 JOYSOUND,參考圖 `docs/1.png`)。
  一前一後才分得出哪句是哪句,兩行都置中會黏成一團。
  **縮排一定要用 `margin` 不能用 `padding`** —— `.kover` 是 `inset: 0`,它的容器盒是 `.kline`
  的 *padding box*,加 padding 會讓上面那層比 `.kbase` 多偏一段、兩種顏色又錯開。
- **字體跟主歌詞頁同一套 (`Poppins` + 系統字,見 `.lyrics-line`),這一頁不自己抓日文字型。**
  **試過三款、全部退回,不要重新提案 (2026-08-09 定案)**:Zen Maru Gothic 900 (丸ゴシック)、
  Noto Serif JP 900、BIZ UDPMincho 700 (UD 明朝)。使用者的結論是「都沒有到想像中的程度」,
  而代價是每一款 CJK 家族都要抓一百多個 unicode-range chunk (2~4.4 MB) 塞進安裝檔。
  - 順帶記著:JOYSOUND 最新機種 (X1 / MAX GO) 用的是**イワタUDフォント**,商用授權、
    不能打包也不能隨安裝檔散布,所以「照抄它的字型」這條路本來就走不到底。
  - 一起移除的:`/vendor/fonts-jp.css`、`/vendor/fonts/jp/`、`karaoke.ejs` 的那條 `<link>`、
    `fetch_vendor_assets.py` 的 `JP_FONTS` 與只服務它的 `save_quiet()`。要復活翻 git 歷史。
- 版面數學在 **`public/js/karaoke-slots.js`** (`karaokeSlots`,純函式,理由同 `scroll-zone.js`)。
  **槽位由「這是第幾句真歌詞」的奇偶決定** (間奏 `♫` 不算序號),偶數在上、奇數在下 ——
  奇偶是每一句的固有屬性,所以同一句在畫面上永遠待在同一槽,
  不會因為 seek 而跳槽 (測試釘住這條)。
  **另一槽不是一換行就跟著換,要等這句唱到一半** (2026-08-09 使用者要求,照 JOYSOUND):
  在那之前留著剛唱完的上一句 (紅著,`.kline.done`),之後才換成下一句當預覽。時機是
  「與下一句的間隔取半」,長間奏封頂在 `KARAOKE_SWAP_MAX_SEC` (4 秒) —— 不封頂的話間奏前
  那句會霸著半個畫面十幾秒、下一句遲遲不預覽。**「不跳槽」不受影響**:另一槽放的不論是
  上一句還是下一句,序號都跟活躍句差一,奇偶必定相反。
  **第一句是例外:沒有上一句可留,那一槽直接放下一句** (2026-08-10 使用者要求) ——
  不特判的話整首歌的開頭只有孤零零一行,唱到一半才蹦出第二行。最後一句 (沒有下一句)
  照舊一直留著上一句。
  另外兩條規則:**當前句永遠是有字的那一句** (落在 `♫` 上
  就把後面那句真歌詞提上來,那時
  `pos < cur.time`,`karaokePaint` 自己算出 0%);**間隔夠長才倒數**,而且「這是間奏」的門檻
  (`KARAOKE_GAP_SEC` 6 秒) 與「倒數窗」(`KARAOKE_COUNT_IN_SEC` 3 秒) **是兩個數** ——
  一般句距的中位數就是 4 秒上下,兩者相等的話每一句都會倒數、整首歌都在閃。
  分成兩個數也讓**沒有 `♫` 標記的歌詞** (很多來源不寫間奏行) 一樣有倒數。
  - **「間隔夠長 = 間奏」量的是「上一句唱完到下一句開口」,不是兩個時間戳的差** (`lineEnd()`,
    有逐字資料就用最後一個折線點)。只比時間戳的話,**長句後面接一般句距也會被判成間奏**:
    `NOMELON NOLEMON / カイカ` 第一句 22.880 起、唱滿 9.33 秒,下一句 32.503 —— 真正的空檔
    只有 0.29 秒,時間戳卻差 9.62 秒,於是那句唱到六成 (離下一句剩 3 秒) 就被換成下一句當
    活躍句,原本那句瞬間變 `.done` 整句補滿紅字。症狀是「卡拉OK的逐字填色會突然跳到全滿」,
    而**首頁沒有這條規則所以完全正常** (2026-08-10 回報,兩張差 100ms 的截圖)。倒數的錨點
    (`anchor`) 同樣要用 `lineEnd`,否則人還在唱就開始倒數。
- LRC 解析抽成 **`public/js/lrc-parse.js`** 的 `parseLrc()`,首頁與這一頁共用
  (`app.js` 的 `parseLrcLyrics` 變成寫回全域變數的薄包裝)。**第 4 份抄本就是靜默失效的來源** ——
  島與行動版各有一份,那兩份回傳的形狀不同 (以時間戳為鍵的對照表),刻意不動。
- 沒有逐字時間的歌**照樣進**,整句一起變紅 (`.kline.cur > span` 那條,有逐字時被 `.kc` 逐字蓋掉,
  所以兩種歌共用一條規則),角落標「無逐字資料」+ 備選歌詞入口 (`lines.some(l => l.words)` 判斷)。
  歌詞沒有時間軸 (`unsynced`) 才拒絕,那時字幕機沒有意義。
- 回歸測試 `node tests/test_karaoke_mode.js` (`parseLrc` + `karaokeSlots` + 上下槽交替與不跳槽)。

**MV 背景 (`karaoke-mv.js` + `yt_search.py`)**:用歌曲資訊搜 YouTube、使用者挑一支,影片鋪滿
背景、歌詞蓋在上面。

- **影片一律靜音,聲音永遠是 Spotify。** 歌詞位置照舊來自媒體監控,現有管線一行都沒改。
  **不要提案把歌詞位置改從 YouTube 播放器讀** —— 那是在媒體監控之外接第二條時間軸。
- **用 IFrame API 不用純 `<iframe src=".../embed/ID">`**:純嵌入沒有 `seekTo`,而 MV 有前奏/
  對白、長度與音源對不上,不能 seek 就等於沒做。這是**全 app 唯一的外部腳本**
  (其餘第三方資源一律自架在 `public/vendor/`),所以**只在使用者真的挑了 MV 之後才動態插入**:
  沒挑 MV 或斷網時整頁行為與沒有這個功能時完全一樣。
- **搜尋走抓搜尋頁 HTML (`ytInitialData`) 不走 Data API** —— 官方 API 要使用者自己去 Google Cloud
  申請,app 又多一個密鑰要保管 (BYOK 那套已經整組拆掉)。代價是 YouTube 改版會壞,所以
  **解析失敗一律回空 list、絕不拋例外**:那時安靜地退回純黑底。`fetch_html` 與 `parse_results`
  分開,測試只打後者 (`tests/test_yt_search.py`,不打真站);`python yt_search.py` 是打真站的
  自我檢查,動到解析時跑它。
- **自動套用搜尋結果的第一支** (2026-08-09 改。原本刻意不自動挑,理由是搜尋結果混著翻唱/演唱會/
  歌ってみた/鋼琴譜,挑錯就是唱到一半畫面完全不對 —— 使用者要求改成自動,兩個成本用下面幾條壓下來)。
  - **挑中的立刻存進 `mv_choices`,所以每首歌一輩子只搜一次 YouTube。** 換歌就搜一次是找封鎖。
    server 端 `mvSearchCache` (TTL 6 小時,形狀同 `gameArtistCache`) 再擋一層。
  - **第一支不是 `ok` 就不套** (`yt_search.py` 的 `ok` 旗標)。那時留純黑底,使用者從 🎞 自己挑。
  - **「取消 MV」要存成 `video_id = ''` 的一列,不可以 DELETE** —— 刪掉就跟「從沒挑過」分不出來,
    下次播到同一首又自動套一支回來,取消等於沒有用。
- 排序 (`yt_search.parse_results`) 是 `ok → 標題含歌名 → 頻道含歌手名 → -Topic → 時長`,
  每一層都是實測配出來的:
  - **只加「官方頻道」會挑到同頻道的別首歌** (`ヨルシカ / 春泥棒` → 晴る、`米津玄師 / KICK BACK`
    → Plazma),所以「標題含歌名」要排在它前面。比對前 `_norm` 掉空白與符號,`KICK BACK` 才對得上
    `KICKBACK`。
  - **時長一定要排在最後**:官方 MV 常比音源長 (前奏/outro),`春泥棒` 是 300s vs 261s 差 39 秒,
    時長往前排的話正版反而被踢掉。
  - **英文的排除字要 `\b` 邊界**,否則 `live` 吃到 `delivery`、`mad` 吃到 `made`。
  - 帶「字幕 / 歌詞 / lyrics」的轉載也算 not ok:那種畫面上本來就燒著一份字,跟我們的歌詞疊在一起。
  - 回歸測試 `venv\Scripts\python.exe tests/test_yt_search.py` (不打真站);
    `python yt_search.py <歌名> <歌手>` 是打真站的自我檢查,動到排序就跑它。
- **YouTube 自己的字幕用播放器參數關不掉,改用 CSS 裁掉那一帶 (`--mv-crop`)。**
  `cc_load_policy: 0` 只是「照使用者偏好」,**不是關閉** —— 2026-08-09 用**無痕視窗**
  (沒有任何帳號偏好) 實測照樣有字幕,所以「帳號設成一律開字幕的人才會遇到」那個舊解釋是錯的。
  改用 `unloadModule('captions')` 或 `setOption('captions','track',{})` (不管掛在 `onReady`、
  `onStateChange` 還是 `onApiChange`) **會把播放器弄到 UNSTARTED 卡死** —— 畫面全黑、連手動
  `playVideo()` 都叫不動,而且沒有任何錯誤訊息。實測過三種掛法都一樣,**不要再試**。
  - **現行立場:MV 維持置中滿版,字幕就讓它出現,擋到歌詞就用 🎞 換一支** (2026-08-09 定案)。
    用 CSS 把字幕那一帶裁掉的兩個版本都做過又拿掉了,**不要重新提案**:
    - 「只把影片往下推」(下緣往下推 18cqh):CSS 幾何是對的 (隔離重現量到 `topGap` 0),但
      **很多 MV 本身有 letterbox 黑邊** —— 置中時黑邊平分上下、各一條細的不礙眼,一往下推
      就全堆到上面變成一大條。
    - 「上下對稱裁 22cqh」:字幕與黑邊都不見了,但**每首歌的 MV 都放大 1.44 倍、四邊各吃掉
      約 22%**,為了部分影片才有的字幕讓所有影片被裁,使用者定案不要。
  - **「在搜尋階段避開有字幕的影片」也不能用。** 搜尋結果確實撈得到
    `metadataBadgeRenderer.label = "字幕"` (實站驗過),但**帶字幕的常常正好是官方 MV**
    (`ヨルシカ - 春泥棒（OFFICIAL VIDEO）` 就有),排掉之後選到的是「【中文字幕】」轉載或
    歌ってみた,比字幕更糟。
  - **日K店家那種「滿版又沒字幕」學不來,那不是 YouTube 嵌入。** 使用者實地拍回來的
    (`docs/2.png`、`docs/3.png`):店家的【輔助工具 BETA 版】把 YouTube 影片**透過
    JOYSOUND APP 上傳**,點歌機自己**下載**那支影片原生播放、再疊自己的歌詞。全程沒有
    YouTube 播放器,所以沒有 CC 層也不受嵌入限制。我們是網頁、只能嵌 iframe,走不到那條路。
  - **裁不掉「燒在影片裡」的字幕** (上傳者自己壓進畫面的那種) —— 那是畫面本身,只能靠
    `yt_search.py` 把標題帶「字幕/歌詞/lyrics」的排到後面,或使用者從 🎞 自己換一支。
- 對齊:`mvSync(pos, playing)` 掛在同一個 rAF 迴圈上,**差 0.5 秒才 `seekTo`** 且 seek 後有
  800ms 冷卻 —— 每幀 seek 會讓影片一直重新緩衝,而 `getCurrentTime` 在 seek 後要一會兒才跟上。
  影片偏移是**每首歌各自一個值** (`mv_choices.offset`,MV 的前奏長度每首都不同)。
- **鋪滿的算式要用容器單位 `cqw/cqh` 不能用 `vw/vh`** —— 舞台不是整個視窗 (`.app-container`
  還留著內距),用視窗單位算出來的尺寸比容器小一圈,左右露黑邊。
  **`body.karaoke-page .main-content` 的 `padding` 也要歸零** (2026-08-09):那 24px 內距把
  舞台連同鋪滿的 MV 四邊各縮 24px,症狀是「影片外面一圈黑框」,而 cover 算式本身是對的 ——
  查這種黑邊先量 `#karaoke-stage` 的 rect 是不是等於視窗,不要去改算式。影片**自己燒進去的
  letterbox** 是另一回事,只能換一支。
- `mv_choices` **屬使用者資料,不進 `CLEAR_TARGETS`** (同 `search_overrides`);備份靠
  `VACUUM INTO` 自動涵蓋。三支端點 (`GET /api/mv/search`、`GET /api/mv`、`POST /api/mv`)
  **桌面專用** —— 雲端的 B1 允許清單是預設拒絕,它們在那台照舊 404 (`test_cloud_guard.js` 蓋得到)。

### Furigana editing (web frontend)

The pen button in the player bar toggles **ruby edit mode** (`toggleRubyEditMode()` in `app.js`, which puts `ruby-edit-mode` on `<body>`). There is no modal — editing happens inline on the lyrics themselves:

- CSS suppresses the normal whole-line hover (the Spotify-style white + underline that means "click to seek") and instead highlights only the hovered `ruby.editable-ruby`.
- **Click** makes that ruby's `<rt>` `contentEditable` and selects it. Typing romaji converts to kana live (`romajiToHiragana()`). Enter or blur saves, Escape cancels. Auto-scroll is paused during editing (`scrollLocked = true`) so the line doesn't slide away mid-edit; `resumeSync()` on exit.
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

Don't re-run this. The errors that remain are mostly single-kanji on'yomi/kun'yomi coin-flips (談 はなし/だん, 角 かど/かく, 相 あい/そう) that no dictionary can settle without context. The two levers that *do* work are **better source data** (adding QQ's romaji track fixed 私, which fugashi and Kugou both got wrong) and, if ever needed, an **LLM pass for homograph disambiguation** — designed below, not yet implemented.

### utaten 的人工注音 (**現在唯一的**外部讀音提示,2026-08-04)

`utaten.py` — 爬 utaten.com 的 ふりがな 歌詞。它是**人標的**,而且伺服器端就渲染成
`<span class="ruby"><span class="rb">漢字</span><span class="rt">かな</span></span>`,不必跑 JS。

拿使用者手改的 `word_corrections` 當標準答案量過 (`scripts/measure_hints.py`;右欄是全庫 utaten 補全後重量的):

| 層 | 命中 (39 詞 / 25 首) | 補全後 (43 詞 / 28 首) | 拔掉羅馬字之後 (43 詞 / 28 首) |
|---|---|---|---|
| L0 只有 fugashi 字典 | 26/39 (67%) | 29/43 (67%) | 29/43 (67%) |
| ~~＋羅馬字 hint~~ (已移除) | **25/39 (64%)** ← 淨負 | 28/43 (65%) ← 仍淨負 | — |
| ＋utaten | **34/39 (87%)** | **38/43 (88%)** | **38/43 (88%)** |

**最右欄就是拔掉羅馬字層之後重跑的數字:一個詞都沒掉**(2026-08-05)。那層在這份樣本裡
本來就完全被 utaten 蓋掉,而它真正的傷害在**沒有 utaten 的那 13%** —— 用
`word_corrections` 當標準答案量不出來,因為那是「使用者看到錯了才手改」的詞,羅馬字層
修對的永遠不會變成一筆 correction,功勞與過失在這張表裡都是隱形的。要看它的真實表現得
拿 utaten 的逐詞注音當**獨立裁判**:161 首裡變對 95 / **變錯 193**,2:1 淨負,所以拔掉。

`--diff` 把同一份資料反過來讀:不是「管線命中幾個」而是「哪幾筆**手改與 utaten 不一致**」
(實跑 5/43,另列出「詞已不在現在的歌詞裡」的死資料)。**只讀不寫,也不要自動刪** ——
`我愛你` 的 `我 うお` 是華語音譯,手改才是對的那一方,沒有任何日文注音來源會有它。

`静寂=しじま`、`談=はなし`、`外=はず`、`逸=はぐ`、`退=ど` 這種字典全滅的特殊唸法它都對。

- **存兩份:`lines` 與 `words`,兩份都必要。**
  - `lines` = `{normalize_line(行): 整行假名}`,直接餵 `apply_hint()`,位置對齊
    (同一個字在不同句可能不同讀音)。
  - `words` = utaten 原生的逐詞讀音,**套用點在 `build_ruby_html` 的 `root_orig` 那一層**
    (不是 token 迴圈:utaten 的 `<rb>` 只有漢字核心 `静寂`,而 fugashi 的 token 常常連著送り仮名
    `覚束ぬ`,比 token 對不上;`root_orig` 正是削掉前後綴後的漢字核心,也就是 `word_corrections`
    的同一把鍵)。**這一層讓命中從 29/39 跳到 34/39** —— `apply_hint` 是按「fugashi 預測的讀音長度」
    去切整行 hint 的,兩邊長度差太多時 (せいじゃく 5 字 vs しじま 3 字) 它的守門會整個放棄,
    而那正是最需要修的那種詞。
  - `words` **只收整首歌讀音唯一的詞**:同一個漢字在不同句唸法不同時 (花人局 的 夜 = よ/よる)
    沒有前後文可判斷,硬套會把對的那句改錯,那種留給 `lines` 處理。
  - `_COMMON_READING` 仍然在 `words` 之上 (那四筆是使用者驗證過的,不該被爬蟲蓋掉);
    `word_corrections` 永遠最上層。
- **搜尋只用歌名,歌手當排序訊號不當條件** —— utaten 用日文歌手名 (`SPITZ` 在那邊叫 `スピッツ`),
  把歌手塞進查詢字串會直接查不到。
- **搜不到時 utaten 回的是一頁推薦清單,裡面照樣有幾十個 `/lyric/` 連結** —— 所以**不能只看有沒有
  `/lyric/`**,要看有沒有 `<table class="searchResult">`。這條踩過,害覆蓋率量成 100%。
- **驗證順序:歌手＋歌名都對得上就採用;對不上才退回行重疊率 (`MIN_OVERLAP` 0.30)。**
  **不要把重疊率變成無條件的門檻** —— 它分不出「不同首歌」與「同一首但斷句不同」:實測
  `サカナクション / アイデンティティ` 只有 8%、`Vaundy / 花占い` 28%,兩首都是對的歌,
  只是 utaten 那份的斷句與標注範圍不同。修掉這條之後覆蓋率 67% → 77%。
  歌手名兩邊寫法常常不同 (`SPITZ` / `スピッツ`),所以歌手對不上時仍然需要重疊率當退路。
- 原名查不到才用 `clean_title()` 去噪重試一次,成功路徑零額外請求。剝三種:`feat.`、左括號之後、
  **破折號尾綴** (` - Live`、` - replica -`、` - ALBUM ver.`)。剝成原曲名是刻意的 —— Live/replica
  是同一份歌詞,注音本來就該一樣;剝過頭的代價只是多打一次搜尋,採用仍要過驗證。
  - **破折號兩邊都要有空白**:沒空白的連字號多半是歌名/團名本身 (`go!go!vanillas`、`n-buna`)。
  - **`_strip_artist_prefix` 一定要排在破折號尾綴前面** —— `ヨルシカ - 春泥棒`、
    `くるり - 琥珀色の街、上海蟹の朝` 是歌手名黏進歌名開頭,剝尾巴只會剩下歌手名。
    判準同 `cleanBrowserQuery` 的「開頭確實等於歌手」(正規化後互相包含),歌手欄可能是
    `ヨルシカ / n-buna / ヨルシカ` 這種複合寫法所以逐段比。**這條讓涵蓋率 85% → 87%。**
- 快取表 `utaten_hints`,形狀同 `lyrics_translations`,**空 `{}` 是負快取**(查過了,utaten 沒這首)。
  平常播到那首歌時順手抓一次;`scripts/backfill_utaten.py` 是一次性補全 (每首之間睡 1 秒,
  這是別人家的網站)。
- **`apply_hint` 不可以加「候選必須與原讀音等長」的門檻。** 那道閘門是 LLM 時代為了擋截斷加的,
  utaten 給的是完整假名,長度變化本身就是正解 (`夜 よる → よ`)。回歸測試 `test_furigana_hint.py`
  第 10 組釘住這條。
- 涵蓋率**全庫實測 87%**(2026-08-04 跑完 `backfill_utaten.py` + 兩輪歌名還原 + `clean_title`
  補剝破折號尾綴:426 首日文歌,有注音 370 / 落空 56)。找到的歌大約 7 成的行有注音。
  - **落空的兩大類都救不到**:(a) 約 20 首**官方歌名本來就是英文** (`水中スピカ / Oshiroi`、
    `muque / TIME`、`NOMELON NOLEMON / SUGAR` —— iTunes JP 自己也登記這個名字);(b) 約 38 首是
    **獨立樂團** (NOMELON NOLEMON 11、CLAN QUEEN 6、Lavt 3、harha 2…),他們連日文歌名的歌 utaten
    也沒收。後者是天花板,**換第二家救不到,而且沒有第二家**(見上一條)。
    **95% 不在射程內,不要再為此找來源;歌名還原這條也已經拉到底 (77% → 85%)。**
  - **utaten 的行重疊率是比時長更好用的歌名證據** —— `scripts/recover_jp_titles.py` 就是這條:
    抓歌手的 iTunes **JP** 曲目列,用「歌詞最後一個時間戳 vs 曲長」排序候選 (時間戳是曲長的下界),
    逐個打 utaten 算行重疊,`≥60%` 採用。對「這首歌沒進過聆聽紀錄」免疫,那正是
    `restore_jp_titles.py` 卡住 28 首的原因。實測對的 78~100%、錯的 0~14%,訊號分得很開。
    - **限制:它分不出原曲/Live版/翻唱** (歌詞一樣)。所以是補時長的不足不是取代 —— 時長證明
      「同一個錄音」,行重疊證明「同一首歌的內容」。腳本因此**只改歌名不改歌手**,候選全取自
      這位歌手自己的曲目列,翻唱從一開始就不在候選裡。
    - **不要排除「庫裡已經有的歌名」**:加過那條,剛好擋掉最該修的情況 (`go!go!vanillas` 的
      `HEIAN` 與 `平安` 兩列同時存在,正是要合併的分裂)。守門本來就是重疊率。
    - **先擋掉「iTunes JP 自己就登記這個英文歌名」的**:30 個目標裡 20 個是這種,
      不擋就是白打 5 次 utaten 再回報「對不上」,看起來像判斷失敗。請求數 94 → 36。
    - **`utaten.fetch_hints` 把 read timeout 吞掉回 `{}`,跟「真的沒這首」分不出來** ——
      連打同一位歌手時會踩到,間隔要 2 秒 (backfill 的 1 秒不夠)。腳本冪等,漏判重跑就好。
  剩下的落空有一半是**歌名還沒還原成日文** (`Could I be yours?`、`HEIAN`) —— 那是
  ROADMAP 的人工確認清單,不是 utaten 的問題;其餘是 utaten 真的沒收 (獨立樂團、新歌)。
- **沒有第二個注音來源可用** (2026-08-04 探過)。uta-net、petitlyrics 的歌曲頁都沒有 ruby;
  kasi-time 網域已死、utamap 連不上;j-lyric / kashinavi 本來就沒有注音功能。
  **要提升覆蓋率,施力點是歌名還原,不是再找一家。**
- **羅馬字那層已於 2026-08-05 拔掉,量測見上面那張表。不要重新提案加回來。**
- 回歸測試 `venv\Scripts\python.exe tests/test_utaten.py` (不打網路);
  `python utaten.py` 是打真站的自我檢查,動到解析或搜尋時跑它。
  `tests/test_recover_titles.py` 釘住 `recover_jp_titles.py` 的候選挑選 (排序要取絕對值、
  不可以排除庫裡已有的歌名)。

### LLM 讀音校正 — 已移除 (2026-08-04)

**量過,淨零,拆掉。不要重新提案。** BYOK 的整套 (`llm_furigana.py`、`llm_hints` 表、
`/api/llm-key`、`/api/llm-furigana/run`、`/api/llm-models`、`secrets.json` + Electron safeStorage、
設定選單的「AI 讀音校正」小節、播放列的魔杖鈕、`apply_hint` 的 `mark` 參數與長度閘門) 全部刪除。

最後一次量測 (5 首歌 16 個詞):字典 9/16 → ＋羅馬字 10/16 → **＋LLM 10/16**。長度閘門確實把它從
淨負 (9/16) 拉回淨零,但也就是淨零。它實際動到的 15 個詞裡約 6 對 8 錯,而且錯的都是它應該要贏的
地方:`無難 ぶなん→ぶかん` (fugashi 本來是對的)、`局 もたせ→きょく` (歌名 `花人局` 就在 prompt
第一行)、`鍵 かぎ→くぎ`。**全曲上下文沒有幫上忙** —— prompt 本來就送整首歌 + 歌名 + 歌手。

順帶消失的是全 app 最敏感的表面:不再有 API key 要保管,`spawnPy` 也不再往環境變數塞任何祕密。

### Credit / title lines

Lines like `作詞：米津玄師` and copyright boilerplate are prefixed with `#TITLE#` so clients can style or skip them. `autoMarkTitleLines()` in **`web-app/title-lines.js`** is the **only** implementation — a duplicate Python copy in `utils.py` was deleted; don't reintroduce one. (It lived inline in `server.js` until it got its own file, for the same reason as `s2t.js`: so the test can require it without starting a server.)

三條規則,順序無所謂但職責不同:

- **`isCreditLabel()` — 標籤式 (`作詞 : 某某`)。判斷的是冒號前那一段,`{1,40}` 字,不是整行長度。** 這是最容易寫錯的地方:製作人員多的時候值會很長 (實測有 109 字的 `编曲 : A/B/…/T`),舊版用 `text.length < 40` 當守門,那批全部漏標。**真正在把關的是「標籤裡有沒有關鍵字」**,日文歌詞裡的真冒號 (`Q:本日の出来栄えは…`、`目が開いてく4:30 A.M.`、`Give me "5:00上がり"`、`16:9の端を…`) 全部是敗在沒有關鍵字,不是敗在長度。
  - **上限曾經是 8 字,那是照中文標籤 (`作詞`/`編曲`) 配的,英文職位名是多字詞組,整批被擋掉** (2026-08-09):`Rec & Mix Engineer：` (18)、`Mastering Engineer：` (18)、`Sound Direction：` (15)、`Lyrics，Composition，Arrangement：` (34) —— `ずっと真夜中でいいのに。/ 消えてしまいそうです` 一首就漏了 5 行。放寬到 40 後全庫 465 首**多標 9 行、全部是真的製作人員列、零誤判**。
  - 同一批補上的關鍵字:`trumpet`/`trombone`/`sax`/`violin`/`cello`/`flute`/`horn`/`percussion`/`direction`/`manipulator`。**是子字串比對,所以 `mixing`/`recording`/`mastering` 不必列** (`mix`/`record`/`master` 已涵蓋)。
- **`isCreditPlain()` — 無冒號式 (`Vocal 初音ミク`)**,這條才需要 `length < 40`,而且**只在標頭區塊內 (`headerIntact`) 才算數**。`music`/`bass`/`lyric`/`drum` 這些關鍵字在英文歌詞正文裡到處都是,不設限就會把唱出來的句子藏成製作人員列 —— 全庫實測誤殺 11 行 (`Greatest music saves the day`、`君へのlyric 隠したlipstick`、`Turn it bass turn it beats`)。標籤式與版權聲明不受這個限制:收在**歌尾**的製作人員列 (實測 TEST/FAST、Kroi/Hyper) 一律是有冒號的那種寫法。
- **`isCopyrightClaim()`** — 版權聲明獨立計分 (命中 ≥3 個「未經/許可/授權/不得…」),因為那種行又長又沒冒號,兩條規則都接不住。
- **`isSongNameLine()` — 歌名行 (整行就是歌名)。判準是「前面每一行都已經是製作人員列」,不是行號、也不是時間戳。** 兩個都實測過都錯:ヨルシカ「あぶく」第 4 行 (t=23.6s) 是唱出來的歌名,前面三行是真歌詞;反過來 muque「TIME」的歌名行在 t=11.6s,但前後都是製作人員列,是真標頭。還要求前面**至少有一行**製作人員列 —— 第 1 行就是歌名時無從判斷是標頭還是開口唱歌名 (WurtS「分かってないよ」第 1、2 行都是歌名),寧可漏標。這條規則需要歌名,所以 `autoMarkTitleLines(lrcText, songTitle)` 有第二個參數,**五個呼叫點都要傳**;沒傳就整條跳過。比對前 `normalizeName` 會把 `「」『』《》""` 剝掉 —— 網易/QQ 的標頭常寫成 `「夜の踊り子」`,不剝就永遠對不上 (全庫漏標 2 首)。剝了也不會誤傷唱出來的引號句,「前面每一行都是製作人員列」那道閘門還壓著。
  - **歌名的版本尾綴兩邊寫法常常不同**:播放器給破折號 (`クズリ念 - Live in Studio_温蔵庫`)、QQ 的標頭給括號 (`クズリ念 (Live in Studio_温蔵庫) - 歌手`),只認一種就整行漏標。`titleVariants()` 因此把「原樣 / 剝括號 / 剝破折號尾綴 / 兩個都剝」四種都拿去比;破折號一樣要**兩邊有空白**,不然會剝爛 `n-buna`、`go!go!vanillas`。
  - **「歌名真的被唱出來」不是理論問題,全庫 53 首有這種行** (`Stand By You` 16 次、`ロックな君とはお別れだ` 8 次),而現行閘門一首都沒誤判 —— 因為那些行前面一定有真歌詞。**任何放寬 (改用行號、時間戳、或允許重複出現) 都會直接踩到這 53 首。**

`CREDIT_KEYWORDS` 與 `LABEL_ONLY_KEYWORDS` **刻意分成兩張表**:單字的 `詞`/`曲`/`鼓`/`唱` 只能在標籤位置比對 (中文歌常見 `词：周杰伦`),放進 `isCreditPlain` 會把「この曲が終わる前に」這種正文整批誤殺。回歸測試 `node tests/test_title_lines.js`,案例全部取自真實快取。

**規則改好之後,舊快取要用 `node scripts/remark_title_lines.js` 補標** (預設 dry-run,`--apply` 才寫入並自動備份)。`autoMarkTitleLines` 只在**寫入時**跑,改進規則不會回頭重標,症狀是畫面上出現一行超長的「歌詞」、實際是一整排編曲名單 (實測最長 109 字)。**它的守門是「重標結果只准多出 `#TITLE#` 前綴」** (外加時間戳後的空白被吃掉,那是 `autoMarkTitleLines` 本來就會做的),其餘任何差異一律跳過那一列 —— 寧可漏標也不要讓一支批次腳本動到歌詞本身。

`config.py` holds the DB path for standalone Python use; `settings.json` (repo root) holds UI settings served via `/api/settings`.

## 行動版（進行中）

iOS PWA 版規格在 `docs/mobile/PWA-SPEC.md`。動到 `web-app/public/mobile/` 或
`/api/lyrics` 端點之前，先讀那份規格，特別是「明確不做」那一節。
**`docs/` 整個在 `.gitignore` 裡 (同 `ROADMAP.md`,是本機檔案)，所以 README 或任何進版控的
文件都不可以連過去 —— GitHub 上會是死連結。clone 下來沒有這個資料夾屬正常。**

Phase 1（靜態頁 + Spotify OAuth PKCE）、Phase 2（輪詢 + 本地插值 + 進度條）、
Phase 3+4（同步歌詞 + 注音）、Phase 5（PWA 化）已完成:`web-app/public/mobile/index.html`
+ `pkce.js` + `playback.js` + `lyrics.js`（純函式獨立成檔的理由同 `public/js/scroll-zone.js`,
測試 require 得到)+ `manifest.json` + `sw.js`。**五個階段都做完了,規格 §7 沒有第 6 階段。**

**後端在 Render 上,不在使用者的電腦上** —— 見下面「雲端唯讀部署」。**手機端零安裝是硬目標:
不要 VPN、不要使用者的電腦開著。** 早期評估過的 Tailscale Serve 那條路因此否決,程式碼與註解
都已清掉,只有 `docs/mobile/PWA-SPEC.md` 那份舊規格還可能提到,以這裡為準。

- **插值的時間軸一律用 `performance.now()`,不可以用 `Date.now()`** —— 後者被系統校時影響會整段跳。
  快照 (`snapshot()`) 記下量測當下的 `at`,`positionAt()` 就是「上次量到的位置 + 之後經過的時間」,
  暫停中不前進、夾在歌曲長度內。每次輪詢回來就覆蓋快照,drift 自動歸零。
- 輪詢間隔由 `pollDelay()` 決定 (播放 3 秒 / 暫停 15 秒),**沒有播放狀態時當暫停**,不要空轉打 API。
  `document.hidden` 時不排下一次 (Safari 背景會凍結 timer),回前景靠 `visibilitychange` 立刻補打一次校正。
- **進度條由 rAF 每幀寫 `width`,所以那個元素刻意不掛 CSS transition** —— 兩邊會互相打架而變黏。
  rAF 在分頁隱藏時瀏覽器自己會停,不必自己管。
- `poll()` 回傳「下次要等多久」的覆寫值:429 照 `Retry-After` 等、401 只清掉記憶體的 access token
  讓下一輪自己用 refresh token 換 (不要退回登入畫面),其餘回 null 走預設間隔。
- 回歸測試 `node tests/test_mobile_playback.js`。

**歌詞走 `GET /api/lyrics`（server.js,行動版專用的無狀態查詢),刻意不共用 `/api/lyrics/fetch`**:
- **不廣播**。`/api/lyrics/fetch` 每條路徑都 `global.broadcast({type:'lyrics_updated'})`,
  手機在播的歌會把桌面與靈動島上顯示的歌詞換掉。
- **自己做歌名還原** (`canonicalArtist` → `getResolvedMetadata` → 再 `canonicalArtist` 一次)。
  手機這條路沒有 `handleMediaUpdate`,Spotify 給的是 `Haru Dorobou` / `魚韻`,不還原就跟桌面的
  cache 鍵分裂,日文歌也查不到。因為是 `await` 的,沒有桌面那個 `state.resolving` 競態。
- **回的是桌面版同一份「帶 `<ruby>` 的 LRC 字串」,不是規格 §4.1 寫的 `lines[]`/`tokens[]`**:
  注音 HTML 已經產好且 `furigana_inject.py` 分詞前就逃逸過,前端 `innerHTML` 畫得出來 ——
  規格第 3 點「給 furigana_inject.py 加 JSON token 輸出模式」因此不必做,Phase 3 與 Phase 4 一起完成。
- 前端用**相對路徑**打它 = 同源請求(頁面本來就是這台 server 服務的),守門一行都不用改,
  設定裡填好 `mobile_origin` 即可。
- `lyrics.js` 的 `parseLrc` **只吃掉 `#TITLE#`**(那不是歌詞)。`#TRANS#`/`#ROMAJI#`/`#WORDS#`
  都掛回同時間戳的那句(`l.trans`/`l.romaji`/`l.words`),**不自成一行**。
- 置中靠寫 `pane.scrollTop`(`scrollTo({behavior:'smooth'})`)而不是 `scrollIntoView` ——
  後者會連整頁的祖先容器一起捲。**只在換行時動**,每幀寫等於吃掉使用者的手動捲動。
- **自動捲動走桌面同一支 `public/js/scroll-zone.js` 的三段規則,不是無條件置中**(2026-08-08)。
  改版前每次換行都 `scrollTo` 置中,使用者往下翻看後面的歌詞,下一句一到(幾秒內)就被拉回來。
  `autoCenter` 是黏著狀態,理由與桌面完全相同(置中後下一句必定往下偏一行,純幾何判定會
  「置中一次又漂出去」)。
  - **脫離同步認 `touchmove` 而不是 `scroll`**:桌面要多一套「最近 1 秒內有手勢」的濾波,是因為
    `scroll` 分不出誰捲的(平滑捲動、視窗重排都會發);這一頁只有手指捲得動它,直接認手勢最省。
    單純點一下不會發 `touchmove`,所以點歌詞跳轉不受影響。
  - 活動行被捲出畫面時跳出「回到目前這句」(`#resync`)。可見性**重用 `scrollZoneAction` 的
    `offscreen`**,不要另外寫一份幾何 —— 兩份會漂,而漂掉的症狀是按鈕該出來時不出來。
  - 按鈕包在 `.lyrics-wrap` 裡絕對定位:放進 `#lyrics` 會跟著捲走,放進 body 那條 flex 則會在
    出現/消失時把歌詞區的高度推來推去。**`#lyrics` 的 `position: relative` 一個字都沒動**。
- `activeIndex(lines, posMs, hint)` 的 `hint` 是「上一幀的答案」。rAF 每幀都要問一次,而原本是
  每幀線性掃全曲(100 行 × 120fps = 每秒一萬多次比較,同時 Wake Lock 正壓著螢幕不熄)。
  **傳錯不會算錯**,只是退回從 -1 開始的線性掃描。
- 進度條**可以拖了**(2026-08-08,`pointerdown/move/up` + `setPointerCapture`,`.hit` 要
  `touch-action: none`)。拖曳期間 `frame()` 靠 `dragRatio` 早退,不然每幀會把手指的位置蓋掉。
- `paintProgress()` 是進度條與時間的**唯一**寫入點,而且**值沒變就不寫**:rAF 是每幀跑的,
  暫停時位置根本不動。`render()` 的「沒有歌」那條也要走它 —— 繞過去的話它記的「上次寫了什麼」
  會過期,下一首歌開頭剛好也算出 0% 時就不寫了,進度條停在上一首的位置。
- `schedule()` 在「快播完」時把下一次輪詢排在歌曲結束那一刻(+400ms 餘裕,下限 500ms)。
  平常 3 秒一次 = 換歌最慢 3 秒才發現,歌詞跟著晚 3 秒才開始抓。**只有播放中且知道長度時才縮**,
  一首歌只會踩到一次。
- 長按設循環點的那半秒有 `.pressing` 回饋:**`transition-delay: 150ms` 是關鍵** —— 一般點擊在
  那之前 class 就被移掉了,完全看不到;撐過去之後背景用 350ms 浮起來,浮滿正好是觸發的那一刻。
  CSS 要排在 `.loop` 後面(同特異度,後者勝)。順帶 `navigator.vibrate?.(15)`:Android 有、iOS 沒有。
- 抽屜可以往左滑關掉。**刻意不做「從左緣滑出來開啟」** —— Safari 分頁模式下左緣往右滑是瀏覽器的
  返回手勢,搶不過;而 standalone 有、分頁沒有的話兩種模式手感又不一致。
- **第一次啟動跳一張手勢說明卡** (`#guide`,`kanaric.mobile.guideSeen`,抽屜裡有「再看一次」)。
  點/長按/連點三個手勢全是隱形的,而桌面有整套 `tourSteps`,這裡本來一個字都沒有。
  卡片蓋在歌詞區上方 (z-index 8,在 scrim 9 / drawer 10 之下),**寫測試時要先收掉它**,
  不然點歌詞會點到卡片。「再看一次」要先 `closeSheet()` —— 抽屜蓋著大半個螢幕。
- **`/js/` 底下那幾支共用檔的清單存在三個地方,加檔案時三邊一起改**:`sw.js` 的 `EXTRA_PATHS`
  (離線抓得到)、`server.js` 的 `MOBILE_SHELL_EXTRA`(雲端 B1 允許清單,漏了就 404)、
  `tests/test_cloud_guard.js` 的靜態頁清單。漏掉任一個都是靜默失敗:`<script>` 404 →
  `karaokePaint`/`nextScrollState` 未定義 → `frame()` 的 rAF 一碰到就丟例外,而
  `requestAnimationFrame` 在函式最後一行,例外一丟就再也沒有下一幀(整頁凍住)。
- 回歸測試 `node tests/test_mobile_lyrics.js`(含 `activeIndex` 的 hint 不准改變答案)、
  `node tests/test_scroll_zone.js`、`node tests/test_cloud_guard.js`。
  **手勢與捲動這類要瀏覽器才驗得到的,repo 裡刻意沒有** —— 這裡沒有 test runner 也不裝 playwright,
  要驗就照 `.Codex/skills/verify` 那條把 playwright 裝進 scratchpad。

**PWA 化 (Phase 5)**:
- **Service Worker (`sw.js`) 只快取 app shell 那六個檔,API 一律走網路** (規格 §5.2)。`fetch` 事件對
  非 `/mobile/` 的路徑**直接 return 不 respondWith**,`/api/lyrics` 與 Spotify 的兩支 API 因此完全
  不經過它。shell 走 cache-first + 背景更新,所以**改了 `index.html`/`*.js` 要把 `CACHE` 的版號往上加**,
  不然舊 shell 會一直命中(`activate` 只清版號不同的)。背景那條 `fetch` 一定要 `.catch` ——
  離線時沒接住就是每次載入一個未處理的 rejection。
- **歌詞快取用 localStorage 不是規格 §4.3 寫的 IndexedDB**:一首幾 KB,不值得為它引入非同步 API。
  整份存在**一個鍵底下的 map** (`kanaric.mobile.lyrics`,id → `/api/lyrics` 的回應),不是一首一個鍵 ——
  淘汰最舊的直接靠物件的鍵順序,不必掃整個 localStorage。**「找不到歌詞」不進快取**,存下去等於永遠不再重試。
- **Wake Lock 在 `visibilitychange` 回前景時要重拿** (規格 §5.3 點名的坑):分頁一隱藏系統就釋放了,
  只在進場拿一次的話切回來螢幕照樣熄。低電量模式會直接拒絕請求,那是正常情況,不要當錯誤吐給使用者。
- **`manifest.json` 目前沒有 `icons`** —— repo 還沒有 app 圖檔 (同「Icon 待辦」那節)。iOS 的 standalone
  是靠 `apple-mobile-web-app-capable` meta 生效的,不缺 manifest 也能跑;有圖之後補 `icons` 與
  `<link rel="apple-touch-icon">` (iOS 那條**只吃 PNG**)。
- **lrclib 備援 (規格 §4.2)**:server 連不上 (電腦關機) 或它也沒有歌詞時,前端**直接**打
  `https://lrclib.net/api/get`。能這樣打是因為 lrclib 有給 CORS header —— **中國平台那三家都沒有**,
  而且 QQ 是 QRC (3DES)、酷狗是 krc (zlib + XOR),手機端沒有路,不要重新提案。
  - 拿到的是**沒有注音的純 LRC**,而且**沒有經過 `furigana_inject.py`,沒有人幫它逃逸過** ——
    畫面是 innerHTML 畫的,所以自己 `escapeHtml()` **整份 LRC 字串**再交給 `parseLrc` (時間戳是 ASCII,不受影響)。
  - **刻意不寫進快取**:存下去的話電腦開回來也永遠換不成有注音的那份。
  - `artist_name` 只送第一位歌手 (`snapshot()` 把 Spotify 的多位歌手 join 成一串,整串送過去查不到)。
- SW 需要 secure context:Render 的 HTTPS 與 `127.0.0.1` 都算,`file://` 直接開不算 (註冊失敗就算了,不影響其他功能)。

**全螢幕歌詞介面 (2026-08-01 改版)**:版面照 Apple Music 的歌詞頁 (`docs/1.jpeg`) —— 頂列是
「⋯ 在左 + 歌名/歌手置中兩行」、歌詞區 `flex: 1` 佔滿、底部只有進度條與控制鈕。`<body>` 是
`height: 100dvh` 的直向 flex 且 `overflow: hidden`,**整頁不捲動,只有歌詞區自己捲**。
- 頂列用**三欄 grid (`40px 1fr 40px`)**,右邊那個等寬空欄是為了讓中間**真的**置中 —— 用
  flex + space-between 的話歌名會被左邊那顆按鈕推偏 40px。
- **封面不顯示** (`#art { display: none }`),畫面底色就是從它採樣來的。但 `<img>` **必須留在 DOM
  且真的載入** —— 主色採樣掛在它的 `load` 事件上;`display:none` 不會阻止圖片下載,所以這樣是安全的,
  **不要改成不插入 `<img>`**。選擇器是 `#art` 不是 `.art`:那個 `<img>` 已經沒有 class 了。
- 歌詞區上下用 `mask-image` 淡出,與頂列/播放列接觸的地方不會硬生生被切斷。**`-webkit-` 前綴不能省**
  (iOS Safari 到現在只認前綴版)。**上緣的淡出寫成固定 `20px` 而不是 %**:寫 % 的話面板一變高淡出區
  就跟著長,又會蓋回第一句。
- **第一句貼在畫面上方而不是正中央**,所以 `.lyrics` 的上緣留白只有 26px(要大於那 20px 淡出,否則第一句
  一開始就是半透明的)。捲不上去時 `scrollTo` 自己會夾住,`syncLyrics` 那條置中邏輯不必改。
  **下緣的 45vh 不能拿掉** —— 沒有它最後幾句永遠捲不到畫面中央,會卡在最底下。
- **`100dvh` 不是 `100vh`** —— Safari 分頁模式的網址列會吃掉高度,`vh` 量的是「網址列收起來時」的值,
  底部播放列會被切掉一截。standalone 模式看不出來,用瀏覽器開就很明顯。
- 歌詞區的 **`position: relative` 不可以拿掉**(理由同改版前:置中靠 `el.offsetTop`,沒有它
  `offsetParent` 變成 `<body>`,多算了頂列的高度)。
- 封面主色 = **`public/mobile/color.js` 的 `pickBg()`**,純函式獨立成檔的理由同 `lyrics.js`。
  數學**照抄電腦版** (`public/js/app.js` 的 `coverImg.onload`):RGB 平均 → ×0.65 壓暗 →
  感知亮度 (`0.299r+0.587g+0.114b`) 大於 80 就把非活躍歌詞改成黑透明。兩邊要看起來是同一個 app,
  不要另外發明一套。
  - **`<img crossorigin="anonymous">` 是前提**:不加的話 canvas 被跨網域污染,`getImageData` 直接丟
    SecurityError。**屬性要寫在 HTML 上** —— 設完 `src` 才補是不生效的。已實測 `i.scdn.co` 有回
    `Access-Control-Allow-Origin: *`。取不到就退回 `FALLBACK`,不要讓整頁跟著壞。
  - 採樣前先把圖縮到 32×32:平均色一樣,但少讀幾十萬個像素。
  - `getComputedStyle(document.body).backgroundColor` **驗不到這件事** —— body 的背景會傳播到
    viewport,computed 值仍是原本的 `--bg`。要驗看 `document.body.style.backgroundColor` 或直接截圖。
- **播放控制需要 `user-modify-playback-state` scope,而改 scope 會讓已存的 `refresh_token` 失效。**
  舊 token 打控制端點只回 403,症狀看起來像「Premium 沒生效」,使用者無從猜起。所以 localStorage 存
  `kanaric.mobile.scope` 記住上次授權用的 scope,進場比對不一致就清掉 refresh token 並提示重新連接。
  **動 `SCOPE` 常數時這段守門不能省。**
  - 控制端點回 204 且不回新狀態,所以 `control()` 要**先改本地快照再送出**(樂觀更新),否則畫面要等
    下一輪輪詢(最多 3 秒)才動,按起來像沒反應;送完 400ms 補一次 `tick()` 校正。
  - **403 不是只有「要 Premium」一種,不可以一律當成免費帳號**。Spotify 對「這個指令在目前狀態下
    不合法」也回 403(`Player command failed: Restriction violated`,`reason` 多半是 `UNKNOWN`)——
    已經暫停了還送 pause、裝置正在切換的那一瞬間都會踩到。舊版把所有 403 都拿去
    `canControl = false` + 收起整排控制鈕(而且要重新載入才會回來),症狀就是**使用者用著用著
    突然被告知「要會員才能控制播放」**(2026-08-02 真實回報)。判準改成看
    `error.reason === 'PREMIUM_REQUIRED'` 或 message 含 premium,其餘只吐一句並排一次校正輪詢
    (樂觀更新已經改過本地狀態,不校正的話圖示會停在錯的那一邊)。
  - **404 不等於「Spotify 沒開」,先自己救一次再說**:暫停一陣子後裝置只是從活躍名單掉出去
    (`/me/player` 回 204、控制端點回 404),app 其實還活著,`/me/player/devices` 常常還列得到它,
    轉移過去就會開始播。所以 `control()` 收到 404 會先跑一次 `transferToDevice()`,失敗才顯示
    救援鈕;只吐錯誤叫使用者去按救援鈕等於同一件事要按兩下。
  - **但「控制中心還顯示著 Spotify」不代表 `/devices` 列得到它** —— 這兩個是解耦的,曾經據此
    推論過所以特別記下來 (2026-08-02 使用者實測推翻):控制中心是 **iOS 本機**的 now-playing
    狀態,app 被系統凍結後仍然留著;`/me/player/devices` 是 **Spotify 雲端**的 Connect 註冊表,
    app 一跟後端斷線就從上面消失。落到「控制中心有、`/devices` 空」的狀態時 **Web API 真的
    無能為力**,只有系統遙控指令 (控制中心本身、或捷徑的「播放/暫停」) 叫得動它 —— 所以那條
    訊息直接寫「請從控制中心按一次播放」,不要只報告一個查不下去的事實。
  - 救援鈕看得見時,輪詢間隔壓到 3 秒(平常暫停是 15 秒)。使用者那時正在想辦法讓它開始播,
    而**拉下控制中心不算頁面隱藏**,`visibilitychange` 那條補不到 —— 不壓的話人按了播放要等
    十幾秒畫面才動,會以為壞掉。
    - **轉移失敗的原因要帶出來** (`transferHint`):手機上沒有 devtools,「列表是空的」「只有受限
      裝置」「查詢失敗」「轉移被拒 403/404」全吐同一句「找不到播放裝置」的話,使用者與我們都
      查不出是哪一種。**轉移那個 PUT 的回應也一定要檢查** —— 不看的話會回報成功而畫面什麼都
      沒發生 (它照樣可能回 404 裝置剛消失、403 非 Premium)。
    - 抽屜裡的「版本」欄直接讀 `caches.keys()` 拿 SW 的快取名字,**不要另外維護一個版號常數**
      (兩份一定會漂)。它存在的理由:改了 `sw.js` 的 `CACHE` 之後沒重整的裝置會一直吃舊 shell,
      症狀是「新功能像是沒做」,而回報者根本無從得知自己在哪一版。
    **但 `pause` 要排除** —— 轉移是帶 `play: true` 的,對「按暫停卻找不到裝置」做這件事會變成
    按暫停反而開始播。
  - **控制中心本身碰不到**:那個 now-playing 是 Spotify 用 `MPNowPlayingInfoCenter` 註冊的,
    遙控指令走 `MPRemoteCommandCenter` 回到那個 app,網頁沒有 API 插得進去。`navigator.mediaSession`
    只管這一頁自己播的媒體;真要搶那個位置得在本頁播無聲音訊,那會把 Spotify 擠掉、而且控制中心會
    顯示 Kanaric 在播但實際發聲的是 Spotify。**不要提案這條。**
  - 進度條**只做點擊跳轉不做拖曳**:拖曳要另外管 pointer 事件、還要在拖曳期間擋掉 rAF 對 `width` 的
    覆寫。程式碼裡留了 `ponytail:` 註解寫升級路徑。點歌詞跳轉直接用 `parseLrc` 結果的 `ms`。
- 設定面板(⋯ 開的 sheet)**除了「片假名標平假名」以外都是純前端項目**:歌詞字級、對齊、
  顯示日文假名(`body.no-furigana` 把 `rt` 藏起來)、中文翻譯(`body.no-trans`)、羅馬拼音
  (`body.no-romaji`)、歌詞來源(唯讀)、Client ID / Token、連接/登出。全部存 localStorage 的
  `kanaric.mobile.prefs`。**Client ID / Token 的 input 只有這一份** —— 未登入時
  自動把 sheet 打開,不再另外做一個 setup 卡片,免得兩個畫面各存各的。「連接 Spotify」與「登出」
  依 refresh token 在不在**互斥顯示**,同時出現只會讓人猶豫該按哪顆(要換 Client ID 就先登出再連接)。
- **中文翻譯與羅馬拼音 (2026-08-04) 都是 `injectFurigana(..., { force: true })` 一律併進來,
  要不要畫由手機自己的 `body.no-trans` / `body.no-romaji` 決定。** 這樣切換開關不必重打端點,
  前端快取裡的那份也永遠是完整的(雲端那台的 `settings.json` 是預設值、桌面那台的設定是
  使用者自己的,兩邊都不該決定手機顯示什麼)。`/api/lyrics` 與 `/api/lyrics/pick` 兩支都要傳
  `force` —— 漏一支的症狀是「套用備選歌詞之後羅馬字消失」。
  - **`force` 併在 `injectFurigana` 裡面,不要改回在端點外面補一次 `applyTranslations`。**
    外面補的那次看不到 `#WORDS#` 已經插在歌詞行後面了(`mergeTranslations`/`mergeRomaji` 的
    防重複只看**下一行**),桌面開著 `show_translation` 時同一句會插出兩行譯文。
  - **`katakana_ruby` 跟另外兩個不同類**:它改的是注音本體(要重跑 python),沒辦法用 CSS 藏,
    所以走 query 參數 `kata=1`,而且**手機的 localStorage 快取鍵要跟著分開**(`cacheId()`:
    `<trackId>|kr` / `<trackId>|r`),兩種各存一份,切回去不必重抓。尾巴那個 `r` 同時讓改版前
    存的舊快取自然失效 —— 沒有它的話,開了「顯示羅馬拼音」在快取命中的歌上完全沒反應。
  - `parseLrc` 把三種標記行都掛回同一個時間戳的那句,`showLyrics` 依 歌詞 / `.rj` / `.tr` 的
    順序畫(與桌面同序);**卡拉OK的 `rejectSel` 要一起排除 `.rj`**,不然羅馬字會被切成字元跟著填色。
- 回歸測試 `node tests/test_mobile_color.js`。

**四個歌詞工具 (2026-08-02)**:版面分兩處 —— **播放列上方那條工具條只放微調時間軸**
(要邊聽邊調,抽屜幾乎蓋滿螢幕就沒辦法對);**段落循環的狀態、說明與取消鈕在抽屜裡**
(它靠長按操作,不需要常駐的控制項),重新載入與備選歌詞也在抽屜。備選歌詞另外加一支端點。
搬法的總則是 **雲端那台的 B1 允許清單是 GET-only**,所以桌面用 POST 寫 DB 的一律改成寫手機自己的
localStorage —— 不是偷懶,雲端本來就刻意不帶使用者手打的資料,而且手機與桌面的視覺延遲不同,
共用一個偏移值反而錯。

- **微調時間軸**存 `kanaric.mobile.offsets`(`{trackId: 秒}`,上限 200),±0.1 秒一格。
  **套用點只有 `syncLyrics(pos - offsetMs)`,進度條與時間顯示不能減** —— 那是真實播放位置(桌面同理)。
  連帶地點歌詞跳轉與循環跳回都要 `lines[i].ms + offsetMs`,不加就會跳到偏移前的位置。
  改完要自己把舊的 `.on` 拿掉再把 `activeLine` 設 -1,不然高亮要等下一句才更新。
- **段落循環**是長按歌詞 500ms 設 A/B(不做模式開關,短按仍然是跳轉)。A、B 存的是**行號**不是秒。
  - **`suppressClick` 要在 pointerdown 清掉而不是在 click 裡消耗** —— 長按之後不保證會有 click,
    留著 true 就會吃掉下一次真正的點擊。
  - iOS 的選取泡泡要**兩件一起**才擋得住:`.lyrics p` 的 `-webkit-touch-callout/user-select`
    加上歌詞區 `preventDefault` 掉 `contextmenu`,少一件就會看到泡泡蓋在歌詞上。
  - **跳回時那個 2 秒的 `loopSeekUntil` 窗是必要的**:`seek()` 是樂觀更新,本地位置立刻回到 A,
    但 400ms 後補的那次輪詢很可能拿到 Spotify 還沒跳完的舊位置(≈B),`setTrack` 一寫回去下一幀
    又觸發,就變成每秒狂送 seek 打爆限流。桌面用 `pendingSeekTarget` 擋同一件事。
  - 終點算在 `lyrics.js` 的 `loopEndMs()`(純函式,理由同 `parseLrc`),數學照桌面的 `loopEndTime()`:
    B 的下一句開頭,離太遠(尾段間奏)就提早在 `B + 一句長 × 1.6`。「一句長」= `medianGap()`,
    取**中位數**不是平均(平均會被尾段間奏拉爆),且只算正的間隔(副歌重複行的差是 0)。
  - 取消的入口有兩個:抽屜裡的「取消循環」鈕,以及**在反白的那幾句上連點兩下**。
    連點是自己判的(記上一次點的行號與時間,300ms 內同一句且那句有 `.loop` 就取消),
    **不要改用 `dblclick`** —— iOS 的雙擊同時是縮放手勢,交給瀏覽器判會多一層不確定性。
    第一下照舊會跳轉(那句本來就在循環段內,跳過去無害),第二下只取消、不再跳。
  - 換歌 / 重新載入 / 套用備選歌詞都 `clearLoop()`,行號只對得上同一份歌詞。**不做跨頁記憶**。
- **重新載入**只刪 `kanaric.mobile.lyrics` 裡這首的鍵再 `loadLyrics()`,**不是強制上網重抓**
  (語意與桌面 `lyrics-tools.js` 一致):雲端 cache 裡若是一份爛歌詞,重載還是它,那時要用備選歌詞。
  偏移值不清,那是使用者調的。
- **備選歌詞**多一支 **`GET /api/lyrics/pick?title&artist&index=N`**:從記憶體的 `optionJobs` 取第 N 個,
  跑 `toTraditional` → `autoMarkTitleLines` → `injectFurigana` → `applyTranslations`,回**與
  `/api/lyrics` 完全相同的形狀**。
  - **不寫 DB、不廣播**(同 `/api/lyrics` 的規矩:手機換歌詞不能動到桌面與靈動島)。持久化是手機把回應
    寫進自己的 localStorage 快取 —— 那是 `loadLyrics` 的第一順位,所以「套用」自然是永久的,直到重新載入。
  - 找不到 job 回 **409**,前端看到就自己重跑一次搜尋。
  - 端點的鍵是 **server 還原後的 (title, artist)**,不是 Spotify 給的原字串 —— 所以前端記 `lyricsMeta`
    (`/api/lyrics` 回應裡的那兩欄),用它去打 options/state/pick。
  - `optionJobs` 加了 **20 筆上限**:那個 Map 本來只增不減,每個 job 帶著五份完整歌詞,
    在雲端那台(512MB、公開端點)就是慢性漏。
  - `/api/lyrics/options/state` 多吃 **`brief=1`**(拔掉歌詞本體):一次搜尋要輪詢十幾次,
    每次夾帶五份完整歌詞就是幾百 KB 的行動網路流量,而手機在按下去之前不需要內文。
  - **自訂搜尋關鍵字 (2026-08-08)**:抽屜裡兩個輸入框,搜不到時自己打歌名/歌手 (桌面
    `lyrics-tools.js` 的 `manualSearchLyrics`)。手機比桌面更需要它 —— Spotify 給的常是羅馬字名,
    iTunes 還原失敗整首就查不到。server 端**本來就支援**,只是手機沒送那兩個參數。
    - **帶 `searchTitle`/`searchArtist` 就一定要一起帶 `force=1`**:`startOptionsJob` 對同一個
      `(artist,title)` 有現成的 job 就直接回傳,不 force 的話換了關鍵字什麼都不會發生,
      而且**沒有任何錯誤訊息**。
    - **`optQuery()` (state/pick 用的鍵) 不准帶自訂關鍵字** —— server 的 `jobKey` 就是
      `artist|||title`,帶別的進去 state/pick 就查不到那個 job。
    - **只有真的改過輸入框才帶**:帶了就是 server 那邊的 `explicit`,它刻意不寫快取
      (那兩張表的鍵是「正在播的這首」,而輸入框讓人打任何歌名)。沒改就不帶,快取照舊寫得進去。
    - 打過的關鍵字存 localStorage 的 `kanaric.mobile.search` (桌面 `search_overrides` 的手機版,
      那張表要 POST 所以搬不過來)。**只影響備選歌詞那條路** —— `/api/lyrics` 不吃 `searchTitle`;
      但挑中的那份本來就會寫進本機快取,所以效果一樣是持久的。改回歌名本身 = 清掉覆蓋。
  - **候選的格式標籤與桌面同一套三分法** (`optFormat`:逐字 / LRC / TXT)。舊版只分
    LRC / 純文字,看不出哪一份帶逐字時間。**`brief=1` 只拔 `lyrics` 本體**,`hasWords`/`isSynced`
    本來就在回應裡,不必動 server。
  - **B1 允許清單多放行這三支 GET,限流各自分桶**:`options` 5/5 分鐘(最貴,實測 25.7 秒)、
    `options/state` **不計入**(不然輪詢會把自己擋掉)、`pick` 沿用 30/分。
    `/api/lyrics/custom` 這類寫入路由**維持 404**。
  - 回歸測試 `node tests/test_cloud_guard.js`(三支的 token 閘門 + 分桶限流 + 寫入路由仍是 404)。

**做過又移除的:鏡像模式** (2026-07-28,commit `8bef724` 加入、同日移除)。手機連 server 的
WebSocket 直接吃 `media_state` 廣播、不打 Spotify,角色跟靈動島一樣。**移除的理由不是它不好用,
是它要求手機連得到使用者的電腦**(當時是 VPN),違反零安裝。要翻實作看 git 歷史,不要重新提案。
(那次順手做的 `broadcastMediaState()` 節流留下來了,那是獨立的修正。)

### 雲端唯讀部署 (Render)

**為什麼存在**:使用者家裡沒有固網,電腦靠手機分享上網 —— 人一離開家,電腦就完全斷網,
行動版只剩 lrclib。所以「家裡放一台常開機器」那條路不成立,歌詞後端必須在雲端。

跑的是**同一份 `server.js`**,靠 `CLOUD_MODE=1` 開四個閘門,**桌面模式的行為一個字都不變**:

- **B1 允許清單 middleware** —— 放在同源守門**之前**。非 GET/HEAD 一律 404;只放行
  `/mobile/*` 與 `GET /api/lyrics`(要 `X-Kanaric-Token`);其餘**回 404 而不是 403**,
  連「有這條路但你沒權限」都不透露。`/api/settings`、`/api/restore`、`/api/db-clear`、
  `/api/llm-key` 因此在那台**根本不存在**,不必為了上雲做帳號系統。
  - `/` 與 `/mobile`(少了結尾斜線)**302 轉到 `/mobile/`**,使用者只要記一個網域。
    **是轉址不是把頁面搬到根路徑** —— 搬過去 `redirect_uri` 會變成 origin + `/`,而
    `<script src="pkce.js">` 那三支相對路徑會指到 `/pkce.js` 全部 404。用 302 不用 301,
    301 會被瀏覽器硬快取,以後想改就改不動。
  - **`MOBILE_TOKEN` 沒設定時一律 401**。不能只寫 `req.get(...) !== process.env.MOBILE_TOKEN` ——
    兩邊都是 `undefined` 會相等而放行,設定漏了就變成公開的免費歌詞 API 且沒有任何徵兆。
  - **限流是必要的不是防禦性程式**:每次 cache miss 都會打三家平台 + spawn 一個 Python 程序,
    被洗會吃光 512 MB 那台的 CPU,還可能害這台 IP 被三家封鎖。前端 `poll()` 本來就看得懂
    429 + `Retry-After`。
- **B2 綁 `0.0.0.0` 且用 Render 指定的 `PORT`**,不走 `findFreePort` —— 換一個 port,
  Render 探測不到會判定部署失敗。「不綁 0.0.0.0」那段註解的理由在雲端不成立(沒有寫入路由、沒有 key)。
- **B3 `PUBLIC_ORIGIN` 加進 `ALLOWED_ORIGINS`**:那台的頁面是它自己服務的(同源),
  Safari 對同源 GET 多半不送 `Origin`,但送了就會撞守門。
- **B4 `verifyClient` 一律回 false**:雲端沒有正當的 WebSocket 客戶端,而 upgrade 不經過
  express middleware,B1 擋不到它。

**中國三家從 `singapore` region 打得通,已實測** (2026-08-01,線上第一首歌的「歌詞來源」
是 NetEase)。這是上雲前最後一個未知數 —— 全不通的話那台只剩 lrclib,連中文譯文與逐字時間
都會整個沒有。動 region 之前要重驗這件事:線上看「歌詞來源」那一列寫什麼,
或直接在那台機器上跑 `python3 scripts/check_cn_reachability.py` (只要 requests + jaconv,
不必裝 fugashi/unidic;必須從 repo 根目錄跑)。

**已知落差,不是 bug**:
- 雲端**沒有 `word_corrections` / `artist_aliases`**(使用者定案不帶上去)。注音等於少掉最上面
  那一層(utaten + `_COMMON_READING` 仍在),手改過的那幾十個詞在雲端會回到自動讀音。
- **磁碟是暫時的**:Render 免費方案重啟就清空,歌詞快取每次都要重抓。它本來就是快取。
- **冷啟動 30~60 秒**(閒置 15 分鐘休眠)。前端等超過 3 秒會把狀態改成「喚醒伺服器中」,
  **刻意不加 timeout 中斷請求** —— 中斷了就永遠喚不醒。
  - 使用者端的解法是 **iOS 捷徑的自動化**(零程式改動):「當我打開 Spotify」→ 立即執行 →
    **「取得 URL 的內容」** 打 `https://<服務>.onrender.com/mobile/manifest.json?wake=1`。
    挑歌那幾十秒剛好拿來讓 Render 起來,切到 Kanaric 時歌詞多半已經抓得到。
    - **一定要選「立即執行」**(iOS 16.4+),否則 iOS 只推一則通知等使用者點,等於沒省到時間。
    - 動作只有「取得 URL 的內容」能用:它是唯一「在捷徑內部真的送出 GET 又不把人踢出 Spotify」的。
      「打開 URL」會跳去 Safari 顯示一坨 JSON;「URL」/「從輸入項目取得 URL」/「取得 URL 組件」
      根本不連網(分別是常數、抽取、字串拆解);「展開 URL」是追短網址的 redirect,語意不對而且
      `manifest.json` 沒有 redirect,行為不保證。
    - **打靜態檔不打 `/api/lyrics`**,理由同 `index.html` 裡那段喚醒 ping 的註解:那支會查 DB、
      spawn Python、對外打三家平台,拿它當喚醒可能害那台的 IP 被三家限流。

部署檔:`Dockerfile`(node:20-bookworm-slim + venv;`requirements.txt` 現場 `grep -v '^winrt'`,
**不維護第二份清單**,兩份一定會漂)、`.dockerignore`、`render.yaml`。
`server.js` 的 `venvPythonPath` 在 Linux 上找不到 `venv/Scripts/python.exe` 會 fallback 到 `python`,
Dockerfile 的 venv 正好讓 PATH 上有它 —— 零程式碼改動。

回歸測試 `node tests/test_cloud_guard.js`。**動到 B1~B4 任何一處都要跑它**,
而且 `tests/test_origin_guard.js`(非雲端)也要照舊全過,那是桌面模式沒被改壞的證明。

**規格 §6.1 那條最高風險已實測過關 (2026-07-28)**:iPhone 從主畫面圖示啟動、跑完整個
授權導回後仍在 standalone (`navigator.standalone === true`,沒有掉回 Safari)。整個 PWA
方案成立,不必再重測 —— 當時頁面上那列 `standalone` 是為這條驗收留的,**驗完已經拿掉**
(連同 `progress_ms`/`is_playing`/`track id` 三列除錯資訊),要重驗自己在 console 打一次就好。

- **這一頁不經過 Kanaric 的 API,只打 `accounts.spotify.com` 與 `api.spotify.com`。**
  所以同源守門一行都不用改:`express.static` 已經在服務 `public/`,頁面自己的 `<script src>`
  是 same-origin,而從授權頁導回來是「跨站頂層導覽 GET + `Sec-Fetch-Dest: document`」,
  正好命中守門既有的例外。
- **`redirect_uri` 由 `location.origin + location.pathname` 推出來**,同一份程式碼在
  `http://127.0.0.1:5720/mobile/`(loopback 是 Spotify 唯一不強制 HTTPS 的形式,而且**必須是
  IP 不能寫 localhost**)與 `https://<服務>.onrender.com/mobile/` 都正確 —— 兩條都要在
  Spotify Dashboard 註冊。結尾的 `index.html` 一定要剝掉,對不上就是 INVALID_CLIENT。
- Client ID 存 localStorage(公開值);`refresh_token` 存 localStorage、`access_token` 只在記憶體。
  **不可以引入 client secret**,PKCE 就是為了不需要它。
- **行動版打 `/api/lyrics` 是同源請求**(頁面由雲端那台自己服務),守門一行都不用改。
  規格 §4.1 寫的「加 CORS header」是錯的方向(開 CORS 等於自己拆掉那道牆)。桌面這台的
  `mobile_origin` 因此預設留空 —— 沒有任何外部來源需要放行。
