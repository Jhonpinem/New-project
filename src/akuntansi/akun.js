'use strict';
/**
 * Modul Akuntansi – Chart of Accounts (Daftar Akun) dan Jurnal Umum.
 */

const { getConnection, DB_PATH } = require('../utils/database');

// ── Akun Default ──────────────────────────────────────────────────────────────

const AKUN_DEFAULT = [
  // Aset
  ['1-1000', 'Kas',                         'Aset',       'Debit'],
  ['1-1100', 'Bank',                         'Aset',       'Debit'],
  ['1-1200', 'Piutang Usaha',                'Aset',       'Debit'],
  ['1-1300', 'Persediaan Barang',            'Aset',       'Debit'],
  ['1-1400', 'Perlengkapan',                 'Aset',       'Debit'],
  ['1-2000', 'Peralatan',                    'Aset',       'Debit'],
  ['1-2100', 'Akumulasi Penyusutan',         'Aset',       'Kredit'],
  // Kewajiban
  ['2-1000', 'Utang Usaha',                  'Kewajiban',  'Kredit'],
  ['2-1100', 'Utang PPN Keluaran',           'Kewajiban',  'Kredit'],
  ['2-2000', 'Utang Jangka Panjang',         'Kewajiban',  'Kredit'],
  // Ekuitas
  ['3-1000', 'Modal Pemilik',                'Ekuitas',    'Kredit'],
  ['3-2000', 'Laba Ditahan',                 'Ekuitas',    'Kredit'],
  // Pendapatan
  ['4-1000', 'Pendapatan Penjualan',         'Pendapatan', 'Kredit'],
  ['4-1100', 'Pendapatan Lain-lain',         'Pendapatan', 'Kredit'],
  ['4-1200', 'Pendapatan Ongkos Kirim',      'Pendapatan', 'Kredit'],
  // Beban
  ['5-1000', 'Harga Pokok Penjualan',        'Beban',      'Debit'],
  ['5-1100', 'Beban Gaji',                   'Beban',      'Debit'],
  ['5-1200', 'Beban Sewa',                   'Beban',      'Debit'],
  ['5-1300', 'Beban Perlengkapan',           'Beban',      'Debit'],
  ['5-1400', 'Beban Penyusutan',             'Beban',      'Debit'],
  ['5-1500', 'Beban Listrik & Air',          'Beban',      'Debit'],
  ['5-2000', 'Biaya Pengiriman Pembelian',   'Beban',      'Debit'],
  ['5-2100', 'Biaya Marketplace',            'Beban',      'Debit'],
  ['5-1900', 'Beban Lain-lain',              'Beban',      'Debit'],
];

/**
 * Masukkan akun bawaan jika belum ada.
 * @param {string} dbPath
 */
function setupAkunDefault(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO akun(kode,nama,jenis,saldo_normal) VALUES(?,?,?,?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) stmt.run(...row);
  });
  insertMany(AKUN_DEFAULT);
  db.close();
}

/**
 * Tambah akun baru ke chart of accounts.
 * @param {string} kode
 * @param {string} nama
 * @param {string} jenis
 * @param {string} saldoNormal
 * @param {string} dbPath
 * @returns {{ kode, nama, jenis, saldo_normal, saldo }}
 */
function tambahAkun(kode, nama, jenis, saldoNormal, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  db.prepare('INSERT INTO akun(kode,nama,jenis,saldo_normal) VALUES(?,?,?,?)').run(
    kode, nama, jenis, saldoNormal
  );
  db.close();
  return { kode, nama, jenis, saldo_normal: saldoNormal, saldo: 0 };
}

/**
 * Kembalikan semua akun, urut berdasarkan kode.
 * @param {string} dbPath
 * @returns {Array<{kode,nama,jenis,saldo_normal,saldo}>}
 */
function daftarAkun(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare('SELECT * FROM akun ORDER BY kode').all();
  db.close();
  return rows;
}

/**
 * Cari akun berdasarkan kode.
 * @param {string} kode
 * @param {string} dbPath
 * @returns {{kode,nama,jenis,saldo_normal,saldo}|null}
 */
function cariAkun(kode, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const row = db.prepare('SELECT * FROM akun WHERE kode=?').get(kode);
  db.close();
  return row || null;
}

// ── Jurnal ────────────────────────────────────────────────────────────────────

/**
 * Validasi jurnal: total debit harus sama dengan total kredit.
 * @param {Array<{kode_akun,debit,kredit}>} detail
 */
