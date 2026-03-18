/**
 * Beer POS - Validation Service
 * Input validation utilities
 * @module validation
 */

/**
 * Validate and sanitize a number
 * @param {*} value - Value to validate
 * @param {number} [min=0] - Minimum value
 * @param {number} [max=Infinity] - Maximum value
 * @param {number} [defaultValue=0] - Default if invalid
 * @returns {number} Validated number
 */
function validateNumber(value, min, max, defaultValue) {
  defaultValue = defaultValue !== undefined ? defaultValue : 0;
  min = min !== undefined ? min : 0;
  max = max !== undefined ? max : Infinity;
  
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  
  const num = Number(value);
  if (isNaN(num)) {
    return defaultValue;
  }
  
  // Clamp to range
  return Math.max(min, Math.min(max, num));
}
exports.validateNumber = validateNumber;

/**
 * Validate string
 * @param {*} value - Value to validate
 * @param {number} [maxLength=255] - Maximum length
 * @param {string} [defaultValue=''] - Default if invalid
 * @returns {string} Validated string
 */
function validateString(value, maxLength, defaultValue) {
  defaultValue = defaultValue !== undefined ? defaultValue : '';
  maxLength = maxLength || 255;
  
  if (value === null || value === undefined) {
    return defaultValue;
  }
  
  let str = String(value).trim();
  if (str.length > maxLength) {
    str = str.substring(0, maxLength);
  }
  
  return str;
}
exports.validateString = validateString;

/**
 * Validate expense type
 * @param {*} type - Type to validate
 * @returns {string} Valid expense type
 */
function validateExpenseType(type) {
  const validTypes = ['fuel', 'food', 'repair', 'other'];
  return validTypes.includes(type) ? type : 'other';
}
exports.validateExpenseType = validateExpenseType;

/**
 * Validate payment method
 * @param {*} method - Method to validate
 * @returns {string} Valid payment method
 */
function validatePaymentMethod(method) {
  const validMethods = ['cash', 'transfer'];
  return validMethods.includes(method) ? method : 'cash';
}
exports.validatePaymentMethod = validatePaymentMethod;

/**
 * Validate order item
 * @param {Object} item - Order item to validate
 * @returns {Object} Validated order item
 */
function validateOrderItem(item) {
  return {
    productId: validateString(item.productId, 50),
    name: validateString(item.name, 100),
    priceAtTime: validateNumber(item.priceAtTime, 0),
    quantity: validateNumber(item.quantity, 1)
  };
}
exports.validateOrderItem = validateOrderItem;

/**
 * Validate order
 * @param {Object} order - Order to validate
 * @returns {Object} Validated order
 */
function validateOrder(order) {
  const validatedItems = Array.isArray(order.items) 
    ? order.items.map(validateOrderItem)
    : [];
  
  return {
    id: validateString(order.id, 50),
    customerId: validateString(order.customerId, 50),
    customerName: validateString(order.customerName, 100),
    items: validatedItems,
    total: validateNumber(order.total, 0),
    createdAt: validateNumber(order.createdAt, 0),
    paymentMethod: validatePaymentMethod(order.paymentMethod),
    note: validateString(order.note, 500)
  };
}
exports.validateOrder = validateOrder;

/**
 * Validate expense
 * @param {Object} expense - Expense to validate
 * @returns {Object} Validated expense
 */
function validateExpense(expense) {
  return {
    id: validateString(expense.id, 50),
    type: validateExpenseType(expense.type),
    amount: validateNumber(expense.amount, 0),
    note: validateString(expense.note, 500),
    createdAt: validateNumber(expense.createdAt, 0),
    date: validateString(expense.date, 10)
  };
}
exports.validateExpense = validateExpense;

/**
 * Validate product
 * @param {Object} product - Product to validate
 * @returns {Object} Validated product
 */
function validateProduct(product) {
  return {
    id: validateString(product.id, 50),
    name: validateString(product.name, 100),
    price: validateNumber(product.price, 0),
    category: validateString(product.category, 50),
    stock: validateNumber(product.stock, 0),
    unit: validateString(product.unit, 20, 'bình')
  };
}
exports.validateProduct = validateProduct;

/**
 * Validate customer
 * @param {Object} customer - Customer to validate
 * @returns {Object} Validated customer
 */
function validateCustomer(customer) {
  return {
    id: validateString(customer.id, 50),
    name: validateString(customer.name, 100),
    phone: validateString(customer.phone, 20),
    address: validateString(customer.address, 200),
    deposit: validateNumber(customer.deposit, 0),
    fridge: {
      lying: validateNumber(customer.fridge?.lying, 0),
      standing: validateNumber(customer.fridge?.standing, 0)
    },
    prices: customer.prices || {},
    lastOrderDate: validateString(customer.lastOrderDate, 10),
    createdAt: validateNumber(customer.createdAt, 0)
  };
}
exports.validateCustomer = validateCustomer;

/**
 * Validate ID
 * @param {*} id - ID to validate
 * @returns {string} Valid ID or empty string
 */
function validateId(id) {
  return validateString(id, 50);
}
exports.validateId = validateId;

/**
 * Check if value is empty
 * @param {*} value - Value to check
 * @returns {boolean} True if empty
 */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value) || typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}
exports.isEmpty = isEmpty;

/**
 * Sanitize HTML to prevent XSS
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
exports.sanitizeHtml = sanitizeHtml;
