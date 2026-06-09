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
            'User-Agent': 'Mozilla/5.0',
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
            'User-Agent': 'Mozilla/5.0',
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
                supportedSearchType:
                    sourceKey === 'tx' || sourceKey === 'kg' ? ['music'] : [],
                async getMediaSource(musicItem, quality) {
                    const lxQuality = getLxQuality(sourceKey, quality);
                    const payload = {
                        source: sourceKey,
                        action: 'musicUrl',
                        info: {
                            musicInfo: extractLxMusicInfo(musicItem),
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
            if (sourceKey === 'tx') {
                instance.search = async (query, page, type) => {
                    if (type !== 'music') return { isEnd: true, data: [] } as any;
                    return searchTencentMusic(query, page, platform) as any;
                };
            } else if (sourceKey === 'kg') {
                instance.search = async (query, page, type) => {
                    if (type !== 'music') return { isEnd: true, data: [] } as any;
                    return searchKugouMusic(query, page, platform) as any;
                };
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
