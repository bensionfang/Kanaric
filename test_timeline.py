import asyncio
import time
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager

async def main():
    sessions = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    session = sessions.get_current_session()
    if session:
        timeline = session.get_timeline_properties()
        print(repr(timeline.last_updated_time))
        print(timeline.last_updated_time.timestamp())
        print(time.time())
    else:
        print("no session")

asyncio.run(main())
