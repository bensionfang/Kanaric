# 🎵 Floating Lyrics 期末報告 - 完整實施計劃

**總工期**: 7-10 天  
**最終目標**: 保留 PyQt6 原有功能 + 新增 Node.js 網頁版統計和播放  
**報告方式**: 展示網頁版本，進階模式可啟動 PyQt6 桌面版

## 🧭 計劃大綱

1. **準備與環境檢查**：確認 Node.js、Python、PyQt6、SQLite 及目錄結構。
2. **建立 Web 專案**：在 `web-app` 下初始化 Node.js 和 Express 專案。
3. **實作後端 API**：提供歌曲列表、播放記錄、統計、以及啟動 PyQt6 的接口。
4. **實作前端頁面**：首頁含簡單播放器與進階模式按鈕；統計頁顯示排行榜與時間線。
5. **整合 PyQt6**：進階模式按鈕啟動原有桌面版，並保持統計資料共用。
6. **測試與優化**：測試 API、前端頁面、PyQt6 啟動、統計數據正確性。
7. **報告演示**：準備演示流程、常見問題與備援方案。

---

## 📋 **Phase 0: 準備工作 (第 0.5-1 天)**

### 0.1 檢查環境
```bash
# 確認 Node.js 已安裝
node --version
npm --version

# 確認 Python + PyQt6 環境可用
python --version
python -c "import PyQt6; print('PyQt6 OK')"
```

### 0.2 檢查現有文件
```
c:\Users\bensi\Desktop\Floating-Lyrics\
├─ main.py                     ✓ 保留 (PyQt6 版本)
├─ requirements.txt            ✓ 保留
├─ lyrics_data.db              ✓ 共享資料庫
├─ README.md                   
├─ settings.json               ✓ 保留
├─ venv/                        ✓ Python 虛擬環境
└─ web-app/                     ✗ (新建)
```

---

## 📁 **Phase 1: Node.js 項目初始化 (第 1-2 天)**

### 1.1 創建目錄結構
```bash
cd c:\Users\bensi\Desktop\Floating-Lyrics
mkdir web-app
cd web-app
```

### 1.2 初始化 npm 項目
```bash
npm init -y
npm install express ejs sqlite3 cors body-parser dotenv
npm install --save-dev nodemon  # 開發時自動重啟
```

預期目錄結構：
```
web-app/
├─ node_modules/               (自動生成)
├─ package.json                ✓ (已創建)
├─ package-lock.json           (自動生成)
├─ .env                        (需創建)
├─ server.js                   (需創建)
├─ views/                      (需創建)
│  ├─ layout.ejs
│  ├─ index.ejs
│  └─ stats.ejs
├─ public/                     (需創建)
│  ├─ css/
│  │  └─ style.css
│  └─ js/
│     └─ app.js
└─ README.md                   (可選)
```

### 1.3 驗證步驟
```bash
# 檢查 npm 套件是否正確安裝
npm list --depth=0

# 預期輸出應包含:
# express@^4.18.0
# ejs@^3.1.0
# sqlite3@^5.1.0
# ... 等等
```

---

## 📝 **Phase 2: 創建所有必要文件 (第 2-3 天)**

### 2.1 創建配置文件

#### `web-app/.env`
```env
PORT=3000
DB_PATH=../lyrics_data.db
NODE_ENV=development
```

#### `web-app/server.js` 
(見下面完整代碼)

### 2.2 創建視圖文件 (EJS 樣板)

#### `web-app/views/layout.ejs`
(基礎模板)

#### `web-app/views/index.ejs`
(首頁 - 簡單 + 進階模式)

#### `web-app/views/stats.ejs`
(統計頁面)

### 2.3 創建靜態文件

#### `web-app/public/css/style.css`
(所有 CSS 樣式)

#### `web-app/public/js/app.js`
(前端 JavaScript 邏輯)

### 2.4 驗證步驟
```bash
# 檢查所有文件是否創建
dir web-app
dir web-app\views
dir web-app\public\css
dir web-app\public\js

# 每個文件不應為空
```

---

## 🚀 **Phase 3: 啟動和測試後端 (第 3-4 天)**

