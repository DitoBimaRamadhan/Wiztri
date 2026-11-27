// wiztri-scan — pembaca mentah $MFT (NTFS) untuk ukuran disk cepat ala WizTree.
// Cara pakai: wiztri-scan.exe C   (membuka \\.\C: ; butuh hak Administrat)
//   atau:      wiztri-scan.exe C:\path\fake.img (mode uji: baca file volume)
// Output: pohon JSON ke stdout, shape sama dengan scan Node (name/size/alloc/children).
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};

// Ter-set bila ada folder > kedalaman 128 terpotong; muncul sebagai catatan di JSON.
static TRUNCATED: AtomicBool = AtomicBool::new(false);
// Ter-set bila limit (per-query) memotong jumlah anak/level; note berbeda.
static TRUNCATED_LIMIT: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct Node {
    frn: u64,
    parent: u64,
    name: String,
    size: u64,   // ukuran logis
    alloc: u64,  // ukuran teralokasi
    is_dir: bool,
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn rd_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([
        b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7],
    ])
}

// Perbaiki fixup (USN): ganti 2 byte TERAKHIR tiap sektor dgn nilai dari US array.
fn fixup(buf: &mut [u8], bps: usize) {
    if buf.len() < 8 || bps < 2 { return; }
    let usoff = rd_u16(buf, 0x04) as usize;
    let count = rd_u16(buf, 0x06) as usize;
    if usoff == 0 || count < 2 || usoff + count * 2 > buf.len() { return; }
    // USN asli (entri ke-0) — referensi utk validasi fixup.
    let (usn_hi, usn_lo) = (buf[usoff], buf[usoff + 1]);
    for i in 1..count {
        let pos = i * bps;
        if pos >= 2 && pos <= buf.len() && usoff + i * 2 + 2 <= buf.len() {
            // Bila 2 byte terakhir sektor != USN, rekaman korup/non-fixup -> lewati
            // (jangan menimpa dgn nilai sampah, mencegah parse salah senyap).
            if buf[pos - 2] != usn_hi || buf[pos - 1] != usn_lo { continue; }
            let src = [buf[usoff + i * 2], buf[usoff + i * 2 + 1]];
            buf[pos - 2..pos].copy_from_slice(&src);
        }
    }
}

fn utf16(buf: &[u8]) -> String {
    if buf.is_empty() { return String::new(); }
    let u16s: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&u16s)
}

// Parse satu rekaman MFT -> Node (None bila bukan FILE / tak aktif / tanpa FILE_NAME).
// Catatan: self-parenting (frn==parent) NORMAL di NTFS utk akar (frn 5) — akar
// menunjuk dirinya sendiri. Bukan bug. Guard utk itu di emit_children (filter frn!=p)
// dan calc (map seen) sengaja ada, jadi rekaman self-parent tak bikin loop.
fn parse_record(buf: &[u8], frn: u64) -> Option<Node> {
    if buf.len() < 0x1c { return None; }
    if &buf[0..4] != b"FILE" { return None; }
    let flags = rd_u16(buf, 0x16);
    if flags & 0x0001 == 0 { return None; }
    let is_dir = flags & 0x0002 != 0;
    let attr_off = rd_u16(buf, 0x14) as usize;
    let mut o = attr_off;
    let used = rd_u32(buf, 0x18) as usize;
    let mut parent: Option<u64> = None;
    let mut name: Option<String> = None;
    let mut size: u64 = 0;
    let mut alloc: u64 = 0;
    while o + 8 < buf.len() && o < used {
        let ty = rd_u32(buf, o);
        if ty == 0xFFFFFFFF { break; }
        let len = rd_u32(buf, o + 4) as usize;
        if len == 0 || o + len > buf.len() || o + len > used { break; }
        let nonresid = buf[o + 8] != 0;
        // guard baca vlen/voff (o+0x10/o+0x14) agar tak OOB utk attr resident pendek/rusak
        if ty == 0x30 && !nonresid && parent.is_none() && o + 0x16 <= buf.len() {
            let vlen = rd_u32(buf, o + 0x10) as usize;
            let voff = rd_u16(buf, o + 0x14) as usize;
            let vb = o + voff;
            if vb + 0x42 <= buf.len() && vlen >= 0x42 {
                parent = Some(rd_u64(buf, vb) & 0x0000_FFFF_FFFF_FFFF);
                alloc = rd_u64(buf, vb + 0x28);
                size = rd_u64(buf, vb + 0x30);
                let nlen = buf[vb + 0x40] as usize;
                let nspace = buf[vb + 0x41];
                if nlen > 0 && vb + 0x42 + nlen * 2 <= buf.len() {
                    let s = utf16(&buf[vb + 0x42..vb + 0x42 + nlen * 2]);
                    if !s.is_empty() {
                        // Prioritas: nama PANJANG (nspace 1/3) diutamakan; alias DOS
                        // pendek (nspace 2) hanya dipakai bila belum ada nama sama
                        // sekali. (Sebelumnya ns 2 menimpa nama panjang.)
                        if nspace != 2 || name.is_none() { name = Some(s); }
                    }
                }
            }
        }
        o += len;
    }
    parent?;
    if name.is_none() { return None; }
    Some(Node { frn, parent: parent.unwrap(), name: name.unwrap(), size, alloc, is_dir })
}

