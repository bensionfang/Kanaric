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
                
                thumb_bytes = b''
                if info.thumbnail:
                    try:
                        stream = await info.thumbnail.open_read_async()
                        reader = DataReader(stream)
                        await reader.load_async(stream.size)
                        buf = bytearray(stream.size)
                        reader.read_bytes(buf)
                        thumb_bytes = bytes(buf)
                    except Exception as e:
                        pass # Exception on thumbnails is common and often ignorable

                current_time = time.time()
                if real_pos != last_real_pos:
                    last_real_pos = real_pos
                    last_real_pos_time = current_time
                    interpolated_pos = real_pos
                else:
                    interpolated_pos = real_pos + (current_time - last_real_pos_time) if is_playing else real_pos
                        
                self.media_updated.emit(title, artist, album, interpolated_pos, thumb_bytes, is_playing)
            await asyncio.sleep(0.05)
