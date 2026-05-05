import sys
import time
import traceback
import re
import asyncio
import requests
import pykakasi
from PyQt6.QtCore import (Qt, QThread, pyqtSignal, QParallelAnimationGroup, 
                          QPropertyAnimation, QEasingCurve, QAbstractAnimation)
from PyQt6.QtWidgets import (QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
                             QMenu, QFileDialog, QInputDialog, QFrame, QSizeGrip, 
                             QPushButton, QScrollArea, QGraphicsOpacityEffect)
from PyQt6.QtGui import QFont, QAction

kks = pykakasi.kakasi()

def add_furigana(text):
    """利用 HTML 表格模擬假名排版，並極致壓縮行高與空白"""
    result = kks.convert(text)
    html = '<table border="0" cellpadding="0" cellspacing="0" align="center" style="margin: 0px auto; line-height: 1;">'
    row1 = "<tr>" 
    row2 = "<tr>" 
    for item in result:
        orig = item['orig']
        hira = item['hira']
        orig_escaped = orig.replace(' ', '&nbsp;')
        if orig == hira or not hira:
            # 沒有漢字的地方，上方完全不佔空間
            row1 += "<td align='center' style='padding: 0;'></td>"
            row2 += f"<td align='center' style='white-space: nowrap; padding: 0;'>{orig_escaped}</td>"
        else:
            row1 += f"<td align='center' style='padding: 0;'><span style='color: #dddddd; font-size: 0.35em;'>{hira}</span></td>"
            row2 += f"<td align='center' style='white-space: nowrap; padding: 0;'>{orig_escaped}</td>"
    row1 += "</tr>"
    row2 += "</tr>"
    html += row1 + row2 + "</table>"
    return html

class MediaWorker(QThread):
    media_updated = pyqtSignal(str, str, float)

    def run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self.poll_media())

    async def poll_media(self):
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
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
                current_time = time.time()
                
                # 20fps 絲滑補幀黑科技
                if real_pos != last_real_pos:
                    last_real_pos = real_pos
                    last_real_pos_time = current_time
                    interpolated_pos = real_pos
                else:
                    if is_playing:
                        interpolated_pos = real_pos + (current_time - last_real_pos_time)
                    else:
                        interpolated_pos = real_pos
                        
                self.media_updated.emit(title, artist, interpolated_pos)
            await asyncio.sleep(0.05)

class LyricsFetcher(QThread):
    lyrics_fetched = pyqtSignal(str, list)
    
    def __init__(self, title, artist):
        super().__init__()
        self.title = title
        self.artist = artist
        
    def run(self):
        try:
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"}
            clean_title = re.sub(r'\(feat\..*?\)|\- Remastered.*|\- Live.*', '', self.title, flags=re.IGNORECASE).strip()
            url = "https://lrclib.net/api/search"
            params = {"q": f"{clean_title} {self.artist}"}
            
            response = requests.get(url, params=params, headers=headers, timeout=15)
            if response.status_code == 200:
                data = response.json()
                valid_lyrics = []
                for track in data:
                    if track.get("syncedLyrics"):
                        desc = f"{track.get('trackName')} ({track.get('albumName')})"
                        valid_lyrics.append((desc, track["syncedLyrics"]))
                        
                if valid_lyrics:
                    def score_lyrics(lrc_text):
                        score = 0
                        if re.search(r'[\u3040-\u309F\u30A0-\u30FF]', lrc_text): score += 100
                        if re.search(r'[\u4E00-\u9FFF]', lrc_text): score += 50
                        return score
                    valid_lyrics.sort(key=lambda x: score_lyrics(x[1]), reverse=True)
                    self.lyrics_fetched.emit(valid_lyrics[0][1], valid_lyrics)
                    return
            self.lyrics_fetched.emit("", []) 
        except Exception:
            self.lyrics_fetched.emit("", [])

