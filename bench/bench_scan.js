'use strict';
// Ukur waktu scan mode layanan (--serve) thd volume palsu: spawn, query akar
// ('-'), ukur wall-clock sampai JSON lengkap. Optional: arg [file] [queries].
const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FAKE = process.argv[2] || path.join(ROOT, 'bench', 'bench.img');
const QUERIES = parseInt(process.argv[3] || '1', 10);
const QUERY_LINE = process.argv[4] || '-';
const EXE = [
  path.join(ROOT, 'rust-scanner', 'target', 'release', 'wiztri-scan.exe'),
  path.join(ROOT, 'rust-scanner', 'target', 'x86_64-pc-windows-gnu', 'release', 'wiztri-scan.exe'),
  path.join(ROOT, 'rust-scanner', 'target', 'debug', 'wiztri-scan.exe'),
].find(existsSync);
if (!EXE || !existsSync(FAKE)) { console.log('SKIP: exe atau fake volume tak ada'); process.exit(2); }

function framedReader(child) {
  let buf = Buffer.alloc(0);
  const pending = [];
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      const len = Number(buf.slice(0, nl).toString('utf8'));
      if (!Number.isFinite(len) || len < 0) { buf = buf.slice(nl + 1); continue; }
      if (buf.length < nl + 1 + len) break;
      const body = buf.slice(nl + 1, nl + 1 + len).toString('utf8');
      buf = buf.slice(nl + 1 + len);
      pending.shift()?.(body);
    }
  });
  return {
    q(line) { return new Promise((res) => { pending.push(res); child.stdin.write(line + '\n'); }); },
  };
}

(async () => {
  const t0 = process.hrtime.bigint();
  const child = spawn(EXE, ['--serve', FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
  const r = framedReader(child);
  const tSpawn = Number(process.hrtime.bigint() - t0) / 1e6;

  const q = []; // progres dari stderr
  child.stderr.on('data', (d) => { for (const m of d.toString('utf8').matchAll(/P (\d+) (\d+)/g)) q.push([+m[1], +m[2]]); });

  const body = await r.q(QUERY_LINE);
  const tFirst = Number(process.hrtime.bigint() - t0) / 1e6;
  let root = null;
  try { root = JSON.parse(body); } catch {}
  const tParse = Number(process.hrtime.bigint() - t0) / 1e6;
  const tParseDelta = (tParse - tFirst).toFixed(1);

  // query tambahan
  const tMore = [];
  for (let i = 0; i < QUERIES - 1; i++) {
    const s = process.hrtime.bigint();
    await r.q(QUERY_LINE);
    tMore.push((Number(process.hrtime.bigint() - s) / 1e6).toFixed(1));
  }

  child.stdin.write('quit\n');
  await new Promise((res) => child.on('close', res));

  const lastP = q[q.length - 1];
  console.log('file:', FAKE);
  console.log('exe :', path.basename(EXE));
  console.log('spawn->ready ms  :', tSpawn.toFixed(1));
  console.log('first query (ms) :', tFirst.toFixed(1), '| children=', root && Array.isArray(root.children) ? root.children.length : 'ERR');
  console.log('sampai parse (ms) :', tParse.toFixed(1), '| parse (ms):', tParseDelta);
  if (tMore.length) console.log('query N+ ms      :', tMore.join(', '));
  console.log('progres akhir :', lastP ? `${lastP[0]}/${lastP[1]}` : 'tidak ada');
  process.exit(0);
})();
