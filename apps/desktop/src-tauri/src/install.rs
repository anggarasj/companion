// Registering the separately bundled, headless native-messaging executable.
//
// It deliberately does not install the extension: that means downloading a
// release, unzipping it and launching a browser with a dedicated profile, and
// a browser someone is already signed into is not ours to restart. The screen
// says what to do instead.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::{env, fs};

pub const HOST_NAME: &str = "dev.suiflex.companion";

/// The extension id, pinned by the `key` in the extension's manifest. The
/// manifest's `allowed_origins` has to name it exactly or the browser refuses
/// the connection with a message about permissions rather than about ids.
pub const EXTENSION_ID: &str = "neeapigpheabagekbdfjdekgdicfckpn";

#[derive(Serialize, Clone)]
pub struct Browser {
    /// Display name.
    pub name: String,
    /// Where its manifest has to go.
    pub manifest_dir: String,
    /// Whether ours is already there.
    pub registered: bool,
}

/// Chromium reads native-messaging manifests out of the user-data-dir it was
/// started with — which is the profile root, not the profile folder inside it.
///
/// Verified rather than assumed for Arc, whose user-data-dir is a subfolder of
/// its application-support directory: after writing the manifest to seven
/// candidate locations, the access time showed only `Arc/User Data` had been
/// read. The others were never opened.
fn candidates(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let app_support = home.join("Library/Application Support");
    if cfg!(target_os = "macos") {
        return vec![
            ("Google Chrome", app_support.join("Google/Chrome")),
            ("Chromium", app_support.join("Chromium")),
            ("Microsoft Edge", app_support.join("Microsoft Edge")),
            (
                "Brave Browser",
                app_support.join("BraveSoftware/Brave-Browser"),
            ),
            ("Arc", app_support.join("Arc/User Data")),
            ("Vivaldi", app_support.join("Vivaldi")),
        ];
    }
    let config = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".config"));
    vec![
        ("Google Chrome", config.join("google-chrome")),
        ("Chromium", config.join("chromium")),
        ("Microsoft Edge", config.join("microsoft-edge")),
        ("Brave Browser", config.join("BraveSoftware/Brave-Browser")),
        ("Vivaldi", config.join("vivaldi")),
    ]
}

fn manifest_dir(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join("NativeMessagingHosts")
}

fn home() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".into()))
}

/// The browsers on this machine, and whether the bridge is registered for each.
///
/// Presence is decided by the profile directory existing: a browser that has
/// never been run has nothing to register into, and one that is installed but
/// unused would otherwise be offered and then fail.
#[tauri::command]
pub fn list_browsers() -> Vec<Browser> {
    let home = home();
    let host = env::current_exe()
        .ok()
        .and_then(|gui| native_host_path(&gui).ok())
        .filter(|path| path.is_file());
    candidates(&home)
        .into_iter()
        .filter(|(_, dir)| dir.is_dir())
        .map(|(name, dir)| Browser {
            name: name.to_string(),
            manifest_dir: manifest_dir(&dir).to_string_lossy().into_owned(),
            registered: host
                .as_deref()
                .is_some_and(|host| migrate_manifest(&dir, host)),
        })
        .collect()
}

/// Upgrade an existing Companion registration from the GUI executable to the
/// headless sidecar. Chrome ignores the old manifest's unsupported `args`.
fn migrate_manifest(browser_root: &Path, host: &Path) -> bool {
    if !host.is_file() {
        return false;
    }
    let Ok(root) = fs::canonicalize(browser_root) else {
        return false;
    };
    let parent = root.join("NativeMessagingHosts");
    let Ok(parent) = fs::canonicalize(&parent) else {
        return false;
    };
    if !parent.starts_with(&root) {
        return false;
    }
    let path = parent.join(format!("{HOST_NAME}.json"));
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    let Ok(path) = fs::canonicalize(&path) else {
        return false;
    };
    if !path.starts_with(&root) {
        return false;
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let host_text = host.to_string_lossy();
    if manifest.get("name").and_then(|name| name.as_str()) != Some(HOST_NAME) {
        return false;
    }
    if manifest.get("path").and_then(|path| path.as_str()) == Some(host_text.as_ref()) {
        return true;
    }
    fs::write(&path, manifest_json(&host_text)).is_ok()
}

/// Rewrite registrations from the prior GUI-host version when the app is
/// upgraded. Existing registrations are the user's opt-in; only our own
/// manifest name is eligible for migration.
pub fn migrate_existing_bridges() {
    let Ok(gui) = env::current_exe() else {
        return;
    };
    let Ok(host) = native_host_path(&gui) else {
        return;
    };
    if !host.is_file() {
        return;
    }
    for (_, dir) in candidates(&home())
        .into_iter()
        .filter(|(_, dir)| dir.is_dir())
    {
        let _ = migrate_manifest(&dir, &host);
    }
}

/// The manifest body. Chromium does not support an `args` field in host
/// manifests, so the registered executable itself must be headless.
fn manifest_json(host: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Companion vault capture host",
        "path": host,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")]
    }))
    .expect("native host manifest fields are serializable")
}

fn native_host_path(gui_exe: &Path) -> Result<PathBuf, String> {
    let dir = gui_exe
        .parent()
        .ok_or_else(|| "desktop executable has no parent directory".to_owned())?;
    let name = if cfg!(target_os = "windows") {
        "companion-native-host.exe"
    } else {
        "companion-native-host"
    };
    Ok(dir.join(name))
}

