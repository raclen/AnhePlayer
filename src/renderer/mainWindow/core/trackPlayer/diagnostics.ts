import logger from '@infra/logger/renderer';
import { LogLevel } from '@common/constant';

export const playbackSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 地址只保留协议和主机；签名参数、路径和 userinfo 均不进入日志。 */
export function summarizeSource(url?: string | null) {
    try {
        const parsed = new URL(url ?? '');
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { protocol: parsed.protocol };
        }
        return { protocol: parsed.protocol, host: parsed.host };
    } catch {
        return { protocol: 'unknown' };
    }
}

export function summarizeMusic(item?: IMedia.IMediaBase | null) {
    if (!item) return null;
    const music = item as IMusic.IMusicItem;
    return {
        platform: item.platform,
        // 本地曲目等可能使用路径或 URL 作为 ID，不保存这些值。
        id: /^[\w-]{1,128}$/.test(String(item.id)) ? String(item.id) : '[redacted]',
        title: music.title,
        artist: music.artist,
    };
}

/** 参考移动端安全错误分类，不保存原始 message、cause、stack 或 HLS 响应正文。 */
export function summarizePlaybackError(error: unknown) {
    const value = error as any;
    const message = String(value?.message ?? error ?? '').toLowerCase();
    const category = /timeout|timed out|超时/.test(message)
        ? 'timeout'
        : /network|fetch|connect|网络|连接/.test(message)
          ? 'network'
          : /no media source|empty|无.*源/.test(message)
            ? 'empty-source'
            : 'unknown';
    const safeLabel = (label: unknown) =>
        typeof label === 'string' && /^[\w-]{1,80}$/.test(label) ? label : undefined;
    return {
        category,
        name: safeLabel(value?.name),
        kind: safeLabel(value?.kind),
        type: safeLabel(value?.type),
        details: safeLabel(value?.details),
        code: typeof value?.code === 'number' ? value.code : undefined,
        status: typeof value?.response?.code === 'number' ? value.response.code : undefined,
        fatal: typeof value?.fatal === 'boolean' ? value.fatal : undefined,
    };
}

export function logPlayback(
    event: string,
    fields: Record<string, unknown> = {},
    level: LogLevel = LogLevel.Info,
): void {
    try {
        logger[level]('[playback]', { sessionId: playbackSessionId, event, ...fields });
    } catch {
        // 诊断不能打断播放或改变错误恢复分支。
    }
}
