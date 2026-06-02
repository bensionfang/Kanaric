import os
index_path = r'web-app/views/index.ejs'
with open(index_path, 'r', encoding='utf-8') as f:
    text = f.read()

modals = """
<!-- Lyrics Rescue Modal -->
<div id="lyrics-options-modal" class="modal-overlay hidden">
    <div class="modal-content" style="padding: 20px; position: relative;">
        <button onclick="closeLyricsModal()" style="position: absolute; top: 15px; right: 15px; background: transparent; border: none; color: var(--text-secondary); font-size: 18px; cursor: pointer; transition: color 0.3s;"><i class="fa-solid fa-xmark"></i></button>
        <h3><i class="fa-solid fa-sliders"></i> 進階歌詞選項</h3>
        <div class="modal-actions" style="display:flex; flex-direction:column; gap: 15px; margin-top: 15px;">
            <div style="padding-top: 5px;">
                <h4 style="margin-bottom: 10px; font-size: 14px;"><i class="fa-solid fa-list"></i> 取得備選歌詞</h4>
                <button onclick="performGetOptions()" class="nav-btn" style="width: 100%; justify-content: center;"><i class="fa-solid fa-cloud-arrow-down"></i> 取得前 5 名備選</button>
                <div id="lyrics-options-list" style="margin-top: 10px; max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;"></div>
            </div>
            <div style="border-top: 1px solid var(--panel-border); padding-top: 15px;">
                <h4 style="margin-bottom: 10px; font-size: 14px;"><i class="fa-solid fa-pen-to-square"></i> 手動搜尋</h4>
                <input type="text" id="manual-title" placeholder="自訂歌曲名稱" style="width:100%; margin-bottom:10px; background: var(--bg-main); border: 1px solid var(--panel-border); padding: 8px; color: var(--text-color); border-radius: 4px;">
                <input type="text" id="manual-artist" placeholder="自訂歌手名稱" style="width:100%; margin-bottom:10px; background: var(--bg-main); border: 1px solid var(--panel-border); padding: 8px; color: var(--text-color); border-radius: 4px;">
                <button onclick="performManualSearch()" class="nav-btn" style="width: 100%; justify-content: center;"><i class="fa-solid fa-search"></i> 搜尋此歌曲</button>
            </div>
            <div style="border-top: 1px solid var(--panel-border); padding-top: 15px;">
                <h4 style="margin-bottom: 10px; font-size: 14px;"><i class="fa-solid fa-paste"></i> 貼上自訂歌詞</h4>
                <textarea id="custom-lyrics-text" placeholder="貼上 LRC 格式或純文字歌詞..." style="width:100%; height:80px; margin-bottom:10px; background: var(--bg-main); border: 1px solid var(--panel-border); padding: 8px; color: var(--text-color); border-radius: 4px; resize: none;"></textarea>
                <button onclick="performCustomLyrics()" class="nav-btn" style="width: 100%; justify-content: center;"><i class="fa-solid fa-check"></i> 套用自訂歌詞</button>
            </div>
        </div>
    </div>
</div>

<!-- Ruby Edit Modal -->
<div id="ruby-edit-modal" class="modal-overlay hidden">
    <div class="modal-content" style="padding: 20px; position: relative;">
        <button onclick="closeRubyModal()" style="position: absolute; top: 15px; right: 15px; background: transparent; border: none; color: var(--text-secondary); font-size: 18px; cursor: pointer; transition: color 0.3s;"><i class="fa-solid fa-xmark"></i></button>
        <h3><i class="fa-solid fa-pen"></i> 編輯假名/拼音</h3>
        <div style="margin-top: 15px;">
            <div style="font-size: 24px; text-align: center; margin-bottom: 15px; color: var(--text-primary);" id="ruby-edit-kanji">漢字</div>
            <input type="text" id="ruby-edit-rt" placeholder="輸入假名或羅馬拼音..." style="width:100%; margin-bottom:15px; background: var(--bg-main); border: 1px solid var(--panel-border); padding: 8px; color: var(--text-color); border-radius: 4px; font-size: 16px; text-align: center;">
            <button onclick="saveRubyEdit()" class="nav-btn" style="width: 100%; justify-content: center; background: var(--accent-main); color: white; border: none;"><i class="fa-solid fa-check"></i> 套用並儲存</button>
        </div>
    </div>
</div>
"""

