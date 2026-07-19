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
from llm_furigana import get_llm_hints

tagger = fugashi.Tagger()

# 長度不變的等價正規化,只用於「比較」,不影響輸出。
# 羅馬字轉回假名時 づ/ぢ 一定會變成 ず/じ,助詞 は/へ/を 也會寫成 wa/e/o,
# 這些差異是羅馬字的先天損失,不算真的讀音不同。
_KANA_EQ = str.maketrans({'づ': 'ず', 'ぢ': 'じ', 'を': 'お', 'へ': 'え', 'は': 'わ'})
_KANA_ONLY = re.compile(r'^[ぁ-ゟァ-ヿー]+$')

# 兩邊來源都不可信的字:unidic-lite 挑錯,網易雲/酷狗的羅馬字多半也是機器產的,
# 常常跟著錯同一個 (例如 私 兩邊都給 watakushi)。所以這張表套在 apply_hint 之後,
# 只有使用者的 word_corrections 蓋得過它 —— 真的唱 わたくし 的歌手動改一次即可。
# 只在「整個斷詞完全等於 key」時才套用,所以 私的 (してき) 之類的複合詞不受影響。
_COMMON_READING = {
    '私': 'わたし',   # 兩邊來源預設都是 わたくし
}

# 親族呼稱 + 敬稱:兄/姉/父/母 後面接 さん/ちゃん/さま 時讀 にい/ねえ/とう/かあ。
# unidic-lite 這裡固定給字典音 あに/あね/ちち/はは —— 只有「接敬稱」這個語境要改,
# 單獨或別的複合 (兄弟=きょうだい) 不動,所以是有界規則而非通用跨詞比對。
_KINSHIP_READING = {'兄': 'にい', '姉': 'ねえ', '父': 'とう', '母': 'かあ'}
_HONORIFIC = {'さん', 'ちゃん', 'さま'}

def kata2hira(text):
    if not text: return ""
    return "".join(chr(ord(c) - 0x60) if 0x30a1 <= ord(c) <= 0x30f6 else c for c in text)

_KANA_HEAD = re.compile(r'^[ぁ-ゟァ-ヿー]+')
_KANA_TAIL = re.compile(r'[ぁ-ゟァ-ヿー]+$')

def _keeps_okurigana(orig, candidate):
    """
    候選讀音必須含有原詞外露的送り仮名,否則就是對齊歪掉了,不能信。

    hint 是整行羅馬字轉回來的假名,跟 fugashi 的預測做 difflib 對齊。來源只要有一個字
    不一樣 (例如 そんな 被機器寫成 そんあ),切出來的區間就會偏移一格 ——
    疑う 的 うたがう 會被切成 うたが。少了尾巴的 う 之後,送り仮名剝不掉,
    split_internal_kana 反而拿詞內的 う 去切,產生空的 <rt>,漢字就完全沒有假名。
    """
    for pat in (_KANA_HEAD, _KANA_TAIL):
        m = pat.search(orig)
        if not m:
            continue
        okuri = kata2hira(m.group()).translate(_KANA_EQ)
        cand = candidate.translate(_KANA_EQ)
        ok = cand.startswith(okuri) if pat is _KANA_HEAD else cand.endswith(okuri)
        if not ok:
            return False
    return True

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
        if not _keeps_okurigana(w['orig'], candidate):
            continue  # 對齊歪掉了,見 _keeps_okurigana

        w['hira'] = candidate

_KANA_SEG = re.compile(r'[぀-ヿ]+|[^぀-ヿ]+')
_IS_KANA_SEG = re.compile(r'^[぀-ヿ]+$')

def _norm_kana(s):
    """等長正規化,只用於對齊比較 (づ/ず、は/わ 等羅馬字損失視為相同)。"""
    return kata2hira(s).translate(_KANA_EQ)

def _ruby(orig_chunk, hira_chunk, full_orig, full_hira, h_off):
    return (f"<ruby class='editable-ruby' data-orig='{full_orig}' data-hira='{full_hira}' "
            f"data-hs='{h_off}' data-hlen='{len(hira_chunk)}'>{orig_chunk}<rt>{hira_chunk}</rt></ruby>")

