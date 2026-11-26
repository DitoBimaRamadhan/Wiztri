# Changelog

## 0.3.3 — 2026-11-27
### Kecepatan scan (target ≤ 3 detik)
- **Parse MFT paralel (Rust)** — `load_vol` membagi chunk $MFT ke semua core (`std::thread::scope`), tanpa dependency baru. 500k record: 3,5s → 1,9s.
- **Scan awal capped** — query pertama meminta slice terbatas (maks 2000 anak/level), respons instan walau drive jutaan file (2M record: 11s → 2,1s). Tree penuh tetap tersedia on-demand.
- **Pre-sort cache** — `files-all` pre-sort `bySize`/`byAlloc` sekali; paginasi slice tanpa `O(n log n)`/halaman. `emit_children` pakai peta anak terurut (tanpa sort ulang per query).
### Perbaikan dari audit lanjutan
- **Path ber-spasi benar** — protokol serve `"<path> [limit]"` kini parse limit dari kanan (hanya bila token terakhir numerik); `C:\Program Files` dsb. tidak lagi terpotong → MFT tetap terpakai utk subfolder.
- **Expand subfolder full** — `ensureChildren` minta tree penuh (`{full:true}`); data >2000 anak tidak hilang senyap (flag `truncated`/note ditampilkan).
- **All Files anti-OOM** — `ALL_RENDER_CAP=2000` (windowing-lite) cegah DOM/state membengkak.
- **`serverQuery` timeout bertingkat** — 30s utk slice, 120s utk full (cegah false-fire pada volume lambat); `svc.onProgress` dipulihkan (anti-clobber antar query).
- **Note truncation dipisah** — `depth_truncated` vs `limit_truncated`.
- **Harness benchmark** — `bench/gen_fake.js` & `bench/bench_scan.js` dibetulkan (undercount record, label parse akurat).

## Audits perbaikan (0.3.2+) — 2026-11-27
Perombakan hasil audit 5 agent paralel (main/preload/server, renderer, Rust scanner, security, test suite).
### Rust scanner (`wiztri-scan.exe`)
- **Cegah panic off-by-one** — guard baca atribut MFT `o+8 <= len` → `o+8 < len` (indeks `buf[o+8]` bisa = len → index-out-of-bounds pada file-volume korup/uji). Berlaku di `parse_record` & `parse_mft_bytes`.
- **Anti-OOM respon JSON** — `emit_children` kini berhenti bila `out.len()` ≥ 64 MB dan menandai `TRUNCATED` (sebelumnya seluruh subtree dibangun sebagai satu String tanpa batas → OOM pada volume raksasa).
- **Progres mencapai 100%** — baris `P <count> <total>` sekarang juga dicetak saat `remaining==0` dan satu baris final bila total bukan kelipatan 4096 (sebelumnya stuck di kelipatan terakhir / volume kecil tanpa progres sama sekali).
- **Error mode serve tak desync** — saat `load_vol` gagal, error ditulis dengan framing length-prefixed (sebelumnya JSON mentah ke stdout → klien misparse).
- **Error I/O tengah baca** — `Err` saat baca `$MFT` kini `return Err(read_mft)` (sebelumnya volume kosong senyap tanpa peringatan); hanya EOF yang normal.
- **Validasi fixup USN** — 2 byte terakhir sektor harus == USN asli sebelum ditimpa (tolak rekaman korup senyap).
- **Geometri minimum** — `rec_size < 512` ditolak (cegah `rec_size=2` dari boot sector rusak).
- **Arg kosong aman** — `--serve ""` tidak lagi panic (fallback `C`).