### 3.1 啟動 Node.js 伺服器
```bash
cd web-app
npm start

# 預期輸出:
# ✓ Connected to SQLite database
# ✓ listening_history table ready
# 🚀 Floating Lyrics Web Server running on http://localhost:3000
# 📊 Stats page: http://localhost:3000/stats
```

### 3.2 測試後端 API (使用 curl 或 Postman)

#### 測試 API 端點

1. **獲取歌曲列表**
```bash
curl http://localhost:3000/api/songs
```
預期: 返回 JSON 數組，包含 `cache` 表中的所有歌曲

2. **測試播放事件記錄**
```bash
curl -X POST http://localhost:3000/api/play-event ^
  -H "Content-Type: application/json" ^
  -d "{\"artist\":\"テストアーティスト\",\"title\":\"テスト曲\",\"duration\":180}"
```
預期: `{"success":true,"message":"Play event recorded"}`

3. **獲取統計摘要**
```bash
curl http://localhost:3000/api/stats/summary
```
預期: 返回 JSON，包含 `totalSongs`, `totalPlays`, `totalTime`

4. **獲取排行榜**
```bash
curl http://localhost:3000/api/stats/top-songs
```
預期: 返回 JSON 數組，包含 Top 10 歌曲

5. **獲取時間線**
```bash
curl http://localhost:3000/api/stats/timeline
```
預期: 返回 JSON 數組，包含過去 7 日的播放數據

### 3.3 前端測試

在瀏覽器打開：
- http://localhost:3000 (首頁)
- http://localhost:3000/stats (統計頁面)

檢查清單:
- [ ] 導航欄正常顯示
- [ ] 簡單模式能加載歌曲列表
- [ ] 進階模式有「啟動 PyQt6」按鈕
- [ ] 統計頁面能加載數據（初次為空）

---

## 🔧 **Phase 4: 集成 PyQt6 啟動功能 (第 4-5 天)**

### 4.1 修改 `server.js` - 添加 PyQt6 啟動 API

在 `server.js` 中添加以下代碼（在其他 API 端點之後）：

```javascript
const { spawn } = require('child_process');
const path = require('path');

// 啟動 PyQt6 應用
app.post('/api/launch-pyqt6', (req, res) => {
  try {
    const mainPyPath = path.join(__dirname, '..', 'main.py');
    
    // 檢查 main.py 是否存在
    const fs = require('fs');
    if (!fs.existsSync(mainPyPath)) {
      return res.status(404).json({ 
        error: 'main.py not found at ' + mainPyPath 
      });
    }

    // 啟動 Python 進程
    const pythonProcess = spawn('python', [mainPyPath], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(__dirname, '..')
    });

    pythonProcess.unref();

    res.json({ 
      success: true, 
      message: 'PyQt6 application launched successfully',
      pid: pythonProcess.pid 
    });
  } catch (err) {
    res.status(500).json({ 
      error: err.message 
    });
  }
});
```

### 4.2 修改 `views/index.ejs` - 更新 PyQt6 按鈕邏輯

已經在代碼中包含，確認按鈕事件監聽正確。

### 4.3 測試 PyQt6 啟動
```bash
# 在瀏覽器打開進階模式，點擊「啟動 PyQt6」按鈕
# 應該看到 PyQt6 視窗打開

# 或用 curl 測試:
curl -X POST http://localhost:3000/api/launch-pyqt6
```

---

## 📊 **Phase 5: 完善前端和美化 (第 5-6 天)**

### 5.1 優化頁面樣式

在 `public/css/style.css` 中已包含完整樣式，檢查：
- [ ] 顏色和佈局美觀
- [ ] 響應式設計正常
- [ ] 按鈕和表單控制清晰

### 5.2 優化 JavaScript 邏輯

在 `public/js/app.js` 和 EJS 文件中的 `<script>` 標籤中：
- [ ] 歌曲加載成功
- [ ] 播放事件記錄成功
- [ ] 統計數據實時更新

### 5.3 添加加載動畫和錯誤提示

