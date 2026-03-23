'use strict';
/**
 * Modul Penjualan – Pelanggan, Produk, dan Faktur Penjualan.
 */

const { getConnection, DB_PATH } = require('../utils/database');
const { _validasiJurnal, _updateSaldoAkun } = require('../akuntansi/akun');

// ── Pelanggan ─────────────────────────────────────────────────────────────────

/**
 * Tambah pelanggan baru.
 * @param {{ kode, nama, alamat?, telepon?, email? }} p
 * @param {string} dbPath
 * @returns {typeof p & { id: number }}
 */
function tambahPelanggan(p, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO pelanggan(kode,nama,alamat,telepon,email) VALUES(?,?,?,?,?)'
  ).run(p.kode, p.nama, p.alamat || '', p.telepon || '', p.email || '');
  db.close();
  return { ...p, id: lastInsertRowid };
}

/**
 * Kembalikan semua pelanggan.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarPelanggan(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare('SELECT * FROM pelanggan ORDER BY kode').all();
  db.close();
  return rows.map((r) => ({
    kode:    r.kode,
    nama:    r.nama,
    alamat:  r.alamat  || '',
    telepon: r.telepon || '',
    email:   r.email   || '',
    id:      r.id,
  }));
}

/**
 * Cari pelanggan berdasarkan kode.
 * @param {string} kode
 * @param {string} dbPath
 * @returns {object|null}
 */
function cariPelanggan(kode, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const r = db.prepare('SELECT * FROM pelanggan WHERE kode=?').get(kode);
  db.close();
  if (!r) return null;
  return { kode: r.kode, nama: r.nama, alamat: r.alamat || '', telepon: r.telepon || '', email: r.email || '', id: r.id };
}

// ── Produk ────────────────────────────────────────────────────────────────────

/**
 * Tambah produk baru.
 * @param {{ kode, nama, satuan?, image_url?, harga_jual?, harga_beli?, stok? }} p
 * @param {string} dbPath
 * @returns {typeof p & { id: number }}
 */
function tambahProduk(p, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO produk(kode,nama,satuan,image_url,harga_jual,harga_beli,stok) VALUES(?,?,?,?,?,?,?)'
  ).run(
    p.kode,
    p.nama,
    p.satuan || 'pcs',
    p.image_url || '',
    p.harga_jual || 0,
    p.harga_beli || 0,
    p.stok || 0
  );
  db.close();
  return { ...p, id: lastInsertRowid };
}

/**
 * Tambah atau kurangi stok produk.
 * @param {string} kodeProduk
 * @param {number} deltaStok  positif = tambah, negatif = kurangi
 * @param {string} dbPath
 */
function updateStok(kodeProduk, deltaStok, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  db.prepare('UPDATE produk SET stok=stok+? WHERE kode=?').run(deltaStok, kodeProduk);
  db.close();
}

/**
 * Kembalikan semua produk.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarProduk(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare('SELECT * FROM produk ORDER BY kode').all();
  db.close();
  return rows.map((r) => ({
    kode:       r.kode,
    nama:       r.nama,
    satuan:     r.satuan,
    image_url:  r.image_url || '',
    harga_jual: r.harga_jual,
    harga_beli: r.harga_beli,
    stok:       r.stok,
    id:         r.id,
  }));
}

/**
 * Cari produk berdasarkan kode.
 * @param {string} kode
 * @param {string} dbPath
 * @returns {object|null}
 */
function cariProduk(kode, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const r = db.prepare('SELECT * FROM produk WHERE kode=?').get(kode);
  db.close();
  if (!r) return null;
  return {
    kode: r.kode,
    nama: r.nama,
    satuan: r.satuan,
    image_url: r.image_url || '',
    harga_jual: r.harga_jual,
    harga_beli: r.harga_beli,
    stok: r.stok,
    id: r.id,
  };
}

/**
 * Hapus produk berdasarkan kode.
 * Produk yang sudah dipakai transaksi tidak dapat dihapus.
 * @param {string} kode
 * @param {string} dbPath
 */
function hapusProduk(kode, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const existing = db.prepare('SELECT kode FROM produk WHERE kode=?').get(kode);
  if (!existing) {
    db.close();
    throw new Error(`Produk tidak ditemukan: ${kode}`);
  }

  try {
    const info = db.prepare('DELETE FROM produk WHERE kode=?').run(kode);
    if (info.changes === 0) {
      throw new Error(`Produk tidak ditemukan: ${kode}`);
    }
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (msg.includes('FOREIGN KEY constraint failed')) {
      db.close();
      throw new Error('Produk tidak dapat dihapus karena sudah dipakai di transaksi.');
    }
    db.close();
    throw error;
  }

  db.close();
}

// ── Faktur Penjualan ──────────────────────────────────────────────────────────

/**
 * Hitung subtotal detail faktur.
 * @param {{ qty, harga_satuan, diskon_persen? }} d
 * @returns {number}
 */
function hitungSubtotalDetail(d) {
  return Math.round(d.qty * d.harga_satuan * (1 - (d.diskon_persen || 0) / 100) * 100) / 100;
}

/**
 * Hitung totals faktur penjualan.
 * @param {{ detail: Array, ppn_persen? }} faktur
 * @returns {{ subtotal, ppn, total_bayar }}
 */
function hitungTotalFaktur(faktur) {
  const subtotal  = Math.round(faktur.detail.reduce((s, d) => s + hitungSubtotalDetail(d), 0) * 100) / 100;
  const ppn       = Math.round(subtotal * (faktur.ppn_persen || 11) / 100 * 100) / 100;
  const totalBayar = Math.round((subtotal + ppn) * 100) / 100;
  return { subtotal, ppn, total_bayar: totalBayar };
}

