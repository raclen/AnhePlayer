/**
 * pluginManager — Renderer 层
 *
 * 提供插件管理的渲染进程 API：
 * - 双阶段初始化：先用本地缓存显示首帧，再异步加载最新数据
 * - jotai 状态管理：见 store.ts（pluginsAtom、pluginMetaAtom）
 * - callPluginMethod：统一方法调用
 * - adapters.getMediaSource：带音质回退的获取音源
 * - React Hooks：见 hooks.ts（usePlugins、usePluginMeta 等）
 */

import type {
    ICallPluginMethodParams,
    IGetMediaSourceParams,
    IGetMediaSourceResult,
    IPluginMetaAll,
} from '@appTypes/infra/pluginManager';
import { QUALITY_KEYS, LOCAL_PLUGIN_HASH } from '@common/constant';
import { tauriInvoke } from '@infra/tauriBridge/ipc';
import { CONTEXT_BRIDGE_KEY } from '../common/constant';
import { sortByPluginOrder } from '../common/sortByOrder';
import {
    store,
    pluginsAtom,
    pluginMetaAtom,
    pluginAvailabilityAtom,
    activeSourceHashAtom,
} from './store';
import type { IPluginAvailabilityResult } from './store';

// ─── Tauri Bridge 接口类型 ───

interface IMod {
    callPluginMethod(params: ICallPluginMethodParams): Promise<any>;
    installPlugin(urlOrPath: string): Promise<{ success: boolean; message?: string }>;
    installPluginFromCode?(code: string): Promise<{ success: boolean; message?: string }>;
    uninstallPlugin(hash: string): Promise<{ success: boolean; message?: string }>;
    updatePlugin(hash: string): Promise<{ success: boolean; message?: string }>;
    updateAllPlugins(): Promise<{ updated: number; failed: number }>;
    getAllPlugins(): Promise<IPlugin.IPluginDelegate[]>;
    setActiveSourceHash?(sourceHash: string): Promise<void>;
    getActiveSourceHash?(): Promise<string>;
    setPluginMeta(hash: string, meta: Partial<IPlugin.IPluginMeta>): Promise<void>;
    batchSetPluginMeta(
        updates: Array<{ hash: string; meta: Partial<IPlugin.IPluginMeta> }>,
    ): Promise<void>;
    getAllPluginMeta(): Promise<IPluginMetaAll>;
    getCachedPlugins(): IPlugin.IPluginDelegate[] | null;
    getLyric(musicItem: IMusic.IMusicItem): Promise<ILyric.ILyricSource | null>;
    getMediaSource(
        params: IGetMediaSourceParams & { hash: string },
    ): Promise<IGetMediaSourceResult | null>;
    onPluginListChanged(callback: (plugins: IPlugin.IPluginDelegate[]) => void): () => void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

// ─── 内部状态 ───

/** 初始化完成标志 */
let isInitialized = false;

/** 插件就绪 Promise（异步数据加载完成后 resolve） */
let readyResolve: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
});

// ─── 初始化 ───

/**
 * 双阶段初始化。
 * Phase 1: 从本地缓存同步加载首帧数据。
 * Phase 2: 异步获取最新数据并更新状态。
 */
async function setup(): Promise<void> {
    if (isInitialized) return;
    isInitialized = true;

    // Phase 1: 缓存首帧
    const cached = mod.getCachedPlugins();
    if (cached) {
        store.set(pluginsAtom, cached);
    }

    // 注册监听
    mod.onPluginListChanged((plugins) => {
        store.set(pluginsAtom, plugins);
    });

    // Phase 2: 异步获取最新数据
    try {
        const [plugins, meta, activeHash] = await Promise.all([
            mod.getAllPlugins(),
            mod.getAllPluginMeta(),
            mod.getActiveSourceHash ? mod.getActiveSourceHash() : Promise.resolve(''),
        ]);

        store.set(pluginsAtom, plugins);
        store.set(pluginMetaAtom, meta);
        if (activeHash) {
            store.set(activeSourceHashAtom, activeHash);
        } else if (plugins.length > 0) {
            const firstLx = plugins.find((p) => p.hash !== LOCAL_PLUGIN_HASH);
            if (firstLx?.sourceHash) {
                store.set(activeSourceHashAtom, firstLx.sourceHash);
            }
        }
    } catch (err) {
        console.error('[PluginManager Renderer] Failed to load initial data:', err);
    }

    readyResolve?.();
}

