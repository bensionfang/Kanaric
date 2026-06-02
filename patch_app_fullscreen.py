import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

fullscreen_logic = """
function toggleFullscreen() {
    document.body.classList.toggle('window-maximized');
    const btn = document.querySelector('.fullscreen-btn');
    if (btn) {
        if (document.body.classList.contains('window-maximized')) {
            btn.innerHTML = '<i class="fa-solid fa-compress"></i> 縮小視窗';
        } else {
            btn.innerHTML = '<i class="fa-solid fa-expand"></i> 視窗放大';
        }
    }
}
"""

if 'function toggleFullscreen()' not in text:
    text += "\n" + fullscreen_logic + "\n"

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
