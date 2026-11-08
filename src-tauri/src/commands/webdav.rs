// WebDAV 备份通道：测试连通性 / 上传 / 下载。
//
// 与 WebDAV 前端调用契约保持一致：
// - test：PROPFIND Depth:0（207/200/204 视为可达）
// - put：先 MKCOL 确保目录（405 已存在忽略），再 PUT JSON
// - get：GET 文本；404 返回 Ok(None)（对应"备份文件不存在"）

use std::time::Duration;

use super::network;

/// 按当前配置构建客户端；构建失败时退回直连，避免备份通道被代理配置拖垮
fn client() -> reqwest::Client {
    let settings = network::read_settings();
    network::apply(
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(15)),
        &settings,
    )
    .build()
    .unwrap_or_else(|_| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("构建直连 HTTP 客户端失败")
    })
}

fn join_url(base: &str, rel_path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        rel_path.trim_start_matches('/')
    )
}

fn method_from(name: &[u8]) -> Result<reqwest::Method, String> {
    reqwest::Method::from_bytes(name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webdav_test(url: String, username: String, password: String) -> Result<bool, String> {
    let response = client()
        .request(method_from(b"PROPFIND")?, &url)
        .basic_auth(&username, Some(&password))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let code = response.status().as_u16();
    Ok(code == 207 || code == 200 || code == 204)
}

#[tauri::command]
pub async fn webdav_put(
    url: String,
    username: String,
    password: String,
    path: String,
    content: String,
) -> Result<bool, String> {
    let base = url.trim_end_matches('/');
    let client = client();

    // 确保父目录存在（失败忽略：已存在时服务器返回 405）
    if let Some((dir, _)) = path.trim_start_matches('/').rsplit_once('/') {
        if !dir.is_empty() {
            let _ = client
                .request(method_from(b"MKCOL")?, join_url(base, dir))
                .basic_auth(&username, Some(&password))
                .send()
                .await;
        }
    }

    let response = client
        .put(join_url(base, &path))
        .basic_auth(&username, Some(&password))
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .body(content)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let code = response.status().as_u16();
    if (200..300).contains(&code) {
        Ok(true)
    } else {
        Err(format!("WebDAV PUT failed: HTTP {}", code))
    }
}

/// 下载备份文件；文件不存在（404）返回 Ok(None)
#[tauri::command]
pub async fn webdav_get(
    url: String,
    username: String,
    password: String,
    path: String,
) -> Result<Option<String>, String> {
    let response = client()
        .get(join_url(url.trim_end_matches('/'), &path))
        .basic_auth(&username, Some(&password))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let code = response.status().as_u16();
    if code == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&code) {
        return Err(format!("WebDAV GET failed: HTTP {}", code));
    }

    let text = response.text().await.map_err(|e| e.to_string())?;
    Ok(Some(text))
}
