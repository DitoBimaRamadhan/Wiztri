# Changelog

## 0.3.1 — 2026-11-25
### Kecepatan & keandalan scan (perombakan scanner MFT)
- **Rust (`wiztri-scan.exe`)**: mode baru `--serve <drive|file-volume>` — baca `$MFT` SEKALI per drive lalu layani banyak query subtree lewat stdin/stdout (framing: baris panjang + JSON). Ekspansi folder tidak lagi membaca ulang seluruh volume (sebelumnya tiap scan/expand me-rescan penuh). Progres nyata dikirim ke stderr (`P <count> <total>`). `-` = akar volume. Emit catatan `note:"depth_truncated"` bila ada folder >128 level terpotong.
- **main.js**: server MFT persisten menggantikan temp-file + anak-per-request (hilangkan race baca temp → rescan Node diam-diam). Progres MFT kini asli, bukan palsu 100%. Scan diserialisasi (single-flight) — hasil tidak lagi tumpang-tindih, cocok untuk klik Scan/Enter berulang. Fallback Node single-pass tanpa prescan ganda (hemat I/O 2×). Deteksi mode Administrator (`is-admin`) & lokasi exe otomatis (bundel / target build lokal).
- **renderer**: banner peringatan saat non-admin (folder terproteksi tidak tampil) + tombol **Restart as Administrator** (relaunch elevated via UAC); hasil scan basi dibuang lewat token (cegah nimpa dari scan lama); catatan truncation ditampilkan di bilah bawah; badge engine (MFT/Fallback) di bilah statistik.
- **main.js**: deteksi admin kini membuka raw volume `\\.\C:` (probe akurat, selaras dengan syarat MFT).

## 0.3.0 — 2026-11-25
### Perbaikan bug
- **Rust (`wiztri-scan.exe`)**: terima arg ke-2 (jalur filter) → emit subtree berakar di folder tersebut, bukan seluruh volume. Mode MFT kini bisa dipakai untuk *folder manapun*, bukan hanya root drive.
- **main.js**: `scan` kini mengarahkan SEMUA jalur drive lokal (root maupun subfolder) ke MFT; fallback Node hanya dipakai bila exe tak tersedia / tanpa admin / bukan NTFS. Karena MFT membaca mentah `$MFT`, ACL folder terproteksi (System Volume Information, $Recycle.Bin, AppData pengguna lain, WinSxS, dll.) ikut terbaca — tidak ada lagi `access_denied` saat berjalan sebagai Administrator.
- **renderer**: teks petunjuk kosong diperbarui (sebutkan folder terproteksi).
- **Lazy scan (fix C:\ / D:\ tidak bisa di-scan)**: main kini menahan tree penuh di memori (cache per path) dan hanya mengirim slice kecil (ringkasan + anak langsung). Renderer memuat anak folder sesuai kebutuhan saat expand. Ini mencegah tree jutaan node dikirim utuh lewat IPC (structured clone) yang membuat renderer hang/OOM pada root drive. `server.js` (mode web) mengikuti kontrak slice yang sama.
- **Cap render baris (anti-freeze/OOM)**: tabel tidak tervirtualisasi; folder dengan >500 anak langsung kini dirender maks 500 baris + baris "⋯ dan N lainnya — Tampilkan semua" (klik untuk mengungkap). Auto-expand folder raksasa di `select()` ikut diberi gerbang (≤500). Mencegah commit monolitik ribuan baris + memory blowup saat menyusuri folder padat (mis. WinSxS).

