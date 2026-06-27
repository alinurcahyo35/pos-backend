const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');

function requireSuperadmin(req, res, next) {
  if (!['admin','direksi'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Hanya Superadmin yang dapat mengatur Aggregator' });
  }
  next();
}

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM aggregator_settings ORDER BY platform').all();
  res.json(all);
});

router.put('/:id', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const { default_fee_percent } = req.body;
  const before = await db.prepare('SELECT * FROM aggregator_settings WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Platform tidak ditemukan' });

  await db.prepare('UPDATE aggregator_settings SET default_fee_percent=?, updated_at=NOW() WHERE id=?')
    .run(parseFloat(default_fee_percent)||0, req.params.id);

  const after = await db.prepare('SELECT * FROM aggregator_settings WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pengaturan Aggregator', record_id: req.params.id, record_label: before.platform, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

module.exports = router;