if '<!-- Lyrics Rescue Modal -->' not in text:
    text = text.replace('<style>', modals + '\n<style>')

text = text.replace('.lyrics-line { font-size: var(--lyrics-fs, 22px); margin-bottom: 8px; transition: font-size 0.3s; }',
                    '.lyrics-line { font-size: var(--lyrics-fs, 22px); line-height: 1.8; margin-bottom: 8px; transition: font-size 0.3s; }')
text = text.replace('.lyrics-line.active { font-size: calc(var(--lyrics-fs, 22px) + 6px); font-weight: bold; }',
                    '.lyrics-line.active { font-size: calc(var(--lyrics-fs, 22px) + 6px); font-weight: bold; line-height: 1.8; }')

if 'cursor: pointer' not in text:
    text = text.replace('ruby { ruby-align: center; }', 'ruby { ruby-align: center; cursor: pointer; transition: color 0.2s; }\nruby:hover { color: color-mix(in srgb, currentColor, black 40%); }')
    text = text.replace('rt { font-size: 14px; color: #a5b4fc; transform: translateY(-2px); }', 'rt { font-size: 0.6em; color: #a5b4fc; transform: translateY(-2px); cursor: default; }')

text = text.replace('app.js', 'app.js?v=13')

with open(index_path, 'w', encoding='utf-8') as f:
    f.write(text)

app_path = r'web-app/public/js/app.js'
with open(app_path, 'r', encoding='utf-8') as f:
    app_text = f.read()

# Fix escapeHtml bug
app_text = app_text.replace('escapeHtml(lyric.text)', 'lyric.text')

