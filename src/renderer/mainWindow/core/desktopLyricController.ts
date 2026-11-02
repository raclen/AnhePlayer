/**
 * 桌面歌词控制器
 *
 * 把 `lyric.enableDesktopLyric` / `lyric.alwaysOnTop` / `lyric.lockLyric`
 * 三项配置映射为歌词窗口的显隐、置顶与点击穿透。
 *
 * 所有入口（主窗口播放栏、设置页、全屏播放器、迷你模式、歌词工具栏、
 * 快捷键、系统托盘）都只写 appConfig，由本控制器统一驱动窗口状态，
 * 避免多处直接操作窗口造成的状态不一致。
 */
import appConfig from '@infra/appConfig/renderer';
import systemUtil from '@infra/systemUtil/renderer';

const DEFAULT_ENABLED = false;
const DEFAULT_ALWAYS_ON_TOP = true;
const DEFAULT_LOCKED = false;

interface ILyricWindowOptions {
    enabled: boolean;
    alwaysOnTop: boolean;
    locked: boolean;
}

export function setupDesktopLyricController(): void {
    const options: ILyricWindowOptions = {
        enabled: appConfig.getConfigByKey('lyric.enableDesktopLyric') ?? DEFAULT_ENABLED,
        alwaysOnTop: appConfig.getConfigByKey('lyric.alwaysOnTop') ?? DEFAULT_ALWAYS_ON_TOP,
        locked: appConfig.getConfigByKey('lyric.lockLyric') ?? DEFAULT_LOCKED,
    };

    const push = () => {
        systemUtil.syncLyricWindow(options);
    };

    // 启动时按磁盘配置对齐一次
    push();

    // 主窗口生命周期 === 应用生命周期，无需注销
    appConfig.onConfigUpdated((patch) => {
        let dirty = false;

        if ('lyric.enableDesktopLyric' in patch) {
            const next = !!patch['lyric.enableDesktopLyric'];
            if (next !== options.enabled) {
                options.enabled = next;
                dirty = true;
            }
        }
        if ('lyric.alwaysOnTop' in patch) {
            const next = !!patch['lyric.alwaysOnTop'];
            if (next !== options.alwaysOnTop) {
                options.alwaysOnTop = next;
                dirty = true;
            }
        }
        if ('lyric.lockLyric' in patch) {
            const next = !!patch['lyric.lockLyric'];
            if (next !== options.locked) {
                options.locked = next;
                dirty = true;
            }
        }

        if (dirty) push();
    });
}
