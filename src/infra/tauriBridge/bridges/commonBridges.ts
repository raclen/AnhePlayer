/**
 * Tauri 桥接：基础通用模块
 * （logger / i18n / requestForwarder / appSync）
 *
 * 注：themepack 已拆分至独立模块 themepackBridge.ts
 */
import { CONTEXT_BRIDGE_KEY as LOGGER_KEY } from '@infra/logger/common/constant';
import { CONTEXT_BRIDGE_KEY as I18N_KEY } from '@infra/i18n/common/constant';
import { CONTEXT_BRIDGE_KEY as FORWARDER_KEY } from '@infra/requestForwarder/common/constant';
import {
    CONTEXT_BRIDGE_KEY as APP_SYNC_KEY,
    CONTEXT_BRIDGE_KEY_AUXILIARY,
} from '@infra/appSync/common/constant';
import type { IAppState, IAppStateEnvelope, ICommandEnvelope } from '@appTypes/infra/appSync';
import zhCN from '../../../../res/lang/zh-CN.json';
import { tauriInvoke, tauriListen, tauriEmit, getCurrentWindowLabel } from '../ipc';

/** 主窗口 → 所有窗口：状态补丁或全量快照 */
const EVENT_APP_STATE_SYNC = 'tauri-app-state-sync';
/** 辅助窗口 → 主窗口：请求全量快照 */
const EVENT_APP_STATE_REQUEST = 'tauri-app-state-request';
/** 任意窗口 → 所有窗口：播放/窗口指令 */
const EVENT_COMMAND = 'tauri-command';

const SELF_LABEL = getCurrentWindowLabel();

/** 浅字段比较：辅助窗口只需要知道「哪个字段真的变了」 */
function isSameShallow(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.is(objA[key], objB[key]));
}

/**
 * 主窗口侧：维护「最新状态快照提供者」，响应辅助窗口的订阅请求。
 *
 * Tauri 的 emit 是全局广播，且 emit_to 的 label 过滤对 target: Any 的 JS 监听无效，
 * 因此窗口间隔离靠信封里的 from / full 字段，而不是发送目标。
 */
function registerAppSyncMainBridge(): void {
    let snapshotProvider: (() => Partial<IAppState>) | null = null;
    let hasPendingRequest = false;

    const emitFullSnapshot = () => {
        if (!snapshotProvider) {
            // provider 尚未注册（trackPlayer 还没 setup），等注册后补发
            hasPendingRequest = true;
            return;
        }
        hasPendingRequest = false;
        tauriEmit(EVENT_APP_STATE_SYNC, {
            v: 1,
            from: SELF_LABEL,
            full: true,
            state: snapshotProvider(),
        } satisfies IAppStateEnvelope).catch(() => {});
    };

    // 辅助窗口启动时请求一次全量快照，避免错过主窗口的早期推送
    tauriListen(EVENT_APP_STATE_REQUEST, emitFullSnapshot).catch(console.error);

    (window as any)[APP_SYNC_KEY] = {
        syncAppState: (state: Partial<IAppState>) => {
            tauriEmit(EVENT_APP_STATE_SYNC, {
                v: 1,
                from: SELF_LABEL,
                full: false,
                state,
            } satisfies IAppStateEnvelope).catch(() => {});
        },
        syncAppStateTo: (_windowType: string, state: Partial<IAppState>) => {
            tauriEmit(EVENT_APP_STATE_SYNC, {
                v: 1,
                from: SELF_LABEL,
                full: false,
                state,
            } satisfies IAppStateEnvelope).catch(() => {});
        },
        /** 注册状态快照提供者；若有挂起的订阅请求则立即补发 */
        setSnapshotProvider: (getter: () => Partial<IAppState>) => {
            snapshotProvider = getter;
            if (hasPendingRequest) emitFullSnapshot();
        },
        onCommand: (command: string, cb: (data: unknown, from: string) => void) => {
            let unlistenFn: (() => void) | null = null;
            tauriListen<ICommandEnvelope>(EVENT_COMMAND, (payload) => {
                if (!payload || payload.command !== command) return;
                cb(payload.data, payload.from);
            }).then((u) => {
                unlistenFn = u;
            });
            return () => {
                if (unlistenFn) unlistenFn();
            };
        },
        sendCommand: (command: string, data?: unknown) => {
            // 只发一次全局广播：主窗口自己也会收到（快捷键依赖此行为），
            // 若再本地派发一次会导致指令执行两次。
            tauriEmit(EVENT_COMMAND, {
                v: 1,
                from: SELF_LABEL,
                command,
                data,
            } satisfies ICommandEnvelope).catch(() => {});
        },
        onSubscribe: (_cb: (windowType: string) => void) => {
            return () => {};
        },
    };
}

