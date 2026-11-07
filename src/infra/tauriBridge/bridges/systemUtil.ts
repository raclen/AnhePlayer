/**
 * Tauri 桥接：systemUtil
 */
import { CONTEXT_BRIDGE_KEY } from '@infra/systemUtil/common/constant';
import type { IUpdateInfo, IUpdateProgress } from '@appTypes/infra/systemUtil';
import { tauriInvoke, tauriListen } from '../ipc';

async function checkUpdateImpl(): Promise<IUpdateInfo> {
    const info = await tauriInvoke<IUpdateInfo>('check_app_update');
    if (!info) throw new Error('应用内更新仅在桌面应用中可用');
    return info;
}

async function downloadUpdateImpl(
    version: string,
    onProgress: (progress: IUpdateProgress) => void,
): Promise<void> {
    if (!(window as any).__TAURI_INTERNALS__) {
        throw new Error('应用内更新仅在桌面应用中可用');
    }
    let active = true;
    const unlisten = await tauriListen<IUpdateProgress>('app-update-progress', (progress) => {
        if (active && progress.version === version) onProgress(progress);
    });
    try {
        await tauriInvoke('download_app_update', { version });
    } finally {
        // 忽略已排队但晚于命令结果送达的事件，避免 ready 状态倒退到 verifying。
        active = false;
        unlisten();
    }
}

export function registerSystemUtilBridge(): void {
    const mod = {
        app: {
            exitApp: () => {
                tauriInvoke('exit_app').catch(console.error);
            },
            getCacheSize: async (): Promise<number> => {
                try {
                    return (await tauriInvoke<number>('get_cache_size')) ?? 0;
                } catch {
                    return 0;
                }
            },
            clearCache: () => {
                tauriInvoke('clear_cache').catch(console.error);
            },
            checkUpdate: checkUpdateImpl,
            downloadUpdate: downloadUpdateImpl,
            installUpdate: async (version: string): Promise<void> => {
                if (!(window as any).__TAURI_INTERNALS__) {
                    throw new Error('应用内更新仅在桌面应用中可用');
                }
                await tauriInvoke('install_app_update', { version });
            },
        },
        window: {
            minimizeWindow: (skipTaskBar?: boolean) => {
                tauriInvoke('minimize_window', { skipTaskBar }).catch(console.error);
            },
            showMainWindow: () => {
                tauriInvoke('show_main_window').catch(console.error);
            },
            toggleMaximize: () => {
                tauriInvoke('toggle_maximize').catch(console.error);
            },
            toggleVisible: () => {
                tauriInvoke('toggle_visible').catch(console.error);
            },
            ignoreMouseEvent: (ignore: boolean) => {
                tauriInvoke('ignore_mouse_event', { ignore }).catch(console.error);
            },
            enterMinimode: () => {
                tauriInvoke('enter_minimode').catch(console.error);
            },
            exitMinimode: () => {
                tauriInvoke('exit_minimode').catch(console.error);
            },
            toggleMinimode: () => {
                tauriInvoke('toggle_minimode').catch(console.error);
            },
            syncLyricWindow: (options: {
                enabled: boolean;
                alwaysOnTop: boolean;
                locked: boolean;
            }) => {
                tauriInvoke('sync_lyric_window', {
                    enabled: options.enabled,
                    alwaysOnTop: options.alwaysOnTop,
                    locked: options.locked,
                }).catch(console.error);
            },
        },
        shell: {
            openExternal: (url: string) => {
                tauriInvoke('open_external', { url }).catch(console.error);
            },
            openPath: (path: string) => {
                tauriInvoke('open_path', { path }).catch(console.error);
            },
            showItemInFolder: async (path: string): Promise<boolean> => {
                try {
                    return await tauriInvoke<boolean>('show_item_in_folder', { path });
                } catch {
                    return false;
                }
            },
        },
        dialog: {
            showOpenDialog: async (options: any): Promise<any> => {
                try {
                    const result = await tauriInvoke<string[] | string | null>('show_open_dialog', {
                        options,
                    });
                    if (!result) return { canceled: true, filePaths: [] };
                    return {
                        canceled: false,
                        filePaths: Array.isArray(result) ? result : [result],
                    };
                } catch {
                    return { canceled: true, filePaths: [] };
                }
            },
            showSaveDialog: async (options: any): Promise<any> => {
                try {
                    const filePath = await tauriInvoke<string | null>('show_save_dialog', {
                        options,
                    });
                    if (!filePath) return { canceled: true, filePath: undefined };
                    return { canceled: false, filePath };
                } catch {
                    return { canceled: true, filePath: undefined };
                }
            },
        },
    };

    (window as any)[CONTEXT_BRIDGE_KEY] = mod;
}
