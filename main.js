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
  if (server && server.drive === drive && !server.child.killed && !server.dead) return Promise.resolve(server);
  if (server) { try { server.child.kill(); } catch {} server = null; }
  const exe = scannerExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, ['--serve', drive], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const readers = [];
    const svc = { drive, child, readers, onProgress: null, dead: false };
    const failAll = () => {
      svc.dead = true;
      while (readers.length) { const q = readers.shift(); if (q) q(null); }
    };
    let pend = [];       // fragmen stdout belum terproses
    let want = 0;        // byte body tersisa yang ditunggu (0 = sedang cari baris panjang)
    child.stdout.on('data', (d) => {
      pend.push(d);
      for (;;) {
        if (want === 0) {
          const all = pend.length === 1 ? pend[0] : Buffer.concat(pend);
          pend.length = 0;
          const nl = all.indexOf(0x0a);
          if (nl < 0) { pend.push(all); break; } // baris panjang belum lengkap
          const len = Number(all.slice(0, nl).toString('utf8'));
          if (!Number.isFinite(len) || len < 0) break; // sampah -> buang
          if (len > (1 << 30)) break; // bounding anti-OOM
          const rest = all.subarray(nl + 1);
          if (rest.length) pend.push(rest);
          want = len;
          if (want === 0) { const q = readers.shift(); if (q) q(''); continue; }
          continue;
        }
        const have = pend.reduce((s, b) => s + b.length, 0);
        if (have < want) break;
        const body = Buffer.concat(pend, want).toString('utf8');
        const extra = Buffer.concat(pend);
        pend.length = 0;
        const left = extra.subarray(want);
        if (left.length) pend.push(left);
        want = 0;
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
    child.on('error', failAll);
    child.on('close', failAll);
    child.stdin.on('error', failAll); // EPIPE saat child mati antre tulis -> jangan crash main
    server = svc;
    resolve(svc);
  });
}

// Timeout watchdog per query: bila scanner tak menjawab dalam QUERY_TIMEOUT_MS
// (mis. drive dicabut di tengah baca $MFT / geometri patologis), resolve null
// dan bunuh server (readers di-drain) — cegah scan menggantung selamanya.
// Timeout lebih longgar utk query full (limit=0) yang bisa menghasilkan respon
// besar, agar watchdog tidak false-fire pada volume raksasa.
const QUERY_TIMEOUT_MS = 30000;
const QUERY_TIMEOUT_FULL_MS = 120000;
function serverQuery(svc, line, isFull = false) {
  if (svc.dead || svc.child.killed || svc.child.exitCode != null) return Promise.resolve(null);
  const timeoutMs = isFull ? QUERY_TIMEOUT_FULL_MS : QUERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      svc.dead = true;
      try { svc.child.kill(); } catch {}
      // failAll (close/error) akan mengalirkan semua reader -> resolve(null).
    }, timeoutMs);
    // Wrapper: clear timer saat resolve (cegah timeout palsu membunuh server
    // setelah query sukses — timer harus di-clear, bukan dibiarkan menembak).
    const done = (v) => { clearTimeout(timer); resolve(v); };
    svc.readers.push(done);
    svc.child.stdin.write(line + '\n');
  });
}

