#!/usr/bin/env node
'use strict';
/**
 * SAGARA – Sistem Akuntansi & Penjualan
 * Command-Line Interface (JavaScript)
 */

const readline = require('readline');

const { initDatabase, DB_PATH }      = require('./utils/database');
const {
  setupAkunDefault, tambahAkun, daftarAkun, cariAkun,
  catatJurnal, daftarJurnal, bukuBesar,
} = require('./akuntansi/akun');
const {
  tambahPelanggan, daftarPelanggan, cariPelanggan,
  tambahProduk, daftarProduk, cariProduk,
  buatFaktur, postingFaktur, daftarFaktur,
} = require('./penjualan/faktur');
const {
  tambahPemasok, daftarPemasok, cariPemasok,
  buatOrder, postingOrder, daftarOrder, detailOrder,
  PLATFORM_LIST, METODE_BAYAR_LIST,
} = require('./pembelian/pembelian');
const {
  buatOrderWebsite, konfirmasiOrderWebsite,
  kirimOrderWebsite, terimaOrderWebsite, batalkanOrderWebsite,
  daftarOrderWebsite, detailOrderWebsite,
  METODE_BAYAR_WEB, KURIR_LIST,
} = require('./penjualan/website');
const {
  neracaSaldo, laporanLabaRugi, neraca,
  rekapPenjualan, rekapPembelian, rekapPenjualanWebsite,
} = require('./laporan/keuangan');

const LEBAR = 80;
const SEP   = '─'.repeat(LEBAR);

// ── Helpers I/O ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function pertanyaan(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function header(judul) {
  console.log(`\n${'═'.repeat(LEBAR)}`);
  console.log(`  ${judul}`);
  console.log('═'.repeat(LEBAR));
}

