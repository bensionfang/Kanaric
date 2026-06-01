import sqlite3
import logging
from typing import Optional
from config import DB_FILE

class DatabaseManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DatabaseManager, cls).__new__(cls)
            cls._instance._init_db()
        return cls._instance

    def _init_db(self):
        self.conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.cursor = self.conn.cursor()
        
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))''')
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS word_corrections (artist TEXT, title TEXT, word TEXT, hira TEXT, PRIMARY KEY (artist, title, word))''')
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS sync_offsets (artist TEXT, title TEXT, offset REAL, PRIMARY KEY (artist, title))''')
        self.cursor.execute('''CREATE TABLE IF NOT EXISTS listening_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist TEXT,
            title TEXT,
            duration INTEGER DEFAULT 180,
            played_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )''')
        try:
            self.cursor.execute("ALTER TABLE listening_history ADD COLUMN album TEXT")
        except sqlite3.OperationalError:
            pass
        self.conn.commit()

    def get_word_correction(self, artist: str, title: str, word: str) -> Optional[str]:
        self.cursor.execute("SELECT hira FROM word_corrections WHERE artist=? AND title=? AND word=?", (artist, title, word))
        row = self.cursor.fetchone()
        return row[0] if row else None

    def save_word_correction(self, artist: str, title: str, word: str, hira: str) -> None:
        self.cursor.execute("INSERT OR REPLACE INTO word_corrections VALUES (?, ?, ?, ?)", (artist, title, word, hira))
        self.conn.commit()

    def get_cached_lyrics(self, artist: str, title: str) -> Optional[str]:
        self.cursor.execute("SELECT lyrics FROM cache WHERE artist=? AND title=?", (artist, title))
        row = self.cursor.fetchone()
        return row[0] if row else None

    def save_cached_lyrics(self, artist: str, title: str, lyrics: str) -> None:
        self.cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", (artist, title, lyrics))
        self.conn.commit()

    def delete_cached_lyrics(self, artist: str, title: str) -> None:
        self.cursor.execute("DELETE FROM cache WHERE artist=? AND title=?", (artist, title))
        self.conn.commit()

    def get_sync_offset(self, artist: str, title: str) -> float:
        self.cursor.execute("SELECT offset FROM sync_offsets WHERE artist=? AND title=?", (artist, title))
        row = self.cursor.fetchone()
        return row[0] if row else 0.0

    def save_sync_offset(self, artist: str, title: str, offset: float) -> None:
        self.cursor.execute("INSERT OR REPLACE INTO sync_offsets VALUES (?, ?, ?)", (artist, title, offset))
        self.conn.commit()

    def add_listening_history(self, artist: str, title: str, album: str, duration: int = 180) -> None:
        try:
            self.cursor.execute("INSERT INTO listening_history (artist, title, album, duration) VALUES (?, ?, ?, ?)", 
                                (artist, title, album, duration))
            self.conn.commit()
        except Exception as e:
            logging.error(f"儲存播放歷史失敗: {e}")

db = DatabaseManager()
