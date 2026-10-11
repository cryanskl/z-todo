//! z-todo 的 Rust 宿主。
//!
//! 这里不写任何业务规则，只提供系统能力：SQLite（经 zt-db）、钥匙串、DeepSeek 请求转发、
//! 托盘、窗口生命周期。业务逻辑全部在 WebView 里的 TypeScript 中，经 `HostPort` 调用这些命令。

mod ai_proxy;
mod commands;
mod keychain;
mod tray;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, WindowEvent};

pub(crate) struct AppState {
    /// 打开失败时为 None：应用照常启动，界面显示 `startup_error`，而不是直接崩溃。
    pub db: Option<Arc<Mutex<zt_db::Connection>>>,
    pub startup_error: Option<String>,
    pub http: reqwest::Client,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub migrate: Option<zt_db::MigrateReport>,
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // 只允许一个实例写同一个数据库；再次打开时把已有窗口叫到前台。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            keychain::init();

            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("ztodo.db");
            let backups = data_dir.join("backups");
            let (db, migrate, startup_error) = match zt_db::open(&db_path, Some(&backups)) {
                Ok((conn, report)) => {
                    log::info!(
                        "数据库 {}：schema {} → {}{}",
                        db_path.display(),
                        report.from_version,
                        report.to_version,
                        report
                            .backup
                            .as_ref()
                            .map(|p| format!("，迁移前备份 {}", p.display()))
                            .unwrap_or_default()
                    );
                    (Some(Arc::new(Mutex::new(conn))), Some(report), None)
                }
                Err(e) => {
                    log::error!("数据库无法打开：{e}");
                    let msg = format!(
                        "数据库无法打开：{}\n\n数据库文件：{}\n备份目录：{}\n数据没有被修改。",
                        e.message,
                        db_path.display(),
                        backups.display()
                    );
                    (None, None, Some(msg))
                }
            };

            app.manage(AppState {
                db,
                startup_error,
                http: ai_proxy::client()?,
                data_dir,
                db_path,
                migrate,
            });
            tray::create(app.handle())?;
            Ok(())
        })
        // 关闭主窗口只是隐藏：进程和计时继续，只有 ⌘Q 或托盘「退出」才真正退出。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_query,
            commands::db_tx,
            commands::ai_call,
            commands::has_api_key,
            commands::set_api_key,
            commands::delete_api_key,
            commands::app_info,
        ])
        .build(tauri::generate_context!())
        .expect("z-todo 启动失败")
        .run(|app, event| {
            let _ = &app;
            match event {
                // 窗口隐藏后点 Dock 图标，重新显示主窗口。
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows: false,
                    ..
                } => show_main_window(app),
                _ => {}
            }
        });
}
