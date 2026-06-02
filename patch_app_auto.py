import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Add autoscrollEnabled to userSettings
if 'autoscrollEnabled' not in text:
    text = text.replace(
        "hotkeysEnabled: true,",
        "hotkeysEnabled: true,\n    autoscrollEnabled: true,"
    )
    
    # loadSettings modification
    text = text.replace(
        "const elEnable = document.getElementById('hotkeys-enable');",
        "const elAuto = document.getElementById('setting-autoscroll');\n    if (elAuto) elAuto.checked = userSettings.autoscrollEnabled;\n    const elEnable = document.getElementById('hotkeys-enable');"
    )
    
    # saveSettings modification
    text = text.replace(
        "const elEnable = document.getElementById('hotkeys-enable');",
        "const elAuto = document.getElementById('setting-autoscroll');\n    if (elAuto) userSettings.autoscrollEnabled = elAuto.checked;\n    const elEnable = document.getElementById('hotkeys-enable');"
    )
    
    # syncLyricsToTime logic
    text = text.replace(
        "if (activeLyricIndex >= 0) {\n            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);\n            if (currentLine) {\n                currentLine.classList.add('active');\n                \n                const pane = document.getElementById('lyrics-scroll');",
        "if (activeLyricIndex >= 0) {\n            const currentLine = document.getElementById(`lyric-line-${activeLyricIndex}`);\n            if (currentLine) {\n                currentLine.classList.add('active');\n                \n                if (!userSettings.autoscrollEnabled) return;\n                \n                const pane = document.getElementById('lyrics-scroll');"
    )

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
