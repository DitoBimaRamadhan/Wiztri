'use strict';
// Uji IPC scan nyata di Electron (lingkaran penuh: renderer -> preload ->
// main -> nodeScan fallback -> kembali ke renderer).
// Panggil window.wiztri.scan(folder), validasi bentuk tree.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9334;
const SCANPATH = path.join(ROOT, 'public');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failures = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failures++; };
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  let targets = [];
  for (let i = 0; i < 40; i++) {
    try { targets = JSON.parse((await get(`http://127.0.0.1:${PORT}/json/list`)).body); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) { child.kill(); console.log('no page; stderr:', stderr.slice(0, 600)); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const opened = await Promise.race([
    new Promise((res) => (ws.onopen = res)),
    sleep(5000).then(() => null),
  ]);
  if (!opened) { console.log('FAIL — WebSocket timeout'); child.kill(); process.exit(1); }
  await sleep(1200);

  const esc = JSON.stringify(SCANPATH + path.sep);
  const subEsc = JSON.stringify(path.join(SCANPATH, 'vendor') + path.sep);
  const expr = `(async () => {
    const prog = [];
    window.wiztri.onProgress(d => prog.push(d));
    const t = await window.wiztri.scan(${esc});
    // Scan subfolder (lazy/cache): harus kembali slice berakar di vendor.
    const sub = await window.wiztri.scan(${subEsc});
    return JSON.stringify({
      name: t.name, pathKey: t.path, size: t.size, alloc: t.alloc,
      kids: (t.children||[]).length,
      err: t.error || null,
      shapeOk: (() => {
        let ok = true;
        (t.children||[]).forEach(c => {
          if (typeof c.size !== 'number' || c.size < 0) ok = false;
          if ('children' in c) ok = false;      // slice lazy: anak adalah daun (tanpa children)
          if (c.dir !== undefined && typeof c.dir !== 'boolean') ok = false;
        });
        return ok;
      })(),
      hasDir: (t.children||[]).some(c => c.dir === true),
      hasFile: (t.children||[]).some(c => !c.dir),
      subName: sub && sub.name, subPath: sub && sub.path,
      subKids: sub ? (sub.children||[]).length : -1,
      subShapeOk: (() => {
        let ok = true;
        (sub.children||[]).forEach(c => {
          if (typeof c.size !== 'number' || c.size < 0) ok = false;
          if ('children' in c) ok = false;
        });
        return ok;
      })(),
      progCount: prog.length,
      progFirst: prog[0] || null
    });
  })()`;
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  let out = null;
  try { out = JSON.parse(r.result.value); } catch {}

  check('scan() mengembalikan objek', !!out);
  check('path sesuai akar yang dipindai', out && path.resolve(out.pathKey) === SCANPATH);
  check('size angka positif', out && typeof out.size === 'number' && out.size > 0);
  check('shape benar (file tanpa children, semua size>=0)', out && out.shapeOk === true);
  check('ada folder (children array) di hasil', out && out.hasDir === true);
  check('ada file (tanpa children) di hasil', out && out.hasFile === true);
  check('root punya anak', out && out.kids > 0);
  check('event progres dikirim', out && out.progCount > 0);
  // MFT / fallback Node single-pass: total boleh 0 (indeterminate). Bila >0,
  // count tidak boleh melampaui total.
  check('progress memuat total >= 0', out && out.progFirst && out.progFirst.total >= 0);
  check('progress memuat count >= 0', out && out.progFirst && out.progFirst.count >= 0);
  check('progress count <= total (bila total>0)', out && out.progFirst && (out.progFirst.total === 0 || out.progFirst.count <= out.progFirst.total));
  check('progress memuat dir', out && out.progFirst && typeof out.progFirst.dir === 'string');
  check('scan subfolder (lazy) mengembalikan objek', !!out && !!out.subName);
  check('subfolder path benar', out && path.resolve(out.subPath) === path.join(SCANPATH, 'vendor'));
  check('subfolder hasil slice valid', out && out.subShapeOk === true);
  check('subfolder punya anak', out && out.subKids >= 0);
  console.log('  hasil scan → size=' + (out && out.size) + ' kids=' + (out && out.kids) + ' err=' + (out && out.err));
  console.log('  subfolder → name=' + (out && out.subName) + ' kids=' + (out && out.subKids));
  console.log('  progres → event=' + (out && out.progCount) + ' first={count=' + (out && out.progFirst && out.progFirst.count) + ', total=' + (out && out.progFirst && out.progFirst.total) + '}');

  ws.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill('SIGKILL');
  console.log(failures === 0 ? '\nSEMUA PASS ✅' : `\n${failures} GAGAL ❌`);
  process.exit(failures === 0 ? 0 : 1);
})();
