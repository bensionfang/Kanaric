"""
主程式進入點與 PyQt6 桌面懸浮視窗介面 (UI)
負責統整所有模組，包含媒體監聽、歌詞抓取、假名注音轉換與資料庫快取，
並將結果顯示在一個可穿透、無邊框的桌面懸浮視窗上。
"""
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
    config.settings = config._load_settings()
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
        row2 = f"<tr class='kanji-row'><td align='center' style='white-space: nowrap; padding: 0;'><span class='kanji-text'>{text_escaped}</span></td></tr>"
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
                row1 += f"<td align='center' valign='bottom' style='padding: 0;'></td>"
                row2 += f"<td align='center' valign='top' style='white-space: nowrap; padding: 0;'>{a_start}<span class='kanji-text'>{p_orig_escaped}</span>{a_end}</td>"
            else:
                row1 += f"<td align='center' valign='bottom' style='padding: 0; color: #a5b4fc;'>{a_start}{p_hira}{a_end}</td>"
                row2 += f"<td align='center' valign='top' style='white-space: nowrap; padding: 0;'>{a_start}<span class='kanji-text'>{p_orig_escaped}</span>{a_end}</td>"
            
    row1 += "</tr>"
    row2 += "</tr>"
    html += row1 + row2 + "</table>"
    return html, words_data

# ================= 5. 事件穿透捲動區塊 =================
class TransparentScrollArea(QScrollArea):
    """
    客製化的捲動區域，攔截滑鼠滾輪事件以避免使用者誤觸滾動，
    確保歌詞的滾動是由程式內部時間軸所控制。
    """
    def wheelEvent(self, event):
        self.parent().wheelEvent(event)
        super().wheelEvent(event)

