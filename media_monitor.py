import sys
import json
import time
import asyncio
import base64
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager
from winrt.windows.storage.streams import DataReader

async def poll_media():
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    last_real_pos = -1.0
    last_real_pos_time = time.time()
    last_song_id = ""
    current_thumb_b64 = ""
    
    while True:
        try:
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
                    interpolated_pos = real_pos
                else:
                    interpolated_pos = real_pos + (current_time - last_real_pos_time) if is_playing else real_pos
                
                state = {
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "position": interpolated_pos,
                    "is_playing": is_playing,
                    "thumbnail": current_thumb_b64
                }
            else:
                state = {
                    "title": "",
                    "artist": "",
                    "position": 0.0,
                    "is_playing": False,
                    "thumbnail": ""
                }
            
            # Print state as JSON line, flush to ensure Node.js receives it immediately
            print(json.dumps(state), flush=True)
            
        except Exception as e:
            # On error, output empty state to prevent crash
            print(json.dumps({
                "title": "",
                "artist": "",
                "position": 0.0,
                "is_playing": False,
                "error": str(e)
            }), flush=True)
            
        # Poll 10 times a second for smooth progress updates (100ms)
        await asyncio.sleep(0.1)

if __name__ == '__main__':
    # Set console encoding to UTF-8 to prevent string encoding issues in Windows
    sys.stdout.reconfigure(encoding='utf-8')
    asyncio.run(poll_media())
