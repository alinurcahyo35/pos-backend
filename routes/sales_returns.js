const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { journalSalesReturn } = require('../db/journal_helper');

async function genNomor(db) {
  const last = await db.prepare("SELECT nomor FROM sales_returns ORDER BY id DESC LIMIT 1").get();
  const n = last ? parseInt((last.nomor||'').replace('RET-',''))||0 : 0;
  return 'RET-' + String(n+1).padStart(4,'0');
}

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const rows = await db.prepare('SELECT * FROM sales_returns ORDER BY tanggal DESC, id DESC').all();
  for (const r of rows) r.items = await db.prepare('SELECT * FROM sales_return_items WHERE return_id=?').all(r.id);
  res.json(rows);
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { tanggal, transaction_id, metode_refund='tunai', alasan='', items=[], outlet='' } = req.body;
  if (!items.length) return res.status(400).json({ error: 'Item retur kosong' });

  const total   = items.reduce((s,i) => s+(i.harga||0)*(i.qty||1), 0);
  const nomor   = await genNomor(db);

  const r = await db.prepare(
    'INSERT INTO sales_returns (nomor,tanggal,transaction_id,metode_refund,alasan,total,outlet,user_id) VALUES (?,?,?,?,?,?,?,?) RETURNING id'
  ).run(nomor, tanggal, transaction_id||null, metode_refund, alasan, total, outlet, req.user.id);

  const retId = r.lastInsertRowid;
  for (const item of items) {
    await db.prepare('INSERT INTO sales_return_items (return_id,product_id,product_name,qty,harga,subtotal) VALUES (?,?,?,?,?,?) RETURNING id')
      .run(retId, item.product_id||null, item.product_name, item.qty||1, item.harga||0, (item.harga||0)*(item.qty||1));
  }

  const saved = { id: retId, nomor, tanggal, transaction_id, metode_refund, alasan, total, outlet };
  await journalSalesReturn(db, saved);
  res.json({ ...saved, items });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  await db.prepare('DELETE FROM sales_return_items WHERE return_id=?').run(req.params.id);
  await db.prepare('DELETE FROM sales_returns WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
