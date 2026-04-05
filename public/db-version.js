// BeerPOS — Single Source of Truth for IndexedDB & Service Worker versioning
// NEVER hardcode DB version numbers elsewhere. Import from here instead.
// This prevents the "VersionError: requested version (31) less than existing (310)" bug
// by ensuring all contexts open the SAME version and never downgrade.

const BEERPOS_DB_VERSION  = 32;  // IndexedDB schema version — bump this on ANY schema change
const BEERPOS_DB_NAME     = 'BeerPOS'; // IndexedDB database name
const BEERPOS_CACHE_NAME  = 'beer-pos-v32'; // SW cache name — MUST match BEERPOS_DB_VERSION
const BEERPOS_SYNC_STORE  = 'sync_queue';  // Object store for sync queue (SW + sync.js)
const BEERPOS_ORDERS_STORE = 'orders_queue'; // Object store for orders queue (sync-orders.js)

// ─── Max-Version Guard ──────────────────────────────────────────────────────────
// NEVER open the DB at a version LOWER than the max ever used.
// If the DB is at version 310 and code says 31 → delete and recreate.
// This prevents VersionError from stale/higher versions.
const MAX_DB_VERSION_KEY = 'beerpos_max_db_version'; // localStorage key

function getMaxDBVersion() {
  return parseInt(localStorage.getItem(MAX_DB_VERSION_KEY) || '0', 10);
}

function setMaxDBVersion(v) {
  const current = getMaxDBVersion();
  if (v > current) localStorage.setItem(MAX_DB_VERSION_KEY, String(v));
}

// Returns the version to pass to indexedDB.open().
// If code version < max-seen version → escalate to max-seen (never downgrade).
function getSafeDBVersion(codeVersion) {
  const maxVersion = getMaxDBVersion();
  const safeVersion = Math.max(codeVersion, maxVersion);
  setMaxDBVersion(safeVersion);
  return safeVersion;
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.BEERPOS_DB_VERSION     = BEERPOS_DB_VERSION;
  window.BEERPOS_DB_NAME        = BEERPOS_DB_NAME;
  window.BEERPOS_CACHE_NAME     = BEERPOS_CACHE_NAME;
  window.BEERPOS_SYNC_STORE     = BEERPOS_SYNC_STORE;
  window.BEERPOS_ORDERS_STORE   = BEERPOS_ORDERS_STORE;
  window.getSafeDBVersion       = getSafeDBVersion;
  window.getMaxDBVersion        = getMaxDBVersion;
}