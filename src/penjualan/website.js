'use strict';
/**
 * Modul Penjualan Website – Order dari toko online milik sendiri.
 *
 * Alur status: PENDING → CONFIRMED → SHIPPED → DELIVERED
 *                              ↓
 *                          CANCELLED (dari PENDING atau CONFIRMED)
 */

const { getConnection, DB_PATH } = require('../utils/database');
const { _validasiJurnal, _updateSaldoAkun } = require('../akuntansi/akun');

const METODE_BAYAR_WEB = ['Transfer', 'COD', 'E-Wallet', 'Kartu Kredit'];
const KURIR_LIST       = ['JNE', 'J&T', 'SiCepat', 'AnterAja', 'Pos Indonesia', 'Lainnya'];
const STATUS_LIST      = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

function normalizeWebsitePaymentMethod(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'hutang' || lower === 'tempo') return 'COD';
  if (METODE_BAYAR_WEB.includes(raw)) return raw;
  return 'Transfer';
}

function ensurePiutangSchema(db) {
  const orderCols = db.prepare("PRAGMA table_info('order_website')").all();
  const hasJumlahBayar = orderCols.some((c) => c.name === 'jumlah_bayar');
  if (!hasJumlahBayar) {
    db.exec('ALTER TABLE order_website ADD COLUMN jumlah_bayar REAL NOT NULL DEFAULT 0');
  }
  const hasSisaHutang = orderCols.some((c) => c.name === 'sisa_hutang');
  if (!hasSisaHutang) {
    db.exec('ALTER TABLE order_website ADD COLUMN sisa_hutang REAL NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pembayaran_piutang_website (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id     INTEGER NOT NULL REFERENCES order_website(id) ON DELETE CASCADE,
      tanggal      TEXT NOT NULL,
      jumlah       REAL NOT NULL,
      metode_bayar TEXT NOT NULL DEFAULT 'Transfer',
      keterangan   TEXT NOT NULL DEFAULT ''
    )
  `);

  const payCols = db.prepare("PRAGMA table_info('pembayaran_piutang_website')").all();
  const hasPayMethod = payCols.some((c) => c.name === 'metode_bayar');
  if (!hasPayMethod) {
    db.exec("ALTER TABLE pembayaran_piutang_website ADD COLUMN metode_bayar TEXT NOT NULL DEFAULT 'Transfer'");
  }
}

// ── Helper kalkulasi ──────────────────────────────────────────────────────────

/**
 * Hitung subtotal satu detail order website.
 * @param {{ qty, harga_satuan, diskon_persen? }} d
 * @returns {number}
 */
function hitungSubtotalDetailWeb(d) {
  return Math.round(d.qty * d.harga_satuan * (1 - (d.diskon_persen || 0) / 100) * 100) / 100;
}

/**
 * Hitung totals order website.
 * @param {{ detail, diskon_voucher?, ppn_persen?, ongkos_kirim? }} order
 * @returns {{ subtotal, nilai_barang, ppn, total_bayar }}
 */
function hitungTotalOrderWeb(order) {
  const subtotal    = Math.round(order.detail.reduce((s, d) => s + hitungSubtotalDetailWeb(d), 0) * 100) / 100;
  const nilaiBrg    = Math.round(Math.max(subtotal - (order.diskon_voucher || 0), 0) * 100) / 100;
  const ppnPersen   = order.ppn_persen !== undefined ? order.ppn_persen : 11;
  const ppn         = Math.round(nilaiBrg * ppnPersen / 100 * 100) / 100;
  const totalBayar  = Math.round((nilaiBrg + ppn + (order.ongkos_kirim || 0)) * 100) / 100;
  return { subtotal, nilai_barang: nilaiBrg, ppn, total_bayar: totalBayar };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Simpan order website ke database (status PENDING).
 * @param {object} order
 * @param {string} dbPath
 * @returns {typeof order & { id: number }}
 */
function buatOrderWebsite(order, dbPath = DB_PATH) {
  const { subtotal, nilai_barang, ppn, total_bayar } = hitungTotalOrderWeb(order);
  const db = getConnection(dbPath);
  const metodeBayar = normalizeWebsitePaymentMethod(order.metode_bayar);

  let pelangganId = null;
  if (order.kode_pelanggan) {
    const row = db.prepare('SELECT id FROM pelanggan WHERE kode=?').get(order.kode_pelanggan);
    if (row) pelangganId = row.id;
  }

  const run = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO order_website
        (nomor, tanggal, pelanggan_id, nama_penerima, alamat_kirim,
         telepon_penerima, kurir, nomor_resi, metode_bayar,
         voucher_kode, diskon_voucher, ongkos_kirim, ppn_persen,
         subtotal, ppn, total_bayar, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      order.nomor, order.tanggal, pelangganId,
      order.nama_penerima, order.alamat_kirim,
      order.telepon_penerima || '', order.kurir || '', order.nomor_resi || '',
      metodeBayar,
      order.voucher_kode || '', order.diskon_voucher || 0,
      order.ongkos_kirim || 0, order.ppn_persen !== undefined ? order.ppn_persen : 11,
      subtotal, ppn, total_bayar, order.status || 'PENDING'
    );

    for (const d of order.detail) {
      const produk = db.prepare('SELECT id FROM produk WHERE kode=?').get(d.kode_produk);
      if (!produk) throw new Error(`Produk tidak ditemukan: ${d.kode_produk}`);
      db.prepare(`
        INSERT INTO detail_order_website(order_id,produk_id,qty,harga_satuan,diskon_persen,subtotal)
        VALUES (?,?,?,?,?,?)
      `).run(lastInsertRowid, produk.id, d.qty, d.harga_satuan, d.diskon_persen || 0, hitungSubtotalDetailWeb(d));
    }
    return lastInsertRowid;
  });

  const id = run();
  db.close();
  return { ...order, id, subtotal, nilai_barang, ppn, total_bayar };
}

/**
 * Konfirmasi order website (PENDING → CONFIRMED):
 * - Validasi stok
 * - Kurangi stok
 * - Buat jurnal pendapatan + HPP
 * @param {string} nomor
 * @param {string} dbPath
 */
function konfirmasiOrderWebsite(nomor, dbPath = DB_PATH) {
  const db = getConnection(dbPath);

  const order = db.prepare('SELECT * FROM order_website WHERE nomor=?').get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }
  if (order.status !== 'PENDING') {
    db.close();
    throw new Error(`Order ${nomor} berstatus ${order.status}, hanya PENDING yang bisa dikonfirmasi.`);
  }

  const detailRows = db.prepare(`
    SELECT dow.qty, dow.harga_satuan,
           p.kode AS kode_produk, p.harga_beli, p.stok
    FROM detail_order_website dow
    JOIN produk p ON p.id = dow.produk_id
    WHERE dow.order_id=?
  `).all(order.id);

  for (const d of detailRows) {
    if (d.stok < d.qty) {
      db.close();
      throw new Error(`Stok produk ${d.kode_produk} tidak mencukupi (tersedia: ${d.stok}, dibutuhkan: ${d.qty})`);
    }
  }

  const akunDebit  = order.metode_bayar !== 'COD' ? '1-1100' : '1-1200';
  const nilaiBrg   = Math.round((order.subtotal - order.diskon_voucher) * 100) / 100;
  const ppnVal     = order.ppn;
  const ongkir     = order.ongkos_kirim;
  const totalBayar = order.total_bayar;

  const detailPendapatan = [
    { kode_akun: akunDebit,  debit: totalBayar, kredit: 0 },
    { kode_akun: '4-1000',   debit: 0,          kredit: nilaiBrg },
  ];
  if (ppnVal > 0)  detailPendapatan.push({ kode_akun: '2-1100', debit: 0, kredit: ppnVal });
  if (ongkir > 0)  detailPendapatan.push({ kode_akun: '4-1200', debit: 0, kredit: ongkir });
  _validasiJurnal(detailPendapatan);

  const hppTotal  = Math.round(detailRows.reduce((s, d) => s + d.qty * d.harga_beli, 0) * 100) / 100;
  const detailHpp = hppTotal > 0 ? [
    { kode_akun: '5-1000', debit: hppTotal, kredit: 0 },
    { kode_akun: '1-1300', debit: 0,        kredit: hppTotal },
  ] : [];
  if (detailHpp.length) _validasiJurnal(detailHpp);

  const run = db.transaction(() => {
    for (const d of detailRows) {
      db.prepare('UPDATE produk SET stok=stok-? WHERE kode=?').run(d.qty, d.kode_produk);
    }

    const { lastInsertRowid: jid } = db.prepare(
      'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
    ).run(order.tanggal, `WEB-${nomor}`, `Konfirmasi order website ${nomor}`);

    for (const d of detailPendapatan) {
      db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
        .run(jid, d.kode_akun, d.debit, d.kredit);
      _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
    }

    if (detailHpp.length) {
      const { lastInsertRowid: jid2 } = db.prepare(
        'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
      ).run(order.tanggal, `HPP-WEB-${nomor}`, `HPP order website ${nomor}`);

      for (const d of detailHpp) {
        db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
          .run(jid2, d.kode_akun, d.debit, d.kredit);
        _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
      }
    }

    db.prepare("UPDATE order_website SET status='CONFIRMED' WHERE nomor=?").run(nomor);
  });

  run();
  db.close();
}

/**
 * Tandai order sebagai SHIPPED (CONFIRMED → SHIPPED).
 * @param {string} nomor
 * @param {string} kurir
 * @param {string} nomorResi
 * @param {string} dbPath
 */
function kirimOrderWebsite(nomor, kurir, nomorResi, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const order = db.prepare('SELECT status FROM order_website WHERE nomor=?').get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }
  if (order.status !== 'CONFIRMED') {
    db.close();
    throw new Error(`Order ${nomor} berstatus ${order.status}, hanya CONFIRMED yang bisa dikirim.`);
  }
  db.prepare("UPDATE order_website SET status='SHIPPED', kurir=?, nomor_resi=? WHERE nomor=?")
    .run(kurir, nomorResi, nomor);
  db.close();
}

/**
 * Tandai order sebagai DELIVERED (SHIPPED → DELIVERED).
 * Untuk COD: buat jurnal pelunasan.
 * @param {string} nomor
 * @param {string} tanggalTerima
 * @param {string} dbPath
 */
function terimaOrderWebsite(nomor, tanggalTerima = '', dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const order = db.prepare('SELECT * FROM order_website WHERE nomor=?').get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }
  if (order.status !== 'SHIPPED') {
    db.close();
    throw new Error(`Order ${nomor} berstatus ${order.status}, hanya SHIPPED yang bisa diterima.`);
  }

  const tgl = tanggalTerima || new Date().toISOString().slice(0, 10);

  const run = db.transaction(() => {
    db.prepare("UPDATE order_website SET status='DELIVERED' WHERE nomor=?").run(nomor);

    if (order.metode_bayar === 'COD') {
      const detailCod = [
        { kode_akun: '1-1000', debit: order.total_bayar, kredit: 0 },
        { kode_akun: '1-1200', debit: 0, kredit: order.total_bayar },
      ];
      _validasiJurnal(detailCod);
      const { lastInsertRowid: jid } = db.prepare(
        'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
      ).run(tgl, `COD-${nomor}`, `Pelunasan COD order website ${nomor}`);

      for (const d of detailCod) {
        db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
          .run(jid, d.kode_akun, d.debit, d.kredit);
        _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
      }
    }
  });

  run();
  db.close();
}

/**
 * Batalkan order (PENDING atau CONFIRMED → CANCELLED).
 * Jika sudah CONFIRMED: balikkan jurnal dan kembalikan stok.
 * @param {string} nomor
 * @param {string} tanggalBatal
 * @param {string} dbPath
 */
function batalkanOrderWebsite(nomor, tanggalBatal = '', dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const order = db.prepare('SELECT * FROM order_website WHERE nomor=?').get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }
  if (!['PENDING', 'CONFIRMED'].includes(order.status)) {
    db.close();
    throw new Error(`Order ${nomor} berstatus ${order.status}, tidak bisa dibatalkan.`);
  }

  const tgl = tanggalBatal || new Date().toISOString().slice(0, 10);

  const detailRows = db.prepare(`
    SELECT dow.qty, p.kode AS kode_produk, p.harga_beli
    FROM detail_order_website dow
    JOIN produk p ON p.id = dow.produk_id
    WHERE dow.order_id=?
  `).all(order.id);

  const run = db.transaction(() => {
    if (order.status === 'CONFIRMED') {
      for (const d of detailRows) {
        db.prepare('UPDATE produk SET stok=stok+? WHERE kode=?').run(d.qty, d.kode_produk);
      }

      const akunDebit  = order.metode_bayar !== 'COD' ? '1-1100' : '1-1200';
      const nilaiBrg   = Math.round((order.subtotal - order.diskon_voucher) * 100) / 100;
      const ppnVal     = order.ppn;
      const ongkir     = order.ongkos_kirim;
      const total      = order.total_bayar;

      const detailBalik = [
        { kode_akun: akunDebit, debit: 0,        kredit: total     },
        { kode_akun: '4-1000',  debit: nilaiBrg, kredit: 0         },
      ];
      if (ppnVal > 0) detailBalik.push({ kode_akun: '2-1100', debit: ppnVal, kredit: 0 });
      if (ongkir > 0) detailBalik.push({ kode_akun: '4-1200', debit: ongkir, kredit: 0 });
      _validasiJurnal(detailBalik);

      const hppTotal = Math.round(detailRows.reduce((s, d) => s + d.qty * d.harga_beli, 0) * 100) / 100;
      const detailHppBalik = hppTotal > 0 ? [
        { kode_akun: '5-1000', debit: 0,        kredit: hppTotal },
        { kode_akun: '1-1300', debit: hppTotal, kredit: 0        },
      ] : [];
      if (detailHppBalik.length) _validasiJurnal(detailHppBalik);

      const { lastInsertRowid: jid } = db.prepare(
        'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
      ).run(tgl, `BATAL-WEB-${nomor}`, `Pembatalan order website ${nomor}`);

      for (const d of detailBalik) {
        db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
          .run(jid, d.kode_akun, d.debit, d.kredit);
        _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
      }

      if (detailHppBalik.length) {
        const { lastInsertRowid: jid2 } = db.prepare(
          'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
        ).run(tgl, `BATAL-HPP-${nomor}`, `Balik HPP pembatalan order website ${nomor}`);

        for (const d of detailHppBalik) {
          db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
            .run(jid2, d.kode_akun, d.debit, d.kredit);
          _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
        }
      }
    }

    db.prepare("UPDATE order_website SET status='CANCELLED' WHERE nomor=?").run(nomor);
  });

  run();
  db.close();
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Kembalikan daftar order website, opsional filter by status.
 * @param {string|null} status
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarOrderWebsite(status = null, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  let rows;
  if (status) {
    rows = db.prepare(`
      SELECT ow.*, p.nama AS nama_pelanggan
      FROM order_website ow
      LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
      WHERE ow.status=?
      ORDER BY ow.tanggal, ow.id
    `).all(status);
  } else {
    rows = db.prepare(`
      SELECT ow.*, p.nama AS nama_pelanggan
      FROM order_website ow
      LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
      ORDER BY ow.tanggal, ow.id
    `).all();
  }
  db.close();
  return rows;
}

/**
 * Kembalikan detail lengkap satu order website.
 * @param {string} nomor
 * @param {string} dbPath
 * @returns {object}
 */
function detailOrderWebsite(nomor, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const order = db.prepare(`
    SELECT ow.*, p.nama AS nama_pelanggan
    FROM order_website ow
    LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
    WHERE ow.nomor=?
  `).get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }

  const items = db.prepare(`
    SELECT dow.qty, dow.harga_satuan, dow.diskon_persen, dow.subtotal,
           pr.kode AS kode_produk, pr.nama AS nama_produk, pr.satuan
    FROM detail_order_website dow
    JOIN produk pr ON pr.id = dow.produk_id
    WHERE dow.order_id=?
  `).all(order.id);
  db.close();

  return { ...order, items };
}

/**
 * Kembalikan daftar piutang order website yang belum lunas.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarPiutangWebsite(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  ensurePiutangSchema(db);
  const rows = db.prepare(`
    SELECT ow.*, p.nama AS nama_pelanggan
    FROM order_website ow
    LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
    WHERE ow.sisa_hutang > 0
    ORDER BY ow.tanggal, ow.id
  `).all();
  db.close();
  return rows;
}

/**
 * Bayar cicilan piutang order website.
 * @param {string} nomor
 * @param {number} jumlahBayar
 * @param {string} tanggalBayar
 * @param {string} dbPath
 * @returns {{ nomor: string, dibayar: number, sisa_hutang: number, status: string }}
 */
function bayarPiutangWebsite(nomor, jumlahBayar, tanggalBayar = '', metodeBayar = 'Transfer', dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  ensurePiutangSchema(db);
  const order = db.prepare('SELECT * FROM order_website WHERE nomor=?').get(nomor);
  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }

  const sisaHutang = Number(order.sisa_hutang || 0);
  if (sisaHutang <= 0) {
    db.close();
    throw new Error(`Order ${nomor} tidak memiliki piutang aktif.`);
  }

  const nominal = Number(jumlahBayar || 0);
  if (!Number.isFinite(nominal) || nominal <= 0) {
    db.close();
    throw new Error('Nominal bayar harus lebih besar dari 0.');
  }
  if (nominal > sisaHutang) {
    db.close();
    throw new Error(`Nominal bayar melebihi sisa hutang (${sisaHutang}).`);
  }

  const tgl = tanggalBayar || new Date().toISOString().slice(0, 10);
  const sisaBaru = Math.round((sisaHutang - nominal) * 100) / 100;
  const jumlahBayarBaru = Math.round((Number(order.jumlah_bayar || 0) + nominal) * 100) / 100;

  const detailJurnal = [
    { kode_akun: '1-1000', debit: nominal, kredit: 0 },
    { kode_akun: '1-1200', debit: 0, kredit: nominal },
  ];
  _validasiJurnal(detailJurnal);

  const metode = String(metodeBayar || 'Transfer').trim() || 'Transfer';

  const run = db.transaction(() => {
    db.prepare('UPDATE order_website SET jumlah_bayar=?, sisa_hutang=? WHERE nomor=?')
      .run(jumlahBayarBaru, sisaBaru, nomor);

    db.prepare(
      'INSERT INTO pembayaran_piutang_website(order_id,tanggal,jumlah,metode_bayar,keterangan) VALUES(?,?,?,?,?)'
    ).run(order.id, tgl, nominal, metode, `Cicilan piutang ${nomor}`);

    if (sisaBaru <= 0 && order.status === 'CONFIRMED') {
      db.prepare("UPDATE order_website SET status='DELIVERED' WHERE nomor=?").run(nomor);
    }

    const { lastInsertRowid: jid } = db.prepare(
      'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
    ).run(tgl, `BYR-HUTANG-${nomor}`, `Pembayaran piutang order website ${nomor}`);

    for (const d of detailJurnal) {
      db.prepare('INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)')
        .run(jid, d.kode_akun, d.debit, d.kredit);
      _updateSaldoAkun(db, d.kode_akun, d.debit, d.kredit);
    }
  });

  run();
  const updated = db.prepare('SELECT nomor, jumlah_bayar, sisa_hutang, status FROM order_website WHERE nomor=?').get(nomor);
  db.close();
  return {
    nomor: updated.nomor,
    dibayar: Number(updated.jumlah_bayar || 0),
    sisa_hutang: Number(updated.sisa_hutang || 0),
    status: updated.status,
  };
}

/**
 * Kembalikan riwayat pembayaran piutang per nomor order.
 * @param {string} nomor
 * @param {string} dbPath
 * @returns {{ order: object, pembayaran: Array<object> }}
 */
function riwayatPiutangWebsite(nomor, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  ensurePiutangSchema(db);
  const order = db.prepare(`
    SELECT ow.*, p.nama AS nama_pelanggan
    FROM order_website ow
    LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
    WHERE ow.nomor=?
  `).get(nomor);

  if (!order) {
    db.close();
    throw new Error(`Order website tidak ditemukan: ${nomor}`);
  }

  const pembayaran = db.prepare(`
    SELECT id, tanggal, jumlah, metode_bayar, keterangan
    FROM pembayaran_piutang_website
    WHERE order_id=?
    ORDER BY tanggal, id
  `).all(order.id);

  db.close();
  return { order, pembayaran };
}

module.exports = {
  METODE_BAYAR_WEB,
  KURIR_LIST,
  STATUS_LIST,
  normalizeWebsitePaymentMethod,
  hitungSubtotalDetailWeb,
  hitungTotalOrderWeb,
  buatOrderWebsite,
  konfirmasiOrderWebsite,
  kirimOrderWebsite,
  terimaOrderWebsite,
  batalkanOrderWebsite,
  daftarOrderWebsite,
  detailOrderWebsite,
  daftarPiutangWebsite,
  bayarPiutangWebsite,
  riwayatPiutangWebsite,
};
