// 本地音乐：目录递归扫描 + 音频标签解析（lofty）。
//
// - local_scan_dir：递归发现音频文件（不跟随符号链接，天然防循环），返回 path/size/mtime(ms)
// - local_parse_meta：解析标题/歌手/专辑/时长（不做 CJK 编码修正与封面读取）
// - local_export_cover：按需把内嵌封面导出为缓存文件，返回本地路径（前端转 asset URL）
// - local_read_lyric：按需读取内嵌歌词文本
//
// 封面/歌词不随扫描入库：扫描时逐首解析会让 200+ 首的目录多出十几 MB 封面数据，
// 而曲库 JSON 与 localStorage 都承受不住；改为播放时按需读取。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileInfo {
    pub path: String,
    pub size: u64,
    /// 文件修改时间（毫秒时间戳）
    pub mtime: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetaResult {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 时长（秒）
    pub duration: Option<f64>,
}

#[tauri::command]
pub fn local_scan_dir(
    folder_path: String,
    excluded_paths: Option<Vec<String>>,
    extensions: Option<Vec<String>>,
) -> Result<Vec<LocalFileInfo>, String> {
    let excluded: Vec<String> = excluded_paths
        .unwrap_or_default()
        .iter()
        .map(|p| normalize_lower(p))
        .filter(|p| !p.is_empty())
        .collect();
    let exts: Vec<String> = extensions
        .unwrap_or_default()
        .iter()
        .map(|e| e.to_lowercase())
        .collect();

    let mut out = Vec::new();
    walk_dir(Path::new(&folder_path), &excluded, &exts, &mut out, 0);
    Ok(out)
}

fn normalize_lower(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn is_excluded(normalized_path: &str, excluded: &[String]) -> bool {
    excluded
        .iter()
        .any(|ep| normalized_path == ep || normalized_path.starts_with(&format!("{ep}/")))
}

fn walk_dir(
    dir: &Path,
    excluded: &[String],
    exts: &[String],
    out: &mut Vec<LocalFileInfo>,
    depth: u32,
) {
    if depth > 16 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let normalized = normalize_lower(&path.to_string_lossy());
        if is_excluded(&normalized, excluded) {
            continue;
        }

        // DirEntry::metadata 不跟随符号链接，天然避免循环
        let Ok(meta) = entry.metadata() else {
            continue;
        };

        if meta.is_dir() {
            walk_dir(&path, excluded, exts, out, depth + 1);
        } else if meta.is_file() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let Some(dot) = name.rfind('.') else {
                continue;
            };
            let ext = &name[dot..];
            if !exts.iter().any(|e| e == ext) {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(LocalFileInfo {
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                mtime,
            });
        }
    }
}

#[tauri::command]
pub async fn local_parse_meta(file_path: String) -> Result<AudioMetaResult, String> {
    // lofty 解析是同步 CPU/IO 操作，放到阻塞线程池执行
    tauri::async_runtime::spawn_blocking(move || parse_meta_inner(&file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_meta_inner(file_path: &str) -> Result<AudioMetaResult, String> {
    let tagged = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let duration = {
        let millis = tagged.properties().duration().as_millis();
        if millis == 0 {
            None
        } else {
            Some(millis as f64 / 1000.0)
        }
    };

    let mut result = AudioMetaResult {
        duration,
        ..Default::default()
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        result.title = tag
            .title()
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());
        result.artist = tag
            .artist()
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());
        result.album = tag
            .album()
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());
    }

    Ok(result)
}

// ─── 按需读取封面 / 歌词 ───

