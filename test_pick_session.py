"""pick_session() 自檢:python test_pick_session.py，全數通過才會印 OK。"""
import sys
import types

# media_monitor 會 import winrt (只有 Windows 有)，測純邏輯時塞假模組頂替
for name in ("winrt", "winrt.windows", "winrt.windows.media",
             "winrt.windows.media.control", "winrt.windows.storage",
             "winrt.windows.storage.streams"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["winrt.windows.media.control"].GlobalSystemMediaTransportControlsSessionManager = object
sys.modules["winrt.windows.storage.streams"].DataReader = object

from media_monitor import pick_session


class FakeSession:
    def __init__(self, app_id, playing):
        self.source_app_user_model_id = app_id
        self._playing = playing

    def get_playback_info(self):
        return types.SimpleNamespace(playback_status=4 if self._playing else 5)


spotify_play = FakeSession("Spotify.exe", True)
spotify_pause = FakeSession("Spotify.exe", False)
spotify_pause2 = FakeSession("Spotify.exe", False)
chrome_play = FakeSession("Chrome", True)
chrome_pause = FakeSession("Chrome", False)
apple = FakeSession("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App", True)

# auto:音樂 app 播放中的優先
assert pick_session([chrome_play, spotify_play]) is spotify_play
# auto:Spotify 只是暫停，也不該被背景影片搶走
assert pick_session([chrome_play, spotify_pause]) is spotify_pause
# auto:沒有音樂 app 才退而取任何播放中的
assert pick_session([chrome_pause, chrome_play]) is chrome_play
# auto:全部暫停且非音樂 app -> 沒得選
assert pick_session([chrome_pause]) is None
# auto:Apple Music 也算音樂 app
assert pick_session([chrome_play, apple]) is apple

# 指定 app:同 app 多個 session 取播放中的那個
assert pick_session([spotify_pause, spotify_play], "Spotify.exe") is spotify_play
# 指定 app:全暫停就取第一個
assert pick_session([spotify_pause, spotify_pause2], "spotify.exe") is spotify_pause
# 指定 app 不在場:回 None，不偷跳去別的來源
assert pick_session([spotify_play], "Chrome") is None

print("OK")
