/**
 * hlsProxy.ts — NexoTV HLS Reverse Proxy
 *
 * Provides two signed endpoints consumed by Stremio clients:
 *
 *   GET /proxy/hls/playlist?token=…&url=…[&ua=…][&ref=…][&ori=…]
 *     Downloads the upstream M3U8 playlist, rewrites every segment / sub-playlist
 *     URL to route through this proxy, and returns the patched content.
 *
 *   GET /proxy/hls/segment?token=…&url=…[&ua=…][&ref=…][&ori=…]
 *     Fetches the upstream binary (TS segment, M4S chunk, AES-128 key, …) and
 *     pipes it straight to the client.
 *
 * All URLs are signed with HMAC-SHA256 derived from CONFIG_SECRET so that
 * external parties cannot use this as an open proxy.
 *
 * Why this is necessary for Stremio Android TV
 * ─────────────────────────────────────────────
 * • behaviorHints.proxyHeaders is ONLY honoured by the Stremio Web / Desktop
 *   clients.  Android TV's internal players (ExoPlayer, libVLC, MPV) receive
 *   the raw stream URL and open it themselves — without any custom headers.
 * • Many IPTV servers reject connections that lack a specific User-Agent or
 *   Referer, causing a silent playback failure on TV while mobile still works.
 * • HLS playlists contain relative segment URLs that reference the origin
 *   server.  Without rewriting, ExoPlayer would fetch segments directly from
 *   the IPTV server (again, without headers) and fail.
 * • Some Xtream servers respond with HTTP → HTTPS redirects that ExoPlayer
 *   refuses to follow across protocols; the proxy absorbs those redirects.
 */

import { Router, Request, Response } from 'express';
import {
    decodeParam,
    verifyProxyToken,
    rewriteM3U8,
    ProxyHeaders,
} from '../utils/proxyUtils';
import { makeLogger } from '../utils/logger';

const router = Router();
const log = makeLogger();

// Generous timeout: live HLS master playlists on congested servers can be slow
const PROXY_TIMEOUT_MS = 30_000;

/**
 * Default User-Agent sent upstream when the stream has no custom UA configured.
 * Matches a common Android browser UA so Xtream servers are least likely to block it.
 */
const DEFAULT_UA =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';

// ── Internal helpers ──────────────────────────────────────────────────────────

