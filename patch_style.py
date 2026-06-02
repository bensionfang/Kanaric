import re

with open('web-app/public/css/style.css', 'r', encoding='utf-8') as f:
    text = f.read()

target = """.window-maximized.player-lyrics-card {
    background: var(--bg-main) !important;
    border: none !important;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    gap: 0;
}"""

replacement = """body.window-maximized .player-lyrics-card {
    background: var(--bg-main) !important;
    border: none !important;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    gap: 0;
    height: 100vh;
    max-width: 100% !important;
    border-radius: 0;
}"""

text = text.replace(target, replacement)

with open('web-app/public/css/style.css', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
