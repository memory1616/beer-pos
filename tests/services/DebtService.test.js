/**
 * Tests for DebtService
 */

// Mock the database module
const mockDb = {
  transaction: jest.fn((fn) => fn),
  prepare: jest.fn(() => ({
    get: jest.fn(),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ lastInsertRowid: 1 })),
  })),
  getVietnamDateStr: jest.fn(() => '2026-06-12'),
};

jest.mock('../../database', () => mockDb);

// Import after mocking
const DebtService = require('../../src/services/DebtService');

describe('DebtService', () => {
  let debtService;

  beforeEach(() => {
    jest.clearAllMocks();
    debtService = new DebtService();
  });

  describe('createDebt', () => {
    it('should return error for invalid customerId', () => {
      const result = debtService.createDebt(null, 100, 1, 'Test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Dữ liệu không hợp lệ');
    });

    it('should return error for invalid amount', () => {
      const result = debtService.createDebt(1, 0, 1, 'Test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Dữ liệu không hợp lệ');
    });

    it('should return error for negative amount', () => {
      const result = debtService.createDebt(1, -100, 1, 'Test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Dữ liệu không hợp lệ');
    });
  });

  describe('payDebt', () => {
    it('should return error for invalid customerId', () => {
      const result = debtService.payDebt(null, 100, 'Test payment');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Dữ liệu không hợp lệ');
    });

    it('should return error for invalid amount', () => {
      const result = debtService.payDebt(1, -50, 'Test payment');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Dữ liệu không hợp lệ');
    });
  });

  describe('adjustDebt', () => {
    it('should return error for missing customerId', () => {
      const result = debtService.adjustDebt(null, 100, 'Manual adjust');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Thiếu customerId');
    });
  });

  describe('reverseDebtForSale', () => {
    it('should return error for missing saleId', () => {
      const result = debtService.reverseDebtForSale(null);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Thiếu saleId');
    });
  });

  describe('getAllDebts', () => {
    it('should return array of debts', () => {
      const mockDebts = [
        { id: 1, name: 'Customer A', debt: 1000 },
        { id: 2, name: 'Customer B', debt: 2000 },
      ];

      const mockPrepare = {
        all: jest.fn(() => mockDebts),
      };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = debtService.getAllDebts();
      expect(result).toEqual(mockDebts);
      expect(mockPrepare.all).toHaveBeenCalled();
    });

    it('should return filtered debts when hasDebt filter is set', () => {
      const mockPrepare = { all: jest.fn(() => [{ id: 1, debt: 1000 }]) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = debtService.getAllDebts({ hasDebt: true });

      expect(result).toEqual([{ id: 1, debt: 1000 }]);
      expect(mockPrepare.all).toHaveBeenCalled();
    });
  });

  describe('getCustomerDebt', () => {
    it('should return null for non-existent customer', () => {
      const mockPrepare = { get: jest.fn(() => null) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = debtService.getCustomerDebt(999);
      expect(result).toBeNull();
    });
  });

  describe('recalcDebt', () => {
    it('should return error for non-existent customer', () => {
      const mockPrepare = { get: jest.fn(() => null) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = debtService.recalcDebt(999);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Không tìm thấy khách');
    });
  });
});