// Coba layani scan via server MFT persisten. return null bila tak tersedia /
// gagal / path bukan drive lokal -> pemanggil fallback ke Node walk.
// `limit` (>0) membatasi jumlah anak per level yang dikirim (slice cepat utk
// tampilan awal); 0 = full tree.
async function tryMftServe(root, onProgress, limit = 0) {
  const m = /^([A-Za-z]):([\\\/].*)?$/.exec(root || '');
  if (!m) return null;
  const drive = m[1].toUpperCase();
  const svc = await ensureServer(drive);
  if (!svc || svc.dead) return null;
  const prevProgress = svc.onProgress;
  svc.onProgress = onProgress;
  try {
    const rest = m[2];
    let req = rest && !/^[\\\/]+$/.test(rest) ? root.replace(/[\\\/]+$/, '') : '-'; // '-' = akar volume
    // Delimiter TAB (dilarang di nama NTFS): path ber-spasi/berakhiran angka
    // tidak ambigu. Limit selalu dikirim eksplisit.
    const line = req + '\t' + limit;
    const raw = await serverQuery(svc, line, limit === 0);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (!j || j.error) ? null : j;
  } catch { return null; }
  finally { svc.onProgress = prevProgress; } // pulihkan cb sebelumnya (jangan null-kan punya scan lain)
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

// Cap anak per slice: cegah payload IPC raksasa + array penuh di state renderer
// untuk folder padat (mis. WinSxS ratusan ribu entri). Renderer tetap meng-`
// folder via scan(path) sendiri; cap hanya membatasi jumlah anak langsung yang
// dikirim sekaligus. Bila terpotong, tandai `truncated`.
const SLICE_CHILD_CAP = 2000;
function makeSlice(node, full = false) {
  const base = node.path || '';
  const allKids = node.children || [];
  // Bila `full` (expand subfolder): jangan cap — kirim semua anak agar data
  // tidak hilang senyap. Root scan (full=false): cap utk cegah payload raksasa.
  const cap = full ? Infinity : SLICE_CHILD_CAP;
  const truncated = allKids.length > cap;
  const kids = allKids.slice(0, cap).map((c) => ({
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
    engine: node._engine || 'node',
    children: kids,
    truncated: truncated || undefined,
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

// Normalisasi akar drive: "C:" -> "C:\". Cache key & node.path bisa beda
// (CacheFT root emit "C:" sedangkan renderer default "C:\"), jadi samakan di
// lookup agar All Files & slice cache cocok.
function normDrive(p) { return typeof p === 'string' && /^[A-Za-z]:$/.test(p) ? p + '\\' : p; }

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
  base = normDrive(base);
  const bb = base.toLowerCase();
  for (const [p, tree] of treeCache) {
    if (!p || typeof p !== 'string') continue;
    if (base === p) { cacheSet(p, tree); return makeSlice(tree); } // sentuh -> segarkan LRU
    const pb = p.toLowerCase();
    if (bb.startsWith(pb) && atBoundary(bb, pb.length)) {
      const rel = base.slice(p.length).split(/[\\\/]+/).filter(Boolean);
      const node = descend(tree, rel);
      if (node) {
        node.path = base;
        // Propagasikan penanda capped dr leluhur: subtree dari tree MFT capped
        // TIDAK lengkap; fullNodeFor harus tahu agar flatten "All Files" tidak
        // anggap penuh (dan memotong senyap).
        if (tree && tree._capped) node._capped = true;
        cacheSet(base, node);
        return makeSlice(node);
      }
    }
  }
  return null;
}

// Serialisasi query scan (single-flight): satu query sekaligus supaya pipe
// server tidak korup dan hasil tidak tumpang-tindih.
let scanQueue = Promise.resolve();
function enqueue(fn) { const r = scanQueue.then(fn); scanQueue = r.catch(() => {}); return r; }

ipcMain.handle('scan', async (_evt, root, opts) => {
  if (!trustedSender(_evt)) return { name: '', path: '', size: 0, alloc: 0, dir: true, children: [], error: 'untrusted' };
  const base = root || process.env.SYSTEMDRIVE || 'C:\\';
  // `full` (dari expand subfolder) minta tree penuh (limit=0) — tidak di-cap,
  // agar data >2000 anak tetap tampil. Root scan default: slice capped cepat.
  // Normalisasi ketat: hanya boolean `true` dianggap full (cegah truthy sembarang).
  const full = !!(opts && opts.full === true);
  // Validasi: hanya jalur drive lokal (cegah UNC/SSRF & path di luar drive).
  if (!/^[A-Za-z]:([\\\/]|$)/.test(base)) return { name: base, path: base, size: 0, alloc: 0, dir: true, children: [], error: 'invalid_root' };
  const fromCache = full ? null : sliceFromCache(base);
  if (fromCache) return fromCache;

  const runScan = async () => {
    let mft = null;
    let mftLast = 0;
    try {
      // Root scan: slice CAPPED (max 2000 anak/level) utk tampilan awal cepat.
      // Expand subfolder (`full`): minta tree penuh (limit=0) agar data tidak
      // hilang senyap. Tree penuh selalu tersedia via server.
      const limit = full ? 0 : 2000;
      mft = await tryMftServe(base, (count, total) => {
        const now = Date.now();
        if (now - mftLast < 120) return; // throttle: maks ~8 event/detik
        mftLast = now;
        if (!_evt.sender.isDestroyed()) _evt.sender.send('scan-progress', { count, total, dir: 'Reading $MFT…' });
      }, limit);
    } catch { mft = null; }
    if (mft) { mft._engine = 'mft'; if (!full) mft._capped = true; return mft; }

    // Fallback Node single-pass (indeterminate progress). Tanpa prescan
    // terpisah (P3) — jumlah item dilaporkan seiring jalan.
    const state = { count: 1 };
    let lastSend = 0;
    const c = (count, dir) => {
      const now = Date.now();
      if (now - lastSend < 120) return; // throttle: maks ~8 event/detik
      lastSend = now;
      if (!_evt.sender.isDestroyed()) _evt.sender.send('scan-progress', { count, total: 0, dir });
    };
    c(0, base);
    const fullTree = await nodeScan(base, c, state);
    if (!_evt.sender.isDestroyed()) _evt.sender.send('scan-progress', { count: state.count, total: 0, dir: '' });
    fullTree._engine = 'node';
    return fullTree;
  };

  const fullTree = await enqueue(runScan);
  cacheSet(base, fullTree);
  filesCache.clear(); // rescan -> snapshot "All Files" lama basi, bangun ulang
  return makeSlice(fullTree, full);
});

// Jendela utama — disimpan utk validasi sender IPC (hanya frame app sendiri).
let win = null;
// Hanya terima event dari webContents jendela utama (cegah konten asing yang
// mewarisi bridge preload memanggil channel IPC).
function trustedSender(evt) {
  return !!(win && !win.isDestroyed() && evt && evt.sender === win.webContents);
}

// Ikon aplikasi (title bar + taskbar Windows): ikon wizard yang disegar
// (gen_icon.ps1), bukan banner 2752x1536 dipaksa persegi.
// Ikon dibundel di public/ (ikut `files: public/**/*`), jadi tersedia saat runtime.
const appIcon = path.join(__dirname, 'public', 'icon.ico');
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Wiztri',
    icon: appIcon,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  // Kunci navigasi: hanya izinkan halaman app sendiri (public/index.html), tolak
  // window.open / navigasi ke file:// lain atau URL remote (cegah renderer
  // dibawa ke halaman yang mewarisi bridge preload).
  const appIndexUrl = require('url').pathToFileURL(path.join(__dirname, 'public', 'index.html')).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== appIndexUrl) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
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

ipcMain.handle('list-drives', (evt) => trustedSender(evt) ? localDrives() : []);

// Deteksi mode Administrator: coba buka raw volume \\.\C: — persis yang
// dilakukan scanner MFT. Berhasil -> admin (MFT bisa jalan); gagal -> bukan.
function isAdmin() {
  try { const fd = fs.openSync('\\\\.\\C:', 'r'); fs.closeSync(fd); return true; }
  catch { return false; }
}
ipcMain.handle('is-admin', (evt) => trustedSender(evt) && isAdmin());

// Relaunch sebagai Administrator (UAC prompt), lalu tutup sesi non-admin.
// Hindari interpolasi path ke string PowerShell (rapuh saat path berisi kutip);
// pakai -EncodedCommand base64 UTF-16LE sehingga zero quoting.
ipcMain.handle('relaunch-admin', (evt) => {
  if (!trustedSender(evt)) return { ok: false };
  try {
    const args = app.isPackaged ? '' : __dirname;
    const script = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '${args.replace(/'/g, "''")}' -Verb RunAs`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const c = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    c.unref();
    // Sesi non-admin ditutup sebentar lagi; UAC prompt muncul di proses baru.
    setTimeout(() => { try { app.quit(); } catch {} }, 1500);
    return { ok: true };
  } catch { return { ok: false }; }
});

// ---------------------------------------------------------------------------
// "All Files": daftar global SEMUA file (lintas folder) di bawah root, diurut
// ukuran menurun. Backend flatten tree penuh yang sudah di-cache, lalu
// paginasi (renderer hanya menerima chunk kecil). Cache per path (LRU).
// ---------------------------------------------------------------------------
const filesCache = new Map();
const FILES_CACHE_MAX = 3;

function flattenFiles(node, out, parent) {
  const p = parent == null ? (node.path || '') : parent;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    const cp = (p ? (p.slice(-1) === '\\' ? p : p + '\\') : '') + c.name;
    if (Array.isArray(c.children)) flattenFiles(c, out, cp);
    else out.push({ name: c.name, path: cp, size: c.size || 0, alloc: c.alloc ?? c.size ?? 0 });
  }
}

