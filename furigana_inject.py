"""
日文假名注音 (Furigana) 注入模組
負責將純文字的日文歌詞轉換為帶有 HTML <ruby> 標籤的格式。
結合 pykakasi 進行分詞與拼音轉換，並透過 SQLite 資料庫檢查是否有使用者自訂的發音修正。
"""
import sys
import json
import re
import os

# 確保可以匯入同目錄下的模組
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from utils import kks
from db import db

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

def build_ruby_html(text, artist, title):
    """
    將單行純文字歌詞轉換為包含 <ruby> 標籤的 HTML。
    """
    if not text.strip():
        return text
    
    # 檢查是否包含日文，使用 pykakasi 進行分詞
    words = kks.convert(text)
    html_parts = []
    
    for item in words:
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

def process_lrc(artist, title, lrc_text):
    """
    處理整份 LRC 格式的歌詞檔案，逐行轉換為 ruby HTML 格式
    並保留原始的時間標籤。
    """
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
                ruby_text = build_ruby_html(text, artist, title)
            new_lines.append(f"{tags}{ruby_text}")
        elif re.match(r'^\[[a-zA-Z]+:.*\]$', line):
            # 保留 LRC 檔案頭部的 Meta 標籤 (如 [ar:Artist])
            new_lines.append(line)
        else:
            # 無時間標籤的純歌詞文字
            if line.startswith("#TITLE#"):
                ruby_text = line
            else:
                ruby_text = build_ruby_html(line, artist, title)
            new_lines.append(ruby_text)
            
    return '\n'.join(new_lines)

if __name__ == "__main__":
    # 若作為獨立腳本執行，預期從 stdin 接收 JSON 輸入
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
