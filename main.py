import sys
import os
import json
import time
import traceback
import re
import asyncio
import requests
import sqlite3
import pykakasi

# === 【關鍵修復】把 Windows 底層套件移到最上方，強迫打包工具看見並包進去 ===
import winrt.windows.foundation
import winrt.windows.foundation.collections
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader
# =========================================================================

from PyQt6.QtCore import (Qt, QThread, pyqtSignal, QParallelAnimationGroup, 
                          QPropertyAnimation, QEasingCurve, QAbstractAnimation, QTimer, QPoint, QEvent)
from PyQt6.QtWidgets import (QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
                             QMenu, QFileDialog, QInputDialog, QFrame, 
                             QPushButton, QScrollArea, QGraphicsOpacityEffect, 
                             QSystemTrayIcon, QStyle, QFontDialog, QSizeGrip,
                             QDialog, QTextEdit, QGridLayout, QMessageBox, QListWidget, QListWidgetItem)
from PyQt6.QtGui import QFont, QAction, QPixmap, QImage, QColor

kks = pykakasi.kakasi()

# ================= 0. 羅馬拼音轉換工具 =================
def romaji_to_hiragana(text):
    text = text.lower()
    text = re.sub(r'([bcdfghjklmpqrstvwxyz])\1', r'っ\1', text)
    
    mapping = {
        'kya':'きゃ', 'kyu':'きゅ', 'kyo':'きょ',
        'sha':'しゃ', 'shu':'しゅ', 'sho':'しょ',
        'cha':'ちゃ', 'chu':'ちゅ', 'cho':'ちょ',
        'nya':'にゃ', 'nyu':'にゅ', 'nyo':'にょ',
        'hya':'ひゃ', 'hyu':'ひゅ', 'hyo':'ひょ',
        'mya':'みゃ', 'myu':'みゅ', 'myo':'みょ',
        'rya':'りゃ', 'ryu':'りゅ', 'ryo':'りょ',
        'gya':'ぎゃ', 'gyu':'ぎゅ', 'gyo':'ぎょ',
        'ja':'じゃ', 'ju':'じゅ', 'jo':'じょ', 'jya':'じゃ', 'jyu':'じゅ', 'jyo':'じょ',
        'bya':'びゃ', 'byu':'びゅ', 'byo':'びょ',
        'pya':'ぴゃ', 'pyu':'ぴゅ', 'pyo':'ぴょ',
        'shi':'し', 'chi':'ち', 'tsu':'つ',
        'ka':'か', 'ki':'き', 'ku':'く', 'ke':'け', 'ko':'こ',
        'sa':'さ', 'su':'す', 'se':'せ', 'so':'そ',
        'ta':'た', 'te':'て', 'to':'と',
        'na':'な', 'ni':'に', 'nu':'ぬ', 'ne':'ね', 'no':'の',
        'ha':'は', 'hi':'ひ', 'fu':'ふ', 'hu':'ふ', 'he':'へ', 'ho':'ほ',
        'ma':'ま', 'mi':'み', 'mu':'む', 'me':'め', 'mo':'も',
        'ya':'や', 'yu':'ゆ', 'yo':'よ',
        'ra':'ら', 'ri':'り', 'ru':'る', 're':'れ', 'ro':'ろ',
        'wa':'わ', 'wo':'を', 'n':'ん',
        'ga':'が', 'gi':'ぎ', 'gu':'ぐ', 'ge':'げ', 'go':'ご',
        'za':'ざ', 'ji':'じ', 'zu':'ず', 'ze':'ぜ', 'zo':'ぞ',
        'da':'だ', 'de':'で', 'do':'ど',
        'ba':'ば', 'bi':'び', 'bu':'ぶ', 'be':'べ', 'bo':'ぼ',
        'pa':'ぱ', 'pi':'ぴ', 'pu':'ぷ', 'pe':'ぺ', 'po':'ぽ',
        'a':'あ', 'i':'い', 'u':'う', 'e':'え', 'o':'お',
        '-':'ー'
    }
    keys = sorted(mapping.keys(), key=len, reverse=True)
    pattern = re.compile('|'.join(map(re.escape, keys)))
    return pattern.sub(lambda m: mapping[m.group(0)], text)

def text_to_romaji_query(text):
    if not text: return ""
    result = kks.convert(text)
    out = [item['hepburn'] for item in result if item['hepburn']]
    joined = " ".join(out)
    return re.sub(r'\s+', ' ', joined).strip()

# ================= 1. 資料庫與設定檔初始化 =================
DB_FILE = 'lyrics_data.db'
SETTINGS_FILE = 'settings.json'

conn = sqlite3.connect(DB_FILE, check_same_thread=False)
conn.execute("PRAGMA journal_mode=WAL;")
cursor = conn.cursor()
cursor.execute('''CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))''')
cursor.execute('''CREATE TABLE IF NOT EXISTS word_corrections (artist TEXT, title TEXT, word TEXT, hira TEXT, PRIMARY KEY (artist, title, word))''')
cursor.execute('''CREATE TABLE IF NOT EXISTS sync_offsets (artist TEXT, title TEXT, offset REAL, PRIMARY KEY (artist, title))''')
cursor.execute('''CREATE TABLE IF NOT EXISTS listening_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT,
    title TEXT,
    duration INTEGER DEFAULT 180,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
)''')
conn.commit()

def load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f: return json.load(f)
        except: pass
    return {"font_size": 28, "font_family": "Microsoft JhengHei", "custom_css_path": "",
            "mini_mode": False, "dynamic_color": True, "display_lines": 2, "pin_window": False}

def save_settings(settings):
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as f: json.dump(settings, f)

