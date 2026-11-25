// Wiztri — Electron main process
// Mode scan: coba wiztri-scan.exe (MFT, cepat, butuh admin) -> jika gagal, fallback walk Node (Win32).
'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HIDDEN = new Set([
  'System Volume Information', '$Recycle.Bin', 'AppData', 'WinSxS',
  '$MFT', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'Recovery',
  '$Extend', 'Config.Msi', 'DumpStack.log.tmp', 'Desktop.ini',
]);

// Juru layan MFT persisten (Rust). Satu proses baca $MFT SEKALI per drive,
// lalu melayani banyak query subtree lewat stdin/stdout. Menghapus rescan
// volume penuh utk tiap ekspansi folder (P1), memberi progres nyata (P2),
// dan meniadakan race temp-file (F3).
let server = null;
// Lokasi exe scanner: utamakan bundel (resourcesPath), lalu target build lokal
// (dev). return null bila tak ada -> fallback Node walk.
function scannerExe() {
  const cands = [
    path.join(process.resourcesPath, 'wiztri-scan.exe'),
    path.join(__dirname, 'rust-scanner', 'target', 'release', 'wiztri-scan.exe'),
    path.join(__dirname, 'rust-scanner', 'target', 'x86_64-pc-windows-gnu', 'release', 'wiztri-scan.exe'),
    path.join(__dirname, 'rust-scanner', 'target', 'debug', 'wiztri-scan.exe'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}
function ensureServer(drive) {
  if (server && server.drive === drive && !server.child.killed) return Promise.resolve(server);
  if (server) { try { server.child.kill(); } catch {} server = null; }
  const exe = scannerExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, ['--serve', drive], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    const readers = [];
    const svc = { drive, child, readers, onProgress: null, dead: false };
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const len = Number(buf.slice(0, nl).toString('utf8'));
        if (!Number.isFinite(len) || len < 0) { buf = buf.slice(nl + 1); continue; }
        if (buf.length < nl + 1 + len) break;
        const body = buf.slice(nl + 1, nl + 1 + len).toString('utf8');
        buf = buf.slice(nl + 1 + len);
        const q = readers.shift();
        if (q) q(body);
      }
    });
    child.stderr.on('data', (d) => {
      if (!svc.onProgress) return;
      for (const m of d.toString('utf8').matchAll(/P (\d+) (\d+)/g)) {
        svc.onProgress(parseInt(m[1], 10), parseInt(m[2], 10));
      }
    });
    const failAll = () => {
      svc.dead = true;
      while (readers.length) { const q = readers.shift(); if (q) q(null); }
    };
    child.on('error', failAll);
    child.on('close', failAll);
    server = svc;
    resolve(svc);
  });
}

function serverQuery(svc, line) {
  if (svc.dead || svc.child.killed || svc.child.exitCode != null) return Promise.resolve(null);
  return new Promise((resolve) => {
    svc.readers.push(resolve);
    svc.child.stdin.write(line + '\n');
  });
}

// Coba layani scan via server MFT persisten. return null bila tak tersedia /
// gagal / path bukan drive lokal -> pemanggil fallback ke Node walk.
async function tryMftServe(root, onProgress) {
  const m = /^([A-Za-z]):([\\\/].*)?$/.exec(root || '');
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const svc = await ensureServer(drive);
  if (!svc || svc.dead) return null;
  svc.onProgress = onProgress;
  try {
    const rest = m[2];
    const req = rest && !/^[\\\/]+$/.test(rest) ? root.replace(/[\\\/]+$/, '') : '-'; // '-' = akar volume
    const raw = await serverQuery(svc, req);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (!j || j.error) ? null : j;
  } catch { return null; }
  finally { svc.onProgress = null; }
}

