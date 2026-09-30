#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let config = companion_desktop_lib::config_dir();
    companion_desktop_lib::host::run(&companion_desktop_lib::host::spool_dir(&config));
}