/**
 * 辅助窗口侧（歌词 / 迷你模式）：缓存主窗口推送的状态并提供订阅 API。
 *
 * 监听在模块求值时就注册，早于 React 挂载，避免错过主窗口的早期推送。
 */
function registerAppSyncAuxBridge(): void {
    const cache: Partial<IAppState> = {};
    const listeners = new Set<(state: Partial<IAppState>, changed: Partial<IAppState>) => void>();
    const requestedKeys = new Set<keyof IAppState>();
    let listenReady = false;
    let needSnapshot = false;

    const requestSnapshot = () => {
        if (!listenReady) {
            needSnapshot = true;
            return;
        }
        needSnapshot = false;
        tauriEmit(EVENT_APP_STATE_REQUEST, { v: 1, from: SELF_LABEL }).catch(() => {});
    };

    tauriListen<IAppStateEnvelope>(EVENT_APP_STATE_SYNC, (envelope) => {
        if (!envelope?.state || envelope.from === SELF_LABEL) return;

        const changed: Partial<IAppState> = {};
        let hasChange = false;

        for (const [key, value] of Object.entries(envelope.state)) {
            const typedKey = key as keyof IAppState;
            if (isSameShallow(cache[typedKey], value)) continue;
            (cache as Record<string, unknown>)[typedKey] = value;
            (changed as Record<string, unknown>)[typedKey] = value;
            hasChange = true;
        }
        if (!hasChange) return;

        listeners.forEach((cb) => {
            try {
                cb(cache, changed);
            } catch (err) {
                console.error('[appSync] state listener error:', err);
            }
        });
    })
        .then((u) => {
            listenReady = true;
            if (needSnapshot || requestedKeys.size > 0) requestSnapshot();
            void u;
        })
        .catch(console.error);

    (window as any)[CONTEXT_BRIDGE_KEY_AUXILIARY] = {
        subscribeAppState: (keys: string[]) => {
            let missing = false;
            for (const key of keys) {
                const typedKey = key as keyof IAppState;
                requestedKeys.add(typedKey);
                if (!(typedKey in cache)) missing = true;
            }
            // 本地缓存缺字段：主窗口可能早于本窗口推送过，主动拉一次全量快照
            if (missing) requestSnapshot();
        },
        getAppState: () => cache,
        onStateChange: (cb: (state: Partial<IAppState>, changed: Partial<IAppState>) => void) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        sendCommand: (command: string, data?: unknown) => {
            tauriEmit(EVENT_COMMAND, {
                v: 1,
                from: SELF_LABEL,
                command,
                data,
            } satisfies ICommandEnvelope).catch(() => {});
        },
        onCommand: (command: string, cb: (data: unknown, from: string) => void) => {
            let unlistenFn: (() => void) | null = null;
            tauriListen<ICommandEnvelope>(EVENT_COMMAND, (payload) => {
                if (!payload || payload.command !== command) return;
                // 事件是全局广播，过滤掉自己发出的那条
                if (payload.from === SELF_LABEL) return;
                cb(payload.data, payload.from);
            }).then((u) => {
                unlistenFn = u;
            });
            return () => {
                if (unlistenFn) unlistenFn();
            };
        },
    };
}

export function registerCommonBridges(): void {
    // 1. Logger
    (window as any)[LOGGER_KEY] = {
        log: (entry: any) => {
            console.log(`[TauriLog] [${entry?.level || 'info'}]`, entry);
            tauriInvoke('log_entry', { entry }).catch(() => {});
        },
    };

    // 2. i18n（使用打包内置 zh-CN，秒级返回，确保 i18nInstance 正常启动）
    (window as any)[I18N_KEY] = {
        setupLanguage: async () => {
            return {
                lang: 'zh-CN',
                content: zhCN,
                allLangs: ['zh-CN'],
            };
        },
        changeLanguage: async (lang: string) => {
            return {
                lang,
                content: zhCN,
            };
        },
    };

    // 3. Request Forwarder (Tauri 架构下请求直接走 Tauri HTTP 或直接网络请求)
    (window as any)[FORWARDER_KEY] = {
        getPort: async () => {
            try {
                return await tauriInvoke<number | null>('forwarder_get_port');
            } catch {
                return null;
            }
        },
        onPortChanged: (callback: (port: number | null) => void) => {
            let unlistenFn: (() => void) | null = null;
            tauriListen<number | null>('forwarder-port-changed', (p) => {
                callback(p);
            }).then((u) => {
                unlistenFn = u;
            });
            return () => {
                if (unlistenFn) unlistenFn();
            };
        },
    };

    // 4. AppSync（主窗口推送状态 / 辅助窗口接收状态）
    if (SELF_LABEL === 'main') {
        registerAppSyncMainBridge();
    } else {
        registerAppSyncAuxBridge();
    }
}
