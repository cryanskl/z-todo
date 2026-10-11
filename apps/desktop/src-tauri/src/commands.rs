//! WebView 可以调用的命令。参数与返回值的形状与 `src/host/types.ts` 一一对应。

use serde::Serialize;
use serde_json::Value as Json;
use tauri::State;

use crate::ai_proxy::{self, AiCall, AiError, AiResponse};
use crate::keychain;
use crate::AppState;
use zt_db::{DbError, DbErrorKind, QueryResult, TxPlan, TxResult};

fn join_error(e: impl std::fmt::Display) -> DbError {
    DbError::new(DbErrorKind::Io, format!("数据库线程异常：{e}"))
}

fn database(
    state: &AppState,
) -> Result<std::sync::Arc<std::sync::Mutex<zt_db::Connection>>, DbError> {
    state.db.clone().ok_or_else(|| {
        DbError::new(
            DbErrorKind::Io,
            state
                .startup_error
                .clone()
                .unwrap_or_else(|| "数据库没有打开".into()),
        )
    })
}

/// 只读查询。写语句返回 `not_readonly`。
#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    sql: String,
    params: Option<Vec<Json>>,
) -> Result<QueryResult, DbError> {
    let db = database(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(join_error)?;
        zt_db::query(&conn, &sql, &params.unwrap_or_default())
    })
    .await
    .map_err(join_error)?
}

/// 一组写语句，在一个事务里原子执行。
#[tauri::command]
pub async fn db_tx(state: State<'_, AppState>, plan: TxPlan) -> Result<TxResult, DbError> {
    let db = database(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock().map_err(join_error)?;
        zt_db::tx(&mut conn, &plan)
    })
    .await
    .map_err(join_error)?
}

/// 转发一次 DeepSeek 请求。密钥由这里从钥匙串取出并注入，WebView 永远拿不到。
#[tauri::command]
pub async fn ai_call(state: State<'_, AppState>, req: AiCall) -> Result<AiResponse, AiError> {
    ai_proxy::call(&state.http, req).await
}

#[tauri::command]
pub async fn has_api_key() -> Result<bool, AiError> {
    Ok(keychain::get()?.is_some())
}

#[tauri::command]
pub async fn set_api_key(key: String) -> Result<(), AiError> {
    keychain::set(&key)
}

#[tauri::command]
pub async fn delete_api_key() -> Result<(), AiError> {
    keychain::delete()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    db_path: String,
    schema_from: i64,
    schema_to: i64,
    migration_backup: Option<String>,
    startup_error: Option<String>,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.display().to_string(),
        db_path: state.db_path.display().to_string(),
        schema_from: state.migrate.as_ref().map_or(0, |m| m.from_version),
        schema_to: state.migrate.as_ref().map_or(0, |m| m.to_version),
        migration_backup: state
            .migrate
            .as_ref()
            .and_then(|m| m.backup.as_ref())
            .map(|p| p.display().to_string()),
        startup_error: state.startup_error.clone(),
    }
}
