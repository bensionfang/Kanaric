"""
動態歌詞抓取模組
透過 PyQt6 QThread 實作非同步的歌詞搜尋與下載，避免網路請求阻塞主介面。
整合了 syncedlyrics 以及自訂的搜尋後援方案 (如 QQMusic, iTunes JP 修正)。
"""
import re
import requests
import logging
import base64
import json
import syncedlyrics
from PyQt6.QtCore import QThread, pyqtSignal
from utils import text_to_romaji_query, auto_mark_title_lines
from db import db
from config import ITUNES_TIMEOUT, API_TIMEOUT, config

class LyricsFetcher(QThread):
    # 定義發送給主視窗的訊號：成功取得的歌詞內容, 備用歌詞清單(供切換)
    lyrics_fetched = pyqtSignal(str, list)
    
    def __init__(self, title, artist):
        super().__init__()
        self.title = title
        self.artist = artist
        
    def generate_queries(self, t, a):
        """
        為提高搜尋命中率，根據原始歌名/歌手產生多種羅馬音查詢組合
        (處理 Lrclib 等國外平台對日文漢字支援不佳的問題)
        """
        queries = []
        seen = set()
        
        def add_q(qt, qa):
            if (qt, qa) not in seen and qt and qa:
                seen.add((qt, qa))
                queries.append((qt, qa))
                
        add_q(t, a)
        
        rt = text_to_romaji_query(t)
        ra = text_to_romaji_query(a)
        
        rt_valid = rt and rt.lower() != t.lower()
        ra_valid = ra and ra.lower() != a.lower()
        
        if rt_valid:
            add_q(rt, a)
            add_q(rt.replace(" ", ""), a) # 有些平台不含空格
            
        if ra_valid:
            add_q(t, ra)
            
        if rt_valid and ra_valid:
            add_q(rt, ra)
            add_q(rt.replace(" ", ""), ra)
            
        return queries

    def fetch_qqmusic(self, title, artist):
        """
        備用方案：透過 QQMusic 抓取歌詞 (針對 syncedlyrics 找不到的中文/日文歌)
        """
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Referer": "https://y.qq.com/"
        }
        search_url = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
        params = {"p": 1, "n": 5, "w": f"{title} {artist}", "format": "json"}
        try:
            resp = requests.get(search_url, params=params, headers=headers, timeout=API_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                songs = data.get("data", {}).get("song", {}).get("list", [])
                if not songs: return None, []
                
                best_song = songs[0]
                songmid = best_song.get("songmid")
                if not songmid: return None, []
                
                lyric_url = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg"
                l_params = {"songmid": songmid, "format": "json", "nobase64": 0}
                l_resp = requests.get(lyric_url, params=l_params, headers=headers, timeout=API_TIMEOUT)
                
                if l_resp.status_code == 200:
                    l_data = l_resp.json()
                    lyric_b64 = l_data.get("lyric", "")
                    if lyric_b64:
                        lyric_text = base64.b64decode(lyric_b64).decode("utf-8", errors="ignore")
                        artist_name = best_song.get("singer", [{}])[0].get("name", artist)
                        lyric_text = f"[source:QQMusic]\n{lyric_text}"
                        return lyric_text, [{'title': best_song.get("songname", title), 'artist': artist_name, 'lyrics': lyric_text}]
        except Exception as e:
            logging.warning(f"QQMusic API 請求失敗: {e}")
        return None, []

    def fetch_from_provider(self, provider, title, artist):
        """根據指定的來源 (Provider) 執行對應的搜尋策略"""
        if provider == "Lrclib":
            # Lrclib 支援自訂評分機制，且需要多組羅馬音查詢
            for qt, qa in self.generate_queries(title, artist):
                best, opts = self.search_lrclib(qt, qa)
                if best: 
                    best = f"[source:Lrclib]\n{best}"
                    return best, opts
            return None, []
        elif provider == "QQMusic":
            return self.fetch_qqmusic(title, artist)
        elif provider in ["NetEase", "Musixmatch", "Megalobiz"]:
            query = f"{title} {artist}"
            try:
                # 呼叫 syncedlyrics 第三方套件
                lyric = syncedlyrics.search(query, providers=[provider])
                if lyric:
                    lyric = f"[source:{provider}]\n{lyric}"
                    return lyric, [{'title': title, 'artist': artist, 'lyrics': lyric}]
            except Exception as e:
                logging.warning(f"syncedlyrics provider {provider} 請求失敗: {e}")
            return None, []
        return None, []

    def run(self):
        """QThread 背景執行的主要邏輯"""
        try:
            # 1. 優先從本地資料庫讀取快取
            cached_lyric = db.get_cached_lyrics(self.artist, self.title)
            if cached_lyric:
                self.lyrics_fetched.emit(cached_lyric, []) 
                return

            # 2. 清洗標題 (移除 Remastered, Live 等贅字) 以提高命中率
            clean_title = re.sub(r'\(feat\..*?\)|\- Remastered.*|\- Live.*', '', self.title, flags=re.IGNORECASE).strip()
            best_lyric, options = None, []

            # 3. 根據使用者偏好設定優先來源排序
            preferred = config.get("preferred_source", "NetEase")
            providers_queue = [preferred]
            for fallback in ["NetEase", "Lrclib", "Musixmatch"]:
                if fallback not in providers_queue:
                    providers_queue.append(fallback)

            # 4. 依序嘗試各個來源
            all_options = []
            best_synced_lyric = None
            best_plain_lyric = None

            for provider in providers_queue:
                logging.info(f"嘗試從 {provider} 獲取歌詞...")
                curr_lyric, curr_options = self.fetch_from_provider(provider, clean_title, self.artist)
                
                if curr_options:
                    all_options.extend(curr_options)
                    
                if curr_lyric:
                    # 判斷是否為「動態歌詞」 (包含時間軸標籤)
                    has_time_tags = bool(re.search(r'\[\d{2}:\d{2}', curr_lyric))
                    if has_time_tags:
                        best_synced_lyric = curr_lyric
                        logging.info(f"成功從 {provider} 獲取動態歌詞！")
                        break # 找到動態歌詞就提早結束搜尋
                    else:
                        if not best_plain_lyric:
                            best_plain_lyric = curr_lyric
                        logging.info(f"從 {provider} 僅獲取到純文字歌詞，保留為備用，繼續尋找動態歌詞...")

            # 5. 最後防線：若皆無結果，嘗試使用 iTunes JP API 修正羅馬音標題回日文標題，再搜 Lrclib
            if not best_synced_lyric and not best_plain_lyric:
                logging.info("所有常規來源均無歌詞，嘗試 iTunes 日文標題修正 fallback...")
                try:
                    itunes_url = "https://itunes.apple.com/search"
                    params = {"term": f"{clean_title} {self.artist}", "entity": "song", "limit": 1, "country": "jp"}
                    resp = requests.get(itunes_url, params=params, timeout=ITUNES_TIMEOUT)
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        if results:
                            jp_title = results[0].get("trackName", clean_title)
                            jp_artist = results[0].get("artistName", self.artist)
                            
                            if jp_title != clean_title or jp_artist != self.artist:
                                curr_lyric, curr_options = self.fetch_from_provider("Lrclib", jp_title, jp_artist)
                                if curr_options:
                                    all_options.extend(curr_options)
                                if curr_lyric:
                                    has_time_tags = bool(re.search(r'\[\d{2}:\d{2}', curr_lyric))
                                    if has_time_tags:
                                        best_synced_lyric = curr_lyric
                                    else:
                                        best_plain_lyric = curr_lyric
                except Exception as e:
                    logging.warning(f"iTunes API 請求失敗: {e}")

            # 6. 整合結果與後處理
            final_lyric = best_synced_lyric or best_plain_lyric
            if final_lyric:
                final_lyric = auto_mark_title_lines(final_lyric) # 為製作人員名單上色標記
            
            # 將備選清單排序：有動態時間軸的排前面
            all_options.sort(key=lambda x: bool(re.search(r'\[\d{2}:\d{2}', x.get('lyrics', ''))), reverse=True)
            
            # 發送最終結果給 UI，並寫入資料庫快取
            if final_lyric and not cached_lyric:
                db.save_cached_lyrics(self.artist, self.title, final_lyric)
                self.lyrics_fetched.emit(final_lyric, all_options)
            elif all_options:
                self.lyrics_fetched.emit("OPTIONS_ONLY", all_options)
            else:
                self.lyrics_fetched.emit("", []) 
                
        except Exception as e: 
            logging.error(f"歌詞抓取例外錯誤: {e}")
            self.lyrics_fetched.emit("", [])

    def search_lrclib(self, target_title, target_artist):
        """
        客製化的 Lrclib 搜尋邏輯，使用評分機制過濾掉翻譯版 (Translation) 或純羅馬音版，
        確保抓到的是原汁原味的原文歌詞。
        """
        headers = {"User-Agent": "Mozilla/5.0"}
        url = "https://lrclib.net/api/search"
        try:
            response = requests.get(url, params={"q": f"{target_title} {target_artist}"}, headers=headers, timeout=API_TIMEOUT)
            if response.status_code == 200:
                data = response.json()
                valid_lyrics = []
                for t in data:
                    best_lyric = t.get("syncedLyrics") or t.get("plainLyrics")
                    if best_lyric:
                        valid_lyrics.append({
                            'title': t.get('trackName', ''),
                            'artist': t.get('artistName', ''),
                            'album': t.get('albumName', ''),
                            'duration': t.get('duration', 0),
                            'lyrics': best_lyric
                        })
                        
                if valid_lyrics:
                    # 定義評分函式，以過濾劣質或不相干的搜尋結果
                    def get_score(item):
                        score = 0
                        item_title = item['title'].lower()
                        item_artist = item['artist'].lower()
                        t_title = target_title.lower()
                        t_artist = target_artist.lower()

                        if t_title == item_title:
                            score += 1000
                        elif t_title in item_title or item_title in t_title:
                            score += 500
                            
                        if t_artist == item_artist:
                            score += 500
                        elif t_artist in item_artist or item_artist in t_artist:
                            score += 200
                            
                        if re.search(r'[\u3040-\u30FF]', item['lyrics']):
                            score += 100 # 含有日文字母加分
                            
                        # 大幅扣分翻譯版或羅馬音版
                        penalty_keywords = ['translated', 'translation', 'romanized', '翻譯', '中文版', 'english version']
                        if any(kw in item_title for kw in penalty_keywords):
                            score -= 800
                        if any(kw in item['album'].lower() for kw in penalty_keywords):
                            score -= 500
                            
                        # 若歌詞內文明確標示翻譯，同樣扣分
                        lower_lyrics = item['lyrics'].lower()
                        if 'english translation' in lower_lyrics or 'romanized' in lower_lyrics or 'translation by' in lower_lyrics:
                            score -= 800
                            
                        return score

                    valid_lyrics.sort(key=get_score, reverse=True)
                    return valid_lyrics[0]['lyrics'], valid_lyrics[:5]
        except Exception as e:
            logging.warning(f"LRCLIB API 請求失敗: {e}")
        return None, []