在 `views/stats.ejs` 中已包含，確保：
- [ ] 統計頁面每 5 秒自動刷新
- [ ] 錯誤訊息能清楚顯示

---

## 🧪 **Phase 6: 完整集成測試 (第 6-7 天)**

### 6.1 測試場景 1: 網頁版播放和統計

1. 啟動 Node.js 伺服器
2. 打開 http://localhost:3000
3. 在簡單模式選擇歌曲
4. 模擬播放（或手動發送播放事件）
5. 切換到統計頁面，驗證數據更新

### 6.2 測試場景 2: PyQt6 集成

1. 在網頁版進階模式點擊「啟動 PyQt6」
2. 確認 PyQt6 視窗打開
3. 在 PyQt6 播放歌曲
4. 返回網頁版統計頁面，驗證播放已記錄

**預期結果**: 兩個應用的播放次數累計在統計頁面顯示

### 6.3 測試場景 3: 並發訪問

1. 同時運行 PyQt6 和網頁版
2. 兩邊分別播放不同歌曲
3. 驗證資料庫無衝突、數據正確累計

---

## 📝 **Phase 7: 報告準備 (第 7-8 天)**

### 7.1 準備報告稿

**技術架構說明**:
```
我設計了一個雙版本的音樂播放和統計應用：

1. 保留原有的 PyQt6 桌面應用
   - 完整的歌詞顯示和假名標註功能
   - 用戶可以像以前一樣使用

2. 新增 Node.js + Express Web 應用
   - 提供網頁介面
   - 簡單模式：基礎播放器
   - 進階模式：啟動 PyQt6

3. 共享 SQLite 資料庫
   - 兩個應用記錄到同一個 listening_history 表
   - 統計數據自動累計

4. Stats.fm 風格統計
   - 排行榜（Top 10）
   - 聽歌時間線（過去 7 日）
   - 統計卡片（總曲數、總播放次數、總時長）
```

### 7.2 準備演示素材

準備以下文件和資料：
- [ ] 截圖：網頁首頁
- [ ] 截圖：簡單模式
- [ ] 截圖：統計頁面
- [ ] 截圖：PyQt6 應用
- [ ] 視頻或演示流程

### 7.3 準備回答教授的問題

常見問題及答案：

**Q: 為什麼用 Node.js？**
> A: Node.js 事件驅動、異步特性適合 Web 應用。npm 生態豐富，易於集成 Express 框架和 SQLite。相比於 Python Flask，Node.js 性能更好，是現代網頁開發的主流選擇。

**Q: Express 框架的作用是什麼？**
> A: Express 是 Node.js 的 Web 框架，負責：
> - 定義路由（GET /、POST /api/play-event 等）
> - 提供 API 端點給前端調用
> - 處理 HTTP 請求和響應
> - 簡化中間件管理（CORS、bodyParser 等）

**Q: SQLite 資料庫怎樣跨應用共享？**
> A: 兩個應用（PyQt6 和 Node.js）都連接到同一個 `lyrics_data.db` 檔案。當 PyQt6 記錄播放事件，Node.js 立即能讀到新數據。我用了 SQLite 的 WAL（Write-Ahead Logging）模式避免並發衝突。

**Q: 前端怎樣與後端通信？**
> A: 使用 JavaScript 的 `fetch()` API 調用後端的 RESTful API：
> - GET /api/songs - 獲取歌曲列表
> - POST /api/play-event - 記錄播放
> - GET /api/stats/top-songs - 獲取排行榜
> 後端返回 JSON 格式數據，前端用 JavaScript 解析並動態更新 HTML。

**Q: PyQt6 和網頁版怎樣切換？**
> A: 網頁版有兩種模式：
> - 簡單模式：純網頁播放器（HTML5 audio）
> - 進階模式：點擊按鈕啟動 PyQt6
> 用戶可根據需求選擇。兩個應用共享統計數據。

**Q: 怎樣記錄播放事件？**
> A: 當音樂播放結束，前端自動發送 POST 請求到 `/api/play-event`，包含藝術家、歌名、播放時長。後端更新 `listening_history` 表的計數。

