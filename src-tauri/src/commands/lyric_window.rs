use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

use super::app_config;

/// 歌词窗口 label（与 tauri.conf.json 一致）
const LYRIC_WINDOW_LABEL: &str = "lyric";

/// 拖拽/缩放事件合并窗口：一次拖动期间只写一次盘
const PLACEMENT_SAVE_DEBOUNCE: Duration = Duration::from_millis(600);

/// 程序化 set_size/set_position 后的一段时间内忽略窗口事件，
/// 避免「恢复位置」被当成用户拖动写回
const PLACEMENT_SUPPRESS: Duration = Duration::from_millis(400);

const MIN_WIDTH: f64 = 320.0;
const MIN_HEIGHT: f64 = 80.0;
const DEFAULT_WIDTH: f64 = 800.0;
const DEFAULT_HEIGHT: f64 = 160.0;
/// 首次显示时距工作区底部的偏移（逻辑像素），约在播放器底部歌词条的位置
const DEFAULT_BOTTOM_OFFSET: f64 = 72.0;

/// 窗口几何：位置用物理像素（跨屏精确），尺寸用逻辑像素（跨 DPI 视觉一致）
#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
}

pub struct LyricWindowState {
    /// 最新观测到的几何（防抖线程消费）
    latest: Mutex<Option<Placement>>,
    /// 已落盘的几何，相同值不重复写
    last_saved: Mutex<Option<Placement>>,
    /// 该时刻之前忽略窗口事件
    suppress_until: Mutex<Option<Instant>>,
    /// 防抖线程信号通道（setup 时初始化）
    saver_tx: Mutex<Option<Sender<()>>>,
}

impl Default for LyricWindowState {
    fn default() -> Self {
        Self {
            latest: Mutex::new(None),
            last_saved: Mutex::new(None),
            suppress_until: Mutex::new(None),
            saver_tx: Mutex::new(None),
        }
    }
}

// ─── 初始化 ───

/// 启动唯一的位置防抖保存线程（在 app setup 阶段调用一次）
pub fn init_lyric_window(app: &AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    {
        let state = app.state::<LyricWindowState>();
        *state.saver_tx.lock().unwrap() = Some(tx.clone());
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 单飞防抖：合并同一轮拖动内的所有事件
            loop {
                match rx.recv_timeout(PLACEMENT_SAVE_DEBOUNCE) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            if is_suppressed(&app_handle) {
                continue;
            }
            let Some(window) = app_handle.get_webview_window(LYRIC_WINDOW_LABEL) else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let latest = {
                let state = app_handle.state::<LyricWindowState>();
                let taken = state.latest.lock().unwrap().take();
                taken
            };
            if let Some(placement) = latest {
                write_placement(&app_handle, placement);
            }
        }
    });
}

// ─── 窗口事件 ───

/// 处理 lyric 窗口的几何变化与关闭请求（由 lib.rs 的 on_window_event 分发）
pub fn handle_lyric_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle().clone();

    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if is_suppressed(&app) {
                return;
            }
            // 隐藏期间的几何变化没有保存价值
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            let Some(placement) = read_window_placement(window) else {
                return;
            };
            {
                let state = app.state::<LyricWindowState>();
                *state.latest.lock().unwrap() = Some(placement);
                let sender = state.saver_tx.lock().unwrap().clone();
                if let Some(tx) = sender {
                    let _ = tx.send(());
                }
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            // 歌词窗口没有关闭按钮，但 Alt+F4 / 系统级关闭仍可能到达。
            // 直接销毁会让 get_webview_window("lyric") 永久返回 None，因此改为隐藏 + 关开关。
            api.prevent_close();
            persist_current(&app);
            let _ = window.hide();
            let _ = app_config::patch_config(
                &app,
                serde_json::json!({ "lyric.enableDesktopLyric": false }),
            );
        }
        _ => {}
    }
}

// ─── 命令 ───

/// 按配置同步歌词窗口：显隐 / 置顶 / 点击穿透 / 位置恢复
///
/// 一个命令承载全部窗口状态且幂等；前端每次配置变化都整份推送，
/// 避免多条 IPC 之间的时序竞争与穿透状态残留。
#[tauri::command]
pub fn sync_lyric_window(
    app: AppHandle,
    enabled: bool,
    always_on_top: bool,
    locked: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LYRIC_WINDOW_LABEL) else {
        return Ok(());
    };

    if !enabled {
        // 隐藏前强制落盘，避免「拖完立刻关歌词」丢失最后位置
        persist_current(&app);
        // 清除穿透，避免下次未锁定时窗口仍然点不到
        let _ = window.set_ignore_cursor_events(false);
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        }
        return Ok(());
    }

    let (width, height, x, y) = resolve_placement(&app, &window);
    suppress_placement_save(&app);

    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_always_on_top(always_on_top);
    let _ = window.set_ignore_cursor_events(locked);

    // 最后才显示，且不抢键盘焦点
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }

    Ok(())
}

