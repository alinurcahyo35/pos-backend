const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const {
  journalPurchase, journalPurchasePayment, deleteJournalsForPurchase
} = require('../db/journal_helper');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genNomor(db) {
  const d = new Date();
  const prefix = `PB/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const all = await db.prepare('SELECT nomor FROM purchases').all();
  const matching = all.filter(r => r.nomor && r.nomor.startsWith(prefix));
  if (!matching.length) return prefix + '/001';
  const nums = matching.map(r => parseInt(r.nomor.split('/').pop()) || 0);
  return prefix + '/' + String(Math.max(...nums) + 1).padStart(3, '0');
}

async function enrichPurchase(db, p) {
  const items    = await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(p.id);
  const payments = await db.prepare('SELECT * FROM purchase_payments WHERE purchase_id=?').all(p.id);
  const paid     = payments.reduce((s,pay) => s + (pay.jumlah||0), 0);
  return { ...p, items, payments, paid, sisa: p.metode_bayar === 'tempo' ? (p.total||0) - paid : 0 };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchases ORDER BY tanggal DESC').all();
  sendCsv(res, 'pembelian.csv', all, [
    { key:'nomor', label:'No Pembelian' }, { key:'supplier_name', label:'Pemasok' }, { key:'tanggal', label:'Tanggal' },
    { key:'subtotal', label:'Subtotal' }, { key:'diskon', label:'Diskon' }, { key:'pajak', label:'Pajak (%)' },
    { key:'total', label:'Total' }, { key:'metode_bayar', label:'Metode Bayar' }, { key:'status', label:'Status' },
    { key:'catatan', label:'Catatan' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { status, metode_bayar, from, to } = req.query;
  let all = await db.prepare('SELECT * FROM purchases').all();

  if (status && status !== 'all') all = all.filter(p => p.status === status);
  if (metode_bayar && metode_bayar !== 'all') all = all.filter(p => p.metode_bayar === metode_bayar);
  if (from) all = all.filter(p => p.tanggal >= from);
  if (to)   all = all.filter(p => p.tanggal <= to);

  all.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const result = [];
  for (const p of all) result.push(await enrichPurchase(db, p));
  res.json(result);
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchases').all();
  const p = all.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Pembelian tidak ditemukan' });

  const enriched = await enrichPurchase(db, p);

  let supplier = null;
  if (p.supplier_id) {
    const allS = await db.prepare('SELECT * FROM suppliers').all();
    supplier = allS.find(s => s.id === p.supplier_id) || null;
  }

  res.json({ ...enriched, supplier });
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const {
    supplier_id, supplier_name, tanggal, jatuh_tempo, catatan,
    items, diskon = 0, pajak = 0,
    metode_bayar = 'cash', akun_bayar
  } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Item kosong' });
  if (metode_bayar === 'cash' && !akun_bayar) return res.status(400).json({ error: 'Pilih akun pembayaran (Kas atau Bank)' });

  const nomor    = await genNomor(db);
  const subtotal = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.harga)||0), 0);
  const total    = subtotal - (parseFloat(diskon)||0) + subtotal * (parseFloat(pajak)||0) / 100;

  let sname = supplier_name || '';
  if (supplier_id && !sname) {
    const allS = await db.prepare('SELECT * FROM suppliers').all();
    const s = allS.find(s => s.id === parseInt(supplier_id));
    sname = s?.nama || '';
  }

  const status = metode_bayar === 'tempo' ? 'unpaid' : 'paid';

  await db.prepare(`INSERT INTO purchases
    (nomor,supplier_id,supplier_name,tanggal,jatuh_tempo,catatan,subtotal,diskon,pajak,total,metode_bayar,akun_bayar,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(nomor, supplier_id||null, sname, tanggal, jatuh_tempo||null, catatan||'',
         subtotal, parseFloat(diskon)||0, parseFloat(pajak)||0, total,
         metode_bayar, metode_bayar === 'tempo' ? null : akun_bayar, status);

  const allP = await db.prepare('SELECT * FROM purchases').all();
  const purchase = allP.sort((a,b)=>b.id-a.id)[0];

  for (const item of items) {
    await db.prepare('INSERT INTO purchase_items (purchase_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(purchase.id, item.ingredient_id||null, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0,
           (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));

    if (item.ingredient_id) {
      await db.prepare('UPDATE ingredients SET stock = stock + ?, updated_at=NOW() WHERE id=?')
        .run(parseFloat(item.qty)||0, item.ingredient_id);
    }
  }

  await journalPurchase(db, purchase);

  const final = await enrichPurchase(db, purchase);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Pembelian', record_id: purchase.id, record_label: purchase.nomor, data_sesudah: final });
  res.json(final);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const {
    supplier_id, supplier_name, tanggal, jatuh_tempo, catatan,
    items, diskon = 0, pajak = 0,
    metode_bayar = 'cash', akun_bayar
  } = req.body;

  if (metode_bayar === 'cash' && !akun_bayar) return res.status(400).json({ error: 'Pilih akun pembayaran (Kas atau Bank)' });

  const before = await enrichPurchase(db, await db.prepare('SELECT * FROM purchases WHERE id=?').get(id));

  const oldItems = await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(id);
  for (const oi of oldItems) {
    if (oi.ingredient_id) {
      await db.prepare('UPDATE ingredients SET stock = stock - ?, updated_at=NOW() WHERE id=?').run(oi.qty, oi.ingredient_id);
    }
  }

  const subtotal = items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.harga)||0), 0);
  const total    = subtotal - (parseFloat(diskon)||0) + subtotal*(parseFloat(pajak)||0)/100;

  let sname = supplier_name || '';
  if (supplier_id && !sname) {
    const allS = await db.prepare('SELECT * FROM suppliers').all();
    const s = allS.find(s => s.id === parseInt(supplier_id));
    sname = s?.nama || '';
  }

  const existing = await db.prepare('SELECT * FROM purchases').all();
  const current = existing.find(p => p.id === id);
  const status = metode_bayar === 'tempo' ? (current?.status === 'unpaid' || !current ? 'unpaid' : current.status) : 'paid';

  await db.prepare(`UPDATE purchases SET
    supplier_id=?,supplier_name=?,tanggal=?,jatuh_tempo=?,catatan=?,subtotal=?,diskon=?,pajak=?,total=?,
    metode_bayar=?,akun_bayar=?,status=?,updated_at=NOW() WHERE id=?`)
    .run(supplier_id||null, sname, tanggal, jatuh_tempo||null, catatan||'',
         subtotal, parseFloat(diskon)||0, parseFloat(pajak)||0, total,
         metode_bayar, metode_bayar === 'tempo' ? null : akun_bayar, status, id);

  await db.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(id);
  for (const item of items) {
    await db.prepare('INSERT INTO purchase_items (purchase_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(id, item.ingredient_id||null, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0,
           (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));

    if (item.ingredient_id) {
      await db.prepare('UPDATE ingredients SET stock = stock + ?, updated_at=NOW() WHERE id=?')
        .run(parseFloat(item.qty)||0, item.ingredient_id);
    }
  }

  const allP = await db.prepare('SELECT * FROM purchases').all();
  const purchase = allP.find(p => p.id === id);
  await journalPurchase(db, purchase);

  const after = await enrichPurchase(db, purchase);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pembelian', record_id: id, record_label: purchase.nomor, data_sebelum: before, data_sesudah: after });
  res.json(after);
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);

  const before = await enrichPurchase(db, await db.prepare('SELECT * FROM purchases WHERE id=?').get(id));

  const items = await db.prepare('SELECT * FROM purchase_items WHERE purchase_id=?').all(id);
  for (const item of items) {
    if (item.ingredient_id) {
      await db.prepare('UPDATE ingredients SET stock = stock - ?, updated_at=NOW() WHERE id=?').run(item.qty, item.ingredient_id);
    }
  }

  await db.prepare('DELETE FROM purchase_items WHERE purchase_id=?').run(id);
  await db.prepare('DELETE FROM purchase_payments WHERE purchase_id=?').run(id);
  await db.prepare('DELETE FROM purchases WHERE id=?').run(id);

  await deleteJournalsForPurchase(db, id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Pembelian', record_id: id, record_label: before?.nomor, data_sebelum: before });
  res.json({ success: true });
});

