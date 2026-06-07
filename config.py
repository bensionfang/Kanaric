import os
import json
import logging
from typing import Dict, Any

# ================= 1. 常數設定 (Constants) =================
DB_FILE = 'lyrics_data.db'
SETTINGS_FILE = 'settings.json'

DEFAULT_FONT_SIZE = 28
DEFAULT_FONT_FAMILY = "Microsoft JhengHei"
MAX_FONT_SIZE = 100
MIN_FONT_SIZE = 10

API_TIMEOUT = 10
ITUNES_TIMEOUT = 5
DEFAULT_HISTORY_DURATION = 180

# ================= 2. 設定檔管理 (SettingsManager) =================
class SettingsManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SettingsManager, cls).__new__(cls)
            cls._instance.settings = cls._instance._load_settings()
        return cls._instance

    def _load_settings(self) -> Dict[str, Any]:
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                logging.warning(f"載入設定檔失敗: {e}")
                
        return {
            "font_size": DEFAULT_FONT_SIZE, 
            "font_family": DEFAULT_FONT_FAMILY, 
            "custom_css_path": "",
            "mini_mode": False, 
            "dynamic_color": True,
            "display_lines": 2,
            "sync_offset": 0.0,
            "pin_window": True,
            "preferred_source": "NetEase"
        }

    def save_settings(self) -> None:
        try:
            with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.settings, f)
        except Exception as e:
            logging.error(f"儲存設定檔失敗: {e}")

    def get(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.settings[key] = value

    def get_all(self) -> Dict[str, Any]:
        return self.settings

config = SettingsManager()
