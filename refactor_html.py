import os

def update_footer():
    with open('web-app/views/footer.ejs', 'r', encoding='utf-8') as f:
        content = f.read()

    player_bar_html = """
        <footer class="player-bar" id="player-bar">
            <div class="player-left">
                <img src="https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=300&auto=format&fit=crop" id="album-cover" alt="Cover" class="player-cover">
                <div class="player-info">
                    <div class="current-title" id="current-title">--</div>
                    <div class="current-artist" id="current-artist">--</div>
                </div>
            </div>
            <div class="player-center">
                <div class="player-controls">
                    <button class="media-btn" onclick="mediaAction('prev')"><i class="fa-solid fa-backward-step"></i></button>
                    <button class="media-btn play-pause-btn" onclick="mediaAction('playpause')"><i class="fa-solid fa-play" id="play-pause-icon"></i></button>
                    <button class="media-btn" onclick="mediaAction('next')"><i class="fa-solid fa-forward-step"></i></button>
                </div>
                <div class="progress-container">
                    <span class="time-label" id="current-time">0:00</span>
                    <div class="slider-wrapper">
                        <input type="range" id="progress-slider" min="0" max="100" value="0">
                        <div class="progress-bar-fill" id="progress-fill"></div>
                    </div>
                </div>
            </div>
            <div class="player-right">
                <button id="toggle-ruby-mode-btn" class="ctrl-btn" onclick="toggleRubyEditMode()" title="編輯假名模式"><i class="fa-solid fa-pen"></i></button>
                <button class="ctrl-btn" onclick="openLyricsModal()" title="取得備選歌詞"><i class="fa-solid fa-list"></i></button>
                <button class="ctrl-btn" onclick="reloadCurrentLyrics()" title="重新載入歌詞"><i class="fa-solid fa-rotate"></i></button>
            </div>
        </footer>
"""
    # Insert player_bar before the last </div> of app-container
    # <main></div> ends at line 3.
    content = content.replace("</main>\n    </div>", "</main>\n" + player_bar_html + "    </div>")

    with open('web-app/views/footer.ejs', 'w', encoding='utf-8') as f:
        f.write(content)

def update_index():
    with open('web-app/views/index.ejs', 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # We need to remove player-upper and the buttons in lyrics-header that are now in player bar.
    # Actually, let's just rewrite index.ejs completely since it's much simpler now.
    
    new_index = """<%- include('header') %>

<div class="page-header animate-fade-in" style="margin-bottom: 10px;">
    <div style="display: flex; align-items: center; gap: 20px;">
        <div class="status-banner" style="margin-bottom: 0; padding: 6px 12px; background: transparent; border: 1px solid var(--panel-border);">
            <div class="pulsing-dot" id="sync-dot"></div>
            <span id="sync-status-text">正在等待系統音樂播放...</span>
        </div>
    </div>
    
    <!-- Mode Switcher -->
    <div class="mode-tabs" style="display: flex; align-items: center; gap: 10px;">
        <span style="font-weight: bold; font-size: 14px; color: var(--text-secondary);">桌面靈動島</span>
        <label class="toggle-switch" style="margin-bottom: 0;">
            <input type="checkbox" id="desktop-toggle-btn" onchange="launchPyQt6()">
            <span class="slider round"></span>
        </label>
        <button class="fullscreen-btn" onclick="toggleFullscreen()" title="視窗放大模式" style="background:transparent; color:var(--text-secondary); border:none; cursor:pointer;">
            <i class="fa-solid fa-expand icon-expand"></i>
            <i class="fa-solid fa-compress icon-compress"></i>
        </button>
    </div>
</div>

<!-- Toast Notification -->
<div id="toast" class="toast hidden">
    <i id="toast-icon" class="fa-solid fa-circle-info"></i>
    <span id="toast-message"></span>
</div>

<!-- ================= 網頁版即時監控 ================= -->
<div id="web-mode-sec" class="mode-section animate-fade-in" style="display: flex; flex-direction: column; flex: 1; height: 100%;">
    <!-- 滾動歌詞面板 -->
    <div class="lyrics-view-container" style="display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative;">
        <div class="lyrics-scroll-pane" id="lyrics-scroll" style="flex: 1; font-size: 24px; min-height: 0; padding-bottom: 100px;">
            <div class="lyrics-empty" id="lyrics-placeholder">
                <i class="fa-solid fa-music"></i>
                <p>等待播放...</p>
            </div>
        </div>
        
        <!-- Resume Sync Button -->
        <div id="sync-resume-panel" class="sync-resume-panel" style="display: none;">
            <button onclick="resumeSync()" title="恢復同步">
                <i class="fa-solid fa-location-arrow"></i> 恢復同步
            </button>
        </div>
    </div>
</div>

<!-- Modals -->
<%- include('modals/lyrics-options') %>
<%- include('modals/ruby-edit') %>

<%- include('footer') %>
"""
    with open('web-app/views/index.ejs', 'w', encoding='utf-8') as f:
        f.write(new_index)

if __name__ == "__main__":
    update_footer()
    update_index()
