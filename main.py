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

from PyQt6.QtCore import (Qt, QThread, pyqtSignal, QParallelAnimationGroup, 
                          QPropertyAnimation, QEasingCurve, QAbstractAnimation, QTimer, QPoint, QEvent)
from PyQt6.QtWidgets import (QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
                             QMenu, QFileDialog, QInputDialog, QFrame, 
                             QPushButton, QScrollArea, QGraphicsOpacityEffect, 
                             QSystemTrayIcon, QStyle, QFontDialog, QSizeGrip)
from PyQt6.QtGui import QFont, QAction, QPixmap, QImage, QColor

kks = pykakasi.kakasi()

# ================= 1. 資料庫與設定檔初始化 =================
DB_FILE = 'lyrics_data.db'
SETTINGS_FILE = 'settings.json'

conn = sqlite3.connect(DB_FILE, check_same_thread=False)
conn.execute("PRAGMA journal_mode=WAL;")
cursor = conn.cursor()
cursor.execute('''CREATE TABLE IF NOT EXISTS cache (artist TEXT, title TEXT, lyrics TEXT, PRIMARY KEY (artist, title))''')
cursor.execute('''CREATE TABLE IF NOT EXISTS word_corrections (artist TEXT, title TEXT, word TEXT, hira TEXT, PRIMARY KEY (artist, title, word))''')
# 【新增】創建獨立儲存每首歌時間偏移的資料表
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
    # 移除了全局的 sync_offset，因為現在是針對每首歌獨立記憶
    return {"font_size": 28, "font_family": "Microsoft JhengHei", "custom_css_path": "",
            "mini_mode": False, "dynamic_color": True}

def save_settings(settings):
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as f: json.dump(settings, f)

