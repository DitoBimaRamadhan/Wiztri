// Wiztri — Electron main process
// Mode scan: coba wiztri-scan.exe (MFT, cepat, butuh admin) -> jika gagal, fallback walk Node (Win32).
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HIDDEN = new Set([
  'System Volume Information', '$Recycle.Bin', 'AppData', 'WinSxS',
  '$MFT', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'Recovery',
  '$Extend', 'Config.Msi', 'DumpStack.log.tmp', 'Desktop.ini',
]);

function parseDrive(root) {
  const m = /^([A-Za-z]):/.exec(root || '');
  return m ? m[1].toUpperCase() : 'C';
}

// Jalur MFT (Rust). return null bila tak tersedia / tak diizinkan.
// Streaming ke file temp (hindari maxBuffer) + ref child utk di-kill saat app tutup.
let childRef = null;
function tryMft(drive) {
  const exe = path.join(process.resourcesPath, 'wiztri-scan.exe');
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), 'wiztri_mft_' + process.pid + '_' + Date.now() + '.json');
    const ws = fs.createWriteStream(tmp);
    const child = spawn(exe, [drive], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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

async function nodeScan(root, onProgress, state, depth = 0) {
  state.count++;
  if (state.count % 1024 === 0 && onProgress) onProgress(state.count, root);
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { name: path.basename(root) || root, path: root, error: 'access_denied', size: 0, children: [] };
  }
  if (depth > 128) return { name: path.basename(root) || root, path: root, size: 0, children: [] }; // ponytail: depth cap 128, increase if deeper nesting required
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

ipcMain.handle('scan', async (_evt, root) => {
  const base = root || process.env.SYSTEMDRIVE || 'C:\\';
  const mft = await tryMft(parseDrive(base));
  if (mft) return mft;
  const state = { count: 0 };
  let lastSend = 0;
  const c = (count, dir) => {
    const now = Date.now();
    if (now - lastSend < 120) return; // throttle: maks ~8 event/detik
    lastSend = now;
    _evt.sender.send('scan-progress', { count, dir });
  };
  c(0, base);
  const tree = await nodeScan(base, c, state);
  c(state.count, '');
  return tree;
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
    },
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Pastikan scanner anak ikut mati saat app tutup (cegah orphan pegang volume handle).
app.on('before-quit', () => {
  if (childRef && !childRef.killed) { try { childRef.kill(); } catch {} }
});
