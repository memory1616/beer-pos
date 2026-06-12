/**
 * Tests for SaleService
 */

const mockDb = {
  transaction: jest.fn((fn) => fn),
  prepare: jest.fn(() => ({
    get: jest.fn(),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ lastInsertRowid: 1 })),
  })),
  getVietnamDateStr: jest.fn(() => '2026-06-12'),
  SQL_KEG_WAREHOUSE_RAW_STOCK: 'SELECT COALESCE(SUM(stock), 0) as total FROM products WHERE type = \'keg\'',
};

jest.mock('../../database', () => mockDb);

const SaleService = require('../../src/services/SaleService');

describe('SaleService', () => {
  let saleService;

  beforeEach(() => {
    jest.clearAllMocks();
    saleService = new SaleService();
  });

  describe('constructor', () => {
    it('should initialize with empty cache', () => {
      expect(saleService._saleCache).toBeInstanceOf(Map);
      expect(saleService._saleCache.size).toBe(0);
    });
  });

  describe('create', () => {
    it('should return error for empty items', () => {
      const result = saleService.create({ items: [] });
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Danh sách sản phẩm trống');
    });

    it('should return error for null items', () => {
      const result = saleService.create({ items: null });
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Danh sách sản phẩm trống');
    });

    it('should return error for undefined items', () => {
      const result = saleService.create({});
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Danh sách sản phẩm trống');
    });

    it('should return error for item without productId or productSlug', () => {
      const result = saleService.create({ items: [{}] });
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Sản phẩm thứ 1: Thiếu mã sản phẩm');
    });

    it('should return error for item with zero quantity', () => {
      const result = saleService.create({ items: [{ productId: 1, quantity: 0 }] });
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Sản phẩm thứ 1: Số lượng phải > 0');
    });

    it('should return error for item with negative quantity', () => {
      const result = saleService.create({ items: [{ productId: 1, quantity: -5 }] });
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Sản phẩm thứ 1: Số lượng phải > 0');
    });

    it('should return error for non-existent product', () => {
      // Mock empty products map
      const mockPrepare = { all: jest.fn(() => []), run: jest.fn() };
      mockDb.prepare.mockReturnValue(mockPrepare);

      const result = saleService.create({
        customerId: 1,
        items: [{ productId: 999, quantity: 1 }],
      });

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Không tìm thấy sản phẩm');
    });
  });

  describe('clearCache', () => {
    it('should clear the internal cache', () => {
      saleService._saleCache.set('test', 'value');
      expect(saleService._saleCache.size).toBe(1);

      saleService.clearCache();
      expect(saleService._saleCache.size).toBe(0);
    });
  });

  describe('effective price calculation', () => {
    it('should use customer price by ID if available', () => {
      const product = { id: 1, slug: 'bia-30l', sell_price: 100 };
      const priceMap = { byId: { 1: 80 }, bySlug: {} };

      saleService._saleCache.set('_products', { 1: product });
      saleService._saleCache.set('_prices_1', priceMap);

      const price = saleService._getEffectivePrice(product, priceMap);
      expect(price).toBe(80);
    });

    it('should use customer price by slug if ID not available', () => {
      const product = { id: 1, slug: 'bia-30l', sell_price: 100 };
      const priceMap = { byId: {}, bySlug: { 'bia-30l': 90 } };

      const price = saleService._getEffectivePrice(product, priceMap);
      expect(price).toBe(90);
    });

    it('should fallback to product sell_price', () => {
      const product = { id: 1, slug: 'bia-30l', sell_price: 100 };
      const priceMap = { byId: {}, bySlug: {} };

      const price = saleService._getEffectivePrice(product, priceMap);
      expect(price).toBe(100);
    });

    it('should fallback to product price field', () => {
      const product = { id: 1, slug: 'bia-30l', price: 95 };
      const priceMap = { byId: {}, bySlug: {} };

      const price = saleService._getEffectivePrice(product, priceMap);
      expect(price).toBe(95);
    });
  });
});
