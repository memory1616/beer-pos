const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const socketServer = require('../../src/socket/socketServer');

// Expense type mapping
const EXPENSE_TYPES = {
  'Xăng dầu': 'fuel',
  'Khấu hao': 'fuel',
  'Hư hỏng': 'repair',
  'Điện nước': 'other',
  'Nhân công': 'food',
  'Thuê mặt bằng': 'other',
  'Bảo trì': 'repair',
  'Marketing': 'other',
  'Khác': 'other'
};

const TYPE_ICONS = {
  'fuel': '⛽',
  'food': '🍜',
  'repair': '🔧',
  'other': '📦'
};

// Get all expenses (exclude archived)
router.get('/', (req, res) => {
  try {
    const { startDate, endDate, category } = req.query;

    let sql = 'SELECT * FROM expenses WHERE archived = 0';
    const params = [];
    
    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    
    sql += ' ORDER BY date DESC, time DESC, id DESC';
    
    const expenses = db.prepare(sql).all(...params);
    res.json(expenses);
  } catch (err) {
    logger.error('Error fetching expenses', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// Get today's expenses by type
router.get('/today', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get all expenses today
    const expenses = db.prepare(`
      SELECT * FROM expenses WHERE date = ? ORDER BY time DESC
    `).all(today);
    
    // Group by type
    const byType = {
      fuel: { total: 0, items: [] },
      food: { total: 0, items: [] },
      repair: { total: 0, items: [] },
      other: { total: 0, items: [] }
    };
    
    let total = 0;
    expenses.forEach(e => {
      const type = e.type || 'other';
      if (byType[type]) {
        byType[type].total += e.amount;
        byType[type].items.push(e);
      }
      total += e.amount;
    });
    
    res.json({
      date: today,
      total: total,
      byType: byType,
      expenses: expenses
    });
  } catch (err) {
    logger.error('Error fetching today expenses', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch today expenses' });
  }
});

// Get expense summary by category (exclude archived)
router.get('/summary', (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let sql = `
      SELECT category, type, SUM(amount) as total
      FROM expenses
      WHERE archived = 0
    `;
    const params = [];
    
    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }
    
    sql += ' GROUP BY category ORDER BY total DESC';
    
    const summary = db.prepare(sql).all(...params);
    res.json(summary);
  } catch (err) {
    logger.error('Error fetching expense summary', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch expense summary' });
  }
});

// Get total expenses in date range (exclude archived)
router.get('/total', (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    let sql = 'SELECT SUM(amount) as total FROM expenses WHERE archived = 0';
    const params = [];
    
    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }
    
    const result = db.prepare(sql).get(...params);
    res.json({ total: result.total || 0 });
  } catch (err) {
    logger.error('Error fetching total expenses', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch total expenses' });
  }
});

// Get expense by ID
router.get('/:id', (req, res) => {
  try {
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.json(expense);
  } catch (err) {
    logger.error('Error fetching expense', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch expense' });
  }
});

// Create new expense
router.post('/', (req, res) => {
  try {
    const { category, amount, description, date, type, km, order_id, is_auto } = req.body;
    
    logger.debug('Create expense', { category, amount, type });
    
    // STEP 6 - Input Validation
    if (!category || !amount) {
      return res.status(400).json({ error: 'Category and amount are required' });
    }
    
    // Validate amount - prevent NaN, negative, zero
    const validatedAmount = Number(amount);
    if (isNaN(validatedAmount) || validatedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    
    // Validate quantity (km) if provided
    let validatedKm = null;
    if (km !== undefined && km !== null && km !== '') {
      validatedKm = Number(km);
      if (isNaN(validatedKm) || validatedKm < 0) {
        return res.status(400).json({ error: 'KM must be a non-negative number' });
      }
    }
    
    // Determine type from category if not provided
    const expenseType = type || EXPENSE_TYPES[category] || 'other';
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const time = String(vnNow.getUTCHours()).padStart(2, '0') + ':' + String(vnNow.getUTCMinutes()).padStart(2, '0');
    const expenseDate = date || (vnNow.getUTCFullYear() + '-' + String(vnNow.getUTCMonth() + 1).padStart(2, '0') + '-' + String(vnNow.getUTCDate()).padStart(2, '0'));
    
    const result = db.prepare(`
      INSERT INTO expenses (category, type, amount, description, date, time, km, order_id, is_auto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      category,
      expenseType,
      validatedAmount,
      description || null,
      expenseDate,
      time,
      validatedKm,
      order_id || null,
      is_auto ? 1 : 0
    );
    
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
    socketServer.emitExpense('created', expense);
    res.status(201).json(expense);
  } catch (err) {
    logger.error('Error creating expense', { error: err.message });
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// Quick add expense (Xăng/Ăn/Sửa)
router.post('/quick', (req, res) => {
  try {
    const { expenseType, amount, note, km } = req.body;
    
    logger.debug('Quick add expense', { expenseType, amount });
    
    // STEP 6 - Input Validation
    if (!expenseType || !amount) {
      return res.status(400).json({ error: 'expenseType and amount are required' });
    }
    
    // Validate amount - prevent NaN, negative, zero
    const validatedAmount = Number(amount);
    if (isNaN(validatedAmount) || validatedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    
    // Validate km if provided
    let validatedKm = null;
    if (km !== undefined && km !== null && km !== '') {
      validatedKm = Number(km);
      if (isNaN(validatedKm) || validatedKm < 0) {
        return res.status(400).json({ error: 'KM must be a non-negative number' });
      }
    }
    
    // Map type to category
    const categoryMap = {
      'fuel': 'Xăng dầu',
      'food': 'Nhân công',
      'repair': 'Hư hỏng',
      'other': 'Khác'
    };
    
    const category = categoryMap[expenseType] || 'Khác';
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const time = String(vnNow.getUTCHours()).padStart(2, '0') + ':' + String(vnNow.getUTCMinutes()).padStart(2, '0');
    const date = vnNow.getUTCFullYear() + '-' + String(vnNow.getUTCMonth() + 1).padStart(2, '0') + '-' + String(vnNow.getUTCDate()).padStart(2, '0');
    
    const result = db.prepare(`
      INSERT INTO expenses (category, type, amount, description, date, time, km, is_auto)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      category,
      expenseType,
      validatedAmount,
      note || null,
      date,
      time,
      validatedKm
    );
    
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
    socketServer.emitExpense('created', expense);
    res.status(201).json(expense);
  } catch (err) {
    logger.error('Error quick adding expense', { error: err.message });
    res.status(500).json({ error: 'Failed to quick add expense' });
  }
});

// Update expense
router.put('/:id', (req, res) => {
  try {
    const { category, amount, description, date, type, km, order_id, is_auto } = req.body;
    const { id } = req.params;
    
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    
    db.prepare(`
      UPDATE expenses
      SET category = ?, type = ?, amount = ?, description = ?, date = ?, km = ?, order_id = ?, is_auto = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      category || existing.category,
      type || existing.type,
      amount || existing.amount,
      description !== undefined ? description : existing.description,
      date || existing.date,
      km !== undefined ? km : existing.km,
      order_id !== undefined ? order_id : existing.order_id,
      is_auto !== undefined ? (is_auto ? 1 : 0) : existing.is_auto,
      id
    );
    
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    socketServer.emitExpense('updated', expense);
    res.json(expense);
  } catch (err) {
    logger.error('Error updating expense', { error: err.message });
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// Delete expense (soft delete)
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    // Soft delete: set archived = 1 instead of hard delete
    db.prepare('UPDATE expenses SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    socketServer.emitExpense('deleted', { ...existing, archived: 1 });
    res.json({ success: true, message: 'Đã xóa chi phí (có thể khôi phục)', archived: true });
  } catch (err) {
    logger.error('Error soft deleting expense', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi xóa chi phí' });
  }
});

// GET /api/expenses/archived - Get archived expenses
router.get('/archived/list', (req, res) => {
  try {
    const expenses = db.prepare('SELECT * FROM expenses WHERE archived = 1 ORDER BY date DESC').all();
    res.json(expenses);
  } catch (err) {
    logger.error('Error fetching archived expenses', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách chi phí đã xóa' });
  }
});

// POST /api/expenses/:id/restore - Restore archived expense
router.post('/:id/restore', (req, res) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND archived = 1').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy chi phí đã xóa' });
    }

    db.prepare('UPDATE expenses SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    const restored = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    socketServer.emitExpense('created', restored);
    res.json({ success: true, message: 'Đã khôi phục chi phí', archived: false });
  } catch (err) {
    logger.error('Error restoring expense', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi khôi phục chi phí' });
  }
});

// Get all custom expense categories
router.get('/categories/all', (req, res) => {
  try {
    const categories = db.prepare('SELECT * FROM expense_categories ORDER BY name ASC').all();
    res.json(categories);
  } catch (err) {
    logger.error('Error fetching expense categories', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch expense categories' });
  }
});

// Add a new expense category
router.post('/categories', (req, res) => {
  try {
    const { name, icon } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Tên loại chi phí phải có ít nhất 2 ký tự.' });
    }
    const trimmed = name.trim();
    const emoji = (icon && typeof icon === 'string') ? icon.trim().slice(0, 8) : '📋';

    // Check duplicate
    const existing = db.prepare('SELECT id FROM expense_categories WHERE name = ?').get(trimmed);
    if (existing) {
      return res.status(409).json({ error: 'Loại chi phí này đã tồn tại.' });
    }

    const result = db.prepare('INSERT INTO expense_categories (name, icon) VALUES (?, ?)').run(trimmed, emoji);
    const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(category);
  } catch (err) {
    logger.error('Error creating expense category', { error: err.message });
    res.status(500).json({ error: 'Failed to create expense category' });
  }
});

// Update expense category (icon or name)
router.patch('/categories/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon } = req.body;

    const existing = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Loại chi phí không tồn tại.' });
    }

    const newName = (name && typeof name === 'string' && name.trim().length >= 2) ? name.trim() : existing.name;
    const newIcon = (icon && typeof icon === 'string') ? icon.trim().slice(0, 8) : existing.icon;

    // Check duplicate name
    if (newName !== existing.name) {
      const dup = db.prepare('SELECT id FROM expense_categories WHERE name = ? AND id != ?').get(newName, id);
      if (dup) {
        return res.status(409).json({ error: 'Loại chi phí này đã tồn tại.' });
      }
    }

    db.prepare('UPDATE expense_categories SET name = ?, icon = ? WHERE id = ?').run(newName, newIcon, id);
    const updated = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    logger.error('Error updating expense category', { error: err.message });
    res.status(500).json({ error: 'Failed to update expense category' });
  }
});

// Delete an expense category (soft: reassign expenses to "Khác" and archive category)
router.delete('/categories/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Loại chi phí không tồn tại.' });
    }
    const catName = existing.name;

    // Update all expenses using this category → move to "Khác" + type "other" (keep expenses, don't delete)
    db.prepare('UPDATE expenses SET category = ?, type = ? WHERE category = ? AND archived = 0').run('Khác', 'other', catName);

    // Soft delete the category (mark as archived)
    db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);

    // Notify all connected clients to refetch expenses (expenses changed)
    socketServer.emitExpense('updated', { id: null, _categoryDeleted: catName });
    res.json({ success: true, message: 'Đã xóa loại chi phí và chuyển các chi phí sang "Khác".', reassigned: catName });
  } catch (err) {
    logger.error('Error deleting expense category', { error: err.message });
    res.status(500).json({ error: 'Failed to delete expense category' });
  }
});

module.exports = router;