# ================= 2. 點擊式假名排版核心 =================
def build_clickable_furigana_html(text, artist, title, line_index):
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
            a_start = f"<a href='edit:{line_index}:{word_index}' style='text-decoration:none; color:inherit;'>"
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
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
        from winrt.windows.storage.streams import DataReader
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
        
    def run(self):
        try:
            cursor.execute("SELECT lyrics FROM cache WHERE title=? AND artist=?", (self.title, self.artist))
            row = cursor.fetchone()
            if row:
                self.lyrics_fetched.emit(row[0], []) 
                return

            clean_title = re.sub(r'\(feat\..*?\)|\- Remastered.*|\- Live.*', '', self.title, flags=re.IGNORECASE).strip()
            
            best_lyric = self.search_lrclib(clean_title, self.artist)
            
            if not best_lyric:
                try:
                    itunes_url = "https://itunes.apple.com/search"
                    params = {"term": f"{clean_title} {self.artist}", "entity": "song", "limit": 1, "country": "jp"}
                    resp = requests.get(itunes_url, params=params, timeout=5)
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        if results:
                            jp_title = results[0].get("trackName", "")
                            jp_artist = results[0].get("artistName", "")
                            
                            if jp_title and (jp_title != clean_title):
                                best_lyric = self.search_lrclib(jp_title, jp_artist)
                except Exception as e:
                    pass 

            if best_lyric:
                cursor.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", (self.artist, self.title, best_lyric))
                conn.commit()
                self.lyrics_fetched.emit(best_lyric, [])
                return
                
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
                valid_lyrics = [(t.get('trackName'), t["syncedLyrics"]) for t in data if t.get("syncedLyrics")]
                if valid_lyrics:
                    valid_lyrics.sort(key=lambda x: 100 if re.search(r'[\u3040-\u30FF]', x[1]) else 0, reverse=True)
                    return valid_lyrics[0][1]
        except: pass
        return None

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
        
        # 【新增】當前歌曲專屬的微調秒數
        self.current_sync_offset = 0.0 
        
        self.current_lrc_text = ""
        self.lyrics_data = []
        self.lyric_labels = []
        self.drag_pos = None
        self.last_index = -2 
        self.theme_color = (0, 0, 0, 160)
        
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
        
        self.settings_btn = QPushButton("設定")
        self.settings_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.settings_btn.setStyleSheet("QPushButton { background: transparent; color: rgba(255,255,255,150); font-weight: bold; border: none; padding: 5px; } QPushButton:hover { color: white; }")
        self.settings_btn.clicked.connect(self.show_settings_menu)
        top_hbox.addWidget(self.settings_btn)
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
        bottom_hbox.setContentsMargins(0, 0, 10, 10)
        bottom_hbox.addStretch()
        
        self.sizegrip = QSizeGrip(self.container)
        self.sizegrip.setStyleSheet("width: 20px; height: 20px; background: transparent;")
        bottom_hbox.addWidget(self.sizegrip, 0, Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignRight)
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
        
        self.hint_label.setText(f"[字體大小: {self.settings['font_size']}px]")
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
            if not self.hide_timer.isActive() and not self.isHidden():
                self.hide_timer.start() 
        
        if title != self.media_title or artist != self.media_artist:
            self.media_title = title
            self.media_artist = artist
            self.search_title = title
            self.search_artist = artist
            
            # 【讀取】每當換歌時，自動從資料庫抓取專屬於這首歌的微調秒數
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
            else:
                self.header_label.setText("正在等待音樂播放...")
                
            self.lyrics_data = []
            self.show_status(f"正在搜尋歌詞...")
            
            self.extract_dominant_color(thumb_bytes)
            self.apply_mode_styles()
            
            self.fetcher = LyricsFetcher(self.search_title, self.search_artist)
            self.fetcher.lyrics_fetched.connect(self.handle_fetched_lyrics)
            self.fetcher.start()
        
        if self.lyrics_data:
            self.refresh_lyrics_display(position)

    def manual_search_lyrics(self):
        default_text = f"{self.search_title} - {self.search_artist}" if self.search_title else ""
        text, ok = QInputDialog.getText(self, "手動搜尋歌詞", "請輸入「日文歌名 - 歌手」進行精準搜尋：", text=default_text)
        if ok and text.strip():
            if "-" in text:
                parts = text.split("-", 1)
                self.search_title = parts[0].strip()
                self.search_artist = parts[1].strip()
            else:
                self.search_title = text.strip()
                self.search_artist = ""
                
            if self.search_title and self.search_artist:
                self.header_label.setText(f"{self.search_title} - {self.search_artist} (手動)")
            else:
                self.header_label.setText(f"{self.search_title} (手動)")
            
            # 【讀取】手動搜尋後，也會自動載入屬於該首歌曲的微調紀錄
            cursor.execute("SELECT offset FROM sync_offsets WHERE artist=? AND title=?", (self.search_artist, self.search_title))
            db_row = cursor.fetchone()
            self.current_sync_offset = db_row[0] if db_row else 0.0
            
            self.lyrics_data = []
            self.last_index = -2
            self.show_status("手動搜尋中...")
            
            self.fetcher = LyricsFetcher(self.search_title, self.search_artist)
            self.fetcher.lyrics_fetched.connect(self.handle_fetched_lyrics)
            self.fetcher.start()

    def apply_mode_styles(self):
        base_style = ""
        if self.settings.get("mini_mode"):
            base_style = "QFrame { background: transparent; }"
            self.scroll_area.setStyleSheet("background: transparent; border: none;")
            self.settings_btn.hide() 
        else:
            r, g, b, a = self.theme_color
            base_style = f"QFrame {{ background-color: rgba({r}, {g}, {b}, {a}); border-radius: 20px; }}"
            self.scroll_area.setStyleSheet("background: transparent; border: none;")
            self.content_widget.setStyleSheet("background: transparent;")
            self.settings_btn.show()
            
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

    def handle_fetched_lyrics(self, best_lyric, options_list):
        self.parse_and_load_lyrics(best_lyric)

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
        
        for line in lrc_text.split('\n'):
            match = pattern.match(line)
            if match:
                m, s, text = match.groups()
                seconds = int(m) * 60 + float(s)
                text = text.strip()
                if text:
                    furigana_html, words_data = build_clickable_furigana_html(text, self.search_artist, self.search_title, line_idx)
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
        if link.startswith("edit:"):
            _, line_idx_str, word_idx_str = link.split(":")
            line_idx, word_idx = int(line_idx_str), int(word_idx_str)
            word_data = self.lyrics_data[line_idx][3][word_idx]
            orig_word, current_hira = word_data['orig'], word_data['hira']

            new_hira, ok = QInputDialog.getText(self, "精準修正假名", f"請輸入漢字「{orig_word}」的正確假名：", text=current_hira)

            if ok and new_hira.strip():
                new_hira = new_hira.strip()
                cursor.execute("INSERT OR REPLACE INTO word_corrections VALUES (?, ?, ?, ?)", 
                               (self.search_artist, self.search_title, orig_word, new_hira))
                conn.commit()
                self.parse_and_load_lyrics(self.current_lrc_text)

    def refresh_lyrics_display(self, position):
        current_index = -1
        # 【修改】使用該首歌曲專屬的微調秒數
        adjusted_position = position + self.current_sync_offset
        
        for i in range(len(self.lyrics_data)):
            if adjusted_position >= self.lyrics_data[i][0]: current_index = i
            else: break
                
        if current_index != self.last_index:
            self.animate_to_index(current_index)

    def animate_to_index(self, index):
        self.last_index = index
        is_mini = self.settings.get("mini_mode")

        if hasattr(self, 'anim_group') and self.anim_group.state() == QAbstractAnimation.State.Running:
            self.anim_group.stop()
        self.anim_group = QParallelAnimationGroup()

        if self.lyric_labels:
            scroll_target = max(0, index)
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
                elif i == index + 1:
                    if not is_mini or index == -1:
                        op_anim.setEndValue(0.5) 
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
        
        menu.addAction("手動搜尋 (修正歌名)", self.manual_search_lyrics)
        menu.addSeparator()
        
        mini_action = QAction("開啟極簡模式 (去背)" if not self.settings.get("mini_mode") else "關閉極簡模式", self)
        mini_action.triggered.connect(self.toggle_mini_mode)
        menu.addAction(mini_action)
        
        color_action = QAction("開啟專輯主題色" if not self.settings.get("dynamic_color") else "關閉專輯主題色", self)
        color_action.triggered.connect(self.toggle_dynamic_color)
        menu.addAction(color_action)
        menu.addSeparator()

        ui_menu = menu.addMenu("外觀與排版設定")
        ui_menu.addAction("選擇歌詞字型", self.set_custom_font)
        ui_menu.addAction("匯入自訂 CSS 樣式", self.load_custom_css)
        ui_menu.addAction("清除自訂 CSS", self.clear_custom_css)
        menu.addSeparator()

        sync_menu = menu.addMenu("時間同步微調")
        sync_menu.addAction("歌詞太慢 (提早 0.5s)  [ ] ]", lambda: self.adjust_sync(0.5))
        sync_menu.addAction("歌詞太快 (延遲 0.5s)  [ [ ]", lambda: self.adjust_sync(-0.5))
        sync_menu.addAction("重置時間同步", lambda: self.adjust_sync('reset'))
        menu.addSeparator()

        menu.addAction("隱藏視窗 (背景執行)", self.hide_window)
        menu.addAction("完全退出程式", self.force_quit) 
        
        if isinstance(pos, QPoint): menu.exec(pos)
        else: 
            if self.settings_btn.isVisible(): menu.exec(self.settings_btn.mapToGlobal(self.settings_btn.rect().bottomLeft()))
            else: menu.exec(self.mapToGlobal(self.rect().center()))

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
        if not self.search_title: return # 防呆：確保目前有歌曲才能調整
        
        if amount == 'reset': 
            self.current_sync_offset = 0.0
        else: 
            self.current_sync_offset += amount
            
        # 【儲存】一按下括號鍵調整時間，就立刻存入資料庫綁定該首歌曲
        cursor.execute("INSERT OR REPLACE INTO sync_offsets VALUES (?, ?, ?)", 
                       (self.search_artist, self.search_title, self.current_sync_offset))
        conn.commit()
        
        self.hint_label.setText(f"[同步微調: {self.current_sync_offset:+.1f}s]")
        self.last_index = -2

    def set_custom_font(self):
        current_font = QFont(self.settings.get("font_family", "Microsoft JhengHei"))
        font, ok = QFontDialog.getFont(current_font, self, "選擇歌詞字型")
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