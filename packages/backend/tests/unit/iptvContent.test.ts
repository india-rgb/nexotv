import { describe, it, expect } from 'vitest';
import { classifyIptvItem, parseMovieInfo, parseSeriesEpisode } from '../../src/utils/iptvContent';

describe('iptv content classification', () => {
  it('keeps live channels in movie-themed groups as tv without VOD signals', () => {
    expect(classifyIptvItem({
      name: 'HBO',
      group: 'Movies',
      url: 'http://stream.example.com/live/hbo/index.m3u8',
    })).toBe('tv');
  });

  it('classifies explicit and URL-based movie items', () => {
    expect(classifyIptvItem({
      name: 'Example Film (2025)',
      group: 'Filmes',
      url: 'http://iptv.example.com/movie/user/pass/123.mp4',
    })).toBe('movie');
    expect(classifyIptvItem({ name: 'Any Title', tvgType: 'vod' })).toBe('movie');
  });

  it('classifies series episodes by URL or episode notation', () => {
    expect(classifyIptvItem({
      name: 'Example Show S02E03 - Third',
      group: 'Series',
      url: 'http://iptv.example.com/series/user/pass/456.mkv',
    })).toBe('series');
    expect(classifyIptvItem({ name: 'Another Show 1x02', group: 'TV Shows' })).toBe('series');
  });

  it('extracts clean movie and episode metadata', () => {
    expect(parseMovieInfo('My Movie (2024) 1080p').title).toBe('My Movie');
    expect(parseMovieInfo('My Movie (2024)').year).toBe(2024);
    expect(parseSeriesEpisode('My Show S01E02 - Pilot')).toMatchObject({
      seriesName: 'My Show',
      season: 1,
      episode: 2,
      episodeTitle: 'Pilot',
    });
  });
});
