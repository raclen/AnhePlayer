import { tauriInvoke } from '@infra/tauriBridge/ipc';
import {
    RADIO_BROWSER_PLATFORM,
    type IRadioBrowserMusicItem,
    isSafeRadioRemoteUrl,
} from '@common/radioBrowser';

// 发现服务器：all.api 在部分网络下直连不可达，改用实测可通的节点域名
const DISCOVERY_BASES = [
    'https://de1.api.radio-browser.info',
    'https://all.api.radio-browser.info',
];
const CACHE_KEY = 'radioBrowser.lastServer';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;
const MAX_SERVER_ATTEMPTS = 4;
const EXPLORE_CACHE_TTL = 5 * 60 * 1000;
const EXPLORE_CACHE_LIMIT = 4;
const MAX_EXPLORE_STATIONS = 1200;

interface IHttpResponse {
    statusCode: number;
    body: string;
}

interface ICachedServer {
    baseUrl: string;
    expiresAt: number;
}

interface IRadioBrowserServer {
    name?: unknown;
}

interface IRadioBrowserStation {
    stationuuid?: unknown;
    name?: unknown;
    url?: unknown;
    url_resolved?: unknown;
    homepage?: unknown;
    favicon?: unknown;
    tags?: unknown;
    country?: unknown;
    countrycode?: unknown;
    language?: unknown;
    codec?: unknown;
    bitrate?: unknown;
    hls?: unknown;
    lastcheckok?: unknown;
    geo_lat?: unknown;
    geo_long?: unknown;
    clickcount?: unknown;
    clicktrend?: unknown;
    votes?: unknown;
}

interface IRadioBrowserFacetRecord {
    name?: unknown;
    iso_3166_1?: unknown;
    stationcount?: unknown;
}

export interface IRadioStationFilters {
    query?: string;
    countryCode?: string;
    language?: string;
    tag?: string;
    bitrateMin?: number;
    bitrateMax?: number;
}

export interface IRadioStationSearchResult {
    data: IRadioBrowserMusicItem[];
    isEnd: boolean;
    nextOffset: number;
}

export interface IRadioFacetOption {
    value: string;
    label: string;
    count: number;
}

export interface IRadioBrowserFacets {
    countries: IRadioFacetOption[];
    languages: IRadioFacetOption[];
    tags: IRadioFacetOption[];
    partial?: boolean;
}

export interface IRadioExploreResult {
    data: IRadioBrowserMusicItem[];
    fetchedAt: number;
}

interface IExploreCacheEntry extends IRadioExploreResult {
    expiresAt: number;
}

class RadioBrowserRequestError extends Error {
    constructor(
        message: string,
        readonly statusCode?: number,
    ) {
        super(message);
    }
}

let preferredBaseUrl = '';
let discoveryPromise: Promise<string[]> | null = null;
let facetsPromise: Promise<IRadioBrowserFacets> | null = null;
const exploreCache = new Map<string, IExploreCacheEntry>();

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeCount(value: unknown): number {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizeNumber(value: unknown, fallback = 0): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeCoordinate(value: unknown, min: number, max: number): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

function normalizeApiBase(value: unknown): string | null {
    const name = normalizeText(value);
    if (!name) return null;

    try {
        const url = new URL(name.includes('://') ? name : `https://${name}`);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:') return null;
        if (
            hostname !== 'api.radio-browser.info' &&
            !hostname.endsWith('.api.radio-browser.info')
        ) {
            return null;
        }
        return `https://${hostname}`;
    } catch {
        return null;
    }
}

function getCachedServer(): string | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw) as Partial<ICachedServer>;
        const baseUrl = normalizeApiBase(cached.baseUrl);
        if (!baseUrl || typeof cached.expiresAt !== 'number' || cached.expiresAt <= Date.now()) {
            localStorage.removeItem(CACHE_KEY);
            return null;
        }
        return baseUrl;
    } catch {
        localStorage.removeItem(CACHE_KEY);
        return null;
    }
}

function rememberServer(baseUrl: string): void {
    preferredBaseUrl = baseUrl;
    try {
        localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ baseUrl, expiresAt: Date.now() + CACHE_TTL } satisfies ICachedServer),
        );
    } catch {
        // localStorage 不可用时仅保留内存缓存。
    }
}

