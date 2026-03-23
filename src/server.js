'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { initDatabase, DB_PATH, getConnection } = require('./utils/database');
const {
  setupAkunDefault,
  tambahAkun,
  daftarAkun,
  cariAkun,
  catatJurnal,
  daftarJurnal,
  bukuBesar,
} = require('./akuntansi/akun');
const {
  tambahPelanggan,
  daftarPelanggan,
  tambahProduk,
  hapusProduk,
  daftarProduk,
  cariProduk,
  buatFaktur,
  postingFaktur,
  daftarFaktur,
} = require('./penjualan/faktur');
const {
  tambahPemasok,
  daftarPemasok,
  PLATFORM_LIST,
  METODE_BAYAR_LIST,
  buatOrder,
  postingOrder,
  daftarOrder,
  detailOrder,
} = require('./pembelian/pembelian');
const {
  neracaSaldo,
  laporanLabaRugi,
  neraca,
  rekapPenjualan,
  rekapPembelian,
  rekapPenjualanWebsite,
} = require('./laporan/keuangan');
const {
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
  normalizeWebsitePaymentMethod,
  METODE_BAYAR_WEB,
  KURIR_LIST,
  STATUS_LIST,
} = require('./penjualan/website');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.SAGARA_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.SAGARA_ADMIN_PASS || 'admin123';
const CASHIER_USERNAME = process.env.SAGARA_CASHIER_USER || 'kasir';
const CASHIER_PASSWORD = process.env.SAGARA_CASHIER_PASS || 'kasir123';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function getDateRangeQuery(req) {
  const from = normalizeDate(req.query.from);
  const to = normalizeDate(req.query.to);
  return { from, to };
}

function normalizeBuyerUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLoginUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function hashBuyerPassword(password, salt) {
  return crypto
    .createHash('sha256')
    .update(`sagara-buyer:${salt}:${String(password || '')}`)
    .digest('hex');
}

function hashLoginPassword(password, salt) {
  return crypto
    .createHash('sha256')
    .update(`sagara-login:${salt}:${String(password || '')}`)
    .digest('hex');
}

function parsePermissionObject(rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};
  const keys = ['can_view', 'can_create_order', 'can_process_order', 'can_manage_produk', 'can_cashier_sale'];
  const result = {};
  for (const key of keys) {
    if (typeof source[key] === 'boolean') {
      result[key] = source[key];
    }
  }
  return result;
}

function parsePermissionJson(rawJson) {
  try {
    const parsed = JSON.parse(String(rawJson || '{}'));
    return parsePermissionObject(parsed);
  } catch {
    return {};
  }
}

function findManagedLoginAccount(username) {
  const normalized = normalizeLoginUsername(username);
  if (!normalized) return null;
  const db = getConnection();
  const row = db.prepare(
    `SELECT id, username, nama_lengkap, role, password_hash, password_salt, is_active, permissions_json
     FROM akun_login
     WHERE username=?`
  ).get(normalized);
  db.close();
  if (!row) return null;
  return {
    ...row,
    permissions: parsePermissionJson(row.permissions_json),
    is_active: Number(row.is_active || 0) === 1,
  };
}

function listManagedLoginAccounts() {
  const db = getConnection();
  const rows = db.prepare(
    `SELECT id, username, nama_lengkap, role, is_active, permissions_json, dibuat_pada, diubah_pada
     FROM akun_login
     ORDER BY username`
  ).all();
  db.close();
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    nama_lengkap: row.nama_lengkap,
    role: row.role,
    is_active: Number(row.is_active || 0) === 1,
    permissions: parsePermissionJson(row.permissions_json),
    dibuat_pada: row.dibuat_pada,
    diubah_pada: row.diubah_pada,
  }));
}

function createManagedLoginAccount({ username, namaLengkap, role, password, isActive, permissions }) {
  const normalized = normalizeLoginUsername(username);
  const nama = String(namaLengkap || '').trim();
  const normalizedRole = String(role || '').trim().toLowerCase();
  const pass = String(password || '');
  const active = isActive === undefined ? 1 : (isActive ? 1 : 0);

  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) {
    throw new Error('Username akun harus 3-32 karakter (huruf kecil, angka, titik, strip, underscore).');
  }
  if (!['buyer', 'cashier', 'admin'].includes(normalizedRole)) {
    throw new Error('Role akun harus buyer, cashier, atau admin.');
  }
  if (nama.length < 2) {
    throw new Error('Nama lengkap minimal 2 karakter.');
  }
  if (pass.length < 6) {
    throw new Error('Password akun minimal 6 karakter.');
  }

  const db = getConnection();
  const exists = db.prepare('SELECT id FROM akun_login WHERE username=?').get(normalized);
  if (exists) {
    db.close();
    throw new Error('Username akun sudah terdaftar.');
  }

  const salt = crypto.randomBytes(12).toString('hex');
  const passwordHash = hashLoginPassword(pass, salt);
  const permissionsObject = parsePermissionObject(permissions);
  db.prepare(
    `INSERT INTO akun_login(username,nama_lengkap,role,password_hash,password_salt,is_active,permissions_json,diubah_pada)
     VALUES(?,?,?,?,?,?,?,datetime('now'))`
  ).run(
    normalized,
    nama,
    normalizedRole,
    passwordHash,
    salt,
    active,
    JSON.stringify(permissionsObject)
  );
  db.close();

  return findManagedLoginAccount(normalized);
}

