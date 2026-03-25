// src/constants.js
// Centralized constants — eliminates magic strings throughout the codebase

module.exports = {
  // Sale types
  SALE_TYPE: {
    SALE:         'sale',
    REPLACEMENT:  'replacement',
    DAMAGE_RETURN:'damage_return',
  },

  // Sale status
  SALE_STATUS: {
    ACTIVE:   'active',
    RETURNED: 'returned',
  },

  // Keg pool names (pool_from / pool_to in keg_ledger)
  KEG_POOL: {
    INVENTORY: 'inventory',
    EMPTY:     'empty',
    CUSTOMER:  'customer',
    FACTORY:   'factory',
  },

  // Ledger source types (source_type in keg_ledger)
  KEG_SOURCE: {
    SALE:        'sale',
    DELIVERY:    'delivery',
    COLLECT:     'collect',
    IMPORT:      'import',
    ADJUST:      'adjust',
    SELL_EMPTY:  'sell_empty',
    RETURN_SALE: 'return_sale',
  },
};
