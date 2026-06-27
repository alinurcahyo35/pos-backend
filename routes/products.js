const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const { parseCsvText } = require('../db/csv_import_helper');

// Hitung stok produk berdasarkan resep
async function calcStock(db, productId) {
  const recipe = await db.prepare(`
    SELECT r.quantity, i.stock
    FROM recipes r JOIN ingredients i ON r.ingredient_id = i.id
    WHERE r.product_id = ?
  `).all(productId);

  if (recipe.length === 0) return null; // tidak ada resep, pakai stok manual
  const max = recipe.reduce((min, r) => Math.min(min, Math.floor(r.stock / r.quantity)), Infinity);
  return max === Infinity ? 0 : max;
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM products ORDER BY name').all();
  sendCsv(res, 'produk.csv', all, [
    { key:'barcode', label:'Barcode' }, { key:'name', label:'Nama' }, { key:'category', label:'Kategori' },
    { key:'price', label:'Harga Jual' }, { key:'stock', label:'Stok Manual' }, { key:'created_at', label:'Dibuat Pada' }
  ]);
});

router.get('/import-template', auth, async (req, res) => {
  const contoh = [
    { barcode:'JUS-001', nama:'Jus Mangga Jumbo', kategori:'Jus', harga_jual:18000, stok_awal:0 },
    { barcode:'', nama:'Es Teh Manis', kategori:'Minuman', harga_jual:8000, stok_awal:0 },
  ];
  sendCsv(res, 'template_import_produk.csv', contoh, [
    { key:'barcode', label:'Barcode (boleh kosong)' }, { key:'nama', label:'Nama' },
    { key:'kategori', label:'Kategori' }, { key:'harga_jual', label:'Harga Jual' },
    { key:'stok_awal', label:'Stok Awal (jika tidak pakai resep)' },
  ]);
});

router.post('/import', auth, async (req, res) => {
  const db = getDb();
  const { csv_text } = req.body;
  if (!csv_text) return res.status(400).json({ error: 'Data CSV kosong' });

  const rows = parseCsvText(csv_text);
  const results = { success: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const nama = r['Nama'] || r['nama'] || r['name'] || '';
    const harga = parseFloat(r['Harga Jual'] || r['harga_jual'] || r['price'] || 0);
    const kategori = r['Kategori'] || r['kategori'] || r['category'] || '';
    const barcode = r['Barcode (boleh kosong)'] || r['Barcode'] || r['barcode'] || null;
    const stok = parseInt(r['Stok Awal (jika tidak pakai resep)'] || r['stok_awal'] || r['stock'] || 0);

    try {
      if (!nama) throw new Error('Nama produk wajib diisi');
      if (!harga) throw new Error('Harga jual wajib diisi dan lebih dari 0');
      await db.prepare('INSERT INTO products (barcode,name,category,price,stock) VALUES (?,?,?,?,?) RETURNING id')
        .run(barcode||null, nama.trim(), kategori.trim(), harga, stok);
      results.success++;
    } catch(e) {
      results.errors.push({ baris: i + 2, nama: nama||'(kosong)', error: e.message });
    }
  }
  res.json(results);
});

// List + search — stok dihitung dari resep jika ada
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q, category } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR barcode LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY name';
  const products = await db.prepare(sql).all(...params);

  const result = [];
  for (const p of products) {
    const computed = await calcStock(db, p.id);
    result.push({
      ...p,
      stock: computed !== null ? computed : p.stock,
      stock_source: computed !== null ? 'resep' : 'manual'
    });
  }
  res.json(result);
});

router.get('/barcode/:code', auth, async (req, res) => {
  const db = getDb();
  const p = await db.prepare('SELECT * FROM products WHERE barcode = ?').get(req.params.code);
  if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  const computed = await calcStock(db, p.id);
  res.json({ ...p, stock: computed !== null ? computed : p.stock, stock_source: computed !== null ? 'resep' : 'manual' });
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { barcode, name, category, price, stock } = req.body;
  const r = await db.prepare('INSERT INTO products (barcode,name,category,price,stock) VALUES (?,?,?,?,?) RETURNING id').run(barcode||null,name,category||null,price,stock||0);
  const result = { id: r.lastInsertRowid, barcode, name, category, price, stock: stock||0 };
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Produk', record_id: result.id, record_label: name, data_sesudah: result });
  res.json(result);
});

// HPP Lookup by nama item (untuk auto-fill di invoice B2B)
// HARUS di atas /:id agar tidak tertangkap sebagai id parameter
router.get('/hpp-lookup', auth, async (req, res) => {
  const db = getDb();
  const { nama } = req.query;
  if (!nama) return res.json({ hpp: 0, found: false });

  const all = await db.prepare('SELECT * FROM products').all();
  const match = all.find(p => p.name.toLowerCase() === nama.toLowerCase().trim());
  if (!match) return res.json({ hpp: 0, found: false });

  const { calcUnitPrice } = require('./ingredients');
  const recipe = await db.prepare(
    `SELECT r.quantity, i.buy_price, i.buy_qty, i.buy_unit, i.unit
     FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id
     WHERE r.product_id=?`
  ).all(match.id);

  if (recipe.length === 0) return res.json({ hpp: match.hpp || 0, found: true, product_id: match.id, product_name: match.name });

  const hpp = recipe.reduce((sum, r) =>
    sum + calcUnitPrice(r.buy_price, r.buy_qty, r.buy_unit, r.unit) * r.quantity, 0
  );
  res.json({ hpp: Math.round(hpp), found: true, product_id: match.id, product_name: match.name });
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { barcode, name, category, price, stock } = req.body;
  const before = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  await db.prepare('UPDATE products SET barcode=?,name=?,category=?,price=?,stock=?,updated_at=NOW() WHERE id=?').run(barcode||null,name,category||null,price,stock||0,req.params.id);
  const after = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Produk', record_id: req.params.id, record_label: name, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Produk', record_id: req.params.id, record_label: before?.name, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
