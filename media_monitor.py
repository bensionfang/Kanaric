import sys
import json
import time
import asyncio
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager

async def poll_media():
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    last_state = None
    
    while True:
        try:
            current_session = sessions.get_current_session()
            if current_session:
                info = await current_session.try_get_media_properties_async()
                timeline = current_session.get_timeline_properties()
                playback_info = current_session.get_playback_info()
                
                title = info.title if info.title else ""
                artist = info.artist if info.artist else ""
                position = timeline.position.total_seconds() if timeline else 0.0
                is_playing = (playback_info and playback_info.playback_status == 4)
                
                state = {
                    "title": title,
                    "artist": artist,
                    "position": position,
                    "is_playing": is_playing
                }
            else:
                state = {
                    "title": "",
                    "artist": "",
                    "position": 0.0,
                    "is_playing": False
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
