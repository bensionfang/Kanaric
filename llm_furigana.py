"""
LLM 同形詞消歧 (BYOK)。
把整首歌詞送給使用者自己設定的 OpenAI 相容端點,要求逐行回傳完整平假名讀音,
轉成與羅馬字 hint 同格式 ({normalize_line(行): 假名}) 後,走 furigana_inject 現成的
apply_hint() 疊在羅馬字 hint 之上。_COMMON_READING 與 word_corrections 仍在其上。

Key 只從環境變數 LLM_API_KEY 讀 (由 server.js 的 spawnPy 注入),絕不進 settings.json。
llm_base_url / llm_model / llm_furigana (off/fallback/always) 不敏感,放 settings.json。
"""
import json
import os
import re
import sys

import requests

from db import db
from cn_music import normalize_line

SETTINGS_PATH = os.environ.get('LYRICS_SETTINGS_PATH') or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings.json')

_KANA_RE = re.compile(r'[ぁ-ゟァ-ヿー]+')
_TIME_TAG = re.compile(r'\[\d+:\d+(?:\.\d+)?\]')
_KANJI = re.compile(r'[一-龯々]')


def _load_llm_settings():
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
    except Exception:
        s = {}
    return {
        'mode': s.get('llm_furigana', 'off'),
        'base_url': (s.get('llm_base_url') or '').strip(),
        'model': (s.get('llm_model') or '').strip(),
    }


def _kata2hira(text):
    return ''.join(chr(ord(c) - 0x60) if 0x30a1 <= ord(c) <= 0x30f6 else c for c in text)


def _clean_reading(reading):
    """回傳值收斂成純平假名字串 (丟掉標點/空白/殘留漢字),供 apply_hint 對齊用。"""
    return ''.join(_KANA_RE.findall(_kata2hira(reading or '')))


def _lyric_lines(lrc_text):
    """去時間標籤、跳過 #TITLE# 行,只留含漢字的歌詞行 (去重保序)。"""
    seen = set()
    lines = []
    for raw in lrc_text.split('\n'):
        text = _TIME_TAG.sub('', raw).strip()
        if not text or text.startswith('#TITLE#') or not _KANJI.search(text):
            continue
        if re.match(r'^\[[a-zA-Z]+:.*\]$', text):  # LRC meta 標籤
            continue
        if text not in seen:
            seen.add(text)
            lines.append(text)
    return lines


def parse_llm_response(content, lines):
    """
    從模型回覆抽出 JSON 陣列並轉成 {normalize_line(行): 假名}。
    容忍 code fence 與前後贅字;元素格式 {"line": ..., "reading": ...}。
    只收 key 對得上送出行的結果,模型自己發明的行直接丟掉。
    """
    m = re.search(r'\[.*\]', content, re.S)
    if not m:
        return {}
    try:
        arr = json.loads(m.group())
    except ValueError:
        return {}
    valid_keys = {normalize_line(l) for l in lines}
    hints = {}
    for item in arr:
        if not isinstance(item, dict):
            continue
        key = normalize_line(str(item.get('line', '')))
        reading = _clean_reading(str(item.get('reading', '')))
        if key and reading and key in valid_keys:
            hints[key] = reading
    return hints


# 最近一次 fetch 的失敗原因;一次性行程,全域夠用。furigana_inject main() 讀它回報 server,
# 讓魔杖強制重跑時「請求失敗」不會被當成「校正完成」。
LAST_ERROR = None


def fetch_llm_hints(artist, title, lrc_text):
    """打一次 API 拿整首歌的逐行讀音。失敗記 stderr + LAST_ERROR、回 {} (視同無 hint)。"""
    global LAST_ERROR
    LAST_ERROR = None
    cfg = _load_llm_settings()
    key = os.environ.get('LLM_API_KEY', '')
    if not key or not cfg['base_url'] or not cfg['model']:
        LAST_ERROR = 'Base URL / Model 未設定'
        return {}

    lines = _lyric_lines(lrc_text)
    if not lines:
        return {}

    url = cfg['base_url'].rstrip('/')
    if not url.endswith('/chat/completions'):
        url += '/chat/completions'

    prompt = (
        f"以下是歌曲「{title}」(歌手: {artist}) 的日文歌詞。"
        "請為每一行標註完整的平假名讀音。注意同形詞要依上下文判斷讀音"
        "(例如 私 わたし/わたくし、行く いく/ゆく、明日 あした/あす)。"
        "歌詞中的人名、專有名詞也依常識標註。\n"
        "只回傳 JSON 陣列,格式: [{\"line\": \"原歌詞行\", \"reading\": \"平假名讀音\"}],"
        "line 必須與輸入完全一致,不要輸出任何其他文字。\n\n"
        + '\n'.join(lines)
    )

    try:
        resp = requests.post(
            url,
            headers={'Authorization': f'Bearer {key}'},
            json={
                'model': cfg['model'],
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0,
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()['choices'][0]['message']['content']
    except Exception as e:
        LAST_ERROR = str(e)
        print(f"[llm_furigana] request failed: {e}", file=sys.stderr)
        return {}

    hints = parse_llm_response(content, lines)
    if not hints:
        LAST_ERROR = '模型回覆無法解析'
        print("[llm_furigana] empty/unparsable response", file=sys.stderr)
    return hints


def get_llm_hints(artist, title, lrc_text, has_romaji, force=False):
    """
    決定要不要跑 LLM 並處理快取。
    模式只管「要不要自動打 API」;已存在的快取 (先前魔杖或自動跑出來的) 永遠套用,
    所以「關閉」模式下魔杖的校正結果也不會消失。
    force=True (前端魔杖) 無視模式、強制重跑並覆寫快取;只快取成功結果。
    """
    if not os.environ.get('LLM_API_KEY'):
        return {}
    if not force:
        cached = db.get_llm_hints(artist, title)
        if cached is not None:
            return cached
        mode = _load_llm_settings()['mode']
        if mode == 'off':
            return {}
        if mode == 'fallback' and has_romaji:
            return {}
    hints = fetch_llm_hints(artist, title, lrc_text)
    if hints:
        db.save_llm_hints(artist, title, hints)
    return hints


def _selftest():
    lines = ['私は行く', '明日を見る']
    fenced = ('好的,以下是結果:\n```json\n'
              '[{"line": "私は行く", "reading": "わたしはゆく"},'
              ' {"line": "明日を見る", "reading": "アシタをみる。"},'
              ' {"line": "捏造的行", "reading": "うそ"}]\n```')
    hints = parse_llm_response(fenced, lines)
    # code fence 剝掉、假名保留 (katakana 轉 hira、標點漢字丟掉)、捏造行不收
    assert hints[normalize_line('私は行く')] == 'わたしはゆく'
    assert hints[normalize_line('明日を見る')] == 'あしたをみる'
    assert len(hints) == 2
    assert parse_llm_response('對不起我做不到', lines) == {}
    assert parse_llm_response('[not json', lines) == {}
    assert _lyric_lines('[00:01.00]私は行く\n[00:02.00]#TITLE#作詞：某人\n[00:03.00]私は行く\nhello world\n') == ['私は行く']
    print('llm_furigana selftest OK')


if __name__ == '__main__':
    _selftest()
