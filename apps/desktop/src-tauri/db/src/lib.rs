//! z-todo 数据层。
//!
//! 对上只暴露两个操作，与 TypeScript 侧的 `HostPort` 一一对应：
//! - [`query`]：只读查询，写语句会被拒绝；
//! - [`tx`]：一组语句在一个事务里执行，任何一条出错或影响行数不符合 `expectChanges`，整个事务回滚。
//!
//! 业务规则不在这里。这里只保证：连接参数正确、迁移有序且失败可回滚、写入是原子的。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, ErrorCode, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value as Json};

pub use rusqlite::Connection;

/// 写入数据库文件头的应用标识（ASCII "ztod"），恢复备份时用来确认文件是 z-todo 的库。
pub const APPLICATION_ID: i64 = 0x7A74_6F64;

/// 一次迁移。版本号严格递增，从 1 开始。
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// 编译进二进制的全部迁移。TypeScript 测试宿主读取同一批 SQL 文件。
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "0001_init",
    sql: include_str!("../migrations/0001_init.sql"),
}];

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbErrorKind {
    /// 版本断言失败：某条语句的影响行数与 `expectChanges` 不符，数据已被别处修改。
    Conflict,
    /// 违反 CHECK、UNIQUE、NOT NULL、外键等约束。
    Constraint,
    /// 通过只读查询接口提交了写语句。
    NotReadonly,
    /// 语法错误、参数错误等。
    Sql,
    /// 文件、备份、迁移层面的问题。
    Io,
}

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{kind:?}: {message}")]
pub struct DbError {
    pub kind: DbErrorKind,
    pub message: String,
    /// 出错语句在事务计划里的下标（从 0 开始）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_index: Option<usize>,
}

impl DbError {
    pub fn new(kind: DbErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            statement_index: None,
        }
    }

    fn at(mut self, index: usize) -> Self {
        self.statement_index = Some(index);
        self
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        let kind = match &e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ConstraintViolation => {
                DbErrorKind::Constraint
            }
            _ => DbErrorKind::Sql,
        };
        DbError::new(kind, e.to_string())
    }
}

impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::new(DbErrorKind::Io, e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, DbError>;

// ---------------------------------------------------------------------------
// 请求与结果的 JSON 形状（与 TypeScript 的 HostPort 类型一致）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Json>,
    /// 期望的影响行数；不一致时整个事务回滚并返回 `conflict`。
    #[serde(default)]
    pub expect_changes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TxPlan {
    pub statements: Vec<Stmt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TxResult {
    pub changes: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Json>>,
}

fn to_sql_value(v: &Json) -> Result<SqlValue> {
    Ok(match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(DbError::new(
                    DbErrorKind::Sql,
                    format!("无法表示的数字参数：{n}"),
                ));
            }
        }
        Json::String(s) => SqlValue::Text(s.clone()),
        Json::Array(_) | Json::Object(_) => {
            return Err(DbError::new(
                DbErrorKind::Sql,
                "参数只能是 null、布尔、数字或字符串；JSON 字段请先序列化为字符串",
            ))
        }
    })
}

fn to_params(params: &[Json]) -> Result<Vec<SqlValue>> {
    params.iter().map(to_sql_value).collect()
}

fn to_json(v: ValueRef<'_>) -> Result<Json> {
    Ok(match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => {
            return Err(DbError::new(
                DbErrorKind::Sql,
                "查询结果含 BLOB，z-todo 不使用 BLOB 列",
            ))
        }
    })
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

/// 连接参数：WAL、外键、同步级别、忙等待。
pub fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // journal_mode 会返回一行结果，用 query_row 读掉。内存库会返回 "memory"。
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    Ok(())
}

/// 打开（必要时创建）数据库文件并迁移到最新版本。
/// 已有数据的库在迁移前会先备份到 `backup_dir`。
pub fn open(path: &Path, backup_dir: Option<&Path>) -> Result<(Connection, MigrateReport)> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    let report = migrate(&mut conn, MIGRATIONS, backup_dir)?;
    Ok((conn, report))
}

/// 迁移好的内存库，用于测试。
pub fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn, MIGRATIONS, None)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub from_version: i64,
    pub to_version: i64,
    pub backup: Option<PathBuf>,
}