def split_internal_kana(orig_chunk, hira_chunk, full_orig, full_hira, h_off=0):
    """
    處理漢字與平假名混合的詞彙 (如 送り仮名),把讀音正確分配到每個漢字段。
    例如「食べて」→ 食(た) + べて。一個斷詞可能被拆成多個 ruby
    (如 噛み締め → 噛(か) + 締(し)),前端得靠 data-hs/data-hlen 知道自己編輯的是
    整詞讀音的哪一段,存回資料庫時才拼得回整詞。

    做法:把 orig 切成 假名段/漢字段 交錯序列,組一條 regex —— 假名段是字面文字,
    漢字段是非貪婪的 (.+?) —— 用 fullmatch 去對整詞讀音,每個漢字段吃到的區間就是它的
    讀音。這樣「言い訳(いいわけ)」的詞內「い」會對到讀音第二個い (言=い、訳=わけ),
    不會像逐字 split 那樣切在第一個い上、害「言」拿到空讀音。
    對不上時整詞包成一個 ruby,寧可整詞標音也不要出現空 <rt>。
    _norm_kana 等長,regex 的 span 位置可直接切回未正規化的 hira_chunk。
    """
    segs = _KANA_SEG.findall(orig_chunk)

    pattern = ''
    for seg in segs:
        pattern += re.escape(_norm_kana(seg)) if _IS_KANA_SEG.match(seg) else '(.+?)'

    m = re.fullmatch(pattern, _norm_kana(hira_chunk)) if '(' in pattern else None
    if m is None:
        # 純漢字 (無詞內假名) 或對不上:整段一個 ruby
        return _ruby(orig_chunk, hira_chunk, full_orig, full_hira, h_off)

    out = []
    gi = 0
    for seg in segs:
        if _IS_KANA_SEG.match(seg):
            out.append(seg)
        else:
            gi += 1
            s, e = m.span(gi)
            out.append(_ruby(seg, hira_chunk[s:e], full_orig, full_hira, h_off + s))
    return ''.join(out)

def build_ruby_html(text, artist, title, hints=()):
    """
    將單行純文字歌詞轉換為包含 <ruby> 標籤的 HTML。
    hints 為該行的正解假名候選,依序套用 (羅馬字 hint 先、LLM hint 後,後者蓋前者)。
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

    # 用羅馬字/LLM 來源的假名校正小辭典挑錯的讀音 (依序疊加,各自過 apply_hint 的 guard)
    for hint in hints:
        apply_hint(words, hint)

    # 連羅馬字來源也一起錯的字,用預設表壓過去 (見 _COMMON_READING)
    for w in words:
        if not w.get('is_space') and w['orig'] in _COMMON_READING:
            w['hira'] = _COMMON_READING[w['orig']]

    # 親族呼稱接敬稱時改用暱稱讀音 (兄さん = にいさん,而非字典的 あにさん)
    non_space = [w for w in words if not w.get('is_space')]
    for a, b in zip(non_space, non_space[1:]):
        if a['orig'] in _KINSHIP_READING and b['orig'] in _HONORIFIC:
            a['hira'] = _KINSHIP_READING[a['orig']]

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

def get_hints(artist, title, lrc_text, force_llm=False):
    """
    取得整首歌的讀音提示:(羅馬字 hint, LLM hint) 兩層,後者套在前者之上。
    只有含漢字的歌詞才值得抓,英文歌直接跳過以免多打一次網路請求。
    force_llm 由前端魔杖觸發:無視模式強制重跑 LLM 並覆寫其快取。
    """
    if not re.search(r'[一-龯々]', lrc_text):
        return {}, {}
    romaji = {}
    try:
        romaji = db.get_romaji_hints(artist, title)
        if romaji is None:  # None = 沒抓過; {} = 抓過但沒來源 (負快取)
            romaji = fetch_hints(artist, title)
            db.save_romaji_hints(artist, title, romaji)
    except Exception as e:
        print(f"[furigana] romaji hints unavailable: {e}", file=sys.stderr)
        romaji = {}
    llm = {}
    try:
        llm = get_llm_hints(artist, title, lrc_text, has_romaji=bool(romaji), force=force_llm)
    except Exception as e:
        print(f"[furigana] llm hints unavailable: {e}", file=sys.stderr)
    return romaji, llm

def process_lrc(artist, title, lrc_text, force_llm=False):
    """
    處理整份 LRC 格式的歌詞檔案，逐行轉換為 ruby HTML 格式
    並保留原始的時間標籤。
    """
    romaji, llm = get_hints(artist, title, lrc_text, force_llm=force_llm)
    def line_hints(text):
        k = normalize_line(text)
        return [h for h in (romaji.get(k), llm.get(k)) if h]
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
                ruby_text = build_ruby_html(text, artist, title, line_hints(text))
            new_lines.append(f"{tags}{ruby_text}")
        elif re.match(r'^\[[a-zA-Z]+:.*\]$', line):
            # 保留 LRC 檔案頭部的 Meta 標籤 (如 [ar:Artist])
            new_lines.append(line)
        else:
            # 無時間標籤的純歌詞文字
            if line.startswith("#TITLE#"):
                ruby_text = line
            else:
                ruby_text = build_ruby_html(line, artist, title, line_hints(line))
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
            injected_lyrics = process_lrc(artist, title, lyrics, force_llm=data.get("force_llm", False))
            print(json.dumps({"success": True, "lyrics": injected_lyrics}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "No lyrics provided"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