/// Register the bridge for one browser, by its display name.
#[tauri::command]
pub fn register_bridge(browser: String) -> Result<String, String> {
    let home = home();
    let (_, dir) = candidates(&home)
        .into_iter()
        .find(|(name, _)| *name == browser)
        .ok_or_else(|| format!("unknown browser: {browser}"))?;
    let gui_exe = env::current_exe().map_err(|e| e.to_string())?;
    let host = native_host_path(&gui_exe)?;
    if !host.is_file() {
        return Err(format!(
            "native host executable is missing: {}",
            host.display()
        ));
    }
    let target = manifest_dir(&dir);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let path = target.join(format!("{HOST_NAME}.json"));
    fs::write(&path, manifest_json(&host.to_string_lossy())).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Remove the registration. Undoing has to be as easy as doing, or trying it
/// is a commitment.
#[tauri::command]
pub fn unregister_bridge(browser: String) -> Result<(), String> {
    let home = home();
    let (_, dir) = candidates(&home)
        .into_iter()
        .find(|(name, _)| *name == browser)
        .ok_or_else(|| format!("unknown browser: {browser}"))?;
    match fs::remove_file(manifest_dir(&dir).join(format!("{HOST_NAME}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_dir_is_the_user_data_dir_not_the_profile() {
        // `Default/` is the profile; Chromium looks one level up from it.
        let dir = manifest_dir(Path::new("/x/Arc/User Data"));
        assert_eq!(dir, PathBuf::from("/x/Arc/User Data/NativeMessagingHosts"));
        assert!(!dir.to_string_lossy().contains("Default"));
    }

    #[test]
    fn arc_is_registered_under_its_user_data_dir() {
        // Arc keeps its profile in a subfolder, so the obvious guess — the
        // application-support directory itself — is wrong, and a manifest
        // written there is never read.
        let dirs = candidates(Path::new("/home/x"));
        if cfg!(target_os = "macos") {
            let arc = dirs.iter().find(|(n, _)| *n == "Arc").expect("Arc missing");
            assert!(arc.1.ends_with("Arc/User Data"), "{:?}", arc.1);
        }
    }

    #[test]
    fn the_manifest_points_to_a_dedicated_host_without_cli_args() {
        let host =
            Path::new("/Applications/Companion Desktop.app/Contents/MacOS/companion-native-host");
        let json = manifest_json(&host.to_string_lossy());
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("manifest is not JSON");
        assert_eq!(parsed["name"], HOST_NAME);
        assert_eq!(parsed["type"], "stdio");
        assert_eq!(parsed["path"], host.to_string_lossy().as_ref());
        assert!(parsed.get("args").is_none());
        assert_eq!(
            parsed["allowed_origins"],
            serde_json::json!([format!("chrome-extension://{EXTENSION_ID}/")])
        );
    }

    #[test]
    fn sidecar_path_is_next_to_the_desktop_executable() {
        let path = native_host_path(Path::new(
            "/Applications/Companion.app/Contents/MacOS/companion",
        ))
        .unwrap();
        let sidecar = if cfg!(target_os = "windows") {
            "companion-native-host.exe"
        } else {
            "companion-native-host"
        };
        assert_eq!(
            path,
            Path::new("/Applications/Companion.app/Contents/MacOS").join(sidecar)
        );
    }

    #[test]
    fn an_existing_gui_host_manifest_is_migrated_to_the_sidecar() {
        let dir = env::temp_dir().join(format!("companion-host-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let host = dir.join(if cfg!(target_os = "windows") {
            "companion-native-host.exe"
        } else {
            "companion-native-host"
        });
        fs::write(&host, b"headless host").unwrap();
        let browser_root = dir.join("profile");
        let host_dir = manifest_dir(&browser_root);
        fs::create_dir_all(&host_dir).unwrap();
        let manifest = host_dir.join(format!("{HOST_NAME}.json"));
        fs::write(
            &manifest,
            serde_json::json!({
                "name": HOST_NAME,
                "description": "Companion vault capture host",
                "path": "/old/Companion.app/Contents/MacOS/companion",
                "type": "stdio",
                "args": ["--native-host"],
                "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")]
            })
            .to_string(),
        )
        .unwrap();

        assert!(migrate_manifest(&browser_root, &host));
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest).unwrap()).unwrap();
        assert!(migrate_manifest(&browser_root, &host));
        assert_eq!(migrated["path"], host.to_string_lossy().as_ref());
        assert!(migrated.get("args").is_none());

        #[cfg(unix)]
        {
            let linked_root = dir.join("linked-profile");
            let external = dir.join("outside/NativeMessagingHosts");
            fs::create_dir_all(&linked_root).unwrap();
            fs::create_dir_all(&external).unwrap();
            let external_manifest = external.join(format!("{HOST_NAME}.json"));
            fs::copy(&manifest, &external_manifest).unwrap();
            std::os::unix::fs::symlink(&external, linked_root.join("NativeMessagingHosts"))
                .unwrap();
            let original = fs::read_to_string(&external_manifest).unwrap();
            assert!(!migrate_manifest(&linked_root, &host));
            assert_eq!(fs::read_to_string(&external_manifest).unwrap(), original);
        }

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unknown_browser_is_refused() {
        assert!(register_bridge("Netscape".into()).is_err());
        assert!(unregister_bridge("Netscape".into()).is_err());
    }
}