/// 按版本号顺序执行未执行过的迁移。
///
/// - 所有待执行脚本在同一个事务里，结束后做外键检查，任何失败都整体回滚；
/// - 已有数据（版本号大于 0）时，先用 `VACUUM INTO` 备份到 `backup_dir`；
/// - 库的版本号高于程序支持的版本、或应用标识不是 z-todo 时拒绝打开。
pub fn migrate(
    conn: &mut Connection,
    migrations: &[Migration],
    backup_dir: Option<&Path>,
) -> Result<MigrateReport> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let app_id: i64 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    if app_id != 0 && app_id != APPLICATION_ID {
        return Err(DbError::new(
            DbErrorKind::Io,
            "这个文件不是 z-todo 的数据库（应用标识不符）",
        ));
    }
    let latest = migrations.last().map_or(0, |m| m.version);
    if current > latest {
        return Err(DbError::new(
            DbErrorKind::Io,
            format!("数据库版本 {current} 高于本程序支持的 {latest}，请升级 z-todo"),
        ));
    }

    let pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > current).collect();
    if pending.is_empty() {
        return Ok(MigrateReport {
            from_version: current,
            to_version: current,
            backup: None,
        });
    }

    let backup = match (current > 0, backup_dir) {
        (true, Some(dir)) => Some(backup(conn, dir, BackupKind::PreMigration)?.path),
        _ => None,
    };

    // SQLite 官方的表重建流程（建新表、拷数据、删旧表、改名）要求在事务外关闭外键：
    // 事务里的 PRAGMA foreign_keys 是空操作，开着外键时 DROP TABLE 会级联删除子表的数据。
    // 外键完整性改为在提交前用 foreign_key_check 显式检查。
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = apply_pending(conn, &pending);
    let restored = conn.pragma_update(None, "foreign_keys", "ON");
    result?;
    restored?;

    Ok(MigrateReport {
        from_version: current,
        to_version: latest,
        backup,
    })
}

fn apply_pending(conn: &mut Connection, pending: &[&Migration]) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Exclusive)?;
    for m in pending {
        tx.execute_batch(m.sql).map_err(|e| {
            let e = DbError::from(e);
            DbError::new(
                DbErrorKind::Io,
                format!("迁移 {} 失败：{}", m.name, e.message),
            )
        })?;
        tx.pragma_update(None, "user_version", m.version)?;
    }
    tx.pragma_update(None, "application_id", APPLICATION_ID)?;
    let violations: i64 =
        tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations > 0 {
        return Err(DbError::new(
            DbErrorKind::Io,
            format!("迁移后外键检查发现 {violations} 处问题，已回滚"),
        ));
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    Daily,
    Manual,
    PreDelete,
    PreMigration,
    PreRestore,
}

impl BackupKind {
    fn as_str(self) -> &'static str {
        match self {
            BackupKind::Daily => "daily",
            BackupKind::Manual => "manual",
            BackupKind::PreDelete => "pre_delete",
            BackupKind::PreMigration => "pre_migration",
            BackupKind::PreRestore => "pre_restore",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: PathBuf,
    pub kind: BackupKind,
    pub size_bytes: u64,
}

/// 用 `VACUUM INTO` 生成一致的整库快照，并对快照做完整性检查。
/// 文件名：`ztodo-YYYYMMDD-HHmmss-<类型>.db`（本地时间），同一秒内重复时追加序号。
pub fn backup(conn: &Connection, dir: &Path, kind: BackupKind) -> Result<BackupInfo> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut path = dir.join(format!("ztodo-{stamp}-{}.db", kind.as_str()));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("ztodo-{stamp}-{}-{n}.db", kind.as_str()));
        n += 1;
    }
    let target = path
        .to_str()
        .ok_or_else(|| DbError::new(DbErrorKind::Io, "备份路径含无法表示的字符"))?;
    conn.execute("VACUUM INTO ?1", [target])?;

    let check = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = check.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err(DbError::new(
            DbErrorKind::Io,
            format!("备份完整性检查失败：{result}"),
        ));
    }
    let size_bytes = std::fs::metadata(&path)?.len();
    Ok(BackupInfo {
        path,
        kind,
        size_bytes,
    })
}

// ---------------------------------------------------------------------------
// 查询与事务
// ---------------------------------------------------------------------------

/// 去掉开头的空白和注释后的第一个关键字（大写）。
pub fn leading_keyword(sql: &str) -> String {
    let mut s = sql;
    loop {
        let t = s.trim_start();
        if let Some(rest) = t.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = t.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            s = t;
            break;
        }
    }
    s.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// 查询接口和事务计划都不允许的语句。必须在编译（prepare）之前检查：
