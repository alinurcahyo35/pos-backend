const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const SECRET = process.env.JWT_SECRET || 'pos-secret-key';

router.post('/login', async (req, res) => {
  const db = getDb();
  const { username, password } = req.body;
  const user = await db.prepare('SELECT * FROM pos_finance.users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Username atau password salah' });
  const passwordField = user.password_hash || user.password;
  if (!bcrypt.compareSync(password, passwordField))
    return res.status(401).json({ error: 'Username atau password salah' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

router.post('/register', auth, async (req, res) => {
  const db = getDb();
  const { name, username, password, role = 'kasir' } = req.body;
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Hanya admin' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = await db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?,?,?,?) RETURNING id').run(name, username, hash, role);
    const result = { id: r.lastInsertRowid, name, username, role };
    // Tidak menyimpan password_hash ke audit log - hanya data non-sensitif
    await recordAudit(db, { user: req.user, aksi:'create', modul:'Pengguna', record_id: result.id, record_label: `${name} (${username})`, data_sesudah: result });
    res.json(result);
  } catch { res.status(400).json({ error: 'Username sudah dipakai' }); }
});

router.get('/users/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT id, name, username, role, created_at FROM users ORDER BY name').all();
  sendCsv(res, 'pengguna.csv', all, [
    { key:'name', label:'Nama' }, { key:'username', label:'Username' }, { key:'role', label:'Role' },
    { key:'created_at', label:'Dibuat Pada' }
  ]);
});

router.get('/users', auth, async (req, res) => {
  const db = getDb();
  res.json(await db.prepare('SELECT id, name, username, role, created_at FROM users ORDER BY name').all());
});

router.delete('/users/:id', auth, async (req, res) => {
  const db = getDb();
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak' });
  const before = await db.prepare('SELECT id, name, username, role, created_at FROM users WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Pengguna', record_id: req.params.id, record_label: before ? `${before.name} (${before.username})` : '', data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
