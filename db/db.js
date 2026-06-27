require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const COA_SEED = require('./seed_coa');

const SCHEMA = 'pos_finance';

// ── Koneksi ke Supabase PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Set search_path setiap kali ada koneksi baru ke pool
pool.on('connect', client => {
  client.query('SET search_path TO pos_finance, public');
});

let _db = null;

// ── Wrapper agar API mirip libsql lama (prepare().get/all/run) ──
// PostgreSQL pakai $1,$2,... bukan ?
// Kita auto-convert ? → $1,$2,...
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = convertPlaceholders(sql);
  return {
    run: async (...params) => {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const result = await pool.query(pgSql, flat);
      // Untuk INSERT ... RETURNING id
      const lastId = result.rows?.[0]?.id || result.rows?.[0]?.lastid || 0;
      return { lastInsertRowid: Number(lastId) };
    },
    get: async (...params) => {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const result = await pool.query(pgSql, flat);
      return result.rows[0] || undefined;
    },
    all: async (...params) => {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const result = await pool.query(pgSql, flat);
      return result.rows;
    },
  };
}

// run langsung (untuk CREATE TABLE, ALTER, dll)
async function run(sql) {
  const pgSql = convertPlaceholders(sql);
  await pool.query(pgSql);
}

function getDb() {
  return _db;
}

// Prefix semua tabel dengan schema pos_finance
function t(tableName) {
  return `${SCHEMA}.${tableName}`;
}