# ================= 2. 點擊式假名排版核心 =================
def build_clickable_furigana_html(text, artist, title, line_index, is_japanese=True):
    if not is_japanese:
        html = '<table border="0" cellpadding="0" cellspacing="0" align="left" style="margin: 0px; line-height: 1;">'
        row1 = "<tr><td align='center' style='padding: 0;'></td></tr>"
        text_escaped = text.replace(' ', '&nbsp;')
        row2 = f"<tr><td align='center' style='white-space: nowrap; padding: 0;'>{text_escaped}</td></tr>"
        html += row1 + row2 + "</table>"
        return html, []

    words = kks.convert(text)
    
    html = '<table border="0" cellpadding="0" cellspacing="0" align="left" style="margin: 0px; line-height: 1;">'
    row1 = "<tr>" 
    row2 = "<tr>" 
    words_data = []

    for word_index, item in enumerate(words):
        orig = item['orig']
        hira = item['hira']

        cursor.execute("SELECT hira FROM word_corrections WHERE artist=? AND title=? AND word=?", (artist, title, orig))
        db_row = cursor.fetchone()
        if db_row: hira = db_row[0]

        words_data.append({'orig': orig, 'hira': hira})
        
        parts = []
        has_kanji = re.search(r'[\u4e00-\u9faf\u3005]', orig)
        
        if not has_kanji or not hira or orig == hira:
            parts.append((orig, ""))
        else:
            i = len(orig) - 1
            j = len(hira) - 1
            while i >= 0 and j >= 0 and orig[i] == hira[j]:
                i -= 1
                j -= 1
            suffix = orig[i+1:]
            
            k = 0
            m = 0
            while k <= i and m <= j and orig[k] == hira[m]:
                k += 1
                m += 1
            prefix = orig[:k]
            
            root_orig = orig[k:i+1]
            root_hira = hira[m:j+1]
            
            if prefix: parts.append((prefix, ""))
            if root_orig: parts.append((root_orig, root_hira))
            if suffix: parts.append((suffix, ""))

        for p_orig, p_hira in parts:
            p_orig_escaped = p_orig.replace(' ', '&nbsp;')
            a_start = f"<a href='edit:{line_index}:{word_index}' style='text-decoration:none; color:#ffffff;'>"
            a_end = "</a>"
            
            if not p_hira:
                row1 += f"<td align='center' style='padding: 0;'></td>"
                row2 += f"<td align='center' style='white-space: nowrap; padding: 0;'>{a_start}{p_orig_escaped}{a_end}</td>"
            else:
                row1 += f"<td align='center' style='padding: 0;'>{a_start}<span style='font-size: 0.5em; opacity: 0.8;'>{p_hira}</span>{a_end}</td>"
                row2 += f"<td align='center' style='white-space: nowrap; padding: 0;'>{a_start}{p_orig_escaped}{a_end}</td>"
            
    row1 += "</tr>"
    row2 += "</tr>"
    html += row1 + row2 + "</table>"
    return html, words_data

# ================= 3. 媒體擷取 =================
class MediaWorker(QThread):
    media_updated = pyqtSignal(str, str, float, bytes, bool)

    def run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self.poll_media())

    async def poll_media(self):
        sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        last_real_pos = -1.0
        last_real_pos_time = time.time()
        
        while True:
            current_session = sessions.get_current_session()
            if current_session:
                info = await current_session.try_get_media_properties_async()
                timeline = current_session.get_timeline_properties()
                playback_info = current_session.get_playback_info()
                
                title = info.title if info.title else ""
                artist = info.artist if info.artist else ""
                real_pos = timeline.position.total_seconds() if timeline else 0.0
                is_playing = (playback_info and playback_info.playback_status == 4) 
                
                thumb_bytes = b''
                if info.thumbnail:
                    try:
                        stream = await info.thumbnail.open_read_async()
                        reader = DataReader(stream)
                        await reader.load_async(stream.size)
                        buf = bytearray(stream.size)
                        reader.read_bytes(buf)
                        thumb_bytes = bytes(buf)
                    except: pass

                current_time = time.time()
                if real_pos != last_real_pos:
                    last_real_pos = real_pos
                    last_real_pos_time = current_time
                    interpolated_pos = real_pos
                else:
                    interpolated_pos = real_pos + (current_time - last_real_pos_time) if is_playing else real_pos
                        
                self.media_updated.emit(title, artist, interpolated_pos, thumb_bytes, is_playing)
            await asyncio.sleep(0.05)

