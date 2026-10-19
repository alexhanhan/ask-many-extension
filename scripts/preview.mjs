import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const root = path.resolve(import.meta.dirname, '../extension');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const publicFiles = new Set(['manager.html', 'popup.html', 'collect.html', 'popup-bootstrap.js', 'page-state.js', 'app.js', 'styles.css', 'core.js', 'native-flow.js', 'organizer-core.js', 'organizer.js', 'organizer-ui.js', 'demo.js', 'background.js', 'manifest.json', ...[16, 32, 48, 128].map(size => `icons/icon${size}.png`)]);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/manager.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (!publicFiles.has(path.relative(root, file).replaceAll('\\', '/'))) { res.writeHead(403); return res.end('Not public'); }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(4317, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4317 (sample data only)'));
