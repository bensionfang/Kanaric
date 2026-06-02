import re
import os

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add settings variables
settings_code = """
let syncOffset = 0;
let userSettings = {
    hotkeysEnabled: true,
    hkAdvance: ']',
    hkDelay: '[',
    hkPlainNext: 'ArrowDown',
    hkPlainPrev: 'ArrowUp'
};

function loadSettings() {
    try {
        const saved = localStorage.getItem('floating_lyrics_settings');
        if (saved) {
            userSettings = { ...userSettings, ...JSON.parse(saved) };
        }
    } catch(e) {}
    
    const elEnable = document.getElementById('hotkeys-enable');
    if (elEnable) elEnable.checked = userSettings.hotkeysEnabled;
    const hk1 = document.getElementById('hk-advance');
    if (hk1) hk1.value = userSettings.hkAdvance;
    const hk2 = document.getElementById('hk-delay');
    if (hk2) hk2.value = userSettings.hkDelay;
    const hk3 = document.getElementById('hk-plain-next');
    if (hk3) hk3.value = userSettings.hkPlainNext;
    const hk4 = document.getElementById('hk-plain-prev');
    if (hk4) hk4.value = userSettings.hkPlainPrev;
}

function saveSettings() {
    const elEnable = document.getElementById('hotkeys-enable');
    if (elEnable) userSettings.hotkeysEnabled = elEnable.checked;
    localStorage.setItem('floating_lyrics_settings', JSON.stringify(userSettings));
}

let recordingKeyFor = null;
function recordHotkey(inputEl, keyId) {
    if (recordingKeyFor) {
        recordingKeyFor.el.value = userSettings[recordingKeyFor.keyName];
        recordingKeyFor.el.style.borderColor = "var(--panel-border)";
    }
    
    let keyName = '';
    if (keyId === 'hk-advance') keyName = 'hkAdvance';
    else if (keyId === 'hk-delay') keyName = 'hkDelay';
    else if (keyId === 'hk-plain-next') keyName = 'hkPlainNext';
    else if (keyId === 'hk-plain-prev') keyName = 'hkPlainPrev';
    
    recordingKeyFor = { el: inputEl, id: keyId, keyName: keyName };
    inputEl.value = "請按下按鍵...";
    inputEl.style.borderColor = "var(--accent-main)";
}

async function saveOffsetToServer() {
    if (!lastMediaTitle || !lastMediaArtist) return;
    try {
        await fetch('/api/lyrics/offset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                offset: syncOffset
            })
        });
    } catch (e) {
        console.error("Failed to save offset", e);
    }
}
"""
text = text.replace('let activeLyricIndex = -1;\nlet songDurationSeconds = 180; // Estimated or default', 
                    'let activeLyricIndex = -1;\nlet songDurationSeconds = 180;\n' + settings_code)

# 2. Add syncOffset application and update progress bar
text = text.replace('updatePlaybackProgress(data.position);\n            syncLyricsToTime(data.position);',
                    'updatePlaybackProgress(data.position + syncOffset);\n            syncLyricsToTime(data.position + syncOffset);')

# 3. Add openSettingsModal properly
text = text.replace('function openSettingsModal() {', 'function openSettingsModal_old() {') # if it exists
text = text.replace('function closeSettingsModal() {', 'function closeSettingsModal_old() {')

text += """
function openSettingsModal() {
    loadSettings();
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('show');
}

function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.remove('show');
    saveSettings();
}
"""

# 4. Fix showToast
old_toast = """function showToast(message, iconClass = 'fa-solid fa-circle-info', duration = 3500) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-message');
    icon.className = iconClass;
    msg.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
}"""

new_toast = """let toastTimeout = null;
function showToast(message, iconClass = 'fa-solid fa-circle-info', duration = 3500) {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-message');
    if(!toast) return;
    icon.className = iconClass;
    msg.textContent = message;
    toast.classList.remove('hidden');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.add('hidden'), duration);
}"""
text = text.replace(old_toast, new_toast)

# 5. Fetch offset inside fetchAndParseLyrics
# Wait, fetchAndParseLyrics looks like:
# async function fetchAndParseLyrics(title, artist) {
#     const scrollPane = document.getElementById('lyrics-scroll');
#     scrollPane.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> 正在搜尋歌詞...</div>`;
#     parsedLyrics = [];

fetch_logic = """
    try {
        const offUrl = `/api/lyrics/offset?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
        const offResp = await fetch(offUrl);
        if (offResp.ok) {
            const offData = await offResp.json();
            syncOffset = offData.offset || 0;
            if (syncOffset !== 0) {
                showToast(`載入預設延遲: ${syncOffset.toFixed(1)}s`, 'fa-solid fa-clock');
            }
        }
    } catch(e) {}
"""
text = re.sub(r'(async function fetchAndParseLyrics[\s\S]*?parsedLyrics = \[\];)', r'\1' + fetch_logic, text, count=1)


