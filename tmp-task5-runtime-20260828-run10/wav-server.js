'use strict';

const http = require('node:http');

const sampleRate = 8000;
const seconds = 120;
const dataSize = sampleRate * 2 * seconds;
const wav = Buffer.alloc(44 + dataSize);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataSize, 40);

http.createServer((req, res) => {
    if (req.url !== '/fixture.wav') {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': wav.length,
        'Content-Type': 'audio/wav',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(wav);
}).listen(Number(process.env.FIXTURE_PORT), '127.0.0.1');
