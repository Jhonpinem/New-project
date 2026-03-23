'use strict';
/**
 * Laporan Keuangan:
 * - Neraca Saldo (Trial Balance)
 * - Laporan Laba Rugi (Income Statement)
 * - Neraca (Balance Sheet)
 * - Rekap Penjualan
 * - Rekap Pembelian
 * - Rekap Penjualan Website
 */

const { getConnection, DB_PATH } = require('../utils/database');

function normalizeDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function dateRangeClause(columnName, range) {
  const from = normalizeDate(range && range.from);
  const to = normalizeDate(range && range.to);
  const parts = [];
  const params = [];

  if (from) {
    parts.push(`${columnName} >= ?`);
    params.push(from);
  }
  if (to) {
    parts.push(`${columnName} <= ?`);
    params.push(to);
  }

  if (parts.length === 0) {
    return { clause: '', params, from: null, to: null };
  }

  return {
    clause: ` AND ${parts.join(' AND ')}`,
    params,
    from: from || null,
    to: to || null,
  };
}

function resolveReportArgs(rangeOrDbPath, dbPath) {
  if (typeof rangeOrDbPath === 'string' && rangeOrDbPath) {
    return { range: {}, dbPath: rangeOrDbPath };
  }
  return { range: rangeOrDbPath || {}, dbPath: dbPath || DB_PATH };
}

// ── Neraca Saldo ──────────────────────────────────────────────────────────────

/**
 * Hasilkan neraca saldo (trial balance).
 * @param {string} dbPath
 * @returns {{ baris, total_debit, total_kredit, seimbang }}
 */
function neracaSaldo(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare(
    'SELECT kode, nama, jenis, saldo_normal, saldo FROM akun ORDER BY kode'
  ).all();
  db.close();

  const baris = [];
  let totalDebit  = 0;
  let totalKredit = 0;

  for (const r of rows) {
    if (r.saldo === 0) continue;
    let debit, kredit;
    if (r.saldo_normal === 'Debit') {
      debit  = Math.max(r.saldo,  0);
      kredit = Math.max(-r.saldo, 0);
    } else {
      kredit = Math.max(r.saldo,  0);
      debit  = Math.max(-r.saldo, 0);
    }
    totalDebit  += debit;
    totalKredit += kredit;
    baris.push({
      kode:   r.kode,
      nama:   r.nama,
      jenis:  r.jenis,
      debit:  Math.round(debit  * 100) / 100,
      kredit: Math.round(kredit * 100) / 100,
    });
  }

  totalDebit  = Math.round(totalDebit  * 100) / 100;
  totalKredit = Math.round(totalKredit * 100) / 100;

  return {
    baris,
    total_debit:  totalDebit,
    total_kredit: totalKredit,
    seimbang:     Math.abs(totalDebit - totalKredit) < 0.01,
  };
}

// ── Laba Rugi ─────────────────────────────────────────────────────────────────

/**
 * Laporan Laba Rugi.
 * @param {string} dbPath
 * @returns {{ pendapatan, total_pendapatan, beban, total_beban, laba_bersih }}
 */
function laporanLabaRugi(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare(
    "SELECT kode, nama, jenis, saldo FROM akun WHERE jenis IN ('Pendapatan','Beban') ORDER BY kode"
  ).all();
  db.close();

  const pendapatan = [];
  const beban      = [];
  let totalPendapatan = 0;
  let totalBeban      = 0;

  for (const r of rows) {
    if (r.jenis === 'Pendapatan') {
      pendapatan.push({ kode: r.kode, nama: r.nama, jumlah: Math.round(r.saldo * 100) / 100 });
      totalPendapatan += r.saldo;
    } else {
      beban.push({ kode: r.kode, nama: r.nama, jumlah: Math.round(r.saldo * 100) / 100 });
      totalBeban += r.saldo;
    }
  }

  const labaBersih = Math.round((totalPendapatan - totalBeban) * 100) / 100;
  return {
    pendapatan,
    total_pendapatan: Math.round(totalPendapatan * 100) / 100,
    beban,
    total_beban:      Math.round(totalBeban * 100) / 100,
    laba_bersih:      labaBersih,
  };
}

// ── Neraca ────────────────────────────────────────────────────────────────────

/**
 * Neraca (Balance Sheet).
 * @param {string} dbPath
 * @returns {{ aset, total_aset, kewajiban, total_kewajiban, ekuitas, total_ekuitas, seimbang }}
 */
