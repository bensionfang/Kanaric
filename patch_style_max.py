import re

with open('web-app/public/css/style.css', 'r', encoding='utf-8') as f:
    text = f.read()

max_css = """
/* Window Maximized Immersive Mode */
body.window-maximized .sidebar,
body.window-maximized .top-bar,
body.window-maximized .page-header {
    display: none !important;
}

body.window-maximized .main-content {
    margin-left: 0 !important;
    padding: 0 !important;
}

body.window-maximized #web-mode-sec {
    animation: none !important;
    transform: none !important;
}

body.window-maximized .player-lyrics-card {
    background: var(--bg-main) !important;
    border: none !important;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    gap: 0;
    height: 100vh;
    max-width: 100% !important;
    border-radius: 0;
}

body.window-maximized .player-upper {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 15px 120px 15px 30px;
    gap: 20px;
    background: rgba(0,0,0,0.2);
    border-bottom: 1px solid var(--panel-border);
    position: relative;
}

body.window-maximized .vinyl-container {
    width: 60px;
    height: 60px;
    margin: 0;
}

body.window-maximized .vinyl-center {
    width: 15px;
    height: 15px;
}

body.window-maximized .player-controls-pane {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 30px;
    flex: 1;
    margin: 0;
}

body.window-maximized .current-title {
    font-size: 20px;
    margin: 0;
}

body.window-maximized .current-artist {
    font-size: 14px;
    margin: 0;
    opacity: 0.8;
}

body.window-maximized .progress-container {
    flex: 1;
    margin: 0;
}

body.window-maximized .lyrics-header h4 {
    display: none;
}

body.window-maximized .lyrics-header {
    margin: 0;
    padding: 0;
    height: 0;
    border: none;
    overflow: visible;
}

body.window-maximized .lyrics-header > div {
    position: absolute;
    top: 15px;
    right: 30px;
    z-index: 10000;
    flex-direction: column !important;
    gap: 6px !important;
}

body.window-maximized .lyrics-header .advanced-lyrics-btn {
    display: none !important;
}

body.window-maximized .lyrics-header .fullscreen-btn,
body.window-maximized .lyrics-header .reload-lyrics-btn {
    padding: 6px 12px !important;
    font-size: 12px !important;
    width: 100%;
    justify-content: center;
}

body.window-maximized .lyrics-view-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

body.window-maximized .lyrics-scroll-pane {
    flex: 1;
    height: auto !important;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 30px 60px;
    position: relative;
}

body.window-maximized .lyrics-line {
    font-size: calc(var(--lyrics-fs, 22px) + 8px);
}

body.window-maximized .lyrics-line.active {
    font-size: calc(var(--lyrics-fs, 22px) + 12px);
}

body.window-maximized .lyrics-line rt { 
    font-size: 0.5em !important; 
    line-height: 1; 
}

body.window-maximized .lyrics-scroll-pane.pure-text-mode .lyrics-line { 
    font-size: calc(var(--lyrics-fs, 22px) + 16px) !important; 
    font-weight: 600 !important; 
    color: var(--text-primary) !important; 
}
"""

if "Window Maximized Immersive Mode" not in text:
    text += "\n" + max_css

with open('web-app/public/css/style.css', 'w', encoding='utf-8') as f:
    f.write(text)
print("SUCCESS!")
