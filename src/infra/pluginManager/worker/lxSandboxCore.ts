/**
 * pluginManager — 洛雪插件沙箱核心（Web Worker 移植版）
 *
 * 由旧版插件沙箱移植：
 * - Node VM 沙箱执行 → new Function 执行（Worker 环境）
 * - axios / lx.request → host_request 消息桥（宿主经 Tauri http_request 转发，穿透 CORS）
 * - 移除 crypto / https / Buffer 等 Node 依赖
 *   注意：LX 的 lx.utils.crypto 仍需 MD5/AES，这里用浏览器可用的 crypto-js 实现
 * 由 lxWorker.ts 在 Web Worker 中加载运行。
 */

import CryptoJS from 'crypto-js';

// ─── Worker 侧：与宿主的 HTTP 桥 ───

interface IHostHttpResult {
    status: number;
    headers: Record<string, string>;
    data: any;
}

interface IHostHttpOptions {
    headers?: Record<string, string>;
    body?: any;
    timeout?: number;
    responseType?: string;
}

const workerScope = self as unknown as { postMessage: (message: any) => void };

const pendingHostRequests = new Map<
    string,
    { resolve: (value: IHostHttpResult) => void; reject: (err: Error) => void }
>();
let hostRequestSeq = 0;

/** 宿主回复入口（由 lxWorker.ts 收到 host_response 时调用） */
export function handleHostResponse(
    reqId: string,
    result: IHostHttpResult | null,
    error: string | null,
): void {
    const waiter = pendingHostRequests.get(reqId);
    if (!waiter) return;
    pendingHostRequests.delete(reqId);
    if (error || !result) {
        waiter.reject(new Error(error || 'Host request failed'));
    } else {
        waiter.resolve(result);
    }
}

/** 向宿主发起 HTTP 请求（宿主走 Tauri http_request） */
function hostHttp(
    method: string,
    url: string,
    options: IHostHttpOptions = {},
): Promise<IHostHttpResult> {
    const reqId = `req_${++hostRequestSeq}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
        pendingHostRequests.set(reqId, { resolve, reject });
        workerScope.postMessage({
            type: 'host_request',
            reqId,
            payload: {
                method,
                url,
                headers: options.headers,
                body: options.body,
                responseType: options.responseType,
            },
        });
    });
}

function buildUrlWithParams(url: string, params?: Record<string, any>): string {
    if (!params) return url;
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        usp.append(key, String(value));
    }
    const query = usp.toString();
    if (!query) return url;
    return url + (url.includes('?') ? '&' : '?') + query;
}

/** axios 兼容 shim：适配器层沿用 axios.get / axios.post 的调用形态 */
const axios = {
    get(url: string, config: Record<string, any> = {}) {
        const finalUrl = buildUrlWithParams(url, config.params);
        return hostHttp('GET', finalUrl, {
            headers: config.headers,
            timeout: config.timeout,
            responseType: config.responseType,
        }).then((resp) => ({ status: resp.status, headers: resp.headers, data: resp.data }));
    },
    post(url: string, data?: any, config: Record<string, any> = {}) {
        const finalUrl = buildUrlWithParams(url, config.params);
        return hostHttp('POST', finalUrl, {
            headers: config.headers,
            body: data,
            timeout: config.timeout,
            responseType: config.responseType,
        }).then((resp) => ({ status: resp.status, headers: resp.headers, data: resp.data }));
    },
};

/** base64 文本解码（替代 Node Buffer） */
function decodeBase64Utf8(base64: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

/** 供沙箱全局使用的极简 Buffer 兼容垫片（覆盖 base64 与字符串场景） */
const BufferShim = {
    from(data: any, encoding?: string) {
        if (encoding === 'base64' && typeof data === 'string') {
            return { toString: (_enc?: string) => decodeBase64Utf8(data) };
        }
        if (typeof data === 'string') {
            return { toString: (_enc?: string) => data };
        }
        return { toString: () => String(data) };
    },
};

/** 把各种输入统一转成字节数组（模拟 Node Buffer.from 的常用编码） */
function toLxBytes(data: any, encoding?: string): Uint8Array {
    if (typeof data === 'string') {
        const enc = (encoding || 'utf8').toLowerCase();
        if (enc === 'base64') {
            const binary = atob(data);
            return Uint8Array.from(binary, (c) => c.charCodeAt(0));
        }
        if (enc === 'hex') {
            const bytes: number[] = [];
            for (let i = 0; i + 1 < data.length; i += 2)
                bytes.push(parseInt(data.slice(i, i + 2), 16));
            return Uint8Array.from(bytes);
        }
        return new TextEncoder().encode(data);
    }
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && typeof data === 'object' && data.buffer instanceof ArrayBuffer) {
        return new Uint8Array(
            data.buffer,
            data.byteOffset || 0,
            data.byteLength ?? data.length ?? 0,
        );
    }
    return new TextEncoder().encode(String(data));
}

/** 字节数组按指定编码转字符串（对应 Buffer#toString） */
function lxBytesToString(bytes: Uint8Array, format?: string): string {
    const fmt = (format || 'utf8').toLowerCase();
    if (fmt === 'hex') return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    if (fmt === 'base64') {
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
    }
    return new TextDecoder().decode(bytes);
}

/** Uint8Array ↔ crypto-js WordArray */
function bytesToWordArray(bytes: Uint8Array): any {
    const words: number[] = [];
    for (let i = 0; i < bytes.length; i++) words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
    return CryptoJS.lib.WordArray.create(words as any, bytes.length);
}

function wordArrayToBytes(wordArray: any): Uint8Array {
    const words: number[] = wordArray.words;
    const { sigBytes } = wordArray;
    const bytes = new Uint8Array(sigBytes);
    for (let i = 0; i < sigBytes; i++) {
        bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return bytes;
}

/** 洛雪 lx.utils 的 Worker 兼容实现（crypto-js 提供同步的 MD5/AES） */
const lxUtils = {
    buffer: {
        from: (data: any, encoding?: string) => toLxBytes(data, encoding),
        bufToString: (buffer: any, format?: string) => lxBytesToString(toLxBytes(buffer), format),
    },
    crypto: {
        md5: (value: any) =>
            CryptoJS.MD5(bytesToWordArray(toLxBytes(value))).toString(CryptoJS.enc.Hex),
        randomBytes: (size: number) => {
            const bytes = new Uint8Array(size);
            globalThis.crypto.getRandomValues(bytes);
            return bytes;
        },
        aesEncrypt: (buffer: any, mode = 'aes-128-cbc', key: any, iv?: any) => {
            const isEcb = /ecb/i.test(mode);
            const config: any = {
                mode: isEcb ? CryptoJS.mode.ECB : CryptoJS.mode.CBC,
                // 与洛雪保持一致：不做自动填充，由音源自行补齐块大小
                padding: CryptoJS.pad.NoPadding,
            };
            if (!isEcb) config.iv = bytesToWordArray(toLxBytes(iv ?? ''));
            const encrypted = CryptoJS.AES.encrypt(
                bytesToWordArray(toLxBytes(buffer)),
                bytesToWordArray(toLxBytes(key)),
                config,
            );
            return wordArrayToBytes(encrypted.ciphertext);
        },
        rsaEncrypt: () => {
            throw new Error('当前运行环境不支持 utils.crypto.rsaEncrypt');
        },
    },
};

/**
 * 创建受保护的沙箱全局对象。
 * 使用 Proxy 保护预注入的全局变量不被覆盖或删除，
 * 但允许插件代码创建新的全局变量（var/function 声明需要）。
 */
function createProtectedGlobal(globals: Record<string, any>): Record<string, any> {
    const frozenKeys = new Set(Object.keys(globals));

    return new Proxy(globals, {
        set(target, prop, value) {
            // 禁止覆盖预注入的全局变量
            if (frozenKeys.has(prop as string)) {
                return false;
            }
            // 允许插件声明新变量
            target[prop as string] = value;
            return true;
        },
        deleteProperty(target, prop) {
            if (frozenKeys.has(prop as string)) {
                return false;
            }
            delete target[prop as string];
            return true;
        },
        defineProperty(target, prop, descriptor) {
            if (frozenKeys.has(prop as string)) {
                return false;
            }
            Object.defineProperty(target, prop, descriptor);
            return true;
        },
    });
}

const LX_EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
} as const;

const LX_QUALITY_MAP: Record<IMusic.IQualityKey, string> = {
    low: '128k',
    standard: '320k',
    high: 'flac',
    super: 'flac',
};

const LX_SEARCH_PAGE_SIZE = 30;
const NETEASE_PLAYLIST_PAGE_SIZE = 30;
const ONLINE_PLAYLIST_PAGE_SIZE = 30;
const BROWSER_USER_AGENT = 'Mozilla/5.0';
const MOBILE_USER_AGENT =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const NETEASE_HEADERS = {
    Referer: 'https://music.163.com/',
    'User-Agent': BROWSER_USER_AGENT,
};

// 汽水音乐（抖音系）没有出现在洛雪内置音源列表中，但社区音源普遍声明 qs 平台。
// 音源只负责取流，搜索必须由客户端完成，因此这里直接对接汽水官方 App 接口。
// 缺少 X-Argus 会被判定为未签名请求，接口返回 empty_search。
const QISHUI_SEARCH_URL = 'https://api.qishui.com/luna/search/track';
const QISHUI_API_HEADERS = {
    'User-Agent':
        'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)',
    'content-type': 'application/json; charset=UTF-8',
    'X-Argus': '=',
    'x-common-params-v2': 'channel=official&aid=386088&device_id=2081836196178571',
};
const QISHUI_API_PARAMS = {
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    cdid: '46556f98-1720-4248-83da-62b74b60b46a',
    channel: 'official',
    aid: '386088',
    app_name: 'luna',
    version_code: '100198030',
    version_name: '19.8.0',
    manifest_version_code: '100198030',
    update_version_code: '100198030',
    resolution: '1080*1920',
    dpi: '480',
    device_type: 'ABR-AL80',
    device_brand: 'HUAWEI',
    language: 'zh',
    os_api: '35',
    os_version: '15',
    ac: 'wifi',
    device_model: 'ABR-AL80',
    package: 'com.luna.music',
    device_id: '2204957404565290',
    iid: '2204957404569386',
};
const KUGOU_HTTPS_AGENT = undefined; // Rust http_request 已忽略证书校验

type ILxRequestHandler = (payload: {
    source: string;
    action: string;
    info: Record<string, any>;
}) => unknown;

interface ILxSourceDefine {
    name?: string;
    type?: string;
    actions?: string[];
    qualitys?: string[];
}

interface ILxInitedPayload {
    sources?: Record<string, ILxSourceDefine>;
}

type ILxSearchResult = {
    isEnd?: boolean;
    data: any[];
};
type ILxMediaSearcher = (query: string, page: number, platform: string) => Promise<ILxSearchResult>;
type ILxLyricGetter = (musicInfo: Record<string, any>) => Promise<ILyric.ILyricSource | null>;
type ILxMusicInfoGetter = (
    musicInfo: Record<string, any>,
) => Promise<Partial<IMusic.IMusicItem> | null>;
type ILxMusicSheetImporter = (urlLike: string, platform: string) => Promise<IMusic.IMusicItem[]>;
type ILxAlbumInfoGetter = (
    albumItem: IAlbum.IAlbumItem,
    page: number,
    platform: string,
) => Promise<IPlugin.IAlbumInfoResult | null>;
type ILxArtistWorksGetter = (
    artistItem: IArtist.IArtistItem,
    page: number,
    type: IArtist.ArtistMediaType,
    platform: string,
) => Promise<ILxSearchResult>;
type ILxSheetInfoResult = {
    isEnd?: boolean;
    sheetItem?: IMusic.IMusicSheetItem;
    musicList?: IMusic.IMusicItem[];
};
type ILxTopListInfoResult = {
    isEnd?: boolean;
    topListItem?: IMusic.IMusicSheetItem;
    musicList?: IMusic.IMusicItem[];
};
type ILxRecommendSheetTagsResult = {
    pinned?: IMusic.IMusicSheetItem[];
    data?: IMusic.IMusicSheetGroupItem[];
};
type ILxPaginationResponse<T> = {
    isEnd?: boolean;
    data: T[];
};
type ILxTopListsGetter = (platform: string) => Promise<IMusic.IMusicSheetGroupItem[]>;
type ILxTopListDetailGetter = (
    topListItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
) => Promise<ILxTopListInfoResult>;
type ILxRecommendTagsGetter = () => Promise<ILxRecommendSheetTagsResult>;
type ILxRecommendSheetsGetter = (
    tag: IMedia.IUnique,
    page: number,
    platform: string,
) => Promise<ILxPaginationResponse<IMusic.IMusicSheetItem>>;
type ILxMusicSheetInfoGetter = (
    sheetItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
) => Promise<ILxSheetInfoResult | null>;

type IParsedSheetLink = {
    id: string;
    url?: string;
    collection?: boolean;
};

function readPluginHeader(code: string): Record<string, string> {
    const match = code.match(/\/\*\*([\s\S]*?)\*\//);
    if (!match) return {};

    const meta: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        const item = line.match(/^\s*\*\s*@([\w-]+)\s+(.+?)\s*$/);
        if (item) {
            meta[item[1]] = item[2];
        }
    }
    return meta;
}

function extractLxMusicInfo(musicItem: IMusic.IMusicItemPartial): Record<string, any> {
    const raw = (musicItem as any)?.raw ?? (musicItem as any)?.musicInfo ?? {};
    return {
        ...raw,
        ...musicItem,
    };
}

function buildLxMusicInfo(
    musicItem: IMusic.IMusicItemPartial,
    sourceKey: string,
): Record<string, any> {
    const info = extractLxMusicInfo(musicItem);
    const fallbackId =
        info.id ??
        info.songId ??
        info.songmid ??
        info.hash ??
        info.rid ??
        info.DC_TARGETID ??
        info.contentId ??
        info.copyrightId;

    if (sourceKey === 'kg') {
        info.hash ??= fallbackId;
    } else {
        info.songmid ??= fallbackId;
    }

    return info;
}

function getMiguToneFlag(quality: IMusic.IQualityKey): string {
    if (quality === 'low') return 'LQ';
    if (quality === 'high') return 'HQ';
    if (quality === 'super') return 'SQ';
    return 'PQ';
}

async function getOfficialLxMediaSource(
    sourceKey: string,
    musicInfo: Record<string, any>,
    quality: IMusic.IQualityKey,
): Promise<IPlugin.IMediaSourceResult | null> {
    if (sourceKey === 'wy') {
        const songId = musicInfo.songmid ?? musicInfo.id ?? musicInfo.songId;
        if (!songId) return null;

        return {
            url: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(
                String(songId),
            )}.mp3`,
            headers: {
                Referer: 'https://music.163.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            quality,
        };
    }

    if (sourceKey === 'mg') {
        const contentId =
            musicInfo.contentId ?? (/^\w{18}$/.test(String(musicInfo.id)) ? musicInfo.id : null);
        if (!contentId) return null;

        const resp = await axios.get(
            'https://app.pd.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do',
            {
                params: {
                    contentId,
                    copyrightId: musicInfo.copyrightId ?? '0',
                    resourceType: musicInfo.resourceType ?? '2',
                    toneFlag: getMiguToneFlag(quality),
                    netType: '00',
                    userId: '15548614588710179085069',
                    ua: 'Android_migu',
                    version: '5.1',
                    channel: '0',
                },
                headers: {
                    'User-Agent': MOBILE_USER_AGENT,
                    Referer: 'https://music.migu.cn/',
                },
                timeout: 15000,
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400,
            },
        );

        const url = resp.headers.location;
        if (!url) return null;

        return {
            url,
            headers: {
                Referer: 'https://music.migu.cn/',
                'User-Agent': MOBILE_USER_AGENT,
            },
            quality,
        };
    }

    return null;
}

