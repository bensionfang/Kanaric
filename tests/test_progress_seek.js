const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..', 'web-app');
const footer = fs.readFileSync(path.join(root, 'views', 'footer.ejs'), 'utf8');
const slider = footer.split(/\r?\n/).find(line => line.includes('id="progress-slider"'))?.trim()
    .replace('value="<%= pct %>"', 'value="0"');
assert.ok(slider, 'progress slider exists');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 600, height: 180 });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<style>' + css + '</style><div class="slider-wrapper" ' +
        'style="position:absolute;left:20px;top:60px;width:400px;height:4px">' +
        slider + '</div>'
    ));
    const rect = await win.webContents.executeJavaScript(
        'JSON.stringify(document.querySelector(".slider-wrapper").getBoundingClientRect())'
    ).then(JSON.parse);
    for (const percent of [7.5, 25.25, 50, 74.75, 92.5]) {
        const x = Math.round(rect.left + rect.width * percent / 100);
        const y = Math.round(rect.top + rect.height / 2);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 30));
        const actual = await win.webContents.executeJavaScript(
            'Number(document.getElementById("progress-slider").value)'
        );
        assert.ok(Math.abs(actual - percent) <= 0.02,
            `hover ${percent}% clicked ${actual}%`);
    }
    console.log('progress slider: hover position matches native click');
    app.quit();
}).catch((error) => {
    console.error(error);
    app.exit(1);
});