/// 开关类 PRAGMA 在编译时就会生效，事务控制语句会打乱宿主自己管理的事务。
fn forbidden(sql: &str, in_tx: bool) -> Option<&'static str> {
    match leading_keyword(sql).as_str() {
        "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => {
            Some("事务由宿主管理，不能执行事务控制语句")
        }
        "ATTACH" | "DETACH" => Some("不能附加或分离数据库"),
        "VACUUM" | "REINDEX" | "ANALYZE" | "EXPLAIN" => Some("不支持这类维护或分析语句"),
        "PRAGMA" if in_tx => Some("事务计划里不能包含 PRAGMA"),
        "PRAGMA" if sql.contains('=') || sql.contains('(') => {
            Some("只能读取 PRAGMA，不能修改；表结构请用 SELECT ... FROM pragma_table_info(?)")
        }
        _ => None,
    }
}

/// 只读查询。写语句（INSERT、UPDATE、DELETE、建表、改设置的 PRAGMA 等）返回 `not_readonly`。
pub fn query(conn: &Connection, sql: &str, params: &[Json]) -> Result<QueryResult> {
    if let Some(reason) = forbidden(sql, false) {
        return Err(DbError::new(DbErrorKind::NotReadonly, reason));
    }
    let mut stmt = conn.prepare(sql)?;
    if !stmt.readonly() {
        return Err(DbError::new(
            DbErrorKind::NotReadonly,
            "查询接口只接受只读语句，写操作请放进事务",
        ));
    }
    let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let values = to_params(params)?;
    let mut rows = stmt.query(params_from_iter(values.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut r = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            r.push(to_json(row.get_ref(i)?)?);
        }
        out.push(r);
    }
    Ok(QueryResult { columns, rows: out })
}

/// 在一个事务里依次执行计划中的语句。
/// 任何一条出错，或影响行数与 `expectChanges` 不符，整个事务回滚，错误里带出语句下标。
pub fn tx(conn: &mut Connection, plan: &TxPlan) -> Result<TxResult> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut changes = Vec::with_capacity(plan.statements.len());
    for (i, s) in plan.statements.iter().enumerate() {
        if let Some(reason) = forbidden(&s.sql, true) {
            return Err(DbError::new(DbErrorKind::Sql, reason).at(i));
        }
        let values = to_params(&s.params).map_err(|e| e.at(i))?;
        let n = tx
            .execute(&s.sql, params_from_iter(values.iter()))
            .map_err(|e| DbError::from(e).at(i))? as u64;
        if tx.is_autocommit() {
            // 兜底：任何语句都不应该结束宿主的事务
            return Err(DbError::new(DbErrorKind::Sql, "语句意外结束了事务").at(i));
        }
        if let Some(expected) = s.expect_changes {
            if n != expected {
                // tx 被丢弃时自动回滚
                return Err(DbError::new(
                    DbErrorKind::Conflict,
                    format!("第 {i} 条语句影响了 {n} 行，期望 {expected} 行；数据可能已被修改"),
                )
                .at(i));
            }
        }
        changes.push(n);
    }
    tx.commit()?;
    Ok(TxResult { changes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pragma_reads_are_readonly_and_pragma_writes_are_not() {
        let conn = open_in_memory().unwrap();
        assert!(query(&conn, "PRAGMA user_version", &[]).is_ok());
        let err = query(&conn, "PRAGMA user_version = 5", &[]).unwrap_err();
        assert_eq!(err.kind, DbErrorKind::NotReadonly);
    }

    #[test]
    fn leading_keyword_skips_whitespace_and_comments() {
        assert_eq!(leading_keyword("  -- 注释\n /* 块 */ select 1"), "SELECT");
        assert_eq!(leading_keyword("\n\tPRAGMA x"), "PRAGMA");
        assert_eq!(leading_keyword("-- 只有注释"), "");
    }

    #[test]
    fn nested_json_params_are_rejected() {
        let conn = open_in_memory().unwrap();
        let err = query(&conn, "SELECT ?", &[serde_json::json!({"a": 1})]).unwrap_err();
        assert_eq!(err.kind, DbErrorKind::Sql);
    }

    #[test]
    fn error_serializes_in_camel_case_for_the_webview() {
        let e = DbError::new(DbErrorKind::NotReadonly, "x").at(2);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "not_readonly", "message": "x", "statementIndex": 2})
        );
    }
}
