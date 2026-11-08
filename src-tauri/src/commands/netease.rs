//! 网易云账号：登录窗口与带 Cookie 的请求
//!
//! 登录窗口与主窗口共用同一个 WebView2 profile，Cookie 由 WebView2 加密持久化。
//! MUSIC_U 只在本模块内读取并拼进请求头，从不返回给前端；
//! weapi 加密与业务编排在前端完成（src/infra/neteaseAccount/common）。

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::webview::{Cookie, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::network;

const LOGIN_WINDOW_LABEL: &str = "netease-login";
const LOGIN_URL: &str = "https://music.163.com/#/login";
const NETEASE_ORIGIN: &str = "https://music.163.com";
const NETEASE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const LOGIN_POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// 登录窗口内允许加载的站点：网易系 + 第三方登录（QQ / 微信 / 微博 / Apple）
const LOGIN_ALLOWED_DOMAINS: &[&str] = &[
    "163.com",
    "126.com",
    "netease.com",
    "qq.com",
    "weibo.com",
    "sina.com.cn",
    "apple.com",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSession {
    logged_in: bool,
    csrf: String,
    login_window_open: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum NeteaseMethod {
    Get,
    Post,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseResponse {
    status_code: u16,
    body: String,
}

fn is_login_allowed(url: &Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    LOGIN_ALLOWED_DOMAINS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// 远程页面给出的链接只允许 http/https 交给系统浏览器，防止唤起任意协议处理程序
fn open_external_safely(url: &Url) {
    if url.scheme() == "https" || url.scheme() == "http" {
        let _ = open::that_detached(url.as_str());
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

/// 读取 music.163.com 的 Cookie。
/// WebView2 的 Cookie 读取在同步上下文会死锁，必须放到独立线程（见 wry#583）。
async fn read_cookies(app: &AppHandle) -> Result<Vec<Cookie<'static>>, String> {
    let window = main_window(app)?;
    let url = Url::parse(NETEASE_ORIGIN).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn cookie_value<'a>(cookies: &'a [Cookie<'static>], name: &str) -> Option<&'a str> {
    cookies
        .iter()
        .find(|c| c.name() == name && !c.value().is_empty())
        .map(|c| c.value())
}

fn is_logged_in(cookies: &[Cookie<'static>]) -> bool {
    cookie_value(cookies, "MUSIC_U").is_some()
}

/// 按主窗口所在屏幕的可用区域收缩登录窗口，避免小屏幕上超出屏幕
fn login_window_size(app: &AppHandle) -> (f64, f64) {
    let (mut width, mut height) = (1000.0_f64, 720.0_f64);
    if let Ok(Some(monitor)) =
        main_window(app).and_then(|w| w.current_monitor().map_err(|e| e.to_string()))
    {
        let scale = monitor.scale_factor();
        let area = monitor.work_area().size;
        width = width.min(area.width as f64 / scale - 48.0).max(480.0);
        height = height.min(area.height as f64 / scale - 64.0).max(420.0);
    }
    (width, height)
}
#[tauri::command]
pub async fn netease_login_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let url = Url::parse(LOGIN_URL).map_err(|e| e.to_string())?;
    let (width, height) = login_window_size(&app);

    WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("网易云音乐账号登录")
        .inner_size(width, height)
        .min_inner_size(480.0, 420.0)
        .resizable(true)
        .center()
        .focused(true)
        .on_navigation(|url| {
            if is_login_allowed(url) {
                return true;
            }
            open_external_safely(url);
            false
        })
        // 第三方登录（QQ/微信）依赖 window.open 弹窗：白名单内放行，其余交给系统浏览器
        .on_new_window(|url, _features| {
            if is_login_allowed(&url) {
                NewWindowResponse::Allow
            } else {
                open_external_safely(&url);
                NewWindowResponse::Deny
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 等待登录：检测到 MUSIC_U 返回 true，用户关闭登录窗口返回 false。
/// 轮询放在 Rust 侧，避免登录窗口遮住主窗口时页面计时器被节流。
#[tauri::command]
pub async fn netease_login_wait(app: AppHandle) -> Result<bool, String> {
    loop {
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            return Ok(false);
        }
        if let Ok(cookies) = read_cookies(&app).await {
            if is_logged_in(&cookies) {
                return Ok(true);
            }
        }
        tokio::time::sleep(LOGIN_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub fn netease_login_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn netease_session(app: AppHandle) -> Result<NeteaseSession, String> {
    let cookies = read_cookies(&app).await?;
    Ok(NeteaseSession {
        logged_in: is_logged_in(&cookies),
        csrf: cookie_value(&cookies, "__csrf")
            .unwrap_or_default()
            .to_string(),
        login_window_open: app.get_webview_window(LOGIN_WINDOW_LABEL).is_some(),
    })
}

/// 携带账号 Cookie 请求 music.163.com。只接受站内路径，防止被当作任意 URL 的带凭据代理。
#[tauri::command]
pub async fn netease_request(
    app: AppHandle,
    method: NeteaseMethod,
    path: String,
    body: Option<String>,
) -> Result<NeteaseResponse, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err("invalid path".to_string());
    }
    let url = Url::parse(NETEASE_ORIGIN)
        .and_then(|base| base.join(&path))
        .map_err(|e| e.to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("music.163.com") {
        return Err("invalid path".to_string());
    }

    let cookies = read_cookies(&app).await?;
    let cookie_header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");

    let settings = network::read_settings();
    let client = network::apply(
        reqwest::Client::builder().timeout(REQUEST_TIMEOUT),
        &settings,
    )
    .build()
    .map_err(|e| e.to_string())?;

    let mut req = match method {
        NeteaseMethod::Get => client.get(url),
        NeteaseMethod::Post => client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Origin", NETEASE_ORIGIN)
            .body(body.unwrap_or_default()),
    };
    req = req
        .header("Referer", format!("{NETEASE_ORIGIN}/"))
        .header("User-Agent", NETEASE_UA);
    if !cookie_header.is_empty() {
        req = req.header("Cookie", cookie_header);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status_code = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(NeteaseResponse { status_code, body })
}

/// 退出登录：删除 music.163.com 的全部 Cookie。
/// 不用 clear_all_browsing_data，否则会连主窗口的 localStorage 一起清空。
#[tauri::command]
pub async fn netease_logout(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    let cookies = read_cookies(&app).await?;
    let window = main_window(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        for cookie in cookies {
            let _ = window.delete_cookie(cookie);
        }
    })
    .await
    .map_err(|e| e.to_string())
}
