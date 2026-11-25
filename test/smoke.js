'use strict';
// Smoke test Wiztri — mode web (server.js) tanpa GUI.
// Menjalankan server di port acak, memindai folder nyata, dan memvalidasi
// bentuk pohon hasil (sama dgn kontrak yang dirender UI).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3917;
// scan direktori sementara yang berisi file tersembunyi (Desktop.ini) supaya
// pengecekan penanda 'hidden' bermakna (bukan vacuous).
const SCANROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz_smoke_'));
fs.writeFileSync(path.join(SCANROOT, 'Desktop.ini'), 'x');
fs.writeFileSync(path.join(SCANROOT, 'a.txt'), 'y');
fs.mkdirSync(path.join(SCANROOT, 'sub'));
fs.writeFileSync(path.join(SCANROOT, 'sub', 'b.bin'), 'z');

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!cond) failures++;
};

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (r) => {
    let b = '';
    r.on('data', (d) => (b += d));
    r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stderr.on('data', (d) => (log += d));

  // tunggu server hidup
  let up = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await get(`http://127.0.0.1:${PORT}/`).catch(() => null);
      if (r) { up = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  check('server mendengar di 127.0.0.1', up);
  if (!up) { srv.kill(); console.log('server stderr:', log); process.exit(1); }

  // 1) scan API — bentuk tree
  const enc = encodeURIComponent(SCANROOT);
  const r = await get(`http://127.0.0.1:${PORT}/api/scan?root=${enc}`);
  check('scan OK (200)', r.status === 200);
  let t = null;
  try { t = JSON.parse(r.body); } catch {}
  check('scan JSON valid', !!t);
  if (t) {
    check('root punya name/path/size/children', !!(t.name && t.path && typeof t.size === 'number' && Array.isArray(t.children)));
    check('root path benar', path.resolve(t.path) === SCANROOT);
    // Kontrak slice lazy: root punya children (anak LANGSUNG); tiap anak
    // tanpa kunci `children` (daun), size>=0, dan `dir` boolean bila ada.
    let shapeOk = true, hiddenSeen = false, hasDir = false, hasFile = false;
    for (const c of t.children) {
      if (typeof c.size !== 'number' || c.size < 0) shapeOk = false;
      if ('children' in c) shapeOk = false;
      if (c.dir !== undefined && typeof c.dir !== 'boolean') shapeOk = false;
      if (c.dir === true) hasDir = true;
      if (!c.dir) hasFile = true;
      if (c.hidden) hiddenSeen = true;
    }
    check('anak slice (tanpa children), size>=0, dir boolean', shapeOk);
    check('folder tersembunyi ditandai', hiddenSeen);
    check('ada folder (dir:true)', hasDir);
    check('ada file', hasFile);
  }

  // 2) traversal/tatak: ../public2 tidak boleh serve
  const bad = await get(`http://127.0.0.1:${PORT}/../package.json`);
  check('path traversal diblokir (403/404)', bad.status === 403 || bad.status === 404);

  // 3) malformed percent-encoding -> 400, server tetap hidup
  const mal = await get(`http://127.0.0.1:${PORT}/%E0%A4%A`).catch(() => ({ status: 0 }));
  check('decoding rusak -> 400 (bukan crash)', mal.status === 400);
  const aliveAfter = await get(`http://127.0.0.1:${PORT}/`).catch(() => null);
  check('server tetap hidup setelah request rusak', !!aliveAfter);

  srv.kill();
  await new Promise((r) => setTimeout(r, 200));
  console.log(failures === 0 ? '\nSEMUA PASS ✅' : `\n${failures} GAGAL ❌`);
  process.exit(failures === 0 ? 0 : 1);
})();
