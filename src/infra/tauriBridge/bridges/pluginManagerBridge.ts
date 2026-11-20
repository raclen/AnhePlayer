/**
 * Tauri 桥接：pluginManager（完整实现）
 *
 * 在渲染进程中提供插件管理器能力：
 * - 插件沙箱：每个插件文件一个 Web Worker（见 worker/lxPluginHost）
 * - 插件存储于 <userData>/anhe-player-plugins/<nanoid>.js
 *   以及 <userData>/.plugin-meta.json、<userData>/.plugin-cache.json
 * - 安装/卸载/更新/批量更新、meta 持久化、默认排序、音源重定向
 * - 内置「本地」插件（bridges/pluginManager/localPlugin.ts）
 * - getMediaSource / getLyric 适配器在渲染进程直连 Worker（无 IPC 开销）
 *
 * 首帧缓存：delegates 同步镜像到 localStorage，供 getCachedPlugins() 同步读取。
 */
import { nanoid } from 'nanoid';
import { compare } from 'compare-versions';
import { LOCAL_PLUGIN_HASH } from '@common/constant';
import {
    CONTEXT_BRIDGE_KEY,
    PLUGIN_DIR_NAME,
    PLUGIN_CACHE_FILE_NAME,
    PLUGIN_META_FILE_NAME,
} from '@infra/pluginManager/common/constant';
import { CONTEXT_BRIDGE_KEY as META_KEY } from '@infra/mediaMeta/common/constant';
import { CONTEXT_BRIDGE_KEY as SHEET_KEY } from '@infra/musicSheet/common/constant';
import { CONTEXT_BRIDGE_KEY as APP_CONFIG_KEY } from '@infra/appConfig/common/constant';
import { methodNormalizers } from '@infra/pluginManager/main/normalizer';
import {
    getMediaSourceAdapter,
    type IGetMediaSourceAdapterParams,
} from '@infra/pluginManager/main/getMediaSourceAdapter';
import { LxPluginHost } from '@infra/pluginManager/worker/lxPluginHost';
import type {
    ICallPluginMethodParams,
    IGetMediaSourceResult,
    IPluginMetaAll,
} from '@appTypes/infra/pluginManager';
import { tauriInvoke } from '../ipc';
import { getLyricAdapterWeb } from './pluginManager/lyricAdapter';
import localPluginDefine from './pluginManager/localPlugin';
import { resolveLxSourceName } from '@infra/pluginManager/common/lxSourceNameResolver';

/** localStorage 首帧缓存键 */
const PLUGIN_CACHE_STORAGE_KEY = 'anhe-player-plugin-cache';

// ─── fs / 哈希工具 ───

function joinPath(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
}

async function fsReadText(path: string): Promise<string | null> {
    try {
        const res = await tauriInvoke<string | number[] | null>('fs_read_file', {
            path,
            encoding: 'utf-8',
        });
        return typeof res === 'string' ? res : null;
    } catch {
        return null;
    }
}

async function fsWriteText(path: string, content: string): Promise<void> {
    await tauriInvoke('fs_write_file', { path, content, isBinary: false });
}

async function fsRemove(path: string): Promise<void> {
    try {
        await tauriInvoke('fs_remove', { path });
    } catch {
        /* 文件不存在时忽略 */
    }
}

async function fsReadDir(path: string): Promise<string[]> {
    try {
        return (await tauriInvoke<string[] | null>('fs_read_dir', { path })) ?? [];
    } catch {
        return [];
    }
}

async function fsMkdir(path: string): Promise<void> {
    try {
        await tauriInvoke('fs_mkdir', { path });
    } catch {
        /* 已存在时忽略 */
    }
}

/** 计算文本的 SHA-256（WebView2 在 tauri.localhost 下为安全上下文，支持 crypto.subtle） */
async function computeHash(text: string): Promise<string> {
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        // 极少数环境无 crypto.subtle 的兜底：FNV-1a 双通道（仅需会话间稳定）
        let h1 = 0x811c9dc5;
        let h2 = 0x811c9dc5 ^ 0x9e3779b9;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
        }
        return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
    }
}

/** 从插件实例提取序列化安全的 delegate（extractPluginDelegate 的同步等价物） */
function buildBuiltinDelegate(
    instance: IPlugin.IPluginInstance,
    hash: string,
): IPlugin.IPluginDelegate {
    const supportedMethod: string[] = [];
    const raw: Record<string, any> = {};
    for (const key of Object.keys(instance)) {
        const value = (instance as any)[key];
        if (typeof value === 'function') {
            supportedMethod.push(key);
        } else {
            raw[key] = value;
        }
    }
    return {
        ...JSON.parse(JSON.stringify(raw)),
        supportedMethod,
        hash,
        path: instance._path,
    };
}

