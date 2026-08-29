'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = process.env.KANARIC_ROOT;
const port = Number(process.env.HARNESS_PORT);
const fixture = process.env.FIXTURE_URL;
const playerSource = fs.readFileSync(path.join(root, 'web-app/public/js/karaoke-player.js'), 'utf8');
const clockSource = fs.readFileSync(path.join(root, 'web-app/public/js/karaoke-clock.js'), 'utf8');

const html = `<!doctype html>
<meta charset="utf-8">
<title>Task 4 runtime harness</title>
<style>body{font:14px monospace;background:#111;color:#eee;padding:16px}button{margin:3px;padding:7px}pre{white-space:pre-wrap;max-width:1100px}</style>
<audio id="audio" preload="auto"></audio>
<div id="buttons"></div>
<pre id="state"></pre>
<script src="/player.js"></script><script src="/clock.js"></script>
<script>
(() => {
  const audio = document.getElementById('audio');
  const player = new KanaricKaraokePlayer.BrowserAudioKaraokePlayer(audio);
  const clock = new KanaricKaraokeClock.KaraokeClock();
  const ws = new WebSocket('ws://127.0.0.1:__SERVER_PORT__');
  const song = {id:'task4-local-fixture', title:'Task 4 local fixture', artist:'Kanaric runtime'};
  const lines = [{time:0,text:'fixture line one'},{time:10,text:'fixture line two'},{time:30,text:'fixture line three'}];
  const trace = [];
  let latest = null;
  let metadataEvent = null;
  let loadSent = false;

  const add = (kind, value) => { trace.push({at:Date.now(),kind,value}); if (trace.length > 300) trace.shift(); render(); };
  const send = value => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
  const sendPlayer = event => { if (latest && latest.sessionId) send({type:'karaoke_player_event',sessionId:latest.sessionId,event:{...event,song}}); };
  const currentLine = positionMs => [...lines].reverse().find(line => positionMs >= line.time * 1000)?.text || '(before first line)';
  const render = () => {
    const snap = clock.snapshot();
    const state = latest ? latest.state : 'NO_SESSION';
    const canonical = latest ? latest.transport : null;
    document.getElementById('state').textContent = JSON.stringify({
      player: {state:player.getState(), positionMs:player.getPosition(), durationMs:player.getDuration()},
      session: latest ? {sessionId:latest.sessionId,revision:latest.revision,state:latest.state,song:latest.song,transport:latest.transport,queue:latest.queue} : null,
      stage: {state,positionMs:snap.positionMs,isPlaying:snap.isPlaying,displayedLine:currentLine(snap.positionMs)},
      lastEvent: trace[trace.length - 1] || null,
      recent: trace.slice(-12),
      traceCount: trace.length,
    }, null, 2);
  };
  const button = (name, action) => { const b=document.createElement('button'); b.textContent=name; b.onclick=action; document.getElementById('buttons').appendChild(b); };
  button('play', () => { add('command','play'); player.play(); });
  button('pause', () => { add('command','pause'); player.pause(); });
  button('seek', () => { add('command','seek 12345'); player.seek(12345); });
  button('restart', () => { add('command','restart'); player.restart(); });
  button('stop', () => { add('command','stop'); player.stop(); });
  button('load', () => { add('command','load'); player.load({src:'__FIXTURE_URL__',...song}); });
  button('ended', () => { add('command','ended'); player.seek(Math.max(0, player.getDuration() - 250)); player.play(); });
  button('skip', () => {
    add('command','skip');
    if (!latest) return;
    if (latest.state === 'ENDING') send({type:'karaoke_session_transition',sourceState:'ENDING',targetState:'TRANSITION',details:{event:'transition',hasNext:false}});
    else send({type:'karaoke_session_transition',sourceState:latest.state,targetState:'ENDING',details:{event:'skip'}});
  });
  button('output capability', async () => {
    let result = {setSinkId:typeof audio.setSinkId,devices:[]};
    try { result.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput').map(d=>({deviceId:d.deviceId,label:d.label})); } catch(e) { result.enumerateError=String(e); }
    if (typeof audio.setSinkId === 'function') { try { result.defaultSelection=await player.setOutputDevice('default'); } catch(e) { result.defaultError=String(e); } }
    add('output', result);
  });

  ws.onopen = () => { add('ws','open'); send({type:'karaoke_role',role:'stage'}); };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'karaoke_session' || message.type === 'karaoke_session_result') {
      if (message.state) {
        latest = message.state;
        const projected = KanaricKaraokeClock.sessionStateToEvent(message.state);
        const applied = clock.apply(projected);
        add('session', {type:message.type,accepted:message.accepted,reason:message.reason,sessionId:message.sessionId,revision:message.revision,state:message.state.state,transport:message.state.transport,clockAccepted:applied.accepted});
        if (message.state.state === 'PREPARING' && metadataEvent && !loadSent) {
          loadSent = true;
          sendPlayer({...metadataEvent,song});
          add('player-send','load');
        }
      }
    }
    render();
  };
  ws.onerror = error => add('ws-error',String(error));
  player.on(event => {
    add('player',event);
    if (event.type === 'load') {
      if (event.durationMs > 0) {
        metadataEvent = event;
        song.durationMs = event.durationMs;
        if (!latest || latest.state === 'IDLE') send({type:'karaoke_session_transition',sourceState:'IDLE',targetState:'PREPARING',details:{song}});
      }
      return;
    }
    sendPlayer(event);
  });
  player.load({src:'__FIXTURE_URL__',...song});
  setInterval(render, 100);
  render();
})();
</script>`
  .replaceAll('__SERVER_PORT__', String(process.env.SERVER_PORT))
  .replaceAll('__FIXTURE_URL__', fixture);

http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(html);
        return;
    }
    if (req.url === '/player.js') {
        res.writeHead(200, {'Content-Type':'application/javascript'});
        res.end(playerSource);
        return;
    }
    if (req.url === '/clock.js') {
        res.writeHead(200, {'Content-Type':'application/javascript'});
        res.end(clockSource);
        return;
    }
    res.writeHead(404);
    res.end();
}).listen(port, '127.0.0.1');
