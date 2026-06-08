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
                          QPropertyAnimation, QEasingCurve, QAbstractAnimation, QTimer, QPoint, QEvent, QFileSystemWatcher, QRect)
from PyQt6.QtWidgets import (QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
                             QMenu, QFileDialog, QInputDialog, QFrame, 
                             QPushButton, QScrollArea, QGraphicsOpacityEffect, 
                             QSystemTrayIcon, QStyle, QFontDialog, QSizeGrip,
                             QDialog, QTextEdit, QGridLayout, QMessageBox, QListWidget, QListWidgetItem)
from PyQt6.QtGui import QFont, QAction, QPixmap, QImage, QColor

from utils import romaji_to_hiragana, text_to_romaji_query, kks
from config import config, DB_FILE, SETTINGS_FILE
from media import MediaWorker
from fetcher import LyricsFetcher

# ================= 1. 資料庫與設定檔初始化 =================
from db import db

def load_settings():
    return config.get_all()

def save_settings(settings):
    config.settings = settings
    config.save_settings()

# ================= 2. 點擊式假名排版核心 =================
def build_clickable_furigana_html(text, artist, title, line_index, is_japanese=True):
    if not is_japanese:
        html = '<table border="0" cellpadding="0" cellspacing="0" align="left" style="margin: 0px;">'
        row1 = "<tr class='furigana-row'><td align='center' style='padding: 0;'></td></tr>"
        text_escaped = text.replace(' ', '&nbsp;')
        row2 = f"<tr class='kanji-row'><td align='center' style='white-space: nowrap; padding: 0;'>{text_escaped}</td></tr>"
        html += row1 + row2 + "</table>"
        return html, []

    words = kks.convert(text)
    
    html = '<table border="0" cellpadding="0" cellspacing="0" align="left" style="margin: 0px;">'
    row1 = "<tr class='furigana-row'>" 
    row2 = "<tr class='kanji-row'>" 
    words_data = []

    for word_index, item in enumerate(words):
        orig = item['orig']
        hira = item['hira']

        db_hira = db.get_word_correction(artist, title, orig)
        if db_hira: hira = db_hira

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
                row1 += f"<td align='center' style='padding: 0; color: #a5b4fc;'>{a_start}{p_hira}{a_end}</td>"
                row2 += f"<td align='center' style='white-space: nowrap; padding: 0;'>{a_start}{p_orig_escaped}{a_end}</td>"
            
    row1 += "</tr>"
    row2 += "</tr>"
    html += row1 + row2 + "</table>"
    return html, words_data

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
        
        self.settings_watcher = QFileSystemWatcher([os.path.abspath(SETTINGS_FILE)])
        self.settings_watcher.fileChanged.connect(self.reload_settings_from_file)
        
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
        
        from hotkeys import HotkeyManager
        self.hotkey_manager = HotkeyManager()
        self.hotkey_manager.toggle_visibility_signal.connect(self.toggle_visibility_from_hotkey)
        self.hotkey_manager.adjust_sync_forward_signal.connect(lambda: self.adjust_sync(0.5))
        self.hotkey_manager.adjust_sync_backward_signal.connect(lambda: self.adjust_sync(-0.5))

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
        self.resize(800, 80) 
        
        self.container = QFrame(self)
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.addWidget(self.container)
        
        vbox = QVBoxLayout(self.container)
        vbox.setContentsMargins(10, 10, 10, 10)
        
        island_hbox = QHBoxLayout()
        island_hbox.setContentsMargins(10, 0, 10, 0)
        
        self.album_art_label = QLabel()
        self.album_art_label.setFixedSize(60, 60)
        self.album_art_label.setStyleSheet("background-color: rgba(255,255,255,20); border-radius: 30px;")
        self.album_art_label.setScaledContents(True)
            
        island_hbox.addWidget(self.album_art_label)
        
        self.scroll_area = TransparentScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.viewport().installEventFilter(self)
        
        self.content_widget = QWidget()
        self.content_layout = QVBoxLayout(self.content_widget)
        self.content_layout.setContentsMargins(10, 0, 10, 0)
        self.content_layout.setAlignment(Qt.AlignmentFlag.AlignVCenter)
            
        self.scroll_area.setWidget(self.content_widget)
        island_hbox.addWidget(self.scroll_area, 1)
        
        vbox.addLayout(island_hbox, 1)
        
        self.show_status("等待音樂播放中...")

    def eventFilter(self, obj, event):
        if obj == self.scroll_area.viewport() and event.type() == QEvent.Type.Wheel:
            self.wheelEvent(event) 
            return True 
        return super().eventFilter(obj, event)

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        if delta > 0:
            self.settings["font_size"] = min(100, self.settings.get("font_size", 22) + 2)
        elif delta < 0:
            self.settings["font_size"] = max(10, self.settings.get("font_size", 22) - 2)
        
        pass
        pass
        
        save_settings(self.settings)
        self.font_update_timer.start()

    def apply_font_size_change(self):
        fs = self.settings.get("font_size", 22)
        ff = self.settings.get("font_family", "Noto Sans JP")
        show_furigana = str(self.settings.get("show_furigana", "true")).lower() != "false"
        
        for i, item in enumerate(self.lyric_labels):
            label = item['label']
            html = self.lyrics_data[i][1]
            
            if not show_furigana:
                clean_html = re.sub(r'<rt>.*?</rt>', '', html)
                clean_html = clean_html.replace('<ruby>', '').replace('</ruby>', '')
                html = clean_html
                label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{html}</div>")
            else:
                f_size = max(10, int(fs * 0.6))
                sized_html = html.replace("<tr class='kanji-row'>", f"<tr class='kanji-row' style='font-size: {fs}px;'>")
                label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {f_size}px; font-weight: bold;'>{sized_html}</div>")
        
        self.content_widget.adjustSize()
        if self.lyric_labels:
            scroll_target = max(0, self.last_index)
            if scroll_target < len(self.lyric_labels):
                target_y = self.lyric_labels[scroll_target]['wrapper'].y()
                self.scroll_area.verticalScrollBar().setValue(target_y)

    def reload_settings_from_file(self, path):
        try:
            old_furigana = str(self.settings.get("show_furigana", "true")).lower() != "false"
            self.settings = load_settings()
            new_furigana = str(self.settings.get("show_furigana", "true")).lower() != "false"
            
            if old_furigana != new_furigana:
                if self.current_lrc_text:
                    cached_lyric = db.get_cached_lyrics(self.search_artist, self.search_title)
                    if cached_lyric:
                        self.current_lrc_text = cached_lyric
                    self.parse_and_load_lyrics(self.current_lrc_text)
            else:
                self.apply_font_size_change()
            
            if SETTINGS_FILE not in self.settings_watcher.files():
                self.settings_watcher.addPath(os.path.abspath(SETTINGS_FILE))
        except Exception as e:
            print("Failed to reload settings:", e)

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

    def toggle_visibility_from_hotkey(self):
        if self.isHidden():
            self.show_window()
            self.activateWindow()
        else:
            self.hide_window()

    def force_quit(self):
        self.tray_icon.hide()
        QApplication.instance().quit()

    def update_media_info(self, title, artist, album, position, thumb_bytes, is_playing):
        if thumb_bytes:
            pixmap = QPixmap()
            pixmap.loadFromData(thumb_bytes)
            self.album_art_label.setPixmap(pixmap)
            
        if is_playing:
            if self.isHidden() and title != "": self.show_window() 
            self.hide_timer.stop()
        else:
            if not self.isHidden() and not self.settings.get("pin_window"):
                self.hide_timer.start() 
        
        # Detect if song restarted (e.g. looped)
        last_pos = getattr(self, 'last_position', 0)
        song_restarted = False
        if is_playing and title == getattr(self, 'media_title', None) and artist == getattr(self, 'media_artist', None):
            if position < 2.0 and last_pos > 10.0:
                song_restarted = True
        self.last_position = position

        if title != self.media_title or artist != self.media_artist or song_restarted:
            song_changed = title != self.media_title or artist != self.media_artist
            
            if song_changed:
                self.media_title = title
                self.media_artist = artist
                self.search_title = title
                self.search_artist = artist
                
                self.current_sync_offset = db.get_sync_offset(self.search_artist, self.search_title)
                ms_val = int(self.current_sync_offset * 1000)
                    
                self.lyrics_data = []
                self.current_lyrics_options = []
                self.show_status(f"正在搜尋歌詞...")
                
                self.extract_dominant_color(thumb_bytes)
                self.apply_mode_styles()
                
                self.start_lyric_fetcher()

            if title and artist:
                # 【新增】記錄播放歷史
                try:
                    db.add_listening_history(artist, title, album, 180)
                except Exception as e:
                    print("Error inserting history:", e)
        
        self.last_position = position
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
            minutes = opt.get('duration', 0) // 60
            seconds = opt.get('duration', 0) % 60
            has_sync = bool(re.search(r'\[\d{2}:\d{2}', opt.get('lyrics', '')))
            tag = "[動態 LRC]" if has_sync else "[純文字]"
            display_text = f"{tag} [{minutes:02}:{seconds:02}] {opt.get('title', '')} - {opt.get('artist', '')}"
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
                db.save_cached_lyrics(self.search_artist, self.search_title, lrc_text)
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
                
                db.save_cached_lyrics(self.search_artist, self.search_title, lrc_text)
                self.parse_and_load_lyrics(lrc_text)
            dialog.accept()
            
        save_btn.clicked.connect(save_and_close)
        cancel_btn.clicked.connect(dialog.reject)
        
        dialog.exec()

    def clear_cache_and_refetch(self):
        if not self.search_title: 
            return
            
        db.delete_cached_lyrics(self.search_artist, self.search_title)
        
        self.lyrics_data = []
        self.current_lyrics_options = []
        self.last_index = -2
        self.show_status("清除快取並重新搜尋中...")
        
        self.start_lyric_fetcher()

    def trigger_lyric_search(self, manual_label=False):
        self.current_lyrics_options = []
        if manual_label:
            orig_text = f"{self.media_title} - {self.media_artist}" if self.media_artist else self.media_title
            search_text = f"{self.search_title} - {self.search_artist}" if self.search_artist else self.search_title
            
        self.current_sync_offset = db.get_sync_offset(self.search_artist, self.search_title)
        ms_val = int(self.current_sync_offset * 1000)
        
        self.lyrics_data = []
        self.current_lyrics_options = []
        self.last_index = -2
        self.show_status("重新搜尋中...")
        
        self.start_lyric_fetcher()

    def apply_mode_styles(self):
        r, g, b, a = self.theme_color
        radius = 40
        base_style = f"QFrame {{ background-color: rgba({r}, {g}, {b}, {a}); border-radius: {radius}px; }}"
        self.scroll_area.setStyleSheet("background: transparent; border: none;")
        self.content_widget.setStyleSheet("background: transparent;")
            
        self.container.setStyleSheet(base_style)
        self.resize(800, 80)

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
        fs = self.settings.get("font_size", 22)
        ff = self.settings.get("font_family", "Noto Sans JP")
        label = QLabel(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{text}</div>")
        label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter) 
        self.content_layout.addWidget(label)
        self.content_layout.addStretch()

    def clear_lyrics(self):
        while self.content_layout.count():
            item = self.content_layout.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self.lyric_labels = []
        self.lyrics_data = []
        self.last_index = -2 
        
        if hasattr(self, 'intro_wrapper'):
            del self.intro_wrapper
        if hasattr(self, 'intro_label'):
            del self.intro_label

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
        pattern = re.compile(r'\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\](.*)')
        fs = self.settings.get("font_size", 22)
        ff = self.settings.get("font_family", "Noto Sans JP")
        
        self.intro_wrapper = QWidget()
        intro_ly = QVBoxLayout(self.intro_wrapper)
        intro_ly.setContentsMargins(0, 0, 0, 0)
        
        title_disp = getattr(self, 'media_title', self.search_title)
        artist_disp = getattr(self, 'media_artist', self.search_artist)
        if not title_disp: title_disp = "Floating Lyrics"
        
        self.intro_label = QLabel(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>🎵 {title_disp} - {artist_disp}</div>")
        self.intro_label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        intro_ly.addWidget(self.intro_label)
        
        intro_eff = QGraphicsOpacityEffect(self.intro_wrapper)
        intro_eff.setOpacity(0.0)
        self.intro_wrapper.setGraphicsEffect(intro_eff)
        self.content_layout.addWidget(self.intro_wrapper)
        
        line_idx = 0
        
        source_provider = ""
        
        is_japanese_song = True
        has_time_tags = bool(re.search(r'\[\d{2}:\d{2}', lrc_text))
        
        parsed_lines = []
        for line in lrc_text.split('\n'):
            line = line.strip()
            if not line:
                continue

            if line.startswith("[source:"):
                source_provider = line[8:-1]
                continue

            match = pattern.match(line)
            if match:
                m, s, text = match.groups()
                seconds = int(m) * 60 + float(s)
                text = text.strip()
            elif not has_time_tags:
                seconds = -1.0
                text = line
            else:
                text = ""

            if text:
                parsed_lines.append({"seconds": seconds, "text": text, "translation": None})
                
        # Sort and merge translations
        if has_time_tags:
            parsed_lines.sort(key=lambda x: x["seconds"])
            merged_lines = []
            for item in parsed_lines:
                if merged_lines and abs(item["seconds"] - merged_lines[-1]["seconds"]) < 0.05:
                    if not merged_lines[-1]["translation"]:
                        merged_lines[-1]["translation"] = item["text"]
                    else:
                        merged_lines[-1]["translation"] += " / " + item["text"]
                else:
                    merged_lines.append(item)
            parsed_lines = merged_lines

        alignment = self.settings.get("text_alignment", "left")

        for line_idx, item in enumerate(parsed_lines):
            seconds = item["seconds"]
            text = item["text"]
            translation = item["translation"]

            if text:
                    furigana_html, words_data = build_clickable_furigana_html(text, self.search_artist, self.search_title, line_idx, is_japanese_song)
                    self.lyrics_data.append((seconds, furigana_html, text, words_data))
                    
                    wrapper = QWidget()
                    wl = QVBoxLayout(wrapper)
                    wl.setContentsMargins(0, 0, 0, 0)

                    label = QLabel()
                    align_flag = Qt.AlignmentFlag.AlignCenter if alignment == "center" else (Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
                    label.setAlignment(align_flag) 
                    
                    label.setTextInteractionFlags(Qt.TextInteractionFlag.LinksAccessibleByMouse)
                    label.setOpenExternalLinks(False)
                    label.linkActivated.connect(self.on_word_clicked)
                    label.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
                    
                    show_furigana = str(self.settings.get("show_furigana", "true")).lower() != "false"
                    
                    trans_html = ""
                    if translation:
                        t_size = max(10, int(fs * 0.5))
                        trans_html = f"<div align='{alignment}' style='font-size: {t_size}px; color: rgba(255,255,255,160); margin-top: -2px; font-weight: normal;'>{translation}</div>"
                        
                    if not show_furigana:
                        clean_html = re.sub(r'<rt>.*?</rt>', '', furigana_html)
                        clean_html = clean_html.replace('<ruby>', '').replace('</ruby>', '')
                        label.setText(f"<div align='{alignment}' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px; font-weight: bold;'>{clean_html}{trans_html}</div>")
                    else:
                        f_size = max(10, int(fs * 0.6))
                        sized_furigana = furigana_html.replace("<tr class='kanji-row'>", f"<tr class='kanji-row' style='font-size: {fs}px;'>")
                        label.setText(f"<div align='{alignment}' style='font-family: \"{ff}\"; color: #ffffff; font-size: {f_size}px; font-weight: bold;'>{sized_furigana}{trans_html}</div>")
                    wl.addWidget(label)
                    
                    effect = QGraphicsOpacityEffect(wrapper)
                    effect.setOpacity(0.0)
                    wrapper.setGraphicsEffect(effect)
                    
                    self.content_layout.addWidget(wrapper)
                    self.lyric_labels.append({'wrapper': wrapper, 'label': label})
                    line_idx += 1
                    
        if source_provider:
            source_label = QLabel(f"歌詞提供者: {source_provider}")
            source_label.setStyleSheet(f"color: rgba(255, 255, 255, 120); font-size: {max(12, int(fs*0.45))}px; padding-top: 20px; font-weight: normal; font-family: \"{ff}\";")
            source_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
            self.content_layout.addWidget(source_label)
            
        self.content_layout.addSpacing(self.height()) 

    def on_word_clicked(self, link):
        self.handle_word_edit(link)

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
                db.save_word_correction(self.search_artist, self.search_title, orig_word, new_hira)
                self.parse_and_load_lyrics(self.current_lrc_text)

    def refresh_lyrics_display(self, position):
        current_index = -1
        adjusted_position = position + self.current_sync_offset
        
        for i in range(len(self.lyrics_data)):
            if self.lyrics_data[i][0] < 0:
                break
            if adjusted_position >= self.lyrics_data[i][0]: current_index = i
            else: break
                
        if current_index != self.last_index:
            self.animate_to_index(current_index)

    def animate_to_index(self, index):
        self.last_index = index
        lines_to_show = self.settings.get("island_lines", 1)
        
        is_plain_text = len(self.lyrics_data) > 0 and self.lyrics_data[0][0] < 0

        if hasattr(self, 'anim_group') and self.anim_group.state() == QAbstractAnimation.State.Running:
            self.anim_group.stop()
        self.anim_group = QParallelAnimationGroup()

        target_y = 0
        target_width_hint = 0
        target_height_hint = 0
        
        if is_plain_text or index >= 0:
            if self.lyric_labels:
                scroll_target = max(0, min(index, len(self.lyric_labels) - 1))
                target_y = self.lyric_labels[scroll_target]['wrapper'].y()
                active_labels = self.lyric_labels[scroll_target:scroll_target + lines_to_show]
                if active_labels:
                    target_width_hint = max(lbl['label'].sizeHint().width() for lbl in active_labels)
                    target_height_hint = sum(lbl['label'].sizeHint().height() for lbl in active_labels)
        else:
            if hasattr(self, 'intro_wrapper'):
                target_y = self.intro_wrapper.y()
                target_width_hint = self.intro_label.sizeHint().width()
                target_height_hint = self.intro_label.sizeHint().height()

        scroll_anim = QPropertyAnimation(self.scroll_area.verticalScrollBar(), b"value")
        scroll_anim.setDuration(400)
        scroll_anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        scroll_anim.setStartValue(self.scroll_area.verticalScrollBar().value())
        scroll_anim.setEndValue(target_y)
        self.anim_group.addAnimation(scroll_anim)

        # Dynamic geometry animation
        current_geom = self.geometry()
        center_x = current_geom.center().x()
        base_width_padding = 130 # Album art + margins
        base_height_padding = 40 # Top/bottom margins
        
        target_width = min(1200, max(300, base_width_padding + target_width_hint))
        target_height = max(80, base_height_padding + target_height_hint)
        
        target_x = center_x - target_width // 2
        
        target_geom = QRect(target_x, current_geom.y(), target_width, target_height)
        
        self.geom_anim = QPropertyAnimation(self, b"geometry")
        self.geom_anim.setDuration(400)
        self.geom_anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.geom_anim.setStartValue(current_geom)
        self.geom_anim.setEndValue(target_geom)
        self.anim_group.addAnimation(self.geom_anim)

        if hasattr(self, 'intro_wrapper'):
            intro_eff = self.intro_wrapper.graphicsEffect()
            if intro_eff:
                op_anim = QPropertyAnimation(intro_eff, b"opacity")
                op_anim.setDuration(400)
                op_anim.setEndValue(1.0 if index < 0 and not is_plain_text else 0.0)
                self.anim_group.addAnimation(op_anim)

        for i, item in enumerate(self.lyric_labels):
            effect = item['wrapper'].graphicsEffect()
            op_anim = QPropertyAnimation(effect, b"opacity")
            op_anim.setDuration(400)
            
            if is_plain_text:
                op_anim.setEndValue(1.0)
            elif i == index:
                op_anim.setEndValue(1.0) 
            elif index < i < index + lines_to_show:
                op_anim.setEndValue(0.8)
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

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_BracketLeft: self.adjust_sync(-0.5)
        elif event.key() == Qt.Key.Key_BracketRight: self.adjust_sync(0.5)

    def toggle_text_alignment(self):
        current = self.settings.get("text_alignment", "left")
        new_align = "center" if current == "left" else "left"
        self.settings["text_alignment"] = new_align
        self.save_settings(self.settings)
        if self.current_lrc_text:
            self.parse_and_load_lyrics(self.current_lrc_text)

    def toggle_pin_window(self):
        self.settings["pin_window"] = not self.settings.get("pin_window", True)
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
        current = self.settings.get("font_size", 22)
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
        db.save_sync_offset(self.search_artist, self.search_title, self.current_sync_offset)
        ms_val = int(self.current_sync_offset * 1000)
        if hasattr(self, 'last_position'):
            self.refresh_lyrics_display(self.last_position)
        self.last_index = -2

    def set_preferred_source(self):
        current = self.settings.get("preferred_source", "NetEase")
        sources = ["NetEase", "Lrclib", "Musixmatch", "QQMusic"]
        try:
            current_idx = sources.index(current)
        except ValueError:
            current_idx = 0
            
        val, ok = QInputDialog.getItem(self, "設定優先搜尋來源", "請選擇優先尋找歌詞的平台：", sources, current_idx, False)
        if ok and val:
            self.settings["preferred_source"] = val
            save_settings(self.settings)

    def set_custom_font(self):
        current_font = QFont(self.settings.get("font_family", "Noto Sans JP"))
        font, ok = QFontDialog.getFont(current_font, self, "選擇字型")
        if ok:
            self.settings["font_family"] = font.family()
            save_settings(self.settings)
            if self.current_lrc_text: self.parse_and_load_lyrics(self.current_lrc_text)

if __name__ == '__main__':
    def global_exception_handler(exctype, value, tb):
        import traceback
        with open("crash_log.txt", "w", encoding="utf-8") as f:
            traceback.print_exception(exctype, value, tb, file=f)
        sys.__excepthook__(exctype, value, tb)
    sys.excepthook = global_exception_handler

    with open("app.pid", "w") as f:
        f.write(str(os.getpid()))
        
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setStyleSheet("QInputDialog { background-color: white; }")
    window = FloatingLyricsApp()
    window.show()
    sys.exit(app.exec())