function normalizeLxMusicUrlResult(result: any): IPlugin.IMediaSourceResult | null {
    if (!result) return null;
    if (typeof result === 'string') {
        return result ? { url: result } : null;
    }
    if (typeof result === 'object') {
        const url = result.url ?? result.musicUrl ?? result.location;
        if (!url) return null;
        return {
            url,
            headers: result.headers,
            userAgent: result.userAgent ?? result.headers?.['user-agent'],
        };
    }
    return null;
}

function getLxQuality(sourceKey: string, quality: IMusic.IQualityKey): string {
    if (sourceKey === 'kg') {
        return '128k';
    }
    return LX_QUALITY_MAP[quality] ?? '320k';
}

function normalizeLxMusicUrl(url: string, sourceKey: string): string {
    try {
        const parsed = new URL(url);

        if (sourceKey === 'tx' && parsed.pathname.includes('/kgqq/qq.php')) {
            parsed.protocol = 'https:';
            parsed.hostname = 'music.haitangw.cc';
            parsed.port = '';
            parsed.pathname = parsed.pathname.replace('/kgqq/qq.php', '/kgqq1/qq.php');
            return parsed.toString();
        }

        if (sourceKey === 'kg' && parsed.pathname.includes('/kg.php')) {
            parsed.searchParams.set('level', 'standard');
            return parsed.toString();
        }
    } catch {
        return url;
    }

    return url;
}

function normalizeArtistNames(value: unknown): string {
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === 'string') return item;
                return item?.name ?? item?.singername ?? item?.author_name ?? '';
            })
            .filter(Boolean)
            .join(' / ');
    }
    return typeof value === 'string' && value ? value : '未知歌手';
}

function cleanSearchText(value: unknown): string {
    if (value == null) return '';
    return String(value)
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
}