#[tauri::command]
pub async fn local_export_cover(file_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || export_cover_inner(&file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// 把内嵌封面写成缓存文件并返回其路径。
///
/// 返回本地路径而非 data URI：当前歌曲对象会整体写入 localStorage，
/// 内嵌封面中位数约 50KB、最大可到 900KB（base64 后 ×1.33），
/// 直接用 data URI 会撑爆 5MB 配额并连带破坏播放进度等持久化数据。
fn export_cover_inner(file_path: &str) -> Result<Option<String>, String> {
    // 缓存文件名已含「路径 + mtime + size」哈希，命中即说明是同一版本，无需再解析标签
    let cache_stem = cover_cache_stem(file_path);
    if let Some(cached) = find_cached_cover(&cache_stem) {
        return Ok(Some(cached));
    }

    let tagged = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };

    // 优先正面封面，没有就退回标签里的第一张图
    let picture = tag
        .get_picture_type(PictureType::CoverFront)
        .or_else(|| tag.pictures().first());
    let Some(picture) = picture else {
        return Ok(None);
    };

    let data = picture.data();
    if data.is_empty() {
        return Ok(None);
    }

    // 扩展名必须与实际图片格式一致：asset 协议按扩展名决定 Content-Type，
    // 大量内嵌封面的 MIME 字段为空（MimeType::Unknown），只能靠魔数嗅探兜底。
    let ext = picture
        .mime_type()
        .and_then(|m| m.ext())
        .unwrap_or_else(|| sniff_image_ext(data));
    let cache_file = cover_cache_dir().join(format!("{cache_stem}.{ext}"));

    if let Some(dir) = cache_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&cache_file, data).map_err(|e| e.to_string())?;

    // 同一首歌换了标签后会生成新缓存，清掉同名旧文件（扩展名可能变化）避免堆积
    let sibling_prefix = format!("{cache_stem}.");
    if let Some(dir) = cache_file.parent() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&sibling_prefix) && path.as_path() != cache_file.as_path() {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    Ok(Some(cache_file.to_string_lossy().to_string()))
}

/// 封面缓存目录（Windows 下为 %LOCALAPPDATA%\AnhePlayer\covers）
fn cover_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AnhePlayer")
        .join("covers")
}

/// 在缓存目录中查找已导出的封面，命中则直接复用。
/// 只用前缀会把「同名不同哈希」以外的文件也捞进来，这里要求文件名是
/// `<cache_stem>.<ext>` 的完整形态，扩展名为 2~5 位字母。
fn find_cached_cover(cache_stem: &str) -> Option<String> {
    let dir = cover_cache_dir();
    let entries = fs::read_dir(&dir).ok()?;
    let prefix = format!("{cache_stem}.");
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(ext) = name.strip_prefix(&prefix) else {
            continue;
        };
        if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// 封面缓存文件名（不含扩展名）：按「音频路径 + 修改时间 + 大小」哈希，文件换标签后自动失效
fn cover_cache_stem(file_path: &str) -> String {
    let path = Path::new(file_path);
    let stamp = fs::metadata(path)
        .ok()
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}-{}", mtime, m.len())
        })
        .unwrap_or_else(|| "0-0".to_string());

    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let key = format!("{file_path}|{stamp}");
    let (h1, h2) = fnv1a_pair(&key);

    format!("{h1:08x}{h2:08x}-{}", sanitize_file_stem(&stem))
}

/// 与前端 hashPath 同款的 FNV-1a 双通道，纯本地用途无需密码学强度
fn fnv1a_pair(input: &str) -> (u32, u32) {
    let mut h1: u32 = 0x811c_9dc5;
    let mut h2: u32 = 0x2166_136b;
    for byte in input.as_bytes() {
        h1 = (h1 ^ *byte as u32).wrapping_mul(0x0100_0193);
        h2 = (h2 ^ *byte as u32).wrapping_mul(0x85eb_ca6b);
    }
    (h1, h2)
}

/// 文件名只保留 Windows 合法字符，中文等其它字符按原样保留以提高可读性
fn sanitize_file_stem(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    if out.chars().count() > 48 {
        out = out.chars().take(48).collect();
    }
    if out.trim_matches('_').is_empty() {
        out.push_str("cover");
    }
    out
}

/// 标签里的 MIME 缺失或不可用时，按魔数嗅探扩展名
fn sniff_image_ext(data: &[u8]) -> &'static str {
    if data.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if data.starts_with(b"GIF8") {
        "gif"
    } else if data.starts_with(b"BM") {
        "bmp"
    } else {
        "jpg"
    }
}

#[tauri::command]
pub async fn local_read_lyric(file_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_lyric_inner(&file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// 读取内嵌歌词：ID3v2 → USLT、MP4 → ©lyr、Vorbis → UNSYNCEDLYRICS。
/// MP4 的 ©lyr 会同时映射到 Lyrics 与 UnsyncLyrics，按顺序取第一个非空文本。
fn read_lyric_inner(file_path: &str) -> Result<Option<String>, String> {
    let tagged = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };

    let text = tag
        .get_string(ItemKey::UnsyncLyrics)
        .or_else(|| tag.get_string(ItemKey::Lyrics))
        .map(|s| s.to_string());

    Ok(text.filter(|s| !s.trim().is_empty()))
}
