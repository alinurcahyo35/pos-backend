// Helper untuk parse CSV yang diupload, kebalikan dari csv_helper.js yang untuk export.
// Mengembalikan array of objects berdasarkan header baris pertama.

function parseCsvText(text) {
  // Hapus BOM jika ada (Excel sering tambahkan ini)
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip baris kosong
    const values = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (values[idx]||'').trim(); });
    rows.push(obj);
  }
  return rows;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

module.exports = { parseCsvText };
