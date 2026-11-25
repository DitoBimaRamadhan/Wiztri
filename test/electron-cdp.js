'use strict';
// Uji renderer Wiztri via Chrome DevTools Protocol (remote debugging).
// Verifikasi: (1) window preload mengekspos window.wiztri,
// (2) React benar-benar me-mount ke #app (innerHTML non-kosong & ada tombol Scan).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9333;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failures = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failures++; };

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); })
    .on('error', rej);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  // tunggu endpoint debug
  let targets = [];
  for (let i = 0; i < 40; i++) {
    try { targets = JSON.parse((await get(`http://127.0.0.1:${PORT}/json/list`)).body); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  check('debuat target page index.html', !!page);
  if (!page) { child.kill(); console.log('stderr:', stderr.slice(0, 800)); process.exit(1); }

  // CDP over WebSocket (global WebSocket tersedia di Node >=22)
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const opened = await Promise.race([
    new Promise((res) => (ws.onopen = res)),
    sleep(5000).then(() => null),
  ]);
  if (!opened) { console.log('FAIL — WebSocket timeout'); child.kill(); process.exit(1); }
  await sleep(1500); // biarkan React mount

  const expr = `JSON.stringify({
    ready: document.readyState,
    appHTML: (document.getElementById('app')||{}).innerHTML ? document.getElementById('app').innerHTML.length : 0,
    hasWiztri: typeof window.wiztri === 'object',
    hasScan: !!(window.wiztri && window.wiztri.scan),
    hasListDrives: !!(window.wiztri && window.wiztri.listDrives),
    hasOpenPath: !!(window.wiztri && window.wiztri.openPath),
    hasOnProgress: !!(window.wiztri && window.wiztri.onProgress),
    hasIsAdmin: !!(window.wiztri && window.wiztri.isAdmin),
    buttons: Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()),
    bodyTextLen: document.body.innerText.length
  })`;
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  let out = null;
  try { out = JSON.parse(r.result.value); } catch {}

  check('DOM ready', out && out.ready === 'complete');
  check('React mount ke #app (innerHTML > 0)', out && out.appHTML > 0);
  check('preload expose window.wiztri', out && out.hasWiztri);
  check('window.wiztri.scan ada', out && out.hasScan);
  check('window.wiztri.listDrives ada', out && out.hasListDrives);
  check('window.wiztri.openPath ada', out && out.hasOpenPath);
  check('window.wiztri.onProgress ada', out && out.hasOnProgress);
  check('window.wiztri.isAdmin ada', out && out.hasIsAdmin);
  check('ada tombol Scan di UI', out && Array.isArray(out.buttons) && out.buttons.includes('Scan'));
  check('body menampilkan teks (bukan kosong)', out && out.bodyTextLen > 0);
  if (out) console.log('  UI stats → appHTML=' + out.appHTML + ' bodyLen=' + out.bodyTextLen + ' buttons=' + JSON.stringify(out.buttons));

  ws.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill('SIGKILL');
  console.log(failures === 0 ? '\nSEMUA PASS ✅' : `\n${failures} GAGAL ❌`);
  process.exit(failures === 0 ? 0 : 1);
})();