# Append all new code
new_app_code = """
let currentEditingRuby = null;

document.getElementById('lyrics-scroll').addEventListener('click', (e) => {
    const ruby = e.target.closest('ruby');
    if (ruby) {
        currentEditingRuby = ruby;
        
        const clone = ruby.cloneNode(true);
        const rtNode = clone.querySelector('rt');
        if (rtNode) clone.removeChild(rtNode);
        const kanji = clone.textContent.trim();
        
        const currentRt = ruby.querySelector('rt') ? ruby.querySelector('rt').textContent : '';
        
        document.getElementById('ruby-edit-kanji').textContent = kanji;
        document.getElementById('ruby-edit-rt').value = currentRt;
        document.getElementById('ruby-edit-modal').classList.remove('hidden');
        document.getElementById('ruby-edit-modal').classList.add('show');
        
        setTimeout(() => document.getElementById('ruby-edit-rt').focus(), 100);
    }
});

function closeRubyModal() {
    const modal = document.getElementById('ruby-edit-modal');
    modal.classList.remove('show');
    setTimeout(() => modal.classList.add('hidden'), 300);
    currentEditingRuby = null;
}

function romajiToHiragana(text) {
    text = text.toLowerCase();
    text = text.replace(/([bcdfghjklmpqrstvwxyz])\\1/g, 'っ$1');
    
    const mapping = {
        'kya':'きゃ', 'kyu':'きゅ', 'kyo':'きょ',
        'sha':'しゃ', 'shu':'しゅ', 'sho':'しょ',
        'cha':'ちゃ', 'chu':'ちゅ', 'cho':'ちょ',
        'nya':'にゃ', 'nyu':'にゅ', 'nyo':'にょ',
        'hya':'ひゃ', 'hyu':'ひゅ', 'hyo':'ひょ',
        'mya':'みゃ', 'myu':'みゅ', 'myo':'みょ',
        'rya':'りゃ', 'ryu':'りゅ', 'ryo':'りょ',
        'gya':'ぎゃ', 'gyu':'ぎゅ', 'gyo':'ぎょ',
        'ja':'じゃ', 'ju':'じゅ', 'jo':'じょ', 'jya':'じゃ', 'jyu':'じゅ', 'jyo':'じょ',
        'bya':'びゃ', 'byu':'びゅ', 'byo':'びょ',
        'pya':'ぴゃ', 'pyu':'ぴゅ', 'pyo':'ぴょ',
        'shi':'し', 'chi':'ち', 'tsu':'つ',
        'ka':'か', 'ki':'き', 'ku':'く', 'ke':'け', 'ko':'こ',
        'sa':'さ', 'su':'す', 'se':'せ', 'so':'そ',
        'ta':'た', 'te':'て', 'to':'と',
        'na':'な', 'ni':'に', 'nu':'ぬ', 'ne':'ね', 'no':'の',
        'ha':'は', 'hi':'ひ', 'fu':'ふ', 'hu':'ふ', 'he':'へ', 'ho':'ほ',
        'ma':'ま', 'mi':'み', 'mu':'む', 'me':'め', 'mo':'も',
        'ya':'や', 'yu':'ゆ', 'yo':'よ',
        'ra':'ら', 'ri':'り', 'ru':'る', 're':'れ', 'ro':'ろ',
        'wa':'わ', 'wo':'を', 'n':'ん',
        'ga':'が', 'gi':'ぎ', 'gu':'ぐ', 'ge':'げ', 'go':'ご',
        'za':'ざ', 'ji':'じ', 'zu':'ず', 'ze':'ぜ', 'zo':'ぞ',
        'da':'だ', 'de':'で', 'do':'ど',
        'ba':'ば', 'bi':'び', 'bu':'ぶ', 'be':'べ', 'bo':'ぼ',
        'pa':'ぱ', 'pi':'ぴ', 'pu':'ぷ', 'pe':'ぺ', 'po':'ぽ',
        'a':'あ', 'i':'い', 'u':'う', 'e':'え', 'o':'お',
        '-':'ー'
    };
    
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(keys.join('|'), 'g');
    
    return text.replace(pattern, m => mapping[m]);
}

document.getElementById('ruby-edit-rt').addEventListener('input', (e) => {
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const oldLength = input.value.length;
    
    input.value = romajiToHiragana(input.value);
    
    const newLength = input.value.length;
    const diff = newLength - oldLength;
    input.setSelectionRange(start + diff, end + diff);
});

async function saveRubyEdit() {
    if (!currentEditingRuby) return;
    
    const newRtText = document.getElementById('ruby-edit-rt').value.trim();
    const kanji = document.getElementById('ruby-edit-kanji').textContent.trim();
    
    // Optimistic update
    let rt = currentEditingRuby.querySelector('rt');
    if (!newRtText) {
        if (rt) currentEditingRuby.removeChild(rt);
    } else {
        if (!rt) {
            rt = document.createElement('rt');
            currentEditingRuby.appendChild(rt);
        }
        rt.textContent = newRtText;
    }
    
    closeRubyModal();
    showToast('儲存修改中...', 'fa-solid fa-spinner', 1000);
    
    try {
        const resp = await fetch('/api/furigana/correct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: lastMediaTitle,
                artist: lastMediaArtist,
                orig: kanji,
                hira: newRtText
            })
        });
        
        if (resp.ok) {
            showToast('假名修改已同步至資料庫！', 'fa-solid fa-check', 2000);
            setTimeout(() => {
                reloadCurrentLyrics();
            }, 500);
        } else {
            showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
        }
    } catch (e) {
        console.error(e);
        showToast('儲存失敗', 'fa-solid fa-xmark', 2000);
    }
}
"""

if 'saveRubyEdit' not in app_text:
    with open(app_path, 'a', encoding='utf-8') as f:
        f.write(new_app_code)

print("ALL RESTORED AND FIXED!")
