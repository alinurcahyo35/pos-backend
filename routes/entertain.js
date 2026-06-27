const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { calcUnitPrice } = require('./ingredients');
const { journalEntertain } = require('../db/journal_helper');

// GET semua entertain
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  let rows = await db.prepare('SELECT * FROM entertain_logs ORDER BY tanggal DESC, id DESC').all();
  if (from) rows = rows.filter(r => r.tanggal >= from);
  if (to)   rows = rows.filter(r => r.tanggal <= to);
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items||'[]') })));
});

// POST catat entertain baru
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { tanggal, kategori, keterangan, items, outlet } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'Items kosong' });

  // Hitung total HPP dari ingredient produk
  let total_hpp = 0;
  for (const item of items) {
    if (!item.product_id) continue;
    const recipe = await db.prepare(`
      SELECT r.quantity, i.buy_price, i.buy_qty, i.buy_unit, i.unit
      FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id
      WHERE r.product_id=?`).all(item.product_id);
    const hpp = recipe.reduce((s,r) => s + calcUnitPrice(r.buy_price,r.buy_qty,r.buy_unit,r.unit)*r.quantity, 0);
    total_hpp += hpp * (item.qty||1);

    // Kurangi stok bahan baku
    for (const r of recipe) {
      await db.prepare('UPDATE ingredients SET stock=stock-? WHERE id=?').run(r.quantity*(item.qty||1), r.ingredient_id||r.id);
    }
  }

  const result = await db.prepare(
    'INSERT INTO entertain_logs (tanggal,kategori,keterangan,items,total_hpp,user_id,user_name,outlet) VALUES (?,?,?,?,?,?,?,?) RETURNING id'
  ).run(tanggal, kategori||'Konsumsi Karyawan', keterangan||'', JSON.stringify(items), total_hpp, req.user.id, req.user.name||'', outlet||'');

  const saved = await db.prepare('SELECT * FROM entertain_logs WHERE id=?').get(result.lastInsertRowid);
  await journalEntertain(db, saved);
  res.json({ ...saved, items });
});

// DELETE
router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  await db.prepare('DELETE FROM entertain_logs WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
