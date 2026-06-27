const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');

const ONLINE_METHODS = ['gofood','shopeefood','grabfood','qris'];

// ── Helper: hitung L/R untuk satu outlet ('' = semua)
async function hitungLaporan(db, start, end, outlet) {
  const outletJoin  = `LEFT JOIN sessions s ON t.session_id = s.id`;
  const outletWhere = outlet ? `AND (s.outlet = ?)` : '';
  const outletParam = outlet ? [outlet] : [];

  const txns = await db.prepare(`
    SELECT t.* FROM transactions t
    ${outletJoin}
    WHERE t.created_at::date >= ? AND t.created_at::date <= ?
    ${outletWhere}
  `).all(start, end, ...outletParam);

  const txnIds = txns.map(t => t.id);

  // ── Penjualan Kasir breakdown: Tunai vs Online
  const total_penjualan_kasir  = txns.reduce((s,t) => s + (t.total||0), 0);
  const total_penjualan_tunai  = txns.filter(t => !ONLINE_METHODS.includes((t.payment_method||'').toLowerCase()))
                                      .reduce((s,t) => s + (t.total||0), 0);
  const total_penjualan_online = txns.filter(t => ONLINE_METHODS.includes((t.payment_method||'').toLowerCase()))
                                      .reduce((s,t) => s + (t.total||0), 0);
  const total_hpp_kasir  = txns.reduce((s,t) => s + (t.hpp_total||0), 0);
  const total_diskon     = txns.reduce((s,t) => s + (t.discount||0), 0);

  // ── Penjualan Project (pembayaran pertama yang masuk di periode ini)
  const outletProjectWhere = outlet ? `AND p.outlet = ?` : '';
  const outletProjectParam = outlet ? [outlet] : [];

  const projectPayments = await db.prepare(`
    SELECT pp.*, p.total as project_total, p.nama_event, p.nomor,
           p.status as project_status, p.outlet as project_outlet,
           (SELECT COUNT(*) FROM project_payments pp2 WHERE pp2.project_id = pp.project_id AND pp2.id <= pp.id) as pay_seq
    FROM project_payments pp
    JOIN projects p ON pp.project_id = p.id
    WHERE pp.tanggal >= ? AND pp.tanggal <= ?
    ${outletProjectWhere}
  `).all(start, end, ...outletProjectParam);

  // Pembayaran pertama = saat jurnal penjualan + HPP dibuat
  const firstPayments = projectPayments.filter(pp => pp.pay_seq === 1);
  // Pembayaran lanjutan = pelunasan piutang saja
  const laterPayments = projectPayments.filter(pp => pp.pay_seq > 1);

  const total_penjualan_project = firstPayments.reduce((s,pp) => s + (pp.project_total||0), 0);
  const total_hpp_project       = 0; // HPP project sudah terhitung terpisah via calcHppProject di projects.js

  // Kas masuk dari project (semua pembayaran yang masuk di periode ini)
  const total_kas_project = projectPayments.reduce((s,pp) => s + (pp.jumlah||0), 0);

  // ── Gabungan penjualan
  const total_penjualan = total_penjualan_kasir + total_penjualan_project;
  const total_hpp       = total_hpp_kasir; // hpp project dicatat di jurnal, tidak ada di tabel project langsung
  const laba_kotor      = total_penjualan - total_hpp;

  // ── Biaya Aggregator & Packing — otomatis dari transaksi kasir
  const total_biaya_aggregator = txns.reduce((s,t) => s + (t.aggregator_fee||0), 0);
  const total_biaya_packing    = txns.reduce((s,t) => s + (t.packing_cost||0), 0);

  // ── Per produk (kasir)
  const allItems = txnIds.length > 0
    ? await db.prepare(`SELECT * FROM transaction_items WHERE transaction_id IN (${txnIds.map(()=>'?').join(',')})`).all(...txnIds)
    : [];
  const productMap = {};
  allItems.forEach(i => {
    const key = i.product_id || i.product_name;
    if (!productMap[key]) productMap[key] = { product_name: i.product_name, qty: 0, revenue: 0, hpp: 0 };
    productMap[key].qty     += i.quantity || 0;
    productMap[key].revenue += i.subtotal || 0;
    productMap[key].hpp     += (i.hpp || 0) * (i.quantity || 0);
  });
  const per_produk = Object.values(productMap)
    .map(p => ({ ...p, laba_kotor: p.revenue - p.hpp }))
    .sort((a,b) => b.laba_kotor - a.laba_kotor);

  // ── Biaya operasional manual — filter by outlet
  const biayaWhere  = outlet
    ? `WHERE tanggal >= ? AND tanggal <= ? AND (outlet = ? OR outlet IS NULL OR outlet = '')`
    : `WHERE tanggal >= ? AND tanggal <= ?`;
  const biayaParams = outlet ? [start, end, outlet] : [start, end];
  const biayaFiltered = await db.prepare(`SELECT * FROM operational_costs ${biayaWhere}`).all(...biayaParams);

  const total_biaya_manual = biayaFiltered.reduce((s,b) => s + (b.nominal||0), 0);

  const biayaKatMap = {};
  biayaFiltered.forEach(b => {
    if (!biayaKatMap[b.kategori]) biayaKatMap[b.kategori] = 0;
    biayaKatMap[b.kategori] += b.nominal || 0;
  });
  const biaya_list = Object.entries(biayaKatMap)
    .map(([kategori, total]) => ({ kategori, total }))
    .sort((a,b) => b.total - a.total);

  const total_biaya_ops = total_biaya_manual + total_biaya_aggregator + total_biaya_packing;

  // ── Biaya project yang lunas di periode ini (project_costs) → masuk Biaya Operasional
  const outletCostWhere = outlet ? `AND p.outlet = ?` : '';
  const lunasProjIds = await db.prepare(`
    SELECT DISTINCT p.id FROM projects p
    WHERE p.status = 'lunas'
    AND p.tanggal_event >= ? AND p.tanggal_event <= ?
    ${outletCostWhere}
  `).all(start, end, ...(outlet ? [outlet] : []));

  let total_biaya_project = 0;
  for (const { id } of lunasProjIds) {
    const c = await db.prepare('SELECT SUM(jumlah) as total FROM project_costs WHERE project_id=?').get(id);
    total_biaya_project += c?.total || 0;
  }

  const total_biaya_all = total_biaya_ops + total_biaya_project;
  const laba_bersih     = laba_kotor - total_biaya_all;

  // ── Harian (kasir + project)
  const harianMap = {};
  txns.forEach(t => {
    const d = t.created_at.slice(0,10);
    if (!harianMap[d]) harianMap[d] = { date:d, penjualan:0, hpp:0, laba_kotor:0, biaya:0 };
    harianMap[d].penjualan  += t.total || 0;
    harianMap[d].hpp        += t.hpp_total || 0;
    harianMap[d].laba_kotor += (t.total||0) - (t.hpp_total||0);
    harianMap[d].biaya      += (t.aggregator_fee||0) + (t.packing_cost||0);
  });
  // Tambah penjualan project ke harian (berdasarkan tanggal pembayaran pertama)
  firstPayments.forEach(pp => {
    const d = pp.tanggal;
    if (!harianMap[d]) harianMap[d] = { date:d, penjualan:0, hpp:0, laba_kotor:0, biaya:0 };
    harianMap[d].penjualan  += pp.project_total || 0;
    harianMap[d].laba_kotor += pp.project_total || 0;
  });
  biayaFiltered.forEach(b => {
    const d = b.tanggal;
    if (!harianMap[d]) harianMap[d] = { date:d, penjualan:0, hpp:0, laba_kotor:0, biaya:0 };
    harianMap[d].biaya += b.nominal || 0;
  });
  const penjualan_harian = Object.values(harianMap).sort((a,b) => a.date.localeCompare(b.date));

  return {
    periode: { from: start, to: end },
    penjualan: {
      total_penjualan,
      total_penjualan_kasir,
      total_penjualan_tunai,
      total_penjualan_online,
      total_penjualan_project,
      total_kas_project,
      jumlah_project: firstPayments.length,
      total_hpp,
      total_diskon,
      jumlah_transaksi: txns.length,
    },
    laba_kotor,
    biaya_operasional: {
      list: biaya_list,
      total_manual:      total_biaya_manual,
      total_aggregator:  total_biaya_aggregator,
      total_packing:     total_biaya_packing,
      total_project:     total_biaya_project,
      total:             total_biaya_all,
    },
    laba_bersih,
    margin_bersih: total_penjualan > 0 ? ((laba_bersih / total_penjualan) * 100).toFixed(1) : 0,
    penjualan_harian,
    per_produk,
  };
}

