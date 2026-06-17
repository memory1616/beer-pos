const express = require('express');
const router = express.Router();
const db = require('../../database');

// GET /api/settings - Get all settings
router.get('/', (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings - Update setting(s)
router.post('/', (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Missing key or value' });
    }

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, String(value));

    res.json({ success: true, key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SPECIFIC ROUTES MUST COME BEFORE /:key ──────────────────────

// GET /api/settings/delivery-cost - Calculate delivery cost
router.get('/delivery-cost', (req, res) => {
  try {
    const { customerLat, customerLng } = req.query;

    if (!customerLat || !customerLng) {
      return res.status(400).json({ error: 'Missing customerLat or customerLng' });
    }

    const costPerKm = db.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_cost_per_km');
    const baseCost = db.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_base_cost');
    const distLat = db.prepare('SELECT value FROM settings WHERE key = ?').get('distributor_lat');
    const distLng = db.prepare('SELECT value FROM settings WHERE key = ?').get('distributor_lng');

    const perKm = costPerKm ? parseFloat(costPerKm.value) : 3000;
    const base = baseCost ? parseFloat(baseCost.value) : 0;
    const dLat = distLat ? parseFloat(distLat.value) : 10.8231;
    const dLng = distLng ? parseFloat(distLng.value) : 106.6297;

    const distance = calculateDistance(dLat, dLng, parseFloat(customerLat), parseFloat(customerLng));
    const cost = Math.round(base + (distance * perKm));

    res.json({
      distance: Math.round(distance * 10) / 10,
      costPerKm: perKm,
      baseCost: base,
      totalCost: cost
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/batch - Update multiple settings
router.post('/batch', (req, res) => {
  try {
    const settings = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings object' });
    }

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    Object.entries(settings).forEach(([key, value]) => {
      stmt.run(key, String(value));
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── QR CONFIG SETTINGS ─────────────────────────────────────────

// GET /api/settings/qr-config - Get QR configuration
router.get('/qr-config', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('qr%');
    const config = {
      qrAccountNo: '',
      qrAccountName: '',
      qrBankCode: 'ICB',
      qrDefaultContent: 'Thanh toan HD {invoice_id}',
      qrTemplate: 'compact2'
    };

    rows.forEach(row => {
      const key = row.key;
      if (key === 'qr_account_no') config.qrAccountNo = row.value;
      else if (key === 'qr_account_name') config.qrAccountName = row.value;
      else if (key === 'qr_bank_code') config.qrBankCode = row.value;
      else if (key === 'qr_default_content') config.qrDefaultContent = row.value;
      else if (key === 'qr_template') config.qrTemplate = row.value;
    });

    res.json(config);
  } catch (err) {
    console.error('Error getting QR config:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/qr-config - Save QR configuration
router.post('/qr-config', (req, res) => {
  try {
    const { qrAccountNo, qrAccountName, qrBankCode, qrDefaultContent, qrTemplate } = req.body;

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    if (qrAccountNo !== undefined) {
      stmt.run('qr_account_no', String(qrAccountNo).trim());
    }
    if (qrAccountName !== undefined) {
      stmt.run('qr_account_name', String(qrAccountName).trim().toUpperCase());
    }
    if (qrBankCode !== undefined) {
      stmt.run('qr_bank_code', String(qrBankCode).trim().toUpperCase());
    }
    if (qrDefaultContent !== undefined) {
      stmt.run('qr_default_content', String(qrDefaultContent).trim());
    }
    if (qrTemplate !== undefined) {
      stmt.run('qr_template', String(qrTemplate).trim());
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving QR config:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── QR ACCOUNTS POOL ────────────────────────────────────────────────────────

// GET /api/settings/qr-accounts - List tất cả (kể cả inactive) cho admin
router.get('/qr-accounts', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, label, bank_code, account_no, account_name, template,
             default_content, weight, active, sort_order, created_at, updated_at
      FROM qr_accounts
      ORDER BY active DESC, sort_order ASC, id ASC
    `).all();
    res.json(rows);
  } catch (err) {
    console.error('Error listing QR accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/qr-accounts/active - List chỉ active=1 cho POS
router.get('/qr-accounts/active', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, label, bank_code, account_no, account_name, template,
             default_content, weight, active, sort_order
      FROM qr_accounts
      WHERE active = 1
      ORDER BY sort_order ASC, id ASC
    `).all();
    res.json(rows);
  } catch (err) {
    console.error('Error listing active QR accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/qr-accounts/:id - Lấy 1 row
router.get('/qr-accounts/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM qr_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'QR account not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function validateQRAccount(data) {
  const errors = [];
  if (!data.label || !String(data.label).trim()) errors.push('label is required');
  if (!data.bank_code || !/^[A-Za-z]{2,10}$/.test(String(data.bank_code).trim())) {
    errors.push('bank_code must be 2-10 letters');
  }
  if (!data.account_no || !/^\d{4,20}$/.test(String(data.account_no).trim())) {
    errors.push('account_no must be 4-20 digits');
  }
  if (!data.account_name || String(data.account_name).trim().length < 2) {
    errors.push('account_name is required (min 2 chars)');
  }
  if (data.template && !['compact2', 'exact', 'qr_only'].includes(String(data.template))) {
    errors.push('template must be compact2, exact, or qr_only');
  }
  if (data.weight !== undefined && data.weight !== null) {
    const w = parseInt(data.weight);
    if (isNaN(w) || w < 0) errors.push('weight must be integer >= 0');
  }
  return errors;
}

function sanitizeQRAccount(data) {
  return {
    label: String(data.label).trim(),
    bank_code: String(data.bank_code).trim().toUpperCase(),
    account_no: String(data.account_no).trim(),
    account_name: String(data.account_name).trim().toUpperCase(),
    template: data.template ? String(data.template).trim() : 'compact2',
    default_content: data.default_content ? String(data.default_content).trim() : 'Thanh toan HD {invoice_id}',
    weight: data.weight !== undefined && data.weight !== null ? parseInt(data.weight) : 1,
    active: data.active === undefined || data.active === null ? 1 : (data.active ? 1 : 0)
  };
}

// POST /api/settings/qr-accounts - Tạo mới
router.post('/qr-accounts', (req, res) => {
  try {
    const errors = validateQRAccount(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const data = sanitizeQRAccount(req.body);
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM qr_accounts').get().m;

    const result = db.prepare(`
      INSERT INTO qr_accounts (label, bank_code, account_no, account_name, template, default_content, weight, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.label, data.bank_code, data.account_no, data.account_name,
      data.template, data.default_content, data.weight, data.active,
      maxSort + 1
    );

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Error creating QR account:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/qr-accounts/:id - Cập nhật
router.put('/qr-accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const existing = db.prepare('SELECT id FROM qr_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'QR account not found' });

    const errors = validateQRAccount(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const data = sanitizeQRAccount(req.body);
    db.prepare(`
      UPDATE qr_accounts
      SET label = ?, bank_code = ?, account_no = ?, account_name = ?,
          template = ?, default_content = ?, weight = ?, active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.label, data.bank_code, data.account_no, data.account_name,
      data.template, data.default_content, data.weight, data.active,
      id
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating QR account:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/qr-accounts/:id - Xoá cứng
router.delete('/qr-accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const result = db.prepare('DELETE FROM qr_accounts WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'QR account not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting QR account:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/qr-accounts/reorder - Cập nhật sort_order
router.post('/qr-accounts/reorder', (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

    const stmt = db.prepare('UPDATE qr_accounts SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const tx = db.transaction((arr) => {
      arr.forEach((it, idx) => {
        const id = parseInt(it.id);
        if (isNaN(id)) return;
        stmt.run(idx + 1, id);
      });
    });
    tx(items);

    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering QR accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/qr-accounts/:id/toggle - Bật/tắt nhanh
router.post('/qr-accounts/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const result = db.prepare(`
      UPDATE qr_accounts
      SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    if (result.changes === 0) return res.status(404).json({ error: 'QR account not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GENERIC ROUTE - MUST BE LAST ───────────────────────────────

// GET /api/settings/:key - Get specific setting
router.get('/:key', (req, res) => {
  try {
    const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ key: setting.key, value: setting.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
