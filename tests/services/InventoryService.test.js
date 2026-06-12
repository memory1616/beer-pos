/**
 * Tests for InventoryService
 */

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

const InventoryService = require('../../src/services/InventoryService');

describe('InventoryService', () => {
  let inventoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    inventoryService = new InventoryService();
  });

  describe('getStockSummary', () => {
    it('should return stock summary with products', () => {
      const mockProducts = [
        { id: 1, name: 'Bia 30L', stock: 10, damaged_stock: 1, cost_price: 100, sell_price: 200, type: 'keg' },
        { id: 2, name: 'Bia 15L', stock: 5, damaged_stock: 0, cost_price: 50, sell_price: 100, type: 'keg' },
      ];

      const mockPrepare = { all: jest.fn(() => mockProducts) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = inventoryService.getStockSummary();

      expect(result.products).toEqual(mockProducts);
      expect(result.totalStock).toBe(15); // 10 + 5
      expect(result.totalDamaged).toBe(1);
    });

    it('should handle empty products', () => {
      const mockPrepare = { all: jest.fn(() => []) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = inventoryService.getStockSummary();

      expect(result.totalStock).toBe(0);
      expect(result.totalDamaged).toBe(0);
    });

    it('should ignore negative stock in total', () => {
      const mockProducts = [
        { id: 1, name: 'Bia 30L', stock: -5, damaged_stock: 0, cost_price: 100, sell_price: 200, type: 'keg' },
      ];

      const mockPrepare = { all: jest.fn(() => mockProducts) };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = inventoryService.getStockSummary();

      expect(result.totalStock).toBe(0); // Negative ignored
    });
  });

  describe('import', () => {
    it('should return error for empty items', () => {
      const result = inventoryService.import({ items: [] });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Danh sách trống');
    });

    it('should return error for null items', () => {
      const result = inventoryService.import({ items: null });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Danh sách trống');
    });

    it('should return error for missing items property', () => {
      const result = inventoryService.import({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Danh sách trống');
    });
  });
});
