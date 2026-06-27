const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const { journalAsset, deleteJournalsForAsset } = require('../db/journal_helper');

// Hitung penyusutan per tahun (metode garis lurus)
function hitungPenyusutan(asset) {
  const { nilai_beli, nilai_residu, masa_manfaat } = asset;
  if (!masa_manfaat || masa_manfaat <= 0) return 0;
  return (nilai_beli - nilai_residu) / masa_manfaat;
}

// Hitung nilai buku saat ini berdasarkan tanggal beli sampai hari ini
function hitungNilaiBuku(asset) {
  if (!asset.tanggal_beli) return asset.nilai_beli;
  const beli = new Date(asset.tanggal_beli);
  const now = new Date();
  const tahunBerjalan = Math.min(
    (now - beli) / (1000 * 60 * 60 * 24 * 365),
    asset.masa_manfaat
  );
  const totalPenyusutan = hitungPenyusutan(asset) * tahunBerjalan;
  return Math.max(asset.nilai_beli - totalPenyusutan, asset.nilai_residu);
}

async function genKode(db) {
  const last = await db.prepare("SELECT kode FROM assets ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'AST-001';
  const num = parseInt((last.kode||'').split('-')[1]||'0') + 1;
  return 'AST-' + String(num).padStart(3, '0');
}

function enrichAsset(a) {
  const penyusutan_per_tahun = hitungPenyusutan(a);
  const nilai_buku = hitungNilaiBuku(a);
  const akumulasi_penyusutan = Math.max(0, a.nilai_beli - nilai_buku);
  return { ...a, penyusutan_per_tahun, nilai_buku, akumulasi_penyusutan };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM assets ORDER BY kode').all();
  sendCsv(res, 'aset_tetap.csv', all.map(enrichAsset), [
    { key:'kode', label:'Kode' }, { key:'nama', label:'Nama Aset' },
    { key:'kategori', label:'Kategori' }, { key:'tanggal_beli', label:'Tanggal Beli' },
    { key:'nilai_beli', label:'Nilai Beli' }, { key:'nilai_residu', label:'Nilai Residu' },
    { key:'masa_manfaat', label:'Masa Manfaat (Tahun)' },
    { key:'penyusutan_per_tahun', label:'Penyusutan/Tahun' },
    { key:'nilai_buku', label:'Nilai Buku Sekarang' },
    { key:'account_kode', label:'Kode Akun' }, { key:'keterangan', label:'Keterangan' },
  ]);
});

// Template CSV untuk import massal
router.get('/import-template', auth, async (req, res) => {
  const contoh = [
    { nama:'Blender Commercial', kategori:'Peralatan', tanggal_beli:'2024-01-15', nilai_beli:3500000, nilai_residu:500000, masa_manfaat:5, keterangan:'Blender untuk produksi jus' },
    { nama:'Meja Kasir', kategori:'Furnitur', tanggal_beli:'2023-06-01', nilai_beli:1200000, nilai_residu:0, masa_manfaat:8, keterangan:'' },
  ];
  sendCsv(res, 'template_import_aset.csv', contoh, [
    { key:'nama', label:'Nama Aset' }, { key:'kategori', label:'Kategori' },
    { key:'tanggal_beli', label:'Tanggal Beli (YYYY-MM-DD)' },
    { key:'nilai_beli', label:'Nilai Beli' }, { key:'nilai_residu', label:'Nilai Residu' },
    { key:'masa_manfaat', label:'Masa Manfaat (Tahun)' }, { key:'keterangan', label:'Keterangan' },
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q, kategori } = req.query;
  let sql = 'SELECT * FROM assets WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND nama LIKE ?'; params.push(`%${q}%`); }
  if (kategori) { sql += ' AND kategori=?'; params.push(kategori); }
  sql += ' ORDER BY kode';
  const all = await db.prepare(sql).all(...params);
  res.json(all.map(enrichAsset));
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const a = await db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Aset tidak ditemukan' });
  res.json(enrichAsset(a));
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { nama, kategori='Peralatan', tanggal_beli, nilai_beli=0, nilai_residu=0, masa_manfaat=1, metode_penyusutan='garis_lurus', account_kode='116001', keterangan='' } = req.body;
  if (!nama || !tanggal_beli) return res.status(400).json({ error: 'Nama dan tanggal beli wajib diisi' });

  const kode = await genKode(db);
  await db.prepare(`INSERT INTO assets (kode,nama,kategori,tanggal_beli,nilai_beli,nilai_residu,masa_manfaat,metode_penyusutan,account_kode,keterangan) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(kode, nama, kategori, tanggal_beli, parseFloat(nilai_beli)||0, parseFloat(nilai_residu)||0, parseInt(masa_manfaat)||1, metode_penyusutan, account_kode, keterangan);

  const row = await db.prepare('SELECT * FROM assets WHERE kode=?').get(kode);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Aset Tetap', record_id: row.id, record_label: nama, data_sesudah: row });
  await journalAsset(db, row);
  res.json(enrichAsset(row));
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Aset tidak ditemukan' });

  const { nama, kategori, tanggal_beli, nilai_beli, nilai_residu, masa_manfaat, metode_penyusutan, account_kode, keterangan } = req.body;
  await db.prepare(`UPDATE assets SET nama=?,kategori=?,tanggal_beli=?,nilai_beli=?,nilai_residu=?,masa_manfaat=?,metode_penyusutan=?,account_kode=?,keterangan=?,updated_at=NOW() WHERE id=?`)
    .run(nama, kategori||'Peralatan', tanggal_beli, parseFloat(nilai_beli)||0, parseFloat(nilai_residu)||0, parseInt(masa_manfaat)||1, metode_penyusutan||'garis_lurus', account_kode||'116001', keterangan||'', req.params.id);

  const after = await db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Aset Tetap', record_id: req.params.id, record_label: nama, data_sebelum: before, data_sesudah: after });
  await journalAsset(db, after);
  res.json(enrichAsset(after));
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Aset tidak ditemukan' });
  await deleteJournalsForAsset(db, req.params.id);
  await db.prepare('DELETE FROM assets WHERE id=?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Aset Tetap', record_id: req.params.id, record_label: before.nama, data_sebelum: before });
  res.json({ success: true });
});

// Import massal dari CSV
router.post('/import', auth, async (req, res) => {
  const db = getDb();
  const { rows } = req.body; // [{ nama, kategori, tanggal_beli, nilai_beli, nilai_residu, masa_manfaat, keterangan }]
  if (!rows || !Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'Data kosong' });

  const results = { success: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.nama || !r.tanggal_beli) throw new Error('Nama dan tanggal beli wajib diisi');
      const kode = await genKode(db);
      await db.prepare(`INSERT INTO assets (kode,nama,kategori,tanggal_beli,nilai_beli,nilai_residu,masa_manfaat,metode_penyusutan,account_kode,keterangan) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
        .run(kode, r.nama.trim(), r.kategori||'Peralatan', r.tanggal_beli, parseFloat(r.nilai_beli)||0, parseFloat(r.nilai_residu)||0, parseInt(r.masa_manfaat)||1, 'garis_lurus', '116001', r.keterangan||'');
      const newAsset = await db.prepare('SELECT * FROM assets WHERE kode=?').get(kode);
      await journalAsset(db, newAsset);
      results.success++;
    } catch(e) {
      results.errors.push({ baris: i + 2, nama: r.nama||'(kosong)', error: e.message });
    }
  }
  res.json(results);
});

module.exports = router;