**Q: 統計圖表怎樣生成？**
> A: 後端提供統計 API，返回原始數據（歌曲、播放次數、日期等）。前端用 Chart.js 庫將數據渲染成圖表（柱狀圖、表格等）。

**Q: 你遇到的最大技術挑戰是什麼？**
> A: 最大的挑戰是確保 PyQt6 和 Node.js 在並發訪問 SQLite 時不出現數據衝突。我通過啟用 SQLite 的 WAL 模式和適當的錯誤處理解決了這個問題。

---

## 🎬 **Phase 8: 報告演示 (第 8-9 天)**

### 8.1 演示流程 (約 10-15 分鐘)

#### 步驟 1: 啟動網頁伺服器
```bash
cd web-app
npm start
```
在瀏覽器打開 http://localhost:3000

#### 步驟 2: 展示簡單模式
- 解釋簡單模式使用原生 HTML5 audio
- 演示歌曲選擇和播放控制

#### 步驟 3: 展示進階模式
- 點擊進階模式切換
- 展示「啟動 PyQt6」按鈕
- 點擊按鈕，啟動 PyQt6 應用

#### 步驟 4: PyQt6 應用演示
- 展示桌面應用的歌詞和假名功能
- 播放一首歌曲

#### 步驟 5: 返回網頁版統計
- 切換到統計頁面
- 展示排行榜、播放次數、時間線
- 刷新頁面確認數據更新

#### 步驟 6: 技術說明
- 解釋後端 API 架構
- 說明資料庫共享方案
- 展示關鍵代碼片段

### 8.2 演示環境檢查清單

報告前一小時：
- [ ] Node.js 伺服器能成功啟動
- [ ] 網頁在 http://localhost:3000 能正常打開
- [ ] PyQt6 能通過按鈕成功啟動
- [ ] 統計頁面數據能正常加載
- [ ] 網絡連接穩定

### 8.3 應急方案

如果遇到問題：
- **伺服器啟動失敗**: 檢查 package.json 依賴、重新執行 `npm install`
- **資料庫連接錯誤**: 確認 `lyrics_data.db` 文件存在且路徑正確
- **PyQt6 無法啟動**: 手動啟動 PyQt6 作為替代，說明技術細節

---

## ✅ **驗證清單**

### 開發完成驗證
- [ ] Node.js 項目成功初始化
- [ ] 所有文件創建完成，無語法錯誤
- [ ] npm 套件正確安裝
- [ ] SQLite 資料庫連接成功
- [ ] 所有 API 端點測試通過
- [ ] 前端頁面能正常加載
- [ ] 統計圖表能正常渲染

### 功能驗證
- [ ] 簡單模式播放器工作正常
- [ ] 進階模式能啟動 PyQt6
- [ ] 播放事件能正確記錄
- [ ] 統計數據能正確計算
- [ ] 排行榜排序正確
- [ ] 時間線圖表顯示正確

### 報告驗證
- [ ] 技術架構圖清晰
- [ ] 報告稿準備完整
- [ ] 回答常見問題有信心
- [ ] 代碼有註釋，易理解
- [ ] 演示流程順暢

---

## 📊 **時間統計**

| 階段 | 工作 | 時長 | 完成日期 |
|------|------|------|---------|
| 0 | 準備環境 | 0.5-1 天 | 5/27 |
| 1 | 項目初始化 | 1-2 天 | 5/28 |
| 2 | 創建文件 | 1-2 天 | 5/29-30 |
| 3 | 後端測試 | 1-2 天 | 5/31-6/1 |
| 4 | PyQt6 集成 | 1-2 天 | 6/2-3 |
| 5 | 前端優化 | 1-2 天 | 6/4 |
| 6 | 完整測試 | 1-2 天 | 6/5 |
| 7 | 報告準備 | 1-2 天 | 6/6 |
| 8 | 報告演示 | 1 天 | 6/7+ |
| **總計** | | **9-16 天** | |

---

## 📚 **所需文件清單**

### 後端文件
- ✅ `web-app/server.js` - Express 主程式（含所有 API）
- ✅ `web-app/.env` - 環境配置
- ✅ `web-app/package.json` - npm 依賴

