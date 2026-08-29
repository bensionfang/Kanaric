'use strict';

const fs = require('node:fs');
const http = require('node:http');

const file = process.env.FIXTURE_PATH;
const port = Number(process.env.FIXTURE_PORT);
const size = fs.statSync(file).size;

http.createServer((req, res) => {
    if (req.url !== '/fixture.m4a') {
        res.writeHead(404);
        res.end();
        return;
    }
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
        if (range[1]) start = Number(range[1]);
        if (range[2]) end = Number(range[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return;
        }
        end = Math.min(end, size - 1);
    }
    const partial = !!range;
    const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'audio/mp4',
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method !== 'HEAD') fs.createReadStream(file, { start, end }).pipe(res);
    else res.end();
}).listen(port, '127.0.0.1');
