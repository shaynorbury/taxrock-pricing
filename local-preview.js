// Local preview only. Serves /public with the login skipped so you can work on
// the page without signing in. NOT how the live site behaves.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    if (p === '/index.html') {
      data = Buffer.from(String(data).replace('window.__DEMO__ = false;', 'window.__DEMO__ = true;'));
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}).listen(8788, () => console.log('preview on http://localhost:8788'));
