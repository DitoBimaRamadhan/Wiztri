// TreeSize-like MVP — Node scan backend (FindFirstFile-style via fs.readdir)
// Interface: GET /api/scan?root=<path> -> nested JSON tree
// Rust/Tauri swap point: ganti handler ini, pertahankan shape response.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;

// Folder/file sistem Windows yang umumnya disembunyikan / terproteksi.
const HIDDEN = new Set([
  'System Volume Information', '$Recycle.Bin', 'AppData', 'WinSxS',
  '$MFT', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'Recovery',
  '$Extend', 'Config.Msi', 'DumpStack.log.tmp', 'Desktop.ini',
]);

async function scan(abs) {
  let entries;
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch {
    return { name: path.basename(abs) || abs, error: 'access_denied', size: 0, children: [] };
  }
  let size = 0;
  const children = [];
  const dirs = [];
  for (const d of entries) {
    const p = path.join(abs, d.name);
    if (d.isSymbolicLink()) {
      // Jangan ikuti symlink/junction -> cegah loop. Ukur metadata saja.
      try { const s = await fs.promises.lstat(p); children.push({ name: d.name, size: s.size, symlink: true }); size += s.size; } catch { /* skip */ }
      continue;
    }
    if (d.isDirectory()) { dirs.push(d); continue; }
    if (d.isFile()) {
      try {
        const s = await fs.promises.stat(p);
        children.push({ name: d.name, size: s.size, hidden: HIDDEN.has(d.name) });
        size += s.size;
      } catch { /* permission denied pada file -> skip */ }
    }
  }
  for (const d of dirs) {
    const sub = await scan(path.join(abs, d.name));
    sub.hidden = HIDDEN.has(d.name);
    size += sub.size || 0;
    children.push(sub);
  }
  children.sort((a, b) => (b.size || 0) - (a.size || 0));
  return { name: path.basename(abs) || abs, path: abs, size, children };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/scan') {
    const root = u.searchParams.get('root') || process.cwd();
    try {
      const t = await scan(root);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(t));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    }
    return;
  }
  // static
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUBLIC, p));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`TreeSize MVP -> http://localhost:${PORT}`));
