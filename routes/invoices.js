const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const {
  journalInvoice, journalInvoicePayment, deleteJournalsForInvoice
} = require('../db/journal_helper');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genNomor(db) {
  const d = new Date();
  const prefix = `INV/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const all = await db.prepare('SELECT nomor FROM invoices').all();
  const matching = all.filter(r => r.nomor && r.nomor.startsWith(prefix));
  if (!matching.length) return prefix + '/001';
  const nums = matching.map(r => parseInt(r.nomor.split('/').pop()) || 0);
  return prefix + '/' + String(Math.max(...nums) + 1).padStart(3, '0');
}

async function enrichInvoice(db, inv) {
  const items    = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(inv.id);
  const payments = await db.prepare('SELECT * FROM invoice_payments WHERE invoice_id=?').all(inv.id);
  const paid     = payments.reduce((s,p) => s + (p.jumlah||0), 0);
  return { ...inv, items, payments, paid, sisa: (inv.total||0) - paid };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM invoices ORDER BY tanggal DESC').all();
  sendCsv(res, 'penjualan_kredit.csv', all, [
    { key:'nomor', label:'No Invoice' }, { key:'customer_name', label:'Konsumen' },
    { key:'tanggal', label:'Tanggal' }, { key:'jatuh_tempo', label:'Jatuh Tempo' },
    { key:'subtotal', label:'Subtotal' }, { key:'diskon', label:'Diskon' }, { key:'pajak', label:'Pajak (%)' },
    { key:'total', label:'Total' }, { key:'hpp_total', label:'HPP Total' }, { key:'status', label:'Status' },
    { key:'catatan', label:'Catatan' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { status, from, to } = req.query;
  let all = await db.prepare('SELECT * FROM invoices').all();

  if (status && status !== 'all') all = all.filter(i => i.status === status);
  if (from) all = all.filter(i => i.tanggal >= from);
  if (to)   all = all.filter(i => i.tanggal <= to);

  all.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const result = [];
  for (const inv of all) result.push(await enrichInvoice(db, inv));
  res.json(result);
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM invoices').all();
  const inv = all.find(i => i.id === parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

  const enriched = await enrichInvoice(db, inv);

  let customer = null;
  if (inv.customer_id) {
    const allCustomers = await db.prepare('SELECT * FROM customers').all();
    customer = allCustomers.find(c => c.id === inv.customer_id) || null;
  }

  const allProfiles = await db.prepare('SELECT * FROM company_profile').all();
  const profile = allProfiles[0] || {};
  res.json({ ...enriched, customer, profile });
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { customer_id, customer_name, tanggal, jatuh_tempo, catatan, items, diskon=0, pajak=0 } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'Item kosong' });

  const nomor     = await genNomor(db);
  const subtotal  = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.harga)||0), 0);
  const hpp_total = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.hpp)||0), 0);
  const total     = subtotal - (parseFloat(diskon)||0) + subtotal * (parseFloat(pajak)||0) / 100;

  let cname = customer_name || '';
  if (customer_id && !cname) {
    const allC = await db.prepare('SELECT * FROM customers').all();
    const c = allC.find(c => c.id === parseInt(customer_id));
    cname = c?.nama || '';
  }

  await db.prepare('INSERT INTO invoices (nomor,customer_id,customer_name,tanggal,jatuh_tempo,catatan,subtotal,diskon,pajak,total,hpp_total,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .run(nomor, customer_id||null, cname, tanggal, jatuh_tempo||null, catatan||'', subtotal, parseFloat(diskon)||0, parseFloat(pajak)||0, total, hpp_total, 'unpaid');

  const allInv = await db.prepare('SELECT * FROM invoices').all();
  const inv = allInv.sort((a,b) => b.id - a.id)[0];

  for (const item of items) {
    await db.prepare('INSERT INTO invoice_items (invoice_id,nama_item,qty,satuan,harga,hpp,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(inv.id, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0, parseFloat(item.hpp)||0, (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));
  }

  await journalInvoice(db, inv);

  const final = await enrichInvoice(db, inv);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Penjualan Kredit', record_id: inv.id, record_label: inv.nomor, data_sesudah: final });
  res.json(final);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const { customer_id, customer_name, tanggal, jatuh_tempo, catatan, items, diskon=0, pajak=0 } = req.body;
  const id = parseInt(req.params.id);

  const before = await enrichInvoice(db, await db.prepare('SELECT * FROM invoices WHERE id=?').get(id));

  const subtotal  = items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.harga)||0), 0);
  const hpp_total = items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.hpp)||0), 0);
  const total     = subtotal - (parseFloat(diskon)||0) + subtotal*(parseFloat(pajak)||0)/100;

  let cname = customer_name || '';
  if (customer_id && !cname) {
    const allC = await db.prepare('SELECT * FROM customers').all();
    const c = allC.find(c => c.id === parseInt(customer_id));
    cname = c?.nama || '';
  }

  await db.prepare('UPDATE invoices SET customer_id=?,customer_name=?,tanggal=?,jatuh_tempo=?,catatan=?,subtotal=?,diskon=?,pajak=?,total=?,hpp_total=?,updated_at=NOW() WHERE id=?')
    .run(customer_id||null, cname, tanggal, jatuh_tempo||null, catatan||'', subtotal, parseFloat(diskon)||0, parseFloat(pajak)||0, total, hpp_total, id);

  await db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
  for (const item of items) {
    await db.prepare('INSERT INTO invoice_items (invoice_id,nama_item,qty,satuan,harga,hpp,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(id, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0, parseFloat(item.hpp)||0, (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));
  }

  const allInv = await db.prepare('SELECT * FROM invoices').all();
  const inv = allInv.find(i => i.id === id);

  await journalInvoice(db, inv);

  const after = await enrichInvoice(db, inv);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Penjualan Kredit', record_id: id, record_label: inv.nomor, data_sebelum: before, data_sesudah: after });
  res.json(after);
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const before = await enrichInvoice(db, await db.prepare('SELECT * FROM invoices WHERE id=?').get(id));
  await db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
  await db.prepare('DELETE FROM invoice_payments WHERE invoice_id=?').run(id);
  await db.prepare('DELETE FROM invoices WHERE id=?').run(id);

  await deleteJournalsForInvoice(db, id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Penjualan Kredit', record_id: id, record_label: before?.nomor, data_sebelum: before });
  res.json({ success: true });
});

router.post('/:id/bayar', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { tanggal, jumlah, metode='transfer', catatan='' } = req.body;

  await db.prepare('INSERT INTO invoice_payments (invoice_id,tanggal,jumlah,metode,catatan) VALUES (?,?,?,?,?) RETURNING id')
    .run(id, tanggal, parseFloat(jumlah), metode, catatan);

  const allInv  = await db.prepare('SELECT * FROM invoices').all();
  const inv     = allInv.find(i => i.id === id);
  const allPay  = await db.prepare('SELECT * FROM invoice_payments').all();
  const payments = allPay.filter(p => p.invoice_id === id);
  const paid    = payments.reduce((s,p) => s + (p.jumlah||0), 0);
  const status  = paid >= inv.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  await db.prepare('UPDATE invoices SET status=?,updated_at=NOW() WHERE id=?').run(status, id);

  const newPayment = payments.sort((a,b)=>b.id-a.id)[0];
  await journalInvoicePayment(db, inv, newPayment);

  await recordAudit(db, { user: req.user, aksi:'update', modul:'Penjualan Kredit', record_id: id, record_label: `Pembayaran ${inv.nomor}`, data_sesudah: newPayment });
  res.json({ success: true, status, paid, sisa: (inv.total||0) - paid });
});

module.exports = router;
