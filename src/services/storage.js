/**
 * Beer POS - Storage Service
 * LocalStorage handling with fallback
 * @module storage
 */

const STORAGE_PREFIX = 'beer_pos_';

/**
 * Save data to localStorage
 * @param {string} key - Storage key
 * @param {*} data - Data to store
 * @returns {boolean} Success status
 */
function saveData(key, data) {
  try {
    const fullKey = STORAGE_PREFIX + key;
    localStorage.setItem(fullKey, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('Storage save error:', e);
    return false;
  }
}
exports.saveData = saveData;

/**
 * Load data from localStorage
 * @param {string} key - Storage key
 * @param {*} [defaultValue=[]] - Default value if not found
 * @returns {*} Loaded data or default
 */
function loadData(key, defaultValue) {
  try {
    const fullKey = STORAGE_PREFIX + key;
    const item = localStorage.getItem(fullKey);
    if (item === null) {
      return defaultValue !== undefined ? defaultValue : [];
    }
    return JSON.parse(item);
  } catch (e) {
    console.error('Storage load error:', e);
    return defaultValue !== undefined ? defaultValue : [];
  }
}
exports.loadData = loadData;

/**
 * Remove data from localStorage
 * @param {string} key - Storage key
 * @returns {boolean} Success status
 */
function removeData(key) {
  try {
    const fullKey = STORAGE_PREFIX + key;
    localStorage.removeItem(fullKey);
    return true;
  } catch (e) {
    console.error('Storage remove error:', e);
    return false;
  }
}
exports.removeData = removeData;

/**
 * Clear all app data from localStorage
 * @returns {boolean} Success status
 */
function clearAll() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    return true;
  } catch (e) {
    console.error('Storage clear error:', e);
    return false;
  }
}
exports.clearAll = clearAll;

/**
 * Get all storage keys
 * @returns {string[]} Array of keys
 */
function getAllKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      keys.push(key.replace(STORAGE_PREFIX, ''));
    }
  }
  return keys;
}
exports.getAllKeys = getAllKeys;

/**
 * Check if key exists in storage
 * @param {string} key - Storage key
 * @returns {boolean} True if exists
 */
function hasKey(key) {
  const fullKey = STORAGE_PREFIX + key;
  return localStorage.getItem(fullKey) !== null;
}
exports.hasKey = hasKey;

/**
 * Get storage size (approximate)
 * @returns {number} Size in bytes
 */
function getStorageSize() {
  let size = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      size += key.length + (localStorage.getItem(key) || '').length;
    }
  }
  return size;
}
exports.getStorageSize = getStorageSize;
