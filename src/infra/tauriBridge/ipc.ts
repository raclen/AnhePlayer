/**
 * Tauri IPC 底层桥接工具
 *
 * 直接基于 window.__TAURI_INTERNALS__ 实现，无需强绑打包版本 npm 依赖，
 * 保证在编译期与运行时皆轻量且安全。
 */

interface TauriInternals {
    invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    transformCallback(callback: (...args: any[]) => void, once?: boolean): number;
    metadata?: {
        currentWindow?: { label?: string };
        currentWebview?: { label?: string };
    };
}

function getTauriInternals(): TauriInternals | null {
    if (typeof window === 'undefined') return null;
    return (window as any).__TAURI_INTERNALS__ || null;
}

/**
 * 当前窗口 label（`main` / `lyric` / `minimode`）
 *
 * Tauri 在初始化脚本文中注入 `__TAURI_INTERNALS__.metadata.currentWindow.label`，
 * 可同步获取；非 Tauri 环境（纯浏览器调试）回退为 main。
 */
export function getCurrentWindowLabel(): string {
    const internals = getTauriInternals();
    return internals?.metadata?.currentWindow?.label || 'main';
}

/**
 * 调用 Rust 暴露的 Tauri 命令
 */
export async function tauriInvoke<T = any>(
    cmd: string,
    args?: Record<string, unknown>,
): Promise<T> {
    const internals = getTauriInternals();
    if (!internals) {
        console.warn(`[TauriBridge] Environment is not Tauri, skip invoke: ${cmd}`, args);
        return Promise.resolve(null as unknown as T);
    }
    return internals.invoke<T>(cmd, args);
}

/**
 * 监听 Tauri 全局事件
 */
export async function tauriListen<T = any>(
    event: string,
    handler: (payload: T) => void,
): Promise<() => void> {
    const internals = getTauriInternals();
    if (!internals) {
        return () => {};
    }

    try {
        const handlerId = internals.transformCallback((e: { event: string; payload: T }) => {
            handler(e.payload);
        });
        await internals.invoke('plugin:event|listen', {
            event,
            target: { kind: 'Any' },
            handler: handlerId,
        });

        return async () => {
            try {
                await internals.invoke('plugin:event|unlisten', {
                    event,
                    eventId: handlerId,
                });
            } catch (err) {
                console.error(`[TauriBridge] Failed to unlisten event ${event}:`, err);
            }
        };
    } catch (err) {
        console.error(`[TauriBridge] Failed to listen event ${event}:`, err);
        return () => {};
    }
}

/**
 * 发射 Tauri 全局事件
 */
export async function tauriEmit(event: string, payload?: unknown): Promise<void> {
    const internals = getTauriInternals();
    if (!internals) return;
    try {
        await internals.invoke('plugin:event|emit', {
            event,
            payload,
        });
    } catch (err) {
        console.error(`[TauriBridge] Failed to emit event ${event}:`, err);
    }
}
