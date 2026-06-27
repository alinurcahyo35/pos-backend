const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const { parseCsvText } = require('../db/csv_import_helper');

// Harga per satuan = harga_beli / (qty_beli * konversi_ke_satuan)
// misal: beli 1 kg = 1000 gr, harga 15000 → harga/gr = 15000/1000 = 15
function calcUnitPrice(buy_price, buy_qty, buy_unit, unit) {
  if (!buy_price || !buy_qty) return 0;
  const conversions = {
    // ke satuan dasar
    'kg':     { 'gr': 1000, 'kg': 1 },
    'gr':     { 'gr': 1 },
    'liter':  { 'ml': 1000, 'liter': 1 },
    'ml':     { 'ml': 1 },
    'pcs':    { 'pcs': 1 },
    'klip':   { 'klip': 1 },
    'sachet': { 'sachet': 1 },
    'botol':  { 'botol': 1 },
  };
  const conv = conversions[buy_unit]?.[unit];
  if (!conv) return buy_price / buy_qty; // fallback: harga / qty langsung
  return buy_price / (buy_qty * conv);
}

// List bahan baku
router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM ingredients ORDER BY name').all();
  sendCsv(res, 'persediaan.csv', all, [
    { key:'name', label:'Nama' }, { key:'unit', label:'Satuan' }, { key:'stock', label:'Stok' },
    { key:'min_stock', label:'Stok Minimum' }, { key:'buy_price', label:'Harga Beli' },
    { key:'buy_qty', label:'Qty Beli' }, { key:'buy_unit', label:'Satuan Beli' }, { key:'updated_at', label:'Update Terakhir' }
  ]);
});

router.get('/import-template', auth, async (req, res) => {
  const contoh = [
    { nama:'Mangga Harum Manis', satuan_pakai:'gr', stok_awal:5000, stok_minimum:500, harga_beli:28000, qty_beli:1, satuan_beli:'kg' },
    { nama:'Gula Pasir', satuan_pakai:'gr', stok_awal:10000, stok_minimum:1000, harga_beli:14000, qty_beli:1, satuan_beli:'kg' },
  ];
  sendCsv(res, 'template_import_persediaan.csv', contoh, [
    { key:'nama', label:'Nama' }, { key:'satuan_pakai', label:'Satuan Pakai (gr/ml/pcs/dll)' },
    { key:'stok_awal', label:'Stok Awal' }, { key:'stok_minimum', label:'Stok Minimum' },
    { key:'harga_beli', label:'Harga Beli' }, { key:'qty_beli', label:'Qty Beli (misal 1)' },
    { key:'satuan_beli', label:'Satuan Beli (kg/liter/karton/dll)' },
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
    const nama  = r['Nama'] || r['nama'] || r['name'] || '';
    const unit  = r['Satuan Pakai (gr/ml/pcs/dll)'] || r['satuan_pakai'] || r['unit'] || 'gr';
    const stock = parseFloat(r['Stok Awal'] || r['stok_awal'] || r['stock'] || 0);
    const min_stock = parseFloat(r['Stok Minimum'] || r['stok_minimum'] || r['min_stock'] || 0);
    const buy_price = parseFloat(r['Harga Beli'] || r['harga_beli'] || r['buy_price'] || 0);
    const buy_qty   = parseFloat(r['Qty Beli (misal 1)'] || r['qty_beli'] || r['buy_qty'] || 1);
    const buy_unit  = r['Satuan Beli (kg/liter/karton/dll)'] || r['satuan_beli'] || r['buy_unit'] || unit;

    try {
      if (!nama) throw new Error('Nama persediaan wajib diisi');
      await db.prepare('INSERT INTO ingredients (name,unit,stock,min_stock,buy_price,buy_qty,buy_unit,is_packing) VALUES (?,?,?,?,?,?,?,0) RETURNING id')
        .run(nama.trim(), unit.trim(), stock, min_stock, buy_price, buy_qty, buy_unit.trim());
      results.success++;
    } catch(e) {
      results.errors.push({ baris: i + 2, nama: nama||'(kosong)', error: e.message });
    }
  }
  res.json(results);
});

// Daftar khusus item packing (dipakai kasir saat checkout)
router.get('/packing', auth, async (req, res) => {
  const db = getDb();
  const items = await db.prepare('SELECT * FROM ingredients WHERE is_packing=1 ORDER BY name').all();
  res.json(items.map(i => ({
    ...i,
    unit_price: calcUnitPrice(i.buy_price, i.buy_qty, i.buy_unit, i.unit)
  })));
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q, type } = req.query;
  let sql = 'SELECT * FROM ingredients WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND name LIKE ?'; params.push(`%${q}%`); }
  if (type === 'packing') sql += ' AND is_packing=1';
  if (type === 'bahan')   sql += ' AND (is_packing=0 OR is_packing IS NULL)';
  sql += ' ORDER BY name';
  const items = await db.prepare(sql).all(...params);
  // Attach computed unit price
  res.json(items.map(i => ({
    ...i,
    unit_price: calcUnitPrice(i.buy_price, i.buy_qty, i.buy_unit, i.unit)
  })));
});