// Ambil node tree penuh untuk path (root atau subtree dari leluhur yang sudah
// dibangun). Basis untuk flatten. Bila cache belum punya tree penuh (scan
// awal datang capped), query server full (limit=0) sekali utk subtree ini.
async function fullNodeFor(base) {
  base = normDrive(base);
  const bb = base.toLowerCase();
  for (const [p, tree] of treeCache) {
    if (tree && tree._capped) continue; // slice scan-awal tidak penuh -> jangan dipakai utk flatten
    const pb = p.toLowerCase();
    if (bb.startsWith(pb) && atBoundary(bb, pb.length)) {
      const rel = base.slice(p.length).split(/[\\\/]+/).filter(Boolean);
      const node = rel.length ? descend(tree, rel) : tree;
      if (node) { if (rel.length) node.path = base; return node; }
    }
  }
  // Tidak di cache (atau cache capped) -> query server penuh.
  try {
    const full = await tryMftServe(base, null, 0);
    if (full) { cacheSet(base, full); return full; }
  } catch {}
  return null;
}

// In-flight per base: deduplikasi `filesEntry` paralel (cegah double full-query
// + flatten + double build bySize/byAlloc untuk base sama).
const filesInFlight = new Map();
async function filesEntry(base) {
  base = normDrive(base);
  let e = filesCache.get(base);
  if (e) { filesCache.delete(base); filesCache.set(base, e); return e; } // sentuh -> LRU
  if (filesInFlight.has(base)) return filesInFlight.get(base);
  const p = (async () => {
    const node = await fullNodeFor(base);
    const files = [];
    if (node) flattenFiles(node, files, null);
    // Pre-sort SEKALI (size & alloc) saat cache dibangun, agar tiap panggilan
    // paginasi tinggal slice tanpa re-sort O(n log n) per halaman.
    const bySize = files.slice().sort((a, b) => b.size - a.size);
    const byAlloc = files.slice().sort((a, b) => (b.alloc ?? b.size) - (a.alloc ?? a.size));
    e = { total: files.length, bySize, byAlloc };
    filesCache.set(base, e);
    if (filesCache.size > FILES_CACHE_MAX) {
      const oldest = filesCache.keys().next().value;
      if (oldest !== undefined) filesCache.delete(oldest);
    }
    return e;
  })();
  filesInFlight.set(base, p);
  p.finally(() => filesInFlight.delete(base));
  return p;
}

