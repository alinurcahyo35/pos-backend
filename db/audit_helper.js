// Helper terpusat untuk mencatat Audit Log di seluruh modul.
// Dipanggil dari route setelah operasi create/update/delete berhasil.

async function recordAudit(db, { user, aksi, modul, record_id, record_label, data_sebelum, data_sesudah }) {
  try {
    await db.prepare(`INSERT INTO audit_logs
      (user_id,user_name,user_role,aksi,modul,record_id,record_label,data_sebelum,data_sesudah)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        user?.id || null,
        user?.name || 'Sistem',
        user?.role || '',
        aksi, // 'create' | 'update' | 'delete'
        modul, // nama modul, cth: 'Produk', 'Invoice', 'Pembelian'
        record_id || null,
        record_label || '',
        data_sebelum ? JSON.stringify(data_sebelum) : null,
        data_sesudah ? JSON.stringify(data_sesudah) : null
      );
  } catch (e) {
    // Audit log tidak boleh menggagalkan operasi utama - cukup catat error ke console
    console.error('⚠️  Gagal mencatat audit log:', e.message);
  }
}

module.exports = { recordAudit };