// Tambah bahan
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { name, unit, stock=0, min_stock=0, buy_price=0, buy_qty=1, buy_unit, is_packing=0 } = req.body;
  const r = await db.prepare('INSERT INTO ingredients (name,unit,stock,min_stock,buy_price,buy_qty,buy_unit,is_packing) VALUES (?,?,?,?,?,?,?,?) RETURNING id').run(name,unit,stock,min_stock,buy_price,buy_qty,buy_unit||unit,is_packing?1:0);
  const unit_price = calcUnitPrice(buy_price, buy_qty, buy_unit||unit, unit);
  const result = { id: r.lastInsertRowid, name, unit, stock, min_stock, buy_price, buy_qty, buy_unit: buy_unit||unit, is_packing: is_packing?1:0, unit_price };
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Persediaan', record_id: result.id, record_label: name, data_sesudah: result });
  res.json(result);
});

// Update bahan
router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { name, unit, stock, min_stock, buy_price, buy_qty, buy_unit, is_packing } = req.body;
  const before = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(req.params.id);
  await db.prepare('UPDATE ingredients SET name=?,unit=?,stock=?,min_stock=?,buy_price=?,buy_qty=?,buy_unit=?,is_packing=?,updated_at=NOW() WHERE id=?').run(name,unit,stock,min_stock,buy_price||0,buy_qty||1,buy_unit||unit,is_packing?1:(before?.is_packing||0),req.params.id);
  const after = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Persediaan', record_id: req.params.id, record_label: name, data_sebelum: before, data_sesudah: after });
  res.json({ success: true });
});

// Restock
router.post('/:id/restock', auth, async (req, res) => {
  const db = getDb();
  const { amount, buy_price, buy_qty, buy_unit } = req.body;
  const before = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(req.params.id);
  // Update harga beli terbaru jika diberikan
  if (buy_price && buy_qty) {
    await db.prepare('UPDATE ingredients SET stock=stock+?,buy_price=?,buy_qty=?,buy_unit=?,updated_at=NOW() WHERE id=?').run(amount,buy_price,buy_qty,buy_unit||'',req.params.id);
  } else {
    await db.prepare('UPDATE ingredients SET stock=stock+?,updated_at=NOW() WHERE id=?').run(amount,req.params.id);
  }
  const updated = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Persediaan', record_id: req.params.id, record_label: `${before?.name} (restock +${amount})`, data_sebelum: before, data_sesudah: updated });
  res.json({ ...updated, unit_price: calcUnitPrice(updated.buy_price,updated.buy_qty,updated.buy_unit,updated.unit) });
});

// Hapus bahan
router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM recipes WHERE ingredient_id=?').run(req.params.id);
  await db.prepare('DELETE FROM ingredients WHERE id=?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Persediaan', record_id: req.params.id, record_label: before?.name, data_sebelum: before });
  res.json({ success: true });
});

// Template dan import massal Resep
router.get('/recipes/import-template', auth, async (req, res) => {
  const contoh = [
    { nama_produk:'Jus Mangga Regular', nama_bahan:'Mangga Harum Manis', jumlah_pakai:200, satuan:'gr' },
    { nama_produk:'Jus Mangga Regular', nama_bahan:'Gula Pasir', jumlah_pakai:20, satuan:'gr' },
    { nama_produk:'Jus Mangga Regular', nama_bahan:'Air Matang', jumlah_pakai:150, satuan:'ml' },
    { nama_produk:'Es Teh Manis', nama_bahan:'Teh Celup', jumlah_pakai:1, satuan:'pcs' },
  ];
  sendCsv(res, 'template_import_resep.csv', contoh, [
    { key:'nama_produk', label:'Nama Produk (harus sudah ada di sistem)' },
    { key:'nama_bahan', label:'Nama Bahan (harus sudah ada di Persediaan)' },
    { key:'jumlah_pakai', label:'Jumlah Pakai per 1 Produk' },
    { key:'satuan', label:'Satuan (gr/ml/pcs/dll)' },
  ]);
});

