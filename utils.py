import re
import pykakasi
from typing import List, Dict, Any

kks = pykakasi.kakasi()

def romaji_to_hiragana(text: str) -> str:
    """將羅馬拼音轉換為平假名。"""
    text = text.lower()
    text = re.sub(r'([bcdfghjklmpqrstvwxyz])\1', r'っ\1', text)
    
    mapping = {
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
    }
    keys = sorted(mapping.keys(), key=len, reverse=True)
    pattern = re.compile('|'.join(map(re.escape, keys)))
    return pattern.sub(lambda m: mapping[m.group(0)], text)

def text_to_romaji_query(text: str) -> str:
    """將文字轉換為羅馬拼音查詢字串。"""
    if not text: return ""
    result = kks.convert(text)
    out = [item['hepburn'] for item in result if item['hepburn']]
    joined = " ".join(out)
    return re.sub(r'\s+', ' ', joined).strip()

import re
def auto_mark_title_lines(lrc_text):
    if not lrc_text: return lrc_text
    keywords = ["作詞", "作词", "作曲", "編曲", "编曲", "製作", "制作", "混音", "演唱", "原唱", "vocal", "lyric", "music", "arrange", "mix", "mastering", "和聲", "和声", "企劃", "企划"]
    lines = lrc_text.split('\n')
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            new_lines.append(line)
            continue
            
        match = re.match(r'^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$', stripped)
        if match:
            tags = match.group(1)
            text = match.group(2).strip()
            if not text.startswith("#TITLE#"):
                lower_text = text.lower()
                is_title = False
                for kw in keywords:
                    if kw in lower_text and len(text) < 40:
                        # Ensure it's acting like a label (e.g., followed by colon, space, or is mostly just the keyword)
                        if re.search(r'[:：]', text) or re.search(rf'{kw}\s+', text) or len(text) < len(kw) + 5:
                            is_title = True
                            break
                if is_title:
                    text = "#TITLE#" + text
            new_lines.append(f"{tags}{text}")
        else:
            new_lines.append(stripped)
    return '\n'.join(new_lines)
