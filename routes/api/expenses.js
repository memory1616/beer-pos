const express = require('express');
const router = express.Router();
const db = require('../../database');

// Get all expenses with optional date range
router.get('/', (req, res) => {
  try {
    const { startDate, endDate, category } = req.query;
    
    let sql = 'SELECT * FROM expenses WHERE 1=1';
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
    
    sql += ' ORDER BY date DESC, id DESC';
    
    const expenses = db.prepare(sql).all(...params);
    res.json(expenses);
  } catch (err) {
    console.error('Error fetching expenses:', err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// Get expense summary by category
router.get('/summary', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let sql = `
      SELECT category, SUM(amount) as total
      FROM expenses
      WHERE 1=1
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
    console.error('Error fetching expense summary:', err);
    res.status(500).json({ error: 'Failed to fetch expense summary' });
  }
});

// Get total expenses in date range
router.get('/total', (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let sql = 'SELECT SUM(amount) as total FROM expenses WHERE 1=1';
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
    console.error('Error fetching total expenses:', err);
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
    console.error('Error fetching expense:', err);
    res.status(500).json({ error: 'Failed to fetch expense' });
  }
});

// Create new expense
router.post('/', (req, res) => {
  try {
    const { category, amount, description, date } = req.body;
    
    console.log('POST /api/expenses body:', req.body);
    
    if (!category || !amount) {
      return res.status(400).json({ error: 'Category and amount are required' });
    }
    
    const result = db.prepare(`
      INSERT INTO expenses (category, amount, description, date)
      VALUES (?, ?, ?, ?)
    `).run(category, amount, description || null, date || new Date().toISOString().split('T')[0]);
    
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(expense);
  } catch (err) {
    console.error('Error creating expense:', err);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// Update expense
router.put('/:id', (req, res) => {
  try {
    const { category, amount, description, date } = req.body;
    const { id } = req.params;
    
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    
    db.prepare(`
      UPDATE expenses
      SET category = ?, amount = ?, description = ?, date = ?
      WHERE id = ?
    `).run(
      category || existing.category,
      amount || existing.amount,
      description !== undefined ? description : existing.description,
      date || existing.date,
      id
    );
    
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    res.json(expense);
  } catch (err) {
    console.error('Error updating expense:', err);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// Delete expense
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    console.error('Error deleting expense:', err);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

module.exports = router;
