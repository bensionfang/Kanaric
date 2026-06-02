import sys
import json
import re
import os

# Ensure the script can import local modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from utils import kks
from db import db

def split_internal_kana(orig_chunk, hira_chunk, full_orig, full_hira):
    match = re.search(r'([\u3040-\u30ff]+)', orig_chunk)
    if match:
        kana = match.group(1)
        if kana in hira_chunk:
            parts_orig = orig_chunk.split(kana, 1)
            parts_hira = hira_chunk.split(kana, 1)
            left = split_internal_kana(parts_orig[0], parts_hira[0], full_orig, full_hira) if parts_orig[0] else ''
            right = split_internal_kana(parts_orig[1], parts_hira[1], full_orig, full_hira) if parts_orig[1] else ''
            return f"{left}{kana}{right}"
    return f"<ruby class='editable-ruby' data-orig='{full_orig}' data-hira='{full_hira}'>{orig_chunk}<rt>{hira_chunk}</rt></ruby>"

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

        has_kanji = re.search(r'[\u4e00-\u9faf\u3005]', orig)
        
        if not has_kanji:
            html_parts.append(orig)
            continue

        # Strip matching prefix and suffix based on kks base conversion
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

        # Now lookup the root_orig in DB
        db_hira = db.get_word_correction(artist, title, root_orig)
        if db_hira is not None: 
            root_hira = db_hira
            
        if not root_orig:
            pass # fallback, should not happen if has_kanji is true
        elif root_orig == root_hira:
            part_html = f"{prefix}{root_orig}{suffix}"
            html_parts.append(part_html)
        elif not root_hira:
            part_html = f"{prefix}<ruby class='editable-ruby' data-orig='{root_orig}' data-hira=''>{root_orig}</ruby>{suffix}"
            html_parts.append(part_html)
        else:
            part_html = f"{prefix}{split_internal_kana(root_orig, root_hira, root_orig, root_hira)}{suffix}"
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
        elif re.match(r'^\[[a-zA-Z]+:.*\]$', line):
            # It's an LRC metadata tag like [ar:Artist], leave it alone
            new_lines.append(line)
        else:
            # It's either plain text lyrics without tags, or a malformed line. Process it.
            ruby_text = build_ruby_html(line, artist, title)
            new_lines.append(ruby_text)
            
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
