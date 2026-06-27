const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { sendCsv } = require('../db/csv_helper');

function requireSuperadmin(req, res, next) {
  if (!['admin','direksi'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Hanya Superadmin yang dapat mengakses Audit Log' });
  }
  next();
}

function filterLogs(all, query) {
  const { modul, aksi, user_id, from, to, q } = query;
  if (modul && modul !== 'all') all = all.filter(l => l.modul === modul);
  if (aksi && aksi !== 'all')   all = all.filter(l => l.aksi === aksi);
  if (user_id)                   all = all.filter(l => String(l.user_id) === String(user_id));
  if (from)                      all = all.filter(l => l.created_at >= from);
  if (to)                        all = all.filter(l => l.created_at <= to + ' 23:59:59');
  if (q) {
    const ql = q.toLowerCase();
    all = all.filter(l =>
      (l.record_label||'').toLowerCase().includes(ql) ||
      (l.user_name||'').toLowerCase().includes(ql)
    );
  }
  return all;
}

router.get('/export', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  let all = await db.prepare('SELECT * FROM audit_logs ORDER BY id DESC').all();
  all = filterLogs(all, req.query);
  sendCsv(res, 'audit_log.csv', all, [
    { key:'created_at', label:'Waktu' }, { key:'user_name', label:'Pengguna' }, { key:'user_role', label:'Role' },
    { key:'modul', label:'Modul' }, { key:'aksi', label:'Aksi' }, { key:'record_label', label:'Data' },
    { key:'data_sebelum', label:'Sebelum' }, { key:'data_sesudah', label:'Sesudah' }
  ]);
});

router.get('/', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  let all = await db.prepare('SELECT * FROM audit_logs ORDER BY id DESC').all();
  all = filterLogs(all, req.query);

  const limited = all.slice(0, 500);

  res.json({
    total: all.length,
    showing: limited.length,
    logs: limited.map(l => ({
      ...l,
      data_sebelum: l.data_sebelum ? JSON.parse(l.data_sebelum) : null,
      data_sesudah: l.data_sesudah ? JSON.parse(l.data_sesudah) : null,
    }))
  });
});

router.get('/modules', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT DISTINCT modul FROM audit_logs ORDER BY modul').all();
  res.json(all.map(r => r.modul));
});

module.exports = router;