// ─── 核心 API ───

/** 等待插件数据就绪 */
function whenReady(): Promise<void> {
    return readyPromise;
}

/** 调用插件方法 */
async function callPluginMethod<
    T extends keyof IPlugin.IPluginInstanceMethods = keyof IPlugin.IPluginInstanceMethods,
>(
    params: ICallPluginMethodParams<T>,
): Promise<Awaited<ReturnType<IPlugin.IPluginInstanceMethods[T]>>> {
    return mod.callPluginMethod(params);
}

/** 安装插件 */
async function installPlugin(urlOrPath: string): Promise<{ success: boolean; message?: string }> {
    return mod.installPlugin(urlOrPath);
}

/** 以代码内容安装插件（WebView2 拖拽无真实路径时的通道；非 Tauri 环境返回失败） */
async function installPluginFromCode(
    code: string,
): Promise<{ success: boolean; message?: string }> {
    if (typeof mod.installPluginFromCode !== 'function') {
        return { success: false, message: 'Not supported in current environment' };
    }
    return mod.installPluginFromCode(code);
}

/** 卸载插件 */
async function uninstallPlugin(hash: string): Promise<{ success: boolean; message?: string }> {
    return mod.uninstallPlugin(hash);
}

/** 更新插件 */
async function updatePlugin(hash: string): Promise<{ success: boolean; message?: string }> {
    return mod.updatePlugin(hash);
}

/** 批量更新全部插件 */
async function updateAllPlugins(): Promise<{ updated: number; failed: number }> {
    return mod.updateAllPlugins();
}

/** 设置插件 meta（排序、用户变量等） */
async function setPluginMeta(hash: string, meta: Partial<IPlugin.IPluginMeta>): Promise<void> {
    await mod.setPluginMeta(hash, meta);

    // 本地更新 meta atom
    const currentMeta = store.get(pluginMetaAtom);
    store.set(pluginMetaAtom, {
        ...currentMeta,
        [hash]: { ...currentMeta[hash], ...meta },
    });
}

/**
 * 批量设置插件 meta（单次 IPC + 单次落盘）。
 * 先同步更新本地 atom（确保 UI 即时响应），再异步持久化到磁盘。
 * 如果 IPC 失败则回滚 atom 到之前的状态。
 */
async function batchSetPluginMeta(
    updates: Array<{ hash: string; meta: Partial<IPlugin.IPluginMeta> }>,
): Promise<void> {
    // 保存旧值以备回滚
    const previousMeta = store.get(pluginMetaAtom);

    // 先同步更新本地 atom
    const newMeta = { ...previousMeta };
    for (const { hash, meta } of updates) {
        newMeta[hash] = { ...newMeta[hash], ...meta };
    }
    store.set(pluginMetaAtom, newMeta);

    // 再异步持久化
    try {
        await mod.batchSetPluginMeta(updates);
    } catch (err) {
        // IPC 失败则回滚
        console.error('[PluginManager Renderer] batchSetPluginMeta failed, rolling back:', err);
        store.set(pluginMetaAtom, previousMeta);
    }
}

/** 获取当前插件列表（快照） */
function getPlugins(): IPlugin.IPluginDelegate[] {
    return store.get(pluginsAtom);
}

/** 获取当前插件 meta（快照） */
function getPluginMeta(): IPluginMetaAll {
    return store.get(pluginMetaAtom);
}

/** 通过 hash 获取单个插件 */
function getPluginByHash(hash: string): IPlugin.IPluginDelegate | undefined {
    return store.get(pluginsAtom).find((p) => p.hash === hash);
}