fn esc(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

// Hitung ukuran (byte) $MFT dari rekaman 0: baca atribut DATA.
fn parse_mft_bytes(buf: &[u8]) -> Option<u64> {
    if buf.len() < 0x1c || &buf[0..4] != b"FILE" { return None; }
    let mut o = rd_u16(buf, 0x14) as usize;
    let used = rd_u32(buf, 0x18) as usize;
    while o + 8 < buf.len() && o < used {
        let ty = rd_u32(buf, o);
        if ty == 0xFFFFFFFF { break; }
        let len = rd_u32(buf, o + 4) as usize;
        if len == 0 || o + len > buf.len() || o + len > used { break; }
        if ty == 0x80 {
            if buf[o + 8] != 0 {
                // non-resident: DataSize @0x30 (bukan 0x2c yg campur dgn AllocatedSize)
                if o + 0x38 <= buf.len() {
                    return Some(rd_u64(buf, o + 0x30));
                }
            } else {
                if o + 0x12 <= buf.len() {
                    let vlen = rd_u32(buf, o + 0x10) as u64;
                    return Some(vlen);
                }
            }
        }
        o += len;
    }
    None
}

// Batas ukuran respon JSON (anti-OOM). Bila terlampaui, hentikan emit dan tandai
// TRUNCATED agar note "depth_truncated" menyertai root.
const MAX_RESP_BYTES: usize = 64 << 20;

// Bangun peta anak per-parent yang SUDAH urut ukuran menurun, sekali per volume
// (pasca-calc). emit_children tinggal pakai, tanpa sort ulang per query.
fn build_sorted_children(by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node],
                         mem: &HashMap<u64, (u64, u64)>) -> HashMap<u64, Vec<usize>> {
    let mut out = HashMap::with_capacity(by_parent.len());
    for (&p, ids) in by_parent {
        let mut v: Vec<usize> = ids.iter().copied().filter(|&i| nodes[i].frn != p).collect();
        v.sort_by(|&a, &b| {
            let (sa, _) = mem.get(&nodes[a].frn).copied().unwrap_or((nodes[a].size, 0));
            let (sb, _) = mem.get(&nodes[b].frn).copied().unwrap_or((nodes[b].size, 0));
            sb.cmp(&sa)
        });
        out.insert(p, v);
    }
    out
}

fn emit_children(p: u64, sorted: &HashMap<u64, Vec<usize>>, nodes: &[Node],
                mem: &HashMap<u64, (u64, u64)>, out: &mut String, depth: usize,
                limit: usize, budget: &mut usize) {
    if depth > 128 { TRUNCATED.store(true, Ordering::Relaxed); return; }
    if let Some(ids) = sorted.get(&p) {
        let count = if limit == 0 { ids.len() } else { ids.len().min(limit) };
        if count < ids.len() { TRUNCATED_LIMIT.store(true, Ordering::Relaxed); }
        for (i, &idx) in ids.iter().take(count).enumerate() {
            // Enforce budget ketat: cek SEBELUM tulis header anak (bukan hanya
            // antar-saudara) agar satu subtree penuh tidak melewati 64MB.
            if *budget == 0 {
                TRUNCATED.store(true, Ordering::Relaxed);
                break;
            }
            if i > 0 { out.push(','); *budget = budget.saturating_sub(1); }
            let n = &nodes[idx];
            out.push_str("{\"name\":\"");
            esc(&n.name, out);
            *budget = budget.saturating_sub(8);
            out.push_str("\",\"size\":");
            if n.is_dir {
                let (s, a) = mem.get(&n.frn).copied().unwrap_or((0, 0));
                out.push_str(&s.to_string());
                out.push_str(",\"alloc\":");
                out.push_str(&a.to_string());
                out.push_str(",\"children\":[");
                emit_children(n.frn, sorted, nodes, mem, out, depth + 1, limit, budget);
                out.push_str("]}");
            } else {
                // file: tanpa kunci children (sama dgn backend Node) agar renderer
                // bisa bedakan file vs folder kosong via Array.isArray(children)
                out.push_str(&n.size.to_string());
                out.push_str(",\"alloc\":");
                out.push_str(&n.alloc.to_string());
                out.push_str("}");
            }
            if out.len() >= MAX_RESP_BYTES { *budget = 0; }
        }
    }
}

