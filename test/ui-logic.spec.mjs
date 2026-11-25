// Unit-check logika UI baru (tampilan File Types + filter), diekstrak langsung
// dari public/index.html supaya tidak melenceng dari sumber asli.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!cond) failures++;
};

// 1) Semua identitas yang dipakai JSX/render kini terdefinisi (sebelumnya crash).
for (const id of ['const [view, setView]', 'const [filter, setFilter]', 'const match =', 'const fileTypes =']) {
  check(`definisi ${id}`, src.includes(id));
}

// 2) Bukan ref yang tersisa (dulu `sort` dipakai tanpa definisi).
check('tidak ada referensi "sort > 0"', !src.includes('sort > 0'));

// 3) Perilaku ekstraksi ekstensi + filter.
const grab = (name) => {
  const m = src.match(new RegExp('const ' + name + '[\\s\\S]*?\\n  };'));
  if (!m) throw new Error('missing ' + name);
  return m[0];
};
const getFn = (name) => eval('(function(){ ' + grab(name) + '; return ' + name + '; })()');
const extOf = getFn('extOf');
const makeMatch = getFn('makeMatch');

check('extOf: a.mp4 -> mp4', extOf('a.mp4') === 'mp4');
check('extOf: tanpa titik -> ""', extOf('README') === '');
check('extOf: titik diawal -> ""', extOf('.gitignore') === '');
check('extOf: huruf besar -> kecil', extOf('A.JPG') === 'jpg');
check('filter: satu token', makeMatch('mp4')('a.mp4') && !makeMatch('mp4')('c.txt'));
check('filter: multi-token AND', makeMatch('a mp4')('a.mp4') && !makeMatch('a mp4')('b.mp4'));
check('filter: kosong -> null (nonaktif)', makeMatch('') === null);

// 4) Agregasi fileTypes (meniru useMemo; gabungkan daun, skip folder).
const tree = { name: 'D:', dir: true, children: [
  { name: 'a.mp4', size: 100, alloc: 120 },
  { name: 'b.mp4', size: 50, alloc: 60 },
  { name: 'c.txt', size: 10, alloc: 10 },
  { name: 'sub', dir: true, children: [{ name: 'deep.jpg', size: 30, alloc: 34 }] },
  { name: 'z', size: 1, alloc: 1 },
] };
const map = new Map();
(function walk(n) {
  if (n.dir === true) { (n.children || []).forEach(walk); return; }
  const e = extOf(n.name) || '(no extension)';
  let g = map.get(e);
  if (!g) map.set(e, g = { name: e, size: 0, alloc: 0, count: 0 });
  g.size += n.size || 0;
  g.alloc += (n.alloc ?? n.size) || 0;
  g.count++;
})(tree);
const bySize = [...map.values()].sort((a, b) => b.size - a.size);
const byAlloc = [...map.values()].sort((a, b) => b.alloc - a.alloc);

const mp4 = map.get('mp4');
check('fileTypes: mp4 menggabung file (count 2)', mp4.count === 2);
check('fileTypes: mp4 size=150', mp4.size === 150);
check('fileTypes: mp4 alloc=180', mp4.alloc === 180);
check('fileTypes: folder di-skip (won jpg)', map.get('jpg') && map.get('jpg').count === 1);
check('fileTypes: urut size desc', bySize[0].name === 'mp4' && bySize[1].name === 'jpg');
check('fileTypes: urut alloc desc', byAlloc[0].name === 'mp4');

process.exit(failures ? 1 : 0);