function _validasiJurnal(detail) {
  if (!detail || detail.length === 0) {
    throw new Error('Jurnal harus memiliki minimal satu baris detail.');
  }
  const totalDebit  = Math.round(detail.reduce((s, d) => s + (d.debit  || 0), 0) * 1e6) / 1e6;
  const totalKredit = Math.round(detail.reduce((s, d) => s + (d.kredit || 0), 0) * 1e6) / 1e6;
  if (totalDebit !== totalKredit) {
    throw new Error(
      `Jurnal tidak seimbang: debit=${totalDebit.toFixed(2)}, kredit=${totalKredit.toFixed(2)}`
    );
  }
}

/**
 * Perbarui saldo akun setelah pencatatan jurnal.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kodeAkun
 * @param {number} debit
 * @param {number} kredit
 */
function _updateSaldoAkun(db, kodeAkun, debit, kredit) {
  const akun = db.prepare('SELECT * FROM akun WHERE kode=?').get(kodeAkun);
  if (!akun) throw new Error(`Kode akun tidak ditemukan: ${kodeAkun}`);
  const delta = akun.saldo_normal === 'Debit' ? debit - kredit : kredit - debit;
  db.prepare('UPDATE akun SET saldo=saldo+? WHERE kode=?').run(delta, kodeAkun);
}

/**
 * Catat entri jurnal ke database dan perbarui saldo akun.
 * @param {{ tanggal, nomor_bukti, keterangan, detail: Array<{kode_akun,debit,kredit}> }} entri
 * @param {string} dbPath
 * @returns {typeof entri & { id: number }}
 */
function catatJurnal(entri, dbPath = DB_PATH) {
  _validasiJurnal(entri.detail);
  const db = getConnection(dbPath);

  const run = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO jurnal(tanggal,nomor_bukti,keterangan) VALUES(?,?,?)'
    ).run(entri.tanggal, entri.nomor_bukti, entri.keterangan);

    for (const d of entri.detail) {
      db.prepare(
        'INSERT INTO detail_jurnal(jurnal_id,kode_akun,debit,kredit) VALUES(?,?,?,?)'
      ).run(lastInsertRowid, d.kode_akun, d.debit || 0, d.kredit || 0);
      _updateSaldoAkun(db, d.kode_akun, d.debit || 0, d.kredit || 0);
    }
    return lastInsertRowid;
  });

  const id = run();
  db.close();
  return { ...entri, id };
}

/**
 * Kembalikan semua jurnal beserta detailnya.
 * @param {string} dbPath
 * @returns {Array<object>}
 */
function daftarJurnal(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const jurnalRows = db.prepare('SELECT * FROM jurnal ORDER BY tanggal, id').all();
  const hasil = jurnalRows.map((j) => {
    const detail = db.prepare(
      'SELECT kode_akun, debit, kredit FROM detail_jurnal WHERE jurnal_id=?'
    ).all(j.id);
    return { ...j, detail };
  });
  db.close();
  return hasil;
}

/**
 * Kembalikan buku besar (ledger) untuk satu akun.
 * @param {string} kodeAkun
 * @param {string} dbPath
 * @returns {object}
 */
function bukuBesar(kodeAkun, dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const akun = db.prepare('SELECT * FROM akun WHERE kode=?').get(kodeAkun);
  if (!akun) {
    db.close();
    throw new Error(`Akun tidak ditemukan: ${kodeAkun}`);
  }

  const rows = db.prepare(`
    SELECT j.tanggal, j.nomor_bukti, j.keterangan, dj.debit, dj.kredit
    FROM detail_jurnal dj
    JOIN jurnal j ON j.id = dj.jurnal_id
    WHERE dj.kode_akun = ?
    ORDER BY j.tanggal, j.id
  `).all(kodeAkun);
  db.close();

  let saldo = 0;
  const mutasi = rows.map((r) => {
    saldo += akun.saldo_normal === 'Debit'
      ? r.debit - r.kredit
      : r.kredit - r.debit;
    return {
      tanggal:     r.tanggal,
      nomor_bukti: r.nomor_bukti,
      keterangan:  r.keterangan,
      debit:       r.debit,
      kredit:      r.kredit,
      saldo:       Math.round(saldo * 100) / 100,
    };
  });

  return {
    kode:        akun.kode,
    nama:        akun.nama,
    jenis:       akun.jenis,
    saldo_normal: akun.saldo_normal,
    mutasi,
    saldo_akhir: Math.round(saldo * 100) / 100,
  };
}

module.exports = {
  AKUN_DEFAULT,
  setupAkunDefault,
  tambahAkun,
  daftarAkun,
  cariAkun,
  _validasiJurnal,
  _updateSaldoAkun,
  catatJurnal,
  daftarJurnal,
  bukuBesar,
};