// Cari FRN node yang jalurnya cocok dgn filter (case-insensitive), mulai dari akar.
// Filter = jalur Windows penuh (mis. "C:\Users\foo"); awalan drive dibuang.
fn find_node_by_path(root_frn: u64, filter: &str, by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node]) -> Option<u64> {
    let mut f = filter.replace('/', "\\");
    if f.len() >= 2 && f.as_bytes()[1] == b':' {
        f = f[2..].to_string();
    }
    let mut cur = root_frn;
    for part in f.split('\\').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let low = part.to_lowercase();
        let mut found = None;
        if let Some(ids) = by_parent.get(&cur) {
            for &i in ids {
                let n = &nodes[i];
                if n.frn == cur { continue; }
                if n.name.to_lowercase() == low { found = Some(n.frn); break; }
            }
        }
        cur = found?;
    }
    Some(cur)
}

// Emit JSON subtree berakar di `frn` (nama + path diberi dari luar).
fn emit_root_node(frn: u64, name: &str, path_label: &str,
                  sorted: &HashMap<u64, Vec<usize>>, nodes: &[Node],
                  mem: &HashMap<u64, (u64, u64)>, out: &mut String, limit: usize) {
    // Budget respon seluruh subtree (anti-OOM ketat).
    let mut budget = MAX_RESP_BYTES;
    // Prefer total subtree (mem). Untuk file (bukan folder), pakai ukuran node sendiri.
    let (mut s, mut a) = mem.get(&frn).copied().unwrap_or((0, 0));
    if let Some(n) = nodes.iter().find(|n| n.frn == frn) {
        if !n.is_dir { s = n.size; a = n.alloc; }
    }
    out.push_str("{\"name\":\"");
    esc(name, out);
    out.push_str("\",\"path\":\"");
    esc(path_label, out);
    out.push_str("\",\"size\":");
    out.push_str(&s.to_string());
    out.push_str(",\"alloc\":");
    out.push_str(&a.to_string());
    out.push_str(",\"children\":[");
    emit_children(frn, sorted, nodes, mem, out, 0, limit, &mut budget);
    out.push_str("]");
    // Note: lebih dari satu penyebab -> gabung dgn koma.
    let mut notes = Vec::new();
    if TRUNCATED.load(Ordering::Relaxed) { notes.push("depth_truncated"); }
    if TRUNCATED_LIMIT.load(Ordering::Relaxed) { notes.push("limit_truncated"); }
    if !notes.is_empty() {
        out.push_str(",\"note\":\"");
        out.push_str(&notes.join(","));
        out.push_str("\"");
    }
    out.push_str("}");
}

// Hitung ukuran agregat (dengan proteksi siklus). Memoisasi global per volume.
fn calc(p: u64, by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node],
        mem: &mut HashMap<u64, (u64, u64)>, seen: &mut HashMap<u64, bool>, depth: usize) -> (u64, u64) {
    if depth > 128 { TRUNCATED.store(true, Ordering::Relaxed); return (0, 0); }
    if seen.get(&p).copied().unwrap_or(false) { return (0, 0); }
    if let Some(&v) = mem.get(&p) { return v; }
    seen.insert(p, true);
    let mut s = 0u64;
    let mut a = 0u64;
    if let Some(list) = by_parent.get(&p) {
        for &idx in list {
            let n = &nodes[idx];
            if n.is_dir {
                let (cs, ca) = calc(n.frn, by_parent, nodes, mem, seen, depth + 1);
                s += cs; a += ca;
            } else {
                s += n.size; a += n.alloc;
            }
        }
    }
    seen.insert(p, false);
    mem.insert(p, (s, a));
    (s, a)
}

