"""
共用工具函式庫
負責提供各模組共用的字串處理功能，包含：羅馬拼音與平假名轉換、以及過濾/標記歌詞開頭的製作人員資訊。
"""
import re
import pykakasi
from typing import List, Dict, Any

# 初始化 pykakasi (日文拼音轉換工具)
kks = pykakasi.kakasi()

def romaji_to_hiragana(text: str) -> str:
    """
    將羅馬拼音轉換為平假名。
    使用正則表達式與替換字典處理連音(っ)與常見拼音組合。
    """
    text = text.lower()
    # 處理促音 (連續兩個相同子音，如 'tt' -> 'っt')
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
    # 依照鍵的長度排序替換，避免短拼音提早匹配 (例：'sha' 不會被當作 's' 和 'ha')
    keys = sorted(mapping.keys(), key=len, reverse=True)
    pattern = re.compile('|'.join(map(re.escape, keys)))
    return pattern.sub(lambda m: mapping[m.group(0)], text)

def text_to_romaji_query(text: str) -> str:
    """
    將一段文字轉換為羅馬拼音查詢字串，主要用於強化歌詞或歌曲的搜尋準確度。
    """
    if not text: return ""
    result = kks.convert(text)
    # 取出 Hepburn 拼音
    out = [item['hepburn'] for item in result if item['hepburn']]
    joined = " ".join(out)
    # 移除多餘空白
    return re.sub(r'\s+', ' ', joined).strip()

def auto_mark_title_lines(lrc_text):
    """
    自動掃描歌詞，為製作人員名單 (如作詞、作曲等) 加上 #TITLE# 標記，
    讓 UI 能夠針對這些標題行給予不同的視覺樣式。
    """
    if not lrc_text: return lrc_text
    keywords = ["作詞", "作词", "作曲", "編曲", "编曲", "製作", "制作", "混音", "演唱", "原唱", "vocal", "lyric", "music", "arrange", "mix", "mastering", "和聲", "和声", "企劃", "企划"]
    lines = lrc_text.split('\n')
    new_lines = []
    
    for line in lines:
        stripped = line.strip()
        if not stripped:
            new_lines.append(line)
            continue
            
        # 匹配標準的 LRC 時間標籤格式，如 [00:12.34]
        match = re.match(r'^(\[(?:\d+:\d+(?:\.\d+)?)\])+(.+)$', stripped)
        if match:
            tags = match.group(1)
            text = match.group(2).strip()
            # 如果尚未被標記，則進行關鍵字判斷
            if not text.startswith("#TITLE#"):
                lower_text = text.lower()
                is_title = False
                for kw in keywords:
                    # 如果字數少於 40 字且包含關鍵字
                    if kw in lower_text and len(text) < 40:
                        # 確保它像一個標題 (例如包含冒號、空格，或長度與關鍵字相近)
                        if re.search(r'[:：]', text) or re.search(rf'{kw}\s+', text) or len(text) < len(kw) + 5:
                            is_title = True
                            break
                if is_title:
                    text = "#TITLE#" + text
            new_lines.append(f"{tags}{text}")
        else:
            new_lines.append(stripped)
    return '\n'.join(new_lines)