router.post('/:id/bayar', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { tanggal, jumlah, metode = 'transfer', catatan = '' } = req.body;

  const allP = await db.prepare('SELECT * FROM purchases').all();
  const purchase = allP.find(p => p.id === id);
  if (!purchase) return res.status(404).json({ error: 'Pembelian tidak ditemukan' });
  if (purchase.metode_bayar !== 'tempo') return res.status(400).json({ error: 'Pembelian ini bukan pembelian tempo' });

  await db.prepare('INSERT INTO purchase_payments (purchase_id,tanggal,jumlah,metode,catatan) VALUES (?,?,?,?,?) RETURNING id')
    .run(id, tanggal, parseFloat(jumlah), metode, catatan);

  const allPay   = await db.prepare('SELECT * FROM purchase_payments').all();
  const payments = allPay.filter(p => p.purchase_id === id);
  const paid     = payments.reduce((s,p) => s + (p.jumlah||0), 0);
  const status   = paid >= purchase.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  await db.prepare('UPDATE purchases SET status=?,updated_at=NOW() WHERE id=?').run(status, id);

  const newPayment = payments.sort((a,b)=>b.id-a.id)[0];
  await journalPurchasePayment(db, purchase, newPayment);

  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pembelian', record_id: id, record_label: `Pembayaran ${purchase.nomor}`, data_sesudah: newPayment });
  res.json({ success: true, status, paid, sisa: (purchase.total||0) - paid });
});

module.exports = router;
