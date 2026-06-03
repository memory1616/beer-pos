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
