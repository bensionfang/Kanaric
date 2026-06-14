"""
系統設定與常數管理模組
負責定義全域常數，並提供單例模式的 SettingsManager 來讀寫 settings.json。
"""
import os
import json
import logging
from typing import Dict, Any

# ================= 1. 常數設定 (Constants) =================
DB_FILE = 'lyrics_data.db'      # SQLite 資料庫檔案名稱
SETTINGS_FILE = 'settings.json' # 使用者偏好設定檔案名稱

DEFAULT_FONT_SIZE = 28          # 預設歌詞字體大小
DEFAULT_FONT_FAMILY = "Microsoft JhengHei" # 預設字型 (微軟正黑體)
MAX_FONT_SIZE = 100             # 最大允許字體大小
MIN_FONT_SIZE = 10              # 最小允許字體大小

API_TIMEOUT = 10                # 歌詞 API 請求超時時間 (秒)
ITUNES_TIMEOUT = 5              # iTunes 搜尋 API 請求超時時間 (秒)
DEFAULT_HISTORY_DURATION = 180  # 預設聽歌紀錄的歌曲長度 (秒)

# ================= 2. 設定檔管理 (SettingsManager) =================
class SettingsManager:
    """單例模式的設定管理員，確保全域只有一份設定實例"""
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SettingsManager, cls).__new__(cls)
            cls._instance.settings = cls._instance._load_settings()
        return cls._instance

    def _load_settings(self) -> Dict[str, Any]:
        """從 settings.json 載入設定，若無檔案則回傳預設值"""
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                logging.warning(f"載入設定檔失敗: {e}")
                
        # 預設設定值
        return {
            "font_size": DEFAULT_FONT_SIZE, 
            "font_family": DEFAULT_FONT_FAMILY, 
            "custom_css_path": "",
            "mini_mode": False,       # 迷你模式開關
            "dynamic_color": True,    # 動態背景色彩開關
            "display_lines": 2,       # 歌詞顯示行數
            "sync_offset": 0.0,       # 全域時間軸偏移量
            "pin_window": True,       # 是否置頂視窗
            "preferred_source": "NetEase" # 預設優先歌詞來源
        }

    def save_settings(self) -> None:
        """將目前的設定寫入 settings.json"""
        try:
            with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.settings, f)
        except Exception as e:
            logging.error(f"儲存設定檔失敗: {e}")

    def get(self, key: str, default: Any = None) -> Any:
        """取得特定設定值，若不存在則回傳預設值"""
        return self.settings.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """更新特定設定值"""
        self.settings[key] = value

    def get_all(self) -> Dict[str, Any]:
        """取得完整設定字典"""
        return self.settings

# 建立全域 config 實例供其他模組匯入使用
config = SettingsManager()
