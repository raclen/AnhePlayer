/**
 * 跨窗口应用状态同步与指令派发类型
 */

import type { IMusicItemSlim } from '@appTypes/infra/musicSheet';
import type { PlayerState, RepeatMode } from '@common/constant';
import type { IParsedLrcItem } from '@common/lyricParser';

export type WindowType = 'main' | 'lyric' | 'minimode';

/**
 * 跨窗口同步的应用状态。
 *
 * 所有需要跨窗口同步的状态直接在此接口声明，不使用 declaration merging。
 */
export interface IAppState {
    // ─── TrackPlayer ───
    musicItem: IMusicItemSlim | null;
    playerState: PlayerState;
    repeatMode: RepeatMode;
    currentLrc: IParsedLrcItem | null;
    /** 当前歌曲的全部歌词行（仅在切歌 / 歌词刷新时变化，用于辅助窗口计算行时长） */
    fullLyric: IParsedLrcItem[] | null;
    progress: { currentTime: number; duration: number };
    isFavorite: boolean;
}

export type AppStateType = keyof IAppState;

/**
 * 跨窗口指令定义。
 * Key = 指令名（kebab-case）, Value = 指令参数类型。
 *
 * 通过 declaration merging 扩展此接口来添加指令：
 * @example
 * ```ts
 * declare module "@appTypes/infra/appSync" {
 *     interface ICommand {
 *         'toggle-player-state': void;
 *         'play-music': IMusic.IMusicItem;
 *     }
 * }
 * ```
 */
export interface ICommand {
    // ─── ShortCut Actions ───
    'play/pause': void;
    'skip-previous': void;
    'skip-next': void;
    'toggle-desktop-lyric': void;
    'volume-up': void;
    'volume-down': void;
    'like/dislike': void;
    'toggle-minimode': void;

    // ─── Window and navigation actions ───
    'set-repeat-mode': RepeatMode;
    navigate: string;
    'open-music-detail': void;
}

// ─── MessagePort 内部协议类型 ───

export interface IPortMessageMap {
    /** 连接探测 */
    ping: undefined;
    /** 指令 */
    command: {
        command: string;
        data: unknown;
    };
    /** 辅助窗口订阅状态字段 */
    subscribeAppState: string[];
    /** 主窗口 → 辅助窗口的状态推送 */
    syncAppState: Partial<IAppState>;
}

export type PortMessageType = keyof IPortMessageMap;

// ─── Tauri 跨窗口事件信封 ───
//
// Tauri 的 emit 是全局广播（发送者自己也会收到），且 emit_to 的 label 过滤
// 对 target: Any 的 JS 监听无效，因此窗口间隔离依赖信封里的 from / full。

export interface IAppStateEnvelope {
    v: 1;
    /** 发送方窗口 label */
    from: string;
    /** true = 全量快照（响应订阅请求），false = 增量补丁 */
    full: boolean;
    state: Partial<IAppState>;
}

export interface ICommandEnvelope {
    v: 1;
    /** 发送方窗口 label，用于过滤自己发出的广播 */
    from: string;
    command: string;
    data?: unknown;
}

export interface IPortMessage<T extends PortMessageType = PortMessageType> {
    type: T;
    payload: IPortMessageMap[T];
    timestamp: number;
}

// ─── 共享能力接口 ───

/**
 * 指令发送能力接口。
 *
 * 用于其他 infra 模块通过 setup 注入来发送指令，
 * 而无需直接 import appSync 单例。
 */
export interface ICommandSender {
    sendCommand<K extends keyof ICommand>(command: K, data?: ICommand[K]): void;
}
