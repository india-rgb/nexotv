/**
 * proxyUtils.ts
 *
 * Utilities for the NexoTV HLS proxy:
 *  - HMAC-SHA256 signing / verification of proxy URLs (anti-abuse)
 *  - Building proxy URLs for playlists and segments
 *  - Rewriting M3U8 playlists so all segment URLs route through the proxy
 *
 * Security model:
 *   The HMAC key is derived from CONFIG_SECRET (already used for addon config
 *   encryption). When CONFIG_SECRET is absent or too short, a default is used
 *   so the proxy still works in development.
 *
 * All URL parameters are base64url-encoded to avoid special-character issues
 * in query strings. The HMAC covers the sorted non-token params, so parameter
 * order does not affect verification.
 */

import crypto from 'crypto';
import env from '../config/env';

// ── Secret derivation ─────────────────────────────────────────────────────────

const FALLBACK_PROXY_SECRET = 'nexotv-proxy-hmac-fallback-2024';

function getProxySecret(): string {
    const secret = env.CONFIG_SECRET;
    if (secret && secret.length >= 8) return secret;
    return FALLBACK_PROXY_SECRET;
}

// ── Base64url encode / decode ─────────────────────────────────────────────────

export function encodeParam(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeParam(value: string): string {
    // Accept both base64url (with - _) and standard base64 (with + /)
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);
    return Buffer.from(padded, 'base64').toString('utf8');
}

// ── HMAC signing ──────────────────────────────────────────────────────────────

/**
 * Compute a 24-hex-char HMAC-SHA256 over the sorted query params
 * (the 'token' key itself is excluded from the computation).
 */
export function signProxyParams(params: Record<string, string>): string {
    const secret = getProxySecret();
    const payload = Object.keys(params)
        .filter(k => k !== 'token')
        .sort()
        .map(k => `${k}=${params[k]}`)
        .join('&');
    return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 24);
}

/**
 * Constant-time comparison: returns true iff the supplied token is valid.
 */
export function verifyProxyToken(token: string, params: Record<string, string>): boolean {
    try {
        const expected = signProxyParams(params);
        if (token.length !== expected.length) return false;
        return crypto.timingSafeEqual(
            Buffer.from(token, 'utf8'),
            Buffer.from(expected, 'utf8'),
        );
    } catch {
        return false;
    }
}

// ── Header bag type ───────────────────────────────────────────────────────────

/** Headers that may need to be forwarded to the upstream IPTV server. */
export interface ProxyHeaders {
    userAgent?: string;
    referer?: string;
    origin?: string;
}

// ── Proxy URL builder ─────────────────────────────────────────────────────────

/**
 * Build a signed proxy URL for either a playlist (.m3u8) or a segment (.ts / .m4s / .key).
 *
 * @param type        'playlist' → /proxy/hls/playlist  |  'segment' → /proxy/hls/segment
 * @param targetUrl   The real upstream URL to be fetched by the proxy
 * @param headers     Optional headers to embed (User-Agent, Referer, Origin)
 * @param addonBaseUrl Base URL of the addon server (e.g. "https://nexotv.onrender.com")
 */
export function buildProxyUrl(
    type: 'playlist' | 'segment',
    targetUrl: string,
    headers: ProxyHeaders,
    addonBaseUrl: string,
): string {
    const params: Record<string, string> = {
        url: encodeParam(targetUrl),
    };
    if (headers.userAgent) params.ua  = encodeParam(headers.userAgent);
    if (headers.referer)   params.ref = encodeParam(headers.referer);
    if (headers.origin)    params.ori = encodeParam(headers.origin);

    // Sign BEFORE serialising so the token is included in the final QS
    params.token = signProxyParams(params);

    // Alphabetical order for predictable, cache-friendly URLs
    const qs = new URLSearchParams(
        Object.keys(params).sort().map(k => [k, params[k]]),
    ).toString();

    return `${addonBaseUrl}/proxy/hls/${type}?${qs}`;
}

// ── URL resolution helper ─────────────────────────────────────────────────────