### 前端文件
- ✅ `web-app/views/layout.ejs` - 基礎樣板
- ✅ `web-app/views/index.ejs` - 首頁
- ✅ `web-app/views/stats.ejs` - 統計頁面
- ✅ `web-app/public/css/style.css` - 樣式
- ✅ `web-app/public/js/app.js` - 前端邏輯

### 原有文件（保留）
- ✅ `main.py` - PyQt6 應用
- ✅ `lyrics_data.db` - SQLite 資料庫
- ✅ `requirements.txt` - Python 依賴

---

## 🎯 **最終目標**

完成後，你將有：
1. ✅ 完整功能的網頁版應用
2. ✅ 保留原有 PyQt6 桌面版功能
3. ✅ 共享資料庫的統計功能
4. ✅ 專業的報告演示
5. ✅ 清晰的技術解釋能力

---

**開始日期**: 2026年5月27日  
**目標完成日期**: 2026年6月6日  
**報告日期**: 2026年6月7日+

✅ 已整合的完整計劃
目標
保留原有 PyQt6 桌面版功能
新增 Node.js + Express 網頁版
網頁版首頁提供：
簡單模式：HTML5 播放器
進階模式：按鈕啟動 PyQt6 桌面版
共用同一個 lyrics_data.db，統計數據可供兩者使用
報告演示重點：網頁版 + PyQt6 桌面版對比展示
技術棧
後端：Node.js + Express
前端：EJS + HTML + CSS + JavaScript
資料庫：SQLite (lyrics_data.db)
桌面版：Python + PyQt6
圖表：推薦 Chart.js
開發工具：npm, node, python
目錄結構
實作階段
Phase 0：準備工作
確認環境：
node --version
npm --version
python --version
python -c "import PyQt6"
確認專案檔案存在：
main.py
lyrics_data.db
requirements.txt
settings.json
Phase 1：Node.js 專案初始化
建立 web-app
依序執行：
npm init -y
npm install express ejs sqlite3 cors body-parser dotenv
npm install --save-dev nodemon
建立 .env：
PORT=3000
DB_PATH=../lyrics_data.db
Phase 2：後端 API 與 SQLite
server.js 內容：
Express 設定
靜態檔案與 EJS 模板
SQLite 連線
listening_history 表
API：
GET /api/songs → 歌曲列表
POST /api/play-event → 記錄播放
GET /api/stats/summary → 統計摘要
GET /api/stats/top-songs → 排行榜
GET /api/stats/timeline → 時間線
POST /api/launch-pyqt6 → 啟動 PyQt6
Phase 3：前端頁面
views/layout.ejs
views/index.ejs
模式切換按鈕
簡單模式播放器
進階模式啟動 PyQt6
views/stats.ejs
統計卡片
排行榜表格
Chart.js 時間線
public/css/style.css
public/js/app.js
Phase 4：PyQt6 集成
進階模式按鈕改為：
向後端發 POST /api/launch-pyqt6
後端使用 child_process.spawn 啟動 python main.py
確保：
main.py 路徑正確
lyrics_data.db 可被同時讀寫
Phase 5：測試
後端：
GET /api/songs
POST /api/play-event
GET /api/stats/summary
GET /api/stats/top-songs
GET /api/stats/timeline
前端：
http://localhost:3000
http://localhost:3000/stats
簡單模式可選歌
進階模式按鈕能啟動 PyQt6
統計：
播放事件是否累計
排行榜排序是否正確
時間線是否顯示數據
報告演示流程
啟動網頁版：cd web-app && npm start
打開 http://localhost:3000
展示簡單模式
切換進階模式，點擊啟動 PyQt6
運行桌面版並播放
打開統計頁面顯示排行榜和時間線
說明兩者共享 SQLite 的設計
教授問答重點
為什麼用 Node.js：適合 Web、異步、主流
Express 負責什麼：路由、API、HTTP
為何用 SQLite：簡單、共享檔案、適合期末專案
為何保留 PyQt6：展示桌面版與網頁版差異
如何記錄播放：前端 fetch() 提交 play-event
為何使用 POST /api/launch-pyqt6：讓網頁操作桌面版
