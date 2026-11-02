use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::Emitter;

fn get_config_file_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("AnhePlayer");
    let _ = fs::create_dir_all(&path);
    path.push("app-config.json");
    path
}

/// 全局配置写锁。
///
/// 主窗口的 `app_config_set` 与歌词窗口位置防抖线程都会「读-改-写」同一份 JSON，
/// 无锁时并发会丢更新；`fs::write` 先 truncate 还可能导致前端读到半截文件。
static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock() -> MutexGuard<'static, ()> {
    CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 不加锁读取配置（仅限已持锁的调用路径，避免非重入 Mutex 死锁）
fn read_config_unlocked() -> Value {
    let path = get_config_file_path();
    if !path.exists() {
        return Value::Null;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or(Value::Null)
}

/// 读取当前配置快照（加锁）
pub fn read_config_value() -> Value {
    let _guard = lock();
    read_config_unlocked()
}

/// 读取布尔配置项，缺失或类型不符时返回默认值
pub fn get_config_bool(key: &str, default: bool) -> bool {
    read_config_value()
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

/// 配置写入的唯一入口：合并 patch → 原子落盘 → 广播 app-config-update
pub fn patch_config(app: &tauri::AppHandle, config: Value) -> Result<(), String> {
    let _guard = lock();
    let path = get_config_file_path();

    // 1. 读取已有配置并与新 patch 进行合并，防止单项配置覆盖抹除其余所有项
    let mut existing = read_config_unlocked();
    if existing.is_null() {
        existing = serde_json::json!({});
    }

    if let (Some(existing_map), Some(patch_map)) = (existing.as_object_mut(), config.as_object()) {
        for (k, v) in patch_map {
            existing_map.insert(k.clone(), v.clone());
        }
    } else {
        existing = config.clone();
    }

    // 2. 先写临时文件再 rename 替换，避免并发读到写了一半的 JSON
    let content = serde_json::to_string_pretty(&existing).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    if fs::write(&tmp_path, &content).is_ok() {
        if fs::rename(&tmp_path, &path).is_err() {
            // 某些环境 rename 失败（目标被占用等），退化为直接写
            let _ = fs::remove_file(&tmp_path);
            fs::write(&path, &content).map_err(|e| e.to_string())?;
        }
    } else {
        fs::write(&path, &content).map_err(|e| e.to_string())?;
    }

    // 3. 广播 app-config-update 事件给所有窗口，驱动 UI 响应式更新与内存缓存同步
    let _ = app.emit(
        "app-config-update",
        serde_json::json!({
            "patch": config,
            "source": "tauri"
        }),
    );

    Ok(())
}

#[tauri::command]
pub fn app_config_sync() -> Result<Value, String> {
    Ok(read_config_value())
}

#[tauri::command]
pub fn app_config_set(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    patch_config(&app, config)
}

#[tauri::command]
pub fn app_config_reset(app: tauri::AppHandle) -> Result<(), String> {
    {
        let _guard = lock();
        let path = get_config_file_path();
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    let _ = app.emit(
        "app-config-update",
        serde_json::json!({
            "patch": {},
            "source": "tauri"
        }),
    );
    Ok(())
}