function updateManagedLoginAccount(username, payload) {
  const normalized = normalizeLoginUsername(username);
  if (!normalized) throw new Error('Username akun wajib diisi.');

  const existing = findManagedLoginAccount(normalized);
  if (!existing) throw new Error('Akun tidak ditemukan.');

  const nextNama = payload.nama_lengkap === undefined
    ? existing.nama_lengkap
    : String(payload.nama_lengkap || '').trim();
  const nextRole = payload.role === undefined
    ? existing.role
    : String(payload.role || '').trim().toLowerCase();
  const nextActive = payload.is_active === undefined
    ? (existing.is_active ? 1 : 0)
    : (payload.is_active ? 1 : 0);
  const nextPermissions = payload.permissions === undefined
    ? existing.permissions
    : parsePermissionObject(payload.permissions);

  if (nextNama.length < 2) {
    throw new Error('Nama lengkap minimal 2 karakter.');
  }
  if (!['buyer', 'cashier', 'admin'].includes(nextRole)) {
    throw new Error('Role akun harus buyer, cashier, atau admin.');
  }

  const nextPassword = payload.password === undefined ? null : String(payload.password || '');
  const db = getConnection();
  if (nextPassword !== null && nextPassword.length > 0) {
    if (nextPassword.length < 6) {
      db.close();
      throw new Error('Password akun minimal 6 karakter.');
    }
    const salt = crypto.randomBytes(12).toString('hex');
    const passwordHash = hashLoginPassword(nextPassword, salt);
    db.prepare(
      `UPDATE akun_login
       SET nama_lengkap=?, role=?, is_active=?, permissions_json=?, password_hash=?, password_salt=?, diubah_pada=datetime('now')
       WHERE username=?`
    ).run(nextNama, nextRole, nextActive, JSON.stringify(nextPermissions), passwordHash, salt, normalized);
  } else {
    db.prepare(
      `UPDATE akun_login
       SET nama_lengkap=?, role=?, is_active=?, permissions_json=?, diubah_pada=datetime('now')
       WHERE username=?`
    ).run(nextNama, nextRole, nextActive, JSON.stringify(nextPermissions), normalized);
  }
  db.close();

  return findManagedLoginAccount(normalized);
}

function findBuyerAccount(username) {
  const normalized = normalizeBuyerUsername(username);
  if (!normalized) return null;
  const db = getConnection();
  const row = db.prepare(
    `SELECT id, username, nama_lengkap, password_hash, password_salt
     FROM akun_pembeli
     WHERE username=?`
  ).get(normalized);
  db.close();
  return row || null;
}

function createBuyerAccount({ username, namaLengkap, password }) {
  const normalized = normalizeBuyerUsername(username);
  const nama = String(namaLengkap || '').trim();
  const pass = String(password || '');

  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) {
    throw new Error('Username pembeli harus 3-32 karakter (huruf kecil, angka, titik, strip, underscore).');
  }
  if (nama.length < 2) {
    throw new Error('Nama lengkap minimal 2 karakter.');
  }
  if (pass.length < 6) {
    throw new Error('Password pembeli minimal 6 karakter.');
  }

  const db = getConnection();
  const exists = db.prepare('SELECT id FROM akun_pembeli WHERE username=?').get(normalized);
  if (exists) {
    db.close();
    throw new Error('Username pembeli sudah terdaftar.');
  }

  const salt = crypto.randomBytes(12).toString('hex');
  const passwordHash = hashBuyerPassword(pass, salt);
  db.prepare(
    `INSERT INTO akun_pembeli(username,nama_lengkap,password_hash,password_salt)
     VALUES(?,?,?,?)`
  ).run(normalized, nama, passwordHash, salt);
  db.close();

  return {
    username: normalized,
    nama_lengkap: nama,
  };
}

function ensureDemoProducts() {
  const samples = [
    {
      kode: 'PRD-WEB-01',
      nama: 'Kopi Arabica 200gr',
      satuan: 'pcs',
      image_url: 'https://picsum.photos/seed/sagara-kopi/640/360',
      harga_jual: 85000,
      harga_beli: 60000,
      stok: 40,
    },
    {
      kode: 'PRD-WEB-02',
      nama: 'Teh Melati Premium',
      satuan: 'pcs',
      image_url: 'https://picsum.photos/seed/sagara-teh/640/360',
      harga_jual: 45000,
      harga_beli: 28000,
      stok: 60,
    },
    {
      kode: 'PRD-WEB-03',
      nama: 'Gula Aren Organik',
      satuan: 'pcs',
      image_url: 'https://picsum.photos/seed/sagara-gula/640/360',
      harga_jual: 30000,
      harga_beli: 18000,
      stok: 80,
    },
  ];

  for (const p of samples) {
    if (!cariProduk(p.kode)) {
      tambahProduk(p);
    }
  }
}

