/**
 * pluginManager — 插件沙箱
 *
 * 使用 Node.js vm.createContext 创建安全的插件运行环境。
 * 每个插件在独立的 Context 中执行，通过 Proxy 冻结全局对象防止逃逸。
 * 使用 Node.js crypto 计算插件代码的 SHA256 哈希值作为唯一标识。
 */

import vm from 'vm';
import crypto from 'crypto';
import axios from 'axios';

/** 计算代码的 SHA256 哈希 */
export function computeHash(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
}

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
const BROWSER_USER_AGENT = 'Mozilla/5.0';
const MOBILE_USER_AGENT =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

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

type ILxMusicSearcher = (
    query: string,
    page: number,
    platform: string,
) => Promise<IPlugin.ISearchResult<'music'>>;
type ILxLyricGetter = (musicInfo: Record<string, any>) => Promise<ILyric.ILyricSource | null>;
type ILxMusicInfoGetter = (
    musicInfo: Record<string, any>,
) => Promise<Partial<IMusic.IMusicItem> | null>;

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
    const ids = songIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);

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
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || page * LX_SEARCH_PAGE_SIZE >= (song.totalnum ?? 0),
        data: list.map((item: any) => ({
            id: String(item.songmid ?? item.songid ?? item.media_mid ?? item.strMediaMid),
            platform,
            title: item.songname ?? item.name ?? '',
            artist: normalizeArtistNames(item.singer),
            album: item.albumname ?? '',
            artwork: item.albummid
                ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg`
                : undefined,
            duration: item.interval,
            raw: item,
            songmid: item.songmid,
            media_mid: item.media_mid,
            strMediaMid: item.strMediaMid,
        })),
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
        data: list.map((item: any) => ({
            id: String(item.hash ?? item.audio_id),
            platform,
            title: item.songname ?? item.songname_original ?? '',
            artist: normalizeArtistNames(item.singername),
            album: item.album_name ?? '',
            artwork: item.trans_param?.union_cover
                ? String(item.trans_param.union_cover).replace('{size}', '300')
                : undefined,
            duration: item.duration,
            raw: item,
            hash: item.hash,
        })),
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
        data: list.map((item: any) => {
            const rid = String(item.DC_TARGETID ?? item.MUSICRID ?? '').replace(/^MUSIC_/, '');
            return {
                id: rid,
                platform,
                title: cleanSearchText(item.SONGNAME ?? item.NAME),
                artist: cleanSearchText(item.ARTIST ?? item.FARTIST),
                album: cleanSearchText(item.ALBUM),
                artwork: buildKuwoArtwork(item.web_albumpic_short),
                duration: normalizeDurationSeconds(item.DURATION),
                raw: item,
                rid,
                songmid: rid,
                musicrid: item.MUSICRID,
                MUSICRID: item.MUSICRID,
                DC_TARGETID: item.DC_TARGETID,
            };
        }),
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
    const songmid = musicInfo.songmid ?? musicInfo.media_mid ?? musicInfo.strMediaMid ?? musicInfo.id;
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

async function getKugouLyric(
    musicInfo: Record<string, any>,
): Promise<ILyric.ILyricSource | null> {
    const hash = musicInfo.hash ?? musicInfo.id;
    const keyword = [musicInfo.title ?? musicInfo.songname, musicInfo.artist ?? musicInfo.singername]
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

    const rawLrc = decodeTextEntities(Buffer.from(content, 'base64').toString('utf8'));
    return rawLrc ? { rawLrc } : null;
}

async function getKuwoLyric(
    musicInfo: Record<string, any>,
): Promise<ILyric.ILyricSource | null> {
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

async function getMiguLyric(
    musicInfo: Record<string, any>,
): Promise<ILyric.ILyricSource | null> {
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

const LX_MUSIC_SEARCHERS: Record<string, ILxMusicSearcher> = {
    tx: searchTencentMusic,
    kg: searchKugouMusic,
    wy: searchNeteaseMusic,
    kw: searchKuwoMusic,
    mg: searchMiguMusic,
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
    if (!/globalThis\s*(?:\.\s*lx|\[\s*['"]lx['"]\s*\])/.test(code)) {
        return null;
    }

    const meta = readPluginHeader(code);
    const requestHandlers: ILxRequestHandler[] = [];
    let initedPayload: ILxInitedPayload | null = null;
    let updateUrl = meta.update_url;

    const lx = {
        EVENT_NAMES: LX_EVENT_NAMES,
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
        request(url: string, _options: Record<string, any>, callback: (err: any, resp: any) => void) {
            if (url === updateUrl) {
                callback(new Error('Update checks are handled by the app'), {
                    statusCode: 500,
                    body: null,
                });
                return;
            }

            axios
                .request({
                    url,
                    method: _options?.method ?? 'GET',
                    timeout: _options?.timeout ?? 15000,
                    responseType: 'json',
                    data: _options?.body,
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
                        statusCode: err?.response?.status,
                        headers: err?.response?.headers,
                        body: err?.response?.data,
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
        Buffer,
        TextEncoder,
        TextDecoder,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        btoa: (s: string) => Buffer.from(s).toString('base64'),
        atob: (s: string) => Buffer.from(s, 'base64').toString(),
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
        const context = vm.createContext(sandboxGlobals);
        const script = new vm.Script(code, {
            filename: `lx-plugin-${pluginPath || 'anonymous'}.js`,
        });

        script.runInContext(context, { timeout: 10000 });

        // 洛雪插件常在 Promise.then 中发送 inited，等待一轮任务让初始化落地。
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (!initedPayload?.sources || requestHandlers.length === 0) {
            return null;
        }

        const instances: IPlugin.IPluginInstance[] = [];
        for (const [sourceKey, source] of Object.entries(initedPayload.sources)) {
            if (source?.type && source.type !== 'music') continue;
            if (source?.actions && !source.actions.includes('musicUrl')) continue;

            const platform = source.name ?? `${meta.name ?? '洛雪音源'}-${sourceKey}`;
            const instance: IPlugin.IPluginInstance = {
                platform,
                version: meta.version,
                author: meta.author,
                description: meta.description,
                srcUrl: updateUrl,
                defaultSearchType: 'music',
                supportedSearchType: LX_MUSIC_SEARCHERS[sourceKey] ? ['music'] : [],
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
            const searcher = LX_MUSIC_SEARCHERS[sourceKey];
            if (searcher) {
                instance.search = async (query, page, type) => {
                    if (type !== 'music') return { isEnd: true, data: [] } as any;
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