function neraca(dbPath = DB_PATH) {
  const db = getConnection(dbPath);
  const rows = db.prepare(
    "SELECT kode, nama, jenis, saldo_normal, saldo FROM akun WHERE jenis IN ('Aset','Kewajiban','Ekuitas') ORDER BY kode"
  ).all();
  db.close();

  const aset       = [];
  const kewajiban  = [];
  const ekuitas    = [];
  let totalAset      = 0;
  let totalKewajiban = 0;
  let totalEkuitas   = 0;

  for (const r of rows) {
    const adjustedBalance = r.saldo_normal === 'Debit' ? r.saldo : -r.saldo;
    const entry = { kode: r.kode, nama: r.nama, jumlah: Math.round(adjustedBalance * 100) / 100 };
    if (r.jenis === 'Aset') {
      aset.push(entry);
      totalAset += adjustedBalance;
    } else if (r.jenis === 'Kewajiban') {
      kewajiban.push(entry);
      totalKewajiban += adjustedBalance;
    } else {
      ekuitas.push(entry);
      totalEkuitas += adjustedBalance;
    }
  }

  const llr  = laporanLabaRugi(dbPath);
  const laba = llr.laba_bersih;
  if (laba !== 0) {
    ekuitas.push({ kode: '-', nama: 'Laba Periode Berjalan', jumlah: laba });
    totalEkuitas += laba;
  }

  totalAset      = Math.round(totalAset      * 100) / 100;
  totalKewajiban = Math.round(totalKewajiban * 100) / 100;
  totalEkuitas   = Math.round(totalEkuitas   * 100) / 100;

  return {
    aset,
    total_aset:       totalAset,
    kewajiban,
    total_kewajiban:  totalKewajiban,
    ekuitas,
    total_ekuitas:    totalEkuitas,
    seimbang:         Math.abs(totalAset - (totalKewajiban + totalEkuitas)) < 0.01,
  };
}

// ── Rekap Penjualan ───────────────────────────────────────────────────────────

/**
 * Rekap penjualan per pelanggan dan per produk.
 * @param {{ from?: string, to?: string }} [range]
 * @param {string} dbPath
 * @returns {{ per_pelanggan, per_produk }}
 */
function rekapPenjualan(rangeOrDbPath = {}, dbPath = DB_PATH) {
  const args = resolveReportArgs(rangeOrDbPath, dbPath);
  const db = getConnection(args.dbPath);
  const dr = dateRangeClause('fp.tanggal', args.range);

  const perPelanggan = db.prepare(`
    SELECT COALESCE(p.nama, 'Umum') AS pelanggan,
           COUNT(fp.id)             AS jumlah_faktur,
           SUM(fp.total_bayar)      AS total
    FROM faktur_penjualan fp
    LEFT JOIN pelanggan p ON p.id = fp.pelanggan_id
    WHERE fp.status = 'POSTED'${dr.clause}
    GROUP BY fp.pelanggan_id
    ORDER BY total DESC
  `).all(...dr.params);

  const perProduk = db.prepare(`
    SELECT pr.kode, pr.nama,
           SUM(df.qty)      AS total_qty,
           SUM(df.subtotal) AS total_nilai
    FROM detail_faktur df
    JOIN produk pr ON pr.id = df.produk_id
    JOIN faktur_penjualan fp ON fp.id = df.faktur_id
    WHERE fp.status = 'POSTED'${dr.clause}
    GROUP BY df.produk_id
    ORDER BY total_nilai DESC
  `).all(...dr.params);

  db.close();
  return {
    periode: { from: dr.from, to: dr.to },
    per_pelanggan: perPelanggan,
    per_produk: perProduk,
  };
}

// ── Rekap Pembelian ───────────────────────────────────────────────────────────

/**
 * Rekap pembelian e-commerce per platform dan per produk.
 * @param {{ from?: string, to?: string }} [range]
 * @param {string} dbPath
 * @returns {{ per_platform, per_produk, per_pemasok }}
 */
