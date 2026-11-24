# Changelog

## Audit perbaikan — 2026-11-24
### Perbaikan bug
- **Renderer**: persentase & bar ukuran kini memakai penyebut sesuai metrik (Size→total logis, Allocated→total teralokasi); sebelumnya selalu total logis, sehingga mode Allocated menampilkan % salah.
- **Renderer**: backend Node tidak menghasilkan `alloc` — kini dinormalisasi (`alloc = size`), sehingga mode Allocated tidak lagi blank/kosong di treemap.
- **Renderer**: error scan (mis. akses ditolak) kini ditampilkan di bilah bawah, bukan ditelan diam-diam.
- **main.js**: `tryMft` tidak lagi bisa menggantung selamanya + membocorkan file temp bila penulisan temp gagal (tambah listener `ws error`).
- **main.js**: `open-path` kini membuka folder dengan `shell.openPath` (file tetap `showItemInFolder`), dan melaporkan gagal bila target tak ada.
- **server.js**: perbaiki path-traversal *prefix-match* (guard boundary case-insensitive + tolak `..`), bungkus `decodeURIComponent` (400 alih-alih crash), tambah depth cap 128, bind ke `127.0.0.1`.
- **Rust (`wiztri-scan.exe`)**: perbaiki offset ukuran non-resident DATA (`0x2c`→`0x30`) — MFT >4 GiB akan terhitung salah/terpotong sebelumnya.
- **Rust**: tambah guard anti-`panic` saat membaca atribut resident yang pendek/rusak (OOB), guard ukuran rekaman agar tak OOM pada geometri boot rusak, escape string error JSON.
- **CSP**: tambah meta Content-Security-Policy (sumber lokal saja) di renderer.

## 0.2.0 — 2026-11-24
### Ditambahkan
- Dropdown pilihan drive (A:–Z:), isi otomatis saat aplikasi dibuka.
- Tombol "Buka di Explorer" per baris (↗) — buka folder/file di Windows Explorer via `shell.showItemInFolder`.
- Rekonstruksi path penuh saat menelusuri pohon (MFT dan mode Node), sehingga buka-di-Explorer bekerja di kedalaman mana pun.
- IPC baru di preload: `listDrives`, `openPath`.
### Lainnya
- Versi dinaikkan 0.1.0 → 0.2.0.

## 0.1.0 — 2026-11-24
- Pembacaan `$MFT` (Rust, `wiztri-scan.exe`) untuk scan cepat memakai hak Administrator, dengan fallback walk Node (Win32).
- UI Electron: tabel ukuran (Size/Allocated), persentase, bar ukuran, treemap squarified.
- Penanda folder tersembunyi/sistem, symlink/junction, dan error akses.
- Progress live pada mode fallback Node.
- Installer NSIS (`wiztri setup.exe`), izin ganti direktori instalasi, shortcut desktop.
