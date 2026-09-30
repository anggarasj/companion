// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn is_native_host_origin(origin: Option<&str>) -> bool {
    let Some(extension_origin) = origin.and_then(|value| value.strip_prefix("chrome-extension://"))
    else {
        return false;
    };
    let Some(extension_id) = extension_origin.strip_suffix('/') else {
        return false;
    };
    extension_id.len() == 32
        && extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
}

fn main() {
    let first_arg = std::env::args_os().nth(1);
    if is_native_host_origin(first_arg.as_deref().and_then(|arg| arg.to_str())) {
        let config = companion_desktop_lib::config_dir();
        let spool = companion_desktop_lib::host::spool_dir(&config);
        companion_desktop_lib::host::run(&spool);
        return;
    }
    companion_desktop_lib::run()
}

#[cfg(test)]
mod tests {
    use super::is_native_host_origin;

    #[test]
    fn recognizes_chromium_extension_origin_only() {
        assert!(is_native_host_origin(Some(
            "chrome-extension://neeapigpheabagekbdfjdekgdicfckpn/"
        )));
        assert!(!is_native_host_origin(None));
        assert!(!is_native_host_origin(Some("--native-host")));
        assert!(!is_native_host_origin(Some("chrome-extension://short/")));
        assert!(!is_native_host_origin(Some(
            "chrome-extension://neeapigpheabagekbdfjdekgdicfckpn"
        )));
    }
}
