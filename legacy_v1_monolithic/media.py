"""
UI 媒體監聽模組
使用 PyQt6 QThread 在背景執行，並透過 Windows Runtime (WinRT) API 擷取目前的系統媒體播放狀態。
擷取後會透過 pyqtSignal 傳遞給主視窗更新 UI。
"""
import time
import asyncio
import winrt.windows.foundation
import winrt.windows.foundation.collections
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader
from PyQt6.QtCore import QThread, pyqtSignal

class MediaWorker(QThread):
    # 定義發送給主視窗的訊號，包含：標題, 歌手, 專輯, 播放進度(秒), 封面縮圖(bytes), 是否正在播放
    media_updated = pyqtSignal(str, str, str, float, bytes, bool)

    def run(self):
        """執行緒啟動點，建立並執行 asyncio 的事件迴圈"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self.poll_media())

    async def poll_media(self):
        """持續輪詢 (Polling) 系統媒體狀態的核心協程"""
        sessions = None
        # 嘗試取得全域媒體控制 Session
        while sessions is None:
            try:
                sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
            except Exception:
                await asyncio.sleep(1)
        
        last_real_pos = -1.0
        last_real_pos_time = time.time()
        last_song_id = ""
        last_thumb_bytes = b''
        last_sent_thumb_id = ""
        
        cached_title = ""
        cached_artist = ""
        cached_album = ""
        cached_is_playing = False
        last_api_call_time = 0
        
        while True:
            try:
                current_time = time.time()
                
                # 為了避免呼叫 COM API 過於頻繁導致記憶體洩漏或崩潰，限制每 0.5 秒查詢一次
                if current_time - last_api_call_time >= 0.5:
                    last_api_call_time = current_time
                    current_session = sessions.get_current_session()
                    if current_session:
                        # 取得媒體屬性與時間軸資訊
                        info = await current_session.try_get_media_properties_async()
                        timeline = current_session.get_timeline_properties()
                        playback_info = current_session.get_playback_info()
                    
                        cached_title = info.title if info.title else ""
                        cached_artist = info.artist if info.artist else ""
                        cached_album = info.album_title if info.album_title else ""
                        # 4 代表 Playing 狀態
                        cached_is_playing = (playback_info and playback_info.playback_status == 4) 
                        
                        real_pos = timeline.position.total_seconds() if timeline else 0.0
                        
                        # 檢查是否更換歌曲，若是則更新專輯封面縮圖
                        song_id = f"{cached_title}-{cached_artist}"
                        if song_id != last_song_id:
                            last_song_id = song_id
                            last_thumb_bytes = b''
                            if info.thumbnail:
                                try:
                                    stream = await info.thumbnail.open_read_async()
                                    reader = DataReader(stream)
                                    await reader.load_async(stream.size)
                                    buf = bytearray(stream.size)
                                    reader.read_bytes(buf)
                                    last_thumb_bytes = bytes(buf)
                                except Exception as e:
                                    pass
                                    
                        # 檢查播放進度是否更新
                        if real_pos != last_real_pos:
                            last_real_pos = real_pos
                            last_real_pos_time = timeline.last_updated_time.timestamp() if timeline else current_time
                            
                # 連續插值運算 (Continuous interpolation)，每 0.05 秒發送一次更新
                # 確保即便 API 只能每 0.5 秒更新一次，UI 歌詞仍能順暢滾動
                if cached_title or cached_artist:
                    if last_song_id != last_sent_thumb_id:
                        thumb_bytes = last_thumb_bytes
                        last_sent_thumb_id = last_song_id
                    else:
                        thumb_bytes = b'' # 節省頻寬，只有更換歌曲時才發送縮圖

                    current_time2 = time.time()
                    time_elapsed = current_time2 - last_real_pos_time
                    
                    # 避免時間軸計算誤差過大
                    if time_elapsed > 10.0:
                        time_elapsed = 10.0
                    elif time_elapsed < 0:
                        time_elapsed = 0.0
                    
                    # 根據目前的播放狀態推算插值後的進度
                    interpolated_pos = last_real_pos + time_elapsed if cached_is_playing else last_real_pos
                            
                    self.media_updated.emit(cached_title, cached_artist, cached_album, interpolated_pos, thumb_bytes, cached_is_playing)
                
            except Exception as e:
                # 處理 Session 失效或重置的情境
                try:
                    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
                except:
                    pass

            await asyncio.sleep(0.05)
