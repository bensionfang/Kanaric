"""
SQLite 資料庫管理模組
負責快取歌詞、單字修正紀錄與聽歌歷史。
"""
import sqlite3
import logging
from typing import Optional
from config import DB_FILE

class DatabaseManager:
    """單例模式的資料庫管理員"""
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DatabaseManager, cls).__new__(cls)
            cls._instance._init_db()
        return cls._instance

    def _init_db(self):
        """初始化資料庫連線並建立所需的資料表"""
        # check_same_thread=False 允許在不同執行緒中使用同一個連線
        self.conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        # 啟用 WAL 模式 (Write-Ahead Logging) 以提升並發讀寫效能
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.cursor = self.conn.cursor()
        
        # 建立快取歌詞表
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))''')
        # 建立單字發音修正表
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS word_corrections (artist TEXT, title TEXT, word TEXT, hira TEXT, PRIMARY KEY (artist, title, word))''')
        # 建立歌曲時間軸偏移量表
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS sync_offsets (artist TEXT, title TEXT, offset REAL, PRIMARY KEY (artist, title))''')
        # 建立聽歌歷史紀錄表
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS listening_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist TEXT,
            title TEXT,
            duration INTEGER DEFAULT 180,
            played_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )''')
        # 嘗試新增 album 欄位，如果已存在則忽略錯誤
        try:
            self.cursor.execute("ALTER TABLE listening_history ADD COLUMN album TEXT")
        except sqlite3.OperationalError:
            pass
            
        # 建立歌手別名映射表
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS artist_aliases (alias TEXT PRIMARY KEY, true_name TEXT)''')
        self.conn.commit()

    def get_artist_alias(self, alias: str) -> str:
        """取得歌手的真實名稱 (如果有設定別名)"""
        self.cursor.execute("SELECT true_name FROM artist_aliases WHERE alias=?", (alias,))
        row = self.cursor.fetchone()
        return row[0] if row else alias

    def get_word_correction(self, artist: str, title: str, word: str) -> Optional[str]:
        """取得特定歌曲中某個單字的自訂發音 (平假名)"""
        self.cursor.execute("SELECT hira FROM word_corrections WHERE artist=? AND title=? AND word=?", (artist, title, word))
        row = self.cursor.fetchone()
        return row[0] if row else None

    def save_word_correction(self, artist: str, title: str, word: str, hira: str) -> None:
        """儲存特定歌曲中某個單字的發音修正"""
        self.cursor.execute("INSERT OR REPLACE INTO word_corrections VALUES (?, ?, ?, ?)", (artist, title, word, hira))
        self.conn.commit()

    def get_cached_lyrics(self, artist: str, title: str) -> Optional[str]:
        """取得快取的歌詞"""
        self.cursor.execute("SELECT lyrics FROM cache WHERE artist=? AND title=?", (artist, title))
        row = self.cursor.fetchone()
        return row[0] if row else None

    def save_cached_lyrics(self, artist: str, title: str, lyrics: str) -> None:
        """將下載的歌詞儲存至快取庫"""
        self.cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", (artist, title, lyrics))
        self.conn.commit()

    def delete_cached_lyrics(self, artist: str, title: str) -> None:
        """刪除指定的快取歌詞"""
        self.cursor.execute("DELETE FROM cache WHERE artist=? AND title=?", (artist, title))
        self.conn.commit()

    def get_sync_offset(self, artist: str, title: str) -> float:
        """取得特定歌曲獨立儲存的時間軸偏移量"""
        self.cursor.execute("SELECT offset FROM sync_offsets WHERE artist=? AND title=?", (artist, title))
        row = self.cursor.fetchone()
        return row[0] if row else 0.0

    def save_sync_offset(self, artist: str, title: str, offset: float) -> None:
        """儲存特定歌曲獨立的時間軸偏移量"""
        self.cursor.execute("INSERT OR REPLACE INTO sync_offsets VALUES (?, ?, ?)", (artist, title, offset))
        self.conn.commit()

    def add_listening_history(self, artist: str, title: str, album: str, duration: int = 180) -> None:
        """新增一筆聽歌歷史紀錄"""
        try:
            self.cursor.execute("INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)", 
                                (artist, title, album, duration))
            self.conn.commit()
        except Exception as e:
            logging.error(f"儲存播放歷史失敗: {e}")

# 建立全域 db 實例供其他模組匯入使用
db = DatabaseManager()
