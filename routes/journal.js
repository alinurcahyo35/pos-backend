const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

router.get('/export', auth, async (req, res) => {
  const db = getDb();
  const entries = await db.prepare('SELECT * FROM journal_entries ORDER BY tanggal DESC, id DESC').all();
  const allLines = await db.prepare('SELECT * FROM journal_lines').all();
  const allAccounts = await db.prepare('SELECT * FROM accounts').all();

  // Flatten: satu baris CSV per journal_line, dengan info entry diulang
  const rows = [];
  for (const e of entries) {
    const lines = allLines.filter(l => l.entry_id === e.id);
    for (const l of lines) {
      rows.push({
        no_bukti: e.no_bukti, tanggal: e.tanggal, keterangan_jurnal: e.keterangan, source: e.source||'manual',
        account_kode: l.account_kode,
        account_nama: allAccounts.find(a => a.kode === l.account_kode)?.nama || l.account_kode,
        keterangan_baris: l.keterangan, debet: l.debet, kredit: l.kredit
      });
    }
  }

  sendCsv(res, 'jurnal_umum.csv', rows, [
    { key:'no_bukti', label:'No Bukti' }, { key:'tanggal', label:'Tanggal' },
    { key:'keterangan_jurnal', label:'Keterangan Jurnal' }, { key:'source', label:'Sumber' },
    { key:'account_kode', label:'Kode Akun' }, { key:'account_nama', label:'Nama Akun' },
    { key:'keterangan_baris', label:'Keterangan Baris' }, { key:'debet', label:'Debet' }, { key:'kredit', label:'Kredit' }
  ]);
});

async function genNoBukti(db, tanggal) {
  const all = await db.prepare('SELECT no_bukti FROM journal_entries').all();
  const nums = all.map(j => {
    const m = (j.no_bukti||'').match(/JU-(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'JU-' + String(next).padStart(3, '0');
}

function enrichEntry(db, entry, lines) {
  const total_debet  = lines.reduce((s,l) => s + (l.debet||0), 0);
  const total_kredit = lines.reduce((s,l) => s + (l.kredit||0), 0);
  return { ...entry, lines, total_debet, total_kredit, balanced: Math.abs(total_debet - total_kredit) < 0.01 };
}

// List journal entries (grouped by no_bukti + tanggal)
router.get('/', auth, async (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  let entries = await db.prepare('SELECT * FROM journal_entries').all();
  const allLines = await db.prepare('SELECT * FROM journal_lines').all();
  const allAccounts = await db.prepare('SELECT * FROM accounts').all();

  if (from) entries = entries.filter(e => e.tanggal >= from);
  if (to)   entries = entries.filter(e => e.tanggal <= to);

  entries.sort((a,b) => (b.tanggal||'').localeCompare(a.tanggal||'') || b.id - a.id);

  const result = entries.map(e => {
    const lines = allLines.filter(l => l.entry_id === e.id).map(l => ({
      ...l,
      account_nama: allAccounts.find(a => a.kode === l.account_kode)?.nama || l.account_kode
    }));
    return enrichEntry(db, e, lines);
  });

  res.json(result);
});

// Get single entry
router.get('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const entry = (await db.prepare('SELECT * FROM journal_entries').all()).find(e => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Jurnal tidak ditemukan' });
  const lines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(id);
  const allAccounts = await db.prepare('SELECT * FROM accounts').all();
  const enrichedLines = lines.map(l => ({ ...l, account_nama: allAccounts.find(a=>a.kode===l.account_kode)?.nama || l.account_kode }));
  res.json(enrichEntry(db, entry, enrichedLines));
});

// Create journal entry
router.post('/', auth, async (req, res) => {
  const db = getDb();
  const { tanggal, keterangan, lines, no_bukti } = req.body;
  if (!lines || lines.length < 2) return res.status(400).json({ error: 'Minimal 2 baris (debet & kredit)' });

  const total_debet  = lines.reduce((s,l) => s + (parseFloat(l.debet)||0), 0);
  const total_kredit = lines.reduce((s,l) => s + (parseFloat(l.kredit)||0), 0);
  if (Math.abs(total_debet - total_kredit) > 0.01) {
    return res.status(400).json({ error: `Jurnal tidak balance. Debet: ${total_debet}, Kredit: ${total_kredit}` });
  }
  if (total_debet === 0) return res.status(400).json({ error: 'Total jurnal tidak boleh 0' });

  const nomor = no_bukti || await genNoBukti(db, tanggal);

  await db.prepare('INSERT INTO journal_entries (no_bukti,tanggal,keterangan,source) VALUES (?,?,?,?) RETURNING id')
    .run(nomor, tanggal, keterangan||'', 'manual');

  const entry = (await db.prepare('SELECT * FROM journal_entries').all()).sort((a,b)=>b.id-a.id)[0];

  for (const line of lines) {
    if ((parseFloat(line.debet)||0) === 0 && (parseFloat(line.kredit)||0) === 0) continue;
    await db.prepare('INSERT INTO journal_lines (entry_id,account_kode,keterangan,debet,kredit) VALUES (?,?,?,?,?) RETURNING id')
      .run(entry.id, line.account_kode, line.keterangan||'', parseFloat(line.debet)||0, parseFloat(line.kredit)||0);
  }

  const savedLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(entry.id);
  const result = enrichEntry(db, entry, savedLines);
  await recordAudit(db, { user: req.user, aksi:'create', modul:'Jurnal Umum', record_id: entry.id, record_label: entry.no_bukti, data_sesudah: result });
  res.json(result);
});

// Update journal entry
router.put('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { tanggal, keterangan, lines, no_bukti } = req.body;

  const beforeEntry = (await db.prepare('SELECT * FROM journal_entries').all()).find(e => e.id === id);
  const beforeLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(id);
  const before = enrichEntry(db, beforeEntry, beforeLines);

  const total_debet  = lines.reduce((s,l) => s + (parseFloat(l.debet)||0), 0);
  const total_kredit = lines.reduce((s,l) => s + (parseFloat(l.kredit)||0), 0);
  if (Math.abs(total_debet - total_kredit) > 0.01) {
    return res.status(400).json({ error: `Jurnal tidak balance. Debet: ${total_debet}, Kredit: ${total_kredit}` });
  }

  await db.prepare('UPDATE journal_entries SET no_bukti=?,tanggal=?,keterangan=? WHERE id=?').run(no_bukti, tanggal, keterangan||'', id);
  await db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(id);
  for (const line of lines) {
    if ((parseFloat(line.debet)||0) === 0 && (parseFloat(line.kredit)||0) === 0) continue;
    await db.prepare('INSERT INTO journal_lines (entry_id,account_kode,keterangan,debet,kredit) VALUES (?,?,?,?,?) RETURNING id')
      .run(id, line.account_kode, line.keterangan||'', parseFloat(line.debet)||0, parseFloat(line.kredit)||0);
  }

  const entry = (await db.prepare('SELECT * FROM journal_entries').all()).find(e => e.id === id);
  const savedLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(id);
  const after = enrichEntry(db, entry, savedLines);
  await recordAudit(db, { user: req.user, aksi:'update', modul:'Jurnal Umum', record_id: id, record_label: entry.no_bukti, data_sebelum: before, data_sesudah: after });
  res.json(after);
});