/** 已加载的插件记录 */
interface ILoadedPlugin {
    /** 完整 hash：`${sourceHash}:${platform}`（内建插件即自身 hash） */
    hash: string;
    /** 源文件代码哈希。洛雪插件一个文件可生成多个实例。 */
    sourceHash: string;
    /** 洛雪插件的 Worker 宿主；内建插件为 null */
    host: LxPluginHost | null;
    /** 内建插件实例；洛雪插件为 null */
    instance: IPlugin.IPluginInstance | null;
    /** 可序列化的代理对象 */
    delegate: IPlugin.IPluginDelegate;
    /** 磁盘路径（内建插件为空串） */
    filePath: string;
}

// ─── 服务实现 ───

class TauriPluginManagerService {
    /** hash → ILoadedPlugin */
    private plugins = new Map<string, ILoadedPlugin>();

    /** 内建插件注册表：platform → instance */
    private builtinPlugins = new Map<string, IPlugin.IPluginInstance>();

    /** 插件 meta（排序、用户变量） */
    private pluginMeta: IPluginMetaAll = {};

    /** 插件列表变更监听器 */
    private changeListeners = new Set<(plugins: IPlugin.IPluginDelegate[]) => void>();

    /** 插件目录路径 */
    private pluginBasePath = '';

    /** 缓存文件路径 */
    private cachePath = '';

    /** meta 文件路径 */
    private metaPath = '';

    /** 异步初始化完成的 Promise */
    private pluginsReadyPromise: Promise<void>;

    constructor() {
        this.pluginsReadyPromise = this.initialize().catch((err) => {
            console.error('[PluginManager] Initialization failed:', err);
        });
    }

    // ─── 初始化 ───

    private async initialize(): Promise<void> {
        // 以 Rust 计算的真实路径为准（globalContext 默认值可能尚未被异步刷新）
        let userData = '';
        try {
            const ctx = await tauriInvoke<{ appPath?: { userData?: string } } | null>(
                'global_context_get',
            );
            userData = ctx?.appPath?.userData ?? '';
        } catch {
            /* 回退到 globalContext */
        }
        if (!userData) {
            userData = (globalThis as any).globalContext?.appPath?.userData ?? '';
        }
        if (!userData) {
            console.warn('[PluginManager] Unable to resolve userData path, skip disk loading');
            return;
        }

        this.pluginBasePath = joinPath(userData, PLUGIN_DIR_NAME);
        this.cachePath = joinPath(userData, PLUGIN_CACHE_FILE_NAME);
        this.metaPath = joinPath(userData, PLUGIN_META_FILE_NAME);

        await fsMkdir(this.pluginBasePath);

        await this.loadMeta();

        // 注册内建「本地」插件
        this.registerBuiltinPlugin(localPluginDefine, LOCAL_PLUGIN_HASH);

        // 迁移 1.0.19 旧布局（<userData>/plugins/*.js）到新目录
        await this.migrateLegacyPlugins(userData);

        await this.loadAllPlugins();

        // 为没有 order 的插件分配默认值，避免更新后 hash 变化导致顺序乱掉
        this.assignDefaultOrder();

        try {
            const savedActiveHash = await this.getConfigByKey('plugin.activeSourceHash');
            if (savedActiveHash) {
                (globalThis as any).__anheActiveSourceHash = savedActiveHash;
            }
        } catch {
            // 忽略读取历史激活哈希异常
        }

        this.updateCache();
    }

    /** 从 1.0.19 的 <userData>/plugins 目录迁移插件文件（一次性） */
    private async migrateLegacyPlugins(userData: string): Promise<void> {
        const legacyDir = joinPath(userData, 'plugins');
        const names = await fsReadDir(legacyDir);
        const jsFiles = names.filter((n) => n.toLowerCase().endsWith('.js'));
        if (!jsFiles.length) return;

        for (const name of jsFiles) {
            const legacyPath = joinPath(legacyDir, name);
            const code = await fsReadText(legacyPath);
            if (!code) {
                await fsRemove(legacyPath);
                continue;
            }
            const sourceHash = await computeHash(code);
            if (!sourceHash || this.getPluginsBySourceHash(sourceHash).length > 0) {
                await fsRemove(legacyPath);
                continue;
            }
            const newPath = joinPath(this.pluginBasePath, `${nanoid()}.js`);
            try {
                await fsWriteText(newPath, code);
                await fsRemove(legacyPath);
            } catch (err) {
                console.warn(`[PluginManager] Migrate legacy plugin failed ${name}:`, err);
            }
        }
    }

    // ─── 注册 ───