function forgetServer(baseUrl: string): void {
    if (preferredBaseUrl === baseUrl) preferredBaseUrl = '';
    try {
        const cached = getCachedServer();
        if (cached === baseUrl) localStorage.removeItem(CACHE_KEY);
    } catch {
        // ignore
    }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new RadioBrowserRequestError('Radio Browser request timed out')),
                    REQUEST_TIMEOUT,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function requestFromBase<T>(baseUrl: string, path: string): Promise<T> {
    const version = normalizeText((globalThis as any).globalContext?.appVersion) || 'unknown';
    const url = `${baseUrl}${path}`;
    let response: IHttpResponse;

    try {
        response = await withTimeout(
            tauriInvoke<IHttpResponse>('http_request', {
                url,
                options: {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': `AnhePlayer/${version} (+https://github.com/raclen/AnhePlayer)`,
                    },
                },
            }),
        );
        if (
            !response ||
            typeof response.statusCode !== 'number' ||
            typeof response.body !== 'string'
        ) {
            throw new RadioBrowserRequestError('Invalid Radio Browser response');
        }
    } catch {
        // Remote origin 调试或 Rust 网络不可用时，回退到支持 CORS 的官方接口。
        response = await withTimeout(
            fetch(url, { headers: { Accept: 'application/json' } }).then(async (result) => ({
                statusCode: result.status,
                body: await result.text(),
            })),
        );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new RadioBrowserRequestError(
            `Radio Browser returned ${response.statusCode}`,
            response.statusCode,
        );
    }

    try {
        return JSON.parse(response.body) as T;
    } catch {
        throw new RadioBrowserRequestError('Radio Browser returned invalid JSON');
    }
}

async function discoverServers(): Promise<string[]> {
    if (!discoveryPromise) {
        discoveryPromise = (async () => {
            // 逐个尝试发现域名：任一成功即用其结果，全部失败时退回候选列表本身
            for (const base of DISCOVERY_BASES) {
                try {
                    const servers = await requestFromBase<IRadioBrowserServer[]>(
                        base,
                        '/json/servers',
                    );
                    if (!Array.isArray(servers)) continue;
                    const names = Array.from(
                        new Set(
                            servers
                                .map((server) => normalizeApiBase(server?.name))
                                .filter((server): server is string => !!server),
                        ),
                    );
                    if (names.length > 0) return names;
                } catch {
                    // 换下一个发现域名
                }
            }
            return [];
        })();
    }
    return discoveryPromise;
}

async function getServerCandidates(): Promise<string[]> {
    const cachedCandidates = [preferredBaseUrl, getCachedServer()].filter(Boolean) as string[];
    if (cachedCandidates.length > 0) {
        return Array.from(new Set([...cachedCandidates, ...DISCOVERY_BASES]));
    }

    const discovered = await discoverServers();
    return Array.from(new Set([...discovered, ...DISCOVERY_BASES]));
}

async function requestJson<T>(path: string): Promise<T> {
    const candidates = await getServerCandidates();
    let lastError: unknown = new RadioBrowserRequestError('No Radio Browser server available');

    for (const baseUrl of candidates.slice(0, MAX_SERVER_ATTEMPTS)) {
        try {
            const result = await requestFromBase<T>(baseUrl, path);
            rememberServer(baseUrl);
            return result;
        } catch (error) {
            lastError = error;
            forgetServer(baseUrl);
            if (
                error instanceof RadioBrowserRequestError &&
                error.statusCode != null &&
                error.statusCode >= 400 &&
                error.statusCode < 500 &&
                error.statusCode !== 429
            ) {
                throw error;
            }
        }
    }

    throw lastError;
}

