// Helper terpusat untuk export data ke CSV.
// Dipakai di seluruh route yang punya endpoint /export.

function escapeCsvValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') val = JSON.stringify(val);
  const str = String(val);
  // Bungkus dengan tanda kutip jika mengandung koma, kutip, atau baris baru
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsv(rows, columns) {
  // columns: array of { key, label } - urutan & nama kolom di file CSV
  // Jika columns tidak diberikan, ambil otomatis dari key object pertama
  if (!rows || rows.length === 0) {
    const headerOnly = columns ? columns.map(c => c.label).join(',') : '';
    return '\uFEFF' + headerOnly; // BOM agar Excel baca UTF-8 dengan benar (penting untuk teks ber-aksen/simbol Rp)
  }

  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k }));
  const header = cols.map(c => escapeCsvValue(c.label)).join(',');
  const lines = rows.map(row =>
    cols.map(c => escapeCsvValue(row[c.key])).join(',')
  );

  return '\uFEFF' + [header, ...lines].join('\r\n');
}

function sendCsv(res, filename, rows, columns) {
  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

module.exports = { toCsv, sendCsv };
