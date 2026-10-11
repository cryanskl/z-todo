// 发布版在 Windows 上不弹出控制台窗口；macOS 上无影响。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    z_todo_lib::run()
}
