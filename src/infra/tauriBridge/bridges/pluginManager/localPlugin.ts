/**
 * Tauri 桥接：pluginManager — 内置「本地」插件（渲染进程版）
 *
 * 由 src/main/core/builtinPlugins/localPlugin.ts 移植：
 * - 扫描入库的元数据由 localMusicStore 负责（标题/歌手/专辑/时长）
 * - 封面与内嵌歌词按需向 Rust 取（local_export_cover / local_read_lyric）：
 *   扫描时逐首解析会让曲库体积与内存暴涨，且当前歌曲对象会写入 localStorage，
 *   内嵌封面最大接近 900KB（base64 后 ×1.33），必须走缓存文件 + asset URL
 * - 播放 URL 使用 Tauri asset 协议（支持大文件流式播放，避免整文件读入内存）
 * - 歌词仅透传 rawLrc，同名 .lrc 文件由 lyricAdapter Step 2 处理（优先于内嵌歌词）
 */
import { LOCAL_PLUGIN_NAME, SUPPORTED_AUDIO_EXTS } from '@common/constant';
import { tauriInvoke } from '../../ipc';

// ─── 工具 ───

/** 尽力读取 i18n（应用启动后模块已加载），失败时返回兜底文案 */
async function t(key: string, fallback: string): Promise<string> {
    try {
        const mod = await import('@infra/i18n/renderer');
        const text = mod.default.t(key);
        return text && text !== key ? text : fallback;
    } catch {
        return fallback;
    }
}

/** 提取扩展名（含点号，小写） */
function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function getBaseName(p: string): string {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i >= 0 ? p.slice(i + 1) : p;
}

function stripExt(name: string): string {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

function joinPath(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
}

/** 将本地路径转为 file:// URL（与上游 localPlugin 的 url 字段保持同构） */
function pathToFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return `file:///${normalized.startsWith('/') ? normalized.slice(1) : normalized}`;
}

function fileUrlToPath(fileUrl: string): string | null {
    if (!fileUrl.startsWith('file:')) return null;
    try {
        const p = decodeURIComponent(fileUrl.replace(/^file:\/\/\/?/, ''));
        return p ? p.replace(/\//g, '\\') : null;
    } catch {
        return null;
    }
}

/** 将本地文件路径转换为 Tauri asset 协议 URL（供 audio 元素直接播放） */
function toAssetUrl(filePath: string): string {
    const internals = (window as any).__TAURI_INTERNALS__;
    if (internals?.convertFileSrc) {
        try {
            return internals.convertFileSrc(filePath, 'asset');
        } catch {
            /* 回退到手工拼接 */
        }
    }
    const encoded = encodeURIComponent(filePath);
    return `http://asset.localhost/${encoded}`;
}

/** 解析 musicItem 的本地路径（localPath 优先，其次 file:/// URL 或裸盘符路径） */
function resolveLocalPath(musicItem: any): string | null {
    if (musicItem?.localPath) return String(musicItem.localPath);
    const u = musicItem?.url;
    if (typeof u === 'string' && u) {
        if (u.startsWith('file:')) return fileUrlToPath(u);
        if (/^[a-zA-Z]:[\\/]/.test(u)) return u;
    }
    return null;
}

/**
 * 稳定的路径哈希（FNV-1a 双通道，16 位十六进制）。
 * 使用稳定的双通道路径哈希标识本地曲目。
 */
function hashPath(p: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5 ^ 0x9e3779b9;
    for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ─── 内嵌封面 / 歌词 ───

/** 封面缓存文件的路径 → asset URL；失败返回 null */
async function readEmbeddedCover(filePath: string): Promise<string | null> {
    try {
        const coverPath = await tauriInvoke<string | null>('local_export_cover', { filePath });
        return coverPath ? toAssetUrl(coverPath) : null;
    } catch {
        return null;
    }
}

/** 读取内嵌歌词文本；任一环节失败返回 null，交给适配器继续下一步 */
async function readEmbeddedLyric(filePath: string): Promise<string | null> {
    try {
        const text = await tauriInvoke<string | null>('local_read_lyric', { filePath });
        return typeof text === 'string' && text.trim() ? text : null;
    } catch {
        return null;
    }
}

// ─── 导入 ───

/** 解析单个本地音乐文件为曲目（标题取文件名，标签解析在扫描入库时完成） */
async function parseLocalMusicItem(filePath: string): Promise<IMusic.IMusicItem> {
    const title = stripExt(getBaseName(filePath)) || filePath;

    return {
        id: hashPath(filePath),
        platform: LOCAL_PLUGIN_NAME,
        title,
        artist: await t('media.unknown_artist', '未知歌手'),
        album: await t('media.unknown_album', '未知专辑'),
        duration: null,
        url: pathToFileUrl(filePath),
        localPath: filePath,
    };
}

/** 解析文件夹中所有支持格式的本地音乐文件 */
async function parseLocalMusicItemFolder(folderPath: string): Promise<IMusic.IMusicItem[]> {
    try {
        const names = await tauriInvoke<string[] | null>('fs_read_dir', { path: folderPath });
        if (!Array.isArray(names)) return [];
        const musicFiles = names.filter((name) => SUPPORTED_AUDIO_EXTS.has(extOf(name)));
        return await Promise.all(
            musicFiles.map((name) => parseLocalMusicItem(joinPath(folderPath, name))),
        );
    } catch {
        return [];
    }
}

// ─── 插件定义 ───

const localPluginDefine: IPlugin.IPluginInstance = {
    platform: LOCAL_PLUGIN_NAME,
    _path: '', // 内建插件不从磁盘加载，无需路径
    async getMediaSource(musicItem) {
        const localPath = resolveLocalPath(musicItem);
        if (!localPath) return null;
        return {
            url: toAssetUrl(localPath),
        };
    },
    async getLyric(musicItem) {
        // 同名 .lrc 文件由 lyricAdapter 的 Step 2 统一处理（优先于内嵌歌词）
        if ((musicItem as any)?.rawLrc) {
            return {
                rawLrc: (musicItem as any).rawLrc,
            };
        }
        // 回退到内嵌歌词（ID3v2 USLT / MP4 ©lyr / Vorbis UNSYNCEDLYRICS）
        const localPath = resolveLocalPath(musicItem);
        if (!localPath) return null;
        const rawLrc = await readEmbeddedLyric(localPath);
        return rawLrc ? { rawLrc } : null;
    },
    async importMusicItem(filePath) {
        return parseLocalMusicItem(filePath);
    },
    async importMusicSheet(folderPath) {
        return parseLocalMusicItemFolder(folderPath);
    },
    async getMusicInfo(musicItem) {
        // 播放时异步补封面（trackPlayer 在 setCurrentMusic 后调用）。
        // 已有 artwork 时直接返回，避免重复导出缓存文件。
        if ((musicItem as any)?.artwork) return null;
        const localPath = resolveLocalPath(musicItem);
        if (!localPath) return null;
        const artwork = await readEmbeddedCover(localPath);
        return artwork ? { artwork } : null;
    },
};

export default localPluginDefine;
