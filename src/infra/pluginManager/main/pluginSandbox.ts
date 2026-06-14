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
import https from 'https';

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
const NETEASE_PLAYLIST_PAGE_SIZE = 30;
const BROWSER_USER_AGENT = 'Mozilla/5.0';
const MOBILE_USER_AGENT =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const NETEASE_HEADERS = {
    Referer: 'https://music.163.com/',
    'User-Agent': BROWSER_USER_AGENT,
};
const KUGOU_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

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
type ILxMediaSearcher = (
    query: string,
    page: number,
    platform: string,
) => Promise<ILxSearchResult>;
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
            const value = parsed.searchParams.get(name) ?? parsed.hash.match(new RegExp(`[?&]${name}=([^&]+)`))?.[1];
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
    const artwork = item.trans_param?.union_cover
        ? String(item.trans_param.union_cover).replace('{size}', '300')
        : undefined;

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

function mapNeteaseSheetItem(item: any, platform: string): IMusic.IMusicSheetItem {
    const creator = item?.creator ?? item?.user ?? {};
    const trackCount = Number(item?.trackCount ?? item?.trackNumber ?? item?.songCount ?? 0);
    const playCount = Number(item?.playCount ?? item?.subscribedCount ?? 0);

    return {
        id: String(item?.id ?? item?.playlistId),
        platform,
        title: cleanSearchText(item?.name ?? item?.title),
        artwork: item?.coverImgUrl ?? item?.picUrl ?? item?.coverUrl,
        description: cleanSearchText(item?.description ?? item?.copywriter ?? item?.updateFrequency),
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

    const resp = await axios.get('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
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
    });

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
        isEnd: list.length < LX_SEARCH_PAGE_SIZE || page * LX_SEARCH_PAGE_SIZE >= (song.totalnum ?? 0),
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

// lyric 搜索复用 music 搜索器：搜索结果项为 IMusicItem（含 raw 字段），
// 关联歌词时由对应的 LX_LYRIC_GETTERS 取词。
const LX_MEDIA_SEARCHERS: Record<string, Partial<Record<IMedia.SupportMediaType, ILxMediaSearcher>>> = {
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
    wy: getNeteaseTopLists,
};

const LX_TOP_LIST_DETAIL_GETTERS: Record<string, ILxTopListDetailGetter> = {
    wy: getNeteaseTopListDetail,
};

const LX_RECOMMEND_TAG_GETTERS: Record<string, ILxRecommendTagsGetter> = {
    wy: getNeteaseRecommendSheetTags,
};

const LX_RECOMMEND_SHEET_GETTERS: Record<string, ILxRecommendSheetsGetter> = {
    wy: getNeteaseRecommendSheetsByTag,
};

const LX_MUSIC_SHEET_INFO_GETTERS: Record<string, ILxMusicSheetInfoGetter> = {
    wy: getNeteaseMusicSheetInfo,
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
