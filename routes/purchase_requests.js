const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { journalPurchase, journalPurchaseRequest } = require('../db/journal_helper');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

async function genNomor(db) {
  const d = new Date();
  const prefix = `PR/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const all = await db.prepare('SELECT nomor FROM purchase_requests').all();
  const matching = all.filter(r => r.nomor && r.nomor.startsWith(prefix));
  if (!matching.length) return prefix + '/001';
  const nums = matching.map(r => parseInt(r.nomor.split('/').pop()) || 0);
  return prefix + '/' + String(Math.max(...nums) + 1).padStart(3, '0');
}

async function genPurchaseNomor(db) {
  const d = new Date();
  const prefix = `PB/${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const all = await db.prepare('SELECT nomor FROM purchases').all();
  const matching = all.filter(r => r.nomor && r.nomor.startsWith(prefix));
  if (!matching.length) return prefix + '/001';
  const nums = matching.map(r => parseInt(r.nomor.split('/').pop()) || 0);
  return prefix + '/' + String(Math.max(...nums) + 1).padStart(3, '0');
}

async function enrichRequest(db, r) {
  const items = await db.prepare('SELECT * FROM purchase_request_items WHERE request_id=?').all(r.id);
  return { ...r, items };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchase_requests ORDER BY created_at DESC').all();
  sendCsv(res, 'pengajuan_pembelian.csv', all, [
    { key:'nomor', label:'No Pengajuan' }, { key:'kategori', label:'Kategori' }, { key:'supplier_name', label:'Pemasok' },
    { key:'tanggal', label:'Tanggal' }, { key:'alasan', label:'Alasan' }, { key:'total', label:'Total' },
    { key:'status', label:'Status' }, { key:'diajukan_oleh_nama', label:'Diajukan Oleh' },
    { key:'diputuskan_oleh_nama', label:'Diputuskan Oleh' }, { key:'catatan_direksi', label:'Catatan Direksi' }
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { status, kategori } = req.query;
  let all = await db.prepare('SELECT * FROM purchase_requests').all();

  if (status && status !== 'all') all = all.filter(r => r.status === status);
  if (kategori && kategori !== 'all') all = all.filter(r => r.kategori === kategori);

  all.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const result = [];
  for (const r of all) result.push(await enrichRequest(db, r));
  res.json(result);
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM purchase_requests').all();
  const r = all.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
  res.json(await enrichRequest(db, r));
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { kategori = 'persediaan', supplier_id, supplier_name, tanggal, alasan, items } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: 'Item pengajuan kosong' });

  const nomor = await genNomor(db);
  const total = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.harga)||0), 0);

  await db.prepare(`INSERT INTO purchase_requests
    (nomor,kategori,supplier_id,supplier_name,tanggal,alasan,total,status,diajukan_oleh,diajukan_oleh_nama)
    VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(nomor, kategori, supplier_id||null, supplier_name||'', tanggal, alasan||'', total, 'diajukan', req.user.id, req.user.name);

  const allR = await db.prepare('SELECT * FROM purchase_requests').all();
  const request = allR.sort((a,b)=>b.id-a.id)[0];

  for (const item of items) {
    await db.prepare('INSERT INTO purchase_request_items (request_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(request.id, item.ingredient_id||null, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0,
           (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));
  }

  const final = await enrichRequest(db, request);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Pengajuan Pembelian', record_id: request.id, record_label: request.nomor, data_sesudah: final });
  res.json(final);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { kategori, supplier_id, supplier_name, tanggal, alasan, items } = req.body;

  const allR = await db.prepare('SELECT * FROM purchase_requests').all();
  const existing = allR.find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
  if (existing.diajukan_oleh !== req.user.id) return res.status(403).json({ error: 'Hanya pengaju asal yang dapat mengedit' });
  if (!['diajukan','revisi'].includes(existing.status)) return res.status(400).json({ error: 'Pengajuan ini tidak dapat diedit lagi' });

  const before = await enrichRequest(db, existing);

  const total = items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.harga)||0), 0);

  await db.prepare(`UPDATE purchase_requests SET
    kategori=?,supplier_id=?,supplier_name=?,tanggal=?,alasan=?,total=?,status='diajukan',
    catatan_direksi=NULL,diputuskan_oleh=NULL,diputuskan_oleh_nama=NULL,diputuskan_at=NULL,
    updated_at=NOW() WHERE id=?`)
    .run(kategori, supplier_id||null, supplier_name||'', tanggal, alasan||'', total, id);

  await db.prepare('DELETE FROM purchase_request_items WHERE request_id=?').run(id);
  for (const item of items) {
    await db.prepare('INSERT INTO purchase_request_items (request_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .run(id, item.ingredient_id||null, item.nama_item, parseFloat(item.qty)||1, item.satuan||'', parseFloat(item.harga)||0,
           (parseFloat(item.qty)||1)*(parseFloat(item.harga)||0));
  }

  const allR2 = await db.prepare('SELECT * FROM purchase_requests').all();
  const updated = allR2.find(r => r.id === id);
  const after = await enrichRequest(db, updated);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pengajuan Pembelian', record_id: id, record_label: updated.nomor, data_sebelum: before, data_sesudah: after });
  res.json(after);
});

router.post('/:id/keputusan', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { keputusan, catatan_direksi } = req.body;

  if (req.user.role !== 'direksi') return res.status(403).json({ error: 'Hanya Direksi yang dapat memberikan keputusan' });
  if (!['disetujui','ditolak','revisi'].includes(keputusan)) return res.status(400).json({ error: 'Keputusan tidak valid' });

  const allR = await db.prepare('SELECT * FROM purchase_requests').all();
  const request = allR.find(r => r.id === id);
  if (!request) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
  if (request.status !== 'diajukan') return res.status(400).json({ error: 'Pengajuan ini sudah diputuskan atau sedang direvisi' });

  const before = await enrichRequest(db, request);

  await db.prepare(`UPDATE purchase_requests SET
    status=?,catatan_direksi=?,diputuskan_oleh=?,diputuskan_oleh_nama=?,diputuskan_at=NOW(),updated_at=NOW()
    WHERE id=?`).run(keputusan, catatan_direksi||'', req.user.id, req.user.name, id);

  let purchase = null;

  if (keputusan === 'disetujui') {
    const items = await db.prepare('SELECT * FROM purchase_request_items WHERE request_id=?').all(id);
    const nomor = await genPurchaseNomor(db);
    const subtotal = items.reduce((s,i) => s + i.subtotal, 0);

    await db.prepare(`INSERT INTO purchases
      (nomor,supplier_id,supplier_name,tanggal,catatan,subtotal,diskon,pajak,total,metode_bayar,akun_bayar,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .run(nomor, request.supplier_id||null, request.supplier_name||'', request.tanggal,
           `Dari pengajuan ${request.nomor} (${request.kategori})`, subtotal, 0, 0, subtotal,
           'tempo', null, 'unpaid');

    const allP = await db.prepare('SELECT * FROM purchases').all();
    purchase = allP.sort((a,b)=>b.id-a.id)[0];

    for (const item of items) {
      await db.prepare('INSERT INTO purchase_items (purchase_id,ingredient_id,nama_item,qty,satuan,harga,subtotal) VALUES (?,?,?,?,?,?,?) RETURNING id')
        .run(purchase.id, item.ingredient_id||null, item.nama_item, item.qty, item.satuan||'', item.harga, item.subtotal);

      if (item.ingredient_id) {
        await db.prepare('UPDATE ingredients SET stock = stock + ?, updated_at=NOW() WHERE id=?')
          .run(item.qty, item.ingredient_id);
      }
    }

    await journalPurchase(db, purchase);

    // Jurnal tambahan: Persediaan/Aset (Db) / Hutang/Kas (Cr) untuk pengajuan itu sendiri
    await journalPurchaseRequest(db, {
      id, nomor: request.nomor, tanggal: request.tanggal,
      kategori: request.kategori, supplier_name: request.supplier_name||'',
      total: subtotal, metode_bayar: 'hutang',
    });

    await db.prepare('UPDATE purchase_requests SET purchase_id=? WHERE id=?').run(purchase.id, id);

    await recordAudit(db, { user: req.user, aksi:'create', modul:'Pembelian', record_id: purchase.id, record_label: `${purchase.nomor} (otomatis dari ${request.nomor})`, data_sesudah: purchase });
  }

  const allR2 = await db.prepare('SELECT * FROM purchase_requests').all();
  const updated = allR2.find(r => r.id === id);
  const after = await enrichRequest(db, updated);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Pengajuan Pembelian', record_id: id, record_label: `Keputusan: ${keputusan} untuk ${request.nomor}`, data_sebelum: before, data_sesudah: after });
  res.json({ ...after, generated_purchase: purchase });
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);

  const allR = await db.prepare('SELECT * FROM purchase_requests').all();
  const existing = allR.find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: 'Pengajuan tidak ditemukan' });
  if (existing.diajukan_oleh !== req.user.id && req.user.role !== 'direksi') {
    return res.status(403).json({ error: 'Tidak punya akses menghapus pengajuan ini' });
  }
  if (!['diajukan','revisi','ditolak'].includes(existing.status)) {
    return res.status(400).json({ error: 'Pengajuan yang sudah disetujui tidak dapat dihapus' });
  }

  const before = await enrichRequest(db, existing);

  await db.prepare('DELETE FROM purchase_request_items WHERE request_id=?').run(id);
  await db.prepare('DELETE FROM purchase_requests WHERE id=?').run(id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Pengajuan Pembelian', record_id: id, record_label: before?.nomor, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
