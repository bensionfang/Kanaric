import re
import requests
import logging
import syncedlyrics
from PyQt6.QtCore import QThread, pyqtSignal
from utils import text_to_romaji_query
from db import db
from config import ITUNES_TIMEOUT, API_TIMEOUT

class LyricsFetcher(QThread):
    lyrics_fetched = pyqtSignal(str, list)
    def __init__(self, title, artist):
        super().__init__()
        self.title, self.artist = title, artist
        
    def generate_queries(self, t, a):
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
            add_q(rt.replace(" ", ""), a)
            
        if ra_valid:
            add_q(t, ra)
            
        if rt_valid and ra_valid:
            add_q(rt, ra)
            add_q(rt.replace(" ", ""), ra)
            
        return queries

    def run(self):
        try:
            cached_lyric = db.get_cached_lyrics(self.artist, self.title)
            if cached_lyric:
                self.lyrics_fetched.emit(cached_lyric, []) 
                return

            clean_title = re.sub(r'\(feat\..*?\)|\- Remastered.*|\- Live.*', '', self.title, flags=re.IGNORECASE).strip()
            best_lyric, options = None, []

            for qt, qa in self.generate_queries(clean_title, self.artist):
                best_lyric, options = self.search_lrclib(qt, qa)
                if best_lyric: break

            if not best_lyric:
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
                                for qt, qa in self.generate_queries(jp_title, jp_artist):
                                    best_lyric, options = self.search_lrclib(qt, qa)
                                    if best_lyric: break
                    
                    if not best_lyric:
                        fallback_lyric = syncedlyrics.search(f"{clean_title} {self.artist}", providers=["NetEase", "Megalobiz", "Musixmatch"])
                        if fallback_lyric:
                            best_lyric = fallback_lyric
                            options = [{'title': clean_title, 'artist': self.artist, 'lyrics': fallback_lyric}]

                except Exception as e:
                    logging.warning(f"iTunes/syncedlyrics API 請求失敗: {e}")

            if best_lyric and not cached_lyric:
                db.save_cached_lyrics(self.artist, self.title, best_lyric)
                self.lyrics_fetched.emit(best_lyric, options)
            elif options:
                self.lyrics_fetched.emit("OPTIONS_ONLY", options)
            else:
                self.lyrics_fetched.emit("", []) 
                
        except Exception as e: 
            logging.error(f"歌詞抓取例外錯誤: {e}")
            self.lyrics_fetched.emit("", [])

    def search_lrclib(self, target_title, target_artist):
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
                            score += 100
                            
                        # Penalize translation or romanized versions
                        penalty_keywords = ['translated', 'translation', 'romanized', '翻譯', '中文版', 'english version']
                        if any(kw in item_title for kw in penalty_keywords):
                            score -= 800
                        if any(kw in item['album'].lower() for kw in penalty_keywords):
                            score -= 500
                            
                        # Penalize if lyrics text explicitly marks itself as translation or romanized
                        lower_lyrics = item['lyrics'].lower()
                        if 'english translation' in lower_lyrics or 'romanized' in lower_lyrics or 'translation by' in lower_lyrics:
                            score -= 800
                            
                        return score

                    valid_lyrics.sort(key=get_score, reverse=True)
                    return valid_lyrics[0]['lyrics'], valid_lyrics[:5]
        except Exception as e:
            logging.warning(f"LRCLIB API 請求失敗: {e}")
        return None, []
