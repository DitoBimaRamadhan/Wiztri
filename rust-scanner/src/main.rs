// wiztri-scan — pembaca mentah $MFT (NTFS) untuk ukuran disk cepat ala WizTree.
// Cara pakai: wiztri-scan.exe C   (membuka \\.\C: ; butuh hak Administrat)
//   atau:      wiztri-scan.exe C:\path\fake.img (mode uji: baca file volume)
// Output: pohon JSON ke stdout, shape sama dengan scan Node (name/size/alloc/children).
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

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
    for i in 1..count {
        let pos = i * bps;
        if pos >= 2 && pos <= buf.len() && usoff + i * 2 + 2 <= buf.len() {
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
    while o + 8 <= buf.len() && o < used {
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
                        // preferensi: ns 2 (Win32+DOS) diutamakan; jika belum ada
                        // nama, ambil apa pun (hindari nama DOS pendek menimpa panjang)
                        if nspace == 2 || name.is_none() { name = Some(s); }
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
    while o + 8 <= buf.len() && o < used {
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

fn emit_children(p: u64, by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node],
                mem: &HashMap<u64, (u64, u64)>, out: &mut String, depth: usize) {
    if depth > 128 { return; }
    if let Some(ids) = by_parent.get(&p) {
        let mut ids: Vec<usize> = ids.iter().copied().filter(|&i| nodes[i].frn != p).collect();
        ids.sort_by(|&a, &b| {
            let (sa, _) = mem.get(&nodes[a].frn).copied().unwrap_or((nodes[a].size, 0));
            let (sb, _) = mem.get(&nodes[b].frn).copied().unwrap_or((nodes[b].size, 0));
            sb.cmp(&sa)
        });
        for (i, &idx) in ids.iter().enumerate() {
            if i > 0 { out.push(','); }
            let n = &nodes[idx];
            out.push_str("{\"name\":\"");
            esc(&n.name, out);
            out.push_str("\",\"size\":");
            if n.is_dir {
                let (s, a) = mem.get(&n.frn).copied().unwrap_or((0, 0));
                out.push_str(&s.to_string());
                out.push_str(",\"alloc\":");
                out.push_str(&a.to_string());
                out.push_str(",\"children\":[");
                emit_children(n.frn, by_parent, nodes, mem, out, depth + 1);
                out.push_str("]}");
            } else {
                // file: tanpa kunci children (sama dgn backend Node) agar renderer
                // bisa bedakan file vs folder kosong via Array.isArray(children)
                out.push_str(&n.size.to_string());
                out.push_str(",\"alloc\":");
                out.push_str(&n.alloc.to_string());
                out.push_str("}");
            }
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
                  by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node],
                  mem: &HashMap<u64, (u64, u64)>, out: &mut String) {
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
    emit_children(frn, by_parent, nodes, mem, out, 0);
    out.push_str("]}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let raw = args.get(1).cloned().unwrap_or_else(|| "C".to_string());
    let filter = args.get(2).cloned();
    // mode device bila 1 huruf; selain itu anggap path file (mode uji).
    let device_mode = raw.len() == 1 && raw.chars().next().unwrap().is_ascii_alphabetic();
    let target = if device_mode { format!("\\\\.\\{}:", raw.to_uppercase()) } else { raw.clone() };

    let mut f = match File::open(&target) {
        Ok(f) => f,
        Err(e) => {
            let mut s = String::from("{\"error\":\"no_volume_access\",\"detail\":\"");
            esc(&e.to_string(), &mut s);
            s.push_str("\"}");
            println!("{}", s);
            std::process::exit(2);
        }
    };

    let mut boot = [0u8; 512];
    if f.seek(SeekFrom::Start(0)).is_err() || f.read_exact(&mut boot).is_err() {
        println!("{}", r#"{"error":"read_boot"}"#);
        std::process::exit(3);
    }
    if &boot[3..7] != b"NTFS" {
        println!("{}", r#"{"error":"not_ntfs"}"#);
        std::process::exit(4);
    }
    let bps = rd_u16(&boot, 0x0b) as usize;
    let spc = boot[0x0d] as usize;
    if bps < 256 || spc == 0 {
        println!("{}", r#"{"error":"bad_geometry"}"#);
        std::process::exit(5);
    }
    let cluster = bps * spc;
    let mft_start = rd_u64(&boot, 0x30) * cluster as u64;
    let cpm = boot[0x40] as i8;
    let rec_size = if cpm > 0 {
        let rs = cpm as usize * cluster;
        if rs > (1 << 20) { println!("{}", r#"{"error":"bad_record_size"}"#); std::process::exit(6); }
        rs
    } else {
        let sh = (-(cpm as i32)) as usize;
        // guard: catatan > 2MB tak masuk akal utk $MFT; cegah OOM dr geometri rusak
        if sh >= 21 { println!("{}", r#"{"error":"bad_record_size"}"#); std::process::exit(6); }
        1usize << sh
    };

    // Baca rekaman 0 utk ukuran $MFT
    let mut record0 = vec![0u8; rec_size];
    if f.seek(SeekFrom::Start(mft_start)).is_err() || f.read_exact(&mut record0).is_err() {
        println!("{}", r#"{"error":"read_mft0"}"#);
        std::process::exit(7);
    }
    fixup(&mut record0, bps);
    let mft_bytes = match parse_mft_bytes(&record0) {
        Some(b) => b,
        None => { println!("{}", r#"{"error":"mft_no_data"}"#); std::process::exit(8); }
    };
    let total_recs = (mft_bytes / rec_size as u64).min(300_000_000);

    // mundurkan cursor ke awal $MFT (readsaman 0 sudah dibaca untuk metadata)
    if f.seek(SeekFrom::Start(mft_start)).is_err() {
        println!("{}", r#"{"error":"read_mft0"}"#);
        std::process::exit(7);
    }

    // Kapasitas konservatif: jangan reservasi dari batas 300M (bisa alokasi ~2GB
    // virtual untuk volume kecil). Pakai perkiraan wajar dari ukuran $MFT aktual.
    let est_nodes = (mft_bytes / (rec_size as u64 * 2)).min(4_000_000) as usize;
    let mut nodes: Vec<Node> = Vec::with_capacity(est_nodes);
    let mut by_parent: HashMap<u64, Vec<usize>> = HashMap::with_capacity(est_nodes / 8);

    let chunk_recs = rec_size.saturating_mul(2048).clamp(1 << 20, 8 << 20);
    let mut chunk = vec![0u8; chunk_recs];
    let mut frn: u64 = 0;
    let mut remaining = total_recs;

    while remaining > 0 {
        let want = chunk_recs.min((remaining as usize) * rec_size);
        let mut got = 0usize;
        let mut eof = false;
        while got < want {
            match f.read(&mut chunk[got..want]) {
                Ok(0) => { eof = true; break; }
                Ok(n) => got += n,
                Err(_) => { eof = true; break; }
            }
        }
        // proses byte yang sudah terbaca dulu, walau EOF/error (jangan buang tail)
        if got > 0 {
            let recs = got / rec_size;
            for r in 0..recs {
                let start = r * rec_size;
                {
                    let rec = &mut chunk[start..start + rec_size];
                    if &rec[0..4] == b"FILE" {
                        fixup(rec, bps);
                        if let Some(n) = parse_record(rec, frn + r as u64) {
                            let idx = nodes.len();
                            by_parent.entry(n.parent).or_default().push(idx);
                            nodes.push(n);
                        }
                    }
                }
            }
            frn += recs as u64;
            remaining -= recs as u64;
        }
        if eof || got < want { break; }
    }

    // ---- hitung ukuran agregat (dengan proteksi siklus) ----
    fn calc(p: u64, by_parent: &HashMap<u64, Vec<usize>>, nodes: &[Node],
            mem: &mut HashMap<u64, (u64, u64)>, seen: &mut HashMap<u64, bool>, depth: usize) -> (u64, u64) {
        if depth > 128 { return (0, 0); }
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

    let mut mem: HashMap<u64, (u64, u64)> = HashMap::new();
    let mut seen: HashMap<u64, bool> = HashMap::new();
    // Akar output: 5 (akar volume) bila tanpa filter; bila ada filter, node yang cocok.
    let root_frn = match &filter {
        Some(f) => match find_node_by_path(5, f, &by_parent, &nodes) {
            Some(frn) => frn,
            None => { println!("{}", r#"{"error":"path_not_found"}"#); std::process::exit(9); }
        },
        None => 5,
    };
    calc(root_frn, &by_parent, &nodes, &mut mem, &mut seen, 0);

    let mut out = String::with_capacity((nodes.len() * 64).max(1 << 20));
    if root_frn == 5 {
        let name_label = if device_mode { raw.to_uppercase() } else { raw.clone() };
        let path_label = if device_mode { format!("{}:", raw.to_uppercase()) } else { raw.clone() };
        emit_root_node(5, &name_label, &path_label, &by_parent, &nodes, &mem, &mut out);
    } else if let Some(idx) = nodes.iter().position(|n| n.frn == root_frn) {
        let n = &nodes[idx];
        let pl = filter.as_deref().unwrap_or("").replace('/', "\\");
        emit_root_node(root_frn, &n.name, &pl, &by_parent, &nodes, &mem, &mut out);
    } else {
        println!("{}", r#"{"error":"path_not_found"}"#);
        std::process::exit(9);
    }
    println!("{}", out);
}
