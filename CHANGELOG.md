# Changelog

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
