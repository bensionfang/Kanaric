import time
import asyncio
import winrt.windows.foundation
import winrt.windows.foundation.collections
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader
from PyQt6.QtCore import QThread, pyqtSignal

class MediaWorker(QThread):
    media_updated = pyqtSignal(str, str, str, float, bytes, bool)

    def run(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self.poll_media())

    async def poll_media(self):
        sessions = None
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
                
                # Only poll COM API every 0.5 seconds to prevent memory leaks/crashes
                if current_time - last_api_call_time >= 0.5:
                    last_api_call_time = current_time
                    current_session = sessions.get_current_session()
                    if current_session:
                        info = await current_session.try_get_media_properties_async()
                        timeline = current_session.get_timeline_properties()
                        playback_info = current_session.get_playback_info()
                    
                        cached_title = info.title if info.title else ""
                        cached_artist = info.artist if info.artist else ""
                        cached_album = info.album_title if info.album_title else ""
                        cached_is_playing = (playback_info and playback_info.playback_status == 4) 
                        
                        real_pos = timeline.position.total_seconds() if timeline else 0.0
                        
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
                                    
                        if real_pos != last_real_pos:
                            last_real_pos = real_pos
                            last_real_pos_time = timeline.last_updated_time.timestamp() if timeline else current_time
                            
                # Continuous interpolation (every 0.05s)
                if cached_title or cached_artist:
                    if last_song_id != last_sent_thumb_id:
                        thumb_bytes = last_thumb_bytes
                        last_sent_thumb_id = last_song_id
                    else:
                        thumb_bytes = b''

                    current_time2 = time.time()
                    time_elapsed = current_time2 - last_real_pos_time
                    if time_elapsed > 10.0:
                        time_elapsed = 10.0
                    elif time_elapsed < 0:
                        time_elapsed = 0.0
                    
                    interpolated_pos = last_real_pos + time_elapsed if cached_is_playing else last_real_pos
                            
                    self.media_updated.emit(cached_title, cached_artist, cached_album, interpolated_pos, thumb_bytes, cached_is_playing)
                
            except Exception as e:
                try:
                    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
                except:
                    pass

            await asyncio.sleep(0.05)
