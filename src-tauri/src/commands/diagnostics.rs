// 播放诊断专用落盘出口；不接管第三方 HTTP 库日志，避免输出凭据和签名地址。
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const FILE_COUNT: usize = 3;
const MAX_ENTRY_BYTES: usize = 16 * 1024;
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn log_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("AnhePlayer").join("logs"))
        .ok_or_else(|| "无法获取日志目录".to_string())
}

fn log_file(index: usize) -> Result<PathBuf, String> {
    let name = if index == 0 {
        "playback.log".to_string()
    } else {
        format!("playback.{index}.log")
    };
    Ok(log_dir()?.join(name))
}

pub fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn append(entry: Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(&entry).map_err(|_| "日志序列化失败")?;
    if line.len() > MAX_ENTRY_BYTES {
        line = serde_json::to_vec(&json!({
            "timestampMs": timestamp_ms(), "source": "diagnostics",
            "event": "entry-too-large", "originalBytes": line.len()
        }))
        .map_err(|_| "日志序列化失败")?;
    }
    line.push(b'\n');

    let _guard = FILE_LOCK.lock().map_err(|_| "日志文件锁不可用")?;
    let dir = log_dir()?;
    fs::create_dir_all(&dir).map_err(|_| "无法创建日志目录")?;
    let current = log_file(0)?;
    let size = fs::metadata(&current).map(|meta| meta.len()).unwrap_or(0);
    if size + line.len() as u64 > MAX_FILE_BYTES {
        for index in (1..FILE_COUNT).rev() {
            let from = log_file(index - 1)?;
            let to = log_file(index)?;
            if to.exists() {
                fs::remove_file(&to).map_err(|_| "日志轮转失败")?;
            }
            if from.exists() {
                fs::rename(from, to).map_err(|_| "日志轮转失败")?;
            }
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .and_then(|mut file| file.write_all(&line))
        .map_err(|_| "无法写入日志文件".to_string())
}

/// 诊断写入失败不能影响播放；调用方只能传递已经筛选过的安全字段。
pub fn record(level: &str, event: &str, fields: Value) {
    let _ = append(json!({
        "timestampMs": timestamp_ms(), "processId": std::process::id(),
        "level": level, "source": "native", "event": event, "fields": fields
    }));
}

#[tauri::command]
pub async fn log_entry(entry: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || append(entry))
        .await
        .map_err(|_| "日志写入任务失败")?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogs {
    path: String,
    content: String,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以管理诊断日志".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_diagnostic_logs(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<DiagnosticLogs, String> {
    require_main(&window)?;
    let environment = json!({
        "source": "diagnostics", "event": "export-environment",
        "timestampMs": timestamp_ms(), "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
        "processId": std::process::id()
    });
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = FILE_LOCK.lock().map_err(|_| "日志文件锁不可用")?;
        let mut content = format!("{environment}\n");
        for index in (0..FILE_COUNT).rev() {
            let path = log_file(index)?;
            match fs::read_to_string(path) {
                Ok(text) => content.push_str(&text),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法读取日志文件".to_string()),
            }
        }
        Ok(DiagnosticLogs {
            path: log_file(0)?.to_string_lossy().into_owned(),
            content,
        })
    })
    .await
    .map_err(|_| "日志读取任务失败")?
}

#[tauri::command]
pub async fn clear_diagnostic_logs(window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = FILE_LOCK.lock().map_err(|_| "日志文件锁不可用")?;
        for index in 0..FILE_COUNT {
            match fs::remove_file(log_file(index)?) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法清空日志文件".to_string()),
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "日志清空任务失败")?
}
