import asyncio
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager

async def test_seek():
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    current_session = sessions.get_current_session()
    if not current_session:
        print("No active session")
        return
    
    # Try to seek to 30 seconds
    target_ticks = int(30.0 * 10000000)
    res = await current_session.try_change_playback_position_async(target_ticks)
    print("Seek result:", res)

asyncio.run(test_seek())
