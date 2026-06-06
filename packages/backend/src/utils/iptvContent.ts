export type IptvContentType = 'tv' | 'movie' | 'series';

interface IptvClassificationInput {
    name?: string | null;
    group?: string | null;
    url?: string | null;
    tvgType?: string | null;
}

export interface MovieInfo {
    title: string;
    year?: number;
}

export interface SeriesEpisodeInfo {
    seriesName: string;
    season?: number;
    episode?: number;
    episodeTitle?: string;
}

export interface StreamTechnicalInfo {
    resolution?: string;
    quality?: string;
    codec?: string;
    audio?: string;
    language?: string;
    container?: string;
}

const MOVIE_KEYWORDS = /\b(vod|filme|filmes|movie|movies|cinema)\b/;
const SERIES_KEYWORDS = /\b(serie|series|seriado|seriados|tv shows|shows|temporada|temporadas|novela|novelas)\b/;
const VIDEO_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|3gp)(?:$|[?#])/i;
const YEAR_RE = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/;
const QUALITY_RE = /\b(2160p|1080p|720p|480p|4k|uhd|hdr|bluray|brrip|webrip|web-dl|hdtv|x264|x265|hevc|aac|dual audio|dublado|legendado)\b/gi;
const RESOLUTION_RE = /\b(2160p|1080p|720p|576p|540p|480p|360p|4k|uhd)\b/i;
const SOURCE_RE = /\b(bluray|blu-ray|brrip|webrip|web-rip|web-dl|webdl|hdtv|hdrip|dvdrip|cam|ts)\b/i;
const CODEC_RE = /\b(x264|h\.?264|avc|x265|h\.?265|hevc|10bit|aac|ac3|eac3|ddp?5\.1|dts)\b/i;
const CONTAINER_RE = /\.(m3u8|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts)(?:$|[?#])/i;

const LANGUAGE_PATTERNS: Array<[RegExp, string]> = [
    [/\b(pt[-_\s]?br|brasil|brazil|portugu[eê]s|dublado|dub(?:lado)?)\b/i, 'PT-BR'],
    [/\b(en|eng|english|ingl[eê]s)\b/i, 'EN'],
    [/\b(es|esp|spa|spanish|espanhol|castellano|latino)\b/i, 'ES'],
    [/\b(fr|fre|fra|french|franc[eê]s)\b/i, 'FR'],
    [/\b(it|ita|italian|italiano)\b/i, 'IT'],
    [/\b(de|ger|deu|german|alem[aã]o)\b/i, 'DE'],
    [/\b(jp|jpn|japanese|japon[eê]s)\b/i, 'JA'],
    [/\b(ko|kor|korean|coreano)\b/i, 'KO'],
];

const EPISODE_PATTERNS = [
    /^(.*?)\s*[.\-_\s]*(?:s|season)\s*(\d{1,2})\s*[.\-_\s]*(?:e|ep|episode)\s*(\d{1,3})(?:\s*[-._ ]+\s*(.*))?$/i,
    /^(.*?)\s*[.\-_\s]+(\d{1,2})x(\d{1,3})(?:\s*[-._ ]+\s*(.*))?$/i,
    /^(.*?)\s*[.\-_\s]*(?:t|temp|temporada)\s*(\d{1,2})\s*[.\-_\s]*(?:e|ep|episodio)\s*(\d{1,3})(?:\s*[-._ ]+\s*(.*))?$/i,
];

function fold(value?: string | null) {
    return (value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function normalizeExplicitType(value?: string | null): IptvContentType | null {
    const normalized = fold(value).trim();
    if (!normalized) return null;
    if (['tv', 'live', 'channel', 'channels'].includes(normalized)) return 'tv';
    if (['movie', 'movies', 'filme', 'filmes', 'vod'].includes(normalized)) return 'movie';
    if (['series', 'serie', 'show', 'shows'].includes(normalized)) return 'series';
    return null;
}

function extractYear(value: string): number | undefined {
    const match = YEAR_RE.exec(value);
    if (!match) return undefined;
    const year = parseInt(match[1], 10);
    return Number.isFinite(year) ? year : undefined;
}

export function cleanIptvTitle(value?: string | null) {
    const title = (value || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\((?:19|20)\d{2}\)/g, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(QUALITY_RE, ' ')
        .replace(/[._]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return title || (value || '').trim() || 'Unknown';
}

export function parseMovieInfo(name?: string | null): MovieInfo {
    const rawName = (name || '').trim();
    return {
        title: cleanIptvTitle(rawName),
        year: extractYear(rawName),
    };
}

export function parseSeriesEpisode(name?: string | null): SeriesEpisodeInfo | null {
    const rawName = (name || '').trim();
    if (!rawName) return null;

    for (const pattern of EPISODE_PATTERNS) {
        const match = pattern.exec(rawName);
        if (!match) continue;
        const seriesName = cleanIptvTitle(match[1]);
        const season = parseInt(match[2], 10);
        const episode = parseInt(match[3], 10);
        const episodeTitle = cleanIptvTitle(match[4] || '');
        return {
            seriesName,
            season: Number.isFinite(season) ? season : undefined,
            episode: Number.isFinite(episode) ? episode : undefined,
            ...(episodeTitle && episodeTitle !== 'Unknown' ? { episodeTitle } : {}),
        };
    }

    return null;
}

export function classifyIptvItem(input: IptvClassificationInput): IptvContentType {
    const explicit = normalizeExplicitType(input.tvgType);
    if (explicit) return explicit;

    const name = fold(input.name);
    const group = fold(input.group);
    const url = fold(input.url);

    if (/\/live(?:\/|$)/.test(url)) return 'tv';
    if (/\/series(?:\/|$)/.test(url)) return 'series';
    if (/\/movie(?:\/|$)/.test(url)) return 'movie';

    if (parseSeriesEpisode(input.name)) return 'series';
    if (SERIES_KEYWORDS.test(group)) return 'series';

    const hasMovieGroup = MOVIE_KEYWORDS.test(group);
    const hasVodPath = /\/vod(?:\/|$)/.test(url);
    const hasVodFile = VIDEO_FILE_RE.test(input.url || '');
    const hasYear = YEAR_RE.test(name);

    if (hasMovieGroup && (hasVodPath || hasVodFile || hasYear)) return 'movie';
    if (hasVodPath || hasVodFile) return 'movie';

    return 'tv';
}

function firstMatchLabel(value: string, re: RegExp) {
    const match = re.exec(value);
    if (!match) return undefined;
    return match[1]
        .replace(/^webdl$/i, 'WEB-DL')
        .replace(/^web-rip$/i, 'WEBRip')
        .replace(/^blu-ray$/i, 'BluRay')
        .toUpperCase();
}

function normalizeLanguage(value?: string | null) {
    const text = fold(value).trim();
    if (!text) return undefined;
    for (const [pattern, label] of LANGUAGE_PATTERNS) {
        if (pattern.test(value || '')) return label;
    }
    if (/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(text)) return text.toUpperCase().replace('_', '-');
    return undefined;
}

export function inferStreamTechnicalInfo(item: any, url?: string | null): StreamTechnicalInfo {
    const haystack = [
        item?.name,
        item?.originalName,
        item?.episodeTitle,
        item?.seriesName,
        item?.category,
        item?.containerExtension,
        item?.container_extension,
        item?.quality,
        item?.rating,
        url,
    ].filter(Boolean).join(' ');

    const resolutionMatch = RESOLUTION_RE.exec(haystack);
    const rawResolution = resolutionMatch?.[1];
    const resolution = rawResolution
        ? rawResolution.toLowerCase() === '4k' || rawResolution.toLowerCase() === 'uhd'
            ? '4K'
            : rawResolution.toLowerCase()
        : undefined;

    const language =
        normalizeLanguage(item?.language) ||
        normalizeLanguage(item?.attributes?.['tvg-language']) ||
        normalizeLanguage(item?.attributes?.['tvg-country']) ||
        normalizeLanguage(haystack);

    const audio = /\bdual(?:\s+audio)?\b/i.test(haystack)
        ? 'Dual Audio'
        : /\bdublado|dub(?:lado)?\b/i.test(haystack)
            ? 'Dublado'
            : /\blegendado|leg(?:endado)?|sub(?:bed|title|s)?\b/i.test(haystack)
                ? 'Legendado'
                : undefined;

    const container =
        item?.containerExtension ||
        item?.container_extension ||
        CONTAINER_RE.exec(url || item?.url || '')?.[1];

    return {
        resolution,
        quality: firstMatchLabel(haystack, SOURCE_RE),
        codec: firstMatchLabel(haystack, CODEC_RE),
        audio,
        language,
        container: container ? String(container).replace(/^\./, '').toUpperCase() : undefined,
    };
}
