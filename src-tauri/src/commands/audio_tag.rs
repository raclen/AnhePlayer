// 音频标签写入：下载完成后嵌入封面与歌词（lofty 多格式尽力而为）。
//
// - write_audio_meta：封面 URL 由 Rust 侧直接下载（http_request 通道只支持文本，二进制走不了）；
//   歌词与封面按文件主标签格式写入：
//      mp3 → ID3v2（USLT 歌词帧 + APIC 封面帧）
//      m4a → MP4 ilst（©lyr 歌词 + covr 封面）
//      flac/ogg/opus → VorbisComments（UNSYNCEDLYRICS / METADATA_BLOCK_PICTURE）
// - 无主标签时按文件格式新建标签容器；任一环节失败只返回 Err，由前端告警，不影响已完成的下载。

use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};

use super::network;

#[tauri::command]
pub async fn write_audio_meta(
    file_path: String,
    cover_url: Option<String>,
    lyrics: Option<String>,
) -> Result<(), String> {
    let lyrics = lyrics.filter(|t| !t.trim().is_empty());

    // 封面在异步阶段下载；失败仅意味着这次只写歌词
    let cover = match cover_url.filter(|u| u.starts_with("http")) {
        Some(url) => download_cover(&url).await.ok(),
        None => None,
    };

    if cover.is_none() && lyrics.is_none() {
        return Ok(());
    }

    // lofty 读写是同步 IO，放到阻塞线程池执行
    tauri::async_runtime::spawn_blocking(move || write_tags(&file_path, cover, lyrics))
        .await
        .map_err(|e| e.to_string())?
}

async fn download_cover(url: &str) -> Result<(Vec<u8>, MimeType), String> {
    let settings = network::read_settings();
    let client = network::apply(
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(15)),
        &settings,
    )
    .build()
    .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() {
        return Err("封面内容为空".to_string());
    }
    let mime = guess_mime(&content_type, url, &bytes);
    Ok((bytes, mime))
}

/// 推断封面 MIME：优先 Content-Type，其次魔数嗅探，最后按 URL 后缀兜底为 JPEG
fn guess_mime(content_type: &str, url: &str, bytes: &[u8]) -> MimeType {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if ct.starts_with("image/") {
        return MimeType::from_str(&ct);
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return MimeType::Jpeg;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return MimeType::Png;
    }
    let path_part = url.split('?').next().unwrap_or("").to_lowercase();
    if path_part.ends_with(".png") {
        return MimeType::Png;
    }
    MimeType::Jpeg
}

fn write_tags(
    file_path: &str,
    cover: Option<(Vec<u8>, MimeType)>,
    lyrics: Option<String>,
) -> Result<(), String> {
    let mut tagged = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    // 无主标签时按文件格式新建（mp3 → ID3v2，m4a → MP4 ilst，flac/ogg → VorbisComments）
    if tagged.primary_tag().is_none() {
        let tag_type = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }

    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| "无法创建标签容器".to_string())?;

    if let Some(text) = lyrics {
        // UnsyncLyrics：ID3v2 → USLT 帧，MP4 → ©lyr，Vorbis → UNSYNCEDLYRICS
        tag.insert_text(ItemKey::UnsyncLyrics, text);
    }

    if let Some((data, mime)) = cover {
        // 先清掉同类旧封面再写入，避免重复图
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(
            Picture::unchecked(data)
                .pic_type(PictureType::CoverFront)
                .mime_type(mime)
                .description("Cover")
                .build(),
        );
    }

    tagged
        .save_to_path(file_path, WriteOptions::default())
        .map_err(|e| e.to_string())
}
