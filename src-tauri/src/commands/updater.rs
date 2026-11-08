use serde::Serialize;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use super::network;

const MANIFEST_URL: &str =
    "https://github.com/raclen/AnhePlayer/releases/latest/download/latest.json";
const RELEASE_PREFIX: &str = "https://github.com/raclen/AnhePlayer/releases/download/";
/// 镜像优先（官方直连在部分网络下超时严重），末位保留官方地址作为兜底
const MIRRORS: &[&str] = &[
    "https://cdn.gh-proxy.org/",
    "https://gh-proxy.org/",
    "https://hk.gh-proxy.org/",
    "",
];
const PROGRESS_EVENT: &str = "app-update-progress";

#[derive(Default)]
pub struct AppUpdateState(Mutex<PendingUpdate>);

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    // 仅缓存本次进程中通过签名验证的安装包，不接受前端传入文件或下载地址。
    bytes: Option<Arc<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    update: Option<UpdateDetails>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDetails {
    version: String,
    change_log: Vec<String>,
    ready: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    version: String,
    stage: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    attempt: usize,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可管理应用更新".into());
    }
    Ok(())
}

fn update_info(app: &AppHandle, pending: &PendingUpdate) -> UpdateInfo {
    UpdateInfo {
        version: app.package_info().version.to_string(),
        update: pending.update.as_ref().map(|update| UpdateDetails {
            version: update.version.clone(),
            change_log: update
                .body
                .as_deref()
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_owned)
                .collect(),
            ready: pending.bytes.is_some(),
        }),
    }
}

fn selected_update(pending: &PendingUpdate, version: &str) -> Result<Update, String> {
    pending
        .update
        .as_ref()
        .filter(|update| update.version == version)
        .cloned()
        .ok_or_else(|| "更新信息已变化，请重新检查更新".into())
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppUpdateState>,
) -> Result<UpdateInfo, String> {
    ensure_main_window(&window)?;
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty());
    if !configured {
        return Err("此构建尚未配置更新签名公钥，应用内更新暂不可用".into());
    }
    let mut pending = state.0.try_lock().map_err(|_| "正在处理更新，请稍后重试")?;
    // 避免再次检查覆盖用户尚未安装的已验证更新包。
    if pending.bytes.is_some() {
        return Ok(update_info(&app, &pending));
    }
    let settings = network::read_settings();
    let mut last_error = String::new();
    for mirror in MIRRORS {
        let endpoint = format!("{mirror}{MANIFEST_URL}")
            .parse()
            .map_err(|e| format!("更新源配置错误：{e}"))?;
        let updater = network::apply_updater(app.updater_builder(), &settings)
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(15))
            .header("Cache-Control", "no-cache")
            .map_err(|e| e.to_string())?
            .configure_client(|client| {
                client
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(30))
            })
            .build()
            .map_err(|e| e.to_string())?;
        // 按源独立检查：镜像返回 HTML 或损坏 JSON 时，也必须能继续回退。
        match updater.check().await {
            Ok(update) => {
                pending.update = update;
                return Ok(update_info(&app, &pending));
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "无法获取已发布的更新信息，请检查网络后重试：{last_error}"
    ))
}

#[tauri::command]
pub async fn download_app_update(
    window: WebviewWindow,
    state: State<'_, AppUpdateState>,
    version: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let mut pending = state.0.try_lock().map_err(|_| "正在处理更新，请稍后重试")?;
    let update = selected_update(&pending, &version)?;
    if pending.bytes.is_some() {
        return Ok(());
    }
    // 镜像只是传输回退，安装包始终使用应用内置公钥验证。
    let original_url = update.download_url.as_str();
    if !original_url.starts_with(RELEASE_PREFIX) {
        return Err("更新包地址不是本项目的 HTTPS 发布资产，已拒绝下载".into());
    }
    let mut last_error = String::new();
    for (attempt, mirror) in MIRRORS.iter().enumerate() {
        let mut candidate = update.clone();
        candidate.download_url = format!("{mirror}{original_url}")
            .parse()
            .map_err(|e| format!("下载地址错误：{e}"))?;
        candidate.timeout = Some(Duration::from_secs(10 * 60));
        let mut downloaded = 0u64;
        let mut last_emit = Instant::now();
        let _ = window.emit(
            PROGRESS_EVENT,
            UpdateProgress {
                version: version.clone(),
                stage: "downloading",
                downloaded_bytes: 0,
                total_bytes: None,
                attempt,
            },
        );
        let result = candidate
            .download(
                |size, total| {
                    downloaded += size as u64;
                    // 合并高频网络分块事件，避免下载占用渲染线程。
                    if last_emit.elapsed() >= Duration::from_millis(100)
                        || total == Some(downloaded)
                    {
                        last_emit = Instant::now();
                        let _ = window.emit(
                            PROGRESS_EVENT,
                            UpdateProgress {
                                version: version.clone(),
                                stage: "downloading",
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                                attempt,
                            },
                        );
                    }
                },
                || {
                    // download 的完成回调发生在验签之前，此时不能宣告可安装。
                    let _ = window.emit(
                        PROGRESS_EVENT,
                        UpdateProgress {
                            version: version.clone(),
                            stage: "verifying",
                            downloaded_bytes: 0,
                            total_bytes: None,
                            attempt,
                        },
                    );
                },
            )
            .await;
        match result {
            Ok(bytes) => {
                pending.bytes = Some(Arc::new(bytes));
                return Ok(());
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!(
        "更新包下载或签名校验失败，未安装任何文件。请重试：{last_error}"
    ))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppUpdateState>,
    version: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let pending = state.0.try_lock().map_err(|_| "正在处理更新，请稍后重试")?;
    let update = selected_update(&pending, &version)?;
    let bytes = pending
        .bytes
        .as_ref()
        .ok_or("请先下载并校验更新包")?
        .clone();
    // 持锁至安装结束，阻止并行检查/安装；失败时保留缓存，允许重试。
    tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice()))
        .await
        .map_err(|e| format!("安装任务失败：{e}"))?
        .map_err(|e| format!("无法启动更新安装程序：{e}"))?;
    drop(pending);
    // Windows 由官方插件启动安装器并退出，安装器负责重启应用。
    if !cfg!(target_os = "windows") {
        app.restart();
    }
    Ok(())
}
