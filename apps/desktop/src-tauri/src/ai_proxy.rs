//! DeepSeek 请求转发。
//!
//! 只允许访问固定的 DeepSeek 地址和少数几个路径；密钥在这里注入，不经过 WebView。
//! 非 2xx 的响应照常返回状态码和响应体，由 TypeScript 侧决定是否重试；
//! 只有网络层面的失败才返回错误。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::keychain;

const BASE: &str = "https://api.deepseek.com";
const BASE_BETA: &str = "https://api.deepseek.com/beta";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiMethod {
    Get,
    Post,
}

#[derive(Debug, Deserialize)]
pub enum AiPath {
    #[serde(rename = "chat/completions")]
    ChatCompletions,
    #[serde(rename = "models")]
    Models,
    #[serde(rename = "user/balance")]
    Balance,
}

impl AiPath {
    fn as_str(&self) -> &'static str {
        match self {
            AiPath::ChatCompletions => "chat/completions",
            AiPath::Models => "models",
            AiPath::Balance => "user/balance",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCall {
    pub method: AiMethod,
    pub path: AiPath,
    /// strict 工具调用需要走 Beta 地址。
    #[serde(default)]
    pub beta: bool,
    #[serde(default)]
    pub body: Option<Json>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub status: u16,
    pub body: Json,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorKind {
    NoKey,
    Keychain,
    Network,
    Timeout,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{kind:?}: {message}")]
pub struct AiError {
    pub kind: AiErrorKind,
    pub message: String,
}

impl AiError {
    pub fn new(kind: AiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("z-todo/", env!("CARGO_PKG_VERSION")))
        .build()
}

pub async fn call(http: &reqwest::Client, req: AiCall) -> Result<AiResponse, AiError> {
    let key = keychain::get()?
        .ok_or_else(|| AiError::new(AiErrorKind::NoKey, "还没有设置 DeepSeek API Key"))?;
    let base = if req.beta { BASE_BETA } else { BASE };
    let url = format!("{base}/{}", req.path.as_str());

    let builder = match req.method {
        AiMethod::Get => http.get(&url),
        AiMethod::Post => http
            .post(&url)
            .json(&req.body.unwrap_or(Json::Object(Default::default()))),
    };

    let started = Instant::now();
    let resp = builder.bearer_auth(key).send().await.map_err(|e| {
        let kind = if e.is_timeout() {
            AiErrorKind::Timeout
        } else {
            AiErrorKind::Network
        };
        AiError::new(kind, e.to_string())
    })?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| AiError::new(AiErrorKind::Network, e.to_string()))?;
    let body = serde_json::from_str(&text).unwrap_or(Json::String(text));

    Ok(AiResponse {
        status,
        body,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}