# ================= 4. 歌詞抓取與智慧翻譯 =================
class LyricsFetcher(QThread):
    lyrics_fetched = pyqtSignal(str, list)
    def __init__(self, title, artist):
        super().__init__()
        self.title, self.artist = title, artist
        
    def generate_queries(self, t, a):
        queries = []
        seen = set()
        
        def add_q(qt, qa):
            if (qt, qa) not in seen and qt and qa:
                seen.add((qt, qa))
                queries.append((qt, qa))
                
        add_q(t, a)
        
        rt = text_to_romaji_query(t)
        ra = text_to_romaji_query(a)
        
        rt_valid = rt and rt.lower() != t.lower()
        ra_valid = ra and ra.lower() != a.lower()
        
        if rt_valid:
            add_q(rt, a)
            add_q(rt.replace(" ", ""), a)
            
        if ra_valid:
            add_q(t, ra)
            
        if rt_valid and ra_valid:
            add_q(rt, ra)
            add_q(rt.replace(" ", ""), ra)
            
        return queries

    def run(self):
        try:
            cached_lyric = None
            cursor.execute("SELECT lyrics FROM cache WHERE title=? AND artist=?", (self.title, self.artist))
            row = cursor.fetchone()
            if row:
                cached_lyric = row[0]
                self.lyrics_fetched.emit(cached_lyric, []) 
                return

            clean_title = re.sub(r'\(feat\..*?\)|\- Remastered.*|\- Live.*', '', self.title, flags=re.IGNORECASE).strip()
            best_lyric, options = None, []

            for qt, qa in self.generate_queries(clean_title, self.artist):
                best_lyric, options = self.search_lrclib(qt, qa)
                if best_lyric: break

            if not best_lyric:
                try:
                    itunes_url = "https://itunes.apple.com/search"
                    params = {"term": f"{clean_title} {self.artist}", "entity": "song", "limit": 1, "country": "jp"}
                    resp = requests.get(itunes_url, params=params, timeout=5)
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        if results:
                            jp_title = results[0].get("trackName", clean_title)
                            jp_artist = results[0].get("artistName", self.artist)
                            
                            if jp_title != clean_title or jp_artist != self.artist:
                                for qt, qa in self.generate_queries(jp_title, jp_artist):
                                    best_lyric, options = self.search_lrclib(qt, qa)
                                    if best_lyric: break
                except Exception as e:
                    pass 

            if best_lyric and not cached_lyric:
                cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", (self.artist, self.title, best_lyric))
                conn.commit()
                self.lyrics_fetched.emit(best_lyric, options)
            elif options:
                self.lyrics_fetched.emit("OPTIONS_ONLY", options)
            else:
                self.lyrics_fetched.emit("", []) 
                
        except Exception as e: 
            self.lyrics_fetched.emit("", [])

    def search_lrclib(self, target_title, target_artist):
        headers = {"User-Agent": "Mozilla/5.0"}
        url = "https://lrclib.net/api/search"
        try:
            response = requests.get(url, params={"q": f"{target_title} {target_artist}"}, headers=headers, timeout=10)
            if response.status_code == 200:
                data = response.json()
                valid_lyrics = []
                for t in data:
                    if t.get("syncedLyrics"):
                        valid_lyrics.append({
                            'title': t.get('trackName', ''),
                            'artist': t.get('artistName', ''),
                            'album': t.get('albumName', ''),
                            'duration': t.get('duration', 0),
                            'lyrics': t.get("syncedLyrics")
                        })
                        
                if valid_lyrics:
                    def get_score(item):
                        score = 0
                        item_title = item['title'].lower()
                        item_artist = item['artist'].lower()
                        t_title = target_title.lower()
                        t_artist = target_artist.lower()

                        if t_title == item_title:
                            score += 1000
                        elif t_title in item_title or item_title in t_title:
                            score += 500
                            
                        if t_artist == item_artist:
                            score += 500
                        elif t_artist in item_artist or item_artist in t_artist:
                            score += 200
                            
                        if re.search(r'[\u3040-\u30FF]', item['lyrics']):
                            score += 100
                            
                        return score

                    valid_lyrics.sort(key=get_score, reverse=True)
                    return valid_lyrics[0]['lyrics'], valid_lyrics[:5]
        except: pass
        return None, []

# ================= 5. 事件穿透捲動區塊 =================
class TransparentScrollArea(QScrollArea):
    def wheelEvent(self, event):
        self.parent().wheelEvent(event)
        super().wheelEvent(event)

