import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add a background offset poller in pollSystemMedia
poller_code = """
        // Poll offset from DB to keep in sync with Desktop app
        if (data.title && data.artist && !document.hidden) {
            fetch(`/api/lyrics/offset?title=${encodeURIComponent(data.title)}&artist=${encodeURIComponent(data.artist)}`)
                .then(res => res.json())
                .then(offData => {
                    if (offData.offset !== undefined && offData.offset !== syncOffset) {
                        syncOffset = offData.offset;
                        showToast(`已同步桌面版微調: ${syncOffset.toFixed(1)}s`, 'fa-solid fa-desktop');
                    }
                }).catch(() => {});
        }
"""

text = text.replace('// Update Progress', poller_code + '\n        // Update Progress')

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