### main.js
- **`files-all` sort sekali, bukan per-panggilan** — cache kini pre-sort `bySize` & `byAlloc`; paginasi tinggal slice (sebelumnya `O(n log n)` per halaman → freeze pada volume jutaan file). Filter re-sort hanya subset hasil filter.
- **Timeout watchdog per query** — `serverQuery` timeout 30s → resolve null + bunuh server (cegah scan menggantung selamanya saat drive dicabut / geometri patologis).
- **`relaunch-admin` tanpa escaping rapuh** — path di-encode via `-EncodedCommand` base64 UTF-16LE (sebelumnya interpolasi string PowerShell berisiko salah parse bila path berisi kutip).
- **Validasi sender IPC** — semua `ipcMain.handle` (`scan`, `files-all`, `open-path`, `list-drives`, `is-admin`, `relaunch-admin`) hanya menerima event dari `webContents` jendela utama (`trustedSender`).
- **`will-navigate` dikunci** — hanya izinkan URL `public/index.html` app (sebelumnya semua `file://` diizinkan → halaman lokal lain bisa mewarisi bridge preload).
- **Cap slice anak** — `makeSlice` maks 2000 anak langsung + flag `truncated` (cegah payload IPC raksasa untuk folder padat seperti WinSxS).

### server.js (mode web dev)
- **Aman saat client putus** — `res.on('error')` menyerap error (sebelumnya uncaughtException → crash server).
- **Log tanpa path penuh** — `console.error` hanya message, bukan `e` (path sensitif).
- **Cap slice anak** — sama dgn main.js.

### preload.js
- **`filesAll` meneruskan `metric`** — arg ke-5 kini sampai ke main (sebelumnya dibuang → sort Allocated di All Files selalu pakai size).

### renderer (`public/index.html`)
- **Ganti metric me-reload All Files** — debounce effect kini bergantung `[filter, metric]` (sebelumnya ganti metric tidak reload).
- **Alignment treemap fixed** — `cap200` re-sort setelah append "Others" agar urutan `tmItems` konsisten dengan sort desc internal `squarify` (cegah tile↔item misalignment / klik salah target).
- **Notifikasi cap folder besar** — nota `truncated` ditampilkan di bilah bawah.

### test
- **electron-smoke** — filter noise initer Chromium yang jinak (`cache_util_win`/`disk_cache.cc` `Unable to ... cache`; artifact environment stale/locked cache, non-fatal) agar tidak jadi false positive. Total **6/6 suite PASS** (`exit=0`).

## 0.3.2 — 2026-11-26
### Parity WizTree
- **Kolom sortable** — klik header **Name / Size / Allocated** utk mengurutkan (default size menurun, ala WizTree).
- **Treemap warna per ekstensi** — file diwarnai berdasarkan tipe (hash ekstensi), folder memakai palet; label disembunyikan di tile yang terlalu kecil.
- **Drill treemap** — klik folder meng-akar ulang treemap ke folder tsb (tombol ↑ kembali ke akar); klik file tidak lagi melompat ke root.
- **Menu konteks** (klik kanan di baris/tile): *Open in Explorer*, *Copy path*.
### Perbaikan
- **All Files kosong di root MFT** — cache key (`C:\`) vs node.path (`C:`) tidak sinkron → normalisasi `normDrive`; `files-all` kini terisi penuh untuk volume.
- **Subfolder cache-hit kehilangan `path`** — slice dari cache kini menetapkan path node, sehingga All Files & openPath benar untuk subtree.
- **Server MFT bisa permanen mati** — `ensureServer` kini men-spawn ulang bila child mati (dead), bukan diam-diam jatuh ke fallback.
- **Framer stdout O(n²)** — akumulasi fragmen (fix mikro saat tree besar) + bounding panjang respon anti-OOM.
- **Progres MFT dithrottle** (120ms) + guard `sender.isDestroyed()` (cegah throw saat window tertutup di tengah scan).
- **`files-all` urut sesuai metrik** — mode Allocated kini urut berdasarkan ukuran teralokasi, bukan logis.
- **All Files di-reset** saat rescan; `ensureChildren` tidak lagi nyangkut `_loading` bila ada scan baru.

## 0.3.1 — 2026-11-26
### Perbaikan
- **Installer**: `wiztri setup.exe` sebelumnya hanya pointer Git-LFS 133 B (belum bersih, tak bisa diinstal) — dibangun ulang jadi NSIS asli ±82 MB.
- **Pengujian**: `npm test` kini juga menjalankan `serve.spec.mjs` & `ui-logic.spec.mjs` (sebelumnya hanya 4 suite).

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
