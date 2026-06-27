// Helper untuk membuat jurnal otomatis dari Penjualan Kredit & Hutang
// Akun mengikuti Chart of Accounts default

const ACC = {
  PIUTANG_USAHA:          '113002',
  PIUTANG_GOFOOD:         '113003',
  PIUTANG_SHOPEEFOOD:     '113004',
  PIUTANG_GRABFOOD:       '113005',
  PERSEDIAAN_JADI:        '114001',
  AKTIVA_TETAP_DEFAULT:   '116001',
  AKUMULASI_PENYUSUTAN:   '117001',
  HUTANG_USAHA:           '210001',
  MODAL_PEMILIK:          '310001',
  PENJUALAN_ONLINE:       '411001',
  PENJUALAN_CASH:         '411002',
  PENJUALAN_B2B:          '411003',
  HPP_PENJUALAN:          '511001',
  KAS_KECIL:              '111001',
  BANK_BCA:               '112002',
  PERLENGKAPAN_TOKO:      '116001',
  BEBAN_SEWA:             '611002',
  BEBAN_LISTRIK:          '611004',
  BEBAN_AGGREGATOR:       '611016',
  BIAYA_PACKING:          '611017',
  BEBAN_ENTERTAIN:        '611018',
  RETUR_PENJUALAN:        '412001',
  BEBAN_LAIN:             '811001',
};

// Mapping kategori hutang -> akun yang di-debit saat hutang timbul
const HUTANG_DEBIT_MAP = {
  'Supplier Bahan':   ACC.PERSEDIAAN_JADI,
  'Sewa Tempat':      ACC.BEBAN_SEWA,
  'Listrik & Air':    ACC.BEBAN_LISTRIK,
  'Gas':              ACC.BEBAN_LAIN,
  'Peralatan':        ACC.PERLENGKAPAN_TOKO,
  'Pinjaman Bank':    ACC.BANK_BCA,
  'Lain-lain':        ACC.BEBAN_LAIN,
};

// Mapping metode pembayaran -> akun kas/bank/piutang
function metodeToAccount(metode) {
  if (metode === 'tunai') return ACC.KAS_KECIL;
  if (metode === 'gofood') return ACC.PIUTANG_GOFOOD;
  if (metode === 'shopeefood') return ACC.PIUTANG_SHOPEEFOOD;
  if (metode === 'grabfood') return ACC.PIUTANG_GRABFOOD;
  return ACC.BANK_BCA; // kartu, qris, transfer, dan lainnya dianggap masuk rekening bank
}

