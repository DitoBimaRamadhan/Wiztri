# Wiztri

Disk usage analyzer untuk Windows, gaya WizTree/TreeSize. Membaca `$MFT` (NTFS) secara mentah untuk scan cepat, dengan fallback walk sistem file biasa.

![Wiztri](Wiztri.jpeg)

## Fitur

- **Mode cepat (MFT)** — scan via pembacaan mentah `$MFT` di Rust; butuh hak Administrator.
- **Fallback Node** — walk sistem file (`fs.readdir` paralel) saat MFT tak bisa dibuka (tanpa admin / bukan NTFS).
- **Treemap squarified** — visualisasi proporsi ukuran; klik baris/warna untuk menelusuri.
- **Tabel ukuran** — kolom Size / Allocated, persentase, bar ukuran; expand/collapse folder.
- **Dropdown drive** — pilih drive A:–Z: tanpa mengetik.
- **Buka di Explorer** — tombol ↔� per baris membuka folder/file di Windows Explorer.
- **Penanda** — folder tersembunyi/sistem, symlink/junction, error akses.
- **Live progress** — pada mode fallback Node.
- Offline, tanpa CDN font, UI gelap berbahasa Indonesia.

## Arsitektur

```
main.js            Proses utama Electron: IPC, spawn scanner MFT, fallback Node scan
preload.js         contextBridge — expose window.wiztri {scan, listDrives, openPath, onProgress}
public/index.html   Renderer React (inline, htm + React CDN lokal) — grid + treemap
rust-scanner/      Scanner $MFT dalam Rust → wiztri-scan.exe (dibundel via extraResources)
server.js          Mode web (developer): GET /api/scan?root=… (tanpa Electron)
installer/         Output electron-builder (NSIS): wiztri setup.exe
```

Data tree JSON konsisten antar backend: `{ name, path, size, alloc, children[] }`.

## Persyaratan

- Windows NTFS (MFT) / sistem file apa pun untuk fallback Node.
- Hak **Administrator** untuk mode cepat MFT.
- [Rust toolchain](https://rustup.rs) untuk membangun scanner `x86_64-pc-windows-gnu`.

## Membangun

```bash
# 1. Scanner Rust
cd rust-scanner
cargo build --release --target x86_64-pc-windows-gnu

# 2. Aplikasi
# 2a. Jalankan di browser/terminal (mode web developer)
cd ..
npm start                    # http://localhost:3000

# 2b. Jalankan sebagai desktop app (Electron)
npm run desktop

# 2c. Bangun installer Windows (NSIS) → installer/wiztri setup.exe
npm run dist
```

> Catatan: `extraResources` di `package.json` menunjuk `rust-scanner/target/x86_64-pc-windows-gnu/release/wiztri-scan.exe` — bangun dulu sebelum `npm run dist`.

## Pemakaian

1. Jalankan Wiztri **sebagai Administrator** untuk mode MFT cepat.
2. Pilih drive dari dropdown atau ketik path (mis. `C:\Users`), lalu **Scan**.
3. Klik baris untuk menelusuri folder; treemap ikut berpindah.
4. Gunakan **↗** untuk membuka lokasi di Explorer.

Jika dijalankan tanpa admin, app otomatis memakai fallback Node (lebih lambat, tetap akurat).

## Changelog

Lihat [CHANGELOG.md](CHANGELOG.md).

## Lisensi

Proyek internal / privat. Belum ada lisensi terbuka.