function ok(res, data, code = 200) {
  res.status(code).json({ ok: true, data });
}

function fail(res, error, code = 400) {
  res.status(code).json({ ok: false, error: error.message || String(error) });
}

function parseAuthToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

function getSession(req) {
  const token = parseAuthToken(req);
  if (!token) return null;

  const session = adminSessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function getRoleCapabilities(role, permissionOverrides = {}) {
  const normalized = role || 'guest';
  if (normalized === 'admin') {
    return {
      role: normalized,
      can_view: true,
      can_create_order: true,
      can_process_order: true,
      can_manage_produk: true,
      can_cashier_sale: true,
    };
  }

  const base = {
    role: normalized,
    can_view: true,
    can_create_order: ['buyer', 'cashier', 'admin'].includes(normalized),
    can_process_order: ['cashier', 'admin'].includes(normalized),
    can_manage_produk: ['cashier', 'admin'].includes(normalized),
    can_cashier_sale: ['cashier', 'admin'].includes(normalized),
  };

  const overrides = parsePermissionObject(permissionOverrides);
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value;
  }
  return base;
}

function requireAuthenticated(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return fail(res, new Error('Silakan login terlebih dahulu.'), 401);
  }
  req.adminSession = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return fail(res, new Error('Akses admin dibutuhkan. Silakan login terlebih dahulu.'), 401);
  }
  if (session.role !== 'admin') {
    return fail(res, new Error('Akses ditolak. Hanya admin yang diizinkan.'), 403);
  }
  req.adminSession = session;
  next();
}

function requireCashierOrAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return fail(res, new Error('Silakan login sebagai kasir atau admin.'), 401);
  }
  if (!session.capabilities || session.capabilities.can_cashier_sale !== true) {
    return fail(res, new Error('Akses ditolak. Role pembeli tidak dapat melakukan transaksi.'), 403);
  }
  req.adminSession = session;
  next();
}

function requireCapability(capabilityKey, message) {
  return (req, res, next) => {
    const session = getSession(req);
    if (!session) {
      return fail(res, new Error('Silakan login terlebih dahulu.'), 401);
    }
    if (!session.capabilities || session.capabilities[capabilityKey] !== true) {
      return fail(res, new Error(message || 'Akses ditolak.'), 403);
    }
    req.adminSession = session;
    next();
  };
}

const requireCreateOrder = requireCapability('can_create_order', 'Akun ini tidak memiliki izin membuat order.');
const requireProcessOrder = requireCapability('can_process_order', 'Akun ini tidak memiliki izin memproses order.');
const requireManageProduk = requireCapability('can_manage_produk', 'Akun ini tidak memiliki izin mengelola produk.');
const requireCashierSale = requireCapability('can_cashier_sale', 'Akun ini tidak memiliki izin transaksi kasir.');

