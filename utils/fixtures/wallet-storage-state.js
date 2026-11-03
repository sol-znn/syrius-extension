'use strict';

// Diagnostic labels only. Never return the saved map, its keys or an error.
const walletStorageState = storage => {
  let raw;
  try { raw = storage.getItem('znn.ts-wallet'); } catch { return 'UNREADABLE'; }
  if (raw === null) return 'ABSENT';
  let value;
  try { value = JSON.parse(raw); } catch { return 'INVALID_JSON'; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'INVALID_SHAPE';
  return Object.keys(value).length ? 'NONEMPTY_OBJECT' : 'EMPTY_OBJECT';
};

module.exports = { walletStorageState };