function mapStation(station: IRadioBrowserStation): IRadioBrowserMusicItem | null {
    if (Number(station.lastcheckok) !== 1) return null;

    const id = normalizeText(station.stationuuid);
    const title = normalizeText(station.name).slice(0, 160);
    const url = normalizeText(station.url_resolved) || normalizeText(station.url);
    if (!id || !title || !isSafeRadioRemoteUrl(url)) return null;

    const country = normalizeText(station.country);
    const countryCode = normalizeText(station.countrycode).toUpperCase();
    const language = normalizeText(station.language);
    const codec = normalizeText(station.codec).toUpperCase();
    const bitrate = normalizeCount(station.bitrate);
    const favicon = normalizeText(station.favicon);
    const homepage = normalizeText(station.homepage);
    const geoLat = normalizeCoordinate(station.geo_lat, -90, 90);
    const geoLong = normalizeCoordinate(station.geo_long, -180, 180);
    const tags = normalizeText(station.tags)
        .split(',')
        .map((tag) => tag.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 24);

    const artist = [country, language].filter(Boolean).join(' · ');
    const album = [codec, bitrate > 0 ? `${bitrate} kbps` : ''].filter(Boolean).join(' · ');

    return {
        platform: RADIO_BROWSER_PLATFORM,
        id,
        title,
        artist,
        album,
        artwork: isSafeRadioRemoteUrl(favicon) ? favicon : undefined,
        url,
        radioBrowser: {
            country,
            countryCode,
            language,
            tags,
            codec,
            bitrate,
            isHls: Number(station.hls) === 1,
            homepage: isSafeRadioRemoteUrl(homepage) ? homepage : undefined,
            geoLat,
            geoLong,
            clickCount: normalizeCount(station.clickcount),
            clickTrend: normalizeNumber(station.clicktrend),
            votes: normalizeCount(station.votes),
        },
    };
}

function mapFacets(
    rows: IRadioBrowserFacetRecord[],
    valueKey: 'name' | 'iso_3166_1',
    limit: number,
): IRadioFacetOption[] {
    if (!Array.isArray(rows)) return [];

    return rows
        .map((row) => {
            const value = normalizeText(row[valueKey]);
            const name = normalizeText(row.name);
            return { value, label: name || value, count: normalizeCount(row.stationcount) };
        })
        .filter((item) => item.value && item.label && item.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, limit);
}

function buildPath(pathname: string, params: Record<string, string | number | undefined>): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        searchParams.set(key, String(value));
    }
    return `${pathname}?${searchParams.toString()}`;
}

function buildStationSearchPath(
    filters: IRadioStationFilters,
    extra: Record<string, string | number | undefined>,
): string {
    return buildPath('/json/stations/search', {
        hidebroken: 'true',
        name: filters.query?.trim().slice(0, 120),
        countrycode: filters.countryCode,
        language: filters.language,
        tag: filters.tag,
        bitrateMin: filters.bitrateMin,
        bitrateMax: filters.bitrateMax,
        ...extra,
    });
}

function explorationCacheKey(filters: IRadioStationFilters, limit: number): string {
    return JSON.stringify({
        query: filters.query?.trim().toLowerCase() ?? '',
        countryCode: filters.countryCode ?? '',
        language: filters.language ?? '',
        tag: filters.tag ?? '',
        bitrateMin: filters.bitrateMin ?? null,
        bitrateMax: filters.bitrateMax ?? null,
        limit,
    });
}

function mixExploreStations(
    randomStations: IRadioBrowserMusicItem[],
    trendingStations: IRadioBrowserMusicItem[],
    limit: number,
): IRadioBrowserMusicItem[] {
    const result: IRadioBrowserMusicItem[] = [];
    const seen = new Set<string>();
    const trendLimit = Math.min(Math.ceil(limit * 0.15), trendingStations.length);

    const push = (station: IRadioBrowserMusicItem) => {
        const key = `${station.platform}\0${station.id}`;
        if (seen.has(key) || result.length >= limit) return;
        seen.add(key);
        result.push(station);
    };

    trendingStations.slice(0, trendLimit).forEach(push);

    const groups = new Map<string, IRadioBrowserMusicItem[]>();
    for (const station of randomStations) {
        const groupKey = station.radioBrowser.countryCode || station.radioBrowser.tags[0] || 'ZZ';
        const group = groups.get(groupKey);
        if (group) group.push(station);
        else groups.set(groupKey, [station]);
    }

    const buckets = [...groups.values()].sort((a, b) => b.length - a.length);
    let round = 0;
    while (result.length < limit && buckets.some((bucket) => round < bucket.length)) {
        for (const bucket of buckets) {
            const station = bucket[round];
            if (station) push(station);
            if (result.length >= limit) break;
        }
        round++;
    }

    trendingStations.forEach(push);
    return result;
}

