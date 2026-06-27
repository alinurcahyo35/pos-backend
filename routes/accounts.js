const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM accounts ORDER BY kode').all();
  sendCsv(res, 'daftar_akun.csv', all, [
    { key:'kode', label:'Kode' }, { key:'nama', label:'Nama Akun' }, { key:'jenis', label:'Jenis' },
    { key:'posisi', label:'Posisi' }, { key:'saldo_normal', label:'Saldo Normal' },
    { key:'kategori_neraca', label:'Kategori Neraca' }, { key:'saldo_awal_debet', label:'Saldo Awal Debet' },
    { key:'saldo_awal_kredit', label:'Saldo Awal Kredit' }, { key:'aktif', label:'Aktif' }
  ]);
});

// List all accounts
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { jenis, posisi, q } = req.query;
  let all = await db.prepare('SELECT * FROM accounts ORDER BY kode').all();
  if (jenis)  all = all.filter(a => a.jenis === jenis);
  if (posisi) all = all.filter(a => a.posisi === posisi);
  if (q) {
    const ql = q.toLowerCase();
    all = all.filter(a => a.kode.includes(q) || a.nama.toLowerCase().includes(ql));
  }
  res.json(all);
});

// List distinct jenis (for dropdown)
router.get('/jenis-list', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT DISTINCT jenis, posisi, saldo_normal FROM accounts').all();
  res.json(all);
});

// Create account
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { kode, nama, jenis, posisi, saldo_normal, kategori_neraca, saldo_awal_debet, saldo_awal_kredit } = req.body;
  try {
    await db.prepare('INSERT INTO accounts (kode,nama,jenis,posisi,saldo_normal,kategori_neraca,saldo_awal_debet,saldo_awal_kredit) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
      .run(kode, nama, jenis, posisi, saldo_normal, kategori_neraca||null, parseFloat(saldo_awal_debet)||0, parseFloat(saldo_awal_kredit)||0);
    const row = (await db.prepare('SELECT * FROM accounts').all()).sort((a,b)=>b.id-a.id)[0];
    await recordAudit(db, { user: req.user, aksi:'create', modul:'Daftar Akun', record_id: row.id, record_label: `${kode} - ${nama}`, data_sesudah: row });
    res.json(row);
  } catch(e) { res.status(400).json({ error: 'Kode akun sudah dipakai' }); }
});

// Update account
router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { kode, nama, jenis, posisi, saldo_normal, kategori_neraca, saldo_awal_debet, saldo_awal_kredit, aktif } = req.body;
  const before = await db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  await db.prepare('UPDATE accounts SET kode=?,nama=?,jenis=?,posisi=?,saldo_normal=?,kategori_neraca=?,saldo_awal_debet=?,saldo_awal_kredit=?,aktif=? WHERE id=?')
    .run(kode, nama, jenis, posisi, saldo_normal, kategori_neraca||null, parseFloat(saldo_awal_debet)||0, parseFloat(saldo_awal_kredit)||0, aktif===false?0:1, req.params.id);
  const after = await db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Daftar Akun', record_id: req.params.id, record_label: `${kode} - ${nama}`, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

// Delete account
router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const acc = (await db.prepare('SELECT * FROM accounts').all()).find(a => a.id === id);
  if (!acc) return res.status(404).json({ error: 'Akun tidak ditemukan' });
  // Cek apakah akun dipakai di jurnal
  const used = (await db.prepare('SELECT * FROM journal_lines').all()).some(l => l.account_kode === acc.kode);
  if (used) return res.status(400).json({ error: 'Akun ini sudah dipakai di jurnal, tidak bisa dihapus' });
  await db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Daftar Akun', record_id: id, record_label: `${acc.kode} - ${acc.nama}`, data_sebelum: acc });
  res.json({ success: true });
});

module.exports = router;