    /**
     * 注册内建插件。
     * 业务层调用此方法注册本地插件等内建插件。
     * 内建插件不从磁盘加载，hash 和 path 由调用方指定。
     */
    public registerBuiltinPlugin(instance: IPlugin.IPluginInstance, hash: string): void {
        this.builtinPlugins.set(instance.platform, instance);

        const delegate = buildBuiltinDelegate(instance, hash);
        const loaded: ILoadedPlugin = {
            hash,
            sourceHash: hash,
            host: null,
            instance,
            delegate,
            filePath: '',
        };
        this.plugins.set(hash, loaded);

        this.onPluginListChanged();
    }

    // ─── 插件加载 ───

    /** 从磁盘加载全部插件 */
    private async loadAllPlugins(): Promise<void> {
        try {
            const files = (await fsReadDir(this.pluginBasePath)).filter((f) =>
                f.toLowerCase().endsWith('.js'),
            );
            const loadedHashes = new Set<string>(this.plugins.keys()); // 包含已注册的内建插件

            for (const file of files) {
                const filePath = joinPath(this.pluginBasePath, file);

                try {
                    const code = await fsReadText(filePath);
                    if (!code) continue;
                    const sourceHash = await computeHash(code);

                    // 跳过空哈希和重复哈希
                    if (!sourceHash || this.getPluginsBySourceHash(sourceHash).length > 0) {
                        continue;
                    }

                    const loadedPlugins = await this.parsePluginCode(code, sourceHash, filePath);
                    if (!loadedPlugins.length) continue;

                    for (const loaded of loadedPlugins) {
                        if (loadedHashes.has(loaded.hash)) continue;
                        this.plugins.set(loaded.hash, loaded);
                        loadedHashes.add(loaded.hash);
                    }
                } catch (err) {
                    console.error(`[PluginManager] Failed to load plugin file ${file}:`, err);
                }
            }

            console.log(`[PluginManager] Loaded ${this.plugins.size} plugins`);
        } catch (err) {
            console.error('[PluginManager] Failed to load plugins:', err);
        }
    }

    /** 解析洛雪插件代码（每文件一个 Worker 宿主） */
    private async parsePluginCode(
        code: string,
        sourceHash: string,
        filePath: string,
    ): Promise<ILoadedPlugin[]> {
        const host = new LxPluginHost();
        try {
            const rawDelegates = await host.initialize(code);
            if (!rawDelegates.length) {
                host.terminate();
                return [];
            }

            const resolvedSourceName = resolveLxSourceName(code, filePath);

            return rawDelegates.map((raw) => {
                const platform = String(raw.platform ?? '');
                const hash = `${sourceHash}:${platform}`;
                const delegate = {
                    ...(raw as any),
                    hash,
                    path: filePath,
                    sourceHash,
                    sourceName: resolvedSourceName,
                } as IPlugin.IPluginDelegate;
                return {
                    hash,
                    sourceHash,
                    host,
                    instance: null as any,
                    delegate,
                    filePath,
                };
            });
        } catch (err) {
            console.error(`[PluginManager] Failed to execute lx plugin at ${filePath}:`, err);
            host.terminate();
            return [];
        }
    }

    // ─── 插件调用核心 ───

    /**
     * 统一的插件方法调用入口。
     * 1. 通过 hash 或 platform 查找插件实例
     * 2. beforeCall 清洗参数
     * 3. 调用插件方法（内建插件直调；洛雪插件走 Worker）
     * 4. afterCall 标准化返回值
     */
    public async callPluginMethod(params: ICallPluginMethodParams): Promise<any> {
        await this.pluginsReadyPromise;

        const { hash, platform, method, args } = params;

        // 支持通过 hash 或 platform 查找
        let loaded: ILoadedPlugin | undefined;
        if (hash) {
            loaded = this.plugins.get(hash);
        } else if (platform) {
            loaded = this.findPluginByPlatform(platform);
        }

        if (!loaded) {
            throw new Error(`[PluginManager] Plugin not found: ${hash ?? platform}`);
        }

        const pluginPlatform = loaded.delegate.platform;
        const normalizer = methodNormalizers[method];

        // 检查插件是否实现了该方法
        const implemented = loaded.host
            ? loaded.delegate.supportedMethod?.includes(method)
            : typeof (loaded.instance as any)?.[method] === 'function';
        if (!implemented) {
            // 使用默认返回值（如有）
            if (normalizer?.defaultResult) {
                return normalizer.defaultResult(args);
            }
            throw new Error(
                `[PluginManager] Method ${method} not implemented by ${pluginPlatform}`,
            );
        }

        // beforeCall：清洗输入参数
        let processedArgs: any[] = [...args];
        if (normalizer?.beforeCall) {
            processedArgs = normalizer.beforeCall(processedArgs);
        }

        // 调用插件方法
        let result: any;
        if (loaded.host) {
            result = await loaded.host.callMethod(pluginPlatform, method, processedArgs);
        } else {
            result = await (loaded.instance as any)[method].apply(loaded.instance, processedArgs);
        }

        // afterCall：标准化输出
        if (normalizer?.afterCall) {
            result = normalizer.afterCall(result, pluginPlatform, args);
        }

        return result;
    }