export async function getExploreStations(
    filters: IRadioStationFilters,
    requestedLimit = MAX_EXPLORE_STATIONS,
): Promise<IRadioExploreResult> {
    const limit = Math.max(200, Math.min(MAX_EXPLORE_STATIONS, Math.round(requestedLimit)));
    const cacheKey = explorationCacheKey(filters, limit);
    const cached = exploreCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        exploreCache.delete(cacheKey);
        exploreCache.set(cacheKey, cached);
        return { data: cached.data, fetchedAt: cached.fetchedAt };
    }
    if (cached) exploreCache.delete(cacheKey);

    const results = await Promise.allSettled([
        requestJson<IRadioBrowserStation[]>(
            buildStationSearchPath(filters, {
                order: 'random',
                limit: Math.min(1000, Math.ceil(limit * 0.9)),
            }),
        ),
        requestJson<IRadioBrowserStation[]>(
            buildStationSearchPath(filters, {
                order: 'clicktrend',
                reverse: 'true',
                limit: Math.min(220, Math.ceil(limit * 0.22)),
            }),
        ),
    ]);

    let fallbackRows: IRadioBrowserStation[] = [];
    if (results.every((result) => result.status === 'rejected')) {
        try {
            fallbackRows = await requestJson<IRadioBrowserStation[]>(
                buildStationSearchPath(filters, {
                    order: 'clickcount',
                    reverse: 'true',
                    limit: Math.min(320, limit),
                }),
            );
        } catch {
            throw new RadioBrowserRequestError('Unable to load Radio Browser explorer');
        }
    }

    const rowsOf = (result: PromiseSettledResult<IRadioBrowserStation[]>) =>
        result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [];
    const randomStations = [...rowsOf(results[0]), ...fallbackRows]
        .map(mapStation)
        .filter((item): item is IRadioBrowserMusicItem => !!item);
    const trendingStations = rowsOf(results[1])
        .map(mapStation)
        .filter((item): item is IRadioBrowserMusicItem => !!item);
    const data = mixExploreStations(randomStations, trendingStations, limit);
    const fetchedAt = Date.now();

    exploreCache.set(cacheKey, {
        data,
        fetchedAt,
        expiresAt: fetchedAt + EXPLORE_CACHE_TTL,
    });
    while (exploreCache.size > EXPLORE_CACHE_LIMIT) {
        const oldestKey = exploreCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        exploreCache.delete(oldestKey);
    }

    return { data, fetchedAt };
}

export async function searchStations(
    filters: IRadioStationFilters,
    offset: number,
    limit = 40,
): Promise<IRadioStationSearchResult> {
    const path = buildStationSearchPath(filters, {
        order: 'clickcount',
        reverse: 'true',
        offset,
        limit,
    });
    const rows = await requestJson<IRadioBrowserStation[]>(path);
    if (!Array.isArray(rows)) throw new RadioBrowserRequestError('Invalid station list');

    return {
        data: rows.map(mapStation).filter((item): item is IRadioBrowserMusicItem => !!item),
        isEnd: rows.length < limit,
        nextOffset: offset + rows.length,
    };
}

async function loadFacets(): Promise<IRadioBrowserFacets> {
    const results = await Promise.allSettled([
        requestJson<IRadioBrowserFacetRecord[]>(
            buildPath('/json/countries', {
                order: 'stationcount',
                reverse: 'true',
                hidebroken: 'true',
            }),
        ),
        requestJson<IRadioBrowserFacetRecord[]>(
            buildPath('/json/languages', {
                order: 'stationcount',
                reverse: 'true',
                hidebroken: 'true',
            }),
        ),
        requestJson<IRadioBrowserFacetRecord[]>(
            buildPath('/json/tags', { order: 'stationcount', reverse: 'true', hidebroken: 'true' }),
        ),
    ]);

    if (results.every((result) => result.status === 'rejected')) {
        throw new RadioBrowserRequestError('Unable to load Radio Browser facets');
    }

    const valueOrEmpty = (result: PromiseSettledResult<IRadioBrowserFacetRecord[]>) =>
        result.status === 'fulfilled' ? result.value : [];

    return {
        countries: mapFacets(valueOrEmpty(results[0]), 'iso_3166_1', 250),
        languages: mapFacets(valueOrEmpty(results[1]), 'name', 100),
        tags: mapFacets(valueOrEmpty(results[2]), 'name', 100),
        partial: results.some((result) => result.status === 'rejected'),
    };
}

export function getFacets(force = false): Promise<IRadioBrowserFacets> {
    if (force) facetsPromise = null;
    if (!facetsPromise) {
        facetsPromise = loadFacets()
            .then((result) => {
                if (result.partial) facetsPromise = null;
                return result;
            })
            .catch((error) => {
                facetsPromise = null;
                throw error;
            });
    }
    return facetsPromise;
}
