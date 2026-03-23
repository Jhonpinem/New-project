'use strict';
/**
 * Modul Pembelian E-Commerce – Pemasok, Order Pembelian, dan Posting Jurnal.
 */

const { getConnection, DB_PATH } = require('../utils/database');
const { _validasiJurnal, _updateSaldoAkun } = require('../akuntansi/akun');

const PLATFORM_LIST    = ['Shopee', 'Tokopedia', 'Lazada', 'Blibli', 'Bukalapak', 'Manual'];
const METODE_BAYAR_LIST = ['Transfer', 'COD', 'E-Wallet', 'Kredit'];

// ── Pemasok ───────────────────────────────────────────────────────────────────

/**
 * Tambah pemasok baru.
 * @param {{ kode, nama, platform?, alamat?, telepon?, email? }} p
 * @param {string} dbPath
 * @returns {typeof p & { id: number }}
 */
function tambahPemasok(p, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO pemasok(kode,nama,platform,alamat,telepon,email) VALUES(?,?,?,?,?,?)'
  ).run(p.kode, p.nama, p.platform || '', p.alamat || '', p.telepon || '', p.email || '');
  db.close();
  return { ...p, id: lastInsertRowid };
}

/**
 * Kembalikan semua pemasok.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarPemasok(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare('SELECT * FROM pemasok ORDER BY kode').all();
  db.close();
  return rows.map((r) => ({
    kode:     r.kode,
    nama:     r.nama,
    platform: r.platform || '',
    alamat:   r.alamat   || '',
    telepon:  r.telepon  || '',
    email:    r.email    || '',
    id:       r.id,
  }));
}

/**
 * Cari pemasok berdasarkan kode.
 * @param {string} kode
 * @param {string} dbPath
 * @returns {object|null}
 */
function cariPemasok(kode, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const r = db.prepare('SELECT * FROM pemasok WHERE kode=?').get(kode);
  db.close();
  if (!r) return null;
  return { kode: r.kode, nama: r.nama, platform: r.platform || '', alamat: r.alamat || '', telepon: r.telepon || '', email: r.email || '', id: r.id };
}

// ── Order Pembelian ───────────────────────────────────────────────────────────

/**
 * Hitung totals order pembelian.
 * @param {{ detail: Array<{qty,harga_satuan}>, ongkos_kirim?, diskon? }} order
 * @returns {{ subtotal, total_bayar, nilai_barang }}
 */
function hitungTotalOrder(order) {
  const subtotal   = Math.round(order.detail.reduce((s, d) => s + d.qty * d.harga_satuan, 0) * 100) / 100;
  const ongkir     = order.ongkos_kirim || 0;
  const diskon     = order.diskon       || 0;
  const totalBayar = Math.round((subtotal + ongkir - diskon) * 100) / 100;
  const nilaiBrg   = Math.round((subtotal - diskon) * 100) / 100;
  return { subtotal, total_bayar: totalBayar, nilai_barang: nilaiBrg };
}

/**
 * Simpan order pembelian ke database (status DRAFT).
 * @param {object} order
 * @param {string} dbPath
 * @returns {typeof order & { id: number }}
 */
function buatOrder(order, dbPath = DB_PATH) {
  const { subtotal, total_bayar, nilai_barang } = hitungTotalOrder(order);
  const db = getConnection(dbPath);

  let pemasokId = null;
  if (order.kode_pemasok) {
    const row = db.prepare('SELECT id FROM pemasok WHERE kode=?').get(order.kode_pemasok);
    if (row) pemasokId = row.id;
  }

  const run = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO order_pembelian
        (nomor,tanggal,platform,nomor_platform,pemasok_id,
         metode_bayar,subtotal,ongkos_kirim,diskon,total_bayar,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      order.nomor, order.tanggal, order.platform || 'Manual',
      order.nomor_platform || '', pemasokId,
      order.metode_bayar || 'Transfer', subtotal,
      order.ongkos_kirim || 0, order.diskon || 0, total_bayar,
      order.status || 'DRAFT'
    );

    for (const d of order.detail) {
      const produk = db.prepare('SELECT id FROM produk WHERE kode=?').get(d.kode_produk);
      if (!produk) throw new Error(`Produk tidak ditemukan: ${d.kode_produk}`);
      const sub = Math.round(d.qty * d.harga_satuan * 100) / 100;
      db.prepare(`
        INSERT INTO detail_pembelian(order_id,produk_id,qty,harga_satuan,subtotal)
        VALUES(?,?,?,?,?)
      `).run(lastInsertRowid, produk.id, d.qty, d.harga_satuan, sub);
    }
    return lastInsertRowid;
  });

  const id = run();
  db.close();
  return { ...order, id, subtotal, total_bayar, nilai_barang };
}

