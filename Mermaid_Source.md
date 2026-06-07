# Floating Lyrics - Mermaid 原始碼

你可以將以下的原始碼複製並貼上到 [Mermaid Live Editor](https://mermaid.live/) 或其他支援 Mermaid 的編輯器（如 Notion, Obsidian）中。

## 1. 資料庫實體關聯圖 (ER Diagram)

```mermaid
erDiagram
    CACHE {
        string artist PK
        string title PK
        string lyrics "快取的完整歌詞（包含來源標籤與假名）"
    }
    
    WORD_CORRECTIONS {
        string artist PK
        string title PK
        string word PK "原始漢字"
        string hira "修正後的平假名"
    }
    
    SYNC_OFFSETS {
        string artist PK
        string title PK
        float offset "微調的時間偏移量（單位：秒）"
    }
    
    LISTENING_HISTORY {
        int id PK "自動遞增編號"
        string artist 
        string title 
        string album "所屬專輯"
        int duration "歌曲總長度（預設 180 秒）"
        datetime played_at "播放時間（預設 CURRENT_TIMESTAMP）"
    }

    CACHE ||--o{ WORD_CORRECTIONS : "擁有 (透過 artist, title)"
    CACHE ||--o| SYNC_OFFSETS : "擁有 (透過 artist, title)"
    CACHE ||--o{ LISTENING_HISTORY : "記錄播放 (透過 artist, title)"
```

## 2. 系統架構與資料流程圖 (System Flow Chart)

```mermaid
graph TD
    OS[Windows Media API <br> Spotify / Apple Music]
    WebAPI[Lrclib / QQ音樂 / 網易雲 <br> 外部歌詞 API]
    DB[(SQLite 資料庫 <br> lyrics_data.db)]

    subgraph Python 核心組件
        MM[media_monitor.py <br> 即時監控播放狀態]
        Furi[furigana_inject.py <br> 日文假名標註]
        PyCore[main.py <br> 桌面版懸浮視窗]
    end

    subgraph Node.js 網頁伺服器
        Express[server.js <br> Express Server API]
    end

    subgraph 網頁前端介面
        WebApp[app.js <br> 網頁播放器]
        StatsUI[統計面板 / 排行榜 <br> stats.ejs]
        SettingsUI[使用者設定介面 <br> settings.json]
    end

    OS -- "抓取當前播放曲目與時間" --> MM
    OS -- "抓取當前播放曲目與時間" --> PyCore
    
    MM -- "Stdout (JSON Stream)" --> Express
    Express -- "API: /api/current-media" --> WebApp
    
    WebApp -- "請求歌詞" --> Express
    PyCore -- "請求歌詞" --> WebAPI
    
    Express -- "找不到時請求外部 API" --> WebAPI
    Express -- "呼叫 Python 處理日文" --> Furi
    Furi -. "回傳注音歌詞" .-> Express
    
    Express -- "讀寫快取/歷史/微調" --> DB
    PyCore -- "讀寫快取/歷史/微調" --> DB
    
    StatsUI -- "請求 /api/stats" --> Express
    Express -- "查詢 Listening History" --> DB
    
    SettingsUI -- "儲存設定" --> Express
    Express -- "寫入 JSON" --> SettingsUI
```
