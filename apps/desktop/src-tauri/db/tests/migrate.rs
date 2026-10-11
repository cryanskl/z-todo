//! 迁移、备份与文件级行为。只在 Rust 宿主上有意义，TypeScript 测试宿主不覆盖。

use rusqlite::Connection;
use zt_db::{
    backup, configure, migrate, open, BackupKind, DbErrorKind, Migration, APPLICATION_ID,
    MIGRATIONS,
};

const M2_OK: Migration = Migration {
    version: 2,
    name: "0002_test_ok",
    sql: "ALTER TABLE tag ADD COLUMN color TEXT;",
};

const M2_BAD: Migration = Migration {
    version: 2,
    name: "0002_test_bad",
    sql: "ALTER TABLE tag ADD COLUMN color TEXT; THIS IS NOT SQL;",
};

fn seed_one_task(conn: &Connection) {
    conn.execute(
        "INSERT INTO task (id, title, lifecycle, origin, created_at, updated_at) VALUES ('t1', '已有数据', 'inbox', 'manual', 0, 0)",
        [],
    )
    .unwrap();
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

/// SQLite 官方的表重建流程：建新表、拷数据、删旧表、改名。
const M2_REBUILD_TAG: Migration = Migration {
    version: 2,
    name: "0002_test_rebuild_tag",
    sql: "CREATE TABLE tag_new (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, color TEXT);
          INSERT INTO tag_new (id, name, created_at) SELECT id, name, created_at FROM tag;
          DROP TABLE tag;
          ALTER TABLE tag_new RENAME TO tag;",
};

#[test]
fn table_rebuild_migration_keeps_child_rows() {
    // 外键开着做重建时，DROP TABLE tag 会级联删掉 task_tag 的数据，而且外键检查也发现不了。
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    let (conn, _) = open(&path, None).unwrap();
    seed_one_task(&conn);
    conn.execute(
        "INSERT INTO tag (id, name, created_at) VALUES ('g1', '论文', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO task_tag (task_id, tag_id) VALUES ('t1', 'g1')",
        [],
    )
    .unwrap();
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    configure(&conn).unwrap();
    migrate(&mut conn, &[MIGRATIONS[0], M2_REBUILD_TAG], None).unwrap();

    let links: i64 = conn
        .query_row("SELECT count(*) FROM task_tag", [], |r| r.get(0))
        .unwrap();
    assert_eq!(links, 1, "重建父表不能删掉子表的数据");
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1, "迁移结束后外键检查必须重新打开");
    let err = conn
        .execute(
            "INSERT INTO task_tag (task_id, tag_id) VALUES ('t1', 'nope')",
            [],
        )
        .unwrap_err();
    assert!(
        err.to_string().contains("FOREIGN KEY"),
        "重建后的表仍受外键约束：{err}"
    );
}

#[test]
fn foreign_keys_are_back_on_after_a_failed_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    drop(open(&path, None).unwrap());
    let mut conn = Connection::open(&path).unwrap();
    configure(&conn).unwrap();
    assert!(migrate(&mut conn, &[MIGRATIONS[0], M2_BAD], None).is_err());
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn every_migration_file_is_registered_in_order() {
    // TypeScript 测试宿主自动读取目录里的全部 .sql；Rust 需要在 MIGRATIONS 里手动登记。
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter_map(|n| n.strip_suffix(".sql").map(str::to_owned))
        .collect();
    files.sort();
    let registered: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
    assert_eq!(
        files, registered,
        "migrations 目录与 zt_db::MIGRATIONS 不一致"
    );
    for (i, m) in MIGRATIONS.iter().enumerate() {
        assert_eq!(m.version, i as i64 + 1, "版本号必须从 1 开始连续递增");
        assert!(
            m.name.starts_with(&format!("{:04}_", m.version)),
            "文件名前缀必须是版本号：{}",
            m.name
        );
    }
}

#[test]
fn new_database_is_migrated_without_backup() {
    let dir = tempfile::tempdir().unwrap();
    let backups = dir.path().join("backups");
    let (conn, report) = open(&dir.path().join("ztodo.db"), Some(&backups)).unwrap();
    assert_eq!(report.from_version, 0);
    assert_eq!(report.to_version, MIGRATIONS.last().unwrap().version);
    assert!(report.backup.is_none(), "全新的库没有数据，不需要备份");
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn reopening_an_up_to_date_database_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    drop(open(&path, None).unwrap());
    let (_, report) = open(&path, Some(&dir.path().join("backups"))).unwrap();
    assert_eq!(report.from_version, report.to_version);
    assert!(report.backup.is_none());
}

#[test]
fn upgrade_backs_up_first_and_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    let backups = dir.path().join("backups");
    let (conn, _) = open(&path, None).unwrap();
    seed_one_task(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    configure(&conn).unwrap();
    let report = migrate(&mut conn, &[MIGRATIONS[0], M2_OK], Some(&backups)).unwrap();
    assert_eq!((report.from_version, report.to_version), (1, 2));
    assert_eq!(user_version(&conn), 2);

    let backup_path = report.backup.expect("升级已有数据的库前必须备份");
    let b = Connection::open(&backup_path).unwrap();
    assert_eq!(user_version(&b), 1, "备份是迁移前的状态");
    let n: i64 = b
        .query_row("SELECT count(*) FROM task", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn failed_migration_rolls_back_and_backup_remains() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    let backups = dir.path().join("backups");
    let (conn, _) = open(&path, None).unwrap();
    seed_one_task(&conn);
    drop(conn);

    let mut conn = Connection::open(&path).unwrap();
    configure(&conn).unwrap();
    let err = migrate(&mut conn, &[MIGRATIONS[0], M2_BAD], Some(&backups)).unwrap_err();
    assert_eq!(err.kind, DbErrorKind::Io);
    assert!(err.message.contains("0002_test_bad"));

    assert_eq!(user_version(&conn), 1, "失败的迁移整体回滚");
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('tag')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        !cols.contains(&"color".to_string()),
        "前半段成功的语句也被回滚"
    );
    let n: i64 = conn
        .query_row("SELECT count(*) FROM task", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "数据没有丢失");
    assert_eq!(
        std::fs::read_dir(&backups).unwrap().count(),
        1,
        "迁移前备份仍在"
    );
}

#[test]
fn newer_database_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ztodo.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    conn.pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    drop(conn);
    let err = open(&path, None).unwrap_err();
    assert_eq!(err.kind, DbErrorKind::Io);
    assert!(err.message.contains("99"));
}

#[test]
fn foreign_sqlite_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("other.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "application_id", 12345).unwrap();
    drop(conn);
    let err = open(&path, None).unwrap_err();
    assert!(err.message.contains("不是 z-todo"));
}

#[test]
fn backup_produces_a_checked_copy_with_unique_names() {
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) = open(&dir.path().join("ztodo.db"), None).unwrap();
    seed_one_task(&conn);
    let a = backup(&conn, &dir.path().join("b"), BackupKind::Manual).unwrap();
    let b = backup(&conn, &dir.path().join("b"), BackupKind::Manual).unwrap();
    assert_ne!(a.path, b.path, "同一秒内的两次备份不能互相覆盖");
    assert!(a.size_bytes > 0);
    let name = a.path.file_name().unwrap().to_str().unwrap().to_owned();
    assert!(
        name.starts_with("ztodo-") && name.contains("-manual"),
        "文件名：{name}"
    );
}