function createSession(username, role, permissionOverrides = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const capabilities = getRoleCapabilities(role, permissionOverrides);
  adminSessions.set(token, {
    username,
    role,
    capabilities,
    createdAt: Date.now(),
    expiresAt,
  });
  return {
    token,
    username,
    role,
    capabilities,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

app.post('/api/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const role = String(body.role || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const autoRole = !role || role === 'auto';

    if (autoRole) {
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return ok(res, createSession(username, 'admin'));
      }

      if (username === CASHIER_USERNAME && password === CASHIER_PASSWORD) {
        return ok(res, createSession(username, 'cashier'));
      }

      const managedAccount = findManagedLoginAccount(username);
      if (managedAccount) {
        if (!managedAccount.is_active) {
          return fail(res, new Error('Akun dinonaktifkan oleh admin.'), 403);
        }
        if (!password) {
          return fail(res, new Error('Password akun wajib diisi.'), 401);
        }
        const expectedHash = hashLoginPassword(password, managedAccount.password_salt);
        if (expectedHash !== managedAccount.password_hash) {
          return fail(res, new Error('Username atau password salah.'), 401);
        }
        return ok(res, createSession(managedAccount.username, managedAccount.role, managedAccount.permissions));
      }

      const buyerAccount = findBuyerAccount(username);
      if (buyerAccount) {
        if (!password) {
          return fail(res, new Error('Akun pembeli terdaftar. Masukkan password untuk login.'), 401);
        }
        const expectedHash = hashBuyerPassword(password, buyerAccount.password_salt);
        if (expectedHash !== buyerAccount.password_hash) {
          return fail(res, new Error('Username atau password pembeli salah.'), 401);
        }
        return ok(res, createSession(buyerAccount.username, 'buyer'));
      }

      if (password) {
        return fail(res, new Error('Username atau password tidak cocok dengan akun manapun.'), 401);
      }

      const buyerName = username || 'pembeli';
      return ok(res, createSession(buyerName, 'buyer'));
    }

    if (role === 'buyer' || role === 'visitor') {
      const managedBuyer = findManagedLoginAccount(username);
      if (managedBuyer && managedBuyer.role === 'buyer') {
        if (!managedBuyer.is_active) {
          return fail(res, new Error('Akun dinonaktifkan oleh admin.'), 403);
        }
        if (!password) {
          return fail(res, new Error('Akun pembeli terdaftar. Masukkan password untuk login.'), 401);
        }
        const expectedHash = hashLoginPassword(password, managedBuyer.password_salt);
        if (expectedHash !== managedBuyer.password_hash) {
          return fail(res, new Error('Username atau password pembeli salah.'), 401);
        }
        return ok(res, createSession(managedBuyer.username, managedBuyer.role, managedBuyer.permissions));
      }

      const buyerAccount = findBuyerAccount(username);

      if (buyerAccount) {
        if (!password) {
          return fail(res, new Error('Akun pembeli terdaftar. Masukkan password untuk login.'), 401);
        }
        const expectedHash = hashBuyerPassword(password, buyerAccount.password_salt);
        if (expectedHash !== buyerAccount.password_hash) {
          return fail(res, new Error('Username atau password pembeli salah.'), 401);
        }
        return ok(res, createSession(buyerAccount.username, 'buyer'));
      }

      if (password) {
        return fail(res, new Error('Akun pembeli tidak ditemukan. Silakan register terlebih dahulu.'), 404);
      }

      const buyerName = username || 'pembeli';
      return ok(res, createSession(buyerName, 'buyer'));
    }

    if (role === 'cashier') {
      const managedCashier = findManagedLoginAccount(username);
      if (managedCashier && managedCashier.role === 'cashier') {
        if (!managedCashier.is_active) {
          return fail(res, new Error('Akun dinonaktifkan oleh admin.'), 403);
        }
        const expectedHash = hashLoginPassword(password, managedCashier.password_salt);
        if (expectedHash !== managedCashier.password_hash) {
          return fail(res, new Error('Username atau password kasir salah.'), 401);
        }
        return ok(res, createSession(managedCashier.username, managedCashier.role, managedCashier.permissions));
      }

      if (username !== CASHIER_USERNAME || password !== CASHIER_PASSWORD) {
        return fail(res, new Error('Username atau password kasir salah.'), 401);
      }
      return ok(res, createSession(username, 'cashier'));
    }

    if (role === 'admin') {
      const managedAdmin = findManagedLoginAccount(username);
      if (managedAdmin && managedAdmin.role === 'admin') {
        if (!managedAdmin.is_active) {
          return fail(res, new Error('Akun dinonaktifkan oleh admin.'), 403);
        }
        const expectedHash = hashLoginPassword(password, managedAdmin.password_salt);
        if (expectedHash !== managedAdmin.password_hash) {
          return fail(res, new Error('Username atau password admin salah.'), 401);
        }
        return ok(res, createSession(managedAdmin.username, managedAdmin.role, managedAdmin.permissions));
      }

      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return fail(res, new Error('Username atau password admin salah.'), 401);
      }
      return ok(res, createSession(username, 'admin'));
    }

    return fail(res, new Error('Role login tidak dikenal. Gunakan auto, buyer, cashier, atau admin.'), 422);
  } catch (e) {
    fail(res, e, 500);
  }
});