# 6. Replace keydown listener
old_keydown = """document.addEventListener('keydown', (e) => {
    // Only apply if we have plain text lyrics
    if (parsedLyrics.length === 0 || parsedLyrics[0].time >= 0) return;
    
    // Check if user is typing in an input (e.g. search box)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        if (activeLyricIndex < parsedLyrics.length - 1) {
            highlightAndScrollToLyric(activeLyricIndex + 1);
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeLyricIndex > 0) {
            highlightAndScrollToLyric(activeLyricIndex - 1);
        }
    }
});"""

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
text = text.replace(old_keydown, new_keydown)

# 7. Append modal functions
modal_funcs = '''
function openLyricsModal() {
    if (lastMediaTitle) {
        document.getElementById('manual-title').value = lastMediaTitle;
        document.getElementById('manual-artist').value = lastMediaArtist;
        document.getElementById('custom-lyrics-text').value = '';
        document.getElementById('lyrics-options-list').innerHTML = '';
        
        const modal = document.getElementById('lyrics-options-modal');
        if (modal) {
            modal.classList.remove('hidden');
            void modal.offsetWidth;
            modal.classList.add('show');
        }
    } else {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
    }
}

function reloadCurrentLyrics() {
    if (lastMediaTitle) {
        showToast(`重新抓取: ${lastMediaTitle}`, 'fa-solid fa-rotate', 2000);
        fetchAndParseLyrics(lastMediaTitle, lastMediaArtist, true);
    } else {
        showToast('目前沒有播放任何歌曲', 'fa-solid fa-circle-exclamation', 2000);
    }
}

let fetchedOptions = [];

async function performGetOptions() {
    const t = document.getElementById('manual-title').value.trim();
    const a = document.getElementById('manual-artist').value.trim();
    if (!t) return;
    
    const listContainer = document.getElementById('lyrics-options-list');
    listContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 10px;">搜尋中...</div>';
    
    try {
        const url = `/api/lyrics/options?title=${encodeURIComponent(t)}&artist=${encodeURIComponent(a)}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            fetchedOptions = data.options || [];
            
            if (fetchedOptions.length === 0) {
                listContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 10px;">找不到備選歌詞</div>';
                return;
            }
            
            listContainer.innerHTML = fetchedOptions.map((opt, idx) => `
                <div style="background: var(--surface-light); border: 1px solid var(--panel-border); border-radius: 6px; padding: 8px; cursor: pointer;" onclick="applyOption(${idx})">
                    <div style="font-weight: bold; font-size: 13px; color: var(--text-color);">${opt.title}</div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                        ${opt.artist} ${opt.album ? '• ' + opt.album : ''} • ${Math.floor(opt.duration/60)}:${(opt.duration%60).toString().padStart(2,'0')} 
                        (分數: ${opt.score})
                    </div>
                </div>
            `).join('');
        }
    } catch (e) {
        console.error(e);
        listContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 10px;">取得失敗</div>';
    }
}

async function applyOption(idx) {
    if (!fetchedOptions[idx]) return;
    const opt = fetchedOptions[idx];
    document.getElementById('custom-lyrics-text').value = opt.lyrics;
    await performCustomLyrics();
}

async function performManualSearch() {
    const t = document.getElementById('manual-title').value.trim();
    const a = document.getElementById('manual-artist').value.trim();
    if (!t) return;
    
    closeLyricsModal();
    showToast(`手動搜尋: ${t}`, 'fa-solid fa-search', 2000);
    
    try {
        const url = `/api/lyrics/fetch?title=${encodeURIComponent(lastMediaTitle)}&artist=${encodeURIComponent(lastMediaArtist)}&searchTitle=${encodeURIComponent(t)}&searchArtist=${encodeURIComponent(a)}&force=true`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            if (data.lyrics) {
                parseLrcLyrics(data.lyrics);
                renderLyrics();
                showToast('手動搜尋成功', 'fa-solid fa-check', 2000);
            } else {
                showToast('找不到符合的歌詞', 'fa-solid fa-xmark', 2000);
            }
        }
    } catch (e) {
        console.error(e);
        showToast('搜尋失敗', 'fa-solid fa-xmark', 2000);
    }
}

async function performCustomLyrics() {
    const customText = document.getElementById('custom-lyrics-text').value.trim();
    if (!customText) return;
    
    closeLyricsModal();
    showToast('套用自訂歌詞...', 'fa-solid fa-paste', 2000);
    
    try {
        const resp = await fetch('/api/lyrics/custom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                lyrics: customText
            })
        });
        
        if (resp.ok) {
            const data = await resp.json();
            parseLrcLyrics(data.lyrics);
            renderLyrics();
            showToast('已套用自訂歌詞', 'fa-solid fa-check', 2000);
        } else {
            showToast('套用失敗', 'fa-solid fa-xmark', 3000);
        }
    } catch (e) {
        console.error(e);
        showToast('套用失敗', 'fa-solid fa-xmark', 2000);
    }
}

function closeLyricsModal() {
    const modal = document.getElementById('lyrics-options-modal');
    if (modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.classList.add('hidden'), 300);
    }
}
'''
if 'openLyricsModal' not in text:
    text += '\n' + modal_funcs

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS REBUILD!")