async function initDb() {
  // Buat schema jika belum ada
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  // Set search_path agar query tanpa prefix tetap bekerja
  await pool.query(`SET search_path TO ${SCHEMA}, public`);

  // ── Buat semua tabel ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'kasir',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.profile (
      id SERIAL PRIMARY KEY,
      nama TEXT,
      alamat TEXT,
      telp TEXT,
      email TEXT,
      logo TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.customers (
      id SERIAL PRIMARY KEY,
      kode TEXT UNIQUE,
      nama TEXT NOT NULL,
      telp TEXT,
      email TEXT,
      alamat TEXT,
      kota TEXT,
      pic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.suppliers (
      id SERIAL PRIMARY KEY,
      kode TEXT UNIQUE,
      nama TEXT NOT NULL,
      telp TEXT,
      email TEXT,
      alamat TEXT,
      kota TEXT,
      pic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.ingredients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT,
      stock REAL DEFAULT 0,
      min_stock REAL DEFAULT 0,
      buy_price REAL DEFAULT 0,
      buy_qty REAL DEFAULT 1,
      buy_unit TEXT,
      is_packing INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.products (
      id SERIAL PRIMARY KEY,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      price REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      hpp REAL DEFAULT 0,
      stock_source TEXT DEFAULT 'resep',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.recipes (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      ingredient_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      UNIQUE(product_id, ingredient_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      opening_cash REAL DEFAULT 0,
      closing_cash REAL,
      outlet TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.transactions (
      id SERIAL PRIMARY KEY,
      session_id INTEGER,
      user_id INTEGER,
      total REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      tax REAL DEFAULT 0,
      payment_method TEXT,
      amount_paid REAL DEFAULT 0,
      change_amount REAL DEFAULT 0,
      hpp_total REAL DEFAULT 0,
      packing_cost REAL DEFAULT 0,
      packing_detail TEXT,
      aggregator_name TEXT,
      aggregator_fee REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.transaction_items (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT,
      price REAL DEFAULT 0,
      hpp REAL DEFAULT 0,
      quantity REAL DEFAULT 1,
      subtotal REAL DEFAULT 0,
      customizations TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.invoices (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      customer_name TEXT,
      tanggal DATE NOT NULL,
      jatuh_tempo DATE,
      catatan TEXT,
      subtotal REAL DEFAULT 0,
      diskon REAL DEFAULT 0,
      pajak REAL DEFAULT 0,
      total REAL DEFAULT 0,
      hpp_total REAL DEFAULT 0,
      status TEXT DEFAULT 'unpaid',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      nama_item TEXT NOT NULL,
      qty REAL DEFAULT 1,
      satuan TEXT,
      harga REAL DEFAULT 0,
      hpp REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.invoice_payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      tanggal DATE NOT NULL,
      jumlah REAL NOT NULL,
      metode TEXT DEFAULT 'transfer',
      catatan TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchases (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      supplier_id INTEGER,
      supplier_name TEXT,
      tanggal DATE NOT NULL,
      catatan TEXT,
      subtotal REAL DEFAULT 0,
      diskon REAL DEFAULT 0,
      pajak REAL DEFAULT 0,
      total REAL DEFAULT 0,
      metode_bayar TEXT DEFAULT 'tempo',
      akun_bayar TEXT,
      status TEXT DEFAULT 'unpaid',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL,
      ingredient_id INTEGER,
      nama_item TEXT NOT NULL,
      qty REAL NOT NULL,
      satuan TEXT,
      harga REAL NOT NULL,
      subtotal REAL NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_payments (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL,
      tanggal DATE NOT NULL,
      jumlah REAL NOT NULL,
      metode TEXT DEFAULT 'transfer',
      catatan TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_returns (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      purchase_id INTEGER,
      supplier_id INTEGER,
      supplier_name TEXT,
      tanggal DATE NOT NULL,
      alasan TEXT,
      total REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_return_items (
      id SERIAL PRIMARY KEY,
      return_id INTEGER NOT NULL,
      ingredient_id INTEGER,
      nama_item TEXT NOT NULL,
      qty REAL NOT NULL,
      satuan TEXT,
      harga REAL NOT NULL,
      subtotal REAL NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_requests (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      kategori TEXT NOT NULL DEFAULT 'persediaan',
      supplier_id INTEGER,
      supplier_name TEXT,
      tanggal DATE NOT NULL,
      alasan TEXT,
      total REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'diajukan',
      catatan_direksi TEXT,
      diajukan_oleh INTEGER NOT NULL,
      diajukan_oleh_nama TEXT,
      diputuskan_oleh INTEGER,
      diputuskan_oleh_nama TEXT,
      diputuskan_at TIMESTAMPTZ,
      purchase_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.purchase_request_items (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      ingredient_id INTEGER,
      nama_item TEXT NOT NULL,
      qty REAL NOT NULL,
      satuan TEXT,
      harga REAL NOT NULL,
      subtotal REAL NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.hutang (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      supplier_id INTEGER,
      supplier_name TEXT NOT NULL,
      tanggal DATE NOT NULL,
      jatuh_tempo DATE,
      keterangan TEXT,
      jumlah REAL NOT NULL,
      sisa REAL NOT NULL,
      status TEXT DEFAULT 'unpaid',
      akun_beban TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.hutang_payments (
      id SERIAL PRIMARY KEY,
      hutang_id INTEGER NOT NULL,
      tanggal DATE NOT NULL,
      jumlah REAL NOT NULL,
      metode TEXT DEFAULT 'transfer',
      catatan TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.assets (
      id SERIAL PRIMARY KEY,
      nama TEXT NOT NULL,
      kode TEXT UNIQUE,
      kategori TEXT,
      tanggal_beli DATE,
      harga_perolehan REAL DEFAULT 0,
      nilai_sisa REAL DEFAULT 0,
      umur_ekonomis INTEGER DEFAULT 5,
      metode_penyusutan TEXT DEFAULT 'garis_lurus',
      akumulasi_penyusutan REAL DEFAULT 0,
      nilai_buku REAL DEFAULT 0,
      keterangan TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.projects (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      nama_event TEXT NOT NULL,
      tanggal_event DATE NOT NULL,
      tanggal_order DATE NOT NULL,
      lokasi TEXT DEFAULT '',
      pic_kontak TEXT DEFAULT '',
      estimasi_porsi INTEGER DEFAULT 0,
      customer_id INTEGER,
      customer_name TEXT DEFAULT '',
      customer_telp TEXT DEFAULT '',
      subtotal REAL DEFAULT 0,
      diskon_total REAL DEFAULT 0,
      diskon_total_persen INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      dp REAL DEFAULT 0,
      sisa REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      catatan TEXT DEFAULT '',
      outlet TEXT DEFAULT '',
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.project_items (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      qty REAL DEFAULT 1,
      harga REAL DEFAULT 0,
      hpp REAL DEFAULT 0,
      diskon_item REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.project_payments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      tanggal DATE NOT NULL,
      jumlah REAL NOT NULL,
      jenis TEXT DEFAULT 'dp',
      metode TEXT DEFAULT 'transfer',
      catatan TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.project_costs (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      nama_biaya TEXT NOT NULL,
      jumlah REAL NOT NULL DEFAULT 0,
      keterangan TEXT DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.accounts (
      id SERIAL PRIMARY KEY,
      kode TEXT UNIQUE NOT NULL,
      nama TEXT NOT NULL,
      jenis TEXT,
      posisi TEXT,
      saldo_normal TEXT,
      kategori_neraca TEXT,
      saldo REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.journal_entries (
      id SERIAL PRIMARY KEY,
      no_bukti TEXT UNIQUE,
      tanggal DATE NOT NULL,
      keterangan TEXT,
      source TEXT,
      source_ref TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.journal_lines (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL,
      account_kode TEXT NOT NULL,
      debet REAL DEFAULT 0,
      kredit REAL DEFAULT 0,
      keterangan TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.operational_costs (
      id SERIAL PRIMARY KEY,
      nama TEXT NOT NULL,
      kategori TEXT NOT NULL,
      nominal REAL NOT NULL,
      tanggal DATE NOT NULL,
      keterangan TEXT DEFAULT '',
      user_id INTEGER,
      outlet TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.aggregator_settings (
      id SERIAL PRIMARY KEY,
      platform TEXT UNIQUE NOT NULL,
      account_kode TEXT,
      default_fee_percent REAL DEFAULT 0,
      aktif INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.customization_options (
      id SERIAL PRIMARY KEY,
      tipe TEXT NOT NULL,
      nama TEXT NOT NULL,
      harga REAL DEFAULT 0,
      urutan INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      ingredient_id INTEGER,
      qty_gram REAL DEFAULT 0,
      hpp_ingredient_id INTEGER,
      hpp_qty REAL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.product_merchant_prices (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      harga REAL NOT NULL DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(product_id, platform)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.entertain_logs (
      id SERIAL PRIMARY KEY,
      tanggal DATE NOT NULL,
      kategori TEXT NOT NULL DEFAULT 'Konsumsi Karyawan',
      keterangan TEXT DEFAULT '',
      items TEXT NOT NULL DEFAULT '[]',
      total_hpp REAL DEFAULT 0,
      user_id INTEGER,
      user_name TEXT,
      outlet TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sales_returns (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      tanggal DATE NOT NULL,
      transaction_id INTEGER,
      metode_refund TEXT DEFAULT 'tunai',
      alasan TEXT DEFAULT '',
      total REAL DEFAULT 0,
      outlet TEXT DEFAULT '',
      user_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sales_return_items (
      id SERIAL PRIMARY KEY,
      return_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      qty REAL DEFAULT 1,
      harga REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.invoice_returns (
      id SERIAL PRIMARY KEY,
      nomor TEXT UNIQUE NOT NULL,
      tanggal DATE NOT NULL,
      invoice_id INTEGER NOT NULL,
      alasan TEXT DEFAULT '',
      total REAL DEFAULT 0,
      metode_refund TEXT DEFAULT 'piutang',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.invoice_return_items (
      id SERIAL PRIMARY KEY,
      return_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      qty REAL DEFAULT 1,
      harga REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.attendance (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tanggal DATE NOT NULL,
      jam_masuk TIME,
      jam_keluar TIME,
      status TEXT DEFAULT 'hadir',
      keterangan TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_name TEXT,
      user_role TEXT,
      aksi TEXT,
      modul TEXT,
      record_id TEXT,
      record_label TEXT,
      data_sebelum TEXT,
      data_sesudah TEXT,
      ip_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Seed data awal ──
  await seedDefaults();

  _db = { prepare, run, pool, query: (sql, params) => pool.query(sql, params) };
  console.log('✅ Database siap (Supabase PostgreSQL - schema: pos_finance)');
  return _db;
}

async function seedDefaults() {
  // Admin default
  const adminExists = await pool.query(`SELECT id FROM ${SCHEMA}.users WHERE username='admin'`);
  if (adminExists.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(`INSERT INTO ${SCHEMA}.users (username,password,name,role) VALUES ('admin',$1,'Administrator','admin')`, [hash]);
    console.log('✅ Admin dibuat: admin / admin123');
  }

  // COA seed
  const coaCount = await pool.query(`SELECT COUNT(*) as c FROM ${SCHEMA}.accounts`);
  if (parseInt(coaCount.rows[0].c) === 0) {
    for (const [kode,nama,jenis,posisi,saldo_normal,kategori_neraca] of COA_SEED) {
      await pool.query(
        `INSERT INTO ${SCHEMA}.accounts (kode,nama,jenis,posisi,saldo_normal,kategori_neraca) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kode) DO NOTHING`,
        [kode,nama,jenis,posisi,saldo_normal,kategori_neraca]
      );
    }
    console.log(`✅ Chart of Accounts diisi (${COA_SEED.length} akun)`);
  }

  // Aggregator settings
  const aggCount = await pool.query(`SELECT COUNT(*) as c FROM ${SCHEMA}.aggregator_settings`);
  if (parseInt(aggCount.rows[0].c) === 0) {
    const platforms = [
      ['GoFood',     '113003', 20],
      ['ShopeeFood', '113004', 20],
      ['GrabFood',   '113005', 20],
    ];
    for (const [platform,account_kode,fee] of platforms) {
      await pool.query(`INSERT INTO ${SCHEMA}.aggregator_settings (platform,account_kode,default_fee_percent) VALUES ($1,$2,$3)`, [platform,account_kode,fee]);
    }
    console.log('✅ Aggregator settings diisi');
  }

  // Customization options default
  const custCount = await pool.query(`SELECT COUNT(*) as c FROM ${SCHEMA}.customization_options`);
  if (parseInt(custCount.rows[0].c) === 0) {
    const defaults = [
      ['sugar','Less Sugar',0,1],
      ['sugar','Normal',0,2],
      ['sugar','Extra Sugar',0,3],
      ['ice','Less Ice',0,1],
      ['ice','Normal Ice',0,2],
      ['ice','Extra Ice',0,3],
      ['ice','No Ice',0,4],
    ];
    for (const [tipe,nama,harga,urutan] of defaults) {
      await pool.query(`INSERT INTO ${SCHEMA}.customization_options (tipe,nama,harga,urutan) VALUES ($1,$2,$3,$4)`, [tipe,nama,harga,urutan]);
    }
    console.log('✅ Customization options default diisi');
  }

  // Packing items
  const packCount = await pool.query(`SELECT COUNT(*) as c FROM ${SCHEMA}.ingredients WHERE is_packing=1`);
  if (parseInt(packCount.rows[0].c) === 0) {
    const packings = [
      ['Cup 16oz','pcs',0,0,'pcs',1],
      ['Sedotan','pcs',0,0,'pcs',1],
      ['Plastik','pcs',0,0,'pcs',1],
    ];
    for (const [name,unit,buy_price,buy_qty,buy_unit,is_packing] of packings) {
      await pool.query(`INSERT INTO ${SCHEMA}.ingredients (name,unit,buy_price,buy_qty,buy_unit,stock,is_packing) VALUES ($1,$2,$3,$4,$5,0,$6)`, [name,unit,buy_price,buy_qty||1,buy_unit,is_packing]);
    }
    console.log('✅ Item packing default ditambahkan');
  }

  // Profile default
  const profCount = await pool.query(`SELECT COUNT(*) as c FROM ${SCHEMA}.profile`);
  if (parseInt(profCount.rows[0].c) === 0) {
    await pool.query(`INSERT INTO ${SCHEMA}.profile (nama,alamat,telp) VALUES ('Juice Smooly','Semarang','08xxx')`);
  }
}

module.exports = { initDb, getDb, prepare, run, pool };
