import { describe, it, expect, vi } from 'vitest';

// Mock all side-effectful dependencies before importing M3UEPGAddon.
// CACHE_ENABLED=false prevents the module-level sqliteCache.init() call.
vi.mock('../../src/config/env', () => ({
  default: {
    DEBUG: false,
    CACHE_ENABLED: false,
    CACHE_TTL_MS: 21600000,
    MAX_CACHE_ENTRIES: 300,
    IPTV_ORG_CACHE_TTL_MS: 21600000,
    M3U_CACHE_TTL_MS: 21600000,
    DATA_MEMORY_TTL_MS: 300000,
    UPDATE_INTERVAL_MS: 14400000,
    FETCH_TIMEOUT_MS: 30000,
    SQLITE_PATH: null,
  },
  repoRoot: '/tmp',
}));

vi.mock('../../src/utils/sqliteCache', () => ({
  init: vi.fn(),
  get: vi.fn(() => null),
  set: vi.fn(),
  setRaw: vi.fn(),
  getRaw: vi.fn(() => null),
  del: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../src/providers/xtreamProvider', () => ({ fetchData: vi.fn() }));
vi.mock('../../src/providers/iptvOrgProvider', () => ({ fetchData: vi.fn() }));
vi.mock('../../src/providers/m3uProvider', () => ({ fetchData: vi.fn() }));

vi.mock('../../src/parsers/epgParser', () => ({
  parseEPG: vi.fn(),
  getCurrentProgram: vi.fn(),
  getUpcomingPrograms: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  makeLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createCacheKey, M3UEPGAddon } from '../../src/addon/M3UEPGAddon';

// ─── createCacheKey ──────────────────────────────────────────────────────────

describe('createCacheKey', () => {
  it('produces the same key for configs with different key order', () => {
    const key1 = createCacheKey({
      provider: 'xtream',
      xtreamUrl: 'http://a.com',
      xtreamUsername: 'user',
      enableEpg: false,
      reformatLogos: false,
    });
    const key2 = createCacheKey({
      xtreamUsername: 'user',
      provider: 'xtream',
      enableEpg: false,
      xtreamUrl: 'http://a.com',
      reformatLogos: false,
    });
    expect(key1).toBe(key2);
  });

  it('produces different keys for different providers', () => {
    const key1 = createCacheKey({ provider: 'xtream', xtreamUrl: 'http://a.com' });
    const key2 = createCacheKey({ provider: 'm3u', m3uUrl: 'http://a.com' });
    expect(key1).not.toBe(key2);
  });

  it('strips non-essential fields (e.g., instanceId)', () => {
    const key1 = createCacheKey({
      provider: 'iptv-org',
      iptvOrgCountry: 'US',
      iptvOrgCategory: 'sports',
    });
    // instanceId is not part of the canonical minimal config for iptv-org
    const key2 = createCacheKey({
      provider: 'iptv-org',
      iptvOrgCountry: 'US',
      iptvOrgCategory: 'sports',
      instanceId: 'some-unique-id',
    });
    expect(key1).toBe(key2);
  });
});

// ─── generateMetaPreview ─────────────────────────────────────────────────────

describe('generateMetaPreview', () => {
  it('maps channel to Stremio meta preview shape', () => {
    const addon = new M3UEPGAddon({ provider: 'xtream', reformatLogos: false });
    const item = {
      id: 'xc_123',
      name: 'Test Channel',
      logo: 'http://logo.example.com/test.png',
      category: 'Sports',
    };
    const meta = addon.generateMetaPreview(item);
    expect(meta.id).toBe('xc_123');
    expect(meta.type).toBe('tv');
    expect(meta.name).toBe('Test Channel');
    expect(meta).toHaveProperty('poster');
  });

  it('includes id, type=tv, name, poster', () => {
    const addon = new M3UEPGAddon({ provider: 'xtream', reformatLogos: false });
    const item = { id: 'xc_456', name: 'Movie Channel', logo: '', category: 'Movies' };
    const meta = addon.generateMetaPreview(item);
    expect(meta).toMatchObject({ id: 'xc_456', type: 'tv', name: 'Movie Channel' });
    expect(typeof meta.poster).toBe('string');
    expect(meta.poster.length).toBeGreaterThan(0);
  });
});

// ─── matchesCatalogSearch ───────────────────────────────────────────────────

describe('matchesCatalogSearch', () => {
  it('matches normalized movie titles with punctuation and year', () => {
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    const item = {
      name: 'The.Matrix.1999.1080p.WEB-DL',
      originalName: 'The.Matrix.1999.1080p.WEB-DL',
      category: 'Filmes',
      year: 1999,
    };

    expect(addon.matchesCatalogSearch(item, 'the matrix')).toBe(true);
    expect(addon.matchesCatalogSearch(item, '1999')).toBe(true);
  });

  it('matches normalized series titles with accents', () => {
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    const item = {
      name: 'La.Casa.De.Papel.S01E01',
      originalName: 'La.Casa.De.Papel.S01E01',
      seriesName: 'La Casa de Papel',
      episodeTitle: 'Episodio 1',
      category: 'Séries',
    };

    expect(addon.matchesCatalogSearch(item, 'la casa de papel')).toBe(true);
    expect(addon.matchesCatalogSearch(item, 'series')).toBe(true);
  });

  it('matches titles through tvg-name when the visible name is noisy', () => {
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    const item = {
      name: 'S01E01 1080p WEB-DL',
      originalName: 'S01E01 1080p WEB-DL',
      category: 'Séries',
      attributes: { 'tvg-name': 'Better Call Saul' },
    };

    expect(addon.matchesCatalogSearch(item, 'better call saul')).toBe(true);
  });
});

// ─── deriveFallbackLogoUrl ───────────────────────────────────────────────────

describe('deriveFallbackLogoUrl', () => {
  it('returns original URL for standard image', () => {
    const addon = new M3UEPGAddon({ provider: 'xtream', reformatLogos: false });
    const item = { name: 'Test', logo: 'http://example.com/logo.png' };
    expect(addon.deriveFallbackLogoUrl(item)).toBe('http://example.com/logo.png');
  });

  it('proxies imgur URLs through wsrv.nl when reformatLogos=true', () => {
    // For xtream provider, reformatLogos is not forced to true by the constructor
    const addon = new M3UEPGAddon({ provider: 'xtream' });
    addon.config.reformatLogos = true;
    const item = { name: 'Test', logo: 'https://i.imgur.com/abc123.png' };
    const url = addon.deriveFallbackLogoUrl(item);
    expect(url).toContain('wsrv.nl');
  });
});

// ─── Background Update Timer ──────────────────────────────────────────────────

describe('_startUpdateTimer', () => {
  it('is idempotent — calling twice does not create two timers', () => {
    vi.useFakeTimers();
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    (addon as any)._startUpdateTimer();
    const first = (addon as any)._updateTimer;
    (addon as any)._startUpdateTimer();
    const second = (addon as any)._updateTimer;
    expect(first).toBe(second);
    vi.useRealTimers();
  });

  it('sets _updateTimer to a non-null value', () => {
    vi.useFakeTimers();
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    expect((addon as any)._updateTimer).toBeNull();
    (addon as any)._startUpdateTimer();
    expect((addon as any)._updateTimer).not.toBeNull();
    vi.useRealTimers();
  });
});

describe('_evictFromMemory timer cleanup', () => {
  it('sets _updateTimer to null after eviction', () => {
    vi.useFakeTimers();
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    (addon as any)._startUpdateTimer();
    expect((addon as any)._updateTimer).not.toBeNull();
    addon._evictFromMemory();
    expect((addon as any)._updateTimer).toBeNull();
    vi.useRealTimers();
  });

  it('does not trigger updateData after eviction (ghost-config prevention)', async () => {
    vi.useFakeTimers();
    const addon = new M3UEPGAddon({ provider: 'm3u' });
    const spy = vi.spyOn(addon, 'updateData').mockResolvedValue(undefined);
    (addon as any)._startUpdateTimer();
    addon._evictFromMemory();
    // Advance well past update interval — should NOT trigger updateData
    vi.advanceTimersByTime(14400000 * 3);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});


describe('VOD catalog support', () => {
  it('maps movie items to movie meta previews', () => {
    const addon = new M3UEPGAddon({ provider: 'm3u', reformatLogos: false });
    const meta = addon.generateMetaPreview({
      id: 'm3_movie_1',
      type: 'movie',
      name: 'Example Movie',
      logo: '',
      category: 'Filmes',
      year: 2024,
    });

    expect(meta).toMatchObject({
      id: 'm3_movie_1',
      type: 'movie',
      name: 'Example Movie',
      releaseInfo: '2024',
    });
  });

  it('returns VOD streams for external IMDb ids when tvg-id matches', async () => {
    const addon = new M3UEPGAddon({ provider: 'm3u', reformatLogos: false });
    addon.channels = [
      {
        id: 'm3_movie_1',
        type: 'movie',
        name: 'Example Movie',
        url: 'http://stream.example.com/movie.mp4',
        attributes: { 'tvg-id': 'tt1234567' },
      },
    ];
    addon.channelMap = new Map(addon.channels.map((item: any) => [item.id, item]));

    const streams = await addon.getStreams('movie', 'tt1234567');
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      url: 'http://stream.example.com/movie.mp4',
      title: 'Example Movie - Movie',
    });
    addon._evictFromMemory();
  });

  it('adds resolution, language and audio details to stream titles when available', async () => {
    const addon = new M3UEPGAddon({ provider: 'm3u', reformatLogos: false });
    addon.channels = [
      {
        id: 'm3_movie_2',
        type: 'movie',
        name: 'Example Movie',
        originalName: 'Example.Movie.2024.1080p.WEB-DL.Dual.Audio.PT-BR.x265',
        url: 'http://stream.example.com/example-movie.mkv',
        language: 'pt-BR',
      },
    ];
    addon.channelMap = new Map(addon.channels.map((item: any) => [item.id, item]));

    const streams = await addon.getStreams('movie', 'm3_movie_2');
    expect(streams[0].title).toBe('Example Movie - Movie');
    expect(streams[0].name).toContain('FHD');
    expect(streams[0].description).toContain('Resolution: FHD');
    expect(streams[0].description).toContain('Language: PT-BR');
    expect(streams[0].description).toContain('Audio: Dual Audio');
    addon._evictFromMemory();
  });

  it('groups series episodes into a series catalog item with videos', () => {
    const addon = new M3UEPGAddon({ provider: 'm3u', reformatLogos: false });
    addon.channels = [
      {
        id: 'm3_ep_2',
        type: 'series',
        name: 'Example Show S01E02',
        seriesName: 'Example Show',
        season: 1,
        episode: 2,
        url: 'http://stream.example.com/ep2.mp4',
        category: 'Series',
      },
      {
        id: 'm3_ep_1',
        type: 'series',
        name: 'Example Show S01E01',
        seriesName: 'Example Show',
        season: 1,
        episode: 1,
        url: 'http://stream.example.com/ep1.mp4',
        category: 'Series',
      },
    ];

    const seriesItems = addon.buildSeriesCatalogItems();
    expect(seriesItems).toHaveLength(1);
    expect(seriesItems[0]).toMatchObject({ type: 'series', name: 'Example Show', episodeCount: 2 });

    const meta = (addon as any).buildSeriesDetailedMeta(seriesItems[0]);
    expect(meta.videos.map((v: any) => v.id)).toEqual(['m3_ep_1', 'm3_ep_2']);
  });

  it('loads Xtream series episodes lazily for series metadata and streams', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        episodes: {
          1: [
            { id: 101, title: 'Pilot', season: 1, episode_num: 1, container_extension: 'mkv' },
          ],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const addon = new M3UEPGAddon({
      provider: 'xtream',
      xtreamUrl: 'http://xtream.example.com',
      xtreamUsername: 'user',
      xtreamPassword: 'pass',
      reformatLogos: false,
    });
    addon.idPrefix = 'abc12345';
    const series = {
      id: 'xcabc12345_series_55',
      type: 'series',
      name: 'Example Show',
      xtreamSeriesId: 55,
      category: 'Series',
      logo: '',
      episodes: [],
    };
    addon.channels = [series];
    addon.channelMap = new Map([[series.id, series]]);

    const meta: any = await addon.getDetailedMeta(series.id);
    expect(meta.videos).toEqual([
      expect.objectContaining({
        id: 'xcabc12345_series_ep_101',
        title: 'Pilot',
        season: 1,
        episode: 1,
      }),
    ]);

    const streams = await addon.getStreams('series', 'xcabc12345_series_ep_101');
    expect(streams[0]).toMatchObject({
      url: 'http://xtream.example.com/series/user/pass/101.mkv',
      title: 'Example Show S01E01 - Episode',
    });

    vi.unstubAllGlobals();
  });
});
