'use strict';
// Smoke test Electron Wiztri: nyalakan app, beri waktu render, lalu cek
// proses hidup + tangkap error dari log. Tidak perlu GUI interaksi.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const LOG = path.join(os.tmpdir(), 'wiztri_electron_smoke.log');
try { fs.unlinkSync(LOG); } catch {}

// WAJIB lepas ELECTRON_RUN_AS_NODE biar electron jalan sbg app, bukan node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(ELECTRON, ['.', '--enable-logging'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
let spawnFailed = false;
child.on('error', (e) => { spawnFailed = true; console.log('FAIL — spawn error:', e.code || e.message); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(8000);
  if (spawnFailed) { console.log('\nGAGAL ❌'); process.exit(1); }
  const alive = child.exitCode === null;
  console.log(alive ? 'PASS — proses Electron hidup (app tetap berjalan)' : 'FAIL — proses Electron mati/exit');
  if (child.exitCode !== null) console.log('exit code:', child.exitCode);

  // tangkap error penting dari stderr.
  // Filter noise initer Chromium yang jinak (disk cache gagal init krn folder
  // cache stale/terkunci — non-fatal, app tetap jalan) agar tidak jadi false
  // positive; deteksi error renderer/main asli tetap utuh.
  const BENIGN = /cache_util_win|disk_cache\.cc|Unable to (move|create).*cache/i;
  const bad = stderr.split('\n').filter((l) =>
    !BENIGN.test(l) &&
    /Uncaught|TypeError|ReferenceError|Cannot find|Failed to load|Unable to|EADDRINUSE|is not defined|undefined is not/i.test(l)
  );
  if (bad.length) {
    console.log('FAIL — error di console:');
    bad.slice(0, 15).forEach((l) => console.log('  ' + l.trim()));
  } else {
    console.log('PASS — tidak ada error renderer/main di log');
  }

  // cek window & renderer hidup via proses (di Windows, electron.exe ada)
  console.log('catatan: window tidak diperiksa visual; app hidup = renderer/main tidak crash.');

  child.kill();
  await sleep(800);
  if (child.exitCode === null) child.kill('SIGKILL');

  const fail = !alive || bad.length > 0;
  console.log(fail ? '\nGAGAL ❌' : '\nPASS ✅');
  process.exit(fail ? 1 : 0);
})();
