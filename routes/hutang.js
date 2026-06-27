const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const {
  journalHutang, journalHutangPayment, deleteJournalsForHutang
} = require('../db/journal_helper');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genKode(db) {
  const last = await db.prepare("SELECT kode FROM hutang ORDER BY id DESC LIMIT 1").get();
  if (!last || !last.kode) return 'HUT-001';
  const num = parseInt(last.kode.split('-')[1] || '0') + 1;
  return 'HUT-' + String(num).padStart(3, '0');
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM hutang ORDER BY created_at DESC').all();
  sendCsv(res, 'hutang.csv', all, [
    { key:'kode', label:'Kode' }, { key:'nama_kreditur', label:'Kreditur' }, { key:'kategori', label:'Kategori' },
    { key:'jumlah', label:'Jumlah' }, { key:'tanggal', label:'Tanggal' }, { key:'jatuh_tempo', label:'Jatuh Tempo' },
    { key:'status', label:'Status' }, { key:'keterangan', label:'Keterangan' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { status } = req.query;
  let all = await db.prepare('SELECT * FROM hutang ORDER BY created_at DESC').all();
  if (status && status !== 'all') all = all.filter(h => h.status === status);

  const result = [];
  for (const h of all) {
    const payments = await db.prepare('SELECT * FROM hutang_payments WHERE hutang_id=?').all(h.id);
    const paid = payments.reduce((s,p) => s + p.jumlah, 0);
    result.push({ ...h, payments, paid, sisa: h.jumlah - paid });
  }
  res.json(result);
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { nama_kreditur, kategori, jumlah, tanggal, jatuh_tempo, keterangan } = req.body;
  const kode = await genKode(db);
  await db.prepare('INSERT INTO hutang (kode,nama_kreditur,kategori,jumlah,tanggal,jatuh_tempo,keterangan,status) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
    .run(kode,nama_kreditur,kategori,parseFloat(jumlah)||0,tanggal,jatuh_tempo||null,keterangan||'','unpaid');
  const all = await db.prepare('SELECT * FROM hutang').all();
  const row = all.sort((a,b)=>b.id-a.id)[0];

  await journalHutang(db, row);

  const result = { ...row, payments:[], paid:0, sisa:row.jumlah };
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Hutang', record_id: row.id, record_label: `${row.kode} - ${nama_kreditur}`, data_sesudah: result });
  res.json(result);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { nama_kreditur, kategori, jumlah, tanggal, jatuh_tempo, keterangan } = req.body;
  const before = await db.prepare('SELECT * FROM hutang WHERE id=?').get(id);
  await db.prepare('UPDATE hutang SET nama_kreditur=?,kategori=?,jumlah=?,tanggal=?,jatuh_tempo=?,keterangan=? WHERE id=?')
    .run(nama_kreditur,kategori,parseFloat(jumlah)||0,tanggal,jatuh_tempo||null,keterangan||'',id);

  const all = await db.prepare('SELECT * FROM hutang').all();
  const row = all.find(h => h.id === id);
  await journalHutang(db, row);

  await recordAudit(db, { user: req.user, aksi:'update', modul:'Hutang', record_id: id, record_label: `${row.kode} - ${nama_kreditur}`, data_sebelum: before, data_sesudah: row });
  res.json({ success: true });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const before = await db.prepare('SELECT * FROM hutang WHERE id=?').get(id);
  await db.prepare('DELETE FROM hutang_payments WHERE hutang_id=?').run(id);
  await db.prepare('DELETE FROM hutang WHERE id=?').run(id);

  await deleteJournalsForHutang(db, id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Hutang', record_id: id, record_label: before ? `${before.kode} - ${before.nama_kreditur}` : '', data_sebelum: before });
  res.json({ success: true });
});

router.post('/:id/bayar', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { tanggal, jumlah, metode='transfer', catatan='' } = req.body;
  await db.prepare('INSERT INTO hutang_payments (hutang_id,tanggal,jumlah,metode,catatan) VALUES (?,?,?,?,?) RETURNING id')
    .run(id, tanggal, parseFloat(jumlah), metode, catatan);

  const allH = await db.prepare('SELECT * FROM hutang').all();
  const h = allH.find(x => x.id === id);
  const payments = await db.prepare('SELECT * FROM hutang_payments WHERE hutang_id=?').all(id);
  const paid     = payments.reduce((s,p) => s + (p.jumlah||0), 0);
  const status   = paid >= h.jumlah ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  await db.prepare('UPDATE hutang SET status=? WHERE id=?').run(status, id);

  const newPayment = payments.sort((a,b)=>b.id-a.id)[0];
  await journalHutangPayment(db, h, newPayment);

  await recordAudit(db, { user: req.user, aksi:'update', modul:'Hutang', record_id: id, record_label: `Pembayaran ${h.kode}`, data_sesudah: newPayment });
  res.json({ success: true, status, paid, sisa: h.jumlah - paid });
});

module.exports = router;
