const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');

router.get('/summary', auth, async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const start = req.query.from || today;
  const end   = (req.query.to || today) + ' 23:59:59';

  const summary = await db.prepare(`
    SELECT COUNT(*) as total_transactions,
           COALESCE(SUM(total),0) as total_revenue,
           COALESCE(AVG(total),0) as avg_transaction,
           COALESCE(SUM(discount),0) as total_discount,
           COALESCE(SUM(hpp_total),0) as total_hpp,
           COALESCE(SUM(total)-SUM(hpp_total),0) as total_laba
    FROM transactions WHERE created_at BETWEEN ? AND ?
  `).get(start, end);

  const by_method = await db.prepare(`
    SELECT payment_method, COUNT(*) as count, SUM(total) as total
    FROM transactions WHERE created_at BETWEEN ? AND ? GROUP BY payment_method
  `).all(start, end);

  const top_products = await db.prepare(`
    SELECT ti.product_name, SUM(ti.quantity) as qty_sold,
           SUM(ti.subtotal) as revenue,
           SUM(ti.hpp*ti.quantity) as total_hpp,
           SUM(ti.subtotal)-SUM(ti.hpp*ti.quantity) as laba
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id=t.id
    WHERE t.created_at BETWEEN ? AND ?
    GROUP BY ti.product_name ORDER BY qty_sold DESC LIMIT 10
  `).all(start, end);

  const low_stock = await db.prepare('SELECT id,name,stock,price FROM products WHERE stock<=10 ORDER BY stock ASC LIMIT 10').all();

  const daily = await db.prepare(`
    SELECT created_at::date as date, COUNT(*) as count,
           SUM(total) as revenue, SUM(hpp_total) as hpp,
           SUM(total)-SUM(hpp_total) as laba
    FROM transactions WHERE created_at BETWEEN ? AND ?
    GROUP BY created_at::date ORDER BY date
  `).all(start, end);

  res.json({ summary, by_method, top_products, low_stock, daily });
});

router.get('/dashboard', auth, async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const from  = req.query.from || today;
  const to    = req.query.to   || today;
  const end   = to + ' 23:59:59';
  const outlet = req.query.outlet || '';

  // Build outlet filter — join sessions for outlet info
  const outletJoin = `LEFT JOIN sessions s ON t.session_id=s.id`;
  const outletWhere = outlet ? `AND (s.outlet=? OR s.outlet IS NULL)` : '';
  const outletParams = outlet ? [outlet] : [];

  // Periode sebelumnya untuk perbandingan
  const diffMs = new Date(to) - new Date(from);
  const prevTo   = new Date(new Date(from) - 86400000).toISOString().split('T')[0];
  const prevFrom = new Date(new Date(from) - diffMs - 86400000).toISOString().split('T')[0];

  // Ringkasan periode ini
  const summary = await db.prepare(`
    SELECT COUNT(*) as total_transaksi,
           COALESCE(SUM(t.total),0) as total_penjualan,
           COALESCE(AVG(t.total),0) as rata_rata,
           COALESCE(SUM(t.hpp_total),0) as total_hpp,
           COALESCE(SUM(t.total)-SUM(t.hpp_total),0) as laba_kotor,
           COALESCE(SUM(t.packing_cost),0) as total_packing,
           COALESCE(SUM(t.aggregator_fee),0) as total_potongan_aggregator
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
  `).get(from, end, ...outletParams);

  // Periode sebelumnya (untuk % perubahan)
  const prevSummary = await db.prepare(`
    SELECT COUNT(*) as total_transaksi, COALESCE(SUM(t.total),0) as total_penjualan
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
  `).get(prevFrom, prevTo + ' 23:59:59', ...outletParams);

  // Produk terlaris
  const topProducts = await db.prepare(`
    SELECT ti.product_name, SUM(ti.quantity) as qty_terjual,
           SUM(ti.subtotal) as revenue
    FROM transaction_items ti
    JOIN transactions t ON ti.transaction_id=t.id
    ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
    GROUP BY ti.product_name ORDER BY qty_terjual DESC LIMIT 10
  `).all(from, end, ...outletParams);

  // Metode pembayaran
  const byMethod = await db.prepare(`
    SELECT t.payment_method, COUNT(*) as jumlah, COALESCE(SUM(t.total),0) as total
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
    GROUP BY t.payment_method ORDER BY jumlah DESC
  `).all(from, end, ...outletParams);

  // Per jam (untuk grafik jam ramai)
  const byHour = await db.prepare(`
    SELECT CAST(strftime('%H', t.created_at) AS INTEGER) as jam,
           COUNT(*) as jumlah, COALESCE(SUM(t.total),0) as total
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
    GROUP BY jam ORDER BY jam
  `).all(from, end, ...outletParams);

  // Tren harian (untuk grafik 7/30 hari)
  const byDay = await db.prepare(`
    SELECT t.created_at::date as tanggal,
           COUNT(*) as jumlah, COALESCE(SUM(t.total),0) as total
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ? ${outletWhere}
    GROUP BY tanggal ORDER BY tanggal
  `).all(from, end, ...outletParams);

  // Aggregator breakdown
  const byAggregator = await db.prepare(`
    SELECT t.aggregator_name as platform,
           COUNT(*) as jumlah,
           COALESCE(SUM(t.total),0) as gross,
           COALESCE(SUM(t.aggregator_fee),0) as potongan,
           COALESCE(SUM(t.total)-SUM(t.aggregator_fee),0) as net
    FROM transactions t ${outletJoin}
    WHERE t.payment_method IN ('gofood','shopeefood','grabfood')
      AND t.created_at BETWEEN ? AND ? ${outletWhere}
    GROUP BY t.aggregator_name ORDER BY gross DESC
  `).all(from, end, ...outletParams);

  // Per outlet (untuk perbandingan antar outlet)
  const byOutlet = await db.prepare(`
    SELECT COALESCE(s.outlet,'(Tidak ada sesi)') as outlet,
           COUNT(*) as jumlah, COALESCE(SUM(t.total),0) as total
    FROM transactions t ${outletJoin}
    WHERE t.created_at BETWEEN ? AND ?
    GROUP BY outlet ORDER BY total DESC
  `).all(from, end);

  // Stok bahan hampir habis
  const lowStock = await db.prepare(`
    SELECT name, stock, min_stock, unit, is_packing
    FROM ingredients WHERE stock <= min_stock AND min_stock > 0
    ORDER BY (CAST(stock AS REAL)/CASE WHEN min_stock>0 THEN min_stock ELSE 1 END) ASC LIMIT 5
  `).all();

  res.json({
    periode: { from, to },
    summary, prevSummary,
    topProducts, byMethod, byHour, byDay, byAggregator, byOutlet, lowStock
  });
});

module.exports = router;