// ── GET /laporan — semua outlet + per outlet
router.get('/laporan', auth, async (req, res) => {
  const db    = getDb();
  const today = new Date().toISOString().split('T')[0];
  const start = req.query.from || today.slice(0,7) + '-01';
  const end   = req.query.to   || today;

  const OUTLETS = ['Tirto Agung', 'Banjarsari Selatan', 'Veteran'];

  const [holding, ...perOutlet] = await Promise.all([
    hitungLaporan(db, start, end, ''),
    ...OUTLETS.map(o => hitungLaporan(db, start, end, o))
  ]);

  const outletData = {};
  OUTLETS.forEach((o, i) => { outletData[o] = perOutlet[i]; });

  res.json({ holding, outlets: outletData });
});

// ── GET /biaya
router.get('/biaya', auth, async (req, res) => {
  const db    = getDb();
  const today = new Date().toISOString().split('T')[0];
  const start = req.query.from   || today.slice(0,7) + '-01';
  const end   = req.query.to     || today;
  const outlet= req.query.outlet || '';
  const where  = outlet
    ? `WHERE tanggal >= ? AND tanggal <= ? AND (outlet = ? OR outlet IS NULL OR outlet = '')`
    : `WHERE tanggal >= ? AND tanggal <= ?`;
  const params = outlet ? [start, end, outlet] : [start, end];
  res.json(await db.prepare(`SELECT * FROM operational_costs ${where} ORDER BY tanggal DESC`).all(...params));
});

// ── POST /biaya
router.post('/biaya', auth, async (req, res) => {
  const db = getDb();
  const { nama, kategori, nominal, tanggal, keterangan, outlet } = req.body;
  const r = await db.prepare(
    `INSERT INTO operational_costs (nama,kategori,nominal,tanggal,keterangan,user_id,outlet) VALUES (?,?,?,?,?,?,?) RETURNING id`
  ).run(nama, kategori, nominal, tanggal, keterangan||'', req.user.id, outlet||'');
  res.json({ id: r.lastInsertRowid, nama, kategori, nominal, tanggal, keterangan, outlet });
});

// ── PUT /biaya/:id
router.put('/biaya/:id', auth, async (req, res) => {
  const db = getDb();
  const { nama, kategori, nominal, tanggal, keterangan, outlet } = req.body;
  await db.prepare(
    `UPDATE operational_costs SET nama=?,kategori=?,nominal=?,tanggal=?,keterangan=?,outlet=? WHERE id=?`
  ).run(nama, kategori, nominal, tanggal, keterangan||'', outlet||'', req.params.id);
  res.json({ success: true });
});

// ── DELETE /biaya/:id
router.delete('/biaya/:id', auth, async (req, res) => {
  const db = getDb();
  await db.prepare('DELETE FROM operational_costs WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
