"""
日文假名注音 (Furigana) 注入模組
負責將純文字的日文歌詞轉換為帶有 HTML <ruby> 標籤的格式。
以 fugashi (unidic-lite) 分詞取讀音,再依序用 cn_music 的羅馬字提示與資料庫中
使用者自訂的發音修正覆蓋 (使用者修正優先權最高)。
"""
import sys
import json
import re
import os
import difflib

# 確保可以匯入同目錄下的模組
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import fugashi
from db import db
from cn_music import fetch_hints, normalize_line

tagger = fugashi.Tagger()

# 長度不變的等價正規化,只用於「比較」,不影響輸出。
# 羅馬字轉回假名時 づ/ぢ 一定會變成 ず/じ,助詞 は/へ/を 也會寫成 wa/e/o,
# 這些差異是羅馬字的先天損失,不算真的讀音不同。
_KANA_EQ = str.maketrans({'づ': 'ず', 'ぢ': 'じ', 'を': 'お', 'へ': 'え', 'は': 'わ'})
_KANA_ONLY = re.compile(r'^[ぁ-ゟァ-ヿー]+$')

def kata2hira(text):
    if not text: return ""
    return "".join(chr(ord(c) - 0x60) if 0x30a1 <= ord(c) <= 0x30f6 else c for c in text)

def apply_hint(words, hint):
    """
    用羅馬字來源的整行假名 (hint) 校正 fugashi 的分詞讀音。

    做法:把 fugashi 預測的整行假名跟 hint 做序列對齊,再依每個 token 在預測字串
    裡的區間,切出 hint 對應的片段。只有在「正規化後仍然不同」時才覆蓋 ——
    例如 君: くん vs きみ 會被修正,而 続: つづけ vs つずけ 屬羅馬字損失,保留 fugashi。
    """
    if not hint:
        return

    pred = ''.join(w['hira'] for w in words)
    if not pred:
        return

    matcher = difflib.SequenceMatcher(None, pred.translate(_KANA_EQ), hint.translate(_KANA_EQ), autojunk=False)
    blocks = matcher.get_matching_blocks()

    def map_index(i):
        """把預測字串的位置映射到 hint 的位置"""
        for b in blocks:
            if i < b.a:
                return b.b - (b.a - i)  # 落在兩個相符區塊之間,用左側區塊外推
            if i < b.a + b.size:
                return b.b + (i - b.a)
        return len(hint)

    pos = 0
    for w in words:
        start, end = pos, pos + len(w['hira'])
        pos = end
        if w.get('is_space') or not re.search(r'[一-龯々]', w['orig']):
            continue

        h_start, h_end = map_index(start), map_index(end)
        if h_start < 0 or h_end > len(hint) or h_start >= h_end:
            continue

        candidate = hint[h_start:h_end]
        if not _KANA_ONLY.match(candidate):
            continue
        if candidate.translate(_KANA_EQ) == w['hira'].translate(_KANA_EQ):
            continue  # 只是羅馬字轉換的等價差異,不動

        w['hira'] = candidate

def split_internal_kana(orig_chunk, hira_chunk, full_orig, full_hira):
    """
    遞迴處理漢字與平假名混合的詞彙 (如 送り仮名)。
    例如：「食べて」中「食」是漢字，「べて」是平假名，此函式負責將它們正確拆分。
    """
    match = re.search(r'([\u3040-\u30ff]+)', orig_chunk) # 找出原始文字中的平假/片假名
    if match:
        kana = match.group(1)
        if kana in hira_chunk:
            # 根據找到的假名將字詞切分為左右兩半
            parts_orig = orig_chunk.split(kana, 1)
            parts_hira = hira_chunk.split(kana, 1)
            left = split_internal_kana(parts_orig[0], parts_hira[0], full_orig, full_hira) if parts_orig[0] else ''
            right = split_internal_kana(parts_orig[1], parts_hira[1], full_orig, full_hira) if parts_orig[1] else ''
            return f"{left}{kana}{right}"
    # 若無內部假名可拆分，則直接包裝成 ruby 標籤
    return f"<ruby class='editable-ruby' data-orig='{full_orig}' data-hira='{full_hira}'>{orig_chunk}<rt>{hira_chunk}</rt></ruby>"