function extractFirstUrl(value: string): string | null {
    const match = value.match(/https?:\/\/[^\s"'<>，。；、]+/i);
    return match?.[0] ?? null;
}

function parseNumericInput(value: string): string | null {
    const trimmed = value.trim();
    return /^\d{4,}$/.test(trimmed) ? trimmed : null;
}

async function resolveShareUrl(urlLike: string): Promise<string> {
    const firstUrl = extractFirstUrl(urlLike);
    if (!firstUrl) return urlLike.trim();

    try {
        const resp = await axios.get(firstUrl, {
            headers: {
                'User-Agent': BROWSER_USER_AGENT,
            },
            timeout: 10000,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: (status) => status >= 200 && status < 400,
        });
        return resp.request?.res?.responseUrl ?? firstUrl;
    } catch {
        return firstUrl;
    }
}

function getUrlParam(urlLike: string, names: string[]): string | null {
    try {
        const parsed = new URL(urlLike);
        for (const name of names) {
            const value =
                parsed.searchParams.get(name) ??
                parsed.hash.match(new RegExp(`[?&]${name}=([^&]+)`))?.[1];
            if (value) return decodeURIComponent(value);
        }
    } catch {
        return null;
    }
    return null;
}

function decodeTextEntities(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;

    const text = value
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();

    return text || undefined;
}

function formatLrcTime(value: unknown): string | null {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return null;

    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

function buildKuwoLyricText(list: unknown): string | undefined {
    if (!Array.isArray(list)) return undefined;

    const lrc = list
        .map((item) => {
            const time = formatLrcTime(item?.time);
            if (!time) return null;
            const line = decodeTextEntities(item?.lineLyric) ?? '';
            return `[${time}]${line}`;
        })
        .filter(Boolean)
        .join('\n');

    return lrc || undefined;
}

function normalizeDurationSeconds(value: unknown): number | undefined {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

function buildKuwoArtwork(path: unknown): string | undefined {
    if (typeof path !== 'string' || !path) return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    return `https://img4.kuwo.cn/star/albumcover/${path}`;
}

function pickMiguArtwork(items: unknown): string | undefined {
    if (!Array.isArray(items)) return undefined;
    const preferred =
        items.find((item) => item?.imgSizeType === '02') ??
        items.find((item) => item?.imgSizeType === '01') ??
        items[0];
    return typeof preferred?.img === 'string' ? preferred.img : undefined;
}

async function fetchNeteaseSongDetails(songIds: unknown[]): Promise<Map<string, any>> {
    const ids = songIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);

    if (!ids.length) return new Map();

    try {
        const resp = await axios.get('https://music.163.com/api/song/detail/', {
            params: {
                ids: JSON.stringify(ids),
            },
            headers: {
                Referer: 'https://music.163.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            timeout: 15000,
            responseType: 'json',
        });

        const songs = Array.isArray(resp.data?.songs) ? resp.data.songs : [];
        return new Map(songs.map((song: any) => [String(song.id), song]));
    } catch {
        return new Map();
    }
}

function mapNeteaseSongInfo(
    song: any,
    platform: string,
): Partial<IMusic.IMusicItem> & Record<string, any> {
    const album = song?.album ?? song?.al ?? {};
    return {
        id: String(song?.id),
        platform,
        title: cleanSearchText(song?.name),
        artist: normalizeArtistNames(song?.artists ?? song?.ar),
        album: cleanSearchText(album?.name),
        artwork: album?.picUrl ?? album?.blurPicUrl,
        duration: normalizeDurationSeconds(song?.duration ?? song?.dt),
        raw: song,
        songId: song?.id,
        songmid: song?.id,
    };
}

function splitKugouFilename(value: unknown): { artist?: string; title?: string } {
    const text = cleanSearchText(value);
    const match = text.match(/^(.+?)\s+-\s+(.+)$/);
    if (!match) return { title: text };
    return {
        artist: match[1],
        title: match[2],
    };
}

function mapTencentSongInfo(item: any, platform: string): IMusic.IMusicItem {
    return {
        id: String(item.songmid ?? item.songid ?? item.media_mid ?? item.strMediaMid),
        platform,
        title: cleanSearchText(item.songname ?? item.name),
        artist: normalizeArtistNames(item.singer),
        album: cleanSearchText(item.albumname ?? item.album?.name),
        artwork: item.albummid
            ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg`
            : undefined,
        duration: normalizeDurationSeconds(item.interval),
        raw: item,
        songmid: item.songmid,
        media_mid: item.media_mid,
        strMediaMid: item.strMediaMid,
    };
}

function mapKugouSongInfo(item: any, platform: string): IMusic.IMusicItem {
    const parsed = splitKugouFilename(item.filename);
    const title = cleanSearchText(
        item.songname ?? item.songname_original ?? item.audio_name ?? parsed.title,
    );
    const artist = cleanSearchText(
        item.singername ?? item.author_name ?? normalizeArtistNames(item.authors) ?? parsed.artist,
    );
    const artworkSource =
        item.trans_param?.union_cover ?? item.album_sizable_cover ?? item.imgurl ?? item.img;
    const artwork = artworkSource ? String(artworkSource).replace('{size}', '300') : undefined;

    return {
        id: String(item.hash ?? item.HASH ?? item.audio_id ?? item.album_audio_id),
        platform,
        title,
        artist: artist || parsed.artist || '未知歌手',
        album: cleanSearchText(item.album_name ?? item.albumname ?? item.remark),
        artwork,
        duration: normalizeDurationSeconds(item.duration ?? item.timelength),
        raw: item,
        hash: item.hash ?? item.HASH,
    };
}

function mapKuwoSongInfo(item: any, platform: string): IMusic.IMusicItem {
    const rid = String(item.DC_TARGETID ?? item.id ?? item.MUSICRID ?? '').replace(/^MUSIC_/, '');
    return {
        id: rid,
        platform,
        title: cleanSearchText(item.SONGNAME ?? item.NAME ?? item.name),
        artist: cleanSearchText(item.ARTIST ?? item.FARTIST ?? item.artist),
        album: cleanSearchText(item.ALBUM ?? item.album),
        artwork: buildKuwoArtwork(item.web_albumpic_short ?? item.albumpic),
        duration: normalizeDurationSeconds(item.DURATION ?? item.duration),
        raw: item,
        rid,
        songmid: rid,
        musicrid: item.MUSICRID,
        MUSICRID: item.MUSICRID,
        DC_TARGETID: item.DC_TARGETID ?? item.id,
    };
}

/** 汽水封面是「域名前缀 + uri + 模板」三段式，拼出不带签名的 CDN 地址 */
function buildQishuiArtwork(cover: any): string | undefined {
    if (!cover) return undefined;
    if (typeof cover === 'string') return cover || undefined;

    const { uri, template_prefix: templatePrefix, urls } = cover;
    if (typeof uri === 'string' && typeof templatePrefix === 'string') {
        return `https://p3-luna.douyinpic.com/img/${uri}~${templatePrefix}-resize:960:960.png`;
    }
    if (Array.isArray(urls) && urls.length > 0) {
        const first = urls[0];
        if (typeof uri !== 'string' || String(first).includes(uri)) return first;
        return `${first}${uri}`;
    }
    return undefined;
}

function mapQishuiSongInfo(track: any, platform: string): IMusic.IMusicItem {
    const id = String(track?.id ?? '');
    return {
        id,
        platform,
        title: cleanSearchText(track?.name ?? track?.title),
        artist: normalizeArtistNames(track?.artists ?? track?.author_info),
        album: cleanSearchText(track?.album?.name),
        artwork: buildQishuiArtwork(track?.album?.url_cover ?? track?.cover_url),
        duration: normalizeDurationSeconds(track?.duration),
        // 音源取流依赖原始 track 字段（id / vid / bit_rates 等），不能只传展示字段
        raw: track,
        songmid: id,
        songId: track?.id,
        vid: track?.vid,
    };
}

function mapNeteaseSheetItem(item: any, platform: string): IMusic.IMusicSheetItem {
    const creator = item?.creator ?? item?.user ?? {};
    const trackCount = Number(item?.trackCount ?? item?.trackNumber ?? item?.songCount ?? 0);
    const playCount = Number(item?.playCount ?? item?.subscribedCount ?? 0);

    return {
        id: String(item?.id ?? item?.playlistId),
        platform,
        title: cleanSearchText(item?.name ?? item?.title),
        artwork: item?.coverImgUrl ?? item?.picUrl ?? item?.coverUrl,
        description: cleanSearchText(
            item?.description ?? item?.copywriter ?? item?.updateFrequency,
        ),
        worksNum: trackCount > 0 ? trackCount : undefined,
        playCount: playCount > 0 ? playCount : undefined,
        artist: cleanSearchText(creator?.nickname ?? creator?.name),
        createAt: Number(item?.createTime) || undefined,
        raw: item,
    };
}

function mapNeteaseAlbumItem(item: any, platform: string): IAlbum.IAlbumItem {
    const artistSource =
        Array.isArray(item?.artists) && item.artists.length
            ? item.artists
            : item?.artist
              ? [item.artist]
              : undefined;
    const artist = normalizeArtistNames(artistSource);
    const publishTime = Number(item?.publishTime ?? item?.publish_time ?? 0);
    const size = Number(item?.size ?? item?.songCount ?? 0);

    return {
        id: String(item?.id),
        platform,
        title: cleanSearchText(item?.name ?? item?.title),
        artwork: item?.picUrl ?? item?.blurPicUrl,
        description: cleanSearchText(item?.description ?? item?.briefDesc),
        worksNum: size > 0 ? size : undefined,
        artist,
        date: publishTime ? new Date(publishTime).getFullYear().toString() : undefined,
        createAt: publishTime || undefined,
        raw: item,
    };
}

function mapNeteaseArtistItem(item: any, platform: string): IArtist.IArtistItem {
    return {
        id: String(item?.id),
        platform,
        name: cleanSearchText(item?.name),
        avatar: item?.img1v1Url ?? item?.picUrl ?? '',
        fans: Number(item?.fansSize ?? item?.fansCount) || undefined,
        description: cleanSearchText(item?.briefDesc ?? item?.description),
    };
}

function mapNeteaseTag(item: any): IMusic.IMusicSheetItem {
    const title = cleanSearchText(item?.name ?? item?.title ?? item);
    return {
        id: title,
        platform: '',
        title,
    };
}

function mapTencentSheetItem(item: any, platform: string): IMusic.IMusicSheetItem {
    const creator = item?.creator ?? {};
    return {
        id: String(item?.dissid ?? item?.tid ?? item?.id),
        platform,
        title: cleanSearchText(item?.dissname ?? item?.title ?? item?.topTitle),
        artwork: item?.imgurl ?? item?.picUrl ?? item?.logo,
        description: cleanSearchText(item?.introduction ?? item?.desc),
        worksNum: Number(item?.songnum ?? item?.song_count) || undefined,
        playCount: Number(item?.listennum ?? item?.listenCount) || undefined,
        artist: cleanSearchText(creator?.name ?? item?.nickname),
        raw: item,
    };
}

function mapKugouSheetItem(item: any, platform: string): IMusic.IMusicSheetItem {
    const artwork = item?.imgurl ?? item?.img_cover ?? item?.bannerurl ?? item?.album_img_9;
    return {
        id: String(item?.specialid ?? item?.rankid ?? item?.id),
        platform,
        title: cleanSearchText(item?.specialname ?? item?.rankname ?? item?.name),
        artwork: artwork ? String(artwork).replace('{size}', '300') : undefined,
        description: cleanSearchText(item?.intro ?? item?.description ?? item?.update_frequency),
        worksNum: Number(item?.songcount ?? item?.total) || undefined,
        playCount: Number(item?.playcount ?? item?.play_times) || undefined,
        artist: cleanSearchText(item?.nickname ?? item?.singername),
        raw: item,
    };
}

function mapRecommendTag(id: unknown, title: unknown): IMusic.IMusicSheetItem {
    return {
        id: String(id ?? ''),
        platform: '',
        title: cleanSearchText(title),
    };
}

async function getTencentTopLists(platform: string): Promise<IMusic.IMusicSheetGroupItem[]> {
    const resp = await axios.get('https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg', {
        params: { format: 'json' },
        headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const list = Array.isArray(resp.data?.data?.topList) ? resp.data.data.topList : [];
    const data = list
        .filter((item: any) => item?.id && item?.topTitle)
        .map((item: any) => mapTencentSheetItem(item, platform));
    return data.length ? [{ title: 'QQ音乐', data }] : [];
}

async function getTencentTopListDetail(
    topListItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxTopListInfoResult> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const resp = await axios.get('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg', {
        params: {
            format: 'json',
            topid: topListItem.raw?.id ?? topListItem.id,
            page: 'detail',
            type: 'top',
            song_begin: (currentPage - 1) * ONLINE_PLAYLIST_PAGE_SIZE,
            song_num: ONLINE_PLAYLIST_PAGE_SIZE,
        },
        headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const list = Array.isArray(resp.data?.songlist) ? resp.data.songlist : [];
    const musicList = list
        .map((item: any) => item?.data ?? item)
        .filter((item: any) => item?.songmid || item?.songid)
        .map((item: any) => mapTencentSongInfo(item, platform));
    const total = Number(resp.data?.total_song_num ?? 0);
    return {
        topListItem: {
            ...topListItem,
            artwork: resp.data?.topinfo?.pic_v12 ?? topListItem.artwork,
            description: cleanSearchText(resp.data?.topinfo?.info ?? topListItem.description),
        },
        musicList,
        isEnd:
            musicList.length < ONLINE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && currentPage * ONLINE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function getTencentRecommendSheetTags(): Promise<ILxRecommendSheetTagsResult> {
    const resp = await axios.get('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg', {
        params: { format: 'json' },
        headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const categories = Array.isArray(resp.data?.data?.categories) ? resp.data.data.categories : [];
    const data = categories
        .map((group: any) => ({
            title: cleanSearchText(group?.categoryGroupName),
            data: (Array.isArray(group?.items) ? group.items : [])
                .filter((item: any) => item?.categoryId != null && item?.categoryName)
                .map((item: any) => mapRecommendTag(item.categoryId, item.categoryName)),
        }))
        .filter((group: IMusic.IMusicSheetGroupItem) => group.data.length);
    const allTags = data.flatMap((group: IMusic.IMusicSheetGroupItem) => group.data);
    return { pinned: allTags.slice(0, 8), data };
}

async function getTencentRecommendSheetsByTag(
    tag: IMedia.IUnique,
    page: number,
    platform: string,
): Promise<ILxPaginationResponse<IMusic.IMusicSheetItem>> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const start = (currentPage - 1) * ONLINE_PLAYLIST_PAGE_SIZE;
    const resp = await axios.get('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
        params: {
            format: 'json',
            categoryId: tag?.id && tag.id !== 'all' ? tag.id : 10000000,
            sortId: 5,
            sin: start,
            ein: start + ONLINE_PLAYLIST_PAGE_SIZE - 1,
        },
        headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const result = resp.data?.data ?? {};
    const list = Array.isArray(result.list) ? result.list : [];
    const total = Number(result.sum ?? 0);
    return {
        data: list.map((item: any) => mapTencentSheetItem(item, platform)),
        isEnd:
            list.length < ONLINE_PLAYLIST_PAGE_SIZE || (total > 0 && start + list.length >= total),
    };
}

async function fetchTencentPlaylistInfo(
    sheetItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxSheetInfoResult | null> {
    const resp = await axios.get(
        'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
        {
            params: {
                type: 1,
                json: 1,
                utf8: 1,
                onlysong: 0,
                disstid: sheetItem.raw?.dissid ?? sheetItem.id,
                format: 'json',
                g_tk: 5381,
                loginUin: 0,
                hostUin: 0,
                inCharset: 'utf8',
                outCharset: 'utf-8',
                notice: 0,
                platform: 'yqq',
                needNewCode: 0,
            },
            headers: { Referer: 'https://y.qq.com/', 'User-Agent': BROWSER_USER_AGENT },
            timeout: 15000,
            responseType: 'json',
        },
    );
    const playlist = resp.data?.cdlist?.[0];
    if (!playlist) return null;
    const currentPage = Math.max(Number(page) || 1, 1);
    const start = (currentPage - 1) * ONLINE_PLAYLIST_PAGE_SIZE;
    const songs = Array.isArray(playlist.songlist) ? playlist.songlist : [];
    const pageSongs = songs.slice(start, start + ONLINE_PLAYLIST_PAGE_SIZE);
    return {
        sheetItem: { ...sheetItem, ...mapTencentSheetItem(playlist, platform) },
        musicList: pageSongs.map((item: any) => mapTencentSongInfo(item, platform)),
        isEnd: start + pageSongs.length >= songs.length,
    };
}

async function getKugouTopLists(platform: string): Promise<IMusic.IMusicSheetGroupItem[]> {
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/rank/list', {
        params: { version: 9108, plat: 0 },
        headers: { Referer: 'https://www.kugou.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const list = Array.isArray(resp.data?.data?.info) ? resp.data.data.info : [];
    const data = list
        .filter((item: any) => item?.rankid && item?.rankname)
        .map((item: any) => mapKugouSheetItem(item, platform));
    return data.length ? [{ title: '酷狗音乐', data }] : [];
}

async function getKugouTopListDetail(
    topListItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxTopListInfoResult> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/rank/song', {
        params: {
            rankid: topListItem.raw?.rankid ?? topListItem.id,
            page: currentPage,
            pagesize: ONLINE_PLAYLIST_PAGE_SIZE,
            version: 9108,
            plat: 0,
        },
        headers: { Referer: 'https://www.kugou.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const result = resp.data?.data ?? {};
    const list = Array.isArray(result.info) ? result.info : [];
    const musicList = list.map((item: any) => mapKugouSongInfo(item, platform));
    const total = Number(result.total ?? 0);
    return {
        topListItem,
        musicList,
        isEnd:
            musicList.length < ONLINE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && currentPage * ONLINE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function getKugouRecommendSheetTags(): Promise<ILxRecommendSheetTagsResult> {
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/tag/list', {
        params: { version: 9108, plat: 0 },
        headers: { Referer: 'https://www.kugou.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const groups = Array.isArray(resp.data?.data?.info) ? resp.data.data.info : [];
    const data = groups
        .map((group: any) => ({
            title: cleanSearchText(group?.name),
            data: (Array.isArray(group?.children) ? group.children : [])
                .filter((item: any) => item?.name)
                .map((item: any) => mapRecommendTag(item.special_tag_id ?? item.id, item.name)),
        }))
        .filter((group: IMusic.IMusicSheetGroupItem) => group.data.length);
    const hotTags = groups.flatMap((group: any) =>
        (Array.isArray(group?.children) ? group.children : [])
            .filter((item: any) => item?.is_hot && item?.name)
            .map((item: any) => mapRecommendTag(item.special_tag_id ?? item.id, item.name)),
    );
    return {
        pinned: hotTags.length
            ? hotTags.slice(0, 8)
            : data.flatMap((group: IMusic.IMusicSheetGroupItem) => group.data).slice(0, 8),
        data,
    };
}

async function getKugouRecommendSheetsByTag(
    tag: IMedia.IUnique,
    page: number,
    platform: string,
): Promise<ILxPaginationResponse<IMusic.IMusicSheetItem>> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const keyword = cleanSearchText(tag?.title) || '热门';
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/search/special', {
        params: { keyword, page: currentPage, pagesize: ONLINE_PLAYLIST_PAGE_SIZE },
        headers: { Referer: 'https://www.kugou.com/', 'User-Agent': BROWSER_USER_AGENT },
        timeout: 15000,
        responseType: 'json',
    });
    const result = resp.data?.data ?? {};
    const list = Array.isArray(result.info) ? result.info : [];
    const total = Number(result.total ?? 0);
    return {
        data: list.map((item: any) => mapKugouSheetItem(item, platform)),
        isEnd:
            list.length < ONLINE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && currentPage * ONLINE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function fetchKugouPlaylistInfo(
    sheetItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxSheetInfoResult | null> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const resp = await axios.get('https://mobilecdn.kugou.com/api/v3/special/song', {
        params: {
            specialid: sheetItem.raw?.specialid ?? sheetItem.id,
            page: currentPage,
            pagesize: ONLINE_PLAYLIST_PAGE_SIZE,
            plat: 0,
            version: 9108,
        },
        headers: { Referer: 'https://www.kugou.com/', 'User-Agent': BROWSER_USER_AGENT },
        httpsAgent: KUGOU_HTTPS_AGENT,
        timeout: 15000,
        responseType: 'json',
    });
    const result = resp.data?.data ?? {};
    const list = Array.isArray(result.info) ? result.info : [];
    const total = Number(result.total ?? 0);
    return {
        sheetItem,
        musicList: list.map((item: any) => mapKugouSongInfo(item, platform)),
        isEnd:
            list.length < ONLINE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && currentPage * ONLINE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function getNeteaseTopLists(platform: string): Promise<IMusic.IMusicSheetGroupItem[]> {
    const resp = await axios.get('https://music.163.com/api/toplist/detail', {
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const list = Array.isArray(resp.data?.list) ? resp.data.list : [];
    const data = list
        .filter((item: any) => item?.id && item?.name)
        .map((item: any) => mapNeteaseSheetItem(item, platform));

    return data.length ? [{ title: '网易云音乐', data }] : [];
}

async function fetchNeteasePlaylistInfo(
    sheetItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxSheetInfoResult | null> {
    const playlistId = sheetItem.raw?.id ?? sheetItem.id;
    if (!playlistId) return null;

    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * NETEASE_PLAYLIST_PAGE_SIZE;
    const resp = await axios.get('https://music.163.com/api/v6/playlist/detail', {
        params: {
            id: playlistId,
            n: NETEASE_PLAYLIST_PAGE_SIZE,
            s: 0,
        },
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const playlist = resp.data?.playlist;
    if (!playlist) return null;

    const trackIds = Array.isArray(playlist.trackIds)
        ? playlist.trackIds.map((item: any) => item?.id).filter(Boolean)
        : [];
    const fallbackTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const pageIds = trackIds.slice(offset, offset + NETEASE_PLAYLIST_PAGE_SIZE);
    let tracks: any[] = [];

    if (pageIds.length) {
        const detailById = await fetchNeteaseSongDetails(pageIds);
        tracks = pageIds.map((id: any) => detailById.get(String(id))).filter(Boolean);
    }

    if (!tracks.length && currentPage === 1) {
        tracks = fallbackTracks.slice(0, NETEASE_PLAYLIST_PAGE_SIZE);
    } else if (!trackIds.length) {
        tracks = fallbackTracks.slice(offset, offset + NETEASE_PLAYLIST_PAGE_SIZE);
    }

    const total = Number(playlist.trackCount ?? trackIds.length ?? fallbackTracks.length ?? 0);
    const musicList = tracks
        .filter((item) => item?.id)
        .map((item) => mapNeteaseSongInfo(item, platform) as IMusic.IMusicItem);

    return {
        sheetItem: {
            ...sheetItem,
            ...mapNeteaseSheetItem(playlist, platform),
        },
        musicList,
        isEnd:
            musicList.length < NETEASE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && offset + NETEASE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function getNeteaseTopListDetail(
    topListItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxTopListInfoResult> {
    const result = await fetchNeteasePlaylistInfo(topListItem, page, platform);
    return {
        topListItem: result?.sheetItem ?? topListItem,
        musicList: result?.musicList ?? [],
        isEnd: result?.isEnd ?? true,
    };
}

async function getNeteaseRecommendSheetTags(): Promise<ILxRecommendSheetTagsResult> {
    const resp = await axios.get('https://music.163.com/api/playlist/hottags', {
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const tags: any[] = Array.isArray(resp.data?.tags) ? resp.data.tags : [];
    const mappedTags = tags.map(mapNeteaseTag).filter((item) => item.id);

    return {
        pinned: mappedTags.slice(0, 8),
        data: mappedTags.length ? [{ title: '热门分类', data: mappedTags }] : [],
    };
}

async function getNeteaseRecommendSheetsByTag(
    tag: IMedia.IUnique,
    page: number,
    platform: string,
): Promise<ILxPaginationResponse<IMusic.IMusicSheetItem>> {
    const currentPage = Math.max(Number(page) || 1, 1);
    const category = cleanSearchText(tag?.title ?? tag?.id) || '全部';
    const resp = await axios.get('https://music.163.com/api/playlist/list', {
        params: {
            cat: category,
            order: 'hot',
            offset: (currentPage - 1) * NETEASE_PLAYLIST_PAGE_SIZE,
            limit: NETEASE_PLAYLIST_PAGE_SIZE,
            total: currentPage === 1,
        },
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const playlists = Array.isArray(resp.data?.playlists) ? resp.data.playlists : [];
    const total = Number(resp.data?.total ?? 0);
    return {
        data: playlists.map((item: any) => mapNeteaseSheetItem(item, platform)),
        isEnd:
            resp.data?.more === false ||
            playlists.length < NETEASE_PLAYLIST_PAGE_SIZE ||
            (total > 0 && currentPage * NETEASE_PLAYLIST_PAGE_SIZE >= total),
    };
}

async function getNeteaseMusicSheetInfo(
    sheetItem: IMusic.IMusicSheetItem,
    page: number,
    platform: string,
): Promise<ILxSheetInfoResult | null> {
    return fetchNeteasePlaylistInfo(sheetItem, page, platform);
}

async function getNeteaseAlbumInfo(
    albumItem: IAlbum.IAlbumItem,
    page: number,
    platform: string,
): Promise<IPlugin.IAlbumInfoResult | null> {
    if (page > 1) {
        return {
            albumItem,
            musicList: [],
            isEnd: true,
        };
    }

    const albumId = albumItem.raw?.id ?? albumItem.id;
    if (!albumId) return null;

    const resp = await axios.get(`https://music.163.com/api/v1/album/${albumId}`, {
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const album = resp.data?.album ?? albumItem.raw ?? {};
    const songs = Array.isArray(resp.data?.songs)
        ? resp.data.songs
        : Array.isArray(album?.songs)
          ? album.songs
          : [];

    return {
        albumItem: {
            ...albumItem,
            ...mapNeteaseAlbumItem(album, platform),
        },
        musicList: songs
            .filter((item: any) => item?.id)
            .map((item: any) => mapNeteaseSongInfo(item, platform) as IMusic.IMusicItem),
        isEnd: true,
    };
}

async function getNeteaseArtistWorks(
    artistItem: IArtist.IArtistItem,
    page: number,
    type: IArtist.ArtistMediaType,
    platform: string,
): Promise<ILxSearchResult> {
    const artistId = artistItem.id;
    if (!artistId) return { isEnd: true, data: [] };

    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * LX_SEARCH_PAGE_SIZE;

    if (type === 'album') {
        const resp = await axios.get(`https://music.163.com/api/artist/albums/${artistId}`, {
            params: {
                offset,
                limit: LX_SEARCH_PAGE_SIZE,
            },
            headers: NETEASE_HEADERS,
            timeout: 15000,
            responseType: 'json',
        });

        const albums = Array.isArray(resp.data?.hotAlbums) ? resp.data.hotAlbums : [];
        return {
            isEnd: resp.data?.more === false || albums.length < LX_SEARCH_PAGE_SIZE,
            data: albums.map((item: any) => mapNeteaseAlbumItem(item, platform)),
        };
    }

    const resp = await axios.get('https://music.163.com/api/v1/artist/songs', {
        params: {
            id: artistId,
            order: 'hot',
            offset,
            limit: LX_SEARCH_PAGE_SIZE,
        },
        headers: NETEASE_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const songs = Array.isArray(resp.data?.songs) ? resp.data.songs : [];
    const total = Number(resp.data?.total ?? 0);
    return {
        isEnd:
            resp.data?.more === false ||
            songs.length < LX_SEARCH_PAGE_SIZE ||
            (total > 0 && currentPage * LX_SEARCH_PAGE_SIZE >= total),
        data: songs.map((item: any) => mapNeteaseSongInfo(item, platform)),
    };
}

function parseNeteaseSheetLink(urlLike: string): IParsedSheetLink | null {
    const id =
        getUrlParam(urlLike, ['id', 'playlistId']) ??
        urlLike.match(/\/playlist\/(?:detail\/)?(\d+)/i)?.[1] ??
        parseNumericInput(urlLike);
    return id ? { id } : null;
}

function parseTencentSheetLink(urlLike: string): IParsedSheetLink | null {
    const id =
        getUrlParam(urlLike, ['disstid', 'id', 'dirid']) ??
        urlLike.match(/\/playlist\/(\d+)/i)?.[1] ??
        urlLike.match(/\/n\/ryqq\/playlist\/(\d+)/i)?.[1] ??
        parseNumericInput(urlLike);
    return id ? { id } : null;
}

function parseKuwoSheetLink(urlLike: string): IParsedSheetLink | null {
    const id =
        getUrlParam(urlLike, ['pid', 'playlistId', 'id']) ??
        urlLike.match(/\/playlist(?:_detail)?\/(\d+)/i)?.[1] ??
        urlLike.match(/\/play_detail\/(\d+)/i)?.[1] ??
        parseNumericInput(urlLike);
    return id ? { id } : null;
}

function parseKugouSheetLink(urlLike: string): IParsedSheetLink | null {
    const collection =
        getUrlParam(urlLike, ['global_specialid', 'global_collection_id']) ??
        urlLike.match(/collection_[\w-]+/i)?.[0];
    if (collection) {
        return {
            id: collection,
            url: extractFirstUrl(urlLike) ?? urlLike,
            collection: true,
        };
    }

    const id =
        getUrlParam(urlLike, ['specialid', 'global_collection_id', 'id']) ??
        urlLike.match(/\/special\/single\/(\d+)\.html/i)?.[1] ??
        urlLike.match(/\/plist\/list\/(\d+)/i)?.[1] ??
        urlLike.match(/\/playlist\/(\d+)/i)?.[1] ??
        parseNumericInput(urlLike);
    return id ? { id } : null;
}

function extractKugouCollectionData(html: string): any[] {
    const marker = html.match(/var\s+data\s*=\s*\[/);
    if (!marker?.index) return [];

    const start = html.indexOf('[', marker.index);
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < html.length; i += 1) {
        const ch = html[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '[') {
            depth += 1;
        } else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(html.slice(start, i + 1));
                    return Array.isArray(parsed) ? parsed : [];
                } catch {
                    return [];
                }
            }
        }
    }

    return [];
}

async function importNeteaseMusicSheet(
    urlLike: string,
    platform: string,
): Promise<IMusic.IMusicItem[]> {
    const resolved = await resolveShareUrl(urlLike);
    const parsed = parseNeteaseSheetLink(resolved);
    if (!parsed?.id) return [];

    const sheet = await fetchNeteasePlaylistInfo(
        { id: parsed.id, platform, title: '' },
        1,
        platform,
    );
    if (!sheet?.sheetItem?.raw) return sheet?.musicList ?? [];

    const raw = sheet.sheetItem.raw;
    const trackIds = Array.isArray(raw.trackIds)
        ? raw.trackIds.map((item: any) => item?.id).filter(Boolean)
        : [];
    if (!trackIds.length) return sheet.musicList ?? [];

    const chunks: unknown[][] = [];
    for (let i = 0; i < trackIds.length; i += 500) {
        chunks.push(trackIds.slice(i, i + 500));
    }

    const musicList: IMusic.IMusicItem[] = [];
    for (const chunk of chunks) {
        const detailById = await fetchNeteaseSongDetails(chunk);
        for (const id of chunk) {
            const song = detailById.get(String(id));
            if (song) {
                musicList.push(mapNeteaseSongInfo(song, platform) as IMusic.IMusicItem);
            }
        }
    }

    return musicList;
}

async function importTencentMusicSheet(
    urlLike: string,
    platform: string,
): Promise<IMusic.IMusicItem[]> {
    const resolved = await resolveShareUrl(urlLike);
    const parsed = parseTencentSheetLink(resolved);
    if (!parsed?.id) return [];

    const resp = await axios.get(
        'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
        {
            params: {
                type: 1,
                json: 1,
                utf8: 1,
                onlysong: 0,
                disstid: parsed.id,
                format: 'json',
                g_tk: 5381,
                loginUin: 0,
                hostUin: 0,
                inCharset: 'utf8',
                outCharset: 'utf-8',
                notice: 0,
                platform: 'yqq',
                needNewCode: 0,
            },
            headers: {
                Referer: 'https://y.qq.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const list = resp.data?.cdlist?.[0]?.songlist;
    return Array.isArray(list) ? list.map((item: any) => mapTencentSongInfo(item, platform)) : [];
}

async function importKuwoMusicSheet(
    urlLike: string,
    platform: string,
): Promise<IMusic.IMusicItem[]> {
    const resolved = await resolveShareUrl(urlLike);
    const parsed = parseKuwoSheetLink(resolved);
    if (!parsed?.id) return [];

    const firstResp = await axios.get('https://nplserver.kuwo.cn/pl.svc', {
        params: {
            op: 'getlistinfo',
            pid: parsed.id,
            pn: 0,
            rn: 1,
            encode: 'utf8',
            keyset: 'pl2012',
        },
        headers: {
            Referer: 'https://www.kuwo.cn/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const total = Number(firstResp.data?.total ?? 0);
    const resp = await axios.get('https://nplserver.kuwo.cn/pl.svc', {
        params: {
            op: 'getlistinfo',
            pid: parsed.id,
            pn: 0,
            rn: Math.max(total, 500),
            encode: 'utf8',
            keyset: 'pl2012',
        },
        headers: {
            Referer: 'https://www.kuwo.cn/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const list = Array.isArray(resp.data?.musiclist) ? resp.data.musiclist : [];
    return list.map((item: any) => mapKuwoSongInfo(item, platform));
}

async function importKugouMusicSheet(
    urlLike: string,
    platform: string,
): Promise<IMusic.IMusicItem[]> {
    const resolved = await resolveShareUrl(urlLike);
    const parsed = parseKugouSheetLink(resolved);
    if (!parsed?.id) return [];

    if (parsed.collection) {
        const url = `https://www.kugou.com/yy/special/single/${parsed.id}.html`;
        const resp = await axios.get(url, {
            headers: {
                Referer: 'https://www.kugou.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            timeout: 15000,
            responseType: 'text',
        });
        return extractKugouCollectionData(String(resp.data)).map((item: any) =>
            mapKugouSongInfo(item, platform),
        );
    }

    const pageSize = 200;
    const musicList: IMusic.IMusicItem[] = [];
    let page = 1;
    let total = Infinity;

    while (musicList.length < total && page <= 20) {
        const resp = await axios.get('https://mobilecdn.kugou.com/api/v3/special/song', {
            params: {
                specialid: parsed.id,
                page,
                pagesize: pageSize,
                plat: 0,
                version: 9108,
            },
            headers: {
                Referer: 'https://www.kugou.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            httpsAgent: KUGOU_HTTPS_AGENT,
            timeout: 15000,
            responseType: 'json',
        });

        const data = resp.data?.data ?? {};
        const list = Array.isArray(data.info) ? data.info : [];
        total = Number(data.total ?? list.length);
        if (!list.length) break;
        musicList.push(...list.map((item: any) => mapKugouSongInfo(item, platform)));
        page += 1;
    }

    return musicList;
}

async function searchTencentMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const resp = await axios.get('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
        params: {
            format: 'json',
            w: query,
            p: page,
            n: LX_SEARCH_PAGE_SIZE,
        },
        headers: {
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const song = resp.data?.data?.song ?? {};
    const list = Array.isArray(song.list) ? song.list : [];
    return {
        isEnd:
            list.length < LX_SEARCH_PAGE_SIZE || page * LX_SEARCH_PAGE_SIZE >= (song.totalnum ?? 0),
        data: list.map((item: any) => mapTencentSongInfo(item, platform)),
    };
}

async function searchNeteaseMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.post(
        'https://music.163.com/api/search/get/web',
        new URLSearchParams({
            s: query,
            type: '1',
            offset: String((currentPage - 1) * LX_SEARCH_PAGE_SIZE),
            limit: String(LX_SEARCH_PAGE_SIZE),
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: 'https://music.163.com/',
                'User-Agent': BROWSER_USER_AGENT,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const result = resp.data?.result ?? {};
    const list = Array.isArray(result.songs) ? result.songs : [];
    const total = Number(result.songCount ?? 0);
    const detailById = await fetchNeteaseSongDetails(list.map((item: any) => item.id));

    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => {
            const detail = detailById.get(String(item.id));
            const merged = {
                ...mapNeteaseSongInfo(detail ?? item, platform),
                raw: {
                    ...item,
                    detail,
                },
            };

            if (!merged.album) merged.album = cleanSearchText(item.album?.name);
            if (!merged.artwork) merged.artwork = item.album?.picUrl ?? item.album?.blurPicUrl;
            if (!merged.duration) merged.duration = normalizeDurationSeconds(item.duration);
            return merged;
        }),
    };
}

async function searchNeteaseAlbum(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'album'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.post(
        'https://music.163.com/api/search/get/web',
        new URLSearchParams({
            s: query,
            type: '10',
            offset: String((currentPage - 1) * LX_SEARCH_PAGE_SIZE),
            limit: String(LX_SEARCH_PAGE_SIZE),
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...NETEASE_HEADERS,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const result = resp.data?.result ?? {};
    const list = Array.isArray(result.albums) ? result.albums : [];
    const total = Number(result.albumCount ?? 0);

    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => mapNeteaseAlbumItem(item, platform)),
    };
}

async function searchNeteaseArtist(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'artist'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.post(
        'https://music.163.com/api/search/get/web',
        new URLSearchParams({
            s: query,
            type: '100',
            offset: String((currentPage - 1) * LX_SEARCH_PAGE_SIZE),
            limit: String(LX_SEARCH_PAGE_SIZE),
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...NETEASE_HEADERS,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const result = resp.data?.result ?? {};
    const list = Array.isArray(result.artists) ? result.artists : [];
    const total = Number(result.artistCount ?? 0);

    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => mapNeteaseArtistItem(item, platform)),
    };
}

async function searchNeteaseSheet(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'sheet'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.post(
        'https://music.163.com/api/search/get/web',
        new URLSearchParams({
            s: query,
            type: '1000',
            offset: String((currentPage - 1) * LX_SEARCH_PAGE_SIZE),
            limit: String(LX_SEARCH_PAGE_SIZE),
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...NETEASE_HEADERS,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const result = resp.data?.result ?? {};
    const list = Array.isArray(result.playlists) ? result.playlists : [];
    const total = Number(result.playlistCount ?? 0);

    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => mapNeteaseSheetItem(item, platform)),
    };
}

async function searchKugouMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const resp = await axios.get('https://mobiles.kugou.com/api/v3/search/song', {
        params: {
            format: 'json',
            keyword: query,
            page,
            pagesize: LX_SEARCH_PAGE_SIZE,
            showtype: 1,
        },
        headers: {
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const data = resp.data?.data ?? {};
    const list = Array.isArray(data.info) ? data.info : [];
    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || page * LX_SEARCH_PAGE_SIZE >= (data.total ?? 0),
        data: list.map((item: any) => mapKugouSongInfo(item, platform)),
    };
}

async function searchKuwoMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.get('https://search.kuwo.cn/r.s', {
        params: {
            client: 'kt',
            all: query,
            pn: currentPage - 1,
            rn: LX_SEARCH_PAGE_SIZE,
            uid: 0,
            ver: 'kwplayer_ar_9.2.2.1',
            vipver: 1,
            show_copyright_off: 1,
            newver: 1,
            ft: 'music',
            cluster: 0,
            strategy: 2012,
            encoding: 'utf8',
            rformat: 'json',
            mobi: 1,
        },
        headers: {
            Referer: 'https://www.kuwo.cn/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const list = Array.isArray(resp.data?.abslist) ? resp.data.abslist : [];
    const total = Number(resp.data?.TOTAL ?? resp.data?.HIT ?? 0);
    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => mapKuwoSongInfo(item, platform)),
    };
}

async function searchMiguMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.get(
        'https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do',
        {
            params: {
                text: query,
                pageNo: currentPage,
                pageSize: LX_SEARCH_PAGE_SIZE,
                searchSwitch: JSON.stringify({
                    song: 1,
                    album: 0,
                    singer: 0,
                    tagSong: 0,
                    mvSong: 0,
                    songlist: 0,
                    bestShow: 1,
                }),
            },
            headers: {
                Referer: 'http://music.migu.cn/',
                'User-Agent': MOBILE_USER_AGENT,
            },
            timeout: 15000,
            responseType: 'json',
        },
    );

    const result = resp.data?.songResultData ?? {};
    const list = Array.isArray(result.result) ? result.result : [];
    const total = Number(result.totalCount ?? 0);
    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || currentPage * LX_SEARCH_PAGE_SIZE >= total,
        data: list.map((item: any) => {
            const id = String(item.copyrightId ?? item.contentId ?? item.id);
            return {
                id,
                platform,
                title: cleanSearchText(item.name),
                artist: normalizeArtistNames(item.singers),
                album: cleanSearchText(item.albums?.[0]?.name),
                artwork: pickMiguArtwork(item.imgItems),
                raw: item,
                songId: item.id,
                songmid: id,
                contentId: item.contentId,
                copyrightId: item.copyrightId,
                lrc: item.lyricUrl,
            };
        }),
    };
}

async function searchQishuiMusic(
    query: string,
    page: number,
    platform: string,
): Promise<IPlugin.ISearchResult<'music'>> {
    const currentPage = Math.max(page, 1);
    const resp = await axios.get(QISHUI_SEARCH_URL, {
        params: {
            ...QISHUI_API_PARAMS,
            _rticket: String(Date.now()),
            q: query,
            // 汽水接口用 cursor 而不是页码，按页大小换算
            cursor: String((currentPage - 1) * LX_SEARCH_PAGE_SIZE),
            count: String(LX_SEARCH_PAGE_SIZE),
        },
        headers: QISHUI_API_HEADERS,
        timeout: 15000,
        responseType: 'json',
    });

    const groups = Array.isArray(resp.data?.result_groups) ? resp.data.result_groups : [];
    const list = groups
        .flatMap((group: any) => (Array.isArray(group?.data) ? group.data : []))
        .map((entry: any) => entry?.entity?.track ?? entry?.track ?? null)
        .filter(Boolean);

    return {
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || !groups.some((group: any) => group?.has_more),
        data: list.map((track: any) => mapQishuiSongInfo(track, platform)),
    };
}

async function getNeteaseMusicInfo(
    musicInfo: Record<string, any>,
): Promise<Partial<IMusic.IMusicItem> | null> {
    const songId = musicInfo.songmid ?? musicInfo.songId ?? musicInfo.id;
    const detailById = await fetchNeteaseSongDetails([songId]);
    const detail = detailById.get(String(songId));
    if (!detail) return null;

    return mapNeteaseSongInfo(detail, musicInfo.platform ?? '');
}

async function getNeteaseLyric(
    musicInfo: Record<string, any>,
): Promise<ILyric.ILyricSource | null> {
    const songId = musicInfo.songmid ?? musicInfo.songId ?? musicInfo.id;
    if (!songId) return null;

    const resp = await axios.get('https://music.163.com/api/song/lyric', {
        params: {
            id: songId,
            lv: 1,
            kv: 1,
            tv: -1,
        },
        headers: {
            Referer: 'https://music.163.com/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const rawLrc = decodeTextEntities(resp.data?.lrc?.lyric);
    const translation = decodeTextEntities(resp.data?.tlyric?.lyric);
    if (!rawLrc && !translation) return null;

    return {
        rawLrc,
        translation,
    };
}

async function getTencentLyric(
    musicInfo: Record<string, any>,
): Promise<ILyric.ILyricSource | null> {
    const songmid =
        musicInfo.songmid ?? musicInfo.media_mid ?? musicInfo.strMediaMid ?? musicInfo.id;
    if (!songmid) return null;

    const resp = await axios.get('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        params: {
            songmid,
            format: 'json',
            nobase64: 1,
        },
        headers: {
            Referer: 'https://y.qq.com/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const rawLrc = decodeTextEntities(resp.data?.lyric);
    const translation = decodeTextEntities(resp.data?.trans);
    if (!rawLrc && !translation) return null;

    return {
        rawLrc,
        translation,
    };
}

async function getKugouLyric(musicInfo: Record<string, any>): Promise<ILyric.ILyricSource | null> {
    const hash = musicInfo.hash ?? musicInfo.id;
    const keyword = [
        musicInfo.title ?? musicInfo.songname,
        musicInfo.artist ?? musicInfo.singername,
    ]
        .filter(Boolean)
        .join(' ');
    if (!hash || !keyword) return null;

    const duration = normalizeDurationSeconds(musicInfo.duration);
    const resp = await axios.get('https://lyrics.kugou.com/search', {
        params: {
            ver: 1,
            man: 'yes',
            client: 'pc',
            keyword,
            duration: duration ? duration * 1000 : undefined,
            hash,
        },
        headers: {
            Referer: 'https://www.kugou.com/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const candidates = Array.isArray(resp.data?.candidates) ? resp.data.candidates : [];
    const candidate = candidates[0];
    if (!candidate?.id || !candidate?.accesskey) return null;

    const downloadResp = await axios.get('https://lyrics.kugou.com/download', {
        params: {
            ver: 1,
            client: 'pc',
            id: candidate.id,
            accesskey: candidate.accesskey,
            fmt: 'lrc',
            charset: 'utf8',
        },
        headers: {
            Referer: 'https://www.kugou.com/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const content = downloadResp.data?.content;
    if (typeof content !== 'string' || !content) return null;

    const rawLrc = decodeTextEntities(decodeBase64Utf8(content));
    return rawLrc ? { rawLrc } : null;
}

async function getKuwoLyric(musicInfo: Record<string, any>): Promise<ILyric.ILyricSource | null> {
    const musicId = String(
        musicInfo.rid ?? musicInfo.songmid ?? musicInfo.DC_TARGETID ?? musicInfo.id ?? '',
    ).replace(/^MUSIC_/, '');
    if (!musicId) return null;

    const resp = await axios.get('https://m.kuwo.cn/newh5/singles/songinfoandlrc', {
        params: {
            musicId,
        },
        headers: {
            Referer: 'https://m.kuwo.cn/',
            'User-Agent': BROWSER_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'json',
    });

    const rawLrc = buildKuwoLyricText(resp.data?.data?.lrclist);
    return rawLrc ? { rawLrc } : null;
}

async function getMiguLyric(musicInfo: Record<string, any>): Promise<ILyric.ILyricSource | null> {
    const lrcUrl = musicInfo.lrc ?? musicInfo.lyricUrl;
    if (!lrcUrl) return null;

    const resp = await axios.get(lrcUrl, {
        headers: {
            Referer: 'https://music.migu.cn/',
            'User-Agent': MOBILE_USER_AGENT,
        },
        timeout: 15000,
        responseType: 'text',
    });

    const rawLrc = decodeTextEntities(resp.data);
    return rawLrc ? { rawLrc, lrc: lrcUrl } : null;
}

// lyric 搜索复用 music 搜索器：搜索结果项为 IMusicItem（含 raw 字段），
// 关联歌词时由对应的 LX_LYRIC_GETTERS 取词。
const LX_MEDIA_SEARCHERS: Record<
    string,
    Partial<Record<IMedia.SupportMediaType, ILxMediaSearcher>>
> = {
    tx: {
        music: searchTencentMusic,
        lyric: searchTencentMusic,
    },
    kg: {
        music: searchKugouMusic,
        lyric: searchKugouMusic,
    },
    wy: {
        music: searchNeteaseMusic,
        album: searchNeteaseAlbum,
        artist: searchNeteaseArtist,
        sheet: searchNeteaseSheet,
        lyric: searchNeteaseMusic,
    },
    kw: {
        music: searchKuwoMusic,
        lyric: searchKuwoMusic,
    },
    mg: {
        music: searchMiguMusic,
        lyric: searchMiguMusic,
    },
    // 社区音源对汽水平台存在 qs / qishui 两种 key，统一走同一套搜索
    qs: {
        music: searchQishuiMusic,
    },
    qishui: {
        music: searchQishuiMusic,
    },
};

const LX_LYRIC_GETTERS: Record<string, ILxLyricGetter> = {
    tx: getTencentLyric,
    kg: getKugouLyric,
    wy: getNeteaseLyric,
    kw: getKuwoLyric,
    mg: getMiguLyric,
};

const LX_MUSIC_INFO_GETTERS: Record<string, ILxMusicInfoGetter> = {
    wy: getNeteaseMusicInfo,
};

const LX_MUSIC_SHEET_IMPORTERS: Record<string, ILxMusicSheetImporter> = {
    tx: importTencentMusicSheet,
    kg: importKugouMusicSheet,
    wy: importNeteaseMusicSheet,
    kw: importKuwoMusicSheet,
};

const LX_ALBUM_INFO_GETTERS: Record<string, ILxAlbumInfoGetter> = {
    wy: getNeteaseAlbumInfo,
};

const LX_ARTIST_WORKS_GETTERS: Record<string, ILxArtistWorksGetter> = {
    wy: getNeteaseArtistWorks,
};

const LX_TOP_LIST_GETTERS: Record<string, ILxTopListsGetter> = {
    tx: getTencentTopLists,
    kg: getKugouTopLists,
    wy: getNeteaseTopLists,
};

const LX_TOP_LIST_DETAIL_GETTERS: Record<string, ILxTopListDetailGetter> = {
    tx: getTencentTopListDetail,
    kg: getKugouTopListDetail,
    wy: getNeteaseTopListDetail,
};

const LX_RECOMMEND_TAG_GETTERS: Record<string, ILxRecommendTagsGetter> = {
    tx: getTencentRecommendSheetTags,
    kg: getKugouRecommendSheetTags,
    wy: getNeteaseRecommendSheetTags,
};

const LX_RECOMMEND_SHEET_GETTERS: Record<string, ILxRecommendSheetsGetter> = {
    tx: getTencentRecommendSheetsByTag,
    kg: getKugouRecommendSheetsByTag,
    wy: getNeteaseRecommendSheetsByTag,
};

const LX_MUSIC_SHEET_INFO_GETTERS: Record<string, ILxMusicSheetInfoGetter> = {
    tx: fetchTencentPlaylistInfo,
    kg: fetchKugouPlaylistInfo,
    wy: getNeteaseMusicSheetInfo,
};

/**
 * 判断脚本是否为洛雪插件。
 * 混淆后的插件会用 globalThis['\x6c\x78'] / globalThis['lx'] 代替 globalThis.lx，
 * 只匹配字面量 lx 会把这些插件误判为非洛雪脚本。
 */
function looksLikeLxPlugin(code: string): boolean {
    if (!/globalThis/.test(code)) return false;
    return /globalThis\s*(?:\.\s*lx|\[\s*['"]lx['"]\s*\]|\[\s*['"]\\x6c\\x78['"]\s*\]|\[\s*['"]\\u006c\\u0078['"]\s*\])/i.test(
        code,
    );
}

/**
 * 在沙箱中执行洛雪插件，返回由 initSource 事件声明的音源实例列表。
 *
 * 洛雪插件通过 globalThis.lx 注册 request 监听，
 * 再通过 inited 事件发送 sources。这里把每个 source 适配成一个只负责
 * getMediaSource 的安禾插件实例，供应用的音源重定向功能使用。
 */
export async function executeLxPluginCode(
    code: string,
    hash: string,
    pluginPath: string,
): Promise<IPlugin.IPluginInstance[] | null> {
    if (!looksLikeLxPlugin(code)) {
        return null;
    }

    const meta = readPluginHeader(code);
    const requestHandlers: ILxRequestHandler[] = [];
    let initedPayload: ILxInitedPayload | null = null;
    let updateUrl = meta.update_url;

    const lx = {
        EVENT_NAMES: LX_EVENT_NAMES,
        // 洛雪运行时版本与环境标识：部分音源据此判断是否启用 utils、以及拼接 User-Agent
        version: '2.0.0',
        env: 'desktop',
        // 脚本元信息：flower/grass 等音源初始化时会直接读取 currentScriptInfo.version
        currentScriptInfo: {
            name: meta.name,
            description: meta.description,
            version: meta.version,
            author: meta.author,
            homepage: meta.homepage,
            rawScript: code,
        },
        utils: lxUtils,
        on(eventName: string, handler: ILxRequestHandler) {
            if (eventName === LX_EVENT_NAMES.request && typeof handler === 'function') {
                requestHandlers.push(handler);
            }
        },
        send(eventName: string, payload: any) {
            if (eventName === LX_EVENT_NAMES.inited) {
                initedPayload = payload;
            } else if (eventName === LX_EVENT_NAMES.updateAlert && payload?.updateUrl) {
                updateUrl = payload.updateUrl;
            }
        },
        request(
            url: string,
            _options: Record<string, any>,
            callback: (err: any, resp: any) => void,
        ) {
            if (url === updateUrl) {
                callback(new Error('Update checks are handled by the app'), {
                    statusCode: 500,
                    body: null,
                });
                return;
            }

            hostHttp(_options?.method ?? 'GET', url, {
                timeout: _options?.timeout ?? 15000,
                responseType: 'json',
                body: _options?.body,
                headers: _options?.headers,
            })
                .then((resp) => {
                    callback(null, {
                        statusCode: resp.status,
                        headers: resp.headers,
                        body: resp.data,
                    });
                })
                .catch((err) => {
                    callback(err, {
                        statusCode: 500,
                        headers: {},
                        body: null,
                    });
                });
        },
    };

    const sandboxBaseGlobals: Record<string, any> = {
        lx,
        console: {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            info: console.info.bind(console),
            debug: console.debug.bind(console),
            trace: console.trace.bind(console),
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Promise,
        URL,
        URLSearchParams,
        Buffer: BufferShim,
        TextEncoder,
        TextDecoder,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        btoa,
        atob,
        fetch: globalThis.fetch,
        AbortController,
        AbortSignal,
        Blob,
        JSON,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Date,
        RegExp,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Symbol,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        undefined,
        NaN,
        Infinity,
    };
    sandboxBaseGlobals.globalThis = sandboxBaseGlobals;
    const sandboxGlobals = createProtectedGlobal(sandboxBaseGlobals);

    try {
        // Worker 环境改用 new Function 执行；lx 经参数注入，插件闭包仍可捕获自身作用域
        const runner = new Function('globalThis', `var lx = globalThis.lx;\n${code}`);
        runner(sandboxGlobals as any);

        // 洛雪插件可能在 Promise.then 或异步请求后才发送 inited，轮询等待（最多 3 秒）
        for (let i = 0; i < 60; i++) {
            if (initedPayload?.sources && requestHandlers.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (!initedPayload?.sources || requestHandlers.length === 0) {
            return null;
        }

        const instances: IPlugin.IPluginInstance[] = [];
        for (const [sourceKey, source] of Object.entries(initedPayload.sources)) {
            if (source?.type && source.type !== 'music') continue;
            if (source?.actions && !source.actions.includes('musicUrl')) continue;

            const platform = source.name ?? `${meta.name ?? '洛雪音源'}-${sourceKey}`;
            const sourceSearchers = LX_MEDIA_SEARCHERS[sourceKey] ?? {};
            const supportedSearchType = Object.keys(sourceSearchers) as IMedia.SupportMediaType[];
            const instance: IPlugin.IPluginInstance = {
                platform,
                version: meta.version,
                author: meta.author,
                description: meta.description,
                srcUrl: updateUrl,
                defaultSearchType: 'music',
                supportedSearchType,
                async getMediaSource(musicItem, quality) {
                    const lxQuality = getLxQuality(sourceKey, quality);
                    const musicInfo = buildLxMusicInfo(musicItem, sourceKey);

                    const officialSource = await getOfficialLxMediaSource(
                        sourceKey,
                        musicInfo,
                        quality,
                    );
                    if (officialSource?.url) {
                        return officialSource;
                    }

                    const payload = {
                        source: sourceKey,
                        action: 'musicUrl',
                        info: {
                            musicInfo,
                            type: lxQuality,
                        },
                    };

                    for (const handler of requestHandlers) {
                        const result = await handler(payload);
                        const normalized = normalizeLxMusicUrlResult(result);
                        if (normalized?.url) {
                            return {
                                ...normalized,
                                url: normalizeLxMusicUrl(normalized.url, sourceKey),
                                quality,
                            };
                        }
                    }
                    return null;
                },
                _path: pluginPath,
            };
            if (supportedSearchType.length) {
                instance.search = async (query, page, type) => {
                    const searcher = sourceSearchers[type];
                    if (!searcher) return { isEnd: true, data: [] } as any;
                    return searcher(query, page, platform) as any;
                };
            }

            const lyricGetter = LX_LYRIC_GETTERS[sourceKey];
            if (lyricGetter) {
                instance.getLyric = async (musicItem) =>
                    lyricGetter(buildLxMusicInfo(musicItem, sourceKey));
            }

            const musicInfoGetter = LX_MUSIC_INFO_GETTERS[sourceKey];
            if (musicInfoGetter) {
                instance.getMusicInfo = async (musicItem) =>
                    musicInfoGetter({
                        ...buildLxMusicInfo(musicItem, sourceKey),
                        platform,
                    });
            }

            const musicSheetImporter = LX_MUSIC_SHEET_IMPORTERS[sourceKey];
            if (musicSheetImporter) {
                instance.importMusicSheet = async (urlLike) =>
                    musicSheetImporter(urlLike, platform);
            }

            const albumInfoGetter = LX_ALBUM_INFO_GETTERS[sourceKey];
            if (albumInfoGetter) {
                instance.getAlbumInfo = async (albumItem, page) =>
                    albumInfoGetter(albumItem, page, platform);
            }

            const artistWorksGetter = LX_ARTIST_WORKS_GETTERS[sourceKey];
            if (artistWorksGetter) {
                instance.getArtistWorks = async (artistItem, page, type) =>
                    artistWorksGetter(artistItem, page, type, platform) as any;
            }

            const topListsGetter = LX_TOP_LIST_GETTERS[sourceKey];
            if (topListsGetter) {
                instance.getTopLists = async () => topListsGetter(platform);
            }

            const topListDetailGetter = LX_TOP_LIST_DETAIL_GETTERS[sourceKey];
            if (topListDetailGetter) {
                instance.getTopListDetail = async (topListItem, page) =>
                    topListDetailGetter(topListItem, page, platform);
            }

            const recommendTagGetter = LX_RECOMMEND_TAG_GETTERS[sourceKey];
            if (recommendTagGetter) {
                instance.getRecommendSheetTags = async () => recommendTagGetter();
            }

            const recommendSheetGetter = LX_RECOMMEND_SHEET_GETTERS[sourceKey];
            if (recommendSheetGetter) {
                instance.getRecommendSheetsByTag = async (tag, page = 1) =>
                    recommendSheetGetter(tag, page, platform);
            }

            const musicSheetInfoGetter = LX_MUSIC_SHEET_INFO_GETTERS[sourceKey];
            if (musicSheetInfoGetter) {
                instance.getMusicSheetInfo = async (sheetItem, page) =>
                    musicSheetInfoGetter(sheetItem, page, platform);
            }

            instances.push(instance);
        }

        return instances.length > 0 ? instances : null;
    } catch (err) {
        console.error(`[PluginSandbox] Failed to execute lx plugin at ${pluginPath}:`, err);
        return null;
    }
}

/**
 * 从插件实例中提取 delegate（序列化安全的纯数据对象）。
 * delegate 不包含函数，可安全传递到渲染进程。
 *
 * @param instance 插件实例
 * @param hash 插件代码哈希
 */
export function extractPluginDelegate(
    instance: IPlugin.IPluginInstance,
    hash: string,
): IPlugin.IPluginDelegate {
    // 提取支持的方法名列表
    const supportedMethod: string[] = [];
    for (const key of Object.keys(instance)) {
        if (typeof (instance as any)[key] === 'function') {
            supportedMethod.push(key);
        }
    }

    // 深拷贝纯数据部分
    const raw: Record<string, any> = {};
    for (const key of Object.keys(instance)) {
        if (typeof (instance as any)[key] !== 'function') {
            raw[key] = (instance as any)[key];
        }
    }

    const delegate: IPlugin.IPluginDelegate = {
        ...JSON.parse(JSON.stringify(raw)),
        supportedMethod,
        hash,
        path: instance._path,
    };

    return delegate;
}