async function genNoBukti(db) {
  const all = await db.prepare('SELECT no_bukti FROM journal_entries').all();
  const nums = all.map(j => {
    const m = (j.no_bukti||'').match(/JU-(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'JU-' + String(next).padStart(3, '0');
}

async function insertEntry(db, { tanggal, keterangan, source, source_ref, lines }) {
  const validLines = lines.filter(l => (l.debet||0) > 0 || (l.kredit||0) > 0);
  if (validLines.length === 0) return null;
  const totalD = validLines.reduce((s,l)=>s+(l.debet||0),0);
  const totalK = validLines.reduce((s,l)=>s+(l.kredit||0),0);
  if (Math.abs(totalD - totalK) > 0.01) return null;

  const no_bukti = await genNoBukti(db);

  // Pakai RETURNING id agar dapat id langsung (PostgreSQL)
  const entryResult = await db.prepare(
    'INSERT INTO journal_entries (no_bukti,tanggal,keterangan,source,source_ref) VALUES (?,?,?,?,?) RETURNING id RETURNING id'
  ).get(no_bukti, tanggal, keterangan||'', source, source_ref);
  const entryId = entryResult?.id || entryResult?.lastInsertRowid;

  for (const line of validLines) {
    await db.prepare('INSERT INTO journal_lines (entry_id,account_kode,keterangan,debet,kredit) VALUES (?,?,?,?,?) RETURNING id')
      .run(entryId, line.account_kode, line.keterangan||'', line.debet||0, line.kredit||0);
  }
  return { id: entryId, no_bukti };
}

// Hapus semua jurnal yang terkait dengan source_ref tertentu
async function deleteJournalsBySourceRef(db, source_ref, sources) {
  const all = await db.prepare('SELECT * FROM journal_entries WHERE source_ref=?').all(String(source_ref));
  const toDelete = all.filter(e => sources.includes(e.source));
  for (const entry of toDelete) {
    await db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(entry.id);
    await db.prepare('DELETE FROM journal_entries WHERE id=?').run(entry.id);
  }
}

// ─── PENJUALAN KREDIT (Invoice) ───────────────────────────

async function journalInvoice(db, invoice) {
  await deleteJournalsBySourceRef(db, invoice.id, ['invoice']);

  const lines = [
    { account_kode: ACC.PIUTANG_USAHA,  debet: invoice.total,  keterangan: `Piutang ${invoice.nomor}` },
    { account_kode: ACC.PENJUALAN_B2B,  kredit: invoice.total, keterangan: `Penjualan B2B ${invoice.nomor}` },
  ];

  if (invoice.hpp_total > 0) {
    lines.push({ account_kode: ACC.HPP_PENJUALAN,   debet: invoice.hpp_total,  keterangan: `HPP ${invoice.nomor}` });
    lines.push({ account_kode: ACC.PERSEDIAAN_JADI, kredit: invoice.hpp_total, keterangan: `Pengurangan persediaan ${invoice.nomor}` });
  }

  await insertEntry(db, {
    tanggal: invoice.tanggal,
    keterangan: `Penjualan kredit ${invoice.nomor} - ${invoice.customer_name||''}`,
    source: 'invoice',
    source_ref: invoice.id,
    lines
  });
}

async function journalInvoicePayment(db, invoice, payment) {
  const lines = [
    { account_kode: metodeToAccount(payment.metode), debet: payment.jumlah,  keterangan: `Pembayaran ${invoice.nomor}` },
    { account_kode: ACC.PIUTANG_USAHA,                kredit: payment.jumlah, keterangan: `Pelunasan piutang ${invoice.nomor}` },
  ];
  await insertEntry(db, {
    tanggal: payment.tanggal,
    keterangan: `Pembayaran piutang ${invoice.nomor} - ${invoice.customer_name||''}`,
    source: 'invoice_payment',
    source_ref: invoice.id,
    lines
  });
}

async function deleteJournalsForInvoice(db, invoiceId) {
  await deleteJournalsBySourceRef(db, invoiceId, ['invoice','invoice_payment']);
}

// ─── HUTANG ────────────────────────────────────────────────

async function journalHutang(db, hutang) {
  await deleteJournalsBySourceRef(db, hutang.id, ['hutang']);

  const debitAccount = HUTANG_DEBIT_MAP[hutang.kategori] || ACC.BEBAN_LAIN;
  const lines = [
    { account_kode: debitAccount,     debet: hutang.jumlah,  keterangan: `${hutang.keterangan||hutang.kategori} (${hutang.nama_kreditur})` },
    { account_kode: ACC.HUTANG_USAHA, kredit: hutang.jumlah, keterangan: `Hutang ${hutang.kode} - ${hutang.nama_kreditur}` },
  ];

  await insertEntry(db, {
    tanggal: hutang.tanggal,
    keterangan: `Hutang ${hutang.kode} - ${hutang.nama_kreditur} (${hutang.kategori})`,
    source: 'hutang',
    source_ref: hutang.id,
    lines
  });
}

async function journalHutangPayment(db, hutang, payment) {
  const lines = [
    { account_kode: ACC.HUTANG_USAHA,            debet: payment.jumlah,  keterangan: `Pembayaran hutang ${hutang.kode}` },
    { account_kode: metodeToAccount(payment.metode), kredit: payment.jumlah, keterangan: `Pembayaran ke ${hutang.nama_kreditur}` },
  ];
  await insertEntry(db, {
    tanggal: payment.tanggal,
    keterangan: `Pembayaran hutang ${hutang.kode} - ${hutang.nama_kreditur}`,
    source: 'hutang_payment',
    source_ref: hutang.id,
    lines
  });
}

async function deleteJournalsForHutang(db, hutangId) {
  await deleteJournalsBySourceRef(db, hutangId, ['hutang','hutang_payment']);
}

// ─── PEMBELIAN ─────────────────────────────────────────────
// Cash:  Debit Persediaan / Kredit Kas atau Bank (sesuai akun_bayar yang dipilih)
// Tempo: Debit Persediaan / Kredit Hutang Usaha

async function journalPurchase(db, purchase) {
  await deleteJournalsBySourceRef(db, purchase.id, ['purchase']);

  const kreditAccount = purchase.metode_bayar === 'tempo'
    ? ACC.HUTANG_USAHA
    : (purchase.akun_bayar || ACC.KAS_KECIL);

  const lines = [
    { account_kode: ACC.PERSEDIAAN_JADI, debet: purchase.total,  keterangan: `Pembelian ${purchase.nomor}` },
    { account_kode: kreditAccount,       kredit: purchase.total, keterangan: purchase.metode_bayar === 'tempo'
        ? `Hutang dagang ${purchase.nomor} - ${purchase.supplier_name||''}`
        : `Pembayaran cash ${purchase.nomor} - ${purchase.supplier_name||''}` },
  ];

  await insertEntry(db, {
    tanggal: purchase.tanggal,
    keterangan: `Pembelian ${purchase.nomor} - ${purchase.supplier_name||''} (${purchase.metode_bayar})`,
    source: 'purchase',
    source_ref: purchase.id,
    lines
  });
}

// Pelunasan pembelian tempo: Debit Hutang Usaha / Kredit Kas atau Bank
async function journalPurchasePayment(db, purchase, payment) {
  const lines = [
    { account_kode: ACC.HUTANG_USAHA,                kredit: 0, debet: payment.jumlah, keterangan: `Pembayaran ${purchase.nomor}` },
    { account_kode: metodeToAccount(payment.metode), kredit: payment.jumlah,            keterangan: `Pembayaran ke ${purchase.supplier_name||''}` },
  ];
  await insertEntry(db, {
    tanggal: payment.tanggal,
    keterangan: `Pembayaran hutang dagang ${purchase.nomor} - ${purchase.supplier_name||''}`,
    source: 'purchase_payment',
    source_ref: purchase.id,
    lines
  });
}

async function deleteJournalsForPurchase(db, purchaseId) {
  await deleteJournalsBySourceRef(db, purchaseId, ['purchase','purchase_payment']);
}

// ─── RETUR PEMBELIAN ───────────────────────────────────────
// Berdiri sendiri (tidak terikat ke transaksi Pembelian tertentu)
// Jurnal: Retur Pembelian (debit akun pengembalian dana) / Persediaan (kredit)

async function journalPurchaseReturn(db, retur) {
  await deleteJournalsBySourceRef(db, retur.id, ['purchase_return']);

  const lines = [
    { account_kode: retur.akun_pengembalian || ACC.KAS_KECIL, debet: retur.total,  keterangan: `Retur pembelian ${retur.nomor}` },
    { account_kode: ACC.PERSEDIAAN_JADI,                      kredit: retur.total, keterangan: `Pengurangan persediaan - retur ${retur.nomor}` },
  ];

  await insertEntry(db, {
    tanggal: retur.tanggal,
    keterangan: `Retur pembelian ${retur.nomor}${retur.supplier_name ? ' - ' + retur.supplier_name : ''}`,
    source: 'purchase_return',
    source_ref: retur.id,
    lines
  });
}

async function deleteJournalsForPurchaseReturn(db, returId) {
  await deleteJournalsBySourceRef(db, returId, ['purchase_return']);
}

// ─── TRANSAKSI KASIR (POS) ─────────────────────────────────
// Jurnal: Kas/Bank (debit, sesuai metode bayar) / Penjualan Cash (kredit, subtotal)
//         HPP Penjualan (debit) / Persediaan Bahan Jadi (kredit) - jika ada HPP
//         Biaya Packing (debit) / Kas-Bank yang sama (kredit) - jika kasir input biaya packing
//         Beban Aggregator (debit) / Kas-Bank yang sama (kredit) - jika ada potongan platform
// Diskon transaksi langsung mengurangi nominal Penjualan Cash (net), bukan baris terpisah.

async function journalTransaction(db, txn) {
  await deleteJournalsBySourceRef(db, txn.id, ['transaction']);

  const AGGREGATOR_METHODS = ['gofood', 'shopeefood', 'grabfood'];
  const method        = (txn.payment_method || '').toLowerCase();
  const isAggregator  = AGGREGATOR_METHODS.includes(method);
  const isOnline      = isAggregator || method === 'qris';

  const akunPiutangPlatform = metodeToAccount(txn.payment_method); // 113003/004/005 atau Bank untuk qris/kartu/tunai
  const akunPenjualan       = isOnline ? ACC.PENJUALAN_ONLINE : ACC.PENJUALAN_CASH;
  const netPenjualan        = txn.total || 0;
  const packingCost         = txn.packing_cost || 0;
  const aggregatorFee       = txn.aggregator_fee || 0;

  const lines = [];

  if (isAggregator) {
    // ── Transaksi via merchant aggregator (GoFood/ShopeeFood/GrabFood) ──
    // Piutang Platform = total bruto (akan diterima sebelum dipotong fee)
    lines.push({ account_kode: akunPiutangPlatform, debet: netPenjualan, keterangan: `Piutang ${txn.aggregator_name||method} transaksi #${txn.id}` });
    // Penjualan = total bruto
    lines.push({ account_kode: akunPenjualan, kredit: netPenjualan, keterangan: `Penjualan Online transaksi #${txn.id}` });
    // Beban Aggregator (Db) / Piutang Platform (Cr) — fee dipotong dari piutang
    if (aggregatorFee > 0) {
      lines.push({ account_kode: ACC.BEBAN_AGGREGATOR,   debet:  aggregatorFee, keterangan: `Beban fee ${txn.aggregator_name||method} transaksi #${txn.id}` });
      lines.push({ account_kode: akunPiutangPlatform,    kredit: aggregatorFee, keterangan: `Potongan fee ${txn.aggregator_name||method} transaksi #${txn.id}` });
    }
  } else {
    // ── Transaksi tunai / QRIS / kartu / transfer ──
    const netDiterima = netPenjualan - packingCost;
    lines.push({ account_kode: akunPiutangPlatform, debet: netDiterima > 0 ? netDiterima : 0, keterangan: `Penerimaan transaksi #${txn.id}` });
    lines.push({ account_kode: akunPenjualan,        kredit: netPenjualan,                     keterangan: `Penjualan ${isOnline ? 'Online' : 'Cash'} transaksi #${txn.id}` });
  }

  // Biaya packing (berlaku semua metode)
  if (packingCost > 0) {
    lines.push({ account_kode: ACC.BIAYA_PACKING,    debet:  packingCost, keterangan: `Biaya packing transaksi #${txn.id}` });
    lines.push({ account_kode: ACC.PERSEDIAAN_JADI,  kredit: packingCost, keterangan: `Pengurangan stok packing transaksi #${txn.id}` });
  }

  // HPP + Persediaan
  if (txn.hpp_total > 0) {
    lines.push({ account_kode: ACC.HPP_PENJUALAN,   debet:  txn.hpp_total, keterangan: `HPP transaksi #${txn.id}` });
    lines.push({ account_kode: ACC.PERSEDIAAN_JADI, kredit: txn.hpp_total, keterangan: `Pengurangan persediaan transaksi #${txn.id}` });
  }

  await insertEntry(db, {
    tanggal: (txn.created_at||'').split('T')[0] || (txn.created_at||'').split(' ')[0],
    keterangan: `Penjualan kasir transaksi #${txn.id} (${txn.payment_method||'-'})`,
    source: 'transaction',
    source_ref: txn.id,
    lines,
  });
}

async function deleteJournalsForTransaction(db, txnId) {
  await deleteJournalsBySourceRef(db, txnId, ['transaction']);
}

// ─── FORM PROJECT (Catering/Event) ────────────────────────
// Pembayaran pertama (DP atau lunas sekaligus):
//   Kas/Bank          Debit  (jumlah_bayar)
//   Piutang Usaha     Debit  (sisa belum dibayar, jika ada)
//   Penjualan B2B     Kredit (total project)
//   HPP Penjualan     Debit  (total hpp)
//   Persediaan Jadi   Kredit (total hpp)
//
// Pembayaran lanjutan (pelunasan piutang):
//   Kas/Bank          Debit  (jumlah bayar)
//   Piutang Usaha     Kredit (jumlah bayar)

async function journalProject(db, project, firstPayment) {
  // Hapus jurnal project sebelumnya (bukan pembayaran)
  await deleteJournalsBySourceRef(db, `project_${project.id}`, ['project']);

  const total    = project.total || 0;
  const hpp      = project.hpp_total || 0;
  const bayar    = firstPayment?.jumlah || 0;
  const sisa     = Math.max(total - bayar, 0);
  const metode   = firstPayment?.metode || 'transfer';
  const tanggal  = firstPayment?.tanggal || project.tanggal_order || new Date().toISOString().split('T')[0];
  const akunKas  = metode === 'tunai' ? ACC.KAS_KECIL : ACC.BANK_BCA;

  const lines = [];

  // Kas/Bank — sebesar yang diterima
  if (bayar > 0) {
    lines.push({ account_kode: akunKas, debet: bayar, keterangan: `Penerimaan project ${project.nomor}` });
  }
  // Piutang — sisa yang belum dibayar
  if (sisa > 0) {
    lines.push({ account_kode: ACC.PIUTANG_USAHA, debet: sisa, keterangan: `Piutang project ${project.nomor}` });
  }
  // Penjualan B2B
  lines.push({ account_kode: ACC.PENJUALAN_B2B, kredit: total, keterangan: `Penjualan project ${project.nomor} - ${project.nama_event||''}` });

  // HPP + Persediaan
  if (hpp > 0) {
    lines.push({ account_kode: ACC.HPP_PENJUALAN,   debet: hpp,  keterangan: `HPP project ${project.nomor}` });
    lines.push({ account_kode: ACC.PERSEDIAAN_JADI, kredit: hpp, keterangan: `Pengurangan persediaan project ${project.nomor}` });
  }

  await insertEntry(db, {
    tanggal,
    keterangan: `Penjualan project ${project.nomor} - ${project.nama_event||''} (${project.customer_name||''})`,
    source: 'project',
    source_ref: `project_${project.id}`,
    lines,
  });
}

async function journalProjectPayment(db, project, payment, isFirst = false) {
  if (isFirst) {
    // Pembayaran pertama sudah dicatat di journalProject
    return;
  }
  // Pembayaran lanjutan: Kas/Bank (Db) / Piutang Usaha (Kr)
  const akunKas = payment.metode === 'tunai' ? ACC.KAS_KECIL : ACC.BANK_BCA;
  const lines = [
    { account_kode: akunKas,            debet: payment.jumlah,  keterangan: `Pelunasan project ${project.nomor}` },
    { account_kode: ACC.PIUTANG_USAHA,  kredit: payment.jumlah, keterangan: `Pelunasan piutang project ${project.nomor}` },
  ];
  await insertEntry(db, {
    tanggal: payment.tanggal,
    keterangan: `Pelunasan piutang project ${project.nomor} - ${project.nama_event||''} (${project.customer_name||''})`,
    source: 'project_payment',
    source_ref: `project_${project.id}`,
    lines,
  });
}

async function deleteJournalsForProject(db, projectId) {
  await deleteJournalsBySourceRef(db, `project_${projectId}`, ['project', 'project_payment']);
}

// Jurnal biaya project (project_costs) — dicatat saat status Lunas
// Beban Operasional Lainnya (811001) Debit / Hutang Usaha (210001) Kredit
async function journalProjectCosts(db, project) {
  await deleteJournalsBySourceRef(db, `project_costs_${project.id}`, ['project_costs']);

  const costs = await db.prepare('SELECT * FROM project_costs WHERE project_id=?').all(project.id);
  const totalBiaya = costs.reduce((s, c) => s + (c.jumlah||0), 0);
  if (totalBiaya <= 0) return;

  const tanggal = project.tanggal_event || project.tanggal_order || new Date().toISOString().split('T')[0];

  await insertEntry(db, {
    tanggal,
    keterangan: `Biaya operasional project ${project.nomor} - ${project.nama_event||''} (${costs.length} item biaya)`,
    source: 'project_costs',
    source_ref: `project_costs_${project.id}`,
    lines: [
      { account_kode: ACC.BEBAN_LAIN,   debet: totalBiaya,  keterangan: `Biaya project ${project.nomor}` },
      { account_kode: ACC.HUTANG_USAHA, kredit: totalBiaya, keterangan: `Hutang biaya project ${project.nomor}` },
    ],
  });
}

async function deleteJournalsForProjectCosts(db, projectId) {
  await deleteJournalsBySourceRef(db, `project_costs_${projectId}`, ['project_costs']);
}

// ─── RETUR PENJUALAN KASIR ────────────────────────────────
// Retur Penjualan 412001 (Db) / Kas/Bank (Cr)
async function journalSalesReturn(db, ret) {
  await deleteJournalsBySourceRef(db, `sales_return_${ret.id}`, ['sales_return']);
  const akunRefund = ret.metode_refund === 'tunai' ? ACC.KAS_KECIL : ACC.BANK_BCA;
  await insertEntry(db, {
    tanggal: ret.tanggal,
    keterangan: `Retur penjualan kasir ${ret.nomor}`,
    source: 'sales_return',
    source_ref: `sales_return_${ret.id}`,
    lines: [
      { account_kode: ACC.RETUR_PENJUALAN, debet: ret.total,  keterangan: `Retur ${ret.nomor} - ${ret.alasan||''}` },
      { account_kode: akunRefund,          kredit: ret.total, keterangan: `Refund kas retur ${ret.nomor}` },
    ],
  });
}

// ─── RETUR PENJUALAN INVOICE B2B ──────────────────────────
// Retur Penjualan 412001 (Db) / Piutang Usaha 113002 (Cr)
async function journalInvoiceReturn(db, ret) {
  await deleteJournalsBySourceRef(db, `invoice_return_${ret.id}`, ['invoice_return']);
  await insertEntry(db, {
    tanggal: ret.tanggal,
    keterangan: `Retur penjualan invoice B2B ${ret.nomor}`,
    source: 'invoice_return',
    source_ref: `invoice_return_${ret.id}`,
    lines: [
      { account_kode: ACC.RETUR_PENJUALAN, debet: ret.total,  keterangan: `Retur invoice ${ret.nomor}` },
      { account_kode: ACC.PIUTANG_USAHA,   kredit: ret.total, keterangan: `Pengurangan piutang retur ${ret.nomor}` },
    ],
  });
}

// ─── ENTERTAIN ────────────────────────────────────────────
// Beban Entertain 611018 (Db) / Persediaan 114001 (Cr)
async function journalEntertain(db, ent) {
  await deleteJournalsBySourceRef(db, `entertain_${ent.id}`, ['entertain']);
  if (!ent.total_hpp || ent.total_hpp <= 0) return;
  await insertEntry(db, {
    tanggal: ent.tanggal,
    keterangan: `Entertain - ${ent.kategori} - ${ent.keterangan||''}`,
    source: 'entertain',
    source_ref: `entertain_${ent.id}`,
    lines: [
      { account_kode: ACC.BEBAN_ENTERTAIN, debet:  ent.total_hpp, keterangan: `Beban entertain ${ent.kategori}` },
      { account_kode: ACC.PERSEDIAAN_JADI, kredit: ent.total_hpp, keterangan: `Pengurangan persediaan entertain` },
    ],
  });
}

// ─── PENGAJUAN PEMBELIAN (saat disetujui) ─────────────────
// Kategori persediaan: Persediaan 114001 (Db) / Hutang Usaha 210001 atau Kas (Cr)
// Kategori aset: Aset Tetap 116001 (Db) / Hutang Usaha 210001 atau Kas (Cr)
async function journalPurchaseRequest(db, req_data) {
  await deleteJournalsBySourceRef(db, `purchase_req_${req_data.id}`, ['purchase_request']);
  const akunDebet  = req_data.kategori === 'aset' ? ACC.AKTIVA_TETAP_DEFAULT : ACC.PERSEDIAAN_JADI;
  const akunKredit = req_data.metode_bayar === 'tunai' ? ACC.KAS_KECIL
                   : req_data.metode_bayar === 'transfer' ? ACC.BANK_BCA
                   : ACC.HUTANG_USAHA;
  await insertEntry(db, {
    tanggal: req_data.tanggal,
    keterangan: `Pengajuan pembelian disetujui ${req_data.nomor} - ${req_data.supplier_name||''}`,
    source: 'purchase_request',
    source_ref: `purchase_req_${req_data.id}`,
    lines: [
      { account_kode: akunDebet,  debet:  req_data.total, keterangan: `${req_data.kategori === 'aset' ? 'Aset tetap' : 'Persediaan'} dari pengajuan ${req_data.nomor}` },
      { account_kode: akunKredit, kredit: req_data.total, keterangan: `${akunKredit === ACC.HUTANG_USAHA ? 'Hutang usaha' : 'Kas/Bank'} pengajuan ${req_data.nomor}` },
    ],
  });
}


// Jurnal pencatatan aset baru:
//   Aktiva Tetap / Perlengkapan Toko (debit, nilai beli) / Modal Pemilik (kredit)
// Jurnal penyusutan (jika ada akumulasi penyusutan):
//   Beban Penyusutan (debit) / Akumulasi Penyusutan (kredit)

async function journalAsset(db, asset) {
  await deleteJournalsBySourceRef(db, asset.id, ['asset']);

  const akunAktiva = asset.account_kode || ACC.AKTIVA_TETAP_DEFAULT;
  const lines = [
    { account_kode: akunAktiva,        debet: asset.nilai_beli, keterangan: `Pencatatan aset: ${asset.nama} (${asset.kode})` },
    { account_kode: ACC.MODAL_PEMILIK, kredit: asset.nilai_beli, keterangan: `Sumber modal - aset ${asset.kode}` },
  ];

  // Hitung akumulasi penyusutan sampai sekarang
  if (asset.masa_manfaat > 0 && asset.tanggal_beli) {
    const penyusutanPerTahun = (asset.nilai_beli - (asset.nilai_residu||0)) / asset.masa_manfaat;
    const beli = new Date(asset.tanggal_beli);
    const now  = new Date();
    const tahun = Math.min((now - beli) / (1000*60*60*24*365), asset.masa_manfaat);
    const akumulasi = Math.round(penyusutanPerTahun * tahun);
    if (akumulasi > 0) {
      lines.push({ account_kode: '811002', debet: akumulasi,  keterangan: `Beban penyusutan - ${asset.nama}` });
      lines.push({ account_kode: ACC.AKUMULASI_PENYUSUTAN, kredit: akumulasi, keterangan: `Akumulasi penyusutan - ${asset.nama}` });
    }
  }

  await insertEntry(db, {
    tanggal: asset.tanggal_beli || new Date().toISOString().split('T')[0],
    keterangan: `Pencatatan aset tetap: ${asset.nama} (${asset.kode})`,
    source: 'asset',
    source_ref: asset.id,
    lines
  });
}

async function deleteJournalsForAsset(db, assetId) {
  await deleteJournalsBySourceRef(db, assetId, ['asset']);
}

// ─── BACKFILL (untuk data yang sudah ada sebelum modul jurnal aktif) ──
async function backfillJournals(db) {
  let allEntries = await db.prepare('SELECT * FROM journal_entries').all();
  const hasJournal = (source_ref, source) => allEntries.some(e => e.source_ref === source_ref && e.source === source);

  // Invoices
  const invoices = await db.prepare('SELECT * FROM invoices').all();
  let countInv = 0;
  for (const inv of invoices) {
    if (!hasJournal(inv.id, 'invoice')) {
      await journalInvoice(db, inv);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countInv++;
    }
    const payments = await db.prepare('SELECT * FROM invoice_payments WHERE invoice_id=?').all(inv.id);
    const existingPayJournals = allEntries.filter(e => e.source_ref === inv.id && e.source === 'invoice_payment');
    if (payments.length > existingPayJournals.length) {
      for (const p of payments.slice(existingPayJournals.length)) {
        await journalInvoicePayment(db, inv, p);
        allEntries = await db.prepare('SELECT * FROM journal_entries').all();
        countInv++;
      }
    }
  }

  // Hutang
  const hutangList = await db.prepare('SELECT * FROM hutang').all();
  let countHut = 0;
  for (const h of hutangList) {
    if (!hasJournal(h.id, 'hutang')) {
      await journalHutang(db, h);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countHut++;
    }
    const payments = await db.prepare('SELECT * FROM hutang_payments WHERE hutang_id=?').all(h.id);
    const existingPayJournals = allEntries.filter(e => e.source_ref === h.id && e.source === 'hutang_payment');
    if (payments.length > existingPayJournals.length) {
      for (const p of payments.slice(existingPayJournals.length)) {
        await journalHutangPayment(db, h, p);
        allEntries = await db.prepare('SELECT * FROM journal_entries').all();
        countHut++;
      }
    }
  }

  // Purchases
  const purchases = await db.prepare('SELECT * FROM purchases').all();
  let countPur = 0;
  for (const p of purchases) {
    if (!hasJournal(p.id, 'purchase')) {
      await journalPurchase(db, p);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countPur++;
    }
    const payments = await db.prepare('SELECT * FROM purchase_payments WHERE purchase_id=?').all(p.id);
    const existingPayJournals = allEntries.filter(e => e.source_ref === p.id && e.source === 'purchase_payment');
    if (payments.length > existingPayJournals.length) {
      for (const pay of payments.slice(existingPayJournals.length)) {
        await journalPurchasePayment(db, p, pay);
        allEntries = await db.prepare('SELECT * FROM journal_entries').all();
        countPur++;
      }
    }
  }

  // Retur Pembelian
  const returns = await db.prepare('SELECT * FROM purchase_returns').all();
  let countRet = 0;
  for (const r of returns) {
    if (!hasJournal(r.id, 'purchase_return')) {
      await journalPurchaseReturn(db, r);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countRet++;
    }
  }

  // Transaksi Kasir (POS)
  const transactions = await db.prepare('SELECT * FROM transactions').all();
  let countTxn = 0;
  for (const t of transactions) {
    if (!hasJournal(t.id, 'transaction')) {
      await journalTransaction(db, t);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countTxn++;
    }
  }

  // Aset Tetap
  let assets = [];
  try { assets = await db.prepare('SELECT * FROM assets').all(); } catch(e) {}
  let countAsset = 0;
  for (const a of assets) {
    if (!hasJournal(a.id, 'asset')) {
      await journalAsset(db, a);
      allEntries = await db.prepare('SELECT * FROM journal_entries').all();
      countAsset++;
    }
  }

  if (countInv > 0 || countHut > 0 || countPur > 0 || countRet > 0 || countTxn > 0 || countAsset > 0) {
    console.log(`✅ Backfill jurnal: ${countInv} invoice/pembayaran, ${countHut} hutang/pembayaran, ${countPur} pembelian/pembayaran, ${countRet} retur pembelian, ${countTxn} transaksi kasir, ${countAsset} aset tetap`);
  }
}

module.exports = {
  ACC, HUTANG_DEBIT_MAP, metodeToAccount,
  journalInvoice, journalInvoicePayment, deleteJournalsForInvoice,
  journalHutang, journalHutangPayment, deleteJournalsForHutang,
  journalPurchase, journalPurchasePayment, deleteJournalsForPurchase,
  journalPurchaseReturn, deleteJournalsForPurchaseReturn,
  journalTransaction, deleteJournalsForTransaction,
  journalAsset, deleteJournalsForAsset,
  journalProject, journalProjectPayment, deleteJournalsForProject,
  journalProjectCosts, deleteJournalsForProjectCosts,
  journalSalesReturn, journalInvoiceReturn, journalEntertain, journalPurchaseRequest,
  backfillJournals,
};
