'use strict';
/**
 * Modul database sederhana menggunakan SQLite untuk SAGARA Akuntansi & Penjualan.
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DB_PATH = process.env.SAGARA_DB || path.join(os.homedir(), 'sagara.db');

/**
 * Buka koneksi ke database SQLite.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function getConnection(dbPath = DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Inisialisasi skema database.
 * @param {string} dbPath
 */
function initDatabase(dbPath = DB_PATH) {
  const db = getConnection(dbPath);

  db.exec(`
    -- Akuntansi
    CREATE TABLE IF NOT EXISTS akun (
      kode         TEXT PRIMARY KEY,
      nama         TEXT NOT NULL,
      jenis        TEXT NOT NULL CHECK(jenis IN ('Aset','Kewajiban','Ekuitas','Pendapatan','Beban')),
      saldo_normal TEXT NOT NULL CHECK(saldo_normal IN ('Debit','Kredit')),
      saldo        REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jurnal (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tanggal     TEXT NOT NULL,
      nomor_bukti TEXT NOT NULL,
      keterangan  TEXT
    );

    CREATE TABLE IF NOT EXISTS detail_jurnal (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      jurnal_id INTEGER NOT NULL REFERENCES jurnal(id) ON DELETE CASCADE,
      kode_akun TEXT NOT NULL REFERENCES akun(kode),
      debit     REAL NOT NULL DEFAULT 0,
      kredit    REAL NOT NULL DEFAULT 0,
      CHECK(debit >= 0 AND kredit >= 0),
      CHECK(NOT (debit > 0 AND kredit > 0))
    );

    -- Penjualan
    CREATE TABLE IF NOT EXISTS pelanggan (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      kode    TEXT UNIQUE NOT NULL,
      nama    TEXT NOT NULL,
      alamat  TEXT,
      telepon TEXT,
      email   TEXT
    );

    CREATE TABLE IF NOT EXISTS akun_pembeli (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      nama_lengkap  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      dibuat_pada   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS akun_login (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      username         TEXT UNIQUE NOT NULL,
      nama_lengkap     TEXT NOT NULL,
      role             TEXT NOT NULL CHECK(role IN ('buyer','cashier','admin')),
      password_hash    TEXT NOT NULL,
      password_salt    TEXT NOT NULL,
      is_active        INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      permissions_json TEXT NOT NULL DEFAULT '{}',
      dibuat_pada      TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_pada      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS produk (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kode       TEXT UNIQUE NOT NULL,
      nama       TEXT NOT NULL,
      satuan     TEXT NOT NULL DEFAULT 'pcs',
      image_url  TEXT,
      harga_jual REAL NOT NULL DEFAULT 0,
      harga_beli REAL NOT NULL DEFAULT 0,
      stok       REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS faktur_penjualan (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nomor        TEXT UNIQUE NOT NULL,
      tanggal      TEXT NOT NULL,
      pelanggan_id INTEGER REFERENCES pelanggan(id),
      total        REAL NOT NULL DEFAULT 0,
      ppn          REAL NOT NULL DEFAULT 0,
      total_bayar  REAL NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','POSTED','VOID'))
    );

    CREATE TABLE IF NOT EXISTS detail_faktur (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      faktur_id     INTEGER NOT NULL REFERENCES faktur_penjualan(id) ON DELETE CASCADE,
      produk_id     INTEGER NOT NULL REFERENCES produk(id),
      qty           REAL NOT NULL,
      harga_satuan  REAL NOT NULL,
      diskon_persen REAL NOT NULL DEFAULT 0,
      subtotal      REAL NOT NULL
    );

    -- Pembelian E-Commerce
    CREATE TABLE IF NOT EXISTS pemasok (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      kode     TEXT UNIQUE NOT NULL,
      nama     TEXT NOT NULL,
      platform TEXT,
      alamat   TEXT,
      telepon  TEXT,
      email    TEXT
    );

    CREATE TABLE IF NOT EXISTS order_pembelian (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nomor          TEXT UNIQUE NOT NULL,
      tanggal        TEXT NOT NULL,
      platform       TEXT NOT NULL DEFAULT 'Manual',
      nomor_platform TEXT,
      pemasok_id     INTEGER REFERENCES pemasok(id),
      metode_bayar   TEXT NOT NULL DEFAULT 'Transfer'
                     CHECK(metode_bayar IN ('Transfer','COD','E-Wallet','Kredit')),
      subtotal       REAL NOT NULL DEFAULT 0,
      ongkos_kirim   REAL NOT NULL DEFAULT 0,
      diskon         REAL NOT NULL DEFAULT 0,
      total_bayar    REAL NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','POSTED','VOID'))
    );

    CREATE TABLE IF NOT EXISTS detail_pembelian (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id     INTEGER NOT NULL REFERENCES order_pembelian(id) ON DELETE CASCADE,
      produk_id    INTEGER NOT NULL REFERENCES produk(id),
      qty          REAL NOT NULL,
      harga_satuan REAL NOT NULL,
      subtotal     REAL NOT NULL
    );

    -- Penjualan Website
    CREATE TABLE IF NOT EXISTS order_website (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nomor            TEXT UNIQUE NOT NULL,
      tanggal          TEXT NOT NULL,
      pelanggan_id     INTEGER REFERENCES pelanggan(id),
      nama_penerima    TEXT NOT NULL,
      alamat_kirim     TEXT NOT NULL,
      telepon_penerima TEXT,
      kurir            TEXT,
      nomor_resi       TEXT,
      metode_bayar     TEXT NOT NULL DEFAULT 'Transfer'
                       CHECK(metode_bayar IN ('Transfer','COD','E-Wallet','Kartu Kredit')),
      voucher_kode     TEXT,
      diskon_voucher   REAL NOT NULL DEFAULT 0,
      ongkos_kirim     REAL NOT NULL DEFAULT 0,
      ppn_persen       REAL NOT NULL DEFAULT 11,
      subtotal         REAL NOT NULL DEFAULT 0,
      ppn              REAL NOT NULL DEFAULT 0,
      total_bayar      REAL NOT NULL DEFAULT 0,
      jumlah_bayar     REAL NOT NULL DEFAULT 0,
      sisa_hutang      REAL NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK(status IN ('PENDING','CONFIRMED','SHIPPED','DELIVERED','CANCELLED'))
    );

    CREATE TABLE IF NOT EXISTS detail_order_website (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      INTEGER NOT NULL REFERENCES order_website(id) ON DELETE CASCADE,
      produk_id     INTEGER NOT NULL REFERENCES produk(id),
      qty           REAL NOT NULL,
      harga_satuan  REAL NOT NULL,
      diskon_persen REAL NOT NULL DEFAULT 0,
      subtotal      REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pembayaran_piutang_website (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL REFERENCES order_website(id) ON DELETE CASCADE,
      tanggal     TEXT NOT NULL,
      jumlah      REAL NOT NULL,
      metode_bayar TEXT NOT NULL DEFAULT 'Transfer',
      keterangan  TEXT NOT NULL DEFAULT ''
    );
  `);

  // Backward-compatible migration for databases created before image_url existed.
  const produkCols = db.prepare("PRAGMA table_info('produk')").all();
  const hasImageUrl = produkCols.some((c) => c.name === 'image_url');
  if (!hasImageUrl) {
    db.exec('ALTER TABLE produk ADD COLUMN image_url TEXT');
  }

  const orderWebCols = db.prepare("PRAGMA table_info('order_website')").all();
  const hasJumlahBayar = orderWebCols.some((c) => c.name === 'jumlah_bayar');
  if (!hasJumlahBayar) {
    db.exec('ALTER TABLE order_website ADD COLUMN jumlah_bayar REAL NOT NULL DEFAULT 0');
  }
  const hasSisaHutang = orderWebCols.some((c) => c.name === 'sisa_hutang');
  if (!hasSisaHutang) {
    db.exec('ALTER TABLE order_website ADD COLUMN sisa_hutang REAL NOT NULL DEFAULT 0');
  }

  const payCols = db.prepare("PRAGMA table_info('pembayaran_piutang_website')").all();
  const hasPayMethod = payCols.some((c) => c.name === 'metode_bayar');
  if (!hasPayMethod) {
    db.exec("ALTER TABLE pembayaran_piutang_website ADD COLUMN metode_bayar TEXT NOT NULL DEFAULT 'Transfer'");
  }

  db.close();
}

module.exports = { DB_PATH, getConnection, initDatabase };