/**
 * Simpan faktur ke database (status DRAFT).
 * @param {{ nomor, tanggal, kode_pelanggan?, detail, ppn_persen? }} faktur
 * @param {string} dbPath
 * @returns {typeof faktur & { id: number }}
 */
function buatFaktur(faktur, dbPath = DB_PATH) {
  const { subtotal, ppn, total_bayar } = hitungTotalFaktur(faktur);
  const db = getConnection(dbPath);

  let pelangganId = null;
  if (faktur.kode_pelanggan) {
    const row = db.prepare('SELECT id FROM pelanggan WHERE kode=?').get(faktur.kode_pelanggan);
    if (row) pelangganId = row.id;
  }

  const run = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO faktur_penjualan(nomor,tanggal,pelanggan_id,total,ppn,total_bayar,status)
      VALUES(?,?,?,?,?,?,?)
    `).run(faktur.nomor, faktur.tanggal, pelangganId, subtotal, ppn, total_bayar, faktur.status || 'DRAFT');

    for (const d of faktur.detail) {
      const produk = db.prepare('SELECT id FROM produk WHERE kode=?').get(d.kode_produk);
      if (!produk) throw new Error(`Produk tidak ditemukan: ${d.kode_produk}`);
      db.prepare(`
        INSERT INTO detail_faktur(faktur_id,produk_id,qty,harga_satuan,diskon_persen,subtotal)
        VALUES(?,?,?,?,?,?)
      `).run(lastInsertRowid, produk.id, d.qty, d.harga_satuan, d.diskon_persen || 0, hitungSubtotalDetail(d));
    }
    return lastInsertRowid;
  });

  const id = run();
  db.close();
  return { ...faktur, id, subtotal, ppn, total_bayar };
}

/**
 * Posting faktur penjualan:
 *  - Kurangi stok produk
 *  - Buat jurnal otomatis (pendapatan + HPP)
 * @param {string} nomorFaktur
 * @param {string} dbPath
 */
function postingFaktur(nomorFaktur, dbPath = DB_PATH) {
  const db = getConnection(dbPath);

  const faktur = db.prepare('SELECT * FROM faktur_penjualan WHERE nomor=?').get(nomorFaktur);
  if (!faktur) {
    db.close();
    throw new Error(`Faktur tidak ditemukan: ${nomorFaktur}`);
  }
  if (faktur.status !== 'DRAFT') {
    db.close();
    throw new Error(`Faktur sudah berstatus ${faktur.status}, tidak bisa diposting.`);
  }

  const detailRows = db.prepare(`
    SELECT df.qty, p.kode AS kode_produk, p.harga_beli, p.stok
    FROM detail_faktur df
    JOIN produk p ON p.id = df.produk_id
    WHERE df.faktur_id=?
  `).all(faktur.id);

  // Validasi stok
  for (const d of detailRows) {
    if (d.stok < d.qty) {
      db.close();
      throw new Error(
        `Stok produk ${d.kode_produk} tidak mencukupi (tersedia: ${d.stok}, dibutuhkan: ${d.qty})`
      );
    }
  }

  const hppTotal   = Math.round(detailRows.reduce((s, d) => s + d.qty * d.harga_beli, 0) * 100) / 100;
  const totalNeto  = faktur.total;
  const ppnVal     = faktur.ppn;

  const detailPendapatan = [
    { kode_akun: '1-1200', debit: faktur.total_bayar, kredit: 0 },
    { kode_akun: '4-1000', debit: 0, kredit: totalNeto },
  ];
  if (ppnVal > 0) detailPendapatan.push({ kode_akun: '2-1100', debit: 0, kredit: ppnVal });
  _validasiJurnal(detailPendapatan);

  const detailHpp = hppTotal > 0 ? [
    { kode_akun: '5-1000', debit: hppTotal, kredit: 0 },
    { kode_akun: '1-1300', debit: 0, kredit: hppTotal },
  ] : [];
  if (detailHpp.length) _validasiJurnal(detailHpp);

  const run = db.transaction(() => {
    for (const d of detailRows) {
      db.prepare('UPDATE produk SET stok=stok-? WHERE kode=?').run(d.qty, d.kode_produk);
    }

    const { lastInsertRowid: jid } = db.prepare(
      'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
    ).run(faktur.tanggal, `PJ-${nomorFaktur}`, `Posting faktur penjualan ${nomorFaktur}`);

    for (const d of detailPendapatan) {
      db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
        .run(jid, d.kode_akun, d.debit, d.kredit);
      _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
    }

    if (detailHpp.length) {
      const { lastInsertRowid: jid2 } = db.prepare(
        'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
      ).run(faktur.tanggal, `HPP-${nomorFaktur}`, `HPP faktur penjualan ${nomorFaktur}`);

      for (const d of detailHpp) {
        db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
          .run(jid2, d.kode_akun, d.debit, d.kredit);
        _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
      }
    }

    db.prepare("UPDATE faktur_penjualan SET status='POSTED' WHERE nomor=?").run(nomorFaktur);
  });

  run();
  db.close();
}

/**
 * Kembalikan semua faktur penjualan.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarFaktur(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare(`
    SELECT fp.*, p.nama AS nama_pelanggan
    FROM faktur_penjualan fp
    LEFT JOIN pelanggan p ON p.id = fp.pelanggan_id
    ORDER BY fp.tanggal, fp.id
  `).all();
  db.close();
  return rows;
}

module.exports = {
  tambahPelanggan,
  daftarPelanggan,
  cariPelanggan,
  tambahProduk,
  hapusProduk,
  updateStok,
  daftarProduk,
  cariProduk,
  hitungSubtotalDetail,
  hitungTotalFaktur,
  buatFaktur,
  postingFaktur,
  daftarFaktur,
};