function rekapPembelian(rangeOrDbPath = {}, dbPath = DB_PATH) {
  const args = resolveReportArgs(rangeOrDbPath, dbPath);
  const db = getConnection(args.dbPath);
  const dr = dateRangeClause('op.tanggal', args.range);

  const perPlatform = db.prepare(`
    SELECT op.platform,
           COUNT(op.id)         AS jumlah_order,
           SUM(op.subtotal)     AS total_barang,
           SUM(op.ongkos_kirim) AS total_ongkir,
           SUM(op.diskon)       AS total_diskon,
           SUM(op.total_bayar)  AS total_bayar
    FROM order_pembelian op
    WHERE op.status = 'POSTED'${dr.clause}
    GROUP BY op.platform
    ORDER BY total_bayar DESC
  `).all(...dr.params);

  const perProduk = db.prepare(`
    SELECT pr.kode, pr.nama,
           SUM(dp.qty)      AS total_qty,
           SUM(dp.subtotal) AS total_nilai
    FROM detail_pembelian dp
    JOIN produk pr ON pr.id = dp.produk_id
    JOIN order_pembelian op ON op.id = dp.order_id
    WHERE op.status = 'POSTED'${dr.clause}
    GROUP BY dp.produk_id
    ORDER BY total_nilai DESC
  `).all(...dr.params);

  const perPemasok = db.prepare(`
    SELECT COALESCE(ps.nama, 'Tanpa Pemasok') AS pemasok,
           COALESCE(ps.platform, '-')          AS platform,
           COUNT(op.id)                        AS jumlah_order,
           SUM(op.total_bayar)                 AS total
    FROM order_pembelian op
    LEFT JOIN pemasok ps ON ps.id = op.pemasok_id
    WHERE op.status = 'POSTED'${dr.clause}
    GROUP BY op.pemasok_id
    ORDER BY total DESC
  `).all(...dr.params);

  db.close();
  return {
    periode: { from: dr.from, to: dr.to },
    per_platform: perPlatform,
    per_produk: perProduk,
    per_pemasok: perPemasok,
  };
}

// ── Rekap Penjualan Website ───────────────────────────────────────────────────

/**
 * Rekap penjualan website per status, metode bayar, produk, pelanggan.
 * @param {{ from?: string, to?: string }} [range]
 * @param {string} dbPath
 * @returns {{ per_status, per_metode, per_produk, per_pelanggan }}
 */
function rekapPenjualanWebsite(rangeOrDbPath = {}, dbPath = DB_PATH) {
  const args = resolveReportArgs(rangeOrDbPath, dbPath);
  const db = getConnection(args.dbPath);
  const dr = dateRangeClause('tanggal', args.range);
  const drOw = dateRangeClause('ow.tanggal', args.range);

  const perStatus = db.prepare(`
    SELECT status,
           COUNT(id)           AS jumlah_order,
           SUM(subtotal)       AS total_barang,
           SUM(diskon_voucher) AS total_diskon,
           SUM(ongkos_kirim)   AS total_ongkir,
           SUM(ppn)            AS total_ppn,
           SUM(total_bayar)    AS total_bayar
    FROM order_website
    WHERE 1=1${dr.clause}
    GROUP BY status
    ORDER BY CASE status
      WHEN 'PENDING'   THEN 1
      WHEN 'CONFIRMED' THEN 2
      WHEN 'SHIPPED'   THEN 3
      WHEN 'DELIVERED' THEN 4
      WHEN 'CANCELLED' THEN 5
    END
  `).all(...dr.params);

  const perMetode = db.prepare(`
    SELECT metode_bayar,
           COUNT(id)        AS jumlah_order,
           SUM(total_bayar) AS total_bayar
    FROM order_website
    WHERE status IN ('CONFIRMED','SHIPPED','DELIVERED')${dr.clause}
    GROUP BY metode_bayar
    ORDER BY total_bayar DESC
  `).all(...dr.params);

  const perProduk = db.prepare(`
    SELECT pr.kode, pr.nama,
           SUM(dow.qty)      AS total_qty,
           SUM(dow.subtotal) AS total_nilai
    FROM detail_order_website dow
    JOIN produk pr ON pr.id = dow.produk_id
    JOIN order_website ow ON ow.id = dow.order_id
    WHERE ow.status IN ('CONFIRMED','SHIPPED','DELIVERED')${drOw.clause}
    GROUP BY dow.produk_id
    ORDER BY total_nilai DESC
  `).all(...drOw.params);

  const perPelanggan = db.prepare(`
    SELECT COALESCE(p.nama, 'Tamu') AS pelanggan,
           COUNT(ow.id)             AS jumlah_order,
           SUM(ow.total_bayar)      AS total
    FROM order_website ow
    LEFT JOIN pelanggan p ON p.id = ow.pelanggan_id
    WHERE ow.status IN ('CONFIRMED','SHIPPED','DELIVERED')${drOw.clause}
    GROUP BY ow.pelanggan_id
    ORDER BY total DESC
  `).all(...drOw.params);

  db.close();
  return {
    periode: { from: dr.from, to: dr.to },
    per_status:    perStatus,
    per_metode:    perMetode,
    per_produk:    perProduk,
    per_pelanggan: perPelanggan,
  };
}

module.exports = {
  neracaSaldo,
  laporanLabaRugi,
  neraca,
  rekapPenjualan,
  rekapPembelian,
  rekapPenjualanWebsite,
};
