const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');

const PLATFORMS = ['GoFood', 'ShopeeFood', 'GrabFood'];

// GET semua harga merchant (opsional filter product_id)
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { product_id } = req.query;
  let rows = product_id
    ? await db.prepare('SELECT * FROM product_merchant_prices WHERE product_id=?').all(parseInt(product_id))
    : await db.prepare('SELECT pmp.*, p.name as product_name FROM product_merchant_prices pmp LEFT JOIN products p ON pmp.product_id=p.id ORDER BY p.name, pmp.platform').all();
  res.json(rows);
});

// POST upsert harga merchant (insert or replace)
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { product_id, platform, harga, aktif=1 } = req.body;
  if (!product_id || !platform || !PLATFORMS.includes(platform))
    return res.status(400).json({ error: 'product_id dan platform (GoFood/ShopeeFood/GrabFood) wajib diisi' });

  const existing = await db.prepare('SELECT * FROM product_merchant_prices WHERE product_id=? AND platform=?').get(product_id, platform);
  if (existing) {
    await db.prepare('UPDATE product_merchant_prices SET harga=?,aktif=? WHERE id=?').run(parseFloat(harga)||0, aktif, existing.id);
    res.json({ ...existing, harga: parseFloat(harga)||0, aktif });
  } else {
    const r = await db.prepare('INSERT INTO product_merchant_prices (product_id,platform,harga,aktif) VALUES (?,?,?,?) RETURNING id').run(product_id, platform, parseFloat(harga)||0, aktif);
    res.json({ id: r.lastInsertRowid, product_id, platform, harga: parseFloat(harga)||0, aktif });
  }
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  await db.prepare('DELETE FROM product_merchant_prices WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
