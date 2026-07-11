import os

# Database file path (packaged app injects LYRICS_DB_PATH pointing at %APPDATA%)
DB_FILE = os.environ.get("LYRICS_DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "lyrics_data.db")
