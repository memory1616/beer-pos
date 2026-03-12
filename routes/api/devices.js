const express = require('express');
const router = express.Router();
const db = require('../../database');

// Sanitize input
function sanitizeInput(input) {
  if (typeof input === 'string') {
    return input.replace(/[<>'"]/g, '').trim();
  }
  return input;
}

// Validate ID
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

// GET /api/devices - List all devices
router.get('/', (req, res) => {
  try {
    const { status, type, customer_id } = req.query;
    
    let query = `
      SELECT d.*, c.name as customer_name 
      FROM devices d 
      LEFT JOIN customers c ON d.customer_id = c.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      query += ' AND d.status = ?';
      params.push(status);
    }
    if (type) {
      query += ' AND d.type = ?';
      params.push(type);
    }
    if (customer_id) {
      query += ' AND d.customer_id = ?';
      params.push(customer_id);
    }
    
    query += ' ORDER BY d.created_at DESC';
    
    const devices = db.prepare(query).all(...params);
    res.json(devices);
  } catch (err) {
    console.error('Error fetching devices:', err);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách thiết bị' });
  }
});

// GET /api/devices/:id - Get device by ID
router.get('/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID không hợp lệ' });
    
    const device = db.prepare(`
      SELECT d.*, c.name as customer_name 
      FROM devices d 
      LEFT JOIN customers c ON d.customer_id = c.id
      WHERE d.id = ?
    `).get(id);
    
    if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị' });
    res.json(device);
  } catch (err) {
    console.error('Error fetching device:', err);
    res.status(500).json({ error: 'Lỗi khi lấy thiết bị' });
  }
});

// POST /api/devices - Create new device
router.post('/', (req, res) => {
  try {
    const { name, type, serial_number, status, customer_id, note } = req.body;
    
    if (!name || !type) {
      return res.status(400).json({ error: 'Tên và loại thiết bị là bắt buộc' });
    }
    
    if (!['horizontal', 'vertical'].includes(type)) {
      return res.status(400).json({ error: 'Loại thiết bị không hợp lệ (horizontal/vertical)' });
    }
    
    const sanitizedName = sanitizeInput(name);
    const sanitizedSerial = serial_number ? sanitizeInput(serial_number) : null;
    const sanitizedNote = note ? sanitizeInput(note) : null;
    const sanitizedStatus = status || 'available';
    const sanitizedCustomerId = customer_id ? validateId(customer_id) : null;
    
    // Validate customer_id if provided
    if (sanitizedCustomerId) {
      const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(sanitizedCustomerId);
      if (!customer) {
        return res.status(400).json({ error: 'Khách hàng không tồn tại' });
      }
    }
    
    const result = db.prepare(`
      INSERT INTO devices (name, type, serial_number, status, customer_id, assigned_date, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizedName,
      type,
      sanitizedSerial,
      sanitizedStatus,
      sanitizedCustomerId,
      sanitizedCustomerId ? new Date().toISOString() : null,
      sanitizedNote
    );
    
    res.status(201).json({ 
      id: result.lastInsertRowid, 
      message: 'Thêm thiết bị thành công' 
    });
  } catch (err) {
    console.error('Error creating device:', err);
    res.status(500).json({ error: 'Lỗi khi thêm thiết bị' });
  }
});

// PUT /api/devices/:id - Update device
router.put('/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID không hợp lệ' });
    
    const { name, type, serial_number, status, customer_id, note } = req.body;
    
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị' });
    
    const sanitizedName = name ? sanitizeInput(name) : device.name;
    const sanitizedType = type && ['horizontal', 'vertical'].includes(type) ? type : device.type;
    const sanitizedSerial = serial_number !== undefined ? sanitizeInput(serial_number) : device.serial_number;
    const sanitizedStatus = status && ['available', 'in_use', 'maintenance'].includes(status) ? status : device.status;
    const sanitizedNote = note !== undefined ? sanitizeInput(note) : device.note;
    
    let sanitizedCustomerId = device.customer_id;
    let assignedDate = device.assigned_date;
    
    if (customer_id !== undefined) {
      if (customer_id === null) {
        sanitizedCustomerId = null;
        assignedDate = null;
      } else {
        const parsedCustomerId = validateId(customer_id);
        if (parsedCustomerId) {
          const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(parsedCustomerId);
          if (!customer) {
            return res.status(400).json({ error: 'Khách hàng không tồn tại' });
          }
          sanitizedCustomerId = parsedCustomerId;
          // Set assigned date if newly assigned
          if (!device.customer_id) {
            assignedDate = new Date().toISOString();
          }
        }
      }
    }
    
    db.prepare(`
      UPDATE devices 
      SET name = ?, type = ?, serial_number = ?, status = ?, 
          customer_id = ?, assigned_date = ?, note = ?
      WHERE id = ?
    `).run(
      sanitizedName,
      sanitizedType,
      sanitizedSerial,
      sanitizedStatus,
      sanitizedCustomerId,
      assignedDate,
      sanitizedNote,
      id
    );
    
    res.json({ message: 'Cập nhật thiết bị thành công' });
  } catch (err) {
    console.error('Error updating device:', err);
    res.status(500).json({ error: 'Lỗi khi cập nhật thiết bị' });
  }
});

// DELETE /api/devices/:id - Delete device
router.delete('/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID không hợp lệ' });
    
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị' });
    
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    
    res.json({ message: 'Xóa thiết bị thành công' });
  } catch (err) {
    console.error('Error deleting device:', err);
    res.status(500).json({ error: 'Lỗi khi xóa thiết bị' });
  }
});

// POST /api/devices/:id/assign - Assign device to customer
router.post('/:id/assign', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID không hợp lệ' });
    
    const { customer_id } = req.body;
    
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Không tìm thấy thiết bị' });
    
    if (customer_id === null) {
      // Unassign
      db.prepare(`
        UPDATE devices SET customer_id = NULL, assigned_date = NULL, status = 'available' WHERE id = ?
      `).run(id);
      res.json({ message: 'Đã hủy gán thiết bị' });
      return;
    }
    
    const parsedCustomerId = validateId(customer_id);
    if (!parsedCustomerId) return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
    
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(parsedCustomerId);
    if (!customer) return res.status(400).json({ error: 'Khách hàng không tồn tại' });
    
    db.prepare(`
      UPDATE devices SET customer_id = ?, assigned_date = ?, status = 'in_use' WHERE id = ?
    `).run(parsedCustomerId, new Date().toISOString(), id);
    
    res.json({ message: 'Đã gán thiết bị cho khách hàng' });
  } catch (err) {
    console.error('Error assigning device:', err);
    res.status(500).json({ error: 'Lỗi khi gán thiết bị' });
  }
});

// GET /api/devices/stats - Get device statistics
router.get('/stats/summary', (req, res) => {
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END) as in_use,
        SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) as maintenance,
        SUM(CASE WHEN type = 'horizontal' THEN 1 ELSE 0 END) as horizontal,
        SUM(CASE WHEN type = 'vertical' THEN 1 ELSE 0 END) as vertical
      FROM devices
    `).get();
    
    res.json(stats);
  } catch (err) {
    console.error('Error fetching device stats:', err);
    res.status(500).json({ error: 'Lỗi khi lấy thống kê thiết bị' });
  }
});

module.exports = router;