def build_ruby_html(text, artist, title, hint=None):
    """
    將單行純文字歌詞轉換為包含 <ruby> 標籤的 HTML。
    hint 為該行來自羅馬字歌詞的正解假名 (可為 None)。
    """
    if not text.strip():
        return text

    # 使用 fugashi 進行上下文感知的形態素分析
    # 注意：fugashi 會吃掉 token 之間的空白，需要手動還原
    words = []
    pos = 0  # 追蹤在原始文字中的位置
    for w in tagger(text):
        surface = w.surface
        # 找到此 token 在原始文字中的位置
        idx = text.find(surface, pos)
        if idx > pos:
            # 在此 token 之前有被 fugashi 吃掉的空白/字元，需要保留
            words.append({'orig': text[pos:idx], 'hira': text[pos:idx], 'is_space': True})
        kana = getattr(w.feature, 'kana', None)
        if not kana:
            kana = surface
        words.append({'orig': surface, 'hira': kata2hira(kana), 'is_space': False})
        pos = idx + len(surface) if idx >= 0 else pos + len(surface)
    # 處理尾部可能殘留的空白
    if pos < len(text):
        words.append({'orig': text[pos:], 'hira': text[pos:], 'is_space': True})

    # 用羅馬字來源的假名校正小辭典挑錯的讀音
    apply_hint(words, hint)

    html_parts = []
    
    for item in words:
        # 空白/分隔符號直接保留
        if item.get('is_space'):
            html_parts.append(item['orig'])
            continue
            
        orig = item['orig'] # 原始文字 (包含漢字)
        hira = item['hira'] # 轉換後的平假名

        # 檢查該詞彙是否含有漢字
        has_kanji = re.search(r'[\u4e00-\u9faf\u3005]', orig)
        
        if not has_kanji:
            html_parts.append(orig)
            continue

        # 去除前後相同綴詞 (處理送り仮名)
        i = len(orig) - 1
        j = len(hira) - 1
        while i >= 0 and j >= 0 and orig[i] == hira[j]:
            i -= 1
            j -= 1
        suffix = orig[i+1:] if i + 1 < len(orig) else ""
        
        k = 0
        m = 0
        while k <= i and m <= j and orig[k] == hira[m]:
            k += 1
            m += 1
        prefix = orig[:k]
        
        # 取出純漢字的核心部分
        root_orig = orig[k:i+1]
        root_hira = hira[m:j+1]

        # 查詢資料庫，檢查是否有使用者自訂的修正發音
        db_hira = db.get_word_correction(artist, title, root_orig)
        if db_hira is not None: 
            root_hira = db_hira
            
        if not root_orig:
            pass # fallback, 不應發生
        elif root_orig == root_hira:
            part_html = f"{prefix}{root_orig}{suffix}"
            html_parts.append(part_html)
        elif not root_hira:
            part_html = f"{prefix}<ruby class='editable-ruby' data-orig='{root_orig}' data-hira=''>{root_orig}</ruby>{suffix}"
            html_parts.append(part_html)
        else:
            # 處理可能還有內部假名的複雜組合
            part_html = f"{prefix}{split_internal_kana(root_orig, root_hira, root_orig, root_hira)}{suffix}"
            html_parts.append(part_html)
            
    return "".join(html_parts)

def get_hints(artist, title, lrc_text):
    """
    取得整首歌的羅馬字讀音提示 (先查快取,沒有才去抓)。
    只有含漢字的歌詞才值得抓,英文歌直接跳過以免多打一次網路請求。
    """
    if not re.search(r'[一-龯々]', lrc_text):
        return {}
    try:
        hints = db.get_romaji_hints(artist, title)
        if hints is None:  # None = 沒抓過; {} = 抓過但沒來源 (負快取)
            hints = fetch_hints(artist, title)
            db.save_romaji_hints(artist, title, hints)
        return hints
    except Exception as e:
        print(f"[furigana] romaji hints unavailable: {e}", file=sys.stderr)
        return {}

def process_lrc(artist, title, lrc_text):
    """
    處理整份 LRC 格式的歌詞檔案，逐行轉換為 ruby HTML 格式
    並保留原始的時間標籤。
    """
    hints = get_hints(artist, title, lrc_text)
    lines = lrc_text.split('\n')
    new_lines = []
    for line in lines:
        line = line.strip()
        if not line:
            new_lines.append(line)
            continue
            
        # 提取時間標籤與文字 (支援多個標籤合併，如 [00:12.34][00:15.67]歌詞)
        match = re.match(r'^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$', line)
        if match:
            tags = match.group(1)
            text = match.group(2).strip()
            # 避開已標記為 #TITLE# 的製作人員列
            if text.startswith("#TITLE#"):
                ruby_text = text
            else:
                ruby_text = build_ruby_html(text, artist, title, hints.get(normalize_line(text)))
            new_lines.append(f"{tags}{ruby_text}")
        elif re.match(r'^\[[a-zA-Z]+:.*\]$', line):
            # 保留 LRC 檔案頭部的 Meta 標籤 (如 [ar:Artist])
            new_lines.append(line)
        else:
            # 無時間標籤的純歌詞文字
            if line.startswith("#TITLE#"):
                ruby_text = line
            else:
                ruby_text = build_ruby_html(line, artist, title, hints.get(normalize_line(line)))
            new_lines.append(ruby_text)
            
    return '\n'.join(new_lines)

def main():
    # 從 stdin 接收 JSON 輸入 (由 Node.js 或 pytools.py 呼叫)
    try:
        input_data = sys.stdin.read()
        data = json.loads(input_data)
        artist = data.get("artist", "")
        title = data.get("title", "")
        lyrics = data.get("lyrics", "")
        
        if lyrics:
            injected_lyrics = process_lrc(artist, title, lyrics)
            print(json.dumps({"success": True, "lyrics": injected_lyrics}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "No lyrics provided"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
