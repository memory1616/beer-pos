/**
 * Tests for middleware validation
 */

const {
  isValidId,
  isValidDate,
  isPositiveNumber,
  isNonNegativeInt,
  sanitizeString,
  validateIdArray,
  validate,
} = require('../middleware/validation');

describe('Validation Middleware', () => {
  describe('isValidId', () => {
    it('should return true for positive numbers', () => {
      expect(isValidId(1)).toBe(true);
      expect(isValidId(999)).toBe(true);
    });

    it('should return true for numeric strings', () => {
      expect(isValidId('1')).toBe(true);
      expect(isValidId('999')).toBe(true);
    });

    it('should return false for null/undefined', () => {
      expect(isValidId(null)).toBe(false);
      expect(isValidId(undefined)).toBe(false);
    });

    it('should return false for zero or negative', () => {
      expect(isValidId(0)).toBe(false);
      expect(isValidId(-1)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidId('')).toBe(false);
      expect(isValidId('   ')).toBe(false);
    });
  });

  describe('isValidDate', () => {
    it('should return true for valid date strings', () => {
      expect(isValidDate('2026-06-12')).toBe(true);
      expect(isValidDate('2026-01-01')).toBe(true);
      expect(isValidDate('2026-12-31')).toBe(true);
    });

    it('should return false for invalid format', () => {
      expect(isValidDate('06-12-2026')).toBe(false);
      expect(isValidDate('2026/06/12')).toBe(false);
      expect(isValidDate('invalid')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidDate(null)).toBe(false);
      expect(isValidDate(undefined)).toBe(false);
    });

    it('should return false for non-string', () => {
      expect(isValidDate(123)).toBe(false);
      expect(isValidDate({})).toBe(false);
    });
  });

  describe('isPositiveNumber', () => {
    it('should return true for positive numbers', () => {
      expect(isPositiveNumber(1)).toBe(true);
      expect(isPositiveNumber(0.5)).toBe(true);
      expect(isPositiveNumber(1000)).toBe(true);
    });

    it('should return true for zero', () => {
      expect(isPositiveNumber(0)).toBe(true);
    });

    it('should return false for negative', () => {
      expect(isPositiveNumber(-1)).toBe(false);
      expect(isPositiveNumber(-0.5)).toBe(false);
    });

    it('should return false for Infinity/NaN', () => {
      expect(isPositiveNumber(Infinity)).toBe(false);
      expect(isPositiveNumber(NaN)).toBe(false);
    });
  });

  describe('isNonNegativeInt', () => {
    it('should return true for non-negative integers', () => {
      expect(isNonNegativeInt(0)).toBe(true);
      expect(isNonNegativeInt(1)).toBe(true);
      expect(isNonNegativeInt(100)).toBe(true);
    });

    it('should return false for negative integers', () => {
      expect(isNonNegativeInt(-1)).toBe(false);
    });

    it('should return false for floats', () => {
      expect(isNonNegativeInt(1.5)).toBe(false);
    });
  });

  describe('sanitizeString', () => {
    it('should trim whitespace', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
    });

    it('should truncate long strings', () => {
      const long = 'a'.repeat(600);
      expect(sanitizeString(long).length).toBe(500);
    });

    it('should return empty string for non-string', () => {
      expect(sanitizeString(123)).toBe('');
      expect(sanitizeString(null)).toBe('');
    });
  });

  describe('validateIdArray', () => {
    it('should filter valid IDs', () => {
      const result = validateIdArray([1, 2, 'abc', null, 3]);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should return empty array for non-array', () => {
      expect(validateIdArray(null)).toEqual([]);
      expect(validateIdArray('not array')).toEqual([]);
    });

    it('should return empty array for empty array', () => {
      expect(validateIdArray([])).toEqual([]);
    });
  });

  describe('validate middleware factory', () => {
    it('should call next() for valid data', () => {
      const middleware = validate('sale');
      const req = { body: { customer_id: 1, total: 100 } };
      const res = { status: jest.fn(() => ({ json: jest.fn() })) };
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should return 400 for missing required fields', () => {
      const middleware = validate('sale');
      const req = { body: {} };
      const res = { status: jest.fn(() => ({ json: jest.fn() })) };
      const next = jest.fn();

      middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('should skip validation for unknown schema', () => {
      const middleware = validate('unknownSchema');
      const req = { body: {} };
      const res = {};
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