    // ─── 安装/卸载/更新 ───

    /** 安装洛雪插件：支持 URL（http/https）或本地 .js 文件 */
    public async installPlugin(urlOrPath: string): Promise<{ success: boolean; message?: string }> {
        await this.pluginsReadyPromise;

        if (!urlOrPath) {
            return { success: false, message: 'Empty plugin path' };
        }

        try {
            let code: string;

            if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
                // 远程下载（添加随机参数防止缓存）
                code = await this.downloadText(this.addRandomHash(urlOrPath));
            } else {
                // 本地文件
                const content = await fsReadText(urlOrPath);
                if (content === null) {
                    return { success: false, message: 'Unable to read plugin file' };
                }
                code = content;
            }

            return await this.installCode(code, urlOrPath);
        } catch (err: any) {
            console.error('[PluginManager] Install failed:', err);
            return { success: false, message: err?.message ?? 'Unknown error' };
        }
    }

    /** 直接以代码内容安装（WebView2 拖拽无真实路径时的入口） */
    public async installPluginFromCode(
        code: string,
    ): Promise<{ success: boolean; message?: string }> {
        await this.pluginsReadyPromise;

        try {
            return await this.installCode(code);
        } catch (err: any) {
            console.error('[PluginManager] Install from code failed:', err);
            return { success: false, message: err?.message ?? 'Unknown error' };
        }
    }

    /** 安装核心：支持多个音源共存、同名音源更新、写盘、解析、注册 */
    private async installCode(
        code: string,
        originalUrlOrPath?: string,
    ): Promise<{ success: boolean; message?: string }> {
        const sourceHash = await computeHash(code);
        if (!sourceHash) {
            return { success: false, message: 'Empty plugin code' };
        }

        // 检查是否已安装相同哈希的插件
        if (this.getPluginsBySourceHash(sourceHash).length > 0) {
            return { success: false, message: 'Plugin already installed' };
        }

        // 写入文件
        const fileName = `${nanoid()}.js`;
        const filePath = joinPath(this.pluginBasePath, fileName);
        await fsWriteText(filePath, code);

        // 在 Worker 中执行（使用真实路径，避免重复执行）
        const loadedPlugins = await this.parsePluginCode(code, sourceHash, filePath);
        if (!loadedPlugins.length) {
            await fsRemove(filePath);
            return { success: false, message: 'Failed to parse plugin' };
        }

        // 尝试通过代码和提示解析音源显示名称
        const resolvedSourceName =
            loadedPlugins[0]?.delegate.sourceName ||
            resolveLxSourceName(code, originalUrlOrPath || '');

        // 检查是否有同名音源（即同一个音源的更新，而非不同音源的互斥）
        const sameNamedEntries = Array.from(this.plugins.values()).filter(
            (p) =>
                !this.isBuiltinPlugin(p) &&
                p.delegate.sourceName &&
                p.delegate.sourceName === resolvedSourceName,
        );

        if (sameNamedEntries.length > 0) {
            // 版本比较：仅在新版本更高时安装（可通过配置跳过）
            const skipVersionCheck =
                (await this.getConfigByKey('plugin.notCheckPluginVersion')) ?? false;
            if (!skipVersionCheck) {
                const existingVersion = sameNamedEntries[0].delegate.version;
                const nextVersion = loadedPlugins[0]?.delegate.version;
                if (existingVersion && nextVersion && compare(existingVersion, nextVersion, '>')) {
                    // 回滚：删除刚写入的文件
                    loadedPlugins[0].host?.terminate();
                    await fsRemove(filePath);
                    return {
                        success: false,
                        message: `Existing version ${existingVersion} >= ${nextVersion}`,
                    };
                }
            }

            // 删除该同名音源的旧文件及实例
            for (const group of this.groupPluginsBySource(sameNamedEntries)) {
                await this.removePluginFile(group[0]);
                for (const loaded of group) {
                    this.plugins.delete(loaded.hash);
                }
            }
        }

        for (const loaded of loadedPlugins) {
            this.plugins.set(loaded.hash, loaded);
        }

        // 新安装的音源默认设为当前激活音源
        (globalThis as any).__anheActiveSourceHash = sourceHash;
        try {
            await this.setConfigByKey('plugin.activeSourceHash', sourceHash);
        } catch {
            /* 忽略配置保存异常 */
        }

        this.onPluginListChanged();
        return { success: true };
    }

    /** 卸载插件 */
    public async uninstallPlugin(hash: string): Promise<{ success: boolean; message?: string }> {
        await this.pluginsReadyPromise;

        const loaded = this.plugins.get(hash);
        if (!loaded) {
            return { success: false, message: 'Plugin not found' };
        }
        const sourceGroup = this.getPluginsBySourceHash(loaded.sourceHash);
        if (sourceGroup.some((item) => this.isBuiltinPlugin(item))) {
            return { success: false, message: 'Cannot uninstall builtin plugin' };
        }

        // 删除文件 + 终止 Worker
        await this.removePluginFile(loaded);

        for (const item of sourceGroup) {
            // 清除 meta
            delete this.pluginMeta[item.hash];

            // 移除记录
            this.plugins.delete(item.hash);
        }
        await this.saveMeta();

        this.onPluginListChanged();
        return { success: true };
    }

    /** 更新单个插件：先下载验证新版本，成功后再替换旧版本 */
    public async updatePlugin(hash: string): Promise<{ success: boolean; message?: string }> {
        await this.pluginsReadyPromise;

        const loaded = this.plugins.get(hash);
        if (!loaded) {
            return { success: false, message: 'Plugin not found' };
        }

        const sourceGroup = this.getPluginsBySourceHash(loaded.sourceHash);
        const srcUrl = sourceGroup.find((it) => it.delegate.srcUrl)?.delegate.srcUrl;
        if (!srcUrl) {
            return { success: false, message: 'Plugin has no srcUrl for update' };
        }

        try {
            // 先下载并验证新版本
            const newCode = await this.downloadText(this.addRandomHash(srcUrl));
            const newSourceHash = await computeHash(newCode);

            if (!newSourceHash || newSourceHash === loaded.sourceHash) {
                return { success: false, message: 'No update available' };
            }

            const fileName = `${nanoid()}.js`;
            const filePath = joinPath(this.pluginBasePath, fileName);
            const testPlugins = await this.parsePluginCode(newCode, newSourceHash, filePath);
            if (!testPlugins.length) {
                return { success: false, message: 'Failed to parse new plugin version' };
            }

            // 版本比较（如有版本号，可通过配置跳过）
            const skipVersionCheck =
                (await this.getConfigByKey('plugin.notCheckPluginVersion')) ?? false;
            if (!skipVersionCheck) {
                for (const current of sourceGroup) {
                    const next = testPlugins.find(
                        (it) => it.delegate.platform === current.delegate.platform,
                    );
                    if (
                        current.delegate.version &&
                        next?.delegate.version &&
                        compare(current.delegate.version, next.delegate.version, '>=')
                    ) {
                        testPlugins[0].host?.terminate();
                        return {
                            success: false,
                            message: `Current ${current.delegate.version} >= new ${next.delegate.version}`,
                        };
                    }
                }
            }

            // 新版本验证通过，写入文件
            await fsWriteText(filePath, newCode);

            // 删除旧插件文件（不清除存储和 meta）
            await this.removePluginFile(sourceGroup[0]);
            for (const current of sourceGroup) {
                this.plugins.delete(current.hash);
            }

            // 迁移 meta 到新 hash，保留排序与用户变量
            for (const next of testPlugins) {
                const previous = sourceGroup.find(
                    (current) => current.delegate.platform === next.delegate.platform,
                );
                if (previous?.hash && this.pluginMeta[previous.hash]) {
                    this.pluginMeta[next.hash] = this.pluginMeta[previous.hash];
                    delete this.pluginMeta[previous.hash];
                }
                this.plugins.set(next.hash, next);
            }
            await this.saveMeta();

            this.onPluginListChanged();
            return { success: true };
        } catch (err: any) {
            console.error('[PluginManager] Update failed:', err);
            return { success: false, message: err?.message ?? 'Unknown error' };
        }
    }

    /** 批量更新全部插件 */
    public async updateAllPlugins(): Promise<{ updated: number; failed: number }> {
        await this.pluginsReadyPromise;

        let updated = 0;
        let failed = 0;

        // 收集需要更新的插件（有 srcUrl 的非内建插件）
        const updatable: ILoadedPlugin[] = [];
        const seenSourceHashes = new Set<string>();
        for (const loaded of this.plugins.values()) {
            if (
                loaded.delegate.srcUrl &&
                !this.isBuiltinPlugin(loaded) &&
                !seenSourceHashes.has(loaded.sourceHash)
            ) {
                updatable.push(loaded);
                seenSourceHashes.add(loaded.sourceHash);
            }
        }

        for (const loaded of updatable) {
            const result = await this.updatePlugin(loaded.hash);
            if (result.success) {
                updated++;
            } else {
                failed++;
            }
        }

        return { updated, failed };
    }

    // ─── 歌词 / 音源适配器 ───

    /** getMediaSource 适配器（含音质回退、重试和音源重定向） */
    public async getMediaSource(
        params: IGetMediaSourceAdapterParams,
    ): Promise<IGetMediaSourceResult | null> {
        await this.pluginsReadyPromise;

        const resolvedHash = this.resolveSourceRedirectHash(params.hash);
        return getMediaSourceAdapter({ ...params, hash: resolvedHash }, (p) =>
            this.callPluginMethod(p),
        );
    }

    /** getLyric 适配器（含本地文件、插件、lrcUrl、自动匹配多步回退） */
    public async getLyric(musicItem: IMusic.IMusicItem): Promise<ILyric.ILyricSource | null> {
        await this.pluginsReadyPromise;

        return getLyricAdapterWeb(
            { musicItem },
            {
                callPluginMethod: (p) => this.callPluginMethod(p as any),
                mediaMeta: {
                    getDownloadData: async (platform, musicId) => {
                        const mod = (window as any)[META_KEY];
                        const meta = await mod?.getMeta?.(platform, musicId);
                        return meta?.downloadData ?? null;
                    },
                    getAssociatedLyric: async (platform, musicId) => {
                        const mod = (window as any)[META_KEY];
                        const meta = await mod?.getMeta?.(platform, musicId);
                        return meta?.associatedLyric ?? null;
                    },
                    setMeta: async (platform, musicId, patch) => {
                        const mod = (window as any)[META_KEY];
                        await mod?.setMeta?.(platform, musicId, patch);
                    },
                },
                musicItemProvider: {
                    getRawMusicItem: async (platform, musicId) => {
                        const mod = (window as any)[SHEET_KEY];
                        return (await mod?.getRawMusicItem?.(platform, musicId)) ?? null;
                    },
                },
                listLyricSearchPlugins: () => this.listLyricSearchPlugins(),
                isAutoMatchEnabled: async () =>
                    (await this.getConfigByKey('lyric.autoMatch')) !== false,
            },
        );
    }

    /**
     * 解析音源重定向：检查源插件是否设置了 sourceRedirectPlatform，
     * 如果目标插件存在且支持 getMediaSource，则返回目标插件的 hash。
     * 只做一层重定向（不递归），避免循环。
     */
    private resolveSourceRedirectHash(hash: string): string {
        const meta = this.pluginMeta[hash];
        const redirectPlatform = meta?.sourceRedirectPlatform;
        if (!redirectPlatform) return hash;

        const target = this.findPluginByPlatform(redirectPlatform);
        if (!target) return hash;

        // 目标插件必须支持 getMediaSource
        const targetSupports = target.host
            ? target.delegate.supportedMethod?.includes('getMediaSource')
            : typeof (target.instance as any)?.getMediaSource === 'function';
        if (!targetSupports) return hash;

        // 避免重定向到自身
        if (target.hash === hash) return hash;

        return target.hash;
    }

    // ─── 查询 ───

    /** 获取所有插件的 delegate 列表 */
    public async getAllPlugins(): Promise<IPlugin.IPluginDelegate[]> {
        await this.pluginsReadyPromise;
        return this.getAllPluginDelegates();
    }

    /** 同步获取首帧缓存（localStorage 镜像），供渲染层 setup 阶段使用 */
    public getCachedPlugins(): IPlugin.IPluginDelegate[] | null {
        try {
            const raw = localStorage.getItem(PLUGIN_CACHE_STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return Array.isArray(data?.plugins) ? data.plugins : null;
        } catch {
            return null;
        }
    }

    /** 插件列表变更监听，返回注销函数 */
    public addChangeListener(cb: (plugins: IPlugin.IPluginDelegate[]) => void): () => void {
        this.changeListeners.add(cb);
        return () => {
            this.changeListeners.delete(cb);
        };
    }

    /** 通过 platform 查找插件，优先当前激活音源 */
    private findPluginByPlatform(platform: string): ILoadedPlugin | undefined {
        const activeSourceHash = (globalThis as any).__anheActiveSourceHash;
        if (activeSourceHash) {
            for (const loaded of this.plugins.values()) {
                if (
                    loaded.sourceHash === activeSourceHash &&
                    loaded.delegate.platform === platform
                ) {
                    return loaded;
                }
            }
        }
        for (const loaded of this.plugins.values()) {
            if (
                loaded.delegate.platform === platform &&
                this.pluginMeta[loaded.hash]?.enabled !== false
            ) {
                return loaded;
            }
        }
        for (const loaded of this.plugins.values()) {
            if (loaded.delegate.platform === platform) {
                return loaded;
            }
        }
        return undefined;
    }

    /**
     * 列出支持 lyric 搜索且已启用的插件平台名。
     * 供 lyricAdapter 的自动匹配（Step 5）枚举候选歌词源。
     */
    private listLyricSearchPlugins(): Array<{ platform: string }> {
        const result: Array<{ platform: string }> = [];
        for (const loaded of this.plugins.values()) {
            const { delegate, hash } = loaded;
            if (
                delegate.supportedMethod?.includes('search') &&
                delegate.supportedSearchType?.includes('lyric' as any) &&
                this.pluginMeta[hash]?.enabled !== false
            ) {
                result.push({ platform: delegate.platform });
            }
        }
        return result;
    }

    /** 通过多个 platform 查找插件，并按源文件去重 */
    private findPluginsByPlatforms(platforms: string[]): ILoadedPlugin[] {
        const result = new Map<string, ILoadedPlugin>();
        for (const platform of platforms) {
            const loaded = this.findPluginByPlatform(platform);
            if (loaded) {
                result.set(loaded.hash, loaded);
            }
        }
        return Array.from(result.values());
    }

    /** 获取同一源文件生成的所有插件实例 */
    private getPluginsBySourceHash(sourceHash: string): ILoadedPlugin[] {
        return Array.from(this.plugins.values()).filter(
            (loaded) => loaded.sourceHash === sourceHash,
        );
    }

    /** 将插件按源文件分组 */
    private groupPluginsBySource(plugins: ILoadedPlugin[]): ILoadedPlugin[][] {
        const groups = new Map<string, ILoadedPlugin[]>();
        for (const plugin of plugins) {
            const group = groups.get(plugin.sourceHash) ?? [];
            group.push(...this.getPluginsBySourceHash(plugin.sourceHash));
            groups.set(plugin.sourceHash, Array.from(new Set(group)));
        }
        return Array.from(groups.values());
    }

    /** 判断是否为内建插件 */
    private isBuiltinPlugin(loaded: ILoadedPlugin): boolean {
        return this.builtinPlugins.has(loaded.delegate.platform);
    }

    // ─── Meta 管理 ───

    /** 获取全部插件 meta */
    public async getAllPluginMeta(): Promise<IPluginMetaAll> {
        await this.pluginsReadyPromise;
        return this.pluginMeta;
    }

    /** 设置插件 meta */
    public async setPluginMeta(hash: string, meta: Partial<IPlugin.IPluginMeta>): Promise<void> {
        await this.pluginsReadyPromise;
        this.pluginMeta[hash] = {
            ...this.pluginMeta[hash],
            ...meta,
        };
        await this.saveMeta();
    }

    /** 批量设置插件 meta（单次落盘） */
    public async batchSetPluginMeta(
        updates: Array<{ hash: string; meta: Partial<IPlugin.IPluginMeta> }>,
    ): Promise<void> {
        await this.pluginsReadyPromise;
        for (const { hash, meta } of updates) {
            this.pluginMeta[hash] = {
                ...this.pluginMeta[hash],
                ...meta,
            };
        }
        await this.saveMeta();
    }

    /** 加载 meta */
    private async loadMeta(): Promise<void> {
        try {
            const raw = await fsReadText(this.metaPath);
            this.pluginMeta = raw ? (JSON.parse(raw) ?? {}) : {};
        } catch (err) {
            console.error('[PluginManager] Failed to load plugin meta:', err);
            this.pluginMeta = {};
        }
    }

    /** 保存 meta */
    private async saveMeta(): Promise<void> {
        try {
            await fsWriteText(this.metaPath, JSON.stringify(this.pluginMeta));
        } catch (err) {
            console.error('[PluginManager] Failed to save plugin meta:', err);
        }
    }

    /** 为没有 order 的插件分配默认值（按加载顺序递增） */
    private assignDefaultOrder(): void {
        let maxOrder = -1;
        for (const meta of Object.values(this.pluginMeta)) {
            if (meta?.order !== undefined && meta.order > maxOrder) {
                maxOrder = meta.order;
            }
        }

        let needSave = false;
        for (const loaded of this.plugins.values()) {
            if (this.pluginMeta[loaded.hash]?.order === undefined) {
                maxOrder++;
                this.pluginMeta[loaded.hash] = {
                    ...this.pluginMeta[loaded.hash],
                    order: maxOrder,
                };
                needSave = true;
            }
        }

        if (needSave) {
            void this.saveMeta();
        }
    }

    // ─── 缓存与通知 ───

    /** 获取全部 delegate（Map 插入顺序） */
    private getAllPluginDelegates(): IPlugin.IPluginDelegate[] {
        return Array.from(this.plugins.values()).map((p) => p.delegate);
    }

    /** 更新插件缓存（localStorage 同步镜像 + 磁盘文件） */
    private updateCache(): void {
        try {
            const cacheData = { plugins: this.getAllPluginDelegates() };
            const json = JSON.stringify(cacheData);

            try {
                localStorage.setItem(PLUGIN_CACHE_STORAGE_KEY, json);
            } catch {
                /* localStorage 不可用时忽略 */
            }

            if (this.cachePath) {
                fsWriteText(this.cachePath, json).catch(() => {});
            }
        } catch (err) {
            console.error('[PluginManager] Failed to update cache:', err);
        }
    }

    /** 插件列表变更时的统一处理 */
    private onPluginListChanged(): void {
        this.updateCache();

        // 通知渲染层监听器
        const delegates = this.getAllPluginDelegates();
        this.changeListeners.forEach((cb) => {
            try {
                cb(delegates);
            } catch (err) {
                console.error('[PluginManager] Listener error:', err);
            }
        });
    }

    // ─── 内部工具 ───

    /** 删除插件文件 + 终止该源文件的 Worker 宿主 */
    private async removePluginFile(loaded: ILoadedPlugin): Promise<void> {
        const hosts = new Set<LxPluginHost>();
        for (const item of this.getPluginsBySourceHash(loaded.sourceHash)) {
            if (item.host) hosts.add(item.host);
        }
        hosts.forEach((host) => host.terminate());

        if (loaded.filePath) {
            try {
                await fsRemove(loaded.filePath);
            } catch (err) {
                console.error(
                    `[PluginManager] Failed to remove plugin file ${loaded.filePath}:`,
                    err,
                );
            }
        }
    }

    /** 下载文本（优先 Tauri http_request，回退原生 fetch） */
    private async downloadText(url: string): Promise<string> {
        try {
            const res = await tauriInvoke<{ statusCode: number; body: string } | null>(
                'http_request',
                { url, options: { method: 'GET' } },
            );
            if (res && typeof res.body === 'string' && res.statusCode < 400) {
                return res.body;
            }
        } catch {
            /* 回退 fetch */
        }

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.text();
    }

    /** 在 URL 后添加随机参数，防止 CDN/浏览器缓存 */
    private addRandomHash(url: string): string {
        try {
            const urlObj = new URL(url);
            urlObj.searchParams.set('_t', Date.now().toString());
            return urlObj.toString();
        } catch {
            // 非法 URL，原样返回
            return url;
        }
    }

    /** 读取应用配置项（如 plugin.notCheckPluginVersion、lyric.autoMatch） */
    private async getConfigByKey(key: string): Promise<any> {
        try {
            const mod = (window as any)[APP_CONFIG_KEY];
            const config = await mod?.syncConfig?.();
            return config?.[key];
        } catch {
            return undefined;
        }
    }

    /** 写入应用配置项 */
    private async setConfigByKey(key: string, value: any): Promise<void> {
        try {
            const mod = (window as any)[APP_CONFIG_KEY];
            await mod?.setConfigByKey?.(key, value);
        } catch {
            /* 忽略写入异常 */
        }
    }

    /** 设置当前激活的音源源文件哈希 */
    public async setActiveSourceHash(sourceHash: string): Promise<void> {
        (globalThis as any).__anheActiveSourceHash = sourceHash;
        await this.setConfigByKey('plugin.activeSourceHash', sourceHash);
        this.onPluginListChanged();
    }

    /** 获取当前激活的音源源文件哈希 */
    public async getActiveSourceHash(): Promise<string> {
        return (
            (globalThis as any).__anheActiveSourceHash ??
            (await this.getConfigByKey('plugin.activeSourceHash')) ??
            ''
        );
    }
}

