import sys
import json
import re
import os

# Ensure the script can import local modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from utils import kks
from db import db

def build_ruby_html(text, artist, title):
    if not text.strip():
        return text
    
    # Check if there is any Japanese text (Hiragana, Katakana, Kanji)
    # If no kanji, we don't strictly need ruby, but kks.convert handles it.
    # To optimize, we can just run it.
    words = kks.convert(text)
    html_parts = []
    
    for item in words:
        orig = item['orig']
        hira = item['hira']

        db_hira = db.get_word_correction(artist, title, orig)
        if db_hira: hira = db_hira

        has_kanji = re.search(r'[\u4e00-\u9faf\u3005]', orig)
        
        if not has_kanji or not hira or orig == hira:
            html_parts.append(orig)
        else:
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
            
            root_orig = orig[k:i+1]
            root_hira = hira[m:j+1]
            
            part_html = ""
            if prefix: part_html += prefix
            if root_orig: part_html += f"<ruby>{root_orig}<rt>{root_hira}</rt></ruby>"
            if suffix: part_html += suffix
            html_parts.append(part_html)
            
    return "".join(html_parts)

def process_lrc(artist, title, lrc_text):
    lines = lrc_text.split('\n')
    new_lines = []
    for line in lines:
        line = line.strip()
        if not line:
            new_lines.append(line)
            continue
            
        # extract time tags and text
        # usually [00:12.34]text
        match = re.match(r'^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$', line)
        if match:
            tags = match.group(1)
            text = match.group(2).strip()
            ruby_text = build_ruby_html(text, artist, title)
            new_lines.append(f"{tags}{ruby_text}")
        else:
            # maybe no tags or no text
            new_lines.append(line)
            
    return '\n'.join(new_lines)

if __name__ == "__main__":
    # Expecting JSON via stdin: {"artist": "...", "title": "...", "lyrics": "..."}
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
