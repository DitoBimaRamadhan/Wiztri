// Bangun volume NTFS palsu (file) utk uji scanner tanpa admin.
// Geometri: bps=512, spc=1 -> cluster=512; mft LCN=2 -> mft_start=1024; rec_size=512.
'use strict';
const fs = require('fs');

const REC = 512, BPS = 512;

function u16(b, o, v) { b.writeUInt16LE(v, o); }
function u32(b, o, v) { b.writeUInt32LE(v, o); }
function u64(b, o, v) { b.writeBigUInt64LE(BigInt(v), o); }

function fixupSlot(rec) {
  // USOFF=0x30, count=2 (tag + 1 sector). us[1] = 0xAAAA; bytes 510..511 placeholder 0xAAAA.
  u16(rec, 0x04, 0x30);
  u16(rec, 0x06, 2);
  u16(rec, 0x30, 0xFFFF);         // tag
  u16(rec, 0x32, 0xAAAA);          // fixup value (no-op)
  u16(rec, 510, 0xAAAA);           // ujung sector 1
}

function flushAttr(rec, o) { u32(rec, o, 0xFFFFFFFF); }

function fileNameValue(parent, alloc, size, name) {
  const n = Buffer.from(name, 'utf16le');
  const v = Buffer.alloc(0x42 + n.length);
  u64(v, 0, BigInt(parent) & 0xFFFFFFFFFFFFn); // parent u64 (low 48 used)
  u64(v, 0x28, alloc);
  u64(v, 0x30, size);
  v[0x40] = n.length / 2;
  v[0x41] = 0;
  n.copy(v, 0x42);
  return v;
}

// rekaman FILE biasa dengan FILE_NAME resident
function fileRecord(frn, flags, parent, alloc, size, name) {
  const rec = Buffer.alloc(REC);
  rec.write('FILE', 0, 'latin1');
  const v = fileNameValue(parent, alloc, size, name);
  const attrLen = 0x18 + v.length;
  u16(rec, 0x14, 0x38);           // attr_off
  u16(rec, 0x16, flags);           // in-use (+dir)
  u32(rec, 0x18, 0x38 + attrLen + 4);
  // atribut FILE_NAME
  u32(rec, 0x38, 0x30);            // type
  u32(rec, 0x3c, attrLen);         // len
  rec[0x40] = 0;                   // nonresident=0
  u32(rec, 0x48, v.length);        // value length
  u16(rec, 0x4c, 0x18);            // value offset
  v.copy(rec, 0x38 + 0x18);
  flushAttr(rec, 0x38 + attrLen);
  fixupSlot(rec);
  return rec;
}

// rekaman 0 ($MFT) dengan DATA non-resident -> ukuran mft_bytes @0x2c
function mftRecord0(mftBytes) {
  const rec = Buffer.alloc(REC);
  rec.write('FILE', 0, 'latin1');
  u16(rec, 0x14, 0x38);
  u16(rec, 0x16, 0x0001);
  const hlen = 0x49; // include mapping terminator
  u32(rec, 0x18, 0x38 + hlen + 4);
  u32(rec, 0x38, 0x80);            // type DATA
  u32(rec, 0x3c, hlen);            // len
  rec[0x40] = 1;                    // nonresident
  u64(rec, 0x48, 0);               // lowestVCN
  u64(rec, 0x50, mftBytes / REC - 1); // highestVCN (clusters? VCN units; ok approx)
  u16(rec, 0x58, 0x40);            // mapping pairs offset
  u64(rec, 0x5c, mftBytes);        // allocated
  u64(rec, 0x64, mftBytes);        // real size
  u64(rec, 0x6c, mftBytes);        // initialized
  rec[0x78] = 0;                   // mapping pairs: terminator (start of 0x40+0x38=0x78)
  flushAttr(rec, 0x38 + hlen);
  fixupSlot(rec);
  return rec;
}

function buildImg() {
  const img = Buffer.alloc(64 * 1024);
  // boot sector
  img[0] = 0xEB; img[1] = 0x52; img[2] = 0x90;
  img.write('NTFS    ', 3, 'latin1'); // 8 bytes
  u16(img, 0x0b, BPS);
  img[0x0d] = 1;
  u64(img, 0x28, 128);       // total sectors
  u64(img, 0x30, 2);         // mft lcn
  u64(img, 0x38, 1);         // mftmirr lcn
  img[0x40] = 1;             // clusters per mft record (=512B)
  img[0x41] = 1;             // clusters per index

  const mftStart = 1024;
  const recs = [];
  recs[0] = mftRecord0(14 * REC);
  // root frn=5
  recs[5] = fileRecord(5, 0x0003, 5, 0, 0, 'ROOT');
  // files & dir
  recs[10] = fileRecord(10, 0x0001, 5, 1024, 1000, 'a.txt');
  recs[11] = fileRecord(11, 0x0001, 5, 512, 500, 'b.txt');
  recs[12] = fileRecord(12, 0x0003, 5, 0, 0, 'sub');
  recs[13] = fileRecord(13, 0x0001, 12, 768, 700, 'c.bin');
  for (let i = 0; i < recs.length; i++) {
    if (recs[i]) recs[i].copy(img, mftStart + i * REC);
  }
  return img;
}

const out = process.argv[2] || 'fake.img';
fs.writeFileSync(out, buildImg());
console.log('wrote', out, require('path').resolve(out));