app.post('/api/auth/register-buyer', (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const namaLengkap = String(body.nama_lengkap || body.nama || '').trim();
    const password = String(body.password || '');

    if (!username || !namaLengkap || !password) {
      return fail(res, new Error('username, nama_lengkap, dan password wajib diisi.'), 422);
    }

    const registered = createBuyerAccount({ username, namaLengkap, password });
    const session = createSession(registered.username, 'buyer');
    ok(res, {
      registered,
      session,
      message: 'Akun pembeli berhasil dibuat.',
    }, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/admin/accounts', requireAdmin, (req, res) => {
  try {
    ok(res, listManagedLoginAccounts());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/admin/accounts', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const account = createManagedLoginAccount({
      username: body.username,
      namaLengkap: body.nama_lengkap || body.nama,
      role: body.role,
      password: body.password,
      isActive: body.is_active,
      permissions: body.permissions,
    });
    ok(res, account, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.patch('/api/admin/accounts/:username', requireAdmin, (req, res) => {
  try {
    const account = updateManagedLoginAccount(req.params.username, req.body || {});
    ok(res, account);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseAuthToken(req);
  if (token) adminSessions.delete(token);
  ok(res, { logged_out: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return fail(res, new Error('Belum login.'), 401);
  }
  const capabilities = session.capabilities || getRoleCapabilities(session.role);
  ok(res, {
    username: session.username,
    role: session.role,
    capabilities,
    expires_at: new Date(session.expiresAt).toISOString(),
  });
});

app.get('/api/auth/capabilities', (req, res) => {
  const session = getSession(req);
  if (session && session.capabilities) {
    return ok(res, session.capabilities);
  }
  const role = session ? session.role : 'guest';
  ok(res, getRoleCapabilities(role));
});

app.post('/api/admin/login', (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return fail(res, new Error('Username atau password admin salah.'), 401);
    }

    ok(res, createSession(username, 'admin'));
  } catch (e) {
    fail(res, e, 500);
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseAuthToken(req);
  if (token) adminSessions.delete(token);
  ok(res, { logged_out: true });
});

app.get('/api/admin/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return fail(res, new Error('Belum login admin.'), 401);
  }
  if (session.role !== 'admin') {
    return fail(res, new Error('Bukan sesi admin.'), 403);
  }
  ok(res, {
    username: session.username,
    role: session.role,
    expires_at: new Date(session.expiresAt).toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  ok(res, { status: 'up', db: DB_PATH, date: today() });
});

app.get('/api/meta', (req, res) => {
  ok(res, {
    metode_bayar: METODE_BAYAR_WEB,
    kurir: KURIR_LIST,
    status: STATUS_LIST,
    platform_pembelian: PLATFORM_LIST,
    metode_bayar_pembelian: METODE_BAYAR_LIST,
  });
});

app.get('/api/features', (req, res) => {
  ok(res, {
    auth: [
      'POST /api/auth/login',
      'POST /api/auth/register-buyer',
      'POST /api/auth/logout',
      'GET /api/auth/me',
      'GET /api/auth/capabilities',
      'GET /api/admin/accounts',
      'POST /api/admin/accounts',
      'PATCH /api/admin/accounts/:username',
    ],
    website_order: [
      'GET /api/orders',
      'GET /api/orders/:nomor',
      'POST /api/orders',
      'POST /api/orders/:nomor/confirm',
      'POST /api/orders/:nomor/ship',
      'POST /api/orders/:nomor/deliver',
      'POST /api/orders/:nomor/cancel',
    ],
    kasir: [
      'POST /api/produk',
      'DELETE /api/produk/:kode',
      'POST /api/kasir/sales',
      'GET /api/kasir/piutang',
      'POST /api/kasir/piutang/:nomor/pay',
      'GET /api/kasir/piutang/:nomor/history',
    ],
    akuntansi: [
      'GET /api/akuntansi/akun',
      'POST /api/akuntansi/akun',
      'GET /api/akuntansi/jurnal',
      'POST /api/akuntansi/jurnal',
      'GET /api/akuntansi/buku-besar/:kode',
    ],
    penjualan: [
      'GET /api/penjualan/pelanggan',
      'POST /api/penjualan/pelanggan',
      'GET /api/penjualan/faktur',
      'POST /api/penjualan/faktur',
      'POST /api/penjualan/faktur/:nomor/post',
    ],
    pembelian: [
      'GET /api/pembelian/pemasok',
      'POST /api/pembelian/pemasok',
      'GET /api/pembelian/orders',
      'GET /api/pembelian/orders/:nomor',
      'POST /api/pembelian/orders',
      'POST /api/pembelian/orders/:nomor/post',
    ],
    laporan: [
      'GET /api/laporan/neraca-saldo',
      'GET /api/laporan/laba-rugi',
      'GET /api/laporan/neraca',
      'GET /api/laporan/rekap-penjualan',
      'GET /api/laporan/rekap-pembelian',
      'GET /api/laporan/rekap-penjualan-website',
    ],
  });
});

app.get('/api/produk', (req, res) => {
  try {
    ok(res, daftarProduk());
  } catch (e) {
    fail(res, e, 500);
  }
});

app.post('/api/produk', requireManageProduk, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.kode || !b.nama) {
      return fail(res, new Error('kode dan nama wajib diisi'), 422);
    }
    const data = tambahProduk({
      kode: String(b.kode).trim(),
      nama: String(b.nama).trim(),
      satuan: b.satuan || 'pcs',
      image_url: String(b.image_url || '').trim(),
      harga_jual: Number(b.harga_jual || 0),
      harga_beli: Number(b.harga_beli || 0),
      stok: Number(b.stok || 0),
    });
    ok(res, {
      ...data,
      ditambahkan_oleh: req.adminSession.username,
      role_penambah: req.adminSession.role,
    }, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.delete('/api/produk/:kode', requireManageProduk, (req, res) => {
  try {
    const kode = String(req.params.kode || '').trim();
    if (!kode) {
      return fail(res, new Error('kode produk wajib diisi'), 422);
    }
    hapusProduk(kode);
    ok(res, {
      kode,
      dihapus_oleh: req.adminSession.username,
      role_penghapus: req.adminSession.role,
    });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/kasir/sales', requireCashierSale, (req, res) => {
  try {
    const b = req.body || {};
    const detailInput = Array.isArray(b.detail) ? b.detail : [];
    if (detailInput.length === 0) {
      return fail(res, new Error('detail minimal 1 item wajib diisi'), 422);
    }

    const nomor = String(b.nomor || `KSR-${Date.now()}`).trim();
    const tanggal = b.tanggal || today();
    const namaPenerima = String(b.nama_penerima || 'Pelanggan Kasir').trim();
    const telepon = String(b.telepon_penerima || '').trim();
    const metodeInput = String(b.metode_bayar || 'Transfer').trim();
    const metodeLower = metodeInput.toLowerCase();
    const isHutang = metodeLower === 'hutang' || metodeLower === 'tempo';
    const metodeBayar = normalizeWebsitePaymentMethod(metodeInput);
    const jumlahBayarInput = Number(b.jumlah_bayar || 0);
    const kurir = b.kurir || 'Kasir';
    const nomorResi = b.nomor_resi || `KSR-RESI-${Date.now()}`;

    const detail = detailInput.map((d) => {
      const kodeProduk = String(d.kode_produk || '').trim();
      if (!kodeProduk) throw new Error('kode_produk wajib diisi di setiap item');

      const produk = cariProduk(kodeProduk);
      if (!produk) throw new Error(`Produk tidak ditemukan: ${kodeProduk}`);

      const qty = Number(d.qty || 0);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`Qty tidak valid untuk produk ${kodeProduk}`);
      }

      const hargaSatuan = d.harga_satuan === undefined ? Number(produk.harga_jual) : Number(d.harga_satuan);
      if (!Number.isFinite(hargaSatuan) || hargaSatuan < 0) {
        throw new Error(`Harga satuan tidak valid untuk produk ${kodeProduk}`);
      }

      return {
        kode_produk: kodeProduk,
        qty,
        harga_satuan: hargaSatuan,
        diskon_persen: Number(d.diskon_persen || 0),
      };
    });

    const order = buatOrderWebsite({
      nomor,
      tanggal,
      nama_penerima: namaPenerima,
      alamat_kirim: b.alamat_kirim || 'Kasir Langsung',
      telepon_penerima: telepon,
      kode_pelanggan: b.kode_pelanggan || null,
      metode_bayar: metodeBayar,
      ongkos_kirim: 0,
      voucher_kode: '',
      diskon_voucher: Number(b.diskon_voucher || 0),
      ppn_persen: Number(b.ppn_persen === undefined ? 11 : b.ppn_persen),
      detail,
    });

    konfirmasiOrderWebsite(nomor);
    if (!isHutang) {
      kirimOrderWebsite(nomor, kurir, nomorResi);
      terimaOrderWebsite(nomor, tanggal);
    }

    const currentOrder = detailOrderWebsite(nomor);
    const totalBayar = Number(currentOrder.total_bayar || 0);
    const jumlahBayar = Number.isFinite(jumlahBayarInput)
      ? Math.max(0, jumlahBayarInput)
      : 0;
    const dibayar = isHutang
      ? Math.min(jumlahBayar, totalBayar)
      : Math.max(jumlahBayar, totalBayar);
    const kembalian = isHutang ? 0 : Math.max(dibayar - totalBayar, 0);
    const sisaHutang = Math.max(totalBayar - dibayar, 0);
    const metodeDisplay = isHutang ? 'Hutang' : metodeBayar;

    const db = getConnection();
    db.prepare('UPDATE order_website SET jumlah_bayar=?, sisa_hutang=? WHERE nomor=?')
      .run(dibayar, sisaHutang, nomor);
    db.close();

    const finalOrder = detailOrderWebsite(nomor);

    ok(res, {
      nomor,
      status: finalOrder.status,
      metode_bayar: metodeDisplay,
      total_bayar: totalBayar,
      dibayar: Number(finalOrder.jumlah_bayar || dibayar || 0),
      kembalian,
      sisa_hutang: Number(finalOrder.sisa_hutang || sisaHutang || 0),
      kasir: req.adminSession.username,
      role: req.adminSession.role,
      order: finalOrder,
      created_order: order,
    }, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/kasir/piutang', requireCashierSale, (req, res) => {
  try {
    ok(res, daftarPiutangWebsite());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/kasir/piutang/:nomor/pay', requireCashierSale, (req, res) => {
  try {
    const nomor = String(req.params.nomor || '').trim();
    if (!nomor) {
      return fail(res, new Error('nomor order wajib diisi'), 422);
    }

    const b = req.body || {};
    const nominal = Number(b.jumlah_bayar || 0);
    const metodeBayar = String(b.metode_bayar || 'Transfer').trim() || 'Transfer';
    if (!Number.isFinite(nominal) || nominal <= 0) {
      return fail(res, new Error('jumlah_bayar harus lebih besar dari 0'), 422);
    }

    const data = bayarPiutangWebsite(nomor, nominal, b.tanggal || today(), metodeBayar);
    ok(res, {
      ...data,
      metode_bayar: metodeBayar,
      dicatat_oleh: req.adminSession.username,
      role: req.adminSession.role,
    });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/kasir/piutang/:nomor/history', requireCashierSale, (req, res) => {
  try {
    const nomor = String(req.params.nomor || '').trim();
    if (!nomor) {
      return fail(res, new Error('nomor order wajib diisi'), 422);
    }
    ok(res, riwayatPiutangWebsite(nomor));
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/orders', (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    ok(res, daftarOrderWebsite(status));
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/orders/:nomor', (req, res) => {
  try {
    ok(res, detailOrderWebsite(req.params.nomor));
  } catch (e) {
    fail(res, e, 404);
  }
});

app.post('/api/orders', requireCreateOrder, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.nomor || !Array.isArray(b.detail) || b.detail.length === 0) {
      return fail(res, new Error('nomor dan detail minimal 1 item wajib diisi'), 422);
    }

    const userRole = req.adminSession.role;
    if (!['buyer', 'cashier', 'admin'].includes(userRole)) {
      return fail(res, new Error('Role akun tidak boleh membuat order.'), 403);
    }

    const order = buatOrderWebsite({
      nomor: String(b.nomor).trim(),
      tanggal: b.tanggal || today(),
      nama_penerima: b.nama_penerima || 'Pelanggan Website',
      alamat_kirim: b.alamat_kirim || '-',
      telepon_penerima: b.telepon_penerima || '',
      kode_pelanggan: b.kode_pelanggan || null,
      metode_bayar: normalizeWebsitePaymentMethod(b.metode_bayar || 'Transfer'),
      ongkos_kirim: Number(b.ongkos_kirim || 0),
      voucher_kode: b.voucher_kode || '',
      diskon_voucher: Number(b.diskon_voucher || 0),
      ppn_persen: Number(b.ppn_persen === undefined ? 11 : b.ppn_persen),
      detail: b.detail.map((d) => ({
        kode_produk: d.kode_produk,
        qty: Number(d.qty),
        harga_satuan: Number(d.harga_satuan),
        diskon_persen: Number(d.diskon_persen || 0),
      })),
    });

    ok(res, { ...order, dibuat_oleh: req.adminSession.username, role_pembuat: userRole }, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/orders/:nomor/confirm', requireProcessOrder, (req, res) => {
  try {
    konfirmasiOrderWebsite(req.params.nomor);
    ok(res, { nomor: req.params.nomor, status: 'CONFIRMED' });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/orders/:nomor/ship', requireProcessOrder, (req, res) => {
  try {
    const b = req.body || {};
    const kurir = b.kurir || 'JNE';
    const nomorResi = b.nomor_resi || `RESI-${Date.now()}`;
    kirimOrderWebsite(req.params.nomor, kurir, nomorResi);
    ok(res, { nomor: req.params.nomor, status: 'SHIPPED', kurir, nomor_resi: nomorResi });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/orders/:nomor/deliver', requireProcessOrder, (req, res) => {
  try {
    const b = req.body || {};
    const tanggal = b.tanggal || today();
    terimaOrderWebsite(req.params.nomor, tanggal);
    ok(res, { nomor: req.params.nomor, status: 'DELIVERED', tanggal });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/orders/:nomor/cancel', requireProcessOrder, (req, res) => {
  try {
    const b = req.body || {};
    const tanggal = b.tanggal || today();
    batalkanOrderWebsite(req.params.nomor, tanggal);
    ok(res, { nomor: req.params.nomor, status: 'CANCELLED', tanggal });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/akuntansi/akun', (req, res) => {
  try {
    ok(res, daftarAkun());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/akuntansi/akun', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const kode = String(b.kode || '').trim();
    const nama = String(b.nama || '').trim();
    const jenis = String(b.jenis || '').trim();
    const saldoNormal = String(b.saldo_normal || '').trim();

    if (!kode || !nama || !jenis || !saldoNormal) {
      return fail(res, new Error('kode, nama, jenis, dan saldo_normal wajib diisi'), 422);
    }

    const allowedJenis = new Set(['Aset', 'Kewajiban', 'Ekuitas', 'Pendapatan', 'Beban']);
    const allowedSaldo = new Set(['Debit', 'Kredit']);
    if (!allowedJenis.has(jenis)) {
      return fail(res, new Error('jenis akun tidak valid'), 422);
    }
    if (!allowedSaldo.has(saldoNormal)) {
      return fail(res, new Error('saldo_normal harus Debit atau Kredit'), 422);
    }

    const akun = tambahAkun(kode, nama, jenis, saldoNormal);
    ok(res, akun, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/akuntansi/jurnal', (req, res) => {
  try {
    ok(res, daftarJurnal());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/akuntansi/jurnal', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const detailInput = Array.isArray(b.detail) ? b.detail : [];
    if (!b.nomor_bukti || !detailInput.length) {
      return fail(res, new Error('nomor_bukti dan detail jurnal minimal 1 baris wajib diisi'), 422);
    }

    for (const row of detailInput) {
      const kodeAkun = String(row.kode_akun || '').trim();
      if (!kodeAkun || !cariAkun(kodeAkun)) {
        return fail(res, new Error(`kode akun tidak ditemukan: ${kodeAkun || '-'}`), 422);
      }
    }

    const jurnal = catatJurnal({
      tanggal: b.tanggal || today(),
      nomor_bukti: String(b.nomor_bukti || '').trim(),
      keterangan: String(b.keterangan || '').trim(),
      detail: detailInput.map((d) => ({
        kode_akun: String(d.kode_akun || '').trim(),
        debit: Number(d.debit || 0),
        kredit: Number(d.kredit || 0),
      })),
    });
    ok(res, jurnal, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/akuntansi/buku-besar/:kode', (req, res) => {
  try {
    ok(res, bukuBesar(req.params.kode));
  } catch (e) {
    fail(res, e, 404);
  }
});

app.get('/api/penjualan/pelanggan', (req, res) => {
  try {
    ok(res, daftarPelanggan());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/penjualan/pelanggan', requireCashierSale, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.kode || !b.nama) {
      return fail(res, new Error('kode dan nama pelanggan wajib diisi'), 422);
    }
    const pelanggan = tambahPelanggan({
      kode: String(b.kode).trim(),
      nama: String(b.nama).trim(),
      alamat: String(b.alamat || '').trim(),
      telepon: String(b.telepon || '').trim(),
      email: String(b.email || '').trim(),
    });
    ok(res, pelanggan, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/penjualan/faktur', (req, res) => {
  try {
    ok(res, daftarFaktur());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/penjualan/faktur', requireCashierSale, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.nomor || !Array.isArray(b.detail) || b.detail.length === 0) {
      return fail(res, new Error('nomor dan detail faktur minimal 1 item wajib diisi'), 422);
    }
    const faktur = buatFaktur({
      nomor: String(b.nomor).trim(),
      tanggal: b.tanggal || today(),
      kode_pelanggan: b.kode_pelanggan || null,
      ppn_persen: Number(b.ppn_persen === undefined ? 11 : b.ppn_persen),
      detail: b.detail.map((d) => ({
        kode_produk: String(d.kode_produk || '').trim(),
        qty: Number(d.qty || 0),
        harga_satuan: Number(d.harga_satuan || 0),
        diskon_persen: Number(d.diskon_persen || 0),
      })),
    });
    ok(res, faktur, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/penjualan/faktur/:nomor/post', requireCashierSale, (req, res) => {
  try {
    postingFaktur(req.params.nomor);
    ok(res, { nomor: req.params.nomor, status: 'POSTED' });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/pembelian/pemasok', (req, res) => {
  try {
    ok(res, daftarPemasok());
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/pembelian/pemasok', requireCashierSale, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.kode || !b.nama) {
      return fail(res, new Error('kode dan nama pemasok wajib diisi'), 422);
    }
    const pemasok = tambahPemasok({
      kode: String(b.kode).trim(),
      nama: String(b.nama).trim(),
      platform: String(b.platform || 'Manual').trim(),
      alamat: String(b.alamat || '').trim(),
      telepon: String(b.telepon || '').trim(),
      email: String(b.email || '').trim(),
    });
    ok(res, pemasok, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/pembelian/orders', (req, res) => {
  try {
    ok(res, daftarOrder());
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/pembelian/orders/:nomor', (req, res) => {
  try {
    ok(res, detailOrder(req.params.nomor));
  } catch (e) {
    fail(res, e, 404);
  }
});

app.post('/api/pembelian/orders', requireCashierSale, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.nomor || !Array.isArray(b.detail) || b.detail.length === 0) {
      return fail(res, new Error('nomor dan detail order pembelian minimal 1 item wajib diisi'), 422);
    }
    const order = buatOrder({
      nomor: String(b.nomor).trim(),
      tanggal: b.tanggal || today(),
      platform: b.platform || 'Manual',
      nomor_platform: b.nomor_platform || '',
      kode_pemasok: b.kode_pemasok || null,
      metode_bayar: b.metode_bayar || 'Transfer',
      ongkos_kirim: Number(b.ongkos_kirim || 0),
      diskon: Number(b.diskon || 0),
      detail: b.detail.map((d) => ({
        kode_produk: String(d.kode_produk || '').trim(),
        qty: Number(d.qty || 0),
        harga_satuan: Number(d.harga_satuan || 0),
      })),
    });
    ok(res, order, 201);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/pembelian/orders/:nomor/post', requireCashierSale, (req, res) => {
  try {
    postingOrder(req.params.nomor);
    ok(res, { nomor: req.params.nomor, status: 'POSTED' });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/neraca-saldo', (req, res) => {
  try {
    ok(res, neracaSaldo());
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/laba-rugi', (req, res) => {
  try {
    ok(res, laporanLabaRugi());
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/neraca', (req, res) => {
  try {
    ok(res, neraca());
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/rekap-penjualan', (req, res) => {
  try {
    ok(res, rekapPenjualan(getDateRangeQuery(req)));
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/rekap-pembelian', (req, res) => {
  try {
    ok(res, rekapPembelian(getDateRangeQuery(req)));
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/laporan/rekap-penjualan-website', (req, res) => {
  try {
    ok(res, rekapPenjualanWebsite(getDateRangeQuery(req)));
  } catch (e) {
    fail(res, e);
  }
});

app.use((err, req, res, next) => {
  fail(res, err, 500);
});

function start() {
  initDatabase();
  setupAkunDefault();
  ensureDemoProducts();

  app.listen(PORT, () => {
    console.log(`SAGARA web test server aktif di http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`Admin default: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    console.log(`Kasir default: ${CASHIER_USERNAME} / ${CASHIER_PASSWORD}`);
    console.log('Pembeli: pilih role buyer (tanpa password).');
  });
}

start();
