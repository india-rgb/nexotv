import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { createClient } from 'redis';
import { makeLogger } from './logger';
import env from '../config/env';

const log = makeLogger();

let db: Database.Database | null = null;
let dbPathForFallback: string | null = null;
let redisClient: ReturnType<typeof createClient> | null = null;
let redisReady: Promise<void> | null = null;
let redisEnabled = false;

function redisKey(key: string) {
    return `${env.REDIS_KEY_PREFIX}${key}`;
}

function initSqlite(dbPath: string | null) {
    if (db) return db;

    const { repoRoot } = require('../config/env');
    const resolvedPath = dbPath || path.resolve(repoRoot, 'data', 'cache.sqlite');
    const dir = path.dirname(resolvedPath);

    const fs = require('fs');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        db = new Database(resolvedPath);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
    } catch {
        // SQLite fails on Windows bind mounts in Docker (SQLITE_IOERR_SHMOPEN).
        // Fall back to in-memory cache — safe since this is pure cache (no primary data).
        log.warn('SQLite persistent cache unavailable (filesystem limitation), using in-memory cache — data will not survive restarts');
        try { db?.close(); } catch {}
        for (const ext of ['', '-shm', '-wal']) {
            try { fs.unlinkSync(resolvedPath + ext); } catch {}
        }
        db = new Database(':memory:');
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS CacheEntry (
            key TEXT PRIMARY KEY,
            value BLOB,
            expires_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_expires ON CacheEntry(expires_at);
    `);

    log.debug('SQLite cache initialized', { path: resolvedPath });
    return db;
}

export function init(dbPath: string | null) {
    dbPathForFallback = dbPath;

    if (env.REDIS_URL && !redisClient && !redisReady) {
        redisClient = createClient({ url: env.REDIS_URL });
        redisClient.on('error', (error: any) => {
            log.warn('Redis cache error; SQLite fallback remains available', { error: error?.message });
        });
        redisReady = redisClient.connect()
            .then(() => {
                redisEnabled = true;
                log.debug('Redis cache initialized', { url: env.REDIS_URL, prefix: env.REDIS_KEY_PREFIX });
            })
            .catch((error: any) => {
                redisEnabled = false;
                redisClient = null;
                log.warn('Redis cache unavailable, using SQLite fallback', { error: error?.message });
                initSqlite(dbPathForFallback);
            });
        return null;
    }

    if (!env.REDIS_URL) return initSqlite(dbPath);
    return null;
}

async function getRedis() {
    if (!redisReady) return null;
    await redisReady;
    if (!redisEnabled || !redisClient?.isOpen) return null;
    return redisClient;
}

function ensureSqlite() {
    return initSqlite(dbPathForFallback);
}

function compress(obj: any) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
}

function decompress(buffer: Buffer) {
    return JSON.parse(zlib.gunzipSync(buffer).toString());
}

export async function get(key: string) {
    const redis = await getRedis();
    if (redis) {
        const raw = await redis.get(redisKey(key));
        return raw ? JSON.parse(raw) : null;
    }

    const database = ensureSqlite();
    const stmt = database.prepare('SELECT value, expires_at FROM CacheEntry WHERE key = ?');
    const row = stmt.get(key) as any;
    if (!row) return null;

    if (row.expires_at && row.expires_at < Date.now()) {
        database.prepare('DELETE FROM CacheEntry WHERE key = ?').run(key);
        log.debug('Cache expired, deleted', { key });
        return null;
    }

    try {
        return decompress(row.value);
    } catch (e: any) {
        log.error('Cache decompress error', { key, error: e.message });
        return null;
    }
}

export async function set(key: string, value: any, ttlMs: number) {
    const redis = await getRedis();
    if (redis) {
        const raw = JSON.stringify(value);
        if (ttlMs) await redis.set(redisKey(key), raw, { PX: ttlMs });
        else await redis.set(redisKey(key), raw);
        log.debug('Redis cache set', { key, bytes: raw.length, ttlMs });
        return;
    }

    const database = ensureSqlite();
    const compressed = compress(value);
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    database.prepare(
        'INSERT OR REPLACE INTO CacheEntry (key, value, expires_at) VALUES (?, ?, ?)'
    ).run(key, compressed, expiresAt);
    log.debug('Cache set', { key, bytes: compressed.length, expiresAt });
}

export async function setRaw(key: string, value: any, ttlMs: number) {
    const redis = await getRedis();
    const raw = JSON.stringify(value);
    if (redis) {
        if (ttlMs) await redis.set(redisKey(key), raw, { PX: ttlMs });
        else await redis.set(redisKey(key), raw);
        log.debug('Redis cache setRaw', { key, bytes: raw.length, ttlMs });
        return;
    }

    const database = ensureSqlite();
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    database.prepare(
        'INSERT OR REPLACE INTO CacheEntry (key, value, expires_at) VALUES (?, ?, ?)'
    ).run(key, Buffer.from(raw), expiresAt);
    log.debug('Cache setRaw', { key, bytes: raw.length, expiresAt });
}

export async function getRaw(key: string) {
    const redis = await getRedis();
    if (redis) {
        const raw = await redis.get(redisKey(key));
        return raw ? JSON.parse(raw) : null;
    }

    const database = ensureSqlite();
    const stmt = database.prepare('SELECT value, expires_at FROM CacheEntry WHERE key = ?');
    const row = stmt.get(key) as any;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) {
        database.prepare('DELETE FROM CacheEntry WHERE key = ?').run(key);
        log.debug('Cache expired, deleted', { key });
        return null;
    }
    try {
        return JSON.parse(row.value.toString());
    } catch (e: any) {
        log.error('Cache getRaw parse error', { key, error: e.message });
        return null;
    }
}

export async function del(key: string) {
    const redis = await getRedis();
    if (redis) {
        await redis.del(redisKey(key));
        return;
    }
    ensureSqlite().prepare('DELETE FROM CacheEntry WHERE key = ?').run(key);
}

export async function cleanExpired() {
    const redis = await getRedis();
    if (redis) return 0;

    const result = ensureSqlite().prepare('DELETE FROM CacheEntry WHERE expires_at < ?').run(Date.now());
    if (result.changes > 0) {
        log.debug('Cache GC: cleaned expired entries', { deleted: result.changes });
    }
    return result.changes;
}

export async function vacuum() {
    const redis = await getRedis();
    if (redis) return;

    ensureSqlite().exec('VACUUM');
    log.debug('Cache VACUUM completed');
}

export async function close() {
    if (redisClient?.isOpen) {
        await redisClient.quit();
        redisClient = null;
        redisReady = null;
        redisEnabled = false;
        log.debug('Redis cache closed');
    }
    if (db) {
        db.close();
        db = null;
        log.debug('SQLite cache closed');
    }
}
