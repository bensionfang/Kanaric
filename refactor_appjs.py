import os

def update_app_js():
    with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Update pollSystemMedia to toggle play/pause icon and handle vinyl gracefully
    new_playing_if = """        if (data.is_playing) {
            dot.classList.add('active');
            statusText.textContent = `即時同步中...`;
            const vd = document.getElementById('vinyl-disc');
            if (vd) vd.classList.add('playing');
            const ppIcon = document.getElementById('play-pause-icon');
            if (ppIcon) ppIcon.className = 'fa-solid fa-pause';
        } else {
            dot.classList.remove('active');
            statusText.textContent = data.title ? `音樂已暫停` : `等待播放...`;
            const vd = document.getElementById('vinyl-disc');
            if (vd) vd.classList.remove('playing');
            const ppIcon = document.getElementById('play-pause-icon');
            if (ppIcon) ppIcon.className = 'fa-solid fa-play';
        }"""
    
    import re
    # Find the old block:
    # if (data.is_playing) { ... } else { ... }
    # inside pollSystemMedia
    # It starts around line 233
    pattern = r'if\s*\(data\.is_playing\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\}'
    content = re.sub(pattern, new_playing_if, content, count=1)

    # 2. Add mediaAction function at the end
    media_action_js = """
// Spotify Player Controls
function mediaAction(action) {
    fetch('/api/media-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
    });
}
"""
    if "function mediaAction" not in content:
        content += "\n" + media_action_js
        
    with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
        f.write(content)

if __name__ == "__main__":
    update_app_js()
