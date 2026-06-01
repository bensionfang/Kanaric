import keyboard
from PyQt6.QtCore import QObject, pyqtSignal

class HotkeyManager(QObject):
    toggle_visibility_signal = pyqtSignal()
    adjust_sync_forward_signal = pyqtSignal()
    adjust_sync_backward_signal = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setup_hotkeys()

    def setup_hotkeys(self):
        try:
            # Ctrl+Alt+L 顯示/隱藏視窗
            keyboard.add_hotkey('ctrl+alt+l', self.toggle_visibility_signal.emit, suppress=True)
            # Ctrl+Alt+] 歌詞提早
            keyboard.add_hotkey('ctrl+alt+]', self.adjust_sync_forward_signal.emit, suppress=True)
            # Ctrl+Alt+[ 歌詞延遲
            keyboard.add_hotkey('ctrl+alt+[', self.adjust_sync_backward_signal.emit, suppress=True)
        except Exception as e:
            import logging
            logging.error(f"快捷鍵綁定失敗: {e}")
