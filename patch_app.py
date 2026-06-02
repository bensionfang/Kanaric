import re

with open('web-app/public/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Modify fetchAndParseLyrics to fetch offset
fetch_injection = '''
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
'''

text = text.replace("parsedLyrics = [];", "parsedLyrics = [];\n" + fetch_injection)

# 2. Modify keydown listener to POST offset
# We need to find the syncOffset += 0.5 logic and add fetch calls.
text = text.replace(
'''            syncOffset += 0.5;
            showToast(`歌詞提早 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);''',
'''            syncOffset += 0.5;
            showToast(`歌詞提早 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);
            saveOffsetToServer();'''
)

text = text.replace(
'''            syncOffset -= 0.5;
            showToast(`歌詞延遲 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);''',
'''            syncOffset -= 0.5;
            showToast(`歌詞延遲 0.5 秒 (總偏移: ${syncOffset.toFixed(1)}s)`);
            saveOffsetToServer();'''
)

# 3. Add saveOffsetToServer function
save_func = '''
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
'''
text += '\n' + save_func

with open('web-app/public/js/app.js', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