// Delete journal entry
router.delete('/:id', auth, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const beforeEntry = (await db.prepare('SELECT * FROM journal_entries').all()).find(e => e.id === id);
  const beforeLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(id);
  const before = beforeEntry ? enrichEntry(db, beforeEntry, beforeLines) : null;

  await db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(id);
  await db.prepare('DELETE FROM journal_entries WHERE id=?').run(id);

  await recordAudit(db, { user: req.user, aksi:'delete', modul:'Jurnal Umum', record_id: id, record_label: before?.no_bukti, data_sebelum: before });
  res.json({ success: true });
});

// Buku besar - per account ledger
router.get('/buku-besar/:kode', auth, async (req, res) => {
  const db = getDb();
  const { kode } = req.params;
  const { from, to } = req.query;

  const account = (await db.prepare('SELECT * FROM accounts').all()).find(a => a.kode === kode);
  if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan' });

  const allEntries = await db.prepare('SELECT * FROM journal_entries').all();
  const allLines = await db.prepare('SELECT * FROM journal_lines WHERE account_kode=?').all(kode);

  let rows = allLines.map(l => {
    const entry = allEntries.find(e => e.id === l.entry_id);
    return { tanggal: entry?.tanggal, no_bukti: entry?.no_bukti, keterangan: l.keterangan || entry?.keterangan, debet: l.debet, kredit: l.kredit };
  });

  if (from) rows = rows.filter(r => r.tanggal >= from);
  if (to)   rows = rows.filter(r => r.tanggal <= to);
  rows.sort((a,b) => (a.tanggal||'').localeCompare(b.tanggal||''));

  // Running balance
  const isDebetNormal = account.saldo_normal === 'Debet';
  let saldo = isDebetNormal ? (account.saldo_awal_debet - account.saldo_awal_kredit) : (account.saldo_awal_kredit - account.saldo_awal_debet);
  const saldo_awal = saldo;

  rows = rows.map(r => {
    if (isDebetNormal) saldo += (r.debet - r.kredit);
    else saldo += (r.kredit - r.debet);
    return { ...r, saldo };
  });

  res.json({ account, saldo_awal, rows, saldo_akhir: saldo });
});

module.exports = router;
