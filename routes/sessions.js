const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');

const OUTLETS = ['Banjarsari Selatan', 'Tirto Agung', 'Veteran'];

router.get('/outlets', auth, (req, res) => {
  res.json(OUTLETS);
});

router.post('/open', auth, async (req, res) => {
  const db = getDb();
  const open = await db.prepare('SELECT id FROM sessions WHERE user_id=? AND closed_at IS NULL').get(req.user.id);
  if (open) return res.json(open);
  const { opening_cash=0, outlet='' } = req.body;
  const r = await db.prepare('INSERT INTO sessions (user_id, opening_cash, outlet) VALUES (?,?,?) RETURNING id').run(req.user.id, opening_cash, outlet);
  const result = { id: r.lastInsertRowid, user_id: req.user.id, opening_cash, outlet };
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Sesi Kasir', record_id: result.id, record_label: `Buka kas - ${req.user.name} (${outlet||'Belum dipilih'})`, data_sesudah: result });
  res.json(result);
});

router.post('/close', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM sessions WHERE user_id=? AND closed_at IS NULL').get(req.user.id);
  await db.prepare('UPDATE sessions SET closing_cash=?, closed_at=NOW() WHERE user_id=? AND closed_at IS NULL').run(req.body.closing_cash||0, req.user.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Sesi Kasir', record_id: before?.id, record_label: `Tutup kas - ${req.user.name}`, data_sebelum: before, data_sesudah: { ...before, closing_cash: req.body.closing_cash||0, closed_at: new Date().toISOString() } });
  res.json({ success: true });
});

router.get('/active', auth, async (req, res) => {
  const db = getDb();
  const s = await db.prepare('SELECT * FROM sessions WHERE user_id=? AND closed_at IS NULL').get(req.user.id);
  res.json(s || null);
});

module.exports = router;
