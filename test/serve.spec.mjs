// Uji protokol mode layanan MFT (--serve) terhadap volume NTFS palsu (fake.img).
// Mencari exe yang sudah dibangun (gnu/release/debug); SKIP bila tak ada.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = resolve(ROOT, 'rust-scanner', 'fake.img');
const EXE = [
  resolve(ROOT, 'rust-scanner', 'target', 'release', 'wiztri-scan.exe'),
  resolve(ROOT, 'rust-scanner', 'target', 'x86_64-pc-windows-gnu', 'release', 'wiztri-scan.exe'),
  resolve(ROOT, 'rust-scanner', 'target', 'debug', 'wiztri-scan.exe'),
].find(existsSync);

if (!EXE || !existsSync(FAKE)) {
  console.log('SKIP — exe scanner / fake.img belum ada (build dulu: cargo build --release --target x86_64-pc-windows-gnu)');
  process.exit(0);
}

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

// Framing: baris panjang (desimal), lalu JSON sepanjang itu.
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
    q(line) {
      return new Promise((res) => { pending.push(res); child.stdin.write(line + '\n'); });
    },
  };
}

const child = spawn(EXE, ['--serve', FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
const r = framedReader(child);

const vol = JSON.parse(await r.q('-'));
check('akar volume: JSON valid', vol && !vol.error);
check('akar volume: ada children', Array.isArray(vol.children) && vol.children.length > 0);

// Protokol limit: separator TAB (bukan spasi) — path ber-spasi tidak ambigu.
// Volume kecil ini 14 record -> limit 1 memotong anak jadi ≤1 + note.
const capped = JSON.parse(await r.q('-\t1'));
check('limit tab: children ≤1', Array.isArray(capped.children) && capped.children.length <= 1);
check('limit tab: ada note truncation', typeof capped.note === 'string' && capped.note.length > 0);
const cappedSpace = JSON.parse(await r.q('- 1'));
check('limit spasi: seluruh baris jadi path (bukan root) → error', cappedSpace && cappedSpace.error === 'path_not_found');
const a = vol.children.find((c) => c.name === 'a.txt');
check('akar volume: a.txt size=1000', a && a.size === 1000);
const sub = vol.children.find((c) => c.name === 'sub');
check('akar volume: sub folder ada', sub && sub.dir === undefined && Array.isArray(sub.children));

const subq = JSON.parse(await r.q('sub'));
check('subfolder: c.bin di dalam', subq.children.some((c) => c.name === 'c.bin' && c.size === 700));

const miss = JSON.parse(await r.q('nope'));
check('path tak ada -> error', miss && miss.error === 'path_not_found');

child.stdin.write('quit\n');
await new Promise((res) => child.on('close', res));
process.exit(failures ? 1 : 0);
