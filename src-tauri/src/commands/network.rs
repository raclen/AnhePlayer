//! 应用内网络策略：读取 appConfig 的 `network.proxy.*`，统一应用到原生 HTTP 客户端与 WebView2。
//!
//! - 默认直连：显式 `no_proxy()`，同时屏蔽系统代理与代理环境变量。
//! - 手动代理：原生客户端注入显式 HTTP 代理，WebView2 通过启动参数注入同一代理。
//! - 局域网（RFC1918）与回环地址始终直连，避免 WebDAV、插件音源被代理拦截。
//! - WebView2 的代理参数只在进程启动时读取，修改配置后需重启应用。

use tauri_plugin_updater::UpdaterBuilder;

use super::app_config;

/// 原生客户端始终直连的地址段（reqwest NoProxy 语法）
const NATIVE_BYPASS: &str = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

/// WebView2 始终直连的地址段（Chromium proxy-bypass-list 语法）
const WEBVIEW_BYPASS: &str = "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

/// 仅支持 HTTP 代理（含 HTTPS 站点经 CONNECT 隧道）
const PROXY_SCHEME: &str = "http";

#[derive(Debug, Clone)]
pub struct ProxySettings {
    pub enabled: bool,
    pub host: String,
    pub port: String,
    pub username: String,
    pub password: String,
}

impl ProxySettings {
    /// 解析实际使用的主机与端口；兼容用户直接粘贴 `http://host:port` 的情况
    fn endpoint(&self) -> Option<(String, u16)> {
        let raw = self.host.trim().trim_end_matches('/');
        let raw = raw
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(raw)
            .trim_end_matches('/');
        // 主机字段里带了端口时优先使用，端口字段有效时以字段为准；
        // IPv6 字面量含多个冒号，不能按「最后一个冒号后是端口」解析
        let (host, embedded) = match raw.rsplit_once(':') {
            Some((host, port)) if raw.matches(':').count() == 1 => (host, port.parse::<u16>().ok()),
            _ => (raw, None),
        };
        let port = self.port.trim().parse::<u16>().ok().or(embedded)?;
        if host.is_empty() || port == 0 {
            return None;
        }
        Some((host.to_string(), port))
    }

    /// 代理是否可用；关闭、主机为空或端口无效时按直连处理
    pub fn is_active(&self) -> bool {
        self.enabled && self.endpoint().is_some()
    }

    /// WebView2 启动参数；未启用代理或地址不完整时返回 None（走直连）
    pub fn webview_arguments(&self) -> Option<String> {
        if !self.is_active() {
            return None;
        }
        let (host, port) = self.endpoint()?;
        Some(format!(
            "--proxy-server={PROXY_SCHEME}://{host}:{port} --proxy-bypass-list={WEBVIEW_BYPASS}"
        ))
    }

    fn proxy_url(&self) -> Option<String> {
        let (host, port) = self.endpoint()?;
        Some(format!("{PROXY_SCHEME}://{host}:{port}"))
    }
}

/// 读取配置里的代理设置；缺失时等同于直连
pub fn read_settings() -> ProxySettings {
    let config = app_config::read_config_value();
    let text = |key: &str| match config.get(key) {
        Some(serde_json::Value::String(value)) => value.clone(),
        Some(serde_json::Value::Number(value)) => value.to_string(),
        _ => String::new(),
    };
    ProxySettings {
        enabled: config
            .get("network.proxy.enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        host: text("network.proxy.host"),
        port: text("network.proxy.port"),
        username: text("network.proxy.username"),
        password: text("network.proxy.password"),
    }
}

fn bypass() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string(NATIVE_BYPASS)
}

fn build_proxy(settings: &ProxySettings) -> Option<reqwest::Proxy> {
    if !settings.is_active() {
        return None;
    }
    let url = settings.proxy_url()?;
    let mut proxy = match reqwest::Proxy::all(url) {
        Ok(proxy) => proxy,
        Err(error) => {
            log::warn!("[network] 代理地址无效，按直连处理: {error}");
            return None;
        }
    };
    if !settings.username.is_empty() {
        proxy = proxy.basic_auth(&settings.username, &settings.password);
    }
    Some(proxy.no_proxy(bypass()))
}

/// 为异步客户端注入网络策略：配置代理时使用显式代理，否则强制直连
pub fn apply(builder: reqwest::ClientBuilder, settings: &ProxySettings) -> reqwest::ClientBuilder {
    match build_proxy(settings) {
        Some(proxy) => builder.proxy(proxy),
        None => builder.no_proxy(),
    }
}

/// 为阻塞客户端注入网络策略，语义与 [`apply`] 一致
pub fn apply_blocking(
    builder: reqwest::blocking::ClientBuilder,
    settings: &ProxySettings,
) -> reqwest::blocking::ClientBuilder {
    match build_proxy(settings) {
        Some(proxy) => builder.proxy(proxy),
        None => builder.no_proxy(),
    }
}

/// 为更新器注入网络策略；更新器只接受 URL，因此认证信息编码进 URL
pub fn apply_updater(builder: UpdaterBuilder, settings: &ProxySettings) -> UpdaterBuilder {
    if let Some(url) = updater_proxy_url(settings) {
        return builder.proxy(url);
    }
    builder.no_proxy()
}

fn updater_proxy_url(settings: &ProxySettings) -> Option<tauri::Url> {
    if !settings.is_active() {
        return None;
    }
    let raw = settings.proxy_url()?;
    let mut url = match tauri::Url::parse(&raw) {
        Ok(url) => url,
        Err(error) => {
            log::warn!("[network] 更新器代理地址无效，按直连处理: {error}");
            return None;
        }
    };
    if !settings.username.is_empty() {
        let _ = url.set_username(&settings.username);
        if !settings.password.is_empty() {
            let _ = url.set_password(Some(&settings.password));
        }
    }
    Some(url)
}
