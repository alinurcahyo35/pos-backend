const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');

// Helper: hitung HPP sugar dari ingredient
async function calcSugarHpp(db, ingredientId, qtyGram) {
  if (!ingredientId || !qtyGram) return 0;
  const ing = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
  if (!ing) return 0;
  // harga per satuan terkecil = buy_price / buy_qty (dalam unit yang sama)
  const pricePerUnit = ing.buy_qty > 0 ? ing.buy_price / ing.buy_qty : 0;
  return Math.round(pricePerUnit * qtyGram);
}

// GET semua opsi — sugar include hpp_calculated
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { tipe } = req.query;
  let rows = await db.prepare('SELECT * FROM customization_options ORDER BY tipe, urutan').all();
  if (tipe) rows = rows.filter(r => r.tipe === tipe);

  // Hitung hpp otomatis untuk sugar
  for (const r of rows) {
    if (r.tipe === 'sugar' && r.ingredient_id && r.qty_gram > 0) {
      r.hpp_calculated = await calcSugarHpp(db, r.ingredient_id, r.qty_gram);
    } else {
      r.hpp_calculated = 0;
    }
  }
  res.json(rows);
});

// GET ingredient list untuk dropdown (ingredients yang bukan packing)
router.get('/ingredients', auth, async (req, res) => {
  const db = getDb();
  const rows = await db.prepare('SELECT id, name, unit, buy_price, buy_qty, buy_unit FROM ingredients WHERE (is_packing IS NULL OR is_packing=0) ORDER BY name').all();
  res.json(rows);
});

// POST tambah opsi baru
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { tipe, nama, harga, urutan, ingredient_id, qty_gram, hpp_ingredient_id, hpp_qty } = req.body;
  if (!tipe || !nama) return res.status(400).json({ error: 'tipe dan nama wajib diisi' });

  const hpp_calc = tipe === 'sugar' ? await calcSugarHpp(db, ingredient_id, qty_gram) : 0;
  const finalHarga = tipe === 'sugar' ? hpp_calc : (parseFloat(harga)||0);

  const r = await db.prepare(
    'INSERT INTO customization_options (tipe,nama,harga,urutan,ingredient_id,qty_gram,hpp_ingredient_id,hpp_qty) VALUES (?,?,?,?,?,?,?,?) RETURNING id'
  ).run(tipe, nama, finalHarga, parseInt(urutan)||0,
    ingredient_id||null, parseFloat(qty_gram)||0,
    hpp_ingredient_id||null, parseFloat(hpp_qty)||0);

  res.json({ id: r.lastInsertRowid, tipe, nama, harga: finalHarga, urutan: parseInt(urutan)||0,
    ingredient_id: ingredient_id||null, qty_gram: parseFloat(qty_gram)||0,
    hpp_ingredient_id: hpp_ingredient_id||null, hpp_qty: parseFloat(hpp_qty)||0,
    hpp_calculated: hpp_calc, aktif: 1 });
});

// PUT update opsi
router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { tipe, nama, harga, urutan, aktif, ingredient_id, qty_gram, hpp_ingredient_id, hpp_qty } = req.body;

  const hpp_calc = tipe === 'sugar' ? await calcSugarHpp(db, ingredient_id, qty_gram) : 0;
  const finalHarga = tipe === 'sugar' ? hpp_calc : (parseFloat(harga)||0);

  await db.prepare(
    'UPDATE customization_options SET tipe=?,nama=?,harga=?,urutan=?,aktif=?,ingredient_id=?,qty_gram=?,hpp_ingredient_id=?,hpp_qty=? WHERE id=?'
  ).run(tipe, nama, finalHarga, parseInt(urutan)||0,
    aktif===false||aktif===0?0:1,
    ingredient_id||null, parseFloat(qty_gram)||0,
    hpp_ingredient_id||null, parseFloat(hpp_qty)||0,
    req.params.id);
  res.json({ success: true });
});

// DELETE opsi
router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  await db.prepare('DELETE FROM customization_options WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
