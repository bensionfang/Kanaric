import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

new_keydown = """
document.addEventListener('keydown', (e) => {
    // 1. Handling hotkey recording
    if (recordingKeyFor) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            // Cancel
        } else {
            userSettings[recordingKeyFor.keyName] = e.key;
        }
        recordingKeyFor.el.style.borderColor = "var(--panel-border)";
        recordingKeyFor.el.blur(); // Remove focus so typing doesn't trigger it again
        recordingKeyFor = null;
        saveSettings();
        loadSettings();
        return;
    }
    
    // 2. Existing functionality - only if hotkeys enabled
    if (!userSettings.hotkeysEnabled) return;
    
    // Check if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const isPlainText = parsedLyrics.length > 0 && parsedLyrics[0].time < 0;

    if (isPlainText) {
        if (e.key === userSettings.hkPlainNext || e.key === ' ') {
            e.preventDefault();
            if (activeLyricIndex < parsedLyrics.length - 1) {
                highlightAndScrollToLyric(activeLyricIndex + 1);
            }
        } else if (e.key === userSettings.hkPlainPrev) {
            e.preventDefault();
            if (activeLyricIndex > 0) {
                highlightAndScrollToLyric(activeLyricIndex - 1);
            }
        }
    } else if (parsedLyrics.length > 0) {
        if (e.key === userSettings.hkAdvance) {
            e.preventDefault();
            syncOffset += 0.5;
            showToast(`歌詞提早 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);
            saveOffsetToServer();
        } else if (e.key === userSettings.hkDelay) {
            e.preventDefault();
            syncOffset -= 0.5;
            showToast(`歌詞延遲 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);
            saveOffsetToServer();
        }
    }
});
"""

if 'document.addEventListener(\'keydown\'' not in text:
    text += '\n' + new_keydown

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