struct Vol {
    nodes: Vec<Node>,
    by_parent: HashMap<u64, Vec<usize>>,
}

// Baca $MFT penuh sekali -> nodes + by_parent. `progress` menyalakan laporan
// `P <count> <total>` ke stderr (dipakai mode layanan untuk UI nyata).
fn load_vol(target: &str, progress: bool) -> Result<Vol, String> {
    let mut f = File::open(target).map_err(|e| {
        let mut s = String::from("{\"error\":\"no_volume_access\",\"detail\":\"");
        esc(&e.to_string(), &mut s);
        s.push_str("\"}");
        s
    })?;
    let mut boot = [0u8; 512];
    if f.seek(SeekFrom::Start(0)).is_err() || f.read_exact(&mut boot).is_err() {
        return Err(r#"{"error":"read_boot"}"#.into());
    }
    if &boot[3..7] != b"NTFS" { return Err(r#"{"error":"not_ntfs"}"#.into()); }
    let bps = rd_u16(&boot, 0x0b) as usize;
    let spc = boot[0x0d] as usize;
    if bps < 256 || spc == 0 { return Err(r#"{"error":"bad_geometry"}"#.into()); }
    let cluster = bps * spc;
    let mft_start = rd_u64(&boot, 0x30) * cluster as u64;
    let cpm = boot[0x40] as i8;
    let rec_size = if cpm > 0 {
        let rs = cpm as usize * cluster;
        if rs > (1 << 20) { return Err(r#"{"error":"bad_record_size"}"#.into()); }
        rs
    } else {
        let sh = (-(cpm as i32)) as usize;
        // guard: catatan > 2MB tak masuk akal utk $MFT; cegah OOM dr geometri rusak
        if sh >= 21 { return Err(r#"{"error":"bad_record_size"}"#.into()); }
        1usize << sh
    };
    // Rekaman $MFT minimal satu sektor (512B); geometri < itu = korup (cegah
    // alokasi/loop aneh untuk rec_size=2, dst).
    if rec_size < 512 { return Err(r#"{"error":"bad_geometry"}"#.into()); }

    // Baca rekaman 0 utk ukuran $MFT
    let mut record0 = vec![0u8; rec_size];
    if f.seek(SeekFrom::Start(mft_start)).is_err() || f.read_exact(&mut record0).is_err() {
        return Err(r#"{"error":"read_mft0"}"#.into());
    }
    fixup(&mut record0, bps);
    let mft_bytes = match parse_mft_bytes(&record0) {
        Some(b) => b,
        None => return Err(r#"{"error":"mft_no_data"}"#.into()),
    };
    let total_recs = (mft_bytes / rec_size as u64).min(300_000_000);

    // mundurkan cursor ke awal $MFT (readsaman 0 sudah dibaca untuk metadata)
    if f.seek(SeekFrom::Start(mft_start)).is_err() {
        return Err(r#"{"error":"read_mft0"}"#.into());
    }

    // Kapasitas konservatif: jangan reservasi dari batas 300M (bisa alokasi ~2GB
    // virtual untuk volume kecil). Pakai perkiraan wajar dari ukuran $MFT aktual.
    let est_nodes = (mft_bytes / (rec_size as u64 * 2)).min(4_000_000) as usize;
    let mut nodes: Vec<Node> = Vec::with_capacity(est_nodes);
    let mut by_parent: HashMap<u64, Vec<usize>> = HashMap::with_capacity(est_nodes / 8);

    // Chunk lebih besar biar parse paralel berguna (I/O + CPU tumpang-tindih).
    let chunk_recs = rec_size.saturating_mul(65536).clamp(1 << 20, 32 << 20);
    let mut chunk = vec![0u8; chunk_recs];
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).max(1);
    let mut frn: u64 = 0;
    let mut remaining = total_recs;

    while remaining > 0 {
        let want = chunk_recs.min((remaining as usize) * rec_size);
        let mut got = 0usize;
        let mut eof = false;
        let mut io_err: Option<String> = None;
        while got < want {
            match f.read(&mut chunk[got..want]) {
                Ok(0) => { eof = true; break; }
                Ok(n) => got += n,
                Err(e) => { io_err = Some(e.to_string()); eof = true; break; }
            }
        }
        // Parse rekaman PARALEL (std thread::scope; tanpa dep). Tiap benang
        // meng-copy rekaman sendiri utk fixup (mutasi lokal) — disjoint, aman.
        if got > 0 {
            let recs = got / rec_size;
            let nrecs = recs;
            let c: &[u8] = &chunk;
            let nodes_batch: Vec<Node> = std::thread::scope(|s| {
                let per = (nrecs + workers - 1) / workers;
                let handles: Vec<_> = (0..workers)
                    .filter(|&si| si * per < nrecs)
                    .map(|si| {
                        let a = si * per;
                        let b = ((si + 1) * per).min(nrecs);
                        s.spawn(move || {
                            let mut v = Vec::with_capacity(b - a);
                            for r in a..b {
                                let start = r * rec_size;
                                let mut rec = c[start..start + rec_size].to_vec();
                                if &rec[0..4] == b"FILE" {
                                    fixup(&mut rec, bps);
                                    if let Some(n) = parse_record(&rec, frn + r as u64) {
                                        v.push(n);
                                    }
                                }
                            }
                            v
                        })
                    })
                    .collect();
                handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
            });
            let base_idx = nodes.len();
            for (li, n) in nodes_batch.into_iter().enumerate() {
                by_parent.entry(n.parent).or_default().push(base_idx + li);
                nodes.push(n);
            }
            frn += nrecs as u64;
            remaining -= nrecs as u64;
            // Progres: cetak tiap 4096 record DAN di akhir (agar UI mencapai 100%).
            if progress && (frn % 4096 == 0 || remaining == 0) {
                eprintln!("P {} {}", frn, total_recs);
            }
        }
        if let Some(e) = io_err {
            return Err(format!("{{\"error\":\"read_mft\",\"detail\":\"{}\"}}", e));
        }
        if eof || got < want { break; }
    }
    // Kirim progres selesai bila total_recs bukan kelipatan 4096 (med: stuck <100%).
    if progress && frn % 4096 != 0 {
        eprintln!("P {} {}", frn, total_recs);
    }
    Ok(Vol { nodes, by_parent })
}

// Mode layanan persisten: baca $MFT sekali untuk sebuah target (drive atau
// file volume uji), lalu layani banyak query subtree lewat stdin. Tiap baris =
// root path; "-" = akar volume; kosong/"quit" = tutup.
// Protokol: respon = baris panjang (desimal), lalu JSON sepanjang itu (tanpa
// newline). Path yang tak ketemu -> JSON {"error":"path_not_found"}.
fn run_serve(arg: &str) -> i32 {
    let first = arg.chars().next().unwrap_or('C');
    let device_mode = arg.len() == 1 && first.is_ascii_alphabetic();
    let drive = first;
    let target = if device_mode { format!("\\\\.\\{}:", drive.to_ascii_uppercase()) } else { arg.to_string() };
    let vol = match load_vol(&target, true) {
        Ok(v) => v,
        Err(e) => {
            // Jaga protokol: tulis error dengan framing length-prefixed SAMA seperti
            // respon normal, agar klien tidak misparse (sebelumnya JSON mentah).
            let stdout = std::io::stdout();
            let mut w = std::io::BufWriter::new(stdout.lock());
            let _ = writeln!(w, "{}", e.len());
            let _ = w.write_all(e.as_bytes());
            let _ = w.flush();
            return 2;
        }
    };
    let mut mem: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut seen: HashMap<u64, bool> = HashMap::new();
    calc(5, &vol.by_parent, &vol.nodes, &mut mem, &mut seen, 0);
    let sorted = build_sorted_children(&vol.by_parent, &vol.nodes, &mem);
    // Peta frn -> idx: gantikan O(n) `position()` per query dgn O(1).
    let frn_idx: HashMap<u64, usize> = vol.nodes.iter().enumerate()
        .map(|(i, n)| (n.frn, i)).collect();

    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    let mut input = std::io::stdin().lock();
    let mut linebuf = String::new();
    let mut out = String::with_capacity(1 << 20);
    loop {
        linebuf.clear();
        match input.read_line(&mut linebuf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let line = linebuf.trim().to_string();
        if line.is_empty() || line.eq_ignore_ascii_case("quit") || line.eq_ignore_ascii_case("exit") { break; }
        TRUNCATED.store(false, Ordering::Relaxed);
        TRUNCATED_LIMIT.store(false, Ordering::Relaxed);
        // Format: "<path>\t<limit>" — tab pemisah (tab DILARANG di nama berkas
        // NTFS, jadi tidak ambigu walau path ber-spasi / berakhiran angka).
        // `limit` opsional; 0 = tanpa batas.
        let (path, limit): (String, usize) = match line.split_once('\t') {
            Some((p, l)) => (p.trim().to_string(), l.trim().parse().unwrap_or(0)),
            None => (line.clone(), 0),
        };
        let root_frn = if path == "-" { 5 } else {
            match find_node_by_path(5, &path, &vol.by_parent, &vol.nodes) {
                Some(f) => f,
                None => {
                    out.clear();
                    out.push_str(r#"{"error":"path_not_found"}"#);
                    let _ = writeln!(w, "{}", out.len());
                    let _ = w.write_all(out.as_bytes());
                    let _ = w.flush();
                    continue;
                }
            }
        };
        out.clear();
        if root_frn == 5 {
            let name_label = if device_mode { format!("{}:", drive.to_ascii_uppercase()) } else { arg.to_string() };
            let path_label = name_label.clone();
            emit_root_node(5, &name_label, &path_label, &sorted, &vol.nodes, &mem, &mut out, limit);
        } else if let Some(&idx) = frn_idx.get(&root_frn) {
            let n = &vol.nodes[idx];
            let nm = n.name.clone();
            let pl = path.replace('/', "\\");
            emit_root_node(root_frn, &nm, &pl, &sorted, &vol.nodes, &mem, &mut out, limit);
        } else {
            out.push_str(r#"{"error":"path_not_found"}"#);
        }
        let _ = writeln!(w, "{}", out.len());
        let _ = w.write_all(out.as_bytes());
        let _ = w.flush();
    }
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s == "--serve").unwrap_or(false) {
        let sr = args.get(2).cloned().unwrap_or_else(|| "C".to_string());
        std::process::exit(run_serve(&sr));
    }
    let raw = args.get(1).cloned().unwrap_or_else(|| "C".to_string());
    let filter = args.get(2).cloned();
    // mode device bila 1 huruf; selain itu anggap path file (mode uji).
    let device_mode = raw.len() == 1 && raw.chars().next().unwrap().is_ascii_alphabetic();
    let target = if device_mode { format!("\\\\.\\{}:", raw.to_uppercase()) } else { raw.clone() };

    let vol = match load_vol(&target, false) {
        Ok(v) => v,
        Err(e) => { println!("{}", e); std::process::exit(2); }
    };

    let mut mem: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut seen: HashMap<u64, bool> = HashMap::new();
    // Akar output: 5 (akar volume) bila tanpa filter; bila ada filter, node yang cocok.
    let root_frn = match &filter {
        Some(f) => match find_node_by_path(5, f, &vol.by_parent, &vol.nodes) {
            Some(frn) => frn,
            None => { println!("{}", r#"{"error":"path_not_found"}"#); std::process::exit(9); }
        },
        None => 5,
    };
    calc(root_frn, &vol.by_parent, &vol.nodes, &mut mem, &mut seen, 0);
    let sorted = build_sorted_children(&vol.by_parent, &vol.nodes, &mem);

    let mut out = String::with_capacity((vol.nodes.len() * 64).max(1 << 20));
    if root_frn == 5 {
        let name_label = if device_mode { raw.to_uppercase() } else { raw.clone() };
        let path_label = if device_mode { format!("{}:", raw.to_uppercase()) } else { raw.clone() };
        emit_root_node(5, &name_label, &path_label, &sorted, &vol.nodes, &mem, &mut out, 0);
    } else if let Some(idx) = vol.nodes.iter().position(|n| n.frn == root_frn) {
        let n = &vol.nodes[idx];
        let pl = filter.as_deref().unwrap_or("").replace('/', "\\");
        emit_root_node(root_frn, &n.name, &pl, &sorted, &vol.nodes, &mem, &mut out, 0);
    } else {
        println!("{}", r#"{"error":"path_not_found"}"#);
        std::process::exit(9);
    }
    println!("{}", out);
}
