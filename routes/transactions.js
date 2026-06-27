const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { calcUnitPrice } = require('./ingredients');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const { journalTransaction } = require('../db/journal_helper');

async function getHpp(db, productId) {
  const recipe = await db.prepare(`SELECT r.quantity, i.buy_price, i.buy_qty, i.buy_unit, i.unit FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id WHERE r.product_id=?`).all(productId);
  return recipe.reduce((sum,r) => sum + calcUnitPrice(r.buy_price,r.buy_qty,r.buy_unit,r.unit)*r.quantity, 0);
}

// Hitung HPP tambahan dari Add On (ingredient dari customization_options)
async function getAddonHpp(db, customizations) {
  if (!customizations) return 0;
  let hpp = 0;
  const cust = typeof customizations === 'string' ? JSON.parse(customizations) : customizations;
  // Sugar HPP sudah di hpp_calculated, skip
  // Add On HPP dari hpp_ingredient_id + hpp_qty
  for (const addon of (cust.addons || [])) {
    if (!addon.id) continue;
    const opt = await db.prepare('SELECT * FROM customization_options WHERE id=?').get(addon.id);
    if (opt && opt.hpp_ingredient_id && opt.hpp_qty > 0) {
      const ing = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(opt.hpp_ingredient_id);
      if (ing && ing.buy_qty > 0) {
        hpp += calcUnitPrice(ing.buy_price, ing.buy_qty, ing.buy_unit, ing.unit) * opt.hpp_qty;
      }
    }
  }
  // Sugar HPP
  if (cust.sugar_hpp && cust.sugar_hpp > 0) hpp += cust.sugar_hpp;
  return hpp;
}

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const {
    session_id, items, payment_method, amount_paid, discount=0, tax=0,
    packing_detail, aggregator_name
  } = req.body;
  if (!items || items.length===0) return res.status(400).json({ error: 'Keranjang kosong' });

  const AGGREGATOR_METHODS = ['gofood','shopeefood','grabfood'];
  const AGGREGATOR_PLATFORM = { gofood:'GoFood', shopeefood:'ShopeeFood', grabfood:'GrabFood' };
  const isAggregatorTxn = AGGREGATOR_METHODS.includes(payment_method);

  const subtotal = items.reduce((s,i) => s+i.price*i.quantity, 0);
  const total = subtotal - discount + (subtotal*tax/100);
  const change = amount_paid - total;
  if (change < 0) return res.status(400).json({ error: 'Jumlah bayar kurang' });

  // Potongan platform dihitung otomatis dari persentase yang diatur Superadmin - kasir tidak menentukan nominalnya
  let aggregator_fee = 0;
  let aggregator_name_final = null;
  if (isAggregatorTxn) {
    const platform = AGGREGATOR_PLATFORM[payment_method];
    const setting = await db.prepare('SELECT * FROM aggregator_settings WHERE platform=?').get(platform);
    aggregator_fee = setting ? Math.round(total * setting.default_fee_percent / 100) : 0;
    aggregator_name_final = platform;
  }

  // packing_detail: [{ ingredient_id, qty }] - item packing diambil dari Persediaan (is_packing=1)
  const validPackingDetail = (packing_detail||[]).filter(p => p.qty > 0);
  let packing_cost = 0;
  const packingIngredients = [];
  if (validPackingDetail.length > 0) {
    for (const p of validPackingDetail) {
      const ing = await db.prepare('SELECT * FROM ingredients WHERE id=? AND is_packing=1').get(p.ingredient_id);
      if (!ing) return res.status(400).json({ error: 'Item packing tidak ditemukan' });
      if (ing.stock < p.qty) return res.status(400).json({ error: `Stok packing "${ing.name}" tidak cukup (sisa ${ing.stock})` });
      const unitPrice = calcUnitPrice(ing.buy_price, ing.buy_qty, ing.buy_unit, ing.unit);
      packing_cost += unitPrice * p.qty;
      packingIngredients.push({ ...ing, qty: p.qty });
    }
  }

  try {
    // Validasi stok bahan baku
    for (const item of items) {
      const recipe = await db.prepare(`SELECT r.quantity,r.ingredient_id,i.name,i.stock,i.unit FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id WHERE r.product_id=?`).all(item.id);
      for (const r of recipe) {
        const needed = r.quantity * item.quantity;
        if (r.stock < needed) return res.status(400).json({ error: `Bahan "${r.name}" tidak cukup` });
      }
    }

    let hpp_total = 0;
    for (const item of items) {
      const baseHpp   = await getHpp(db, item.id);
      const addonHpp  = await getAddonHpp(db, item.customizations);
      hpp_total += (baseHpp + addonHpp) * item.quantity;
    }

    // Insert transaksi
    await db.prepare(`INSERT INTO transactions
      (session_id,user_id,total,discount,tax,payment_method,amount_paid,change_amount,hpp_total,packing_cost,packing_detail,aggregator_name,aggregator_fee)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .run(session_id, req.user.id, total, discount, tax, payment_method, amount_paid, change, hpp_total,
           packing_cost, validPackingDetail.length ? JSON.stringify(validPackingDetail) : null, aggregator_name_final, aggregator_fee);

    const txnRow = await db.prepare('SELECT id FROM transactions ORDER BY id DESC LIMIT 1').get();
    const txnId = txnRow.id;

    for (const item of items) {
      const baseHpp  = await getHpp(db, item.id);
      const addHpp   = await getAddonHpp(db, item.customizations);
      const totalHpp = baseHpp + addHpp;

      await db.prepare('INSERT INTO transaction_items (transaction_id,product_id,product_name,price,hpp,quantity,subtotal,customizations) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
        .run(txnId, item.id, item.name, item.price, totalHpp, item.quantity, item.price*item.quantity, item.customizations ? JSON.stringify(item.customizations) : null);

      await db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(item.quantity, item.id);

      const recipe = await db.prepare('SELECT * FROM recipes WHERE product_id=?').all(item.id);
      for (const r of recipe) {
        await db.prepare('UPDATE ingredients SET stock=stock-?,updated_at=NOW() WHERE id=?').run(r.quantity*item.quantity, r.ingredient_id);
      }
    }

    // Kurangi stok item packing yang dipakai (cup/sedotan/plastik)
    for (const pi of packingIngredients) {
      await db.prepare('UPDATE ingredients SET stock=stock-?,updated_at=NOW() WHERE id=?').run(pi.qty, pi.id);
    }

    const fullTxn = await db.prepare('SELECT * FROM transactions WHERE id=?').get(txnId);
    await journalTransaction(db, fullTxn);

    const result = { id: txnId, total, change, payment_method, hpp_total, packing_cost };
    await recordAudit(db, { user: req.user, aksi:'create', modul:'Transaksi Kasir', record_id: txnId, record_label: `Transaksi #${txnId}`, data_sesudah: result });
    res.json(result);
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const allTxns = await db.prepare('SELECT t.*, u.name as kasir FROM transactions t JOIN users u ON t.user_id=u.id').all();
  const { from, to } = req.query;
  let filtered = allTxns;
  if (from) filtered = filtered.filter(t => t.created_at >= from);
  if (to)   filtered = filtered.filter(t => t.created_at <= to + ' 23:59:59');
  filtered = filtered.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  sendCsv(res, 'transaksi_kasir.csv', filtered, [
    { key:'id', label:'No Transaksi' }, { key:'created_at', label:'Waktu' }, { key:'kasir', label:'Kasir' },
    { key:'total', label:'Total' }, { key:'discount', label:'Diskon' }, { key:'tax', label:'Pajak' },
    { key:'payment_method', label:'Metode Bayar' }, { key:'amount_paid', label:'Dibayar' },
    { key:'change_amount', label:'Kembalian' }, { key:'hpp_total', label:'HPP Total' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const allTxns = await db.prepare('SELECT t.*, u.name as kasir FROM transactions t JOIN users u ON t.user_id=u.id').all();
  const { from, to, limit=50 } = req.query;
  let filtered = allTxns;
  if (from) filtered = filtered.filter(t => t.created_at >= from);
  if (to)   filtered = filtered.filter(t => t.created_at <= to + ' 23:59:59');
  filtered = filtered.sort((a,b) => b.created_at?.localeCompare(a.created_at)).slice(0, parseInt(limit));
  res.json(filtered);
});

router.get('/:id/items', auth, async (req, res) => {
  const db = getDb();
  res.json(await db.prepare('SELECT * FROM transaction_items WHERE transaction_id=?').all(parseInt(req.params.id)));
});

module.exports = router;
