const router = require('express').Router();
const { getDb } = require('../db/db');
const auth = require('../middleware/auth');
const { recordAudit } = require('../db/audit_helper');
const { sendCsv } = require('../db/csv_helper');

function today() {
  return new Date().toISOString().split('T')[0];
}

function nowJakarta() {
  return new Date().toISOString();
}

function minutesBetween(timeA, timeB) {
  const partsA = timeA.split(':').map(Number);
  const partsB = timeB.split(':').map(Number);
  const hA = partsA[0], mA = partsA[1];
  const hB = partsB[0], mB = partsB[1];
  return (hB*60+mB) - (hA*60+mA);
}

function timeStringFromISO(iso) {
  // Konversi UTC ke WIB (UTC+7) sebelum dibandingkan dengan jadwal kerja
  const d = new Date(iso);
  const wibMinutes = d.getUTCHours()*60 + d.getUTCMinutes() + 7*60;
  const h = Math.floor(wibMinutes/60) % 24;
  const m = wibMinutes % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

async function getSchedule(db, userId) {
  const s = await db.prepare('SELECT * FROM work_schedules WHERE user_id=?').get(userId);
  return s || { jam_masuk:'08:00', jam_keluar:'17:00', hari_kerja:'1,2,3,4,5,6' };
}

router.get('/schedule/me', auth, async (req, res) => {
  const db = getDb();
  res.json(await getSchedule(db, req.user.id));
});

router.get('/today', auth, async (req, res) => {
  const db = getDb();
  const row = await db.prepare('SELECT * FROM attendances WHERE user_id=? AND tanggal=?').get(req.user.id, today());
  res.json(row || null);
});

router.post('/check-in', auth, async (req, res) => {
  const db = getDb();
  const { photo, keterangan = 'normal', catatan = '' } = req.body;
  if (!photo) return res.status(400).json({ error: 'Foto selfie wajib diambil untuk check-in' });
  if (!['normal','izin','sakit'].includes(keterangan)) return res.status(400).json({ error: 'Keterangan tidak valid' });

  const tanggal = today();
  const existing = await db.prepare('SELECT * FROM attendances WHERE user_id=? AND tanggal=?').get(req.user.id, tanggal);
  if (existing && existing.check_in) return res.status(400).json({ error: 'Anda sudah check-in hari ini' });

  const ts = nowJakarta();
  const schedule = await getSchedule(db, req.user.id);
  const jamCheckIn = timeStringFromISO(ts);
  const selisih = minutesBetween(schedule.jam_masuk, jamCheckIn);
  const statusTelat = selisih > 0 ? 1 : 0;
  const menitTelat = selisih > 0 ? selisih : 0;

  if (existing) {
    await db.prepare('UPDATE attendances SET check_in=?,check_in_photo=?,keterangan=?,catatan=?,status_telat=?,menit_telat=?,updated_at=NOW() WHERE id=?')
      .run(ts, photo, keterangan, catatan, statusTelat, menitTelat, existing.id);
  } else {
    await db.prepare('INSERT INTO attendances (user_id,tanggal,check_in,check_in_photo,keterangan,catatan,status_telat,menit_telat) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
      .run(req.user.id, tanggal, ts, photo, keterangan, catatan, statusTelat, menitTelat);
  }

  const row = await db.prepare('SELECT * FROM attendances WHERE user_id=? AND tanggal=?').get(req.user.id, tanggal);
  await recordAudit(db, {
    user: req.user, aksi: existing ? 'update' : 'create', modul: 'Absensi',
    record_id: row.id, record_label: `Check-in ${req.user.name} - ${tanggal}`,
    data_sesudah: { ...row, check_in_photo: '[foto]', check_out_photo: row.check_out_photo ? '[foto]' : null }
  });

  res.json({ ...row, check_in_photo: undefined, check_out_photo: undefined });
});

router.post('/check-out', auth, async (req, res) => {
  const db = getDb();
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: 'Foto selfie wajib diambil untuk check-out' });

  const tanggal = today();
  const existing = await db.prepare('SELECT * FROM attendances WHERE user_id=? AND tanggal=?').get(req.user.id, tanggal);
  if (!existing || !existing.check_in) return res.status(400).json({ error: 'Anda belum check-in hari ini' });
  if (existing.check_out) return res.status(400).json({ error: 'Anda sudah check-out hari ini' });

  const ts = nowJakarta();
  const schedule = await getSchedule(db, req.user.id);
  const jamCheckOut = timeStringFromISO(ts);
  const selisih = minutesBetween(schedule.jam_keluar, jamCheckOut);
  const statusLembur = selisih > 0 ? 1 : 0;
  const menitLembur = selisih > 0 ? selisih : 0;

  await db.prepare('UPDATE attendances SET check_out=?,check_out_photo=?,status_lembur=?,menit_lembur=?,updated_at=NOW() WHERE id=?')
    .run(ts, photo, statusLembur, menitLembur, existing.id);

  const row = await db.prepare('SELECT * FROM attendances WHERE id=?').get(existing.id);
  await recordAudit(db, {
    user: req.user, aksi:'update', modul:'Absensi',
    record_id: row.id, record_label: `Check-out ${req.user.name} - ${tanggal}`,
    data_sebelum: { ...existing, check_in_photo:'[foto]', check_out_photo: existing.check_out_photo?'[foto]':null },
    data_sesudah: { ...row, check_in_photo:'[foto]', check_out_photo:'[foto]' }
  });

  res.json({ ...row, check_in_photo: undefined, check_out_photo: undefined });
});