/** 通过 platform 获取单个插件（优先当前激活音源） */
function getPluginByPlatform(platform: string): IPlugin.IPluginDelegate | undefined {
    const activeHash = store.get(activeSourceHashAtom);
    const plugins = store.get(pluginsAtom);
    if (activeHash) {
        const match = plugins.find((p) => p.sourceHash === activeHash && p.platform === platform);
        if (match) return match;
    }
    const meta = store.get(pluginMetaAtom);
    const enabled = plugins.find((p) => p.platform === platform && meta[p.hash]?.enabled !== false);
    if (enabled) return enabled;
    return plugins.find((p) => p.platform === platform);
}

/** 设置当前激活的音源源文件哈希 */
async function setActiveSourceHash(sourceHash: string): Promise<void> {
    store.set(activeSourceHashAtom, sourceHash);
    if (mod.setActiveSourceHash) {
        await mod.setActiveSourceHash(sourceHash);
    }
}

/** 获取当前激活的音源源文件哈希 */
function getActiveSourceHash(): string {
    return store.get(activeSourceHashAtom);
}

/**
 * 获取支持指定方法的插件列表。
 * @param enabledOnly 仅返回已启用的插件（默认 true）
 */
function getSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    const meta = enabledOnly ? store.get(pluginMetaAtom) : null;
    return store
        .get(pluginsAtom)
        .filter(
            (p) =>
                p.supportedMethod.includes(featureMethod) &&
                (!meta || meta[p.hash]?.enabled !== false),
        );
}

/**
 * 获取支持指定方法的插件列表（按 meta.order 排序）。
 * @param enabledOnly 仅返回已启用的插件（默认 true）
 */
function getSortedSupportedPlugin(
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    const meta = store.get(pluginMetaAtom);
    return sortByPluginOrder(
        store
            .get(pluginsAtom)
            .filter(
                (p) =>
                    p.supportedMethod.includes(featureMethod) &&
                    (!enabledOnly || meta[p.hash]?.enabled !== false),
            ),
        meta,
    );
}

/**
 * 获取支持搜索功能的插件列表（可选按搜索类型过滤）。
 * @param enabledOnly 仅返回已启用的插件（默认 true）
 */
function getSearchablePlugins(
    supportedSearchType?: IMedia.SupportMediaType,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    return getSupportedPlugin('search', enabledOnly).filter((p) =>
        supportedSearchType && p.supportedSearchType
            ? p.supportedSearchType.includes(supportedSearchType)
            : true,
    );
}

/**
 * 获取支持搜索功能的已排序插件列表。
 * @param enabledOnly 仅返回已启用的插件（默认 true）
 */
function getSortedSearchablePlugins(
    supportedSearchType?: IMedia.SupportMediaType,
    enabledOnly = true,
): IPlugin.IPluginDelegate[] {
    return getSortedSupportedPlugin('search', enabledOnly).filter((p) =>
        supportedSearchType && p.supportedSearchType
            ? p.supportedSearchType.includes(supportedSearchType)
            : true,
    );
}

/** 判断指定 platform 的插件是否支持某个方法 */
function isSupportFeatureMethod(
    platform: string,
    featureMethod: keyof IPlugin.IPluginInstanceMethods,
): boolean {
    if (!platform) return false;
    return (
        store
            .get(pluginsAtom)
            .find((p) => p.platform === platform)
            ?.supportedMethod?.includes(featureMethod) ?? false
    );
}

/** 获取插件的 primaryKey 定义 */
function getPluginPrimaryKey(pluginItem: { platform?: string }): string[] {
    return store.get(pluginsAtom).find((p) => p.platform === pluginItem.platform)?.primaryKey ?? [];
}

// ─── Adapters ───

/** 适配器命名空间，封装需要额外业务逻辑的方法 */
const adapters = {
    /**
     * 获取音源（带音质回退和重试）。
     * 实际处理在 bridge runtime（直接调用插件，无多次 bridge 开销）。
     *
     * @example
     * ```ts
     * const result = await pluginManager.adapters.getMediaSource({
     *     hash,
     *     musicItem,
     *     quality: 'high',
     *     qualityOrder: ['high', 'standard', 'low'],
     *     qualityFallbackOrder: 'lower',
     * });
     * ```
     */
    async getMediaSource(
        params: IGetMediaSourceParams & { hash: string },
    ): Promise<IGetMediaSourceResult | null> {
        return mod.getMediaSource(params);
    },

    /**
     * 获取歌词（含多步回退：本地文件 → 插件 → lrcUrl）。
     * 实际处理在 bridge runtime（需要文件访问），通过 bridge 调用。
     *
     * @example
     * ```ts
     * const lyric = await pluginManager.adapters.getLyric(musicItem);
     * ```
     */
    async getLyric(musicItem: IMusic.IMusicItem): Promise<ILyric.ILyricSource | null> {
        return mod.getLyric(musicItem);
    },
};

