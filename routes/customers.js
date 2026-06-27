const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

// Auto-generate kode customer
async function genKode(db) {
  const last = await db.prepare("SELECT kode FROM customers ORDER BY id DESC LIMIT 1").get();
  if (!last || !last.kode) return 'CST-001';
  const num = parseInt(last.kode.split('-')[1] || '0') + 1;
  return 'CST-' + String(num).padStart(3, '0');
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM customers ORDER BY nama').all();
  sendCsv(res, 'konsumen.csv', all, [
    { key:'kode', label:'Kode' }, { key:'nama', label:'Nama' }, { key:'telp', label:'Telepon' },
    { key:'email', label:'Email' }, { key:'alamat', label:'Alamat' }, { key:'kota', label:'Kota' },
    { key:'pic', label:'PIC' }, { key:'created_at', label:'Dibuat Pada' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q } = req.query;
  const all = await db.prepare('SELECT * FROM customers ORDER BY nama').all();
  if (!q) return res.json(all);
  const ql = q.toLowerCase();
  res.json(all.filter(c => c.nama?.toLowerCase().includes(ql) || c.kode?.toLowerCase().includes(ql) || c.telp?.includes(q)));
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { nama, telp, email, alamat, kota, pic } = req.body;
  const kode = await genKode(db);
  await db.prepare('INSERT INTO customers (kode,nama,telp,email,alamat,kota,pic) VALUES (?,?,?,?,?,?,?) RETURNING id').run(kode,nama,telp||'',email||'',alamat||'',kota||'',pic||'');
  const row = await db.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 1').get();
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Konsumen', record_id: row.id, record_label: nama, data_sesudah: row });
  res.json(row);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { nama, telp, email, alamat, kota, pic } = req.body;
  const before = await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  await db.prepare('UPDATE customers SET nama=?,telp=?,email=?,alamat=?,kota=?,pic=? WHERE id=?').run(nama,telp||'',email||'',alamat||'',kota||'',pic||'',req.params.id);
  const after = await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Konsumen', record_id: req.params.id, record_label: nama, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Konsumen', record_id: req.params.id, record_label: before?.nama, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