function resolveUrl(url: string, base: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
        return new URL(url, base).href;
    } catch {
        return url;
    }
}

function isSubPlaylist(url: string): boolean {
    const path = url.split('?')[0].toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.m3u');
}

// ── HLS line rewriter ─────────────────────────────────────────────────────────

/**
 * Rewrite any URI="…" attribute inside a tag line (EXT-X-KEY, EXT-X-MAP, etc.)
 * so the URI goes through the proxy's segment endpoint.
 */
function rewriteUriAttr(
    line: string,
    baseUrl: string,
    proxyBaseUrl: string,
    headers: ProxyHeaders,
): string {
    return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
        const absolute = resolveUrl(uri, baseUrl);
        return `URI="${buildProxyUrl('segment', absolute, headers, proxyBaseUrl)}"`;
    });
}

/**
 * Rewrite an M3U8 playlist so that:
 *  - All segment lines (.ts / .m4s / unrecognised) → /proxy/hls/segment
 *  - All sub-playlist lines (.m3u8) → /proxy/hls/playlist
 *  - EXT-X-KEY / EXT-X-MAP URI attributes → /proxy/hls/segment (AES-128 & fMP4 init)
 *
 * @param content         Raw M3U8 text as returned by the upstream server
 * @param resolvedBaseUrl The final URL after any HTTP redirects (for resolving relative paths)
 * @param proxyBaseUrl    Addon server base URL used to build absolute proxy URLs
 * @param headers         Headers that were used to fetch the playlist (forwarded to segments)
 */
export function rewriteM3U8(
    content: string,
    resolvedBaseUrl: string,
    proxyBaseUrl: string,
    headers: ProxyHeaders,
): string {
    const lines = content.split('\n');
    const result: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // ── Empty lines ──
        if (!trimmed) {
            result.push(line);
            continue;
        }

        // ── AES-128 decryption key ──
        if (trimmed.startsWith('#EXT-X-KEY:') && trimmed.includes('URI="')) {
            result.push(rewriteUriAttr(trimmed, resolvedBaseUrl, proxyBaseUrl, headers));
            continue;
        }

        // ── fMP4 / CMAF init segment ──
        if (trimmed.startsWith('#EXT-X-MAP:') && trimmed.includes('URI="')) {
            result.push(rewriteUriAttr(trimmed, resolvedBaseUrl, proxyBaseUrl, headers));
            continue;
        }

        // ── Other tags — pass through unchanged ──
        if (trimmed.startsWith('#')) {
            result.push(line);
            continue;
        }

        // ── Segment / sub-playlist URL line ──
        const absoluteUrl = resolveUrl(trimmed, resolvedBaseUrl);
        const proxyType: 'playlist' | 'segment' = isSubPlaylist(absoluteUrl) ? 'playlist' : 'segment';
        result.push(buildProxyUrl(proxyType, absoluteUrl, headers, proxyBaseUrl));
    }

    return result.join('\n');
}

// ── Proxy eligibility ─────────────────────────────────────────────────────────

/**
 * Decide whether a stream URL needs to go through the proxy.
 *
 * Rules (in priority order):
 *  1. Always proxy HLS playlists (.m3u8) — segments need rewriting
 *  2. Always proxy when custom headers are present (proxyHeaders is ignored by Android TV)
 *  3. MP4 over HTTPS without custom headers → skip proxy (ExoPlayer handles natively)
 *  4. Everything else (TS, MKV, M4S, M4V, …) → proxy
 */
export function shouldProxy(url: string, hasCustomHeaders: boolean): boolean {
    if (!url) return false;
    const urlPath = url.split('?')[0].toLowerCase();

    // Rule 1 — always proxy HLS
    if (urlPath.endsWith('.m3u8')) return true;

    // Rule 2 — custom headers require proxy (proxyHeaders not honoured on Android TV)
    if (hasCustomHeaders) return true;

    // Rule 3 — native MP4 HTTPS: ExoPlayer is perfectly capable
    if (url.startsWith('https://') && urlPath.endsWith('.mp4')) return false;

    // Rule 4 — all remaining formats through the proxy
    return true;
}
