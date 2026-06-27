// Chart of Accounts default - seed dari template akuntansi
module.exports = [
  // Kas & Bank
  ['111001','Kas Kecil','Kas','Neraca','Debet','Aset Lancar'],
  ['112001','Bank HSBC','Bank','Neraca','Debet','Aset Lancar'],
  ['112002','Bank BCA','Bank','Neraca','Debet','Aset Lancar'],
  // Piutang
  ['113001','Piutang Karyawan','Piutang','Neraca','Debet','Aset Lancar'],
  ['113002','Piutang Usaha','Piutang','Neraca','Debet','Aset Lancar'],
  ['113003','Piutang GoFood','Piutang','Neraca','Debet','Aset Lancar'],
  ['113004','Piutang ShopeeFood','Piutang','Neraca','Debet','Aset Lancar'],
  ['113005','Piutang GrabFood','Piutang','Neraca','Debet','Aset Lancar'],
  // Persediaan
  ['114001','Persediaan Barang Jadi','Persediaan','Neraca','Debet','Aset Lancar'],
  // Aset Tetap
  ['115001','Sewa Bangunan','Aktiva Tetap','Neraca','Debet','Aset Tetap'],
  ['116001','Perlengkapan Toko','Aktiva Tetap','Neraca','Debet','Aset Tetap'],
  ['117001','Akumulasi Penyusutan Peralatan Toko','Akumulasi Penyusutan','Neraca','Debet','Aset Tetap'],
  // Hutang
  ['210001','Hutang Usaha','Hutang','Neraca','Kredit','Kewajiban'],
  ['211001','Hutang Lainnya','Hutang','Neraca','Kredit','Kewajiban'],
  // Ekuitas
  ['310001','Modal Pemilik','Ekuitas','Neraca','Kredit','Modal'],
  ['311002','Tambahan Modal Disetor','Ekuitas','Neraca','Kredit','Modal'],
  ['311003','Laba Ditahan','Ekuitas','Neraca','Kredit','Modal'],
  ['311004','Laba/Rugi Tahun Berjalan','Ekuitas','Neraca','Kredit','Modal'],
  // Pendapatan
  ['411001','Penjualan Online','Pendapatan','Laba Rugi','Kredit',null],
  ['411002','Penjualan Cash','Pendapatan','Laba Rugi','Kredit',null],
  ['411003','Penjualan B2B','Pendapatan','Laba Rugi','Kredit',null],
  ['412001','Retur Penjualan','Pendapatan','Laba Rugi','Kredit',null],
  // HPP
  ['511001','HPP Penjualan','HPP','Laba Rugi','Debet',null],
  ['511002','COGS','HPP','Laba Rugi','Debet',null],
  ['511003','Persediaan Bahan Baku','HPP','Laba Rugi','Debet',null],
  ['512001','Persediaan Bahan Jadi','HPP','Laba Rugi','Debet',null],
  // Beban/Biaya
  ['611001','Beban Gaji','Beban/Biaya','Laba Rugi','Debet',null],
  ['611002','Beban Sewa Bangunan','Beban/Biaya','Laba Rugi','Debet',null],
  ['611003','Beban Fee Management','Beban/Biaya','Laba Rugi','Debet',null],
  ['611004','Beban Listrik','Beban/Biaya','Laba Rugi','Debet',null],
  ['611005','Biaya PDAM','Beban/Biaya','Laba Rugi','Debet',null],
  ['611006','Biaya Wifi','Beban/Biaya','Laba Rugi','Debet',null],
  ['611007','Biaya Admin','Beban/Biaya','Laba Rugi','Debet',null],
  ['611008','Biaya Aplikasi','Beban/Biaya','Laba Rugi','Debet',null],
  ['611009','Beban Iuran Sampah','Beban/Biaya','Laba Rugi','Debet',null],
  ['611010','Beban Sosial','Beban/Biaya','Laba Rugi','Debet',null],
  ['611011','Beban Perawatan dan Pemeliharaan','Beban/Biaya','Laba Rugi','Debet',null],
  ['611012','Beban Pengiriman','Beban/Biaya','Laba Rugi','Debet',null],
  ['611013','Beban Perlengkapan','Beban/Biaya','Laba Rugi','Debet',null],
  ['611014','Beban Waste','Beban/Biaya','Laba Rugi','Debet',null],
  ['611015','Beban Produksi','Beban/Biaya','Laba Rugi','Debet',null],
  ['611016','Beban Aggregator','Beban/Biaya','Laba Rugi','Debet',null],
  ['611017','Biaya Packing','Beban/Biaya','Laba Rugi','Debet',null],
  ['611018','Beban Entertain','Beban/Biaya','Laba Rugi','Debet',null],
  // Lain-lain
  ['711001','Pendapatan lain-lain','Pendapatan Lainnya','Laba Rugi','Kredit',null],
  ['811001','Beban lain-lain','Beban Lainnya','Laba Rugi','Debet',null],
  ['811002','Beban Penyusutan Aset Tetap','Beban Lainnya','Laba Rugi','Debet',null],
];
