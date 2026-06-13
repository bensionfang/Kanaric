"""
全域快捷鍵綁定模組
負責設定並監聽鍵盤快捷鍵，以控制主視窗的顯示狀態與歌詞時間軸微調。
"""
import keyboard
from PyQt6.QtCore import QObject, pyqtSignal

class HotkeyManager(QObject):
    # 定義發送給主視窗的訊號
    toggle_visibility_signal = pyqtSignal()      # 切換視窗顯示/隱藏
    adjust_sync_forward_signal = pyqtSignal()    # 歌詞時間軸提早
    adjust_sync_backward_signal = pyqtSignal()   # 歌詞時間軸延遲

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setup_hotkeys()

    def setup_hotkeys(self):
        """綁定全域鍵盤快捷鍵"""
        try:
            # Ctrl+Alt+L: 觸發顯示/隱藏視窗 (suppress=True 表示攔截該按鍵事件，不傳遞給其他程式)
            keyboard.add_hotkey('ctrl+alt+l', self.toggle_visibility_signal.emit, suppress=True)
            # Ctrl+Alt+]: 觸發歌詞提早
            keyboard.add_hotkey('ctrl+alt+]', self.adjust_sync_forward_signal.emit, suppress=True)
            # Ctrl+Alt+[: 觸發歌詞延遲
            keyboard.add_hotkey('ctrl+alt+[', self.adjust_sync_backward_signal.emit, suppress=True)
        except Exception as e:
            import logging
            logging.error(f"快捷鍵綁定失敗: {e}")