class FloatingLyricsApp(QWidget):
    def __init__(self):
        super().__init__()
        self.current_title = ""
        self.current_artist = ""
        self.lyrics_data = []
        self.lyric_labels = [] # 儲存所有的 QLabel
        self.available_lyrics_options = []
        self.drag_pos = None
        self.last_index = -1
        
        self.font_size = 32         
        self.sync_offset = 0.0      
        
        self.init_ui()
        self.media_worker = MediaWorker()
        self.media_worker.media_updated.connect(self.update_media_info)
        self.media_worker.start()

    def init_ui(self):
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.resize(800, 200)
        
        self.container = QFrame(self)
        self.container.setStyleSheet("QFrame { background-color: rgba(0, 0, 0, 160); border-radius: 20px; }")
        
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.addWidget(self.container)
        
        vbox = QVBoxLayout(self.container)
        
        # --- 頂部：微調提示 與 設定按鈕 ---
        top_hbox = QHBoxLayout()
        self.hint_label = QLabel("")
        self.hint_label.setStyleSheet("color: #ffff00; font-size: 14px;")
        top_hbox.addWidget(self.hint_label)
        top_hbox.addStretch()
        
        self.settings_btn = QPushButton("⚙️ 設定")
        self.settings_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.settings_btn.setStyleSheet("QPushButton { background: transparent; color: rgba(255,255,255,150); font-weight: bold; border: none; padding: 5px; } QPushButton:hover { color: white; }")
        self.settings_btn.clicked.connect(self.show_settings_menu)
        top_hbox.addWidget(self.settings_btn)
        vbox.addLayout(top_hbox)
        
        # --- 中間：滾動歌詞區 (核心改動) ---
        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setStyleSheet("background: transparent; border: none;")
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        
        self.content_widget = QWidget()
        self.content_widget.setStyleSheet("background: transparent;")
        self.content_layout = QVBoxLayout(self.content_widget)
        self.content_layout.setContentsMargins(20, 0, 20, 20)
        self.scroll_area.setWidget(self.content_widget)
        
        vbox.addWidget(self.scroll_area, 1)
        
        # --- 底部：調整大小拉桿 ---
        bottom_hbox = QHBoxLayout()
        bottom_hbox.setContentsMargins(0, 0, 10, 10)
        bottom_hbox.addStretch()
        self.sizegrip = QSizeGrip(self.container)
        self.sizegrip.setStyleSheet("width: 20px; height: 20px; background: transparent;")
        bottom_hbox.addWidget(self.sizegrip, 0, Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignRight)
        vbox.addLayout(bottom_hbox)
        
        self.show_status("等待音樂播放中...")

    def show_status(self, text):
        self.clear_lyrics()
        label = QLabel(f"<div align='center' style='color: white; font-size: {self.font_size}px; font-weight: bold;'>{text}</div>")
        self.content_layout.addWidget(label)
        self.content_layout.addStretch()

    def clear_lyrics(self):
        while self.content_layout.count():
            item = self.content_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.lyric_labels = []
        self.last_index = -1

    def update_media_info(self, title, artist, position):
        if title != self.current_title or artist != self.current_artist:
            self.current_title = title
            self.current_artist = artist
            self.lyrics_data = []
            self.available_lyrics_options = []
            self.sync_offset = 0.0 
            self.hint_label.setText("")
            self.show_status(f"正在搜尋歌詞...<br>{title} - {artist}")
            
            self.fetcher = LyricsFetcher(title, artist)
            self.fetcher.lyrics_fetched.connect(self.handle_fetched_lyrics)
            self.fetcher.start()
        
        if self.lyrics_data:
            self.refresh_lyrics_display(position)

    def handle_fetched_lyrics(self, best_lyric, options_list):
        self.available_lyrics_options = options_list
        self.parse_and_load_lyrics(best_lyric)

    def switch_lyric_version(self, lrc_text):
        self.sync_offset = 0.0 
        self.hint_label.setText("")
        self.parse_and_load_lyrics(lrc_text)

    def parse_and_load_lyrics(self, lrc_text):
        if not lrc_text:
            self.show_status(f"找不到歌詞<br>{self.current_title}")
            return
            
        self.clear_lyrics()
        pattern = re.compile(r'\[(\d{2}):(\d{2}\.\d{2,3})\](.*)')
        
        for line in lrc_text.split('\n'):
            match = pattern.match(line)
            if match:
                m, s, text = match.groups()
                seconds = int(m) * 60 + float(s)
                text = text.strip()
                if text:
                    furigana_html = add_furigana(text)
                    self.lyrics_data.append((seconds, furigana_html))
                    
                    # 建立每一行的 QLabel
                    label = QLabel()
                    # 初始狀態為小字、灰色
                    label.setText(f"<div align='center' style='color: #999999; font-size: {int(self.font_size * 0.6)}px;'>{furigana_html}</div>")
                    # 設定透明度效果，初始全透明(隱藏)
                    effect = QGraphicsOpacityEffect(label)
                    effect.setOpacity(0.0)
                    label.setGraphicsEffect(effect)
                    
                    self.content_layout.addWidget(label)
                    self.lyric_labels.append(label)
                    
        self.content_layout.addStretch() # 把歌詞頂上去

    def refresh_lyrics_display(self, position):
        current_index = -1
        adjusted_position = position + self.sync_offset
        
        for i in range(len(self.lyrics_data)):
            if adjusted_position >= self.lyrics_data[i][0]:
                current_index = i
            else:
                break
                
        # 當歌詞換行時，觸發平移動畫
        if current_index != -1 and current_index != self.last_index:
            self.animate_to_index(current_index)

    def animate_to_index(self, index):
        self.last_index = index
        
        # 1. 更新所有歌詞的字體大小與顏色 (不包含透明度)
        for i, label in enumerate(self.lyric_labels):
            text = self.lyrics_data[i][1] 
            if i == index:
                # 當前句：大字、白色
                label.setText(f"<div align='center' style='color: #ffffff; font-size: {self.font_size}px; font-weight: bold;'>{text}</div>")
            else:
                # 其他句：小字、灰色
                label.setText(f"<div align='center' style='color: #999999; font-size: {int(self.font_size * 0.6)}px;'>{text}</div>")

        # 強制刷新排版，讓我們能抓到精準的 Y 座標
        self.content_widget.adjustSize()

        # 2. 準備動畫群組
        if hasattr(self, 'anim_group') and self.anim_group.state() == QAbstractAnimation.State.Running:
            self.anim_group.stop()
        self.anim_group = QParallelAnimationGroup()

        # 【平移動畫】：將捲動軸滑順地滾動到當前歌詞的 Y 座標
        target_y = self.lyric_labels[index].y()
        scroll_anim = QPropertyAnimation(self.scroll_area.verticalScrollBar(), b"value")
        scroll_anim.setDuration(400) # 動畫時間 0.4 秒
        scroll_anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        scroll_anim.setStartValue(self.scroll_area.verticalScrollBar().value())
        scroll_anim.setEndValue(target_y)
        self.anim_group.addAnimation(scroll_anim)

        # 【漸隱動畫】：只顯示現在和下一句，其他的透明度歸零
        for i, label in enumerate(self.lyric_labels):
            effect = label.graphicsEffect()
            op_anim = QPropertyAnimation(effect, b"opacity")
            op_anim.setDuration(400)
            
            # 只顯示當前句 (i == index) 和下一句 (i == index + 1)
            if i == index or i == index + 1:
                op_anim.setEndValue(1.0)
            else:
                op_anim.setEndValue(0.0) # 上一句和未來的句子會消失
                
            self.anim_group.addAnimation(op_anim)

        self.anim_group.start()

    # --- 滑鼠拖曳與快捷鍵 ---
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.MouseButton.LeftButton and self.drag_pos is not None:
            self.move(event.globalPosition().toPoint() - self.drag_pos)
            event.accept()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_BracketLeft:    
            self.adjust_sync(-0.5)
        elif event.key() == Qt.Key.Key_BracketRight: 
            self.adjust_sync(0.5)

    # --- 設定選單 ---
    def show_settings_menu(self):
        menu = QMenu(self)
        menu.setStyleSheet("QMenu { font-size: 14px; padding: 5px; }")
        
        if self.available_lyrics_options and len(self.available_lyrics_options) > 1:
            switch_menu = menu.addMenu(f"🔄 切換歌詞版本 (有 {len(self.available_lyrics_options)} 個)")
            for i, (desc, lrc) in enumerate(self.available_lyrics_options):
                short_desc = desc if len(desc) < 25 else desc[:22] + "..."
                action = QAction(f"版本 {i+1}. {short_desc}", self)
                action.triggered.connect(lambda checked, text=lrc: self.switch_lyric_version(text))
                switch_menu.addAction(action)
            menu.addSeparator()

        sync_early_action = QAction("⏪ 歌詞太慢 (提早 0.5 秒)  [快捷鍵: ] ]", self)
        sync_early_action.triggered.connect(lambda: self.adjust_sync(0.5))
        menu.addAction(sync_early_action)
        
        sync_late_action = QAction("⏩ 歌詞太快 (延遲 0.5 秒)  [快捷鍵: [ ]", self)
        sync_late_action.triggered.connect(lambda: self.adjust_sync(-0.5))
        menu.addAction(sync_late_action)
        
        sync_reset_action = QAction("⏺️ 重置時間同步", self)
        sync_reset_action.triggered.connect(lambda: self.adjust_sync('reset'))
        menu.addAction(sync_reset_action)
        menu.addSeparator()
        
        load_action = QAction("📂 載入本地歌詞檔 (.lrc)", self)
        load_action.triggered.connect(self.load_local_lyrics)
        menu.addAction(load_action)
        menu.addSeparator() 
        
        font_action = QAction("🔠 設定主字體大小", self)
        font_action.triggered.connect(self.set_font_size)
        menu.addAction(font_action)
        menu.addSeparator()
        
        exit_action = QAction("❌ 關閉程式", self)
        exit_action.triggered.connect(self.close)
        menu.addAction(exit_action)
        
        menu.exec(self.settings_btn.mapToGlobal(self.settings_btn.rect().bottomLeft()))

    def adjust_sync(self, amount):
        if amount == 'reset':
            self.sync_offset = 0.0
            self.hint_label.setText("")
        else:
            self.sync_offset += amount
            self.hint_label.setText(f"[同步微調: {self.sync_offset:+.1f}s]")
            
        if self.lyrics_data: 
            # 重置索引以強制觸發平移動畫
            self.last_index = -1 
            self.refresh_lyrics_display(self.media_worker.media_updated.pos if hasattr(self.media_worker, 'pos') else 0)

    def set_font_size(self):
        size, ok = QInputDialog.getInt(self, "設定", "請輸入字體大小 (預設 32):", self.font_size, 10, 100, 2)
        if ok:
            self.font_size = size
            self.last_index = -1

    def load_local_lyrics(self):
        file_name, _ = QFileDialog.getOpenFileName(self, "選擇 LRC 檔案", "", "Lyrics Files (*.lrc);;All Files (*)")
        if file_name:
            try:
                with open(file_name, 'r', encoding='utf-8') as f:
                    self.parse_and_load_lyrics(f.read())
            except Exception as e:
                self.show_status(f"讀取檔案失敗: {e}")

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyleSheet("QInputDialog { background-color: white; }")
    window = FloatingLyricsApp()
    window.show()
    sys.exit(app.exec())