async function upstreamFetch(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers,
            redirect: 'follow',          // absorb HTTP→HTTPS redirects server-side
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

interface ExtractResult {
    targetUrl: string;
    upstreamHeaders: Record<string, string>;
    proxyHeaders: ProxyHeaders;         // only non-default values — used when re-signing segment URLs
    proxyBaseUrl: string;
}

/**
 * Parse & verify the signed query string.
 * Returns null on any validation failure (bad token, missing params, bad URL).
 */
function extractAndVerify(req: Request): ExtractResult | null {
    const q = req.query as Record<string, string>;
    const { url: urlEnc, ua: uaEnc, ref: refEnc, ori: oriEnc, token } = q;

    if (!urlEnc || !token) return null;

    // Reconstruct the params map exactly as it was when the token was signed
    const params: Record<string, string> = { url: urlEnc };
    if (uaEnc)  params.ua  = uaEnc;
    if (refEnc) params.ref = refEnc;
    if (oriEnc) params.ori = oriEnc;

    if (!verifyProxyToken(token, params)) {
        log.warn('[PROXY] Token verification failed');
        return null;
    }

    let targetUrl: string;
    try {
        targetUrl = decodeParam(urlEnc);
    } catch {
        return null;
    }

    // Only allow HTTP(S) targets — block SSRF to local networks
    if (!/^https?:\/\//i.test(targetUrl)) return null;

    const ua  = uaEnc  ? decodeParam(uaEnc)  : DEFAULT_UA;
    const ref = refEnc ? decodeParam(refEnc)  : undefined;
    const ori = oriEnc ? decodeParam(oriEnc)  : undefined;

    const upstreamHeaders: Record<string, string> = { 'User-Agent': ua };
    if (ref) upstreamHeaders['Referer'] = ref;
    if (ori) upstreamHeaders['Origin']  = ori;

    // proxyHeaders: only carry non-default values forward into rewritten URLs
    const proxyHeaders: ProxyHeaders = {
        userAgent: ua !== DEFAULT_UA ? ua : undefined,
        referer: ref,
        origin: ori,
    };

    const proxyBaseUrl = `${req.protocol}://${req.get('host')}`;

    return { targetUrl, upstreamHeaders, proxyHeaders, proxyBaseUrl };
}

// ── /proxy/hls/playlist ───────────────────────────────────────────────────────

router.get('/proxy/hls/playlist', async (req: Request, res: Response) => {
    const ext = extractAndVerify(req);
    if (!ext) {
        res.status(403).end('Forbidden');
        return;
    }

    const { targetUrl, upstreamHeaders, proxyHeaders, proxyBaseUrl } = ext;
    log.debug('[PROXY] playlist ←', { url: targetUrl });

    let upstream: globalThis.Response;
    try {
        upstream = await upstreamFetch(targetUrl, upstreamHeaders, PROXY_TIMEOUT_MS);
    } catch (e: any) {
        log.error('[PROXY] playlist fetch error', e.message);
        if (!res.headersSent) res.status(502).end('Bad Gateway');
        return;
    }

    if (!upstream.ok) {
        log.warn('[PROXY] playlist upstream error', { status: upstream.status, url: targetUrl });
        res.status(upstream.status).end();
        return;
    }

    let text: string;
    try {
        text = await upstream.text();
    } catch (e: any) {
        log.error('[PROXY] playlist read error', e.message);
        if (!res.headersSent) res.status(502).end();
        return;
    }

    // If the response body is not an M3U8 (e.g. the server returned a redirect
    // page or an error page after a 200), pass it through without rewriting.
    if (!text.includes('#EXTM3U') && !text.includes('#EXT-X-')) {
        const ct = upstream.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', ct);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(text);
        return;
    }

    // `upstream.url` is the final URL after redirects — needed to correctly
    // resolve any relative segment paths inside the playlist.
    const resolvedUrl = upstream.url || targetUrl;
    const rewritten = rewriteM3U8(text, resolvedUrl, proxyBaseUrl, proxyHeaders);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(rewritten);
});

// ── /proxy/hls/segment ────────────────────────────────────────────────────────

router.get('/proxy/hls/segment', async (req: Request, res: Response) => {
    const ext = extractAndVerify(req);
    if (!ext) {
        res.status(403).end('Forbidden');
        return;
    }

    const { targetUrl, upstreamHeaders } = ext;
    log.debug('[PROXY] segment ←', { url: targetUrl });

    let upstream: globalThis.Response;
    try {
        upstream = await upstreamFetch(targetUrl, upstreamHeaders, PROXY_TIMEOUT_MS);
    } catch (e: any) {
        log.error('[PROXY] segment fetch error', e.message);
        if (!res.headersSent) res.status(502).end();
        return;
    }

    if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
    }

    // Forward relevant response headers
    const contentType   = upstream.headers.get('content-type')   || 'video/mp2t';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Stream the binary body directly to the HTTP response.
    // Using getReader() avoids buffering the entire segment in RAM — important
    // for live MPEG-TS streams which may be continuous (no Content-Length).
    if (!upstream.body) {
        // Fallback for environments that don't expose a streaming body
        const buf = await upstream.arrayBuffer();
        res.end(Buffer.from(buf));
        return;
    }

    const reader = upstream.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Stop writing if the client has already disconnected
            if (res.destroyed || !res.writable) break;
            res.write(Buffer.from(value));
        }
    } catch (e: any) {
        log.debug('[PROXY] segment stream interrupted', e.message);
    } finally {
        reader.releaseLock();
    }

    if (!res.writableEnded) res.end();
});

export default router;