async function nodeScan(root, onProgress, state, depth = 0) {
  if (depth > 128) return { name: path.basename(root) || root, path: root, size: 0, children: [] }; // ponytail: depth cap 128, increase if deeper nesting required
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { name: path.basename(root) || root, path: root, error: 'access_denied', size: 0, children: [] };
  }
  let size = 0;
  const children = [];
  let idx = 0;
  const workers = Array(Math.min(32, entries.length)).fill(0).map(async () => {
    while (idx < entries.length) {
      const d = entries[idx++];
      state.count++;
      if (state.count % 1024 === 0 && onProgress) onProgress(state.count, root);
      const p = path.join(root, d.name);
      if (d.isSymbolicLink()) {
        try { const s = await fs.promises.lstat(p); children.push({ name: d.name, size: s.size, symlink: true }); size += s.size; } catch {}
      } else if (d.isDirectory()) {
        try {
          const sub = await nodeScan(p, onProgress, state, depth + 1);
          sub.hidden = HIDDEN.has(d.name);
          size += sub.size || 0;
          children.push(sub);
        } catch {}
      } else if (d.isFile()) {
        try {
          const s = await fs.promises.stat(p);
          children.push({ name: d.name, size: s.size, hidden: HIDDEN.has(d.name) });
          size += s.size;
        } catch {}
      }
    }
  });
  await Promise.all(workers);
  children.sort((a, b) => (b.size || 0) - (a.size || 0));
  return { name: path.basename(root) || root, path: root, size, children };
}

// ---------------------------------------------------------------------------
// Lazy scan: main selalu menahan tree PENUH di memori (cache per path), tetapi
// hanya mengirimkan "slice" kecil (ringkasan + anak LANGSUNG) ke renderer.
// Renderer memuat anak folder sesuai kebutuhan (expanding). Ini mencegah
// tree jutaan node dikirim utuh lewat IPC (structured clone) yang membuat
// renderer hang/OOM saat memindai root drive seperti C:\ / D:\.
// ---------------------------------------------------------------------------
const treeCache = new Map(); // path -> tree penuh berakar di path tsb
const TREE_CACHE_MAX = 4; // batas entri (LRU) — cegah memori tumbuh tanpa batas

function makeSlice(node) {
  const base = node.path || '';
  const kids = (node.children || []).map((c) => ({
    name: c.name,
    path: c.path || (base + (base && base.slice(-1) !== '\\' ? '\\' : '') + c.name),
    size: c.size || 0,
    alloc: c.alloc ?? c.size ?? 0,
    dir: Array.isArray(c.children),
    symlink: !!c.symlink,
    // MFT tak menandai hidden -> tandai di sini agar konsisten dgn mode Node.
    hidden: !!c.hidden || HIDDEN.has(c.name),
    error: c.error || undefined,
  }));
  return {
    name: node.name,
    path: base,
    size: node.size || 0,
    alloc: node.alloc ?? node.size ?? 0,
    dir: true,
    note: node.note,
    children: kids,
  };
}

// Turun dari tree cache mengikuti komponen relatif (case-insensitive).
function descend(tree, parts) {
  let cur = tree;
  for (const p of parts) {
    const kid = (cur.children || []).find(
      (c) => Array.isArray(c.children) && c.name.toLowerCase() === p.toLowerCase()
    );
    if (!kid) return null;
    cur = kid;
  }
  return cur;
}

// Batas komponen path: "C:\Users" harus TIDAK cocok dgn "C:\UsersData".
function atBoundary(s, i) { return i >= s.length || s[i] === '\\' || s[i] === '/'; }

function cacheSet(p, tree) {
  treeCache.set(p, tree);
  // LRU: pindahkan ke akhir; buang entri tertua bila melebihi batas.
  if (treeCache.size > TREE_CACHE_MAX) {
    const oldest = treeCache.keys().next().value;
    if (oldest !== undefined) treeCache.delete(oldest);
  }
}

