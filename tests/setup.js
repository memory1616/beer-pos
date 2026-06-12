/**
 * Jest setup for Beer POS tests
 */

// Set test environment
process.env.NODE_ENV = 'test';

// Increase timeout for database tests
jest.setTimeout(10000);