# ================= 6. 主程式介面 =================
class FloatingLyricsApp(QWidget):
    def __init__(self):
        super().__init__()
        self.settings = load_settings()
        
        self.media_title = ""
        self.media_artist = ""
        self.search_title = ""
        self.search_artist = ""
        
        self.current_sync_offset = 0.0 
        
        self.current_lrc_text = ""
        self.lyrics_data = []
        self.lyric_labels = []
        self.current_lyrics_options = []
        self.drag_pos = None
        self.last_index = -2 
        self.theme_color = (0, 0, 0, 160)
        
        self.last_clicked_link = ""
        self.last_clicked_time = 0.0
        
        self.init_ui()
        self.init_tray() 
        self.apply_mode_styles()
        
        self.font_update_timer = QTimer(self)
        self.font_update_timer.setSingleShot(True)
        self.font_update_timer.setInterval(50) 
        self.font_update_timer.timeout.connect(self.apply_font_size_change)
        
        self.hide_timer = QTimer(self)
        self.hide_timer.setSingleShot(True)
        self.hide_timer.setInterval(5000) 
        self.hide_timer.timeout.connect(self.hide_window)
        
        self.media_worker = MediaWorker()
        self.media_worker.media_updated.connect(self.update_media_info)
        self.media_worker.start()

    def start_lyric_fetcher(self):
        if hasattr(self, 'fetcher') and self.fetcher is not None:
            try:
                self.fetcher.lyrics_fetched.disconnect()
            except TypeError:
                pass 
        self.fetcher = LyricsFetcher(self.search_title, self.search_artist)
        self.fetcher.lyrics_fetched.connect(self.handle_fetched_lyrics)
        self.fetcher.start()

    def init_ui(self):
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.resize(800, 200) 
        
        self.container = QFrame(self)
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.addWidget(self.container)
        
        vbox = QVBoxLayout(self.container)
        
        top_hbox = QHBoxLayout()
        top_hbox.setContentsMargins(25, 15, 15, 0) 
        
        self.header_label = QLabel("正在等待播放...")
        ff = self.settings.get("font_family", "Microsoft JhengHei")
        self.header_label.setStyleSheet(f"color: #b3b3b3; font-size: 14px; font-weight: bold; font-family: \"{ff}\";")
        top_hbox.addWidget(self.header_label)
        
        top_hbox.addStretch()
        
        self.hint_label = QLabel("")
        self.hint_label.setStyleSheet("color: #ffff00; font-size: 14px;")
        top_hbox.addWidget(self.hint_label)
        
        self.settings_btn = QPushButton("☰")
        self.settings_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.settings_btn.setStyleSheet("QPushButton { background: transparent; color: rgba(255,255,255,150); font-size: 18px; font-weight: bold; border: none; padding: 5px; } QPushButton:hover { color: white; }")
        self.settings_btn.clicked.connect(self.show_settings_menu)
        top_hbox.addWidget(self.settings_btn)

        self.close_btn = QPushButton("✕")
        self.close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.close_btn.setStyleSheet("QPushButton { background: transparent; color: rgba(255,255,255,150); font-size: 18px; font-weight: bold; border: none; padding: 5px; } QPushButton:hover { color: #ff5c5c; }")
        self.close_btn.clicked.connect(self.force_quit)
        top_hbox.addWidget(self.close_btn)
        
        vbox.addLayout(top_hbox)
        
        self.scroll_area = TransparentScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.viewport().installEventFilter(self)
        
        self.content_widget = QWidget()
        self.content_layout = QVBoxLayout(self.content_widget)
        self.content_layout.setContentsMargins(25, 5, 10, 20)
        self.scroll_area.setWidget(self.content_widget)
        vbox.addWidget(self.scroll_area, 1)
        
        bottom_hbox = QHBoxLayout()
        bottom_hbox.setContentsMargins(0, 0, 0, 0)
        bottom_hbox.addStretch()
        
        grip_layout = QGridLayout()
        grip_layout.setContentsMargins(0, 0, 5, 5)
        
        self.grip_icon = QLabel("↘")
        self.grip_icon.setStyleSheet("color: rgba(255,255,255,150); font-size: 16px; font-weight: bold;")
        self.grip_icon.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignRight)
        
        self.sizegrip = QSizeGrip(self.container)
        self.sizegrip.setFixedSize(25, 25)
        self.sizegrip.setStyleSheet("background: transparent;")
        self.sizegrip.setToolTip("按住拖曳來縮放視窗")
        
        grip_layout.addWidget(self.grip_icon, 0, 0, Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignRight)
        grip_layout.addWidget(self.sizegrip, 0, 0, Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignRight)
        
        bottom_hbox.addLayout(grip_layout)
        vbox.addLayout(bottom_hbox)
        
        self.show_status("等待音樂播放中...")

    def eventFilter(self, obj, event):
        if obj == self.scroll_area.viewport() and event.type() == QEvent.Type.Wheel:
            self.wheelEvent(event) 
            return True 
        return super().eventFilter(obj, event)

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        if delta > 0:
            self.settings["font_size"] = min(100, self.settings.get("font_size", 28) + 2)
        elif delta < 0:
            self.settings["font_size"] = max(10, self.settings.get("font_size", 28) - 2)
        
        self.hint_label.setText(f"字體大小: {self.settings['font_size']}px")
        QTimer.singleShot(1500, lambda: self.hint_label.setText("")) 
        
        save_settings(self.settings)
        self.font_update_timer.start()

    def apply_font_size_change(self):
        fs = self.settings.get("font_size", 28)
        ff = self.settings.get("font_family", "Microsoft JhengHei")
        for i, item in enumerate(self.lyric_labels):
            label = item['label']
            html = self.lyrics_data[i][1]
            label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{html}</div>")
        
        self.content_widget.adjustSize()
        if self.lyric_labels:
            scroll_target = max(0, self.last_index)
            if scroll_target < len(self.lyric_labels):
                target_y = self.lyric_labels[scroll_target]['wrapper'].y()
                self.scroll_area.verticalScrollBar().setValue(target_y)

    def init_tray(self):
        self.tray_icon = QSystemTrayIcon(self)
        icon = self.style().standardIcon(QStyle.StandardPixmap.SP_MediaVolume)
        self.tray_icon.setIcon(icon)

        tray_menu = QMenu()
        tray_menu.addAction("顯示歌詞", self.show_window)
        tray_menu.addAction("隱藏歌詞", self.hide_window)
        tray_menu.addSeparator()
        tray_menu.addAction("完全退出", self.force_quit)

        self.tray_icon.setContextMenu(tray_menu)
        self.tray_icon.show()

    def show_window(self):
        self.show()
        self.hide_timer.stop() 

    def hide_window(self):
        self.hide()

    def force_quit(self):
        self.tray_icon.hide()
        QApplication.instance().quit()

    def update_media_info(self, title, artist, position, thumb_bytes, is_playing):
        if is_playing:
            if self.isHidden() and title != "": self.show_window() 
            self.hide_timer.stop()
        else:
            if not self.hide_timer.isActive() and not self.isHidden() and not self.settings.get("pin_window"):
                self.hide_timer.start() 
        
        if title != self.media_title or artist != self.media_artist:
            self.media_title = title
            self.media_artist = artist
            self.search_title = title
            self.search_artist = artist
            
            cursor.execute("SELECT offset FROM sync_offsets WHERE artist=? AND title=?", (self.search_artist, self.search_title))
            db_row = cursor.fetchone()
            self.current_sync_offset = db_row[0] if db_row else 0.0
            
            if title and artist:
                self.header_label.setText(f"{title} - {artist}")
                # 【新增】記錄播放歷史
                try:
                    cursor.execute("INSERT INTO listening_history (artist, title, duration) VALUES (?, ?, 180)", (artist, title))
                    conn.commit()
                except Exception as e:
                    print("Error inserting history:", e)
            elif title:
                self.header_label.setText(f"{title}")
            else:
                self.header_label.setText("正在等待音樂播放...")
                
            self.lyrics_data = []
            self.current_lyrics_options = []
            self.show_status(f"正在搜尋歌詞...")
            
            self.extract_dominant_color(thumb_bytes)
            self.apply_mode_styles()
            
            self.start_lyric_fetcher()
        
        if self.lyrics_data:
            self.refresh_lyrics_display(position)

    def show_help_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("操作說明")
        dialog.resize(650, 650)
        dialog.setStyleSheet("""
            QDialog { background-color: #2b2b2b; color: white; }
            QPushButton { background-color: #444; color: white; padding: 8px; border-radius: 4px; font-weight: bold; }
            QPushButton:hover { background-color: #555; }
            QTextEdit { background-color: #1e1e1e; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; padding: 10px; font-size: 14px; }
        """)
        
        layout = QVBoxLayout(dialog)
        text_edit = QTextEdit()
        text_edit.setReadOnly(True)
        
        help_text = """# 桌面智慧浮動歌詞

這是一款輕量級桌面浮動歌詞播放器，能自動追蹤系統音樂並在桌面上同步顯示歌詞。

## 基本操作
* 移動視窗：按住視窗空白處即可拖曳。
* 調整大小：拖曳右下角圖示改變長寬。
* 縮放字體：游標停留在視窗上方，滾動滑鼠滾輪即可縮放。
* 修正拼音：雙擊歌詞漢字手動修正。支援輸入羅馬拼音，會自動轉成平假名。
* 時間微調：點擊視窗後，按 `]` 提早 0.5 秒，按 `[` 延遲 0.5 秒。

## 常見問題 QA

**Q：為什麼有些日文歌找不到，但手動改成羅馬拼音就找到了？**
A：這通常是因為 Spotify 上的歌名使用了**繁體中文字**（例如：噓つき），導致系統轉換拼音失敗。現在系統已內建「iTunes 校正與多重拼音防護網」，會在背景自動修正錯字、並嘗試各種包含或不包含空格的羅馬拼音組合，您不必再手動測試了！

**Q：不小心把手動搜尋的歌名改錯了怎麼辦？**
A：點擊選單內的「還原自動偵測」，系統就會切回系統原始偵測到的播放歌曲。

**Q：如果連自動羅馬拼音搜尋都找不到歌詞呢？**
A：請點擊選單的「選擇備選歌詞」查看系統抓到的其他版本。若仍沒有，可使用「手動搜尋」或終極絕招「貼上自訂歌詞 (LRC)」。

**Q：日文拼音打不出來怎麼辦？**
A：雙擊漢字後，直接輸入「羅馬拼音」即可，系統會自動轉換。

**Q：快捷鍵怎麼沒有反應？**
A：請先用滑鼠點擊一下歌詞視窗，讓視窗處於作用中狀態即可使用快捷鍵。

**Q：音樂暫停時，歌詞視窗會自己消失？**
A：若希望視窗常駐，請在選單中開啟「釘選視窗」。

**Q：怎麼完全關閉程式？**
A：點擊右上角的「✕」只會將視窗隱藏至背景。若要完全退出，請在桌面右下角的系統托盤找到喇叭圖示，右鍵選擇「完全退出」。
"""
        text_edit.setMarkdown(help_text)
        layout.addWidget(text_edit)
        
        close_btn = QPushButton("我知道了")
        close_btn.clicked.connect(dialog.accept)
        layout.addWidget(close_btn)
        
        dialog.exec()

    def choose_alternative_lyrics(self):
        if not hasattr(self, 'current_lyrics_options') or not self.current_lyrics_options:
            QMessageBox.information(self, "無備選歌詞", "目前這首歌沒有在網路上找到其他的同步歌詞版本。")
            return
            
        dialog = QDialog(self)
        dialog.setWindowTitle("選擇備選歌詞")
        dialog.resize(600, 400)
        dialog.setStyleSheet("QDialog { background-color: #f0f0f0; } QPushButton { padding: 8px; } QListWidget { font-size: 14px; }")
        layout = QVBoxLayout(dialog)
        
        label = QLabel("我們為您在背景找到了以下備選版本，請選擇最適合的套用：")
        layout.addWidget(label)
        
        list_widget = QListWidget()
        for opt in self.current_lyrics_options:
            minutes = opt['duration'] // 60
            seconds = opt['duration'] % 60
            display_text = f"[{minutes:02}:{seconds:02}] {opt['title']} - {opt['artist']} - {opt['album']}"
            item = QListWidgetItem(display_text)
            item.setData(Qt.ItemDataRole.UserRole, opt['lyrics'])
            list_widget.addItem(item)
            
        layout.addWidget(list_widget)
        
        btn_layout = QHBoxLayout()
        apply_btn = QPushButton("套用選取歌詞")
        cancel_btn = QPushButton("取消")
        btn_layout.addWidget(apply_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        
        def apply_selected():
            selected = list_widget.selectedItems()
            if selected:
                lrc_text = selected[0].data(Qt.ItemDataRole.UserRole)
                cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", 
                               (self.search_artist, self.search_title, lrc_text))
                conn.commit()
                self.parse_and_load_lyrics(lrc_text)
                dialog.accept()
                
        apply_btn.clicked.connect(apply_selected)
        cancel_btn.clicked.connect(dialog.reject)
        
        dialog.exec()

    def manual_search_lyrics(self):
        default_text = f"{self.search_title} - {self.search_artist}" if self.search_artist else self.search_title
        text, ok = QInputDialog.getText(self, "手動搜尋", "請輸入 歌名 - 歌手 進行精準搜尋：", text=default_text)
        if ok and text.strip():
            if "-" in text:
                parts = text.split("-", 1)
                self.search_title = parts[0].strip()
                self.search_artist = parts[1].strip()
            else:
                self.search_title = text.strip()
                self.search_artist = ""
                
            self.trigger_lyric_search(manual_label=True)

    def reset_manual_search(self):
        if self.search_title == self.media_title and self.search_artist == self.media_artist:
            QMessageBox.information(self, "提示", "目前已經是系統自動偵測的原始歌名囉！")
            return
            
        self.search_title = self.media_title
        self.search_artist = self.media_artist
        self.trigger_lyric_search(manual_label=False)

    def import_custom_lyrics(self):
        if not self.search_title:
            return
            
        dialog = QDialog(self)
        dialog.setWindowTitle("貼上自訂歌詞")
        dialog.resize(500, 400)
        dialog.setStyleSheet("QDialog { background-color: #f0f0f0; } QTextEdit { font-size: 14px; }")
        
        layout = QVBoxLayout(dialog)
        label = QLabel(f"請貼上「{self.search_title}」的 LRC 格式歌詞：\n提示：必須包含如 00:15.30 的時間標記")
        layout.addWidget(label)
        
        text_edit = QTextEdit()
        layout.addWidget(text_edit)
        
        btn_layout = QHBoxLayout()
        save_btn = QPushButton("保存並套用")
        cancel_btn = QPushButton("取消")
        btn_layout.addWidget(save_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        
        def save_and_close():
            lrc_text = text_edit.toPlainText().strip()
            if lrc_text:
                if not re.search(r'\[\d{2}:\d{2}\.\d{2,3}\]', lrc_text):
                    QMessageBox.warning(dialog, "格式錯誤", "未偵測到有效的 LRC 時間標記，但系統仍會為您存檔。")
                
                cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", 
                               (self.search_artist, self.search_title, lrc_text))
                conn.commit()
                self.parse_and_load_lyrics(lrc_text)
            dialog.accept()
            
        save_btn.clicked.connect(save_and_close)
        cancel_btn.clicked.connect(dialog.reject)
        
        dialog.exec()

    def clear_cache_and_refetch(self):
        if not self.search_title: 
            return
            
        cursor.execute("DELETE FROM cache WHERE title=? AND artist=?", (self.search_title, self.search_artist))
        conn.commit()
        
        self.lyrics_data = []
        self.current_lyrics_options = []
        self.last_index = -2
        self.show_status("清除快取並重新搜尋中...")
        
        self.start_lyric_fetcher()

    def trigger_lyric_search(self, manual_label=False):
        if manual_label:
            orig_text = f"{self.media_title} - {self.media_artist}" if self.media_artist else self.media_title
            search_text = f"{self.search_title} - {self.search_artist}" if self.search_artist else self.search_title
            self.header_label.setText(f"{orig_text} [手動搜尋: {search_text}]")
        else:
            if self.search_title and self.search_artist:
                self.header_label.setText(f"{self.search_title} - {self.search_artist}")
            elif self.search_title:
                self.header_label.setText(f"{self.search_title}")
            else:
                self.header_label.setText("正在等待音樂播放...")
            
        cursor.execute("SELECT offset FROM sync_offsets WHERE artist=? AND title=?", (self.search_artist, self.search_title))
        db_row = cursor.fetchone()
        self.current_sync_offset = db_row[0] if db_row else 0.0
        
        self.lyrics_data = []
        self.current_lyrics_options = []
        self.last_index = -2
        self.show_status("重新搜尋中...")
        
        self.start_lyric_fetcher()

    def apply_mode_styles(self):
        base_style = ""
        if self.settings.get("mini_mode"):
            base_style = "QFrame { background: transparent; }"
            self.scroll_area.setStyleSheet("background: transparent; border: none;")
            self.settings_btn.hide() 
            self.close_btn.hide()
            self.grip_icon.hide()
        else:
            r, g, b, a = self.theme_color
            base_style = f"QFrame {{ background-color: rgba({r}, {g}, {b}, {a}); border-radius: 20px; }}"
            self.scroll_area.setStyleSheet("background: transparent; border: none;")
            self.content_widget.setStyleSheet("background: transparent;")
            self.settings_btn.show()
            self.close_btn.show()
            self.grip_icon.show()
            
        custom_css = ""
        css_path = self.settings.get("custom_css_path", "")
        if css_path and os.path.exists(css_path):
            try:
                with open(css_path, 'r', encoding='utf-8') as f: custom_css = f.read()
            except: pass

        self.container.setStyleSheet(base_style + "\n" + custom_css)

    def extract_dominant_color(self, image_bytes):
        if not image_bytes or not self.settings.get("dynamic_color"):
            self.theme_color = (0, 0, 0, 160)
            return
        pixmap = QPixmap()
        pixmap.loadFromData(image_bytes)
        img = pixmap.toImage()
        if not img.isNull():
            small = img.scaled(1, 1)
            color = small.pixelColor(0, 0)
            self.theme_color = (color.red() // 2, color.green() // 2, color.blue() // 2, 180)
        else:
            self.theme_color = (0, 0, 0, 160)

    def show_status(self, text):
        self.clear_lyrics()
        fs = self.settings.get("font_size", 28)
        ff = self.settings.get("font_family", "Microsoft JhengHei")
        label = QLabel(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{text}</div>")
        label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter) 
        self.content_layout.addWidget(label)
        self.content_layout.addStretch()

    def clear_lyrics(self):
        while self.content_layout.count():
            item = self.content_layout.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self.lyric_labels = []
        self.last_index = -2 

    def handle_fetched_lyrics(self, text, options_list):
        if text == "OPTIONS_ONLY":
            self.current_lyrics_options = options_list
            return
            
        self.current_lyrics_options = options_list
        self.parse_and_load_lyrics(text)

    def parse_and_load_lyrics(self, lrc_text):
        if not lrc_text:
            self.show_status(f"找不到歌詞")
            return
            
        self.clear_lyrics()
        self.current_lrc_text = lrc_text 
        pattern = re.compile(r'\[(\d{2}):(\d{2}\.\d{2,3})\](.*)')
        fs = self.settings.get("font_size", 28)
        ff = self.settings.get("font_family", "Microsoft JhengHei")
        line_idx = 0
        
        is_japanese_song = bool(re.search(r'[\u3040-\u30FF]', lrc_text))
        
        for line in lrc_text.split('\n'):
            match = pattern.match(line)
            if match:
                m, s, text = match.groups()
                seconds = int(m) * 60 + float(s)
                text = text.strip()
                if text:
                    furigana_html, words_data = build_clickable_furigana_html(text, self.search_artist, self.search_title, line_idx, is_japanese_song)
                    self.lyrics_data.append((seconds, furigana_html, text, words_data))
                    
                    wrapper = QWidget()
                    wl = QVBoxLayout(wrapper)
                    wl.setContentsMargins(0, 0, 0, 0)

                    label = QLabel()
                    label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter) 
                    
                    label.setTextInteractionFlags(Qt.TextInteractionFlag.LinksAccessibleByMouse)
                    label.setOpenExternalLinks(False)
                    label.linkActivated.connect(self.on_word_clicked)
                    label.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
                    label.customContextMenuRequested.connect(lambda pos, w=wrapper: self.show_settings_menu(pos=w.mapToGlobal(pos)))
                    
                    label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{furigana_html}</div>")
                    wl.addWidget(label)
                    
                    effect = QGraphicsOpacityEffect(wrapper)
                    effect.setOpacity(0.0)
                    wrapper.setGraphicsEffect(effect)
                    
                    self.content_layout.addWidget(wrapper)
                    self.lyric_labels.append({'wrapper': wrapper, 'label': label})
                    line_idx += 1
                    
        self.content_layout.addSpacing(self.height()) 

    def on_word_clicked(self, link):
        current_time = time.time()
        if link == self.last_clicked_link and (current_time - self.last_clicked_time) < 0.4:
            self.last_clicked_link = "" 
            self.handle_word_edit(link)
        else:
            self.last_clicked_link = link
            self.last_clicked_time = current_time

    def handle_word_edit(self, link):
        if link.startswith("edit:"):
            _, line_idx_str, word_idx_str = link.split(":")
            line_idx, word_idx = int(line_idx_str), int(word_idx_str)
            word_data = self.lyrics_data[line_idx][3][word_idx]
            
            if not word_data: return
            
            orig_word, current_hira = word_data['orig'], word_data['hira']

            prompt_msg = f"請為漢字「{orig_word}」輸入正確的發音：\n支援直接打羅馬拼音，如 watashi 會自動轉為 わたし"
            new_input, ok = QInputDialog.getText(self, "精準修正假名", prompt_msg, text=current_hira)

            if ok and new_input.strip():
                new_hira = romaji_to_hiragana(new_input.strip())
                cursor.execute("INSERT OR REPLACE INTO word_corrections VALUES (?, ?, ?, ?)", 
                               (self.search_artist, self.search_title, orig_word, new_hira))
                conn.commit()
                self.parse_and_load_lyrics(self.current_lrc_text)

    def refresh_lyrics_display(self, position):
        current_index = -1
        adjusted_position = position + self.current_sync_offset
        
        for i in range(len(self.lyrics_data)):
            if adjusted_position >= self.lyrics_data[i][0]: current_index = i
            else: break
                
        if current_index != self.last_index:
            self.animate_to_index(current_index)

    def animate_to_index(self, index):
        self.last_index = index
        is_mini = self.settings.get("mini_mode")
        lines_to_show = self.settings.get("display_lines", 2)

        if hasattr(self, 'anim_group') and self.anim_group.state() == QAbstractAnimation.State.Running:
            self.anim_group.stop()
        self.anim_group = QParallelAnimationGroup()

        if self.lyric_labels:
            scroll_target = max(0, index)
            if scroll_target >= len(self.lyric_labels):
                scroll_target = len(self.lyric_labels) - 1
                
            target_y = self.lyric_labels[scroll_target]['wrapper'].y()
            scroll_anim = QPropertyAnimation(self.scroll_area.verticalScrollBar(), b"value")
            scroll_anim.setDuration(400)
            scroll_anim.setEasingCurve(QEasingCurve.Type.OutCubic)
            scroll_anim.setStartValue(self.scroll_area.verticalScrollBar().value())
            scroll_anim.setEndValue(target_y)
            self.anim_group.addAnimation(scroll_anim)

            for i, item in enumerate(self.lyric_labels):
                effect = item['wrapper'].graphicsEffect()
                op_anim = QPropertyAnimation(effect, b"opacity")
                op_anim.setDuration(400)
                
                if i == index:
                    op_anim.setEndValue(1.0) 
                elif index == -1 and i < lines_to_show:
                    op_anim.setEndValue(0.8)
                elif index < i < index + lines_to_show:
                    if not is_mini:
                        op_anim.setEndValue(0.8)
                    else:
                        op_anim.setEndValue(0.0)
                else:
                    op_anim.setEndValue(0.0) 
                    
                self.anim_group.addAnimation(op_anim)

        self.anim_group.start()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.MouseButton.LeftButton and self.drag_pos is not None:
            self.move(event.globalPosition().toPoint() - self.drag_pos)
            event.accept()

    def contextMenuEvent(self, event):
        self.show_settings_menu(pos=event.globalPos())

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_BracketLeft: self.adjust_sync(-0.5)
        elif event.key() == Qt.Key.Key_BracketRight: self.adjust_sync(0.5)

    def show_settings_menu(self, pos=None):
        menu = QMenu(self)
        menu.setStyleSheet("QMenu { font-size: 14px; padding: 5px; }")
        
        menu.addAction("操作說明", self.show_help_dialog)
        
        pin_action = QAction("取消釘選視窗" if self.settings.get("pin_window") else "釘選視窗", self)
        pin_action.triggered.connect(self.toggle_pin_window)
        menu.addAction(pin_action)
        menu.addSeparator()
        
        search_menu = menu.addMenu("歌詞抓取與補救")
        search_menu.addAction("選擇備選歌詞", self.choose_alternative_lyrics)
        search_menu.addAction("手動搜尋", self.manual_search_lyrics)
        search_menu.addAction("還原自動偵測", self.reset_manual_search)
        search_menu.addAction("重新抓取", self.clear_cache_and_refetch)
        search_menu.addAction("貼上自訂歌詞", self.import_custom_lyrics)
        
        sync_menu = menu.addMenu("時間同步微調")
        sync_menu.addAction("歌詞提早 0.5s", lambda: self.adjust_sync(0.5))
        sync_menu.addAction("歌詞延遲 0.5s", lambda: self.adjust_sync(-0.5))
        sync_menu.addAction("重置時間同步", lambda: self.adjust_sync('reset'))
        
        ui_menu = menu.addMenu("視窗外觀與排版")
        mini_action = QAction("關閉極簡模式" if self.settings.get("mini_mode") else "開啟極簡模式", self)
        mini_action.triggered.connect(self.toggle_mini_mode)
        ui_menu.addAction(mini_action)
        
        color_action = QAction("關閉主題色" if self.settings.get("dynamic_color") else "開啟主題色", self)
        color_action.triggered.connect(self.toggle_dynamic_color)
        ui_menu.addAction(color_action)
        ui_menu.addSeparator()
        
        ui_menu.addAction("設定顯示行數", self.set_display_lines)
        ui_menu.addAction("設定字體大小", self.set_font_size_menu)
        ui_menu.addAction("選擇字型", self.set_custom_font)
        ui_menu.addAction("匯入自訂 CSS", self.load_custom_css)
        ui_menu.addAction("清除自訂 CSS", self.clear_custom_css)
        
        menu.addSeparator()
        menu.addAction("隱藏視窗", self.hide_window)
        
        if isinstance(pos, QPoint): menu.exec(pos)
        else: 
            if self.settings_btn.isVisible(): menu.exec(self.settings_btn.mapToGlobal(self.settings_btn.rect().bottomLeft()))
            else: menu.exec(self.mapToGlobal(self.rect().center()))

    def toggle_pin_window(self):
        self.settings["pin_window"] = not self.settings.get("pin_window", False)
        save_settings(self.settings)
        if self.settings.get("pin_window"):
            self.hide_timer.stop()
        else:
            self.hide_timer.start()

    def set_display_lines(self):
        current = self.settings.get("display_lines", 2)
        val, ok = QInputDialog.getInt(self, "設定顯示行數", "請輸入要顯示的歌詞行數：", current, 1, 5, 1)
        if ok:
            self.settings["display_lines"] = val
            save_settings(self.settings)
            self.last_index = -2
            if self.lyrics_data:
                self.refresh_lyrics_display(self.media_worker.media_updated.pos if hasattr(self.media_worker, 'pos') else 0)

    def set_font_size_menu(self):
        current = self.settings.get("font_size", 28)
        val, ok = QInputDialog.getInt(self, "設定字體大小", "請輸入字體大小：", current, 10, 100, 2)
        if ok:
            self.settings["font_size"] = val
            save_settings(self.settings)
            self.font_update_timer.start()

    def toggle_mini_mode(self):
        self.settings["mini_mode"] = not self.settings.get("mini_mode")
        save_settings(self.settings)
        self.apply_mode_styles()
        self.last_index = -2 
        if self.lyrics_data:
            self.refresh_lyrics_display(self.media_worker.media_updated.pos if hasattr(self.media_worker, 'pos') else 0)

    def toggle_dynamic_color(self):
        self.settings["dynamic_color"] = not self.settings.get("dynamic_color")
        save_settings(self.settings)
        self.extract_dominant_color(None) 
        self.apply_mode_styles()

    def adjust_sync(self, amount):
        if not self.search_title: return 
        
        if amount == 'reset': 
            self.current_sync_offset = 0.0
        else: 
            self.current_sync_offset += amount
            
        cursor.execute("INSERT OR REPLACE INTO sync_offsets VALUES (?, ?, ?)", 
                       (self.search_artist, self.search_title, self.current_sync_offset))
        conn.commit()
        
        self.hint_label.setText(f"同步微調: {self.current_sync_offset:+.1f}s")
        self.last_index = -2

    def set_custom_font(self):
        current_font = QFont(self.settings.get("font_family", "Microsoft JhengHei"))
        font, ok = QFontDialog.getFont(current_font, self, "選擇字型")
        if ok:
            self.settings["font_family"] = font.family()
            self.header_label.setStyleSheet(f"color: #b3b3b3; font-size: 14px; font-weight: bold; font-family: \"{font.family()}\";")
            save_settings(self.settings)
            if self.current_lrc_text: self.parse_and_load_lyrics(self.current_lrc_text)

    def load_custom_css(self):
        file_name, _ = QFileDialog.getOpenFileName(self, "選擇 CSS 檔案", "", "CSS Files (*.css);;All Files (*)")
        if file_name:
            self.settings["custom_css_path"] = file_name
            save_settings(self.settings)
            self.apply_mode_styles()

    def clear_custom_css(self):
        self.settings["custom_css_path"] = ""
        save_settings(self.settings)
        self.apply_mode_styles()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setStyleSheet("QInputDialog { background-color: white; }")
    window = FloatingLyricsApp()
    window.show()
    sys.exit(app.exec())