## Audit perbaikan II — 2026-11-25
### Perbaikan bug (hasil audit oleh agent paralel)
- **main.js (HIGH)**: MFT (`wiztri-scan.exe`) hanya dipakai saat root *adalah drive* (mis. `C:\`). Sebelumnya subfolder ikut dipindai MFT → mengembalikan tree seluruh drive tapi diberi label subfolder (hasil salah). Subfolder kini langsung fallback Node.
- **main.js**: event progres akhir dikirim tanpa throttle → bilah selalu sampai 100% (sebelumnya bisa terbuang dalam 120 ms terakhir).
- **main.js**: `ws error` pada `tryMft` kini juga mematikan child (cegah orphan pegang volume handle); cek batas kedalaman dipindah sebelum `readdir` (hindari kerja sia-sia).
- **renderer**: kunci React per baris kini unik (index sibling) — nama kembar dalam satu folder tidak lagi kacau saat expand/pilih.
- **Rust**: ukuran rekaman cabang positif kini dibatasi (anti-OOM pada geometri rusak); preferensi nama utamakan Win32 (ns 2) — nama DOS pendek tak lagi menimpa nama panjang; pembacaan parsial di EOF tidak lagi membuang byte ekor rekaman.
### Keamanan
- **scripts/release.ps1**: upload asset kini selalu via `Invoke-RestMethod` (token hanya di memori) — token tidak lagi muncul di baris perintah `curl`.
- **server.js**: `/api/scan` menolak root non-drive-lokal (cegah SSRF via UNC `\\host\share` dan enumerasi path lain).
- **main.js**: `sandbox: true` eksplisit di webPreferences.
### Pengujian
- Test diperkeras: `electron-smoke` mendeteksi kegagalan spawn (anti-false-pass); `smoke` memindai dir sementara berisi `Desktop.ini` (pengecekan hidden nyata), malformed encoding hanya menerima 400 + cek server tetap hidup; WebSocket CDP diberi timeout; assert folder/file dipisah (folder wajib array, file tanpa children).
- `npm test` (script baru di package.json) menjalankan keempat suite serial. Semua PASS.

## Audit perbaikan — 2026-11-24
### Perbaikan bug
- **Renderer**: persentase & bar ukuran kini memakai penyebut sesuai metrik (Size→total logis, Allocated→total teralokasi); sebelumnya selalu total logis, sehingga mode Allocated menampilkan % salah.
- **Renderer**: backend Node tidak menghasilkan `alloc` — kini dinormalisasi (`alloc = size`), sehingga mode Allocated tidak lagi blank/kosong di treemap.
- **Renderer**: error scan (mis. akses ditolak) kini ditampilkan di bilah bawah, bukan ditelan diam-diam.
- **Renderer**: progres scan kini menampilkan persentase + bilah + jumlah item (`N / total item`); sebelumnya hanya jumlah item. Persentase dihitung dari total node yang diketahui via prescan (`countNodes`) di main.js, dan penghitungan item diperbaiki agar tiap node (termasuk folder) dihitung sekali.
- **main.js**: `tryMft` tidak lagi bisa menggantung selamanya + membocorkan file temp bila penulisan temp gagal (tambah listener `ws error`).
- **main.js**: `open-path` kini membuka folder dengan `shell.openPath` (file tetap `showItemInFolder`), dan melaporkan gagal bila target tak ada.
- **server.js**: perbaiki path-traversal *prefix-match* (guard boundary case-insensitive + tolak `..`), bungkus `decodeURIComponent` (400 alih-alih crash), tambah depth cap 128, bind ke `127.0.0.1`.
- **Rust (`wiztri-scan.exe`)**: perbaiki offset ukuran non-resident DATA (`0x2c`→`0x30`) — MFT >4 GiB akan terhitung salah/terpotong sebelumnya.
- **Rust**: tambah guard anti-`panic` saat membaca atribut resident yang pendek/rusak (OOB), guard ukuran rekaman agar tak OOM pada geometri boot rusak, escape string error JSON.
- **Rust**: emisi file tanpa kunci `children` (sama dgn backend Node) — sebelumnya file ikut `children:[]` sehingga tampil sebagai folder bisa-expand di UI mode MFT.
- **CSP**: tambah meta Content-Security-Policy (sumber lokal saja) di renderer.
### Pengujian
- Tambah `test/` — smoke test otomatis: `smoke.js` (server web: scan API, traversal, decoding rusak), `electron-smoke.js` (app hidup), `electron-cdp.js` (renderer mount + preload + tombol), `electron-scan.js` (IPC scan end-to-end). Semua PASS.

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