// ─── 音源可用性检测 ───

/** 单次探测超时（毫秒）：搜索 + 取播放地址 + 拉流校验 */
const CHECK_TIMEOUT = 30_000;
/** 并发探测数，避免同时打满多个音源接口 */
const CHECK_CONCURRENCY = 2;
/** 搜索探测关键词：热门歌手，正常音源必有结果 */
const CHECK_SEARCH_QUERY = '周杰伦';

export interface IPluginCheckSummary {
    available: number;
    unavailable: number;
    unsupported: number;
}

/** 给 Promise 加超时，避免远端接口挂起导致检测一直转圈 */
function withTimeout<T>(promise: Promise<T>, timeout = CHECK_TIMEOUT): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('检测超时')), timeout);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * 无搜索能力的插件使用的固定测试歌曲。
 * 字段与洛雪 musicInfo 对齐，插件按 hash/songmid/contentId 等取源。
 */
const TEST_MUSIC: Record<string, IMusic.IMusicItem> = {
    wy: {
        platform: 'wy',
        id: '1357375695',
        songmid: 1357375695,
        title: '海阔天空',
        artist: 'Beyond',
        album: '乐与怒',
    },
    tx: {
        platform: 'tx',
        id: '001yS0N33yPm1B',
        songmid: '001yS0N33yPm1B',
        strMediaMid: '002MX8Ea4e5RDS',
        title: '海阔天空',
        artist: 'BEYOND',
    },
    kw: {
        platform: 'kw',
        id: '321946135',
        songmid: 321946135,
        hash: 'MUSIC_321946135',
        title: '海阔天空',
        artist: 'G.E.M.邓紫棋',
    },
    kg: {
        platform: 'kg',
        id: 'C41E80A18D1448FA47086372999C7F43',
        hash: 'C41E80A18D1448FA47086372999C7F43',
        songmid: 3261014,
        title: '海阔天空',
        artist: 'BEYOND',
    },
    mg: {
        platform: 'mg',
        id: '6005752DXKE',
        songmid: '6005752DXKE',
        copyrightId: '6005752DXKE',
        contentId: '600913000009337537',
        albumId: '1133556323',
        title: '海阔天空',
        artist: 'Beyond',
    },
} as unknown as Record<string, IMusic.IMusicItem>;

/** 判断响应类型是否明显不是音频（错误页、JSON 报错体等） */
function isNonAudioContentType(contentType: string): boolean {
    const type = (contentType || '').toLowerCase();
    if (!type) return false;
    return (
        type.startsWith('text/') ||
        type.startsWith('image/') ||
        type.includes('json') ||
        type.includes('xml') ||
        type.includes('html')
    );
}

/**
 * 拉流探活：只读取响应头和前 2KB，不下载完整音频。
 * @returns 失败原因；可播放时返回 null
 */
async function probeMediaSource(media: IPlugin.IMediaSourceResult): Promise<string | null> {
    const headers: Record<string, string> = { ...(media.headers || {}) };
    if (media.userAgent) headers['user-agent'] = media.userAgent;

    try {
        const result = await tauriInvoke<{
            statusCode: number;
            contentType: string;
            finalUrl: string;
        }>('probe_media_url', { url: media.url, headers });

        if (!result) return '播放地址探测未返回结果';

        if (result.statusCode !== 200 && result.statusCode !== 206) {
            return `播放地址返回 HTTP ${result.statusCode}`;
        }
        if (isNonAudioContentType(result.contentType)) {
            return `播放地址返回的不是音频（${result.contentType.split(';')[0]}）`;
        }
        return null;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `播放地址无法访问：${message}`;
    }
}

/**
 * 检测单个平台音源是否真的能播放。
 * 流程：搜索（或固定测试歌曲）→ 完整取源 → 拉流探活。
 */
