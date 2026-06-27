const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');
const { journalProject, journalProjectPayment, deleteJournalsForProject, journalProjectCosts, deleteJournalsForProjectCosts } = require('../db/journal_helper');

// Hitung HPP total project dari resep masing-masing item
async function calcHppProject(db, items) {
  const { calcUnitPrice } = require('./ingredients');
  let totalHpp = 0;
  for (const item of items) {
    if (!item.product_id) continue;
    const recipe = await db.prepare(
      `SELECT r.quantity, i.buy_price, i.buy_qty, i.buy_unit, i.unit
       FROM recipes r JOIN ingredients i ON r.ingredient_id=i.id
       WHERE r.product_id=?`
    ).all(item.product_id);
    if (recipe.length === 0) continue;
    const hppPerUnit = recipe.reduce((s, r) =>
      s + calcUnitPrice(r.buy_price, r.buy_qty, r.buy_unit, r.unit) * r.quantity, 0
    );
    totalHpp += hppPerUnit * (item.qty || 1);
  }
  return Math.round(totalHpp);
}

const STATUS = ['draft', 'konfirmasi', 'dp_masuk', 'lunas', 'batal'];
const STATUS_LABEL = { draft:'Draft', konfirmasi:'Dikonfirmasi', dp_masuk:'DP Masuk', lunas:'Lunas', batal:'Dibatalkan' };

