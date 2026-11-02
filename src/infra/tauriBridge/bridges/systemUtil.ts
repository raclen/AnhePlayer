/**
 * Tauri 桥接：systemUtil
 */
import { compare } from 'compare-versions';
import { CONTEXT_BRIDGE_KEY, UPDATE_SOURCES } from '@infra/systemUtil/common/constant';
import type { IUpdateInfo } from '@appTypes/infra/systemUtil';
import { tauriInvoke } from '../ipc';

/**
 * 检查应用更新（JS 实现，逐源尝试）。
 * 任一更新源返回更高版本即中止并给出 update 信息。
 */
async function checkUpdateImpl(): Promise<IUpdateInfo> {
    const currentVersion = ((globalThis as any).globalContext?.appVersion as string) || '0.0.0';
    const info: IUpdateInfo = { version: currentVersion };

    for (const source of UPDATE_SOURCES) {
        try {
            const res = await tauriInvoke<{ statusCode: number; body: string }>('http_request', {
                url: source,
                options: {
                    method: 'GET',
                    headers: { 'Cache-Control': 'no-cache' },
                },
            });
            if (!res || res.statusCode !== 200 || typeof res.body !== 'string') continue;

            let remote: { version?: string; changeLog?: unknown; download?: unknown };
            try {
                remote = JSON.parse(res.body);
            } catch {
                continue;
            }
            if (!remote?.version) continue;

            if (compare(String(remote.version), currentVersion, '>')) {
                info.update = {
                    version: String(remote.version),
                    changeLog: Array.isArray(remote.changeLog)
                        ? (remote.changeLog as string[])
                        : undefined,
                    download: Array.isArray(remote.download)
                        ? (remote.download as string[])
                        : undefined,
                };
            }
            // 首个可用源成功即返回（无论是否有更新）
            return info;
        } catch {
            /* 当前源不可用，尝试下一个 */
        }
    }

    return info;
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