async function checkSinglePlugin(hash: string): Promise<IPluginAvailabilityResult> {
    const plugin = getPluginByHash(hash);
    if (!plugin) {
        return { state: 'unavailable', message: '插件未加载', checkedAt: Date.now() };
    }

    // 没有取源能力（如纯搜索插件）无法判断播放能力
    if (!plugin.supportedMethod.includes('getMediaSource')) {
        return { state: 'unsupported', checkedAt: Date.now() };
    }

    try {
        // 1. 优先用插件自己的搜索结果，得到字段完整的音乐项
        let musicItem: IMusic.IMusicItem | null = null;
        if (plugin.supportedMethod.includes('search')) {
            try {
                const searched = await withTimeout(
                    callPluginMethod({
                        hash,
                        method: 'search',
                        args: [CHECK_SEARCH_QUERY, 1, 'music'],
                    } as ICallPluginMethodParams),
                );
                const list = Array.isArray(searched?.data)
                    ? searched.data
                    : Array.isArray(searched)
                      ? searched
                      : [];
                musicItem = list.find((item: any) => item?.id) ?? null;
            } catch {
                // 搜索失败时回退固定测试歌曲
            }
        }
        musicItem = musicItem ?? TEST_MUSIC[plugin.platform] ?? null;
        if (!musicItem) {
            return { state: 'unsupported', checkedAt: Date.now() };
        }

        // 2. 走与播放一致的取源链路（含官方源兜底），拿到真实播放地址
        const media = await withTimeout(
            adapters.getMediaSource({
                hash,
                musicItem,
                quality: 'standard',
                qualityOrder: QUALITY_KEYS,
                qualityFallbackOrder: 'lower',
            }),
        );
        if (!media?.url) {
            return { state: 'unavailable', message: '未返回播放地址', checkedAt: Date.now() };
        }

        // 3. 拉流探活：HTTP 可访问且不是错误页 / JSON 才算可用
        const failReason = await probeMediaSource(media);
        if (failReason) {
            return { state: 'unavailable', message: failReason, checkedAt: Date.now() };
        }
        return { state: 'available', checkedAt: Date.now() };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: 'unavailable', message, checkedAt: Date.now() };
    }
}

/**
 * 批量检测音源可用性。
 * 检测过程中实时写入 pluginAvailabilityAtom，UI 可展示「检测中」。
 */
async function checkPluginsAvailability(hashes: string[]): Promise<IPluginCheckSummary> {
    const summary: IPluginCheckSummary = { available: 0, unavailable: 0, unsupported: 0 };

    // 先整体置为检测中
    const initial = { ...store.get(pluginAvailabilityAtom) };
    for (const hash of hashes) {
        initial[hash] = { state: 'checking' };
    }
    store.set(pluginAvailabilityAtom, initial);

    // 简单的并发池，避免一次性发起过多网络请求
    const queue = [...hashes];
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
            const hash = queue.shift()!;
            const result = await checkSinglePlugin(hash);
            store.set(pluginAvailabilityAtom, {
                ...store.get(pluginAvailabilityAtom),
                [hash]: result,
            });

            if (result.state === 'available') summary.available++;
            else if (result.state === 'unsupported') summary.unsupported++;
            else summary.unavailable++;
        }
    });
    await Promise.all(workers);

    return summary;
}

// ─── 导出 ───

export type { IPluginAvailabilityResult, PluginAvailabilityState } from './store';

const pluginManager = {
    setup,
    whenReady,
    callPluginMethod,
    checkPluginsAvailability,
    installPlugin,
    installPluginFromCode,
    uninstallPlugin,
    updatePlugin,
    updateAllPlugins,
    setActiveSourceHash,
    getActiveSourceHash,
    setPluginMeta,
    batchSetPluginMeta,
    getPlugins,
    getPluginMeta,
    getPluginByHash,
    getPluginByPlatform,
    getSupportedPlugin,
    getSortedSupportedPlugin,
    getSearchablePlugins,
    getSortedSearchablePlugins,
    isSupportFeatureMethod,
    getPluginPrimaryKey,
    adapters,
};

export default pluginManager;