/**
 * Posting order pembelian: tambah stok, perbarui harga beli, buat jurnal.
 * @param {string} nomorOrder
 * @param {string} dbPath
 */
function postingOrder(nomorOrder, dbPath = DB_PATH) {
  const db = getConnection(dbPath);

  const order = db.prepare('SELECT * FROM order_pembelian WHERE nomor=?').get(nomorOrder);
  if (!order) {
    db.close();
    throw new Error(`Order pembelian tidak ditemukan: ${nomorOrder}`);
  }
  if (order.status !== 'DRAFT') {
    db.close();
    throw new Error(`Order ${nomorOrder} sudah berstatus ${order.status}, tidak bisa diposting.`);
  }

  const detailRows = db.prepare(`
    SELECT dp.qty, dp.harga_satuan, p.kode AS kode_produk
    FROM detail_pembelian dp
    JOIN produk p ON p.id = dp.produk_id
    WHERE dp.order_id=?
  `).all(order.id);

  if (!detailRows.length) {
    db.close();
    throw new Error(`Order ${nomorOrder} tidak memiliki detail item.`);
  }

  const nilaiBrg   = Math.round((order.subtotal - order.diskon) * 100) / 100;
  const ongkir     = order.ongkos_kirim;
  const totalBayar = order.total_bayar;

  const akunKredit = order.metode_bayar === 'Kredit' ? '2-1000' : '1-1000';

  const detailJurnal = [{ kode_akun: '1-1300', debit: nilaiBrg, kredit: 0 }];
  if (ongkir > 0) detailJurnal.push({ kode_akun: '5-2000', debit: ongkir, kredit: 0 });
  detailJurnal.push({ kode_akun: akunKredit, debit: 0, kredit: totalBayar });
  _validasiJurnal(detailJurnal);

  const run = db.transaction(() => {
    for (const d of detailRows) {
      db.prepare('UPDATE produk SET stok=stok+?, harga_beli=? WHERE kode=?')
        .run(d.qty, d.harga_satuan, d.kode_produk);
    }

    const { lastInsertRowid: jid } = db.prepare(
      'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
    ).run(
      order.tanggal, `PB-${nomorOrder}`,
      `Pembelian e-commerce ${order.platform} – ${nomorOrder}`
    );

    for (const d of detailJurnal) {
      db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
        .run(jid, d.kode_akun, d.debit, d.kredit);
      _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
    }

    db.prepare("UPDATE order_pembelian SET status='POSTED' WHERE nomor=?").run(nomorOrder);
  });

  run();
  db.close();
}

/**
 * Kembalikan semua order pembelian beserta nama pemasok.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarOrder(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare(`
    SELECT op.*, ps.nama AS nama_pemasok
    FROM order_pembelian op
    LEFT JOIN pemasok ps ON ps.id = op.pemasok_id
    ORDER BY op.tanggal, op.id
  `).all();
  db.close();
  return rows;
}

/**
 * Kembalikan detail lengkap satu order pembelian.
 * @param {string} nomorOrder
 * @param {string} dbPath
 * @returns {object}
 */
function detailOrder(nomorOrder, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const order = db.prepare(`
    SELECT op.*, ps.nama AS nama_pemasok
    FROM order_pembelian op
    LEFT JOIN pemasok ps ON ps.id = op.pemasok_id
    WHERE op.nomor=?
  `).get(nomorOrder);
  if (!order) {
    db.close();
    throw new Error(`Order tidak ditemukan: ${nomorOrder}`);
  }

  const items = db.prepare(`
    SELECT dp.qty, dp.harga_satuan, dp.subtotal,
           p.kode AS kode_produk, p.nama AS nama_produk, p.satuan
    FROM detail_pembelian dp
    JOIN produk p ON p.id = dp.produk_id
    WHERE dp.order_id=?
  `).all(order.id);
  db.close();

  return { ...order, items };
}

module.exports = {
  PLATFORM_LIST,
  METODE_BAYAR_LIST,
  tambahPemasok,
  daftarPemasok,
  cariPemasok,
  hitungTotalOrder,
  buatOrder,
  postingOrder,
  daftarOrder,
  detailOrder,
};
