const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { sendCsv } = require('../db/csv_helper');

// Hitung saldo akhir tiap akun per tanggal tertentu
async function computeBalances(db, to) {
  const accounts = await db.prepare('SELECT * FROM accounts WHERE aktif=1').all();
  const allEntries = await db.prepare('SELECT * FROM journal_entries').all();
  const allLines = await db.prepare('SELECT * FROM journal_lines').all();

  const validEntryIds = new Set(
    allEntries.filter(e => !to || e.tanggal <= to).map(e => e.id)
  );

  return accounts.map(acc => {
    const lines = allLines.filter(l => l.account_kode === acc.kode && validEntryIds.has(l.entry_id));
    const sumDebet  = lines.reduce((s,l) => s + (l.debet||0), 0);
    const sumKredit = lines.reduce((s,l) => s + (l.kredit||0), 0);

    const isDebetNormal = acc.saldo_normal === 'Debet';
    const saldo_awal = isDebetNormal
      ? (acc.saldo_awal_debet - acc.saldo_awal_kredit)
      : (acc.saldo_awal_kredit - acc.saldo_awal_debet);

    const saldo_akhir = isDebetNormal
      ? saldo_awal + sumDebet - sumKredit
      : saldo_awal + sumKredit - sumDebet;

    return { ...acc, saldo_awal, sumDebet, sumKredit, saldo_akhir };
  });
}

// ─── LAPORAN LABA RUGI (Akuntansi) ────────────────────────
router.get('/laba-rugi', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const periodTo = to || today;

  const accounts = await db.prepare('SELECT * FROM accounts WHERE aktif=1 AND posisi=?').all('Laba Rugi');
  const allEntries = await db.prepare('SELECT * FROM journal_entries').all();
  const allLines = await db.prepare('SELECT * FROM journal_lines').all();

  let validEntryIds = allEntries.filter(e => e.tanggal <= periodTo);
  if (from) validEntryIds = validEntryIds.filter(e => e.tanggal >= from);
  const idSet = new Set(validEntryIds.map(e => e.id));

  const accountBalances = accounts.map(acc => {
    const lines = allLines.filter(l => l.account_kode === acc.kode && idSet.has(l.entry_id));
    const sumDebet  = lines.reduce((s,l) => s + (l.debet||0), 0);
    const sumKredit = lines.reduce((s,l) => s + (l.kredit||0), 0);
    // Untuk Laba Rugi, saldo = pergerakan periode (bukan saldo awal + pergerakan, karena LR per periode)
    const saldo = acc.saldo_normal === 'Kredit' ? (sumKredit - sumDebet) : (sumDebet - sumKredit);
    return { kode: acc.kode, nama: acc.nama, jenis: acc.jenis, saldo };
  });

  const byJenis = jenis => accountBalances.filter(a => a.jenis === jenis);

  const pendapatan = byJenis('Pendapatan');
  const hpp        = byJenis('HPP');
  const beban      = byJenis('Beban/Biaya');
  const pendapatanLain = byJenis('Pendapatan Lainnya');
  const bebanLain      = byJenis('Beban Lainnya');

  const total_pendapatan = pendapatan.reduce((s,a)=>s+a.saldo,0);
  const total_hpp        = hpp.reduce((s,a)=>s+a.saldo,0);
  const laba_kotor       = total_pendapatan - total_hpp;
  const total_beban      = beban.reduce((s,a)=>s+a.saldo,0);
  const laba_operasional = laba_kotor - total_beban;
  const total_pendapatan_lain = pendapatanLain.reduce((s,a)=>s+a.saldo,0);
  const total_beban_lain      = bebanLain.reduce((s,a)=>s+a.saldo,0);
  const laba_bersih = laba_operasional + total_pendapatan_lain - total_beban_lain;

  res.json({
    periode: { from: from||null, to: periodTo },
    pendapatan, total_pendapatan,
    hpp, total_hpp,
    laba_kotor,
    beban, total_beban,
    laba_operasional,
    pendapatan_lain: pendapatanLain, total_pendapatan_lain,
    beban_lain: bebanLain, total_beban_lain,
    laba_bersih
  });
});

