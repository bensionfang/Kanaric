"""
CLI 媒體監聽腳本 (給 Node.js 網頁後台使用)
使用標準輸出 (stdout) 以 JSON 格式持續印出目前的媒體狀態。
Node.js 伺服器會將這個腳本當作子進程啟動並監聽。
"""
import os
import sys
import json
import time
import asyncio
import base64
import argparse
import urllib.request
import winrt.windows.media  # 讓 MediaPlaybackAutoRepeatMode enum 可被解析
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader

CLOUD_URL = None
LAST_CLOUD_SYNC_TIME = 0
LAST_CLOUD_STATE = None

# 自動模式下優先採用的音樂 app (比對 source_app_user_model_id 的小寫子字串)
# Apple Music 的 app id 形如 AppleInc.AppleMusicWin_nzyj5cx40ttqa!App
MUSIC_APPS = ("spotify", "applemusic", "itunes", "zunemusic")

SETTINGS_PATH = os.environ.get('LYRICS_SETTINGS_PATH') or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings.json')


def load_media_source():
    """讀 settings.json 的 media_source;讀不到一律當 'auto'。"""
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f).get('media_source') or 'auto'
    except Exception:
        return 'auto'


def _is_playing(sess):
    pb = sess.get_playback_info()
    return bool(pb and pb.playback_status == 4)


def pick_session(all_sessions, pref='auto'):
    """挑出要顯示歌詞的 session。

    pref 為 app id 時只認那個 app (同 app 多個 session 取正在播的);找不到就回 None,
    不偷偷退回別的來源 —— 使用者明確指定過。
    pref='auto' 時音樂 app 優先:播放中的音樂 app > 暫停中的音樂 app > 任何播放中的 session。
    第二順位排在第三之前是刻意的:Spotify 暫停時歌詞不該被背景影片搶走。
    """
    def app_id(s):
        return (s.source_app_user_model_id or "").lower()

    if pref and pref != 'auto':
        same_app = [s for s in all_sessions if app_id(s) == pref.lower()]
        if not same_app:
            return None
        return next((s for s in same_app if _is_playing(s)), same_app[0])

    music = [s for s in all_sessions if any(k in app_id(s) for k in MUSIC_APPS)]
    playing_music = next((s for s in music if _is_playing(s)), None)
    if playing_music:
        return playing_music
    if music:
        return music[0]
    return next((s for s in all_sessions if _is_playing(s)), None)

