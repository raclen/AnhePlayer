/**
 * appSync — 主窗口 Renderer 层
 *
 * 提供类型安全的窗口间同步 API。
 */
import type { IAppState, ICommand, WindowType } from '@appTypes/infra/appSync';
import { CONTEXT_BRIDGE_KEY } from '../common/constant';

interface IMod {
    syncAppState(state: Partial<IAppState>): void;
    syncAppStateTo(windowType: string, state: Partial<IAppState>): void;
    onCommand(command: string, cb: (data: unknown, from: string) => void): () => void;
    sendCommand(command: string, data?: unknown): void;
    onSubscribe(cb: (windowType: string) => void): () => void;
    setSnapshotProvider(getter: () => Partial<IAppState>): void;
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

const appSync = {
    /** 同步应用状态到辅助窗口 */
    syncAppState(state: Partial<IAppState>): void {
        mod.syncAppState(state);
    },

    /** 监听指令 */
    onCommand<K extends keyof ICommand>(
        command: K,
        cb: (data: ICommand[K], from: string) => void,
    ): void {
        mod.onCommand(command as string, cb as (data: unknown, from: string) => void);
    },

    /** 发送指令（主窗口内部派发） */
    sendCommand<K extends keyof ICommand>(command: K, data?: ICommand[K]): void {
        mod.sendCommand(command as string, data);
    },

    /** 定向推送状态到指定辅助窗口 */
    syncAppStateTo(windowType: WindowType, state: Partial<IAppState>): void {
        mod.syncAppStateTo(windowType, state);
    },

    /** 监听辅助窗口订阅事件，回调携带窗口类型 */
    onSubscribe(cb: (windowType: WindowType) => void): void {
        mod.onSubscribe(cb as (windowType: string) => void);
    },

    /**
     * 注册状态快照提供者。
     * 辅助窗口请求全量快照时（含启动早于主窗口推送的情况）由它取当前状态。
     */
    setSnapshotProvider(getter: () => Partial<IAppState>): void {
        mod.setSnapshotProvider(getter);
    },
};

export default appSync;
