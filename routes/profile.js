const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');

router.get('/', auth, async (req, res) => {
  const db = getDb();
  res.json(await db.prepare('SELECT * FROM company_profile LIMIT 1').get() || {});
});

router.put('/', auth, async (req, res) => {
  const db = getDb();
  const { nama, alamat, telp, email, website, npwp, rekening, bank, atas_nama } = req.body;
  const before = await db.prepare('SELECT * FROM company_profile LIMIT 1').get();
  const existing = before;
  if (existing) {
    await db.prepare('UPDATE company_profile SET nama=?,alamat=?,telp=?,email=?,website=?,npwp=?,rekening=?,bank=?,atas_nama=?,updated_at=NOW() WHERE id=?')
      .run(nama,alamat,telp,email,website||'',npwp||'',rekening||'',bank||'',atas_nama||'',existing.id);
  } else {
    await db.prepare('INSERT INTO company_profile (nama,alamat,telp,email,website,npwp,rekening,bank,atas_nama) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id')
      .run(nama,alamat,telp,email,website||'',npwp||'',rekening||'',bank||'',atas_nama||'');
  }
  const after = await db.prepare('SELECT * FROM company_profile LIMIT 1').get();
  await recordAudit(db, { user: req.user, aksi: existing ? 'update' : 'create', modul:'Profil Usaha', record_id: after?.id, record_label: nama, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

module.exports = router;
