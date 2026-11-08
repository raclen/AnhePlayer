/**
 * systemUtil — 渲染进程层
 *
 * 提供类型安全的系统操作 API，按子域名空间分组：
 *   - systemUtil.app   — 应用生命周期
 *   - systemUtil.window — 窗口控制
 *   - systemUtil.shell  — 系统 Shell 操作
 *   - systemUtil.dialog — 原生对话框
 */
import type { IUpdateInfo, IUpdateProgress } from '@appTypes/infra/systemUtil';
import { CONTEXT_BRIDGE_KEY } from './common/constant';

interface IDialogFilter {
    name: string;
    extensions: string[];
}

interface IOpenDialogOptions {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    filters?: IDialogFilter[];
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
}

interface ISaveDialogOptions {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    filters?: IDialogFilter[];
}

interface IOpenDialogResult {
    canceled: boolean;
    filePaths: string[];
}

interface ISaveDialogResult {
    canceled: boolean;
    filePath?: string;
}

// ─── Tauri Bridge ───

interface IMod {
    app: {
        exitApp(): void;
        restartApp(): void;
        getCacheSize(): Promise<number>;
        clearCache(): void;
        checkUpdate(): Promise<IUpdateInfo>;
        downloadUpdate(
            version: string,
            onProgress: (progress: IUpdateProgress) => void,
        ): Promise<void>;
        installUpdate(version: string): Promise<void>;
    };
    window: {
        minimizeWindow(skipTaskBar?: boolean): void;
        showMainWindow(): void;
        toggleMaximize(): void;
        toggleVisible(): void;
        ignoreMouseEvent(ignore: boolean): void;
        enterMinimode(): void;
        exitMinimode(): void;
        toggleMinimode(): void;
        syncLyricWindow(options: { enabled: boolean; alwaysOnTop: boolean; locked: boolean }): void;
    };
    shell: {
        openExternal(url: string): void;
        openPath(path: string): void;
        showItemInFolder(path: string): Promise<boolean>;
    };
    dialog: {
        showOpenDialog(options: IOpenDialogOptions): Promise<IOpenDialogResult>;
        showSaveDialog(options: ISaveDialogOptions): Promise<ISaveDialogResult>;
    };
}

const mod = window[CONTEXT_BRIDGE_KEY as any] as unknown as IMod;

// ─── 模块实现 ───

class SystemUtilRenderer {
    // ─── App ───

    /** 退出应用 */
    public exitApp(): void {
        mod.app.exitApp();
    }

    /** 重启应用（网络代理等启动参数需重启生效） */
    public restartApp(): void {
        mod.app.restartApp();
    }

    /** 获取当前缓存大小（字节） */
    public getCacheSize(): Promise<number> {
        return mod.app.getCacheSize();
    }

    /** 清除浏览器缓存 */
    public clearCache(): void {
        mod.app.clearCache();
    }

    /** 检查应用更新 */
    public checkUpdate(): Promise<IUpdateInfo> {
        return mod.app.checkUpdate();
    }

    /** 下载更新并验证签名，不自动安装 */
    public downloadUpdate(
        version: string,
        onProgress: (progress: IUpdateProgress) => void,
    ): Promise<void> {
        return mod.app.downloadUpdate(version, onProgress);
    }

    /** 安装已验证的更新，成功后由安装器重启应用 */
    public installUpdate(version: string): Promise<void> {
        return mod.app.installUpdate(version);
    }

    // ─── Window ───

    /** 最小化当前窗口 */
    public minimizeWindow(skipTaskBar?: boolean): void {
        mod.window.minimizeWindow(skipTaskBar);
    }

    /** 显示主窗口 */
    public showMainWindow(): void {
        mod.window.showMainWindow();
    }

    /** 切换主窗口最大化状态 */
    public toggleMaximize(): void {
        mod.window.toggleMaximize();
    }

    /** 切换主窗口可见性 */
    public toggleVisible(): void {
        mod.window.toggleVisible();
    }

    /** 忽略鼠标事件（穿透点击） */
    public ignoreMouseEvent(ignore: boolean): void {
        mod.window.ignoreMouseEvent(ignore);
    }

    /** 进入迷你模式 */
    public enterMinimode(): void {
        mod.window.enterMinimode();
    }

    /** 退出迷你模式 */
    public exitMinimode(): void {
        mod.window.exitMinimode();
    }

    /** 切换迷你模式 */
    public toggleMinimode(): void {
        mod.window.toggleMinimode();
    }

    /**
     * 按配置同步桌面歌词窗口（显隐 / 置顶 / 点击穿透 / 位置恢复）。
     * 由主窗口的桌面歌词控制器在配置变化时调用。
     */
    public syncLyricWindow(options: {
        enabled: boolean;
        alwaysOnTop: boolean;
        locked: boolean;
    }): void {
        mod.window.syncLyricWindow(options);
    }

    // ─── Shell ───

    /** 在默认浏览器中打开 URL */
    public openExternal(url: string): void {
        mod.shell.openExternal(url);
    }

    /** 用系统默认程序打开路径 */
    public openPath(path: string): void {
        mod.shell.openPath(path);
    }

    /** 在文件管理器中定位文件 */
    public showItemInFolder(path: string): Promise<boolean> {
        return mod.shell.showItemInFolder(path);
    }

    // ─── Dialog ───

    /** 显示文件打开对话框 */
    public showOpenDialog(options: IOpenDialogOptions): Promise<IOpenDialogResult> {
        return mod.dialog.showOpenDialog(options);
    }

    /** 显示文件保存对话框 */
    public showSaveDialog(options: ISaveDialogOptions): Promise<ISaveDialogResult> {
        return mod.dialog.showSaveDialog(options);
    }
}

const systemUtil = new SystemUtilRenderer();
export default systemUtil;
