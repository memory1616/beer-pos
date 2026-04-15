// Input validation middleware utilities

// Check if value is valid ID (UUID or numeric string)
function isValidId(id) {
  if (!id) return false;
  if (typeof id === 'number') return id > 0;
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (!trimmed) return false;
    // UUID format: 8-4-4-4-12 hex
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(trimmed) || /^\d+$/.test(trimmed);
  }
  return false;
}

// Check if value is valid date string (YYYY-MM-DD)
function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  const d = new Date(dateStr);
  return d instanceof Date && !isNaN(d.getTime());
}

// Check if value is positive number
function isPositiveNumber(val) {
  return typeof val === 'number' && val >= 0 && isFinite(val);
}

// Check if value is non-negative integer
function isNonNegativeInt(val) {
  return Number.isInteger(val) && val >= 0;
}

// Sanitize string (trim, remove dangerous chars)
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '');
}

// Validate array of IDs
function validateIdArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.filter(id => isValidId(id));
}

// Validation schemas for common operations
const schemas = {
  // Sale validation
  sale: {
    required: ['customer_id', 'total'],
    optional: ['date', 'profit', 'deliver_kegs', 'return_kegs', 'type', 'note', 'items'],
    validate: {
      customer_id: isValidId,
      total: isPositiveNumber,
      profit: val => val === undefined || isPositiveNumber(val),
      deliver_kegs: val => val === undefined || isNonNegativeInt(val),
      return_kegs: val => val === undefined || isNonNegativeInt(val),
    }
  },

  // Customer validation
  customer: {
    required: ['id', 'name'],
    optional: ['phone', 'deposit', 'keg_balance', 'debt', 'address', 'lat', 'lng', 'note', 'horizontal_fridge', 'vertical_fridge'],
    validate: {
      name: val => typeof val === 'string' && val.trim().length > 0 && val.length <= 200,
      phone: val => val === undefined || (typeof val === 'string' && val.length <= 20),
      deposit: val => val === undefined || isPositiveNumber(val),
      keg_balance: val => val === undefined || isNonNegativeInt(val),
      debt: val => val === undefined || isPositiveNumber(val),
    }
  },

  // Product validation
  product: {
    required: ['id', 'name'],
    optional: ['stock', 'cost_price', 'sell_price', 'type'],
    validate: {
      name: val => typeof val === 'string' && val.trim().length > 0 && val.length <= 200,
      stock: val => val === undefined || isNonNegativeInt(val),
      cost_price: val => val === undefined || isPositiveNumber(val),
      sell_price: val => val === undefined || isPositiveNumber(val),
    }
  },

  // Expense validation
  expense: {
    required: ['category', 'amount'],
    optional: ['type', 'description', 'date', 'time', 'km'],
    validate: {
      category: val => typeof val === 'string' && val.trim().length > 0,
      amount: isPositiveNumber,
      km: val => val === undefined || isPositiveNumber(val),
    }
  },

  // Payment validation
  payment: {
    required: ['customer_id', 'amount'],
    optional: ['date', 'note'],
    validate: {
      customer_id: isValidId,
      amount: isPositiveNumber,
    }
  },

  // Sync batch item validation
  syncItem: {
    required: ['syncId', 'entity', 'action'],
    optional: ['data', 'client_updated_at'],
    validate: {
      syncId: val => typeof val === 'string' && val.length > 0,
      entity: val => typeof val === 'string' && val.length > 0 && val.length <= 50,
      action: val => ['create', 'update', 'delete'].includes(val),
    }
  }
};

// Generic validator middleware factory
function validate(schemaName, options = {}) {
  const schema = schemas[schemaName];
  if (!schema) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const data = req.method === 'GET' ? req.query : req.body;
    const errors = [];

    // Check required fields
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Validate field values
    if (schema.validate) {
      for (const [field, validator] of Object.entries(schema.validate)) {
        if (data[field] !== undefined && data[field] !== null) {
          if (!validator(data[field])) {
            errors.push(`Invalid value for field: ${field}`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    next();
  };
}

module.exports = {
  isValidId,
  isValidDate,
  isPositiveNumber,
  isNonNegativeInt,
  sanitizeString,
  validateIdArray,
  schemas,
  validate
};
