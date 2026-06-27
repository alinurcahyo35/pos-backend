const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const {
  journalPurchaseReturn, deleteJournalsForPurchaseReturn
} = require('../db/journal_helper');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genNomor(db) {
  const d = new Date();
  const prefix = `RB/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const all = await db.prepare('SELECT nomor FROM purchase_returns').all();
  const matching = all.filter(r => r.nomor && r.nomor.startsWith(prefix));
  if (!matching.length) return prefix + '/001';
  const nums = matching.map(r => parseInt(r.nomor.split('/').pop()) || 0);
  return prefix + '/' + String(Math.max(...nums) + 1).padStart(3, '0');
}

async function enrichReturn(db, r) {
  const items = await db.prepare('SELECT * FROM purchase_return_items WHERE return_id=?').all(r.id);
  return { ...r, items };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchase_returns ORDER BY tanggal DESC').all();
  sendCsv(res, 'retur_pembelian.csv', all, [
    { key:'nomor', label:'No Retur' }, { key:'supplier_name', label:'Pemasok' }, { key:'tanggal', label:'Tanggal' },
    { key:'total', label:'Total' }, { key:'akun_pengembalian', label:'Akun Pengembalian' }, { key:'catatan', label:'Catatan' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  let all = await db.prepare('SELECT * FROM purchase_returns').all();

  if (from) all = all.filter(r => r.tanggal >= from);
  if (to)   all = all.filter(r => r.tanggal <= to);

  all.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const result = [];
  for (const r of all) result.push(await enrichReturn(db, r));
  res.json(result);
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchase_returns').all();
  const r = all.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Retur tidak ditemukan' });
  res.json(await enrichReturn(db, r));
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { supplier_id, supplier_name, tanggal, catatan, items, akun_pengembalian = '111001' } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Item retur kosong' });

  for (const item of items) {
    if (!item.ingredient_id) return res.status(400).json({ error: 'Setiap item retur harus dipilih dari Persediaan' });
    const ing = await db.prepare('SELECT * FROM ingredients WHERE id=?').get(item.ingredient_id);
    if (!ing) return res.status(400).json({ error: 'Item persediaan tidak ditemukan' });
    if (ing.stock < parseFloat(item.qty)) return res.status(400).json({ error: `Stok "${ing.name}" tidak cukup untuk diretur (sisa ${ing.stock} ${ing.unit})` });
  }

  const nomor = await genNomor(db);
  const total = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.harga)||0), 0);

  await db.prepare(`INSERT INTO purchase_returns
    (nomor,supplier_id,supplier_name,tanggal,catatan,total,akun_pengembalian)
    VALUES (?,?,?,?,?,?,?) RETURNING id`)
    .run(nomor, supplier_id||null, supplier_name||'', tanggal, catatan||'', total, akun_pengembalian);

  const allR = await db.prepare('SELECT * FROM purchase_returns').all();
  const retur = allR.sort((a,b)=>b.id-a.id)[0];

  for (const item of items) {
    await db.prepare('INSERT INTO purchase_return_items (return_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(retur.id, item.ingredient_id, item.nama_item, parseFloat(item.qty)||0, item.satuan||'', parseFloat(item.harga)||0,
           (parseFloat(item.qty)||0)*(parseFloat(item.harga)||0));

    await db.prepare('UPDATE ingredients SET stock = stock - ?, updated_at=NOW() WHERE id=?')
      .run(parseFloat(item.qty)||0, item.ingredient_id);
  }

  await journalPurchaseReturn(db, retur);

  const final = await enrichReturn(db, retur);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Retur Pembelian', record_id: retur.id, record_label: retur.nomor, data_sesudah: final });
  res.json(final);
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);

  const before = await enrichReturn(db, await db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(id));

  const items = await db.prepare('SELECT * FROM purchase_return_items WHERE return_id=?').all(id);
  for (const item of items) {
    await db.prepare('UPDATE ingredients SET stock = stock + ?, updated_at=NOW() WHERE id=?').run(item.qty, item.ingredient_id);
  }

  await db.prepare('DELETE FROM purchase_return_items WHERE return_id=?').run(id);
  await db.prepare('DELETE FROM purchase_returns WHERE id=?').run(id);

  await deleteJournalsForPurchaseReturn(db, id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Retur Pembelian', record_id: id, record_label: before?.nomor, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
