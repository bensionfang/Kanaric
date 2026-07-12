import os

def update_css():
    with open('web-app/public/css/style.css', 'r', encoding='utf-8') as f:
        content = f.read()

    # Define Spotify grid
    spotify_grid_css = """
/* Layout Grid (Spotify Style) */
.app-container { 
    display: grid;
    grid-template-areas: 
        "sidebar main"
        "player player";
    grid-template-columns: 260px 1fr;
    grid-template-rows: 1fr 90px;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-main);
}

.app-container.collapsed-sidebar {
    grid-template-columns: 76px 1fr;
}

.sidebar {
    grid-area: sidebar;
    height: 100%;
    overflow-y: auto;
    border-right: none;
    background: #000000;
}

.main-content {
    grid-area: main;
    height: 100%;
    overflow-y: auto;
    background: #121212;
    padding: 20px;
}

/* Player Bar */
.player-bar {
    grid-area: player;
    background: #181818;
    border-top: 1px solid #282828;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 16px;
    z-index: 100;
}

.player-left {
    display: flex;
    align-items: center;
    width: 30%;
    min-width: 180px;
}

.player-cover {
    width: 56px;
    height: 56px;
    border-radius: 4px;
    margin-right: 14px;
    object-fit: cover;
}

.player-info {
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.player-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 40%;
    max-width: 722px;
}

.player-controls {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-bottom: 8px;
}

.media-btn {
    background: transparent;
    border: none;
    color: #b3b3b3;
    font-size: 16px;
    cursor: pointer;
    transition: color 0.2s, transform 0.2s;
}

.media-btn:hover {
    color: #ffffff;
}

.play-pause-btn {
    background: #ffffff;
    color: #000000;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
}

.play-pause-btn:hover {
    transform: scale(1.05);
    background: #ffffff;
    color: #000000;
}

.player-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: 30%;
    min-width: 180px;
    gap: 16px;
}

/* Spotify dark theme variables overwrite */
:root {
    --bg-main: #121212;
    --bg-gradient: #121212;
    --sidebar-bg: #000000;
    --panel-bg: #181818;
    --panel-border: #282828;
    --text-primary: #ffffff;
    --text-secondary: #b3b3b3;
}
"""

    import re
    # Remove old .app-container
    content = re.sub(r'\.app-container\s*\{[^}]*\}', '', content)
    # Remove old .sidebar layout properties but keep inner stuff
    # Actually it's better to just append our overrides at the end!
    
    with open('web-app/public/css/style.css', 'a', encoding='utf-8') as f:
        f.write("\n" + spotify_grid_css)

if __name__ == "__main__":
    update_css()
