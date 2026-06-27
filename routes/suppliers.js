const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genKode(db) {
  const all = await db.prepare('SELECT kode FROM suppliers').all();
  const nums = all.map(s => parseInt((s.kode||'').split('-')[1]) || 0);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'SUP-' + String(next).padStart(3, '0');
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM suppliers ORDER BY nama').all();
  sendCsv(res, 'pemasok.csv', all, [
    { key:'kode', label:'Kode' }, { key:'nama', label:'Nama' }, { key:'telp', label:'Telepon' },
    { key:'email', label:'Email' }, { key:'alamat', label:'Alamat' }, { key:'kota', label:'Kota' },
    { key:'pic', label:'PIC' }, { key:'created_at', label:'Dibuat Pada' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q } = req.query;
  let all = await db.prepare('SELECT * FROM suppliers ORDER BY nama').all();
  if (q) {
    const ql = q.toLowerCase();
    all = all.filter(s => s.nama?.toLowerCase().includes(ql) || s.kode?.toLowerCase().includes(ql) || (s.telp||'').includes(q));
  }
  res.json(all);
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { nama, telp, email, alamat, kota, pic } = req.body;
  const kode = await genKode(db);
  await db.prepare('INSERT INTO suppliers (kode,nama,telp,email,alamat,kota,pic) VALUES (?,?,?,?,?,?,?) RETURNING id')
    .run(kode, nama, telp||'', email||'', alamat||'', kota||'', pic||'');
  const all = await db.prepare('SELECT * FROM suppliers').all();
  const row = all.sort((a,b)=>b.id-a.id)[0];
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Pemasok', record_id: row.id, record_label: nama, data_sesudah: row });
  res.json(row);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { nama, telp, email, alamat, kota, pic } = req.body;
  const before = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  await db.prepare('UPDATE suppliers SET nama=?,telp=?,email=?,alamat=?,kota=?,pic=? WHERE id=?')
    .run(nama, telp||'', email||'', alamat||'', kota||'', pic||'', req.params.id);
  const after = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pemasok', record_id: req.params.id, record_label: nama, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM suppliers WHERE id=?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Pemasok', record_id: req.params.id, record_label: before?.nama, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
