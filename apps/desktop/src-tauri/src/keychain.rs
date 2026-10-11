//! DeepSeek API Key 的存取。macOS 上存在系统钥匙串里；其他平台只在内存里（仅供开发与 CI）。

use keyring_core::{Entry, Error as KeyringError};

use crate::ai_proxy::{AiError, AiErrorKind};

const SERVICE: &str = "com.zenith.ztodo";
const ACCOUNT: &str = "deepseek-api-key";

/// 启动时调用一次，设置默认的凭据存储。
pub fn init() {
    #[cfg(target_os = "macos")]
    match apple_native_keyring_store::keychain::Store::new() {
        Ok(store) => keyring_core::set_default_store(store),
        Err(e) => log::error!("无法打开系统钥匙串：{e}"),
    }

    #[cfg(not(target_os = "macos"))]
    match keyring_core::mock::Store::new() {
        Ok(store) => {
            keyring_core::set_default_store(store);
            log::warn!("非 macOS 平台：API Key 只保存在内存里，退出即丢失");
        }
        Err(e) => log::error!("无法创建内存凭据存储：{e}"),
    }
}

fn keychain_error(e: KeyringError) -> AiError {
    AiError::new(AiErrorKind::Keychain, format!("钥匙串访问失败：{e}"))
}

fn entry() -> Result<Entry, AiError> {
    Entry::new(SERVICE, ACCOUNT).map_err(keychain_error)
}

pub fn get() -> Result<Option<String>, AiError> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(keychain_error(e)),
    }
}

pub fn set(key: &str) -> Result<(), AiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AiError::new(AiErrorKind::Keychain, "API Key 不能为空"));
    }
    entry()?.set_password(key).map_err(keychain_error)
}

pub fn delete() -> Result<(), AiError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(keychain_error(e)),
    }
}
