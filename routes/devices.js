const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

// GET /devices - Serve devices page
router.get('/', (req, res, next) => {
  res.sendFile(require('path').join(__dirname, '../views', 'devices.html'));
});

// GET /devices/summary - Get devices summary data (used by devices.html page)
router.get('/summary', (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT 
        id, name, phone,
        COALESCE(horizontal_fridge, 0) as horizontal_fridge,
        COALESCE(vertical_fridge, 0) as vertical_fridge
      FROM customers 
      WHERE horizontal_fridge > 0 OR vertical_fridge > 0
      ORDER BY name
    `).all();

    const availableDevices = db.prepare(`
      SELECT type, COUNT(*) as count 
      FROM devices 
      WHERE status = 'available' 
      GROUP BY type
    `).all();

    const availableHorizontal = availableDevices.find(d => d.type === 'horizontal')?.count || 0;
    const availableVertical = availableDevices.find(d => d.type === 'vertical')?.count || 0;

    res.json({
      customers,
      availableHorizontal,
      availableVertical
    });
  } catch (err) {
    logger.error('GET /devices/summary error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /devices - Add new device
router.post('/', (req, res) => {
  const { type, quantity, serial, name } = req.body;

  if (!type || !quantity) {
    return res.json({ success: false, message: 'Thiếu thông tin' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO devices (name, type, serial_number, status, created_at) 
      VALUES (?, ?, ?, 'available', datetime('now'))
    `);

    const baseName = name || `Tủ ${type === 'horizontal' ? 'Nằm' : 'Đứng'}`;

    for (let i = 0; i < quantity; i++) {
      const serialNumber = serial ? (quantity > 1 ? `${serial}-${i + 1}` : serial) : null;
      const deviceName = quantity > 1 ? `${baseName} #${i + 1}` : baseName;
      stmt.run(deviceName, type, serialNumber);
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST /devices/adjust - Adjust inventory
router.post('/adjust', (req, res) => {
  const { horizontal, vertical } = req.body;

  try {
    const currentHorizontal = db.prepare(`SELECT COUNT(*) as count FROM devices WHERE type = 'horizontal' AND status = 'available'`).get().count;
    const currentVertical = db.prepare(`SELECT COUNT(*) as count FROM devices WHERE type = 'vertical' AND status = 'available'`).get().count;

    if (horizontal !== currentHorizontal) {
      if (horizontal > currentHorizontal) {
        const toAdd = horizontal - currentHorizontal;
        const stmt = db.prepare(`INSERT INTO devices (name, type, status) VALUES (?, 'horizontal', 'available')`);
        for (let i = 0; i < toAdd; i++) {
          stmt.run(`Tủ Nằm ${currentHorizontal + i + 1}`);
        }
      } else {
        const toRemove = currentHorizontal - horizontal;
        db.prepare(`DELETE FROM devices WHERE type = 'horizontal' AND status = 'available' ORDER BY id LIMIT ?`).run(toRemove);
      }
    }

    if (vertical !== currentVertical) {
      if (vertical > currentVertical) {
        const toAdd = vertical - currentVertical;
        const stmt = db.prepare(`INSERT INTO devices (name, type, status) VALUES (?, 'vertical', 'available')`);
        for (let i = 0; i < toAdd; i++) {
          stmt.run(`Tủ Đứng ${currentVertical + i + 1}`);
        }
      } else {
        const toRemove = currentVertical - vertical;
        db.prepare(`DELETE FROM devices WHERE type = 'vertical' AND status = 'available' ORDER BY id LIMIT ?`).run(toRemove);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;