function fmt(angka) {
  return (angka || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(15);
}

function hariIni() {
  return new Date().toISOString().slice(0, 10);
}

// ── Akun ──────────────────────────────────────────────────────────────────────

async function cmdDaftarAkun() {
  header('DAFTAR AKUN (Chart of Accounts)');
  const akuns = daftarAkun();
  console.log('Kode       Nama                                Jenis        Saldo Normal         Saldo');
  console.log(SEP);
  for (const a of akuns) {
    console.log(
      `${a.kode.padEnd(10)} ${a.nama.substring(0, 35).padEnd(35)} ${a.jenis.padEnd(12)} ${a.saldo_normal.padEnd(12)} ${fmt(a.saldo)}`
    );
  }
  console.log(SEP);
}

async function cmdTambahAkun() {
  header('TAMBAH AKUN BARU');
  const kode        = (await pertanyaan('Kode akun      : ')).trim();
  const nama        = (await pertanyaan('Nama akun      : ')).trim();
  const jenis       = (await pertanyaan('Jenis (Aset/Kewajiban/Ekuitas/Pendapatan/Beban): ')).trim();
  const saldoNormal = (await pertanyaan('Saldo normal (Debit/Kredit): ')).trim();
  try {
    tambahAkun(kode, nama, jenis, saldoNormal);
    console.log(`✔  Akun ${kode} – ${nama} berhasil ditambahkan.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdJurnalUmum() {
  header('CATAT JURNAL UMUM');
  const tanggal    = (await pertanyaan(`Tanggal [${hariIni()}]: `)).trim() || hariIni();
  const nomorBukti = (await pertanyaan('Nomor bukti    : ')).trim();
  const keterangan = (await pertanyaan('Keterangan     : ')).trim();
  const detail     = [];
  console.log('Masukkan baris debit/kredit (kosongkan kode akun untuk selesai):');
  while (true) {
    const kode = (await pertanyaan('  Kode akun   : ')).trim();
    if (!kode) break;
    const akun = cariAkun(kode);
    if (!akun) { console.log(`  ✘ Akun ${kode} tidak ditemukan.`); continue; }
    const debit  = parseFloat((await pertanyaan('  Debit      : ')).trim() || '0');
    const kredit = parseFloat((await pertanyaan('  Kredit     : ')).trim() || '0');
    detail.push({ kode_akun: kode, debit, kredit });
  }
  if (!detail.length) { console.log('Tidak ada detail, dibatalkan.'); return; }
  try {
    const entri = catatJurnal({ tanggal, nomor_bukti: nomorBukti, keterangan, detail });
    console.log(`✔  Jurnal ${nomorBukti} berhasil dicatat (id=${entri.id}).`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarJurnal() {
  header('DAFTAR JURNAL UMUM');
  const list = daftarJurnal();
  for (const j of list) {
    console.log(`\n[${j.id}] ${j.tanggal}  ${j.nomor_bukti}  ${j.keterangan}`);
    for (const d of j.detail) {
      const dStr = d.debit  > 0 ? `Debit  ${fmt(d.debit)}` : '';
      const kStr = d.kredit > 0 ? `Kredit ${fmt(d.kredit)}` : '';
      console.log(`       ${d.kode_akun}  ${dStr}${kStr}`);
    }
  }
}

async function cmdBukuBesar() {
  header('BUKU BESAR');
  const kode = (await pertanyaan('Kode akun: ')).trim();
  try {
    const bb = bukuBesar(kode);
    console.log(`\nAkun: ${bb.kode} – ${bb.nama} (${bb.jenis}, ${bb.saldo_normal})`);
    console.log(`${'Tanggal'.padEnd(12)} ${'No.Bukti'.padEnd(12)} ${'Keterangan'.padEnd(30)} ${'Debit'.padStart(13)} ${'Kredit'.padStart(13)} ${'Saldo'.padStart(13)}`);
    console.log(SEP);
    for (const m of bb.mutasi) {
      console.log(
        `${m.tanggal.padEnd(12)} ${m.nomor_bukti.padEnd(12)} ${m.keterangan.substring(0, 29).padEnd(30)} ${fmt(m.debit)} ${fmt(m.kredit)} ${fmt(m.saldo)}`
      );
    }
    console.log(SEP);
    console.log(`Saldo Akhir: ${fmt(bb.saldo_akhir)}`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

// ── Pelanggan ─────────────────────────────────────────────────────────────────

async function cmdTambahPelanggan() {
  header('TAMBAH PELANGGAN');
  const kode    = (await pertanyaan('Kode      : ')).trim();
  const nama    = (await pertanyaan('Nama      : ')).trim();
  const alamat  = (await pertanyaan('Alamat    : ')).trim();
  const telepon = (await pertanyaan('Telepon   : ')).trim();
  const email   = (await pertanyaan('Email     : ')).trim();
  try {
    tambahPelanggan({ kode, nama, alamat, telepon, email });
    console.log(`✔  Pelanggan ${kode} – ${nama} berhasil ditambahkan.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarPelanggan() {
  header('DAFTAR PELANGGAN');
  const list = daftarPelanggan();
  console.log(`${'Kode'.padEnd(10)} ${'Nama'.padEnd(30)} ${'Telepon'.padEnd(15)} Email`);
  console.log(SEP);
  for (const p of list) console.log(`${p.kode.padEnd(10)} ${p.nama.padEnd(30)} ${p.telepon.padEnd(15)} ${p.email}`);
}

// ── Produk ────────────────────────────────────────────────────────────────────

async function cmdTambahProduk() {
  header('TAMBAH PRODUK');
  const kode      = (await pertanyaan('Kode      : ')).trim();
  const nama      = (await pertanyaan('Nama      : ')).trim();
  const satuan    = (await pertanyaan('Satuan [pcs]: ')).trim() || 'pcs';
  const hargaJual = parseFloat((await pertanyaan('Harga jual: ')).trim() || '0');
  const hargaBeli = parseFloat((await pertanyaan('Harga beli: ')).trim() || '0');
  const stok      = parseFloat((await pertanyaan('Stok awal : ')).trim() || '0');
  try {
    tambahProduk({ kode, nama, satuan, harga_jual: hargaJual, harga_beli: hargaBeli, stok });
    console.log(`✔  Produk ${kode} – ${nama} berhasil ditambahkan.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarProduk() {
  header('DAFTAR PRODUK');
  const list = daftarProduk();
  console.log(`${'Kode'.padEnd(10)} ${'Nama'.padEnd(30)} ${'Satuan'.padEnd(8)} ${'H.Jual'.padStart(13)} ${'H.Beli'.padStart(13)} ${'Stok'.padStart(8)}`);
  console.log(SEP);
  for (const p of list) {
    console.log(`${p.kode.padEnd(10)} ${p.nama.substring(0, 29).padEnd(30)} ${p.satuan.padEnd(8)} ${fmt(p.harga_jual)} ${fmt(p.harga_beli)} ${String(p.stok).padStart(8)}`);
  }
}

// ── Faktur ────────────────────────────────────────────────────────────────────

async function cmdBuatFaktur() {
  header('BUAT FAKTUR PENJUALAN');
  const nomor          = (await pertanyaan('Nomor faktur       : ')).trim();
  const tanggal        = (await pertanyaan(`Tanggal [${hariIni()}]: `)).trim() || hariIni();
  const kodePelanggan  = (await pertanyaan('Kode pelanggan     : ')).trim() || null;
  const ppnPersen      = parseFloat((await pertanyaan('PPN % [11]         : ')).trim() || '11');
  const detail         = [];
  while (true) {
    const kp = (await pertanyaan('Kode produk (kosong=selesai): ')).trim();
    if (!kp) break;
    const produk = cariProduk(kp);
    if (!produk) { console.log(`  ✘ Produk ${kp} tidak ditemukan.`); continue; }
    const qty         = parseFloat((await pertanyaan(`  Qty: `)).trim());
    const harga       = parseFloat((await pertanyaan(`  Harga satuan [${produk.harga_jual}]: `)).trim() || String(produk.harga_jual));
    const diskon      = parseFloat((await pertanyaan('  Diskon % [0]: ')).trim() || '0');
    detail.push({ kode_produk: kp, qty, harga_satuan: harga, diskon_persen: diskon });
  }
  if (!detail.length) { console.log('Tidak ada item, dibatalkan.'); return; }
  try {
    const faktur = buatFaktur({ nomor, tanggal, kode_pelanggan: kodePelanggan, detail, ppn_persen: ppnPersen });
    console.log(`✔  Faktur ${nomor} berhasil dibuat (DRAFT). Total bayar: ${fmt(faktur.total_bayar).trim()}`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdPostingFaktur() {
  header('POSTING FAKTUR');
  const nomor = (await pertanyaan('Nomor faktur: ')).trim();
  try {
    postingFaktur(nomor);
    console.log(`✔  Faktur ${nomor} berhasil diposting.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarFaktur() {
  header('DAFTAR FAKTUR PENJUALAN');
  const list = daftarFaktur();
  console.log(`${'Nomor'.padEnd(15)} ${'Tanggal'.padEnd(12)} ${'Pelanggan'.padEnd(25)} ${'Total Bayar'.padStart(13)} Status`);
  console.log(SEP);
  for (const f of list) {
    console.log(`${f.nomor.padEnd(15)} ${f.tanggal.padEnd(12)} ${(f.nama_pelanggan || '-').substring(0, 24).padEnd(25)} ${fmt(f.total_bayar)} ${f.status}`);
  }
}

// ── Pemasok ───────────────────────────────────────────────────────────────────

async function cmdTambahPemasok() {
  header('TAMBAH PEMASOK');
  const kode     = (await pertanyaan('Kode     : ')).trim();
  const nama     = (await pertanyaan('Nama     : ')).trim();
  const platform = (await pertanyaan(`Platform (${PLATFORM_LIST.join('/')}): `)).trim();
  const alamat   = (await pertanyaan('Alamat   : ')).trim();
  const telepon  = (await pertanyaan('Telepon  : ')).trim();
  const email    = (await pertanyaan('Email    : ')).trim();
  try {
    tambahPemasok({ kode, nama, platform, alamat, telepon, email });
    console.log(`✔  Pemasok ${kode} – ${nama} berhasil ditambahkan.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarPemasok() {
  header('DAFTAR PEMASOK');
  const list = daftarPemasok();
  console.log(`${'Kode'.padEnd(10)} ${'Nama'.padEnd(30)} ${'Platform'.padEnd(12)} Telepon`);
  console.log(SEP);
  for (const p of list) console.log(`${p.kode.padEnd(10)} ${p.nama.padEnd(30)} ${p.platform.padEnd(12)} ${p.telepon}`);
}

// ── Order Pembelian ───────────────────────────────────────────────────────────

async function cmdBuatOrder() {
  header('BUAT ORDER PEMBELIAN');
  const nomor         = (await pertanyaan('Nomor order      : ')).trim();
  const tanggal       = (await pertanyaan(`Tanggal [${hariIni()}]: `)).trim() || hariIni();
  const platform      = (await pertanyaan(`Platform (${PLATFORM_LIST.join('/')}): `)).trim() || 'Manual';
  const nomorPlatform = (await pertanyaan('Nomor platform   : ')).trim();
  const kodePemasok   = (await pertanyaan('Kode pemasok     : ')).trim() || null;
  const metodeBayar   = (await pertanyaan(`Metode (${METODE_BAYAR_LIST.join('/')}) [Transfer]: `)).trim() || 'Transfer';
  const ongkir        = parseFloat((await pertanyaan('Ongkos kirim [0] : ')).trim() || '0');
  const diskon        = parseFloat((await pertanyaan('Diskon [0]       : ')).trim() || '0');
  const detail        = [];
  while (true) {
    const kp = (await pertanyaan('Kode produk (kosong=selesai): ')).trim();
    if (!kp) break;
    const qty   = parseFloat((await pertanyaan('  Qty         : ')).trim());
    const harga = parseFloat((await pertanyaan('  Harga satuan: ')).trim());
    detail.push({ kode_produk: kp, qty, harga_satuan: harga });
  }
  if (!detail.length) { console.log('Tidak ada item, dibatalkan.'); return; }
  try {
    const order = buatOrder({ nomor, tanggal, platform, nomor_platform: nomorPlatform, kode_pemasok: kodePemasok, metode_bayar: metodeBayar, ongkos_kirim: ongkir, diskon, detail });
    console.log(`✔  Order ${nomor} berhasil dibuat (DRAFT). Total: ${fmt(order.total_bayar).trim()}`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdPostingOrder() {
  header('POSTING ORDER PEMBELIAN');
  const nomor = (await pertanyaan('Nomor order: ')).trim();
  try {
    postingOrder(nomor);
    console.log(`✔  Order ${nomor} berhasil diposting.`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarOrder() {
  header('DAFTAR ORDER PEMBELIAN');
  const list = daftarOrder();
  console.log(`${'Nomor'.padEnd(15)} ${'Tanggal'.padEnd(12)} ${'Platform'.padEnd(12)} ${'Total Bayar'.padStart(13)} Status`);
  console.log(SEP);
  for (const o of list) console.log(`${o.nomor.padEnd(15)} ${o.tanggal.padEnd(12)} ${o.platform.padEnd(12)} ${fmt(o.total_bayar)} ${o.status}`);
}

async function cmdDetailOrder() {
  header('DETAIL ORDER PEMBELIAN');
  const nomor = (await pertanyaan('Nomor order: ')).trim();
  try {
    const data = detailOrder(nomor);
    console.log(`\nNomor    : ${data.nomor}`);
    console.log(`Tanggal  : ${data.tanggal}`);
    console.log(`Platform : ${data.platform}`);
    console.log(`Status   : ${data.status}`);
    console.log(`Total    : ${fmt(data.total_bayar).trim()}`);
    console.log(`\n${'Produk'.padEnd(12)} ${'Qty'.padStart(8)} ${'H.Satuan'.padStart(13)} ${'Subtotal'.padStart(13)}`);
    console.log(SEP);
    for (const item of data.items) {
      console.log(`${item.kode_produk.padEnd(12)} ${String(item.qty).padStart(8)} ${fmt(item.harga_satuan)} ${fmt(item.subtotal)}`);
    }
  } catch (e) { console.log(`✘  ${e.message}`); }
}

async function cmdRekapPembelian() {
  header('REKAP PEMBELIAN E-COMMERCE');
  const rekap = rekapPembelian();
  console.log('\nPer Platform:');
  for (const r of rekap.per_platform) {
    console.log(`  ${r.platform.padEnd(12)} ${r.jumlah_order} order  Total: ${fmt(r.total_bayar).trim()}`);
  }
  console.log('\nPer Produk:');
  for (const r of rekap.per_produk) {
    console.log(`  ${r.kode.padEnd(10)} ${r.nama.padEnd(28)} Qty: ${r.total_qty}  Nilai: ${fmt(r.total_nilai).trim()}`);
  }
}

// ── Laporan ───────────────────────────────────────────────────────────────────

async function cmdNeracaSaldo() {
  header('NERACA SALDO');
  const ns = neracaSaldo();
  console.log(`${'Kode'.padEnd(10)} ${'Nama'.padEnd(35)} ${'Debit'.padStart(13)} ${'Kredit'.padStart(13)}`);
  console.log(SEP);
  for (const b of ns.baris) {
    console.log(`${b.kode.padEnd(10)} ${b.nama.substring(0, 34).padEnd(35)} ${fmt(b.debit)} ${fmt(b.kredit)}`);
  }
  console.log(SEP);
  console.log(`${'TOTAL'.padEnd(45)} ${fmt(ns.total_debit)} ${fmt(ns.total_kredit)}`);
  console.log(`Seimbang: ${ns.seimbang ? '✔' : '✘'}`);
}

async function cmdLabaRugi() {
  header('LAPORAN LABA RUGI');
  const llr = laporanLabaRugi();
  console.log('\nPENDAPATAN:');
  for (const p of llr.pendapatan) console.log(`  ${p.kode.padEnd(10)} ${p.nama.padEnd(35)} ${fmt(p.jumlah)}`);
  console.log(`  ${'Total Pendapatan'.padEnd(45)} ${fmt(llr.total_pendapatan)}`);
  console.log('\nBEBAN:');
  for (const b of llr.beban) console.log(`  ${b.kode.padEnd(10)} ${b.nama.padEnd(35)} ${fmt(b.jumlah)}`);
  console.log(`  ${'Total Beban'.padEnd(45)} ${fmt(llr.total_beban)}`);
  console.log(SEP);
  console.log(`  ${'LABA / RUGI BERSIH'.padEnd(45)} ${fmt(llr.laba_bersih)}`);
}

async function cmdNeraca() {
  header('NERACA');
  const data = neraca();
  console.log('\nASET:');
  for (const a of data.aset) console.log(`  ${a.kode.padEnd(10)} ${a.nama.padEnd(35)} ${fmt(a.jumlah)}`);
  console.log(`  ${'Total Aset'.padEnd(45)} ${fmt(data.total_aset)}`);
  console.log('\nKEWAJIBAN:');
  for (const k of data.kewajiban) console.log(`  ${k.kode.padEnd(10)} ${k.nama.padEnd(35)} ${fmt(k.jumlah)}`);
  console.log(`  ${'Total Kewajiban'.padEnd(45)} ${fmt(data.total_kewajiban)}`);
  console.log('\nEKUITAS:');
  for (const e of data.ekuitas) console.log(`  ${e.kode.padEnd(10)} ${e.nama.padEnd(35)} ${fmt(e.jumlah)}`);
  console.log(`  ${'Total Ekuitas'.padEnd(45)} ${fmt(data.total_ekuitas)}`);
  console.log(SEP);
  console.log(`Seimbang: ${data.seimbang ? '✔' : '✘'}`);
}

async function cmdRekapPenjualan() {
  header('REKAP PENJUALAN');
  const rekap = rekapPenjualan();
  console.log('\nPer Pelanggan:');
  for (const r of rekap.per_pelanggan) console.log(`  ${r.pelanggan.padEnd(30)} ${r.jumlah_faktur} faktur  Total: ${fmt(r.total).trim()}`);
  console.log('\nPer Produk:');
  for (const r of rekap.per_produk) console.log(`  ${r.kode.padEnd(10)} ${r.nama.padEnd(30)} Qty: ${r.total_qty}  Nilai: ${fmt(r.total_nilai).trim()}`);
}

// ── Order Website ─────────────────────────────────────────────────────────────

async function cmdBuatOrderWebsite() {
  header('BUAT ORDER PENJUALAN WEBSITE');
  const nomor          = (await pertanyaan('Nomor order      : ')).trim();
  const tanggal        = (await pertanyaan(`Tanggal [${hariIni()}]: `)).trim() || hariIni();
  const namaPenerima   = (await pertanyaan('Nama penerima    : ')).trim();
  const alamatKirim    = (await pertanyaan('Alamat kirim     : ')).trim();
  const telepon        = (await pertanyaan('Telepon penerima : ')).trim();
  const kodePelanggan  = (await pertanyaan('Kode pelanggan (kosong=tamu): ')).trim() || null;
  const metodeBayar    = (await pertanyaan(`Metode bayar (${METODE_BAYAR_WEB.join('/')}) [Transfer]: `)).trim() || 'Transfer';
  const ongkir         = parseFloat((await pertanyaan('Ongkos kirim [0] : ')).trim() || '0');
  const voucherKode    = (await pertanyaan('Kode voucher     : ')).trim();
  const diskonVoucher  = parseFloat((await pertanyaan('Diskon voucher [0]: ')).trim() || '0');
  const ppnPersen      = parseFloat((await pertanyaan('PPN % [11]       : ')).trim() || '11');
  const detail         = [];
  while (true) {
    const kp = (await pertanyaan('Kode produk (kosong=selesai): ')).trim();
    if (!kp) break;
    const produk = cariProduk(kp);
    if (!produk) { console.log(`  ✘ Produk ${kp} tidak ditemukan.`); continue; }
    const qty    = parseFloat((await pertanyaan(`  Qty (${produk.satuan}): `)).trim());
    const harga  = parseFloat((await pertanyaan(`  Harga satuan [${produk.harga_jual}]: `)).trim() || String(produk.harga_jual));
    const diskon = parseFloat((await pertanyaan('  Diskon item % [0]: ')).trim() || '0');
    detail.push({ kode_produk: kp, qty, harga_satuan: harga, diskon_persen: diskon });
  }
  if (!detail.length) { console.log('Tidak ada item, dibatalkan.'); return; }
  try {
    const order = buatOrderWebsite({ nomor, tanggal, nama_penerima: namaPenerima, alamat_kirim: alamatKirim, telepon_penerima: telepon, kode_pelanggan: kodePelanggan, metode_bayar: metodeBayar, ongkos_kirim: ongkir, voucher_kode: voucherKode, diskon_voucher: diskonVoucher, ppn_persen: ppnPersen, detail });
    console.log(`✔  Order website ${nomor} berhasil disimpan (PENDING). Total: ${fmt(order.total_bayar).trim()}`);
  } catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdKonfirmasiOrderWebsite() {
  header('KONFIRMASI ORDER WEBSITE');
  const nomor = (await pertanyaan('Nomor order: ')).trim();
  try { konfirmasiOrderWebsite(nomor); console.log(`✔  Order ${nomor} dikonfirmasi.`); }
  catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdKirimOrderWebsite() {
  header('KIRIM ORDER WEBSITE');
  const nomor     = (await pertanyaan('Nomor order : ')).trim();
  const kurir     = (await pertanyaan(`Kurir (${KURIR_LIST.join('/')}): `)).trim();
  const nomorResi = (await pertanyaan('Nomor resi  : ')).trim();
  try { kirimOrderWebsite(nomor, kurir, nomorResi); console.log(`✔  Order ${nomor} dikirim via ${kurir} – resi: ${nomorResi}`); }
  catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdTerimaOrderWebsite() {
  header('ORDER DITERIMA');
  const nomor  = (await pertanyaan('Nomor order: ')).trim();
  const tanggal = (await pertanyaan(`Tanggal terima [${hariIni()}]: `)).trim() || hariIni();
  try { terimaOrderWebsite(nomor, tanggal); console.log(`✔  Order ${nomor} ditandai DELIVERED.`); }
  catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdBatalkanOrderWebsite() {
  header('BATALKAN ORDER WEBSITE');
  const nomor  = (await pertanyaan('Nomor order: ')).trim();
  const tanggal = (await pertanyaan(`Tanggal batal [${hariIni()}]: `)).trim() || hariIni();
  try { batalkanOrderWebsite(nomor, tanggal); console.log(`✔  Order ${nomor} dibatalkan.`); }
  catch (e) { console.log(`✘  Error: ${e.message}`); }
}

async function cmdDaftarOrderWebsite() {
  header('DAFTAR ORDER WEBSITE');
  const statusFilter = (await pertanyaan('Filter status (kosong=semua): ')).trim().toUpperCase() || null;
  const list = daftarOrderWebsite(statusFilter);
  console.log(`${'Nomor'.padEnd(15)} ${'Tanggal'.padEnd(12)} ${'Penerima'.padEnd(20)} ${'Total Bayar'.padStart(13)} ${'Metode'.padEnd(13)} Status`);
  console.log(SEP);
  for (const o of list) {
    console.log(`${o.nomor.padEnd(15)} ${o.tanggal.padEnd(12)} ${o.nama_penerima.substring(0, 19).padEnd(20)} ${fmt(o.total_bayar)} ${o.metode_bayar.padEnd(13)} ${o.status}`);
  }
}

async function cmdDetailOrderWebsite() {
  header('DETAIL ORDER WEBSITE');
  const nomor = (await pertanyaan('Nomor order: ')).trim();
  try {
    const data = detailOrderWebsite(nomor);
    console.log(`\nNomor      : ${data.nomor}`);
    console.log(`Status     : ${data.status}`);
    console.log(`Penerima   : ${data.nama_penerima}`);
    console.log(`Alamat     : ${data.alamat_kirim}`);
    console.log(`Metode     : ${data.metode_bayar}`);
    console.log(`Total      : ${fmt(data.total_bayar).trim()}`);
  } catch (e) { console.log(`✘  ${e.message}`); }
}

async function cmdRekapPenjualanWebsite() {
  header('REKAP PENJUALAN WEBSITE');
  const rekap = rekapPenjualanWebsite();
  console.log('\nPer Status:');
  for (const r of rekap.per_status) console.log(`  ${r.status.padEnd(12)} ${r.jumlah_order} order  Total: ${fmt(r.total_bayar).trim()}`);
  console.log('\nPer Metode Bayar:');
  for (const r of rekap.per_metode) console.log(`  ${r.metode_bayar.padEnd(15)} ${r.jumlah_order} order  Total: ${fmt(r.total_bayar).trim()}`);
}

// ── Menu ──────────────────────────────────────────────────────────────────────

const MENU = [
  null,
  // Akuntansi
  ['Daftar Akun',                   cmdDaftarAkun],
  ['Tambah Akun',                   cmdTambahAkun],
  ['Catat Jurnal Umum',             cmdJurnalUmum],
  ['Daftar Jurnal Umum',            cmdDaftarJurnal],
  ['Buku Besar',                    cmdBukuBesar],
  // Penjualan manual
  ['Tambah Pelanggan',              cmdTambahPelanggan],
  ['Daftar Pelanggan',              cmdDaftarPelanggan],
  ['Tambah Produk',                 cmdTambahProduk],
  ['Daftar Produk',                 cmdDaftarProduk],
  ['Buat Faktur Penjualan',         cmdBuatFaktur],
  ['Posting Faktur',                cmdPostingFaktur],
  ['Daftar Faktur',                 cmdDaftarFaktur],
  // Website
  ['Buat Order Website',            cmdBuatOrderWebsite],
  ['Konfirmasi Order Website',      cmdKonfirmasiOrderWebsite],
  ['Kirim Order Website',           cmdKirimOrderWebsite],
  ['Order Diterima (COD settle)',   cmdTerimaOrderWebsite],
  ['Batalkan Order Website',        cmdBatalkanOrderWebsite],
  ['Daftar Order Website',          cmdDaftarOrderWebsite],
  ['Detail Order Website',          cmdDetailOrderWebsite],
  ['Rekap Penjualan Website',       cmdRekapPenjualanWebsite],
  // Pembelian
  ['Tambah Pemasok',                cmdTambahPemasok],
  ['Daftar Pemasok',                cmdDaftarPemasok],
  ['Buat Order Pembelian',          cmdBuatOrder],
  ['Posting Order Pembelian',       cmdPostingOrder],
  ['Daftar Order Pembelian',        cmdDaftarOrder],
  ['Detail Order Pembelian',        cmdDetailOrder],
  ['Rekap Pembelian',               cmdRekapPembelian],
  // Laporan
  ['Neraca Saldo',                  cmdNeracaSaldo],
  ['Laporan Laba Rugi',             cmdLabaRugi],
  ['Neraca',                        cmdNeraca],
  ['Rekap Penjualan',               cmdRekapPenjualan],
];

function tampilkanMenu() {
  console.log(`\n${'═'.repeat(LEBAR)}`);
  console.log('  SAGARA – Sistem Akuntansi & Penjualan Pro');
  console.log('═'.repeat(LEBAR));
  console.log('  AKUNTANSI');
  for (let i = 1; i <= 5; i++) console.log(`   [${String(i).padStart(2)}] ${MENU[i][0]}`);
  console.log('  PENJUALAN (Konter / Manual)');
  for (let i = 6; i <= 12; i++) console.log(`   [${String(i).padStart(2)}] ${MENU[i][0]}`);
  console.log('  PENJUALAN WEBSITE');
  for (let i = 13; i <= 20; i++) console.log(`   [${String(i).padStart(2)}] ${MENU[i][0]}`);
  console.log('  PEMBELIAN E-COMMERCE');
  for (let i = 21; i <= 27; i++) console.log(`   [${String(i).padStart(2)}] ${MENU[i][0]}`);
  console.log('  LAPORAN KEUANGAN');
  for (let i = 28; i <= 31; i++) console.log(`   [${String(i).padStart(2)}] ${MENU[i][0]}`);
  console.log(`   [ 0] Keluar`);
  console.log('═'.repeat(LEBAR));
}

async function main() {
  initDatabase();
  setupAkunDefault();
  console.log('✔  Database siap.');

  while (true) {
    tampilkanMenu();
    const pilihan = parseInt((await pertanyaan('\nPilih menu: ')).trim(), 10);
    if (pilihan === 0) { console.log('Sampai jumpa!'); rl.close(); process.exit(0); }
    if (!pilihan || pilihan < 1 || pilihan >= MENU.length || !MENU[pilihan]) {
      console.log('✘  Pilihan tidak valid.');
      continue;
    }
    try {
      await MENU[pilihan][1]();
    } catch (e) {
      console.log(`✘  Error tidak terduga: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