async def poll_media():
    """與 media.py 邏輯類似，但輸出對象為終端機標準輸出"""
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    last_real_pos = -1.0
    last_real_pos_time = time.time()
    last_song_id = ""
    current_thumb_b64 = ""
    last_sent_thumb_id = ""
    media_source = load_media_source()
    settings_mtime = -1.0

    while True:
        try:
            # 設定改了就即時生效,不用重啟這個子進程 (stat 很便宜,只有 mtime 變才重讀)
            try:
                mtime = os.stat(SETTINGS_PATH).st_mtime
            except OSError:
                mtime = -1.0
            if mtime != settings_mtime:
                settings_mtime = mtime
                media_source = load_media_source()

            all_sessions = sessions.get_sessions()
            current_session = pick_session(all_sessions, media_source)

            if current_session:
                info = await current_session.try_get_media_properties_async()
                timeline = current_session.get_timeline_properties()
                playback_info = current_session.get_playback_info()
                
                title = info.title if info.title else ""
                artist = info.artist if info.artist else ""
                album = info.album_title if info.album_title else ""
                source = current_session.source_app_user_model_id or ""
                real_pos = timeline.position.total_seconds() if timeline else 0.0
                duration_sec = timeline.end_time.total_seconds() if timeline else 0.0
                is_playing = (playback_info and playback_info.playback_status == 4)
                
                # 若歌曲變更，則將專輯封面轉換為 Base64 字串傳遞給 Node.js
                song_id = f"{title}-{artist}"
                if song_id != last_song_id:
                    last_song_id = song_id
                    current_thumb_b64 = ""
                    if info.thumbnail:
                        try:
                            stream = await info.thumbnail.open_read_async()
                            reader = DataReader(stream)
                            await reader.load_async(stream.size)
                            buf = bytearray(stream.size)
                            reader.read_bytes(buf)
                            current_thumb_b64 = base64.b64encode(buf).decode('utf-8')
                        except Exception:
                            pass
                
                current_time = time.time()
                if real_pos != last_real_pos:
                    last_real_pos = real_pos
                    last_real_pos_time = current_time
                
                time_elapsed = current_time - last_real_pos_time
                if time_elapsed < 0:
                    time_elapsed = 0.0
                
                # 插值計算時間軸
                interpolated_pos = real_pos + time_elapsed if is_playing else real_pos
                
                # 隨機播放 / 循環模式 (Spotify 有回報，其他播放器可能為 None)
                shuffle = bool(playback_info.is_shuffle_active) if playback_info and playback_info.is_shuffle_active is not None else False
                repeat_mode = int(playback_info.auto_repeat_mode) if playback_info and playback_info.auto_repeat_mode is not None else 0

                state = {
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "source": source,
                    "position": interpolated_pos,
                    "duration": duration_sec,
                    "is_playing": is_playing,
                    "shuffle": shuffle,
                    "repeat": repeat_mode
                }
                
                # 節省傳輸大小，只有換歌時傳送一次 Thumbnail
                if song_id != last_sent_thumb_id:
                    state["thumbnail"] = current_thumb_b64
                    last_sent_thumb_id = song_id
            else:
                # 沒有可用來源時傳送空狀態。Node 端是淺層合併 (server.js:146),
                # 欄位漏掉就會留著上一首的值,所以這裡要把每個欄位都寫成空
                state = {
                    "title": "",
                    "artist": "",
                    "album": "",
                    "source": "",
                    "position": 0.0,
                    "duration": 0.0,
                    "is_playing": False,
                    "shuffle": False,
                    "repeat": 0,
                    "thumbnail": ""
                }
                last_song_id = ""
                last_sent_thumb_id = ""
            
            # 以 JSON 單行格式輸出，並強制 flush 確保 Node.js 能夠即時讀取到
            state_json = json.dumps(state)
            print(state_json, flush=True)
            
            # 雲端模式：發送 HTTP POST 給部署在 Heroku 的系統
            global CLOUD_URL, LAST_CLOUD_SYNC_TIME, LAST_CLOUD_STATE
            if CLOUD_URL:
                now = time.time()
                state_changed = False
                
                if LAST_CLOUD_STATE is None:
                    state_changed = True
                else:
                    if state.get("title") != LAST_CLOUD_STATE.get("title") or state.get("is_playing") != LAST_CLOUD_STATE.get("is_playing"):
                        state_changed = True
                
                # 只有換歌、播放/暫停狀態改變，或是每隔 3 秒才向雲端同步一次，避免把雲端伺服器打掛
                if state_changed or (now - LAST_CLOUD_SYNC_TIME > 3.0 and state.get("is_playing")):
                    try:
                        req = urllib.request.Request(CLOUD_URL, data=state_json.encode('utf-8'), headers={'Content-Type': 'application/json'})
                        urllib.request.urlopen(req, timeout=3.0)
                        LAST_CLOUD_SYNC_TIME = now
                        LAST_CLOUD_STATE = state
                    except Exception as cloud_e:
                        print(json.dumps({"error": f"Cloud sync failed: {str(cloud_e)}"}), flush=True)
            
        except Exception as e:
            # 發生錯誤時，輸出空狀態與錯誤訊息防止崩潰
            print(json.dumps({
                "title": "",
                "artist": "",
                "position": 0.0,
                "is_playing": False,
                "error": str(e)
            }), flush=True)
            
        # 以 10Hz (每 0.1 秒) 的頻率輪詢以維持流暢的進度條更新
        await asyncio.sleep(0.1)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', type=str, help='Cloud server URL to sync state to (e.g. https://my-app.herokuapp.com/api/sync-state)')
    args = parser.parse_args()
    if args.url:
        CLOUD_URL = args.url

    # 將控制台編碼設定為 UTF-8，防止在 Windows 環境下出現字串編碼問題
    sys.stdout.reconfigure(encoding='utf-8')
    asyncio.run(poll_media())
