import env from '../config/env';

function catalogExtra() {
    return [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip' }
    ];
}

export function createManifest(idPrefix?: string, catalogName?: string) {
    const baseCatalogName = catalogName || env.ADDON_NAME;

    return {
        id: 'community.nexotv',
        version: '2.0.0',
        name: env.ADDON_NAME,
        description: env.ADDON_DESCRIPTION,
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv', 'movie', 'series'],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: baseCatalogName,
                extra: catalogExtra(),
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: `${baseCatalogName} Movies`,
                extra: catalogExtra(),
                genres: []
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: `${baseCatalogName} Series`,
                extra: catalogExtra(),
                genres: []
            }
        ],
        idPrefixes: idPrefix ? [`xc${idPrefix}_`, `io${idPrefix}_`, `m3${idPrefix}_`, 'tt'] : ['xc', 'io', 'm3', 'tt'],
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        },
        ...(env.ADDON_LOGO_URL ? { logo: env.ADDON_LOGO_URL } : {}),
        ...(env.ADDON_BACKGROUND_URL ? { background: env.ADDON_BACKGROUND_URL } : {}),
    };
}
