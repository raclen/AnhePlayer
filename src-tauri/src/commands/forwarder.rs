// 本地请求转发代理，保持前端 requestForwarder 的 URL 契约。
//
// 契约：GET http://127.0.0.1:<port>/?url=<encoded>&headers=<JSON encoded>
//   - url 与 headers 均为 x-www-form-urlencoded 编码（URLSearchParams.toString()），
//     其中空格被编码为 '+'，需要先还原为空格再做 percent-decode。
//   - 支持透传 Range 请求头（206 分段响应），供音频元素 seek 使用。
// 安全：仅监听 127.0.0.1，不暴露公网。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::network;

/// 代理端口状态（0 表示未启动）
#[derive(Default)]
pub struct ForwarderPortState(pub AtomicU16);

#[tauri::command]
pub fn forwarder_get_port(state: tauri::State<'_, ForwarderPortState>) -> Option<u16> {
    let port = state.0.load(Ordering::Relaxed);
    if port == 0 {
        None
    } else {
        Some(port)
    }
}

/// 启动代理服务器（独立线程），端口写入 state 并广播 forwarder-port-changed。
pub fn init_forwarder(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(server) => server,
            Err(err) => {
                log::error!("[forwarder] failed to bind 127.0.0.1: {err}");
                return;
            }
        };

        let port = match server.server_addr().to_ip() {
            Some(addr) => addr.port(),
            None => return,
        };

        if let Some(state) = app.try_state::<ForwarderPortState>() {
            state.0.store(port, Ordering::Relaxed);
        }
        let _ = app.emit("forwarder-port-changed", port);
        log::info!("[forwarder] listening on 127.0.0.1:{port}");

        for request in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || {
                handle_request(request, app);
            });
        }
    });
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || ip
            .to_ipv4_mapped()
            .is_some_and(|mapped| !is_public_ipv4(mapped)))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn resolve_public_target(url: &reqwest::Url) -> Option<(String, Option<SocketAddr>)> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".localdomain")
    {
        return None;
    }
    let port = url.port_or_known_default().unwrap_or(80);
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return is_public_ip(ip).then_some((normalized, None));
    }

    let addresses: Vec<SocketAddr> = (normalized.as_str(), port)
        .to_socket_addrs()
        .ok()?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return None;
    }
    Some((normalized, addresses.into_iter().next()))
}

fn handle_request(request: tiny_http::Request, _app: AppHandle) {
    let raw_url = request.url().to_string();
    let query = raw_url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = parse_query(query);

    let Some(target_url) = params.get("url").cloned().filter(|u| !u.is_empty()) else {
        respond_plain(request, 400, "missing url parameter");
        return;
    };
    let public_only = params.get("publicOnly").is_some_and(|value| value == "1");
    let parsed_target = match reqwest::Url::parse(&target_url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => {
            respond_plain(request, 400, "target url must use HTTP(S)");
            return;
        }
    };
    let public_resolution = if public_only {
        match resolve_public_target(&parsed_target) {
            Some(resolution) => Some(resolution),
            None => {
                respond_plain(request, 403, "target url is not a public HTTP(S) address");
                return;
            }
        }
    } else {
        None
    };

    let extra_headers: HashMap<String, String> = params
        .get("headers")
        .and_then(|h| serde_json::from_str(h).ok())
        .unwrap_or_default();

    let settings = network::read_settings();
    let mut client_builder = network::apply_blocking(
        reqwest::blocking::Client::builder()
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(15)),
        &settings,
    );
    if let Some((host, resolved_address)) = &public_resolution {
        client_builder = client_builder.redirect(reqwest::redirect::Policy::none());
        if let Some(address) = resolved_address {
            // 将校验过的 DNS 结果固定到实际连接，阻止校验后 DNS rebinding。
            client_builder = client_builder.resolve(host, *address);
        }
    } else {
        // 插件音源保留原有局域网与有限重定向能力。
        client_builder = client_builder.redirect(reqwest::redirect::Policy::limited(10));
    }
    let client = match client_builder.build() {
        Ok(client) => client,
        Err(err) => {
            respond_plain(request, 500, &format!("client build failed: {err}"));
            return;
        }
    };

    let mut upstream = client.get(parsed_target);
    for (key, value) in &extra_headers {
        if is_forbidden_header(key) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(key.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            upstream = upstream.header(name, val);
        }
    }
    // 透传客户端 Range（音频 seek）
    if let Some(range) = request.headers().iter().find(|h| h.field.equiv("Range")) {
        upstream = upstream.header("Range", range.value.as_str());
    }

    let response = match upstream.send() {
        Ok(response) => response,
        Err(err) => {
            respond_plain(request, 502, &format!("upstream failed: {err}"));
            return;
        }
    };

    let status = response.status().as_u16();
    let content_length = response.content_length();

    // 仅转发客户端播放器关心的响应头
    let forwardable = [
        "content-type",
        "content-range",
        "accept-ranges",
        "last-modified",
        "etag",
        "cache-control",
        "expires",
    ];
    let mut out_headers = Vec::new();
    // 允许页面侧 fetch/XHR（如 hls.js）跨源读取代理响应
    if let Ok(acao) = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..])
    {
        out_headers.push(acao);
    }
    for (name, value) in response.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if forwardable.contains(&lower.as_str()) {
            if let Ok(header) =
                tiny_http::Header::from_bytes(name.as_str().as_bytes(), value.as_bytes())
            {
                out_headers.push(header);
            }
        }
    }

    // reqwest blocking Response 实现 Read，作为数据源流式转发
    let tiny_response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        out_headers,
        response,
        content_length.map(|len| len as usize),
        None,
    );
    let _ = request.respond(tiny_response);
}

/// 发送纯文本响应（Request::respond 按值消费，故这里取所有权）
fn respond_plain(request: tiny_http::Request, status: u16, message: &str) {
    let mut response =
        tiny_http::Response::from_string(message).with_status_code(tiny_http::StatusCode(status));
    // 错误响应同样允许跨源读取，便于页面侧 fetch 拿到状态码
    if let Ok(acao) = tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..])
    {
        response = response.with_header(acao);
    }
    let _ = request.respond(response);
}

/// 这些头由底层 HTTP 栈管理，透传会破坏请求
fn is_forbidden_header(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding" | "range"
    )
}

/// 解析 x-www-form-urlencoded query（'+' 视为空格）
fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        map.insert(percent_decode(key), percent_decode(value));
    }
    map
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
