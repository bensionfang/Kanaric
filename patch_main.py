import re

with open('main.py', 'r', encoding='utf-8') as f:
    text = f.read()

# In main.py, update_media_status(self) runs every 100ms.
# We will inject a block that polls db.get_sync_offset every 1 second.
injection = """
        # Poll sync_offset from DB every 1 second
        if not hasattr(self, 'last_offset_poll_time'):
            self.last_offset_poll_time = 0
            
        import time
        if time.time() - self.last_offset_poll_time > 1.0:
            self.last_offset_poll_time = time.time()
            if self.search_artist and self.search_title:
                new_offset = db.get_sync_offset(self.search_artist, self.search_title)
                if new_offset != self.current_sync_offset:
                    self.current_sync_offset = new_offset
                    self.hint_label.setText(f"同步微調: {self.current_sync_offset:+.1f}s")
                    self.show_hint()
"""

# Find def update_media_status(self):
# and put it right after it.
text = text.replace('def update_media_status(self):', 'def update_media_status(self):\n' + injection)

with open('main.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
