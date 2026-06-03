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
        sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
        last_real_pos = -1.0
        last_real_pos_time = time.time()
        last_song_id = ""
        last_thumb_bytes = b''
        
        while True:
            current_session = sessions.get_current_session()
            if current_session:
                info = await current_session.try_get_media_properties_async()
                timeline = current_session.get_timeline_properties()
                playback_info = current_session.get_playback_info()
                
                title = info.title if info.title else ""
                artist = info.artist if info.artist else ""
                album = info.album_title if info.album_title else ""
                real_pos = timeline.position.total_seconds() if timeline else 0.0
                is_playing = (playback_info and playback_info.playback_status == 4) 
                
                song_id = f"{title}-{artist}"
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
                
                thumb_bytes = last_thumb_bytes

                current_time = time.time()
                if real_pos != last_real_pos:
                    last_real_pos = real_pos
                    # Use the exact OS timestamp when this position was valid
                    last_real_pos_time = timeline.last_updated_time.timestamp() if timeline else current_time
                
                time_elapsed = current_time - last_real_pos_time
                if time_elapsed > 1.5:
                    time_elapsed = 1.5
                elif time_elapsed < 0:
                    time_elapsed = 0.0
                
                interpolated_pos = real_pos + time_elapsed if is_playing else real_pos
                        
                self.media_updated.emit(title, artist, album, interpolated_pos, thumb_bytes, is_playing)
            await asyncio.sleep(0.05)
