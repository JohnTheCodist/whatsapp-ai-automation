/**
 * The collapsed-sidebar preference. What these defend: a choice someone made
 * is honoured on their next visit, a first visit on a small screen gets the
 * room it needs, and a browser that refuses storage never takes the
 * dashboard down over a sidebar.
 */

import { test, expect } from 'vitest';
import {
  SIDEBAR_COLLAPSED_KEY, AUTO_COLLAPSE_BELOW,
  readSidebarCollapsed, writeSidebarCollapsed,
} from './sidebarPreference.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data,
  };
}

const throwingStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

test('a saved choice wins at any screen width', () => {
  expect(readSidebarCollapsed({ storage: memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: 'true' }), width: 1920 })).toBe(true);
  expect(readSidebarCollapsed({ storage: memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: 'false' }), width: 800 })).toBe(false);
});

test('with no saved choice, a small screen starts collapsed and a large one expanded', () => {
  expect(readSidebarCollapsed({ storage: memoryStorage(), width: AUTO_COLLAPSE_BELOW - 1 })).toBe(true);
  expect(readSidebarCollapsed({ storage: memoryStorage(), width: AUTO_COLLAPSE_BELOW })).toBe(false);
});

test('a corrupted saved value is ignored, not read as "collapsed"', () => {
  expect(readSidebarCollapsed({ storage: memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: 'yes' }), width: 1440 })).toBe(false);
});

test('storage that throws falls back to the width rule instead of breaking the page', () => {
  expect(readSidebarCollapsed({ storage: throwingStorage, width: 700 })).toBe(true);
  expect(readSidebarCollapsed({ storage: null, width: 1440 })).toBe(false);
  expect(() => writeSidebarCollapsed(throwingStorage, true)).not.toThrow();
  expect(() => writeSidebarCollapsed(null, true)).not.toThrow();
});

test('the choice round-trips through storage', () => {
  const storage = memoryStorage();
  writeSidebarCollapsed(storage, true);
  expect(storage.data[SIDEBAR_COLLAPSED_KEY]).toBe('true');
  expect(readSidebarCollapsed({ storage, width: 1920 })).toBe(true);
  writeSidebarCollapsed(storage, false);
  expect(readSidebarCollapsed({ storage, width: 600 })).toBe(false);
});
