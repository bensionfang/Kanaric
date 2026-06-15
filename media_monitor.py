"""
CLI 媒體監聽腳本 (給 Node.js 網頁後台使用)
使用標準輸出 (stdout) 以 JSON 格式持續印出目前的媒體狀態。
Node.js 伺服器會將這個腳本當作子進程啟動並監聽。
"""
import sys
import json
import time
import asyncio
import base64
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader

async def poll_media():
    """與 media.py 邏輯類似，但輸出對象為終端機標準輸出"""
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    last_real_pos = -1.0
    last_real_pos_time = time.time()
    last_song_id = ""
    current_thumb_b64 = ""
    last_sent_thumb_id = ""
    
    while True:
        try:
            all_sessions = sessions.get_sessions()
            current_session = None
            browser_keywords = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'vivaldi', 'browser']
            
            # 優先尋找非瀏覽器且正在播放的 Session
            for sess in all_sessions:
                app_id = (sess.source_app_user_model_id or "").lower()
                if not any(k in app_id for k in browser_keywords):
                    pb_info = sess.get_playback_info()
                    if pb_info and pb_info.playback_status == 4: # playing
                        current_session = sess
                        break
                        
            # 若無正在播放的，找第一個非瀏覽器的 Session
            if not current_session:
                for sess in all_sessions:
                    app_id = (sess.source_app_user_model_id or "").lower()
                    if not any(k in app_id for k in browser_keywords):
                        current_session = sess
                        break

            if current_session:
                info = await current_session.try_get_media_properties_async()
                timeline = current_session.get_timeline_properties()
                playback_info = current_session.get_playback_info()
                
                title = info.title if info.title else ""
                artist = info.artist if info.artist else ""
                album = info.album_title if info.album_title else ""
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
                
                state = {
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "position": interpolated_pos,
                    "duration": duration_sec,
                    "is_playing": is_playing
                }
                
                # 節省傳輸大小，只有換歌時傳送一次 Thumbnail
                if song_id != last_sent_thumb_id:
                    state["thumbnail"] = current_thumb_b64
                    last_sent_thumb_id = song_id
            else:
                # 系統無音樂播放時傳送空狀態
                state = {
                    "title": "",
                    "artist": "",
                    "position": 0.0,
                    "is_playing": False,
                    "thumbnail": ""
                }
            
            # 以 JSON 單行格式輸出，並強制 flush 確保 Node.js 能夠即時讀取到
            print(json.dumps(state), flush=True)
            
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
    # 將控制台編碼設定為 UTF-8，防止在 Windows 環境下出現字串編碼問題
    sys.stdout.reconfigure(encoding='utf-8')
    asyncio.run(poll_media())