router.post('/recipes/import', auth, async (req, res) => {
  const db = getDb();
  const { csv_text } = req.body;
  if (!csv_text) return res.status(400).json({ error: 'Data CSV kosong' });

  const rows = parseCsvText(csv_text);
  const results = { success: 0, errors: [] };

  // Cache produk dan bahan agar tidak query berulang
  const allProducts = await db.prepare('SELECT id, name FROM products').all();
  const allIngredients = await db.prepare('SELECT id, name FROM ingredients').all();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const namaProduk = (r['Nama Produk (harus sudah ada di sistem)'] || r['nama_produk'] || '').trim();
    const namaBahan  = (r['Nama Bahan (harus sudah ada di Persediaan)'] || r['nama_bahan'] || '').trim();
    const jumlah     = parseFloat(r['Jumlah Pakai per 1 Produk'] || r['jumlah_pakai'] || 0);

    try {
      if (!namaProduk) throw new Error('Nama produk wajib diisi');
      if (!namaBahan)  throw new Error('Nama bahan wajib diisi');
      if (!jumlah)     throw new Error('Jumlah pakai wajib diisi dan lebih dari 0');

      const produk = allProducts.find(p => p.name.toLowerCase() === namaProduk.toLowerCase());
      if (!produk) throw new Error(`Produk "${namaProduk}" tidak ditemukan di sistem`);

      const bahan = allIngredients.find(b => b.name.toLowerCase() === namaBahan.toLowerCase());
      if (!bahan) throw new Error(`Bahan "${namaBahan}" tidak ditemukan di Persediaan`);

      await db.prepare('INSERT OR REPLACE INTO recipes (product_id, ingredient_id, quantity) VALUES (?,?,?)')
        .run(produk.id, bahan.id, jumlah);
      results.success++;
    } catch(e) {
      results.errors.push({ baris: i + 2, produk: namaProduk||'(kosong)', bahan: namaBahan||'(kosong)', error: e.message });
    }
  }
  res.json(results);
});

// Get resep produk
router.get('/recipes/:product_id', auth, async (req, res) => {
  const db = getDb();
  const items = await db.prepare(`
    SELECT r.id, r.product_id, r.ingredient_id, r.quantity,
           i.name as ingredient_name, i.unit, i.stock as ingredient_stock,
           i.buy_price, i.buy_qty, i.buy_unit
    FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id
    WHERE r.product_id=?
  `).all(req.params.product_id);
  res.json(items.map(i => ({
    ...i,
    unit_price: calcUnitPrice(i.buy_price, i.buy_qty, i.buy_unit, i.unit),
    cost: calcUnitPrice(i.buy_price, i.buy_qty, i.buy_unit, i.unit) * i.quantity
  })));
});

// Simpan resep
router.post('/recipes/:product_id', auth, async (req, res) => {
  const db = getDb();
  const { items } = req.body;
  await db.prepare('DELETE FROM recipes WHERE product_id=?').run(req.params.product_id);
  for (const item of items) {
    await db.prepare('INSERT INTO recipes (product_id,ingredient_id,quantity) VALUES (?,?,?) RETURNING id').run(req.params.product_id,item.ingredient_id,item.quantity);
  }
  res.json({ success: true });
});

// HPP satu produk
router.get('/hpp/:product_id', auth, async (req, res) => {
  const db = getDb();
  const recipe = await db.prepare(`
    SELECT r.quantity, i.buy_price, i.buy_qty, i.buy_unit, i.unit, i.name
    FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id
    WHERE r.product_id=?
  `).all(req.params.product_id);
  const hpp = recipe.reduce((sum, r) => {
    return sum + calcUnitPrice(r.buy_price, r.buy_qty, r.buy_unit, r.unit) * r.quantity;
  }, 0);
  res.json({ hpp, breakdown: recipe.map(r => ({
    name: r.name,
    unit_price: calcUnitPrice(r.buy_price, r.buy_qty, r.buy_unit, r.unit),
    quantity: r.quantity,
    unit: r.unit,
    cost: calcUnitPrice(r.buy_price, r.buy_qty, r.buy_unit, r.unit) * r.quantity
  }))});
});

// Check stok semua produk
router.get('/check-stock', auth, async (req, res) => {
  const db = getDb();
  const products = await db.prepare('SELECT id, name, price FROM products').all();
  const result = [];
  for (const p of products) {
    const recipe = await db.prepare(`
      SELECT r.quantity, i.stock, i.name as ingredient_name, i.unit,
             i.buy_price, i.buy_qty, i.buy_unit
      FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id WHERE r.product_id=?
    `).all(p.id);
    if (recipe.length === 0) { result.push({ ...p, can_make: null, recipe: [], hpp: 0 }); continue; }
    const maxPortions = recipe.reduce((min,r) => Math.min(min, Math.floor(r.stock/r.quantity)), Infinity);
    const hpp = recipe.reduce((sum,r) => sum + calcUnitPrice(r.buy_price,r.buy_qty,r.buy_unit,r.unit)*r.quantity, 0);
    result.push({ ...p, can_make: maxPortions===Infinity?0:maxPortions, recipe, hpp, margin: p.price - hpp });
  }
  res.json(result);
});

module.exports = { router, calcUnitPrice };