// ─── 注册 ───

export function registerTauriPluginManagerBridge(): void {
    const service = new TauriPluginManagerService();

    const mod = {
        callPluginMethod: (params: ICallPluginMethodParams) => service.callPluginMethod(params),
        installPlugin: (urlOrPath: string) => service.installPlugin(urlOrPath),
        installPluginFromCode: (code: string) => service.installPluginFromCode(code),
        uninstallPlugin: (hash: string) => service.uninstallPlugin(hash),
        updatePlugin: (hash: string) => service.updatePlugin(hash),
        updateAllPlugins: () => service.updateAllPlugins(),
        getAllPlugins: () => service.getAllPlugins(),
        setActiveSourceHash: (sourceHash: string) => service.setActiveSourceHash(sourceHash),
        getActiveSourceHash: () => service.getActiveSourceHash(),
        setPluginMeta: (hash: string, meta: Partial<IPlugin.IPluginMeta>) =>
            service.setPluginMeta(hash, meta),
        batchSetPluginMeta: (
            updates: Array<{ hash: string; meta: Partial<IPlugin.IPluginMeta> }>,
        ) => service.batchSetPluginMeta(updates),
        getAllPluginMeta: () => service.getAllPluginMeta(),
        getCachedPlugins: () => service.getCachedPlugins(),
        getLyric: (musicItem: IMusic.IMusicItem) => service.getLyric(musicItem),
        getMediaSource: (params: IGetMediaSourceAdapterParams) => service.getMediaSource(params),
        onPluginListChanged: (cb: (plugins: IPlugin.IPluginDelegate[]) => void) =>
            service.addChangeListener(cb),
    };

    (window as any)[CONTEXT_BRIDGE_KEY] = mod;
}