async function genNomor(db) {
  const now = new Date();
  const yymm = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}`;
  const last = await db.prepare("SELECT nomor FROM projects WHERE nomor LIKE ? ORDER BY id DESC LIMIT 1").get(`PRJ/${yymm}/%`);
  const seq = last ? parseInt(last.nomor.split('/').pop()) + 1 : 1;
  return `PRJ/${yymm}/${String(seq).padStart(3,'0')}`;
}

function calcProject(items, costs, diskon_total, diskon_total_persen) {
  const subtotalItems = items.reduce((s,i) => s + i.subtotal, 0);
  const subtotalCosts = (costs||[]).reduce((s,c) => s + (parseFloat(c.jumlah)||0), 0);
  const subtotal = subtotalItems + subtotalCosts;
  const disc = diskon_total_persen > 0
    ? subtotal * diskon_total_persen / 100
    : (diskon_total || 0);
  const total = Math.max(subtotal - disc, 0);
  return { subtotal, diskon_total: disc, total };
}

function enrichItems(items) {
  return items.map(i => {
    const hargaSetelahDiskon = i.diskon_item_persen > 0
      ? i.harga * (1 - i.diskon_item_persen / 100)
      : Math.max(i.harga - (i.diskon_item || 0), 0);
    const subtotal = hargaSetelahDiskon * i.qty;
    return { ...i, subtotal };
  });
}

async function getFullProject(db, id) {
  const p = await db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!p) return null;
  const items    = await db.prepare('SELECT * FROM project_items WHERE project_id=? ORDER BY id').all(id);
  const costs    = await db.prepare('SELECT * FROM project_costs WHERE project_id=? ORDER BY id').all(id);
  const payments = await db.prepare('SELECT * FROM project_payments WHERE project_id=? ORDER BY tanggal').all(id);
  const total_bayar = payments.reduce((s,p) => s+p.jumlah, 0);
  const sisa = Math.max((p.total||0) - total_bayar, 0);
  return { ...p, items, costs, payments, total_bayar, sisa };
}

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const all = await db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  sendCsv(res, 'form_project.csv', all, [
    { key:'nomor', label:'Nomor' }, { key:'nama_event', label:'Nama Event' },
    { key:'tanggal_event', label:'Tanggal Event' }, { key:'tanggal_order', label:'Tanggal Order' },
    { key:'lokasi', label:'Lokasi' }, { key:'pic_kontak', label:'PIC Kontak' },
    { key:'customer_name', label:'Konsumen' }, { key:'customer_telp', label:'Telp' },
    { key:'estimasi_porsi', label:'Est. Porsi' }, { key:'subtotal', label:'Subtotal' },
    { key:'diskon_total', label:'Diskon Total' }, { key:'total', label:'Total' },
    { key:'dp', label:'DP' }, { key:'sisa', label:'Sisa' }, { key:'status', label:'Status' },
    { key:'catatan', label:'Catatan' },
  ]);
});

router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { q, status } = req.query;
  let sql = 'SELECT * FROM projects WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (nama_event LIKE ? OR nomor LIKE ? OR customer_name LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  const all = await db.prepare(sql).all(...params);
  res.json(all);
});

router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const p = await getFullProject(db, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project tidak ditemukan' });
  res.json(p);
});

router.post('/', auth, async (req, res) => {
  const db = getDb();
  const {
    nama_event, tanggal_event, tanggal_order, lokasi='', pic_kontak='', estimasi_porsi=0,
    customer_name='', customer_telp='', items=[], costs=[], diskon_total=0, diskon_total_persen=0, dp=0, catatan='', outlet=''
  } = req.body;

  if (!nama_event || !tanggal_event) return res.status(400).json({ error: 'Nama event dan tanggal event wajib diisi' });
  if (!items.length) return res.status(400).json({ error: 'Minimal satu item harus diisi' });

  const enriched = enrichItems(items);
  const validCosts = (costs||[]).filter(c => c.nama_biaya && parseFloat(c.jumlah) > 0);
  const { subtotal, diskon_total: disc, total } = calcProject(enriched, validCosts, diskon_total, diskon_total_persen);
  const sisa = Math.max(total - (parseFloat(dp)||0), 0);
  const nomor = await genNomor(db);
  const now = tanggal_order || new Date().toISOString().split('T')[0];

  const r = await db.prepare(`INSERT INTO projects (nomor,nama_event,tanggal_event,tanggal_order,lokasi,pic_kontak,estimasi_porsi,customer_name,customer_telp,subtotal,diskon_total,diskon_total_persen,total,dp,sisa,catatan,created_by,outlet) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .run(nomor, nama_event, tanggal_event, now, lokasi, pic_kontak, parseInt(estimasi_porsi)||0, customer_name, customer_telp, subtotal, disc, parseInt(diskon_total_persen)||0, total, parseFloat(dp)||0, sisa, catatan, req.user.id, outlet||'');

  const projId = r.lastInsertRowid;
  for (const item of enriched) {
    await db.prepare('INSERT INTO project_items (project_id,product_id,nama_item,qty,harga,diskon_item,diskon_item_persen,subtotal) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
      .run(projId, item.product_id||null, item.nama_item, item.qty, item.harga, item.diskon_item||0, item.diskon_item_persen||0, item.subtotal);
  }

  // Simpan biaya tambahan
  for (const c of validCosts) {
    await db.prepare('INSERT INTO project_costs (project_id,nama_biaya,jumlah,keterangan) VALUES (?,?,?,?) RETURNING id')
      .run(projId, c.nama_biaya.trim(), parseFloat(c.jumlah)||0, c.keterangan||'');
  }

  // Catat DP awal jika ada
  if (parseFloat(dp) > 0) {
    await db.prepare('INSERT INTO project_payments (project_id,tanggal,jumlah,jenis,metode,catatan) VALUES (?,?,?,?,?,?) RETURNING id')
      .run(projId, now, parseFloat(dp), 'dp', 'transfer', 'DP awal saat order');
  }

  const result = await getFullProject(db, projId);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Form Project', record_id: projId, record_label: nomor + ' - ' + nama_event, data_sesudah: result });
  res.json(result);
});