# ================= 6. 主程式介面 =================
class FloatingLyricsApp(QWidget):
    """
    主視窗類別 (Floating Lyrics App)
    負責管理所有 UI 呈現、動畫滾動邏輯、事件綁定，以及與背景執行緒 (MediaWorker, LyricsFetcher) 的通訊。
    """
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
        
        self.show_status("靈動島已啟動！等待音樂中...")
        self.hide_timer.start()

    def start_lyric_fetcher(self):
        """啟動或重啟歌詞抓取執行緒，確保不會有多個抓取任務同時進行"""
        if not hasattr(self, '_orphan_fetchers'):
            self._orphan_fetchers = []
        self._orphan_fetchers = [f for f in self._orphan_fetchers if f.isRunning()]
            
        if hasattr(self, 'fetcher') and self.fetcher is not None:
            try:
                self.fetcher.lyrics_fetched.disconnect()
            except TypeError:
                pass 
            if self.fetcher.isRunning():
                self._orphan_fetchers.append(self.fetcher)
                
        self.fetcher = LyricsFetcher(self.search_title, self.search_artist)
        self.fetcher.lyrics_fetched.connect(self.handle_fetched_lyrics)
        self.fetcher.start()

    def init_ui(self):
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        
        self.is_snapped_to_top = True
        screen = QApplication.primaryScreen().geometry()
        self.setGeometry((screen.width() - 800) // 2, 0, 800, 80)
        
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
        self.content_layout = QVBoxLayout()
        self.content_layout.setContentsMargins(20, 20, 20, 20)
        self.content_layout.setSpacing(10)

        self.intro_wrapper = QWidget()
        intro_layout = QVBoxLayout(self.intro_wrapper)
        intro_layout.setContentsMargins(0, 0, 0, 0)
        intro_layout.setSpacing(0)
        self.intro_label = QLabel("<div align='left' style='color: #ffffff; font-size: 22px;'>無播放中的媒體</div>")
        intro_layout.addWidget(self.intro_label)
        self.content_layout.addWidget(self.intro_wrapper)

        self.content_widget = QWidget()
        self.content_widget.setObjectName("contentWidget")
        self.content_widget.setLayout(self.content_layout)
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
                label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px;'>{html}</div>")
            else:
                f_size = max(10, int(fs * 0.6))
                sized_html = html.replace("<span class='kanji-text'>", f"<span class='kanji-text' style='font-size: {fs}px;'>")
                label.setText(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {f_size}px;'>{sized_html}</div>")
        
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
        """
        處理 MediaWorker 傳來的媒體更新訊號。
        若偵測到歌曲變更，會觸發新的歌詞搜尋；
        若進度更新，則觸發歌詞介面的滾動與高亮邏輯。
        """
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
        if not hasattr(self, 'theme_color'):
            self.theme_color = (0, 0, 0, 150)
        r, g, b, a = self.theme_color
        radius = 40
        if getattr(self, 'is_snapped_to_top', False):
            base_style = f"QFrame {{ background-color: rgba({r}, {g}, {b}, {a}); border-bottom-left-radius: {radius}px; border-bottom-right-radius: {radius}px; border-top-left-radius: 0px; border-top-right-radius: 0px; }}"
        else:
            base_style = f"QFrame {{ background-color: rgba({r}, {g}, {b}, {a}); border-radius: {radius}px; }}"
        
        if getattr(self, 'last_base_style', '') != base_style:
            self.container.setStyleSheet(base_style)
            self.scroll_area.setStyleSheet("background: transparent; border: none;")
            self.content_widget.setStyleSheet("background: transparent;")
            self.last_base_style = base_style

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
        label = QLabel(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px;'>{text}</div>")
        label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter) 
        self.content_layout.addWidget(label)
        self.content_layout.addStretch()

    def clear_lyrics(self):
        if hasattr(self, 'anim_group'):
            self.anim_group.stop()
            self.anim_group.clear()
            
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
        """
        解析 LRC 格式字串，將時間標籤與歌詞文字分離，
        並渲染到 UI 上的 QLabel 元件。
        支援處理日文假名注音 (Furigana) 的 HTML 格式。
        """
        if not lrc_text:
            self.show_status(f"找不到歌詞")
            return
            
        self.clear_lyrics()
        self.current_lrc_text = lrc_text 
        fs = self.settings.get("font_size", 22)
        ff = self.settings.get("font_family", "Noto Sans JP")
        
        self.intro_wrapper = QWidget()
        intro_ly = QVBoxLayout(self.intro_wrapper)
        intro_ly.setContentsMargins(0, 0, 0, 0)
        
        title_disp = getattr(self, 'media_title', self.search_title)
        artist_disp = getattr(self, 'media_artist', self.search_artist)
        if not title_disp: title_disp = "Floating Lyrics"
        
        self.intro_label = QLabel(f"<div align='left' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px;'>{title_disp} - {artist_disp}</div>")
        self.intro_label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        intro_ly.addWidget(self.intro_label)
        
        intro_eff = QGraphicsOpacityEffect(self.intro_wrapper)
        intro_eff.setOpacity(0.0)
        self.intro_wrapper.setGraphicsEffect(intro_eff)
        self.content_layout.addWidget(self.intro_wrapper)
        
        from lrc_parser import parse_lrc
        parsed_data = parse_lrc(lrc_text)
        source_provider = parsed_data["source"]
        parsed_lines = parsed_data["lines"]
        
        is_japanese_song = True
        
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
                        label.setText(f"<div align='{alignment}' style='font-family: \"{ff}\"; color: #ffffff; font-size: {fs}px;'>{clean_html}{trans_html}</div>")
                    else:
                        f_size = max(10, int(fs * 0.6))
                        sized_furigana = furigana_html.replace("<span class='kanji-text'>", f"<span class='kanji-text' style='font-size: {fs}px;'>")
                        label.setText(f"<div align='{alignment}' style='font-family: \"{ff}\"; color: #ffffff; font-size: {f_size}px;'>{sized_furigana}{trans_html}</div>")
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
        """
        根據目前的播放進度 (position)，計算應該顯示哪一行歌詞，
        並利用 PyQt6 的動畫引擎平滑地將歌詞捲動到該行。
        """
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

        if hasattr(self, 'anim_group'):
            self.anim_group.stop()
            self.anim_group.clear()
            self.anim_group.deleteLater()
        self.anim_group = QParallelAnimationGroup(self)

        target_y = 0
        target_width_hint = 0
        target_height_hint = 0
        
        if is_plain_text or index >= 0:
            if self.lyric_labels:
                scroll_target = max(0, min(index, len(self.lyric_labels) - 1))
                target_y = max(0, self.lyric_labels[scroll_target]['wrapper'].y() - 6)
                active_labels = self.lyric_labels[scroll_target:scroll_target + lines_to_show]
                if active_labels:
                    target_width_hint = max(lbl['label'].sizeHint().width() for lbl in active_labels)
                    target_height_hint = sum(lbl['label'].sizeHint().height() for lbl in active_labels) + 15
        else:
            if hasattr(self, 'intro_wrapper'):
                target_y = self.intro_wrapper.y()
                target_width_hint = self.intro_label.sizeHint().width()
                target_height_hint = self.intro_label.sizeHint().height()
                
                if lines_to_show >= 2 and self.lyric_labels:
                    extra_lines = lines_to_show - 1
                    active_labels = self.lyric_labels[0:extra_lines]
                    if active_labels:
                        lyric_width = max(lbl['label'].sizeHint().width() for lbl in active_labels)
                        lyric_height = sum(lbl['label'].sizeHint().height() for lbl in active_labels)
                        target_width_hint = max(target_width_hint, lyric_width)
                        target_height_hint += lyric_height + 15

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
        base_height_padding = 20 # vbox margins (10 top, 10 bottom)
        
        target_width = min(1200, max(300, base_width_padding + target_width_hint))
        target_height = max(80, base_height_padding + target_height_hint)
        
        target_x = center_x - target_width // 2
        
        target_y_pos = 0 if getattr(self, 'is_snapped_to_top', False) else current_geom.y()
        target_geom = QRect(target_x, target_y_pos, target_width, target_height)
        
        if getattr(self, 'drag_pos', None) is None:
            geom_anim = QPropertyAnimation(self, b"geometry")
            geom_anim.setDuration(400)
            geom_anim.setEasingCurve(QEasingCurve.Type.OutCubic)
            geom_anim.setStartValue(current_geom)
            geom_anim.setEndValue(target_geom)
            self.anim_group.addAnimation(geom_anim)

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
        if event.buttons() == Qt.MouseButton.LeftButton and getattr(self, 'drag_pos', None) is not None:
            new_pos = event.globalPosition().toPoint() - self.drag_pos
            old_snap = getattr(self, 'is_snapped_to_top', False)
            
            snap_threshold = 10 if old_snap else 5
            
            if new_pos.y() < snap_threshold:
                new_pos.setY(0)
                self.is_snapped_to_top = True
            else:
                self.is_snapped_to_top = False
                
            self.move(new_pos)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_pos = None
            self.apply_mode_styles()
            QTimer.singleShot(0, lambda: self.animate_to_index(getattr(self, 'last_index', -1)))
            event.accept()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_BracketLeft: self.adjust_sync(-0.5)
        elif event.key() == Qt.Key.Key_BracketRight: self.adjust_sync(0.5)

    def adjust_sync(self, amount):
        if not self.search_title: return 
        if amount == 'reset':
            self.current_sync_offset = 0.0
        else:
            self.current_sync_offset += amount
        db.save_sync_offset(self.search_artist, self.search_title, self.current_sync_offset)
        
        # 即時廣播給 Node.js (靈動島會即時收到並更新)
        def broadcast_offset():
            try:
                import requests
                requests.post('http://localhost:3000/api/lyrics/offset', json={
                    'title': self.search_title,
                    'artist': self.search_artist,
                    'offset': self.current_sync_offset
                }, timeout=1)
            except Exception:
                pass
        
        import threading
        threading.Thread(target=broadcast_offset, daemon=True).start()
        
        ms_val = int(self.current_sync_offset * 1000)
        if hasattr(self, 'last_position'):
            self.refresh_lyrics_display(self.last_position)
        self.last_index = -2



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