// ─── 几何解析 ───

/// 返回 (物理宽, 物理高, 物理 x, 物理 y)
fn resolve_placement(app: &AppHandle, window: &tauri::WebviewWindow) -> (u32, u32, i32, i32) {
    // 可见时以当前几何为准：保证「刚拖动 + 马上切换置顶」不被旧配置拉回
    let base = if window.is_visible().unwrap_or(false) {
        read_webview_placement(window).or_else(|| read_placement(app))
    } else {
        read_placement(app)
    }
    .unwrap_or_else(|| default_placement(app));

    // 目标显示器：包含保存点 → 主屏 → 任意可用屏
    let target = app
        .monitor_from_point(base.x as f64, base.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| {
            app.available_monitors()
                .ok()
                .and_then(|m| m.into_iter().next())
        });

    let (ax, ay, aw, ah, scale) = match &target {
        Some(monitor) => {
            let area = monitor.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
                monitor.scale_factor(),
            )
        }
        None => (0, 0, 1920, 1080, 1.0),
    };
    let scale = if scale > 0.0 { scale } else { 1.0 };

    let width_log = if base.width.is_finite() && base.width > 0.0 {
        base.width
    } else {
        DEFAULT_WIDTH
    };
    let height_log = if base.height.is_finite() && base.height > 0.0 {
        base.height
    } else {
        DEFAULT_HEIGHT
    };

    let min_width = (MIN_WIDTH * scale).round() as i32;
    let min_height = (MIN_HEIGHT * scale).round() as i32;
    let width = ((width_log * scale).round() as i32).clamp(min_width, aw.max(min_width));
    let height = ((height_log * scale).round() as i32).clamp(min_height, ah.max(min_height));

    // 位置钳制到工作区内；窗口比屏幕还大时不越界（避免 clamp 的 min > max panic）
    let max_x = (ax + aw - width).max(ax);
    let max_y = (ay + ah - height).max(ay);
    let x = base.x.clamp(ax, max_x);
    let y = base.y.clamp(ay, max_y);

    (width as u32, height as u32, x, y)
}

/// 首次运行（无配置）的位置：主屏底部居中，距任务栏上方约 72 逻辑像素
fn default_placement(app: &AppHandle) -> Placement {
    let (ax, ay, aw, ah, scale) = match app.primary_monitor().ok().flatten() {
        Some(monitor) => {
            let area = monitor.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
                monitor.scale_factor(),
            )
        }
        None => (0, 0, 1920, 1080, 1.0),
    };
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let width_phys = (DEFAULT_WIDTH * scale).round() as i32;
    let height_phys = (DEFAULT_HEIGHT * scale).round() as i32;
    let bottom_offset = (DEFAULT_BOTTOM_OFFSET * scale).round() as i32;

    Placement {
        x: ax + ((aw - width_phys) / 2).max(0),
        y: ay + (ah - height_phys - bottom_offset).max(0),
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    }
}

fn read_placement(app: &AppHandle) -> Option<Placement> {
    let config = app_config::read_config_value();
    let pos = config.get("private.lyricWindowPosition")?;
    let size = config.get("private.lyricWindowSize")?;

    let width = size.get("width")?.as_f64()?;
    let height = size.get("height")?.as_f64()?;

    Some(Placement {
        x: pos.get("x")?.as_i64()? as i32,
        y: pos.get("y")?.as_i64()? as i32,
        width,
        height,
    })
}

fn read_window_placement(window: &Window) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0);
    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

fn read_webview_placement(window: &tauri::WebviewWindow) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0);
    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

// ─── 位置持久化 ───

fn persist_current(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LYRIC_WINDOW_LABEL) else {
        return;
    };
    let Some(placement) = read_webview_placement(&window) else {
        return;
    };
    write_placement(app, placement);
}

fn write_placement(app: &AppHandle, placement: Placement) {
    {
        let state = app.state::<LyricWindowState>();
        let mut last = state.last_saved.lock().unwrap();
        if *last == Some(placement) {
            return;
        }
        *last = Some(placement);
    }

    let _ = app_config::patch_config(
        app,
        serde_json::json!({
            "private.lyricWindowPosition": { "x": placement.x, "y": placement.y },
            "private.lyricWindowSize": {
                "width": placement.width.round() as i64,
                "height": placement.height.round() as i64,
            },
        }),
    );
}

fn suppress_placement_save(app: &AppHandle) {
    let state = app.state::<LyricWindowState>();
    let until = Instant::now() + PLACEMENT_SUPPRESS;
    *state.suppress_until.lock().unwrap() = Some(until);
}

fn is_suppressed(app: &AppHandle) -> bool {
    let state = app.state::<LyricWindowState>();
    let suppressed = state
        .suppress_until
        .lock()
        .unwrap()
        .map(|until| Instant::now() < until)
        .unwrap_or(false);
    suppressed
}
