mod commands;

use commands::{
    app_config::{self, app_config_reset, app_config_set, app_config_sync},
    audio_tag::*,
    dialog::*,
    download::*,
    forwarder::*,
    fs_util::*,
    global_context::*,
    http_proxy::*,
    local_meta::*,
    lyric_window::{self, sync_lyric_window, LyricWindowState},
    netease::*,
    system_util::*,
    updater::*,
    webdav::*,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager, WindowEvent,
};

/// 从配置文件读取关闭行为。
fn read_close_behavior() -> String {
    app_config::read_config_value()
        .get("normal.closeBehavior")
        .and_then(|v| v.as_str())
        .unwrap_or("minimize")
        .to_string()
}

/// 显示并聚焦主窗口；同时恢复任务栏按钮（关闭到托盘时曾被隐藏）
/// 注意：命名需避开 `system_util::show_main_window` 命令，否则会遮蔽同名命令
fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 只影响播放器进程，不修改 Windows 或代理软件配置。
///
/// 默认直连；配置了可用代理时，WebView2 改用该代理（原生客户端由 `network` 模块逐次读取配置）。
fn configure_network() {
    let proxy = commands::network::read_settings();
    let active = proxy.is_active();
    let webview_arguments = proxy.webview_arguments();

    if active {
        // 有显式代理时清掉直连标记，避免第三方 HTTP 插件把 NO_PROXY=* 也套到代理请求上
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");
    } else {
        // 覆盖第三方 HTTP 插件的自动代理；业务客户端与更新器另有显式 no_proxy 保证。
        std::env::set_var("NO_PROXY", "*");
        std::env::set_var("no_proxy", "*");
    }

    #[cfg(target_os = "windows")]
    {
        // 只保留与本策略无关的参数；重启会继承旧进程环境变量，必须清掉上一轮的代理开关，
        // 否则「直连 ↔ 代理」切换后会残留 `--no-proxy-server` 或旧代理地址。
        let inherited = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kept: Vec<&str> = inherited
            .split_whitespace()
            .filter(|arg| {
                !arg.starts_with("--no-proxy-server")
                    && !arg.starts_with("--proxy-server=")
                    && !arg.starts_with("--proxy-bypass-list=")
            })
            .collect();
        let mut args = kept.join(" ");
        match webview_arguments {
            Some(arguments) => args.push_str(&format!(" {arguments}")),
            // 未启用代理或代理地址不完整时，WebView2 一律直连
            None => args.push_str(" --no-proxy-server"),
        }
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args.trim());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_network();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppUpdateState::default())
        .manage(ForwarderPortState::default())
        .manage(DownloadCancelState::default())
        .manage(LyricWindowState::default())
        .invoke_handler(tauri::generate_handler![
            // Global Context
            global_context_get,
            // App Config
            app_config_sync,
            app_config_set,
            app_config_reset,
            // System Util
            exit_app,
            restart_app,
            minimize_window,
            show_main_window,
            toggle_maximize,
            toggle_visible,
            enter_minimode,
            exit_minimode,
            toggle_minimode,
            open_external,
            open_path,
            show_item_in_folder,
            ignore_mouse_event,
            log_entry,
            get_cache_size,
            clear_cache,
            // 应用内更新（仅主窗口可调用）
            check_app_update,
            download_app_update,
            install_app_update,
            // 桌面歌词窗口
            sync_lyric_window,
            // Dialog
            show_open_dialog,
            show_save_dialog,
            // Fs Util
            fs_write_file,
            fs_read_file,
            fs_is_file,
            fs_is_folder,
            fs_remove,
            fs_mkdir,
            fs_copy_file,
            fs_read_dir,
            fs_rename,
            // HTTP Request / Forwarder
            http_request,
            probe_media_url,
            forwarder_get_port,
            // Local Music
            local_scan_dir,
            local_parse_meta,
            local_export_cover,
            local_read_lyric,
            // Download
            download_file,
            download_cancel,
            // Audio Tag（下载完成后写入封面/歌词）
            write_audio_meta,
            // WebDAV
            webdav_test,
            webdav_put,
            webdav_get,
            // NetEase Account（登录窗口与带 Cookie 请求）
            netease_login_open,
            netease_login_wait,
            netease_login_close,
            netease_session,
            netease_request,
            netease_logout,
        ])
        .setup(|app| {
            commands::forwarder::init_forwarder(app.handle().clone());
            lyric_window::init_lyric_window(app.handle());

            // ── 系统托盘 ──
            // 关闭按钮在「最小化」模式下只会隐藏窗口，必须提供托盘入口将其找回。
            let show_item = MenuItem::with_id(app, "tray-show", "显示主窗口", true, None::<&str>)?;
            // 桌面歌词锁定时整窗鼠标穿透，托盘是唯一可靠的解锁入口
            let lyric_item = CheckMenuItem::with_id(
                app,
                "tray-desktop-lyric",
                "桌面歌词",
                true,
                app_config::get_config_bool("lyric.enableDesktopLyric", false),
                None::<&str>,
            )?;
            let lock_lyric_item = CheckMenuItem::with_id(
                app,
                "tray-lock-lyric",
                "锁定桌面歌词",
                true,
                app_config::get_config_bool("lyric.lockLyric", false),
                None::<&str>,
            )?;
            let exit_item = MenuItem::with_id(app, "tray-exit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &lyric_item, &lock_lyric_item, &exit_item],
            )?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                // 左键单击恢复窗口，右键才弹出菜单
                .show_menu_on_left_click(false)
                .tooltip("AnhePlayer")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => restore_main_window(app),
                    // 只写配置，窗口由主窗口控制器统一驱动，避免双驱动
                    "tray-desktop-lyric" => {
                        let next = !app_config::get_config_bool("lyric.enableDesktopLyric", false);
                        let _ = app_config::patch_config(
                            app,
                            serde_json::json!({ "lyric.enableDesktopLyric": next }),
                        );
                    }
                    "tray-lock-lyric" => {
                        let next = !app_config::get_config_bool("lyric.lockLyric", false);
                        let _ = app_config::patch_config(
                            app,
                            serde_json::json!({ "lyric.lockLyric": next }),
                        );
                    }
                    "tray-exit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            // 任一入口（设置页 / 主窗口 / 歌词工具栏）改动配置后，同步托盘勾选状态
            let lyric_for_config = lyric_item.clone();
            let lock_for_config = lock_lyric_item.clone();
            app.listen("app-config-update", move |event| {
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let Some(patch) = payload.get("patch") else {
                    return;
                };
                if let Some(checked) = patch
                    .get("lyric.enableDesktopLyric")
                    .and_then(|v| v.as_bool())
                {
                    let _ = lyric_for_config.set_checked(checked);
                }
                if let Some(checked) = patch.get("lyric.lockLyric").and_then(|v| v.as_bool()) {
                    let _ = lock_for_config.set_checked(checked);
                }
            });

            // 启动时按磁盘配置对齐一次歌词窗口（隐藏状态下也会正确设置穿透与置顶）
            let enabled = app_config::get_config_bool("lyric.enableDesktopLyric", false);
            let always_on_top = app_config::get_config_bool("lyric.alwaysOnTop", true);
            let locked = app_config::get_config_bool("lyric.lockLyric", false);
            if let Err(err) = lyric_window::sync_lyric_window(
                app.handle().clone(),
                enabled,
                always_on_top,
                locked,
            ) {
                log::warn!("[tray] sync lyric window on startup failed: {err}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match window.label() {
                // 主窗口关闭请求：按配置决定「退出」还是「隐藏到托盘」，
                // 避免窗口被销毁后进程与音频仍在后台运行却无法找回。
                "main" => {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if read_close_behavior() == "exit_app" {
                            window.app_handle().exit(0);
                            return;
                        }
                        api.prevent_close();
                        let _ = window.hide();
                        let _ = window.set_skip_taskbar(true);
                    }
                }
                // 歌词窗口：几何变化防抖持久化 + 关闭请求拦截
                "lyric" => lyric_window::handle_lyric_window_event(window, event),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running anhe-player tauri application");
}
