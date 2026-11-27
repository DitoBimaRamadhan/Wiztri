'use strict';
// Bangun volume NTFS palsu BESAR (stream) utk benchmark scanner tanpa admin.
// Geometri sama dgn make_fake_ntfs.js: bps=512, spc=1 -> cluster=512;
// mft_lcn=2 -> mft_start=1024; rec_size=512. Record 0 ($MFT DATA non-resident)
// memberi total_recs = N. Semua record lain = file dengan parent=5 (ROOT).
// Pemakaian: node bench/gen_fake.js <N> <outfile>
const fs = require('fs');
const REC = 512;
function u16(b, o, v) { b.writeUInt16LE(v, o); }
function u32(b, o, v) { b.writeUInt32LE(v, o); }
function u64(b, o, v) { b.writeBigUInt64LE(BigInt(v), o); }

function fixupSlot(rec) {
  u16(rec, 0x04, 0x30);
  u16(rec, 0x06, 2);
  u16(rec, 0x30, 0xFFFF);
  u16(rec, 0x32, 0xAAAA);
  u16(rec, 510, 0xAAAA);
}
function flushAttr(rec, o) { u32(rec, o, 0xFFFFFFFF); }
function fileNameValue(parent, alloc, size, name) {
  const n = Buffer.from(name, 'utf16le');
  const v = Buffer.alloc(0x42 + n.length);
  u64(v, 0, BigInt(parent) & 0xFFFFFFFFFFFFn);
  u64(v, 0x28, alloc);
  u64(v, 0x30, size);
  v[0x40] = n.length / 2;
  v[0x41] = 0;
  n.copy(v, 0x42);
  return v;
}
function fileRecord(frn, flags, parent, alloc, size, name) {
  const rec = Buffer.alloc(REC);
  rec.write('FILE', 0, 'latin1');
  const v = fileNameValue(parent, alloc, size, name);
  const attrLen = 0x18 + v.length;
  u16(rec, 0x14, 0x38);
  u16(rec, 0x16, flags);
  u32(rec, 0x18, 0x38 + attrLen + 4);
  u32(rec, 0x38, 0x30);
  u32(rec, 0x3c, attrLen);
  rec[0x40] = 0;
  u32(rec, 0x48, v.length);
  u16(rec, 0x4c, 0x18);
  v.copy(rec, 0x38 + 0x18);
  flushAttr(rec, 0x38 + attrLen);
  fixupSlot(rec);
  return rec;
}
function mftRecord0(mftBytes) {
  const rec = Buffer.alloc(REC);
  rec.write('FILE', 0, 'latin1');
  u16(rec, 0x14, 0x38);
  u16(rec, 0x16, 0x0001);
  const hlen = 0x49;
  u32(rec, 0x18, 0x38 + hlen + 4);
  u32(rec, 0x38, 0x80);
  u32(rec, 0x3c, hlen);
  rec[0x40] = 1;
  u64(rec, 0x48, 0);
  u64(rec, 0x50, mftBytes / REC - 1);
  u16(rec, 0x58, 0x40);
  u64(rec, 0x60, mftBytes);
  u64(rec, 0x68, mftBytes);
  u64(rec, 0x70, mftBytes);
  rec[0x78] = 0;
  flushAttr(rec, 0x38 + hlen);
  fixupSlot(rec);
  return rec;
}

const N = parseInt(process.argv[2] || '200000', 10);
const out = process.argv[3] || 'bench/bench.img';
const BPS = 512;
const MFT_START = 1024;

const fd = fs.openSync(out, 'w');
const img = Buffer.alloc(MFT_START);
img[0] = 0xEB; img[1] = 0x52; img[2] = 0x90;
img.write('NTFS    ', 3, 'latin1');
u16(img, 0x0b, BPS);
img[0x0d] = 1;
u64(img, 0x28, 128);
u64(img, 0x30, 2);
u64(img, 0x38, 1);
img[0x40] = 1;
img[0x41] = 1;
fs.writeSync(fd, img, 0, MFT_START, 0);

let off = MFT_START;
// Banyak record fisik yg ditulis: rec0(1) + frn1-4 kosong(4) + root(1) + N file = N+6
const rec0 = mftRecord0((N + 6) * REC);
fs.writeSync(fd, rec0, 0, REC, off); off += REC;
// frn 1..4 kosong (buffer nol)
off += 4 * REC;
const root = fileRecord(5, 0x0003, 5, 0, 0, 'ROOT');
fs.writeSync(fd, root, 0, REC, off); off += REC;

// stream N file record, parent=5
const chunk = Buffer.alloc(64 * 1024);
const ext = ['bin', 'tmp', 'log', 'dat', 'raw', 'cache', 'part', 'bak'];
let wrote = 0;
let cOff = 0;
function flush() { if (cOff) { fs.writeSync(fd, chunk, 0, cOff, off); off += cOff; cOff = 0; } }
for (let i = 0; i < N; i++) {
  const name = 'f' + i + '.' + ext[i % ext.length];
  const size = (i * 7919) % 1000000;
  const rec = fileRecord(6 + i, 0x0001, 5, size, size, name);
  chunk.set(rec, cOff); cOff += REC;
  if (cOff + REC > chunk.length) flush();
}
// Tambah satu file bernama BER-SPASI (frn 6+N) utk uji protokol path ber-spasi.
{
  const rec = fileRecord(6 + N, 0x0001, 5, 512, 500, 'my file with spaces.bin');
  chunk.set(rec, cOff); cOff += REC;
}
flush();
flush();
fs.closeSync(fd);
console.log('wrote', out, 'records=' + N, 'bytes=' + off);
