import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Do NOT mock env here — sqliteCache.ts uses a runtime require('../config/env')
// that bypasses Vitest's ESM mock registry. The real env module loads fine
// (dotenv gracefully handles a missing .env), and since we pass ':memory:' to
// init(), the repoRoot value is fetched but never actually used.
import * as sqliteCache from '../../src/utils/sqliteCache';

describe('sqliteCache', () => {
  beforeEach(() => {
    // Use ':memory:' path for fully in-memory SQLite — no filesystem I/O
    sqliteCache.init(':memory:');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await sqliteCache.close();
  });

  describe('set / get', () => {
    it('stores and retrieves a value', async () => {
      await sqliteCache.set('key1', { data: 'hello' }, 60000);
      expect(await sqliteCache.get('key1')).toEqual({ data: 'hello' });
    });

    it('returns null for missing key', async () => {
      expect(await sqliteCache.get('nonexistent')).toBeNull();
    });

    it('returns null after TTL expires', async () => {
      vi.useFakeTimers();
      await sqliteCache.set('expiring', { x: 1 }, 1000);
      vi.advanceTimersByTime(1001);
      expect(await sqliteCache.get('expiring')).toBeNull();
    });

    it('compresses with gzip and decompresses transparently', async () => {
      const large = { data: 'x'.repeat(1000) };
      await sqliteCache.set('compressed', large, 60000);
      expect(await sqliteCache.get('compressed')).toEqual(large);
    });
  });

  describe('setRaw / getRaw', () => {
    it('stores and retrieves raw JSON without compression', async () => {
      await sqliteCache.setRaw('raw1', { raw: true }, 60000);
      expect(await sqliteCache.getRaw('raw1')).toEqual({ raw: true });
    });

    it('returns null after TTL expires', async () => {
      vi.useFakeTimers();
      await sqliteCache.setRaw('raw-expire', { x: 1 }, 1000);
      vi.advanceTimersByTime(1001);
      expect(await sqliteCache.getRaw('raw-expire')).toBeNull();
    });
  });

  describe('del', () => {
    it('removes an existing key', async () => {
      await sqliteCache.set('toDelete', 'value', 60000);
      await sqliteCache.del('toDelete');
      expect(await sqliteCache.get('toDelete')).toBeNull();
    });

    it('is a no-op for missing key', async () => {
      await expect(sqliteCache.del('nope')).resolves.toBeUndefined();
    });
  });

  describe('cleanExpired', () => {
    it('deletes expired entries and returns count', async () => {
      vi.useFakeTimers();
      await sqliteCache.set('exp1', 'v1', 500);
      await sqliteCache.set('exp2', 'v2', 500);
      await sqliteCache.set('keep', 'v3', 60000);
      vi.advanceTimersByTime(600);
      const deleted = await sqliteCache.cleanExpired();
      expect(deleted).toBe(2);
    });

    it('does not delete entries within TTL', async () => {
      await sqliteCache.set('live', 'value', 60000);
      const deleted = await sqliteCache.cleanExpired();
      expect(deleted).toBe(0);
      expect(await sqliteCache.get('live')).toEqual('value');
    });
  });

  describe('fallback to in-memory', () => {
    it('init(":memory:") returns a working in-memory database', async () => {
      // beforeEach already called init(':memory:') — verify it works
      await sqliteCache.set('mem-test', { inMemory: true }, 60000);
      expect(await sqliteCache.get('mem-test')).toEqual({ inMemory: true });
    });
  });
});