function requireSuperadmin(req, res, next) {
  if (!['admin','direksi'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Hanya Superadmin yang dapat mengakses HR' });
  }
  next();
}

router.get('/hr/export', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const { user_id, from, to, keterangan } = req.query;

  let all = await db.prepare('SELECT * FROM attendances ORDER BY tanggal DESC, id DESC').all();
  const allUsers = await db.prepare('SELECT id, name, role FROM users').all();

  if (user_id) all = all.filter(a => String(a.user_id) === String(user_id));
  if (from) all = all.filter(a => a.tanggal >= from);
  if (to) all = all.filter(a => a.tanggal <= to);
  if (keterangan && keterangan !== 'all') all = all.filter(a => a.keterangan === keterangan);

  const rows = all.map(a => {
    const u = allUsers.find(u => u.id === a.user_id);
    return { ...a, user_name: u ? u.name : 'Tidak diketahui' };
  });

  sendCsv(res, 'absensi.csv', rows, [
    { key:'tanggal', label:'Tanggal' }, { key:'user_name', label:'Karyawan' },
    { key:'check_in', label:'Check-in' }, { key:'check_out', label:'Check-out' },
    { key:'keterangan', label:'Keterangan' }, { key:'status_telat', label:'Telat' },
    { key:'menit_telat', label:'Menit Telat' }, { key:'status_lembur', label:'Lembur' },
    { key:'menit_lembur', label:'Menit Lembur' }, { key:'catatan', label:'Catatan' }
  ]);
});

router.get('/hr', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const { user_id, from, to, keterangan } = req.query;

  let all = await db.prepare('SELECT * FROM attendances ORDER BY tanggal DESC, id DESC').all();
  const allUsers = await db.prepare('SELECT id, name, role FROM users').all();

  if (user_id) all = all.filter(a => String(a.user_id) === String(user_id));
  if (from) all = all.filter(a => a.tanggal >= from);
  if (to) all = all.filter(a => a.tanggal <= to);
  if (keterangan && keterangan !== 'all') all = all.filter(a => a.keterangan === keterangan);

  const result = all.map(a => {
    const u = allUsers.find(u => u.id === a.user_id);
    return {
      ...a,
      check_in_photo: undefined, check_out_photo: undefined,
      has_check_in_photo: !!a.check_in_photo, has_check_out_photo: !!a.check_out_photo,
      user_name: u ? u.name : 'Tidak diketahui', user_role: u ? u.role : ''
    };
  });

  res.json(result);
});

router.get('/hr/:id', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const row = await db.prepare('SELECT * FROM attendances WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Data absensi tidak ditemukan' });
  const u = await db.prepare('SELECT id, name, role FROM users WHERE id=?').get(row.user_id);
  res.json({ ...row, user_name: u ? u.name : null, user_role: u ? u.role : null });
});

router.put('/hr/:id', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { keterangan, catatan } = req.body;
  const before = await db.prepare('SELECT * FROM attendances WHERE id=?').get(id);
  if (!before) return res.status(404).json({ error: 'Data absensi tidak ditemukan' });

  await db.prepare('UPDATE attendances SET keterangan=?,catatan=?,updated_at=NOW() WHERE id=?')
    .run(keterangan, catatan||'', id);

  const after = await db.prepare('SELECT * FROM attendances WHERE id=?').get(id);
  await recordAudit(db, {
    user: req.user, aksi:'update', modul:'Absensi (HR)', record_id: id,
    record_label: `Koreksi absensi #${id}`,
    data_sebelum: { ...before, check_in_photo:'[foto]', check_out_photo: before.check_out_photo?'[foto]':null },
    data_sesudah: { ...after, check_in_photo:'[foto]', check_out_photo: after.check_out_photo?'[foto]':null }
  });

  res.json({ success: true });
});

router.get('/schedules', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const schedules = await db.prepare('SELECT * FROM work_schedules').all();
  const users = await db.prepare("SELECT id, name, role FROM users WHERE role != 'admin' AND role != 'direksi' ORDER BY name").all();
  res.json(users.map(u => {
    const existing = schedules.find(s => s.user_id === u.id);
    const defaults = { jam_masuk:'08:00', jam_keluar:'17:00', hari_kerja:'1,2,3,4,5,6' };
    return { user_id: u.id, user_name: u.name, user_role: u.role, ...(existing || defaults) };
  }));
});

router.put('/schedules/:userId', auth, requireSuperadmin, async (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId);
  const { jam_masuk, jam_keluar, hari_kerja } = req.body;

  const existing = await db.prepare('SELECT * FROM work_schedules WHERE user_id=?').get(userId);
  if (existing) {
    await db.prepare('UPDATE work_schedules SET jam_masuk=?,jam_keluar=?,hari_kerja=?,updated_at=NOW() WHERE user_id=?')
      .run(jam_masuk, jam_keluar, hari_kerja||'1,2,3,4,5,6', userId);
  } else {
    await db.prepare('INSERT INTO work_schedules (user_id,jam_masuk,jam_keluar,hari_kerja) VALUES (?,?,?,?) RETURNING id')
      .run(userId, jam_masuk, jam_keluar, hari_kerja||'1,2,3,4,5,6');
  }

  const after = await db.prepare('SELECT * FROM work_schedules WHERE user_id=?').get(userId);
  const u = await db.prepare('SELECT name FROM users WHERE id=?').get(userId);
  await recordAudit(db, { user: req.user, aksi: existing?'update':'create', modul:'Jadwal Kerja', record_id: userId, record_label: u?u.name:'', data_sebelum: existing, data_sesudah: after });

  res.json({ success: true });
});

module.exports = router;