// Coba layani slice dari cache — path sama atau subtree dari leluhur yang sudah dibangun.
function sliceFromCache(base) {
  const bb = base.toLowerCase();
  for (const [p, tree] of treeCache) {
    if (!p || typeof p !== 'string') continue;
    if (base === p) { cacheSet(p, tree); return makeSlice(tree); } // sentuh -> segarkan LRU
    const pb = p.toLowerCase();
    if (bb.startsWith(pb) && atBoundary(bb, pb.length)) {
      const rel = base.slice(p.length).split(/[\\\/]+/).filter(Boolean);
      const node = descend(tree, rel);
      if (node) { cacheSet(base, node); return makeSlice(node); }
    }
  }
  return null;
}

// Serialisasi query scan (single-flight): satu query sekaligus supaya pipe
// server tidak korup dan hasil tidak tumpang-tindih.
let scanQueue = Promise.resolve();
function enqueue(fn) { const r = scanQueue.then(fn); scanQueue = r.catch(() => {}); return r; }

ipcMain.handle('scan', async (_evt, root) => {
  const base = root || process.env.SYSTEMDRIVE || 'C:\\';
  // Validasi: hanya jalur drive lokal (cegah UNC/SSRF & path di luar drive).
  if (!/^[A-Za-z]:([\\\/]|$)/.test(base)) return { name: base, path: base, size: 0, alloc: 0, dir: true, children: [], error: 'invalid_root' };
  const fromCache = sliceFromCache(base);
  if (fromCache) return fromCache;

  const runScan = async () => {
    let mft = null;
    try {
      mft = await tryMftServe(base, (count, total) => {
        _evt.sender.send('scan-progress', { count, total, dir: 'Reading $MFT…' });
      });
    } catch { mft = null; }
    if (mft) return mft;

    // Fallback Node single-pass (indeterminate progress). Tanpa prescan
    // terpisah (P3) — jumlah item dilaporkan seiring jalan.
    const state = { count: 1 };
    let lastSend = 0;
    const c = (count, dir) => {
      const now = Date.now();
      if (now - lastSend < 120) return; // throttle: maks ~8 event/detik
      lastSend = now;
      _evt.sender.send('scan-progress', { count, total: 0, dir });
    };
    c(0, base);
    const fullTree = await nodeScan(base, c, state);
    _evt.sender.send('scan-progress', { count: state.count, total: 0, dir: '' });
    return fullTree;
  };

  const full = await enqueue(runScan);
  cacheSet(base, full);
  return makeSlice(full);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Wiztri',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Daftar drive lokal (A:..Z: yang ada) — dipakai utk dropdown & validasi path.
function localDrives() {
  const out = [];
  for (let i = 65; i <= 90; i++) { // A..Z
    const letter = String.fromCharCode(i);
    try { fs.statSync(letter + ':\\'); out.push(letter + ':'); } catch {}
  }
  return out;
}

ipcMain.handle('list-drives', () => localDrives());

// Deteksi mode Administrator: probe folder terproteksi. ENOENT (folder tidak
// ada) -> anggap admin; EACCES/EPERM -> bukan admin (MFT akan gagal).
function isAdmin() {
  try { fs.readdirSync('C:\\System Volume Information'); return true; }
  catch (e) { return e.code !== 'ENOENT'; }
}
ipcMain.handle('is-admin', () => isAdmin());

ipcMain.handle('open-path', (_e, target) => {
  try {
    if (!target || typeof target !== 'string') return { ok: false };
    // Batasi ke drive lokal (cegah renderer membuka path sembarang / UNC).
    const ok = localDrives().some((d) => target.toUpperCase().startsWith(d.toUpperCase() + '\\') || target.toUpperCase() === d.toUpperCase());
    if (!ok) return { ok: false };
    const st = fs.statSync(target);
    if (st.isDirectory()) { const err = shell.openPath(target); return { ok: !err }; }
    shell.showItemInFolder(target);
    return { ok: true };
  } catch { return { ok: false }; }
});

// Pastikan server scanner ikut mati saat app tutup (cegah orphan pegang volume handle).
app.on('before-quit', () => {
  if (server && !server.child.killed) { try { server.child.kill(); } catch {} }
});
