// 流式下载命令：供 JS 侧 downloadManager 桥使用。
//
// - 流式写盘（不缓冲整文件），支持 Range 断点续传（resume=true 时读已有文件大小）
// - 进度事件：tauri-download-progress（约 500ms 节流）
// - 取消：download_cancel 置位后最多 500ms 内中断（文件保留断点）
// - 服务器不支持 Range（200 而非 206）时从头下载（truncate）

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

use super::network;

/// 活跃下载的取消标志表
#[derive(Default)]
pub struct DownloadCancelState(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    task_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileResult {
    content_type: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadCancelState>,
    task_id: String,
    url: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    resume: Option<bool>,
) -> Result<DownloadFileResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(task_id.clone(), cancel.clone());
    }

    let result = download_inner(
        &app,
        &task_id,
        &url,
        &path,
        headers,
        resume.unwrap_or(false),
        cancel.clone(),
    )
    .await;

    if let Ok(mut map) = state.0.lock() {
        map.remove(&task_id);
    }
    result
}

#[tauri::command]
pub fn download_cancel(
    state: tauri::State<'_, DownloadCancelState>,
    task_id: String,
) -> Result<(), String> {
    if let Ok(map) = state.0.lock() {
        if let Some(flag) = map.get(&task_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

async fn download_inner(
    app: &tauri::AppHandle,
    task_id: &str,
    url: &str,
    path: &str,
    headers: Option<HashMap<String, String>>,
    resume: bool,
    cancel: Arc<AtomicBool>,
) -> Result<DownloadFileResult, String> {
    let settings = network::read_settings();
    let client = network::apply(
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(30)),
        &settings,
    )
    .build()
    .map_err(|e| e.to_string())?;

    // 断点续传：以已有临时文件的实际大小为准
    let mut existing: u64 = 0;
    if resume {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if meta.is_file() {
                existing = meta.len();
            }
        }
    }

    let mut request = client.get(url);
    if let Some(map) = &headers {
        for (key, value) in map {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                request = request.header(name, val);
            }
        }
    }
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", existing));
    }

    let mut response = request.send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let is_partial = response.status().as_u16() == 206;
    let content_length = response.content_length();
    let total: Option<u64> = match content_length {
        Some(len) => Some(if is_partial { existing + len } else { len }),
        None => None,
    };
    let mut downloaded: u64 = if is_partial { existing } else { 0 };

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // 确保目标下载目录存在（无论是否更改过下载路径）
    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create download directory: {}", e))?;
    }

    // 打开写入句柄：续传 → append；不支持 Range → 从头（truncate）
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if is_partial {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options.open(path).await.map_err(|e| e.to_string())?;

    // 起始进度（携带 total，供 UI 立即显示总量）
    let _ = app.emit(
        "tauri-download-progress",
        ProgressPayload {
            task_id: task_id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            speed: 0.0,
        },
    );

    let mut last_emit = Instant::now();
    let mut last_bytes = downloaded;
    let mut speed = 0f64;

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = file.flush().await;
            return Err("cancelled".to_string());
        }

        // 500ms 心跳与数据竞争：既保证取消及时生效，也避免读阻塞时无法取消
        let chunk_result = tokio::select! {
            result = response.chunk() => result,
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = file.flush().await;
                    return Err("cancelled".to_string());
                }
                continue;
            }
        };

        match chunk_result {
            Ok(Some(chunk)) => {
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                downloaded += chunk.len() as u64;

                let now = Instant::now();
                let elapsed = now.duration_since(last_emit).as_secs_f64();
                if elapsed >= 0.5 {
                    speed = (downloaded.saturating_sub(last_bytes)) as f64 / elapsed;
                    last_bytes = downloaded;
                    last_emit = now;
                    let _ = app.emit(
                        "tauri-download-progress",
                        ProgressPayload {
                            task_id: task_id.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes: total,
                            speed,
                        },
                    );
                }
            }
            Ok(None) => break,
            Err(err) => {
                let _ = file.flush().await;
                return Err(err.to_string());
            }
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    if let Some(expected) = total {
        if downloaded < expected {
            return Err(format!("incomplete: {}/{}", downloaded, expected));
        }
    }

    Ok(DownloadFileResult {
        content_type,
        downloaded_bytes: downloaded,
        total_bytes: total,
    })
}
