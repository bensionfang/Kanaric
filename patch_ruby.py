import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

ruby_logic = """
// Ruby Editor Logic
let currentEditingRuby = null;

document.getElementById('lyrics-scroll').addEventListener('click', (e) => {
    const ruby = e.target.closest('ruby');
    if (ruby && !document.getElementById('lyrics-scroll').classList.contains('pure-text-mode')) {
        currentEditingRuby = ruby;
        
        // Extract Kanji (ignoring rt)
        const clone = ruby.cloneNode(true);
        const rtNode = clone.querySelector('rt');
        if (rtNode) clone.removeChild(rtNode);
        const kanji = clone.textContent.trim();
        
        const currentRt = ruby.querySelector('rt') ? ruby.querySelector('rt').textContent : '';
        
        document.getElementById('ruby-edit-kanji').textContent = kanji;
        document.getElementById('ruby-edit-rt').value = currentRt;
        document.getElementById('ruby-edit-modal').classList.remove('hidden');
        
        // Focus input
        setTimeout(() => document.getElementById('ruby-edit-rt').focus(), 100);
    }
});

function closeRubyModal() {
    document.getElementById('ruby-edit-modal').classList.add('hidden');
    currentEditingRuby = null;
}

async function saveRubyEdit() {
    if (!currentEditingRuby) return;
    
    const newRtText = document.getElementById('ruby-edit-rt').value.trim();
    let rt = currentEditingRuby.querySelector('rt');
    
    if (!newRtText) {
        // If user clears the text, we might want to just remove the rt or ruby entirely?
        // Let's just remove the rt.
        if (rt) currentEditingRuby.removeChild(rt);
    } else {
        if (!rt) {
            rt = document.createElement('rt');
            currentEditingRuby.appendChild(rt);
        }
        rt.textContent = newRtText;
    }
    
    // Save to parsedLyrics
    const lineDiv = currentEditingRuby.closest('.lyrics-line');
    if (lineDiv) {
        const idMatch = lineDiv.id.match(/lyric-line-(\\d+)/);
        if (idMatch) {
            const idx = parseInt(idMatch[1]);
            parsedLyrics[idx].text = lineDiv.innerHTML;
        }
    }
    
    // Reconstruct LRC
    const lyricsLines = parsedLyrics.map(lyric => {
        if (lyric.time === -1) return lyric.text; // pure text mode fallback
        const minutes = Math.floor(lyric.time / 60).toString().padStart(2, '0');
        const secondsStr = (lyric.time % 60).toFixed(2).padStart(5, '0');
        return `[${minutes}:${secondsStr}]${lyric.text}`;
    });
    
    const fullLrc = lyricsLines.join('\\n');
    
    closeRubyModal();
    showToast('儲存修改中...', 'fa-solid fa-spinner', 1000);
    
    try {
        const resp = await fetch('/api/lyrics/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                lyrics: fullLrc
            })
        });
        
        if (resp.ok) {
            showToast('假名修改已同步至資料庫！', 'fa-solid fa-check', 2000);
        } else {
            showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
        }
    } catch (e) {
        console.error(e);
        showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
    }
}
"""

if "Ruby Editor Logic" not in text:
    text += "\n" + ruby_logic

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
