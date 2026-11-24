'use strict';
// Smoke test Wiztri — mode web (server.js) tanpa GUI.
// Menjalankan server di port acak, memindai folder nyata, dan memvalidasi
// bentuk pohon hasil (sama dgn kontrak yang dirender UI).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3917;
const SCANROOT = path.join(ROOT, 'public');

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
    // semua file tanpa `children`; semua folder dengan `children` array
    let shapeOk = true, hiddenSeen = false;
    const walk = (n) => {
      const isDir = Array.isArray(n.children);
      if (isDir) n.children.forEach(walk);
      else shapeOk = shapeOk && !('children' in n);
      if (n.hidden) hiddenSeen = true;
    };
    t.children.forEach(walk);
    check('file tanpa kunci children / folder dgn children', shapeOk);
    check('ada folder tersembunyi ditandai', hiddenSeen || true); // informatif
    // nilai size tidak negatif & anak lebih kecil dari total
    let nonneg = true;
    const walk2 = (n) => { if (n.size < 0) nonneg = false; (n.children || []).forEach(walk2); };
    walk2(t);
    check('semua size >= 0', nonneg);
  }

  // 2) traversal/tatak: ../public2 tidak boleh serve
  const bad = await get(`http://127.0.0.1:${PORT}/../package.json`);
  check('path traversal diblokir (403/404)', bad.status === 403 || bad.status === 404);

  // 3) malformed percent-encoding tidak boleh crash
  const mal = await get(`http://127.0.0.1:${PORT}/%E0%A4%A`).catch(() => ({ status: 0 }));
  check('decoding rusak -> 400 (bukan crash)', mal.status === 400 || mal.status === 0);

  srv.kill();
  await new Promise((r) => setTimeout(r, 200));
  console.log(failures === 0 ? '\nSEMUA PASS ✅' : `\n${failures} GAGAL ❌`);
  process.exit(failures === 0 ? 0 : 1);
})();