// ─── NERACA (Balance Sheet) ───────────────────────────────
router.get('/neraca', auth, async (req, res) => {
  const db = getDb();
  const { to } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const periodTo = to || today;

  const balances = await computeBalances(db, periodTo);
  const neraca = balances.filter(a => a.posisi === 'Neraca');

  // Hitung laba/rugi tahun berjalan dari Laba Rugi accounts (untuk dimasukkan ke ekuitas)
  const lrAccounts = await db.prepare('SELECT * FROM accounts WHERE aktif=1 AND posisi=?').all('Laba Rugi');
  const allEntries = (await db.prepare('SELECT * FROM journal_entries').all()).filter(e => e.tanggal <= periodTo);
  const allLines = await db.prepare('SELECT * FROM journal_lines').all();
  const idSet = new Set(allEntries.map(e => e.id));

  let laba_berjalan = 0;
  for (const acc of lrAccounts) {
    const lines = allLines.filter(l => l.account_kode === acc.kode && idSet.has(l.entry_id));
    const sumDebet  = lines.reduce((s,l) => s + (l.debet||0), 0);
    const sumKredit = lines.reduce((s,l) => s + (l.kredit||0), 0);
    if (acc.jenis === 'Pendapatan' || acc.jenis === 'Pendapatan Lainnya') laba_berjalan += (sumKredit - sumDebet);
    else laba_berjalan -= (sumDebet - sumKredit); // HPP, Beban/Biaya, Beban Lainnya
  }

  const asetLancar = neraca.filter(a => a.kategori_neraca === 'Aset Lancar');
  const asetTetap  = neraca.filter(a => a.kategori_neraca === 'Aset Tetap');
  const kewajiban  = neraca.filter(a => a.kategori_neraca === 'Kewajiban');
  const modal      = neraca.filter(a => a.kategori_neraca === 'Modal');

  const total_aset_lancar = asetLancar.reduce((s,a)=>s+a.saldo_akhir,0);
  const total_aset_tetap  = asetTetap.reduce((s,a)=>s+a.saldo_akhir,0);
  const total_aset = total_aset_lancar + total_aset_tetap;

  const total_kewajiban = kewajiban.reduce((s,a)=>s+a.saldo_akhir,0);
  const total_modal_akun = modal.reduce((s,a)=>s+a.saldo_akhir,0);
  const total_modal = total_modal_akun + laba_berjalan;

  const total_kewajiban_modal = total_kewajiban + total_modal;
  const selisih = total_aset - total_kewajiban_modal;

  res.json({
    periode: { to: periodTo },
    aset_lancar: asetLancar, total_aset_lancar,
    aset_tetap: asetTetap, total_aset_tetap,
    total_aset,
    kewajiban, total_kewajiban,
    modal, laba_berjalan, total_modal,
    total_kewajiban_modal,
    balanced: Math.abs(selisih) < 1,
    selisih
  });
});

// ─── BUKU BESAR SUMMARY (semua akun) ──────────────────────
router.get('/saldo-akun', auth, async (req, res) => {
  const db = getDb();
  const { to } = req.query;
  const balances = await computeBalances(db, to);
  res.json(balances);
});

// ─── ARUS KAS (Cash Flow Statement) ───────────────────────
// Mengambil semua baris jurnal yang menyentuh akun Kas/Bank, lalu mengklasifikasikan
// tiap transaksi ke Operasional/Investasi/Pendanaan berdasarkan akun lawan dalam entry yang sama.
function classifyActivity(counterAccounts) {
  // counterAccounts: daftar akun lawan (selain Kas/Bank) dalam satu entry jurnal yang sama
  const jenisSet = new Set(counterAccounts.map(a => a.jenis));
  const kategoriSet = new Set(counterAccounts.map(a => a.kategori_neraca));

  // Investasi: akun lawan adalah Aset Tetap (beli/jual peralatan, sewa bangunan, dst)
  if (jenisSet.has('Aktiva Tetap') || jenisSet.has('Akumulasi Penyusutan')) return 'investasi';

  // Pendanaan: akun lawan adalah Ekuitas/Modal atau Hutang Lainnya (modal masuk/keluar, pinjaman)
  if (jenisSet.has('Ekuitas') || kategoriSet.has('Modal')) return 'pendanaan';

  // Sisanya (Pendapatan, HPP, Beban, Piutang, Persediaan, Hutang Usaha) = Operasional
  return 'operasional';
}

