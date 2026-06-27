require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDb, getDb } = require('./db/db');
const { backfillJournals } = require('./db/journal_helper');

const app = express();

// Izinkan multiple origin (pisahkan dengan koma di FRONTEND_URL jika perlu)
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map(s=>s.trim());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '5mb' })); // dinaikkan untuk menampung foto selfie base64 (Absensi)

initDb().then(async () => {
  await backfillJournals(getDb());

  app.use('/api/auth',         require('./routes/auth'));
  app.use('/api/products',     require('./routes/products'));
  app.use('/api/transactions', require('./routes/transactions'));
  app.use('/api/sessions',     require('./routes/sessions'));
  app.use('/api/reports',      require('./routes/reports'));
  app.use('/api/ingredients',  require('./routes/ingredients').router);
  app.use('/api/labarugi',     require('./routes/labarugi'));
  app.use('/api/profile',      require('./routes/profile'));
  app.use('/api/customers',    require('./routes/customers'));
  app.use('/api/invoices',     require('./routes/invoices'));
  app.use('/api/hutang',       require('./routes/hutang'));
  app.use('/api/accounts',     require('./routes/accounts'));
  app.use('/api/journal',      require('./routes/journal'));
  app.use('/api/financial',    require('./routes/financial'));
  app.use('/api/suppliers',    require('./routes/suppliers'));
  app.use('/api/purchases',    require('./routes/purchases'));
  app.use('/api/purchase-returns', require('./routes/purchase_returns'));
  app.use('/api/purchase-requests', require('./routes/purchase_requests'));
  app.use('/api/audit', require('./routes/audit'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/aggregator-settings', require('./routes/aggregator_settings'));
  app.use('/api/customizations',      require('./routes/customizations'));
  app.use('/api/entertain',           require('./routes/entertain'));
  app.use('/api/sales-returns',       require('./routes/sales_returns'));
  app.use('/api/invoice-returns',     require('./routes/invoice_returns'));
  app.use('/api/merchant-prices',     require('./routes/merchant_prices'));
  app.use('/api/assets', require('./routes/assets'));
  app.use('/api/projects', require('./routes/projects'));
  app.get('/api/health', (_,res) => res.json({ status:'ok', db: process.env.TURSO_DATABASE_URL ? 'turso' : 'local' }));

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 POS backend: http://localhost:${PORT}`));
}).catch(err => console.error('❌ Gagal start:', err));