router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await getFullProject(db, req.params.id);
  if (!before) return res.status(404).json({ error: 'Project tidak ditemukan' });

  const {
    nama_event, tanggal_event, tanggal_order, lokasi, pic_kontak, estimasi_porsi,
    customer_name, customer_telp, items, costs, diskon_total, diskon_total_persen, catatan, status, outlet
  } = req.body;

  if (items) {
    const enriched = enrichItems(items);
    const validCosts = (costs||[]).filter(c => c.nama_biaya && parseFloat(c.jumlah) > 0);
    const { subtotal, diskon_total: disc, total } = calcProject(enriched, validCosts, diskon_total, diskon_total_persen);
    const payments = await db.prepare('SELECT * FROM project_payments WHERE project_id=?').all(req.params.id);
    const total_bayar = payments.reduce((s,p) => s+p.jumlah, 0);
    const sisa = Math.max(total - total_bayar, 0);

    await db.prepare(`UPDATE projects SET nama_event=?,tanggal_event=?,tanggal_order=?,lokasi=?,pic_kontak=?,estimasi_porsi=?,customer_name=?,customer_telp=?,subtotal=?,diskon_total=?,diskon_total_persen=?,total=?,sisa=?,catatan=?,status=?,outlet=?,updated_at=NOW() WHERE id=?`)
      .run(nama_event, tanggal_event, tanggal_order||before.tanggal_order, lokasi||'', pic_kontak||'', parseInt(estimasi_porsi)||0, customer_name||'', customer_telp||'', subtotal, disc, parseInt(diskon_total_persen)||0, total, sisa, catatan||'', status||before.status, outlet||before.outlet||'', req.params.id);

    await db.prepare('DELETE FROM project_items WHERE project_id=?').run(req.params.id);
    for (const item of enriched) {
      await db.prepare('INSERT INTO project_items (project_id,product_id,nama_item,qty,harga,diskon_item,diskon_item_persen,subtotal) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
        .run(req.params.id, item.product_id||null, item.nama_item, item.qty, item.harga, item.diskon_item||0, item.diskon_item_persen||0, item.subtotal);
    }

    // Perbarui biaya tambahan
    await db.prepare('DELETE FROM project_costs WHERE project_id=?').run(req.params.id);
    for (const c of validCosts) {
      await db.prepare('INSERT INTO project_costs (project_id,nama_biaya,jumlah,keterangan) VALUES (?,?,?,?) RETURNING id')
        .run(req.params.id, c.nama_biaya.trim(), parseFloat(c.jumlah)||0, c.keterangan||'');
    }
  } else if (status) {
    await db.prepare('UPDATE projects SET status=?,updated_at=NOW() WHERE id=?').run(status, req.params.id);
  }

  const after = await getFullProject(db, req.params.id);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Form Project', record_id: req.params.id, record_label: before.nomor + ' - ' + before.nama_event, data_sebelum: before, data_sesudah: after });
  res.json(after);
});

// Tambah pembayaran (DP lanjutan atau pelunasan)
router.post('/:id/payments', auth, async (req, res) => {
  const db = getDb();
  const proj = await getFullProject(db, req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project tidak ditemukan' });

  const { tanggal, jumlah, jenis='dp', metode='transfer', catatan='' } = req.body;
  if (!jumlah || parseFloat(jumlah) <= 0) return res.status(400).json({ error: 'Jumlah pembayaran harus lebih dari 0' });

  await db.prepare('INSERT INTO project_payments (project_id,tanggal,jumlah,jenis,metode,catatan) VALUES (?,?,?,?,?,?) RETURNING id')
    .run(req.params.id, tanggal, parseFloat(jumlah), jenis, metode, catatan);

  const payments = await db.prepare('SELECT * FROM project_payments WHERE project_id=?').all(req.params.id);
  const total_bayar = payments.reduce((s,p) => s+p.jumlah, 0);
  const sisa = Math.max(proj.total - total_bayar, 0);

  // Update status otomatis
  let newStatus = proj.status;
  if (sisa === 0 && proj.total > 0) newStatus = 'lunas';
  else if (total_bayar > 0 && jenis === 'dp') newStatus = 'dp_masuk';
  await db.prepare('UPDATE projects SET dp=?,sisa=?,status=?,updated_at=NOW() WHERE id=?').run(total_bayar, sisa, newStatus, proj.params?.id || req.params.id);

  // ── Jurnal otomatis ──
  const isFirstPayment = payments.length === 1;
  const hpp_total = await calcHppProject(db, proj.items || []);

  if (isFirstPayment) {
    await journalProject(db, { ...proj, hpp_total, total: proj.total }, { jumlah: parseFloat(jumlah), metode, tanggal });
  } else {
    await journalProjectPayment(db, proj, { jumlah: parseFloat(jumlah), metode, tanggal }, false);
  }

  // Catat biaya project (project_costs) saat status menjadi Lunas
  if (newStatus === 'lunas') {
    const fullProj = await getFullProject(db, req.params.id);
    await journalProjectCosts(db, fullProj);
  }

  res.json(await getFullProject(db, req.params.id));
});

router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const before = await getFullProject(db, req.params.id);
  if (!before) return res.status(404).json({ error: 'Project tidak ditemukan' });
  await db.prepare('DELETE FROM project_items WHERE project_id=?').run(req.params.id);
  await db.prepare('DELETE FROM project_costs WHERE project_id=?').run(req.params.id);
  await db.prepare('DELETE FROM project_payments WHERE project_id=?').run(req.params.id);
  await deleteJournalsForProject(db, req.params.id);
  await deleteJournalsForProjectCosts(db, req.params.id);
  await db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Form Project', record_id: req.params.id, record_label: before.nomor, data_sebelum: before });
  res.json({ success: true });
});

module.exports = router;