ipcMain.handle('files-all', async (evt, root, offset, limit, q, metric) => {
  if (!trustedSender(evt)) return { total: 0, rows: [] };
  const base = (typeof root === 'string' && /^[A-Za-z]:([\\\/]|$)/.test(root)) ? root : '';
  if (!base) return { total: 0, rows: [] };
  const e = await filesEntry(base);
  const byAlloc = metric === 'alloc';
  let all = byAlloc ? e.byAlloc : e.bySize;
  const qq = (typeof q === 'string' ? q : '').trim().toLowerCase().slice(0, 256);
  if (qq) {
    const toks = qq.split(/\s+/).filter(Boolean);
    if (toks.length) {
      all = all.filter((f) => {
        const s = f.name.toLowerCase() + '\n' + f.path.toLowerCase();
        return toks.every((t) => s.includes(t));
      });
      // re-sort hanya subset hasil filter (jauh lebih kecil dari total).
      all = all.slice().sort((a, b) =>
        byAlloc ? (b.alloc ?? b.size) - (a.alloc ?? a.size) : b.size - a.size);
    }
  }
  const start = Math.max(0, offset | 0);
  const lim = Math.min(1000, Math.max(1, (limit | 0) || 500));
  return { total: all.length, rows: all.slice(start, start + lim) };
});

ipcMain.handle('open-path', (evt, target) => {
  try {
    if (!trustedSender(evt) || !target || typeof target !== 'string') return { ok: false };
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
