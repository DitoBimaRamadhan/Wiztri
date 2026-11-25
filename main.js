// Wiztri — Electron main process
// Mode scan: coba wiztri-scan.exe (MFT, cepat, butuh admin) -> jika gagal, fallback walk Node (Win32).
'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HIDDEN = new Set([
  'System Volume Information', '$Recycle.Bin', 'AppData', 'WinSxS',
  '$MFT', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'Recovery',
  '$Extend', 'Config.Msi', 'DumpStack.log.tmp', 'Desktop.ini',
]);

// Jalur MFT (Rust). return null bila tak tersedia / tak diizinkan.
// Streaming ke file temp (hindari maxBuffer) + ref child utk di-kill saat app tutup.
let childRef = null;
function tryMft(args) {
  const exe = path.join(process.resourcesPath, 'wiztri-scan.exe');
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), 'wiztri_mft_' + process.pid + '_' + Date.now() + '.json');
    const ws = fs.createWriteStream(tmp);
    ws.on('error', () => { try { child.kill(); } catch {} finish(null); }); // gagal tulis temp -> jangan gantung/biarkan orphan
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    childRef = child;
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      if (childRef === child) childRef = null;
      try { ws.destroy(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      resolve(val);
    };
    child.stdout.pipe(ws);
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      ws.end();
      ws.on('finish', () => {
        if (code !== 0) return finish(null);
        try {
          const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
          finish(!j || j.error ? null : j);
        } catch { finish(null); }
      });
    });
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
    t.unref();
  });
}

// Hitung total node (dir+file) di bawah root, termasuk root.
// Aturan sama dgn nodeScan: tak mengikuti symlink, depth cap 128,
// error akses diabaikan. Digunakan utk persentase progres.
async function countNodes(root, depth = 0) {
  if (depth > 128) return 1;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return 1;
  }
  let c = 1;
  for (const d of entries) {
    if (d.isSymbolicLink()) { c++; continue; }
    if (d.isDirectory()) {
      try { c += await countNodes(path.join(root, d.name), depth + 1); } catch { c++; }
    } else {
      c++;
    }
  }
  return c;
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

// MFT dipakai utk SEMUA jalur drive lokal (root drive maupun subfolder) —
// scanner Rust kini menerima arg ke-2 utk memotong tree volume ke subtree
// yang diminta. Ini mem-bypass ACL folder (System Volume Information,
// $Recycle.Bin, AppData pengguna lain, dll.) sehingga tak ada access_denied.
// Bila exe tak tersedia / tanpa admin (gagal), return null -> fallback Node walk.
function tryMftPath(root) {
  const m = /^([A-Za-z]):([\\\/].*)?$/.exec(root || '');
  if (!m) return Promise.resolve(null); // bukan jalur drive lokal -> fallback Node
  const drive = m[1].toUpperCase();
  const rest = m[2];
  const args = [drive];
  if (rest && !/^[\\\/]+$/.test(rest)) args.push(root.replace(/[\\\/]+$/, ''));
  return tryMft(args);
}

// ---------------------------------------------------------------------------
// Lazy scan: main selalu menahan tree PENUH di memori (cache per path), tetapi
// hanya mengirimkan "slice" kecil (ringkasan + anak LANGSUNG) ke renderer.
// Renderer memuat anak folder sesuai kebutuhan (expanding). Ini mencegah
// tree jutaan node dikirim utuh lewat IPC (structured clone) yang membuat
// renderer hang/OOM saat memindai root drive seperti C:\ / D:\.
// ---------------------------------------------------------------------------
const treeCache = new Map(); // path -> tree penuh berakar di path tsb

function makeSlice(node) {
  const base = node.path || '';
  const kids = (node.children || []).map((c) => ({
    name: c.name,
    path: c.path || (base + (base && base.slice(-1) !== '\\' ? '\\' : '') + c.name),
    size: c.size || 0,
    alloc: c.alloc ?? c.size ?? 0,
    dir: Array.isArray(c.children),
    symlink: !!c.symlink,
    hidden: !!c.hidden,
    error: c.error || undefined,
  }));
  return {
    name: node.name,
    path: base,
    size: node.size || 0,
    alloc: node.alloc ?? node.size ?? 0,
    dir: true,
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

// Coba layani slice dari cache — path sama atau subtree dari leluhur yang sudah dibangun.
function sliceFromCache(base) {
  const bb = base.toLowerCase();
  for (const [p, tree] of treeCache) {
    if (!p || typeof p !== 'string') continue;
    if (base === p) return makeSlice(tree);
    const pb = p.toLowerCase();
    if (bb.startsWith(pb)) {
      const rel = base.slice(p.length).split(/[\\\/]+/).filter(Boolean);
      const node = descend(tree, rel);
      if (node) { treeCache.set(base, node); return makeSlice(node); }
    }
  }
  return null;
}

ipcMain.handle('scan', async (_evt, root) => {
  const base = root || process.env.SYSTEMDRIVE || 'C:\\';
  const fromCache = sliceFromCache(base);
  if (fromCache) return fromCache;

  let full = null;
  const mft = await tryMftPath(base);
  if (mft && !mft.error) {
    full = mft;
  } else {
    // Fallback Node: prescan utk % progres, lalu walk penuh.
    const total = await countNodes(base);
    const state = { count: 1 }; // akar dihitung sekali; anak dihitung di nodeScan
    let lastSend = 0;
    const c = (count, dir) => {
      const now = Date.now();
      if (now - lastSend < 120) return; // throttle: maks ~8 event/detik
      lastSend = now;
      _evt.sender.send('scan-progress', { count, total, dir });
    };
    c(0, base);
    full = await nodeScan(base, c, state);
    // event akhir dikirim langsung tanpa throttle agar UI selalu sampai 100%
    _evt.sender.send('scan-progress', { count: state.count, total, dir: '' });
  }

  treeCache.set(base, full);
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

ipcMain.handle('list-drives', () => {
  const out = [];
  for (let i = 65; i <= 90; i++) { // A..Z
    const letter = String.fromCharCode(i);
    try { fs.statSync(letter + ':\\'); out.push(letter + ':'); } catch {}
  }
  return out;
});

ipcMain.handle('open-path', (_e, target) => {
  try {
    if (!target || typeof target !== 'string') return { ok: false };
    const st = fs.statSync(target);
    if (st.isDirectory()) { const err = shell.openPath(target); return { ok: !err }; }
    shell.showItemInFolder(target);
    return { ok: true };
  } catch { return { ok: false }; }
});

// Pastikan scanner anak ikut mati saat app tutup (cegah orphan pegang volume handle).
app.on('before-quit', () => {
  if (childRef && !childRef.killed) { try { childRef.kill(); } catch {} }
});
