import os
import re

def update_css():
    with open('web-app/public/css/style.css', 'r', encoding='utf-8') as f:
        content = f.read()

    # Define the new floating-panel Spotify grid
    spotify_grid_css = """
/* Layout Grid (New Spotify Floating Panels Style) */
.app-container { 
    display: grid;
    grid-template-areas: 
        "topbar topbar"
        "sidebar main"
        "player player";
    grid-template-columns: auto 1fr;
    grid-template-rows: 64px 1fr 90px;
    height: 100vh;
    overflow: hidden;
    background: #000000;
    gap: 8px;
    padding: 8px 8px 0 8px;
}

.app-container.collapsed-sidebar {
    grid-template-columns: 72px 1fr;
}

.sidebar {
    grid-area: sidebar;
    height: 100%;
    overflow-y: auto;
    border-right: none;
    background: #121212;
    border-radius: 8px;
    padding: 16px 12px;
}

.main-content {
    grid-area: main;
    height: 100%;
    overflow-y: auto;
    background: #121212;
    background-image: linear-gradient(to bottom, #1d4d4f 0%, #121212 300px); /* Teal gradient */
    border-radius: 8px;
    padding: 24px;
}

/* Hide old header */
.page-header {
    background: transparent !important;
    border: none !important;
}

/* Player Bar */
.player-bar {
    grid-area: player;
    background: #000000;
    border-top: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 8px;
    z-index: 100;
    margin: 0 -8px; /* Offset the container padding */
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

.current-title {
    font-size: 14px;
    font-weight: 500;
    color: #ffffff;
    margin-bottom: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.current-artist {
    font-size: 11px;
    color: #b3b3b3;
    font-weight: 400;
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

.play-pause-btn i {
    transform: translateX(1px); /* optical alignment for play icon */
}
.play-pause-btn .fa-pause {
    transform: translateX(0);
}

.play-pause-btn:hover {
    transform: scale(1.05);
    background: #ffffff;
    color: #000000;
}

.progress-container {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
}

.time-label {
    font-size: 11px;
    color: #a7a7a7;
    min-width: 32px;
    text-align: center;
}

.slider-wrapper {
    flex: 1;
    height: 4px;
    background: #4d4d4d;
    border-radius: 2px;
    position: relative;
    cursor: pointer;
}

.slider-wrapper:hover .progress-bar-fill {
    background: #1db954;
}

.slider-wrapper:hover .progress-bar-fill::after {
    content: '';
    position: absolute;
    right: -4px;
    top: -4px;
    width: 12px;
    height: 12px;
    background: #fff;
    border-radius: 50%;
}

.progress-bar-fill {
    height: 100%;
    background: #ffffff;
    border-radius: 2px;
    width: 0%;
    position: relative;
}

input[type="range"] {
    position: absolute;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    z-index: 2;
}

.player-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: 30%;
    min-width: 180px;
    gap: 16px;
}

.ctrl-btn {
    background: transparent;
    border: none;
    color: #b3b3b3;
    font-size: 14px;
    cursor: pointer;
}
.ctrl-btn:hover {
    color: #ffffff;
}
"""

    # Remove the old Spotify overrides we added earlier to replace them cleanly
    if "/* Layout Grid (Spotify Style) */" in content:
        content = content[:content.find("/* Layout Grid (Spotify Style) */")]

    with open('web-app/public/css/style.css', 'w', encoding='utf-8') as f:
        f.write(content.strip() + "\n\n" + spotify_grid_css)

if __name__ == "__main__":
    update_css()