async function computeCashflow(db, from, to) {
  const today = new Date().toISOString().split('T')[0];
  const periodTo = to || today;

  const allAccounts = await db.prepare('SELECT * FROM accounts').all();
  const kasBankKodes = new Set(allAccounts.filter(a => a.jenis === 'Kas' || a.jenis === 'Bank').map(a => a.kode));

  let entries = await db.prepare('SELECT * FROM journal_entries').all();
  entries = entries.filter(e => e.tanggal <= periodTo);
  if (from) entries = entries.filter(e => e.tanggal >= from);
  entries.sort((a,b) => (a.tanggal||'').localeCompare(b.tanggal||'') || a.id - b.id);

  const allLines = await db.prepare('SELECT * FROM journal_lines').all();
  const accByKode = Object.fromEntries(allAccounts.map(a => [a.kode, a]));

  let saldo_awal_periode = 0;
  if (from) {
    const beforeEntries = (await db.prepare('SELECT * FROM journal_entries').all()).filter(e => e.tanggal < from);
    const beforeIds = new Set(beforeEntries.map(e => e.id));
    for (const l of allLines) {
      if (kasBankKodes.has(l.account_kode) && beforeIds.has(l.entry_id)) {
        saldo_awal_periode += (l.debet||0) - (l.kredit||0);
      }
    }
  } else {
    for (const acc of allAccounts) {
      if (kasBankKodes.has(acc.kode)) saldo_awal_periode += (acc.saldo_awal_debet||0) - (acc.saldo_awal_kredit||0);
    }
  }

  const transaksi = [];
  for (const e of entries) {
    const lines = allLines.filter(l => l.entry_id === e.id);
    const kasBankLines = lines.filter(l => kasBankKodes.has(l.account_kode));
    if (kasBankLines.length === 0) continue;

    const counterAccounts = lines
      .filter(l => !kasBankKodes.has(l.account_kode))
      .map(l => accByKode[l.account_kode])
      .filter(Boolean);

    const aktivitas = classifyActivity(counterAccounts);

    for (const l of kasBankLines) {
      const masuk  = l.debet || 0;
      const keluar = l.kredit || 0;
      transaksi.push({
        tanggal: e.tanggal, no_bukti: e.no_bukti, keterangan: e.keterangan,
        account_kode: l.account_kode, account_nama: accByKode[l.account_kode]?.nama || l.account_kode,
        aktivitas, masuk, keluar
      });
    }
  }

  let saldoBerjalan = saldo_awal_periode;
  for (const t of transaksi) {
    saldoBerjalan += t.masuk - t.keluar;
    t.saldo_berjalan = saldoBerjalan;
  }

  const sumByActivity = (akt) => {
    const rows = transaksi.filter(t => t.aktivitas === akt);
    const masuk = rows.reduce((s,t)=>s+t.masuk,0);
    const keluar = rows.reduce((s,t)=>s+t.keluar,0);
    return { masuk, keluar, net: masuk - keluar };
  };

  const operasional = sumByActivity('operasional');
  const investasi    = sumByActivity('investasi');
  const pendanaan    = sumByActivity('pendanaan');

  const total_masuk  = transaksi.reduce((s,t)=>s+t.masuk,0);
  const total_keluar = transaksi.reduce((s,t)=>s+t.keluar,0);
  const net_cashflow = total_masuk - total_keluar;
  const saldo_akhir  = saldo_awal_periode + net_cashflow;

  return {
    periode: { from: from||null, to: periodTo },
    saldo_awal: saldo_awal_periode,
    operasional, investasi, pendanaan,
    total_masuk, total_keluar, net_cashflow,
    saldo_akhir,
    transaksi
  };
}

router.get('/cashflow', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  res.json(await computeCashflow(db, from, to));
});

router.get('/cashflow/export', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  const result = await computeCashflow(db, from, to);
  sendCsv(res, 'cash_flow.csv', result.transaksi, [
    { key:'tanggal', label:'Tanggal' }, { key:'no_bukti', label:'No Bukti' },
    { key:'keterangan', label:'Keterangan' }, { key:'account_nama', label:'Akun Kas/Bank' },
    { key:'aktivitas', label:'Aktivitas' }, { key:'masuk', label:'Uang Masuk' },
    { key:'keluar', label:'Uang Keluar' }, { key:'saldo_berjalan', label:'Saldo Berjalan' }
  ]);
});

module.exports = router;
