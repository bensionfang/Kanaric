"""
共用工具函式庫
字串處理:羅馬拼音與平假名的互轉。目前唯一使用者是 search_fallback.generate_queries()，
用來產生同一首歌的多種搜尋寫法 (原名 / 平假名 / 羅馬字) 以提高外部歌詞來源的命中率。
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

