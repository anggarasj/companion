// Thin filesystem backend for the desktop vault.
//
// Deliberately primitives-only: list/read/write/append/trash/mtime. All vault
// logic (note parsing, index, search) lives in @meetcc/vault (TypeScript) which
// the WebView drives through these commands via a VaultIo adapter. This is the
// roadmap §D4 boundary — Rust owns file I/O and IPC, never the AI/retrieval.
use parking_lot::Mutex;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::State;

const TRASH: &str = ".trash";
const TRANSCRIPT: &str = ".transcript";

/// Where this install keeps its own small state, handed in by `lib.rs` so the
/// vault module never has to know about the Tauri app handle.
pub struct ConfigDir(pub PathBuf);

/// Managed Tauri state holding the vault root directory.
pub struct VaultState {
    pub root: Mutex<PathBuf>,
}

impl VaultState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Mutex::new(root),
        }
    }
}

/// Default vault root: `~/Companion`.
pub fn default_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Companion")
}

/// Where the chosen root is remembered between launches.
///
/// One line of text rather than a store plugin: this is a single path, and a
/// plugin would mean an npm dependency, a crate and a capability entry for it.
pub fn config_file(config_dir: &Path) -> PathBuf {
    config_dir.join("vault-root")
}

/// The root to start with: the remembered one if it still exists, else the
/// default. A stored path whose folder has since been deleted or unmounted
/// must not leave the app pointing at nothing.
pub fn startup_root(config_dir: &Path) -> PathBuf {
    match fs::read_to_string(config_file(config_dir)) {
        Ok(text) => {
            let saved = PathBuf::from(text.trim());
            if !saved.as_os_str().is_empty() && saved.is_dir() {
                saved
            } else {
                default_root()
            }
        }
        Err(_) => default_root(),
    }
}

/// Remember a root, or forget it when `root` is `None` (back to the default).
pub fn remember_root(config_dir: &Path, root: Option<&Path>) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    match root {
        Some(path) => fs::write(config_file(config_dir), path.to_string_lossy().as_bytes()),
        None => match fs::remove_file(config_file(config_dir)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

/// What a folder looks like, without touching it.
///
/// `set_vault_root` used to create `.transcript/` inside whatever was picked
/// *before* the user could confirm, so a mis-click left a directory behind in
/// someone's Documents. This answers the question first; nothing is written.
#[derive(serde::Serialize)]
pub struct RootProbe {
    pub exists: bool,
    pub markdown: usize,
    pub is_vault: bool,
}

/// The default the reset action returns to, so the frontend does not have to
/// reconstruct `~/Companion` and hope it matches.
#[tauri::command]
pub fn default_vault_root() -> String {
    default_root().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn probe_vault_root(path: String) -> RootProbe {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return RootProbe {
            exists: false,
            markdown: 0,
            is_vault: false,
        };
    }
    let mut found = Vec::new();
    let _ = walk_md(&dir, &dir, &mut found);
    RootProbe {
        exists: true,
        markdown: found.len(),
        is_vault: dir.join(TRANSCRIPT).is_dir(),
    }
}

/// Create the vault skeleton. Called at startup: on a machine that has never
/// run the app, `~/Companion` does not exist, and the first `list_vault` would
/// fail on read_dir and leave the window stuck on an error with no way out.
pub fn ensure_root(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root.join(TRANSCRIPT))
}

fn root(state: &VaultState) -> PathBuf {
    state.root.lock().clone()
}

/// Resolve a vault-relative path. Rejects anything that would climb out of the
/// vault: these paths originate in the WebView, which in turn takes them from
/// note frontmatter, so they are data rather than something we control.
fn abs(state: &VaultState, rel: &str) -> Result<PathBuf, String> {
    resolve(&root(state), rel)
}

/// The guard itself, taking a root so it can be exercised directly.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    let path = Path::new(rel);
    if path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("path escapes the vault: {rel}"));
    }
    Ok(root.join(path))
}

#[tauri::command]
pub fn vault_root(state: State<'_, VaultState>) -> Result<String, String> {
    Ok(root(&state).to_string_lossy().into_owned())
}

/// Switch to another root and remember it.
///
/// The folder is only prepared once the caller has committed to it — the
/// frontend confirms against `probe_vault_root` first.
#[tauri::command]
pub fn set_vault_root(
    state: State<'_, VaultState>,
    config: State<'_, ConfigDir>,
    path: String,
) -> Result<(), String> {
    let new_root = PathBuf::from(path);
    ensure_root(&new_root).map_err(|e| e.to_string())?;
    remember_root(&config.0, Some(&new_root)).map_err(|e| e.to_string())?;
    *state.root.lock() = new_root;
    Ok(())
}

/// Forget the chosen root and go back to `~/Companion`.
#[tauri::command]
pub fn reset_vault_root(
    state: State<'_, VaultState>,
    config: State<'_, ConfigDir>,
) -> Result<String, String> {
    let root = default_root();
    ensure_root(&root).map_err(|e| e.to_string())?;
    remember_root(&config.0, None).map_err(|e| e.to_string())?;
    *state.root.lock() = root.clone();
    Ok(root.to_string_lossy().into_owned())
}

/// All `.md` relative paths under the vault, excluding `.trash`/`.transcript`.
#[tauri::command]
pub fn list_vault(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    walk_md(&root(&state), &root(&state), &mut out)?;
    Ok(out)
}

fn walk_md(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    if let Some(n) = dir.file_name().and_then(|n| n.to_str()) {
        if n == TRASH || n == TRANSCRIPT {
            return Ok(());
        }
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            walk_md(root, &path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            out.push(rel);
        }
    }
    Ok(())
}

/// Image types a note may use as its icon or cover.
const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
/// Video and audio a note plays inline.
const MEDIA_EXTS: [&str; 8] = ["mp4", "mov", "m4v", "webm", "mp3", "m4a", "wav", "ogg"];
/// An attachment travels through IPC in one piece, so it has a ceiling.
const MAX_ASSET_BYTES: u64 = 200 * 1024 * 1024;
/// Where pasted, dropped and picked attachments live; a dot folder, so the
/// sidebar tree leaves it out.
const ASSETS: &str = ".assets/";

fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

fn is_image(path: &Path) -> bool {
    ext_of(path).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str()))
}

fn is_media(path: &Path) -> bool {
    ext_of(path).is_some_and(|e| MEDIA_EXTS.contains(&e.as_str()))
}

/// An attachment keeps its own type and is never a note: a `.md` written
/// here would join the vault as a note nobody wrote.
fn attachment_type_ok(dest: &Path) -> bool {
    ext_of(dest).is_some_and(|e| e != "md")
}

/// Copy a file the user picked in the file dialog into the vault, so a note's
/// cover, icon or attachment travels with the vault instead of pointing at a
/// file somewhere else on the disk. Bytes only: the name comes from the frontend.
fn import_asset(root: &Path, src: &Path, rel: &str) -> Result<(), String> {
    let dest = resolve(root, rel)?;
    if !attachment_type_ok(&dest) || ext_of(src) != ext_of(&dest) {
        return Err("an attachment keeps its own type and is never a note".into());
    }
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_ASSET_BYTES {
        return Err("not a file, or larger than 200 MB".into());
    }
    if dest.exists() {
        return Err(format!("already exists: {rel}"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(src, &dest).map(|_| ()).map_err(|e| e.to_string())
}

/// Write a pasted or dropped attachment into `.assets/`. Such a file has no
/// path the dialog could hand over — a screenshot on the clipboard is only
/// bytes — so the bytes come over IPC. Never over an existing file.
fn write_asset(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if !rel.starts_with(ASSETS) {
        return Err(format!("attachments go in {ASSETS}"));
    }
    let dest = resolve(root, rel)?;
    if !attachment_type_ok(&dest) {
        return Err("an attachment keeps its own type and is never a note".into());
    }
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err("larger than 200 MB".into());
    }
    if dest.exists() {
        return Err(format!("already exists: {rel}"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

/// The body is the file's raw bytes, not a JSON array of numbers — a video
/// encoded that way would be several times its own size. The vault path rides
/// in the `x-vault-rel` header, ASCII because the frontend builds it that way.
#[tauri::command]
pub fn write_vault_bytes(
    state: State<'_, VaultState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let rel = request
        .headers()
        .get("x-vault-rel")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-vault-rel header")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    write_asset(&root(&state), rel, bytes)
}

#[tauri::command]
pub fn import_vault_asset(
    state: State<'_, VaultState>,
    src: String,
    rel: String,
) -> Result<(), String> {
    import_asset(&root(&state), Path::new(&src), &rel)
}

fn is_viewable(path: &Path) -> bool {
    is_image(path) || is_media(path) || ext_of(path).is_some_and(|e| e == "pdf")
}

/// An image, PDF, video or audio file inside the vault, as raw bytes for the WebView to show.
/// Nothing else: the WebView reads text through `read_vault_file`.
#[tauri::command]
pub fn read_vault_bytes(
    state: State<'_, VaultState>,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let path = abs(&state, &rel)?;
    if !is_viewable(&path) {
        return Err("not an image, PDF, video or audio file".into());
    }
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Every file that is not a note, so the tree can show a vault as it is on
/// disk. Dot entries (.obsidian, .assets, .DS_Store …) are tool state and left out.
#[tauri::command]
pub fn list_vault_files(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let root = root(&state);
    let mut out = Vec::new();
    walk_other(&root, &root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_other(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk_other(root, &path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) != Some("md") {
            let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
            out.push(rel.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

/// Show a vault file in Finder / Explorer / the file manager. Reveal, never
/// run: a vault can be a synced folder, and launching whatever file sits in
/// it would make "open" mean "execute".
#[tauri::command]
pub fn reveal_vault_file(state: State<'_, VaultState>, rel: String) -> Result<(), String> {
    let path = abs(&state, &rel)?;
    if !path.exists() {
        return Err(format!("not found: {rel}"));
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&path);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", path.display()));
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(&path));
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_vault_file(state: State<'_, VaultState>, rel: String) -> Result<String, String> {
    fs::read_to_string(abs(&state, &rel)?).map_err(|e| e.to_string())
}

/// Atomic write: temp file + rename, so a crash never leaves a partial note.
#[tauri::command]
pub fn write_vault_file(
    state: State<'_, VaultState>,
    rel: String,
    content: String,
) -> Result<(), String> {
    let path = abs(&state, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append a single line to a file (used for raw transcript sidecars).
#[tauri::command]
pub fn append_vault_line(
    state: State<'_, VaultState>,
    rel: String,
    line: String,
) -> Result<(), String> {
    use std::io::Write;
    let path = abs(&state, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_mtime(state: State<'_, VaultState>, rel: String) -> Result<f64, String> {
    fs::metadata(abs(&state, &rel)?)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        })
        .map_err(|e| e.to_string())
}

/// Move a note to another folder inside the vault.
///
/// Both ends go through `abs()`, which is the whole safety story: these paths
/// come from the WebView, and a destination is just as capable of climbing out
/// of the vault as a source is.
#[tauri::command]
pub fn move_vault_file(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> Result<(), String> {
    move_within(&root(&state), &from, &to)
}

/// The move itself, split from the command so it can be tested without a
/// Tauri `State`.
fn move_within(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = resolve(root, from)?;
    let dest = resolve(root, to)?;
    // Replacing the destination would destroy a note, which is the one outcome
    // a move must never have.
    if dest.exists() {
        return Err(format!("a note already exists at {to}"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())
}
/// Resolve an existing folder and ensure symlinks cannot take it outside the vault.
fn existing_folder(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    if rel.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == TRASH || c.as_os_str() == TRANSCRIPT)
    {
        return Err(format!("invalid vault folder path: {rel}"));
    }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let folder = root.join(path);
    let mut current = root.clone();
    for component in path.components() {
        current.push(component);
        if fs::symlink_metadata(&current)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err(format!("folder path contains a symlink: {rel}"));
        }
    }
    let canonical = fs::canonicalize(&folder).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_dir() {
        return Err(format!(
            "folder is outside the vault or not a directory: {rel}"
        ));
    }
    Ok(folder)
}

/// Rename a folder without replacing an existing path or moving it into itself.
#[tauri::command]
pub fn rename_vault_folder(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> Result<(), String> {
    rename_folder(&root(&state), &from, &to)
}

fn rename_folder(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = existing_folder(root, from)?;
    let dst_rel = Path::new(to);
    if to.is_empty()
        || dst_rel.is_absolute()
        || dst_rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || dst_rel
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == TRASH || c.as_os_str() == TRANSCRIPT)
    {
        return Err(format!("invalid vault folder path: {to}"));
    }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let destination = root.join(dst_rel);
    if destination == src || destination.starts_with(&src) {
        return Err("a folder cannot be renamed into itself".into());
    }
    let parent = destination.parent().ok_or("invalid destination folder")?;
    let canonical_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !canonical_parent.starts_with(&root) {
        return Err(format!("destination is outside the vault: {to}"));
    }
    let destination = canonical_parent.join(
        destination
            .file_name()
            .ok_or("invalid destination folder")?,
    );
    if destination == src || destination.starts_with(&src) {
        return Err("a folder cannot be renamed into itself".into());
    }
    if fs::symlink_metadata(&destination).is_ok() {
        let source = fs::canonicalize(&src).map_err(|e| e.to_string())?;
        let same_directory =
            fs::canonicalize(&destination).is_ok_and(|existing| existing == source);
        if !same_directory {
            return Err(format!("a folder already exists at {to}"));
        }
        let parent = src.parent().ok_or("invalid source folder")?;
        let temporary = unique_timestamped_path(parent, ".companion-rename", "")?;
        fs::rename(&src, &temporary).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&temporary, &destination) {
            return match fs::rename(&temporary, &src) {
                Ok(()) => Err(error.to_string()),
                Err(restore) => Err(format!(
                    "{error}; failed to restore original folder name: {restore}"
                )),
            };
        }
        return Ok(());
    }
    fs::rename(src, destination).map_err(|e| e.to_string())
}

/// Move a whole folder tree into the vault's reversible trash area.
#[tauri::command]
pub fn trash_vault_folder(state: State<'_, VaultState>, rel: String) -> Result<(), String> {
    trash_folder(&root(&state), &rel)
}

fn trash_folder(root: &Path, rel: &str) -> Result<(), String> {
    let folder = existing_folder(root, rel)?;
    let vault_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let trash_path = vault_root.join(TRASH);
    if fs::symlink_metadata(&trash_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("trash directory cannot be a symlink".into());
    }
    fs::create_dir_all(&trash_path).map_err(|e| e.to_string())?;
    let trash = fs::canonicalize(trash_path).map_err(|e| e.to_string())?;
    if !trash.starts_with(&vault_root) {
        return Err("trash directory is outside the vault".into());
    }
    let name = folder.file_name().ok_or("invalid folder name")?;
    let mut destination = trash.join(name);
    if fs::symlink_metadata(&destination).is_ok() {
        let name = name.to_string_lossy();
        destination = unique_timestamped_path(&trash, &name, "")?;
    }
    fs::rename(folder, destination).map_err(|e| e.to_string())
}

fn unique_timestamped_path(
    directory: &Path,
    stem: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let first_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    for attempt in 0u128..100 {
        let suffix = first_suffix.saturating_add(attempt);
        let path = directory.join(format!("{stem}-{suffix}{extension}"));
        if fs::symlink_metadata(&path).is_err() {
            return Ok(path);
        }
    }
    Err("could not allocate a unique timestamped path".into())
}

/// Create an empty folder in the vault.
///
/// Empty on purpose: a folder exists before the note that will live in it, and
/// the sidebar derives its tree from note paths, so the folder has to be real
/// on disk to survive a refresh.
#[tauri::command]
pub fn create_vault_folder(state: State<'_, VaultState>, rel: String) -> Result<(), String> {
    let dir = abs(&state, &rel)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// The folders that exist in the vault, including ones holding no notes.
#[tauri::command]
pub fn list_vault_folders(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let root = root(&state);
    let mut out = Vec::new();
    walk_dirs(&root, &root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_dirs(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // The sidecar and the bin are storage, not places a note belongs.
        if name == TRASH || name == TRANSCRIPT {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        out.push(rel);
        walk_dirs(root, &path, out)?;
    }
    Ok(())
}

#[tauri::command]
pub fn trash_vault_file(state: State<'_, VaultState>, rel: String) -> Result<(), String> {
    trash_file(&root(&state), &rel)
}

fn trash_file(root: &Path, rel: &str) -> Result<(), String> {
    let from = resolve(root, rel)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("note.md");
    let trash_dir = root.join(TRASH);
    fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
    // Notes from different days share a basename; landing on one already in the
    // trash would destroy it, which is what the trash exists to prevent.
    let mut dest = trash_dir.join(name);
    if fs::symlink_metadata(&dest).is_ok() {
        // Any file can be trashed now, not only notes: keep its own extension.
        let (stem, ext) = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
            _ => (name, String::new()),
        };
        dest = unique_timestamped_path(&trash_dir, stem, &ext)?;
    }
    fs::rename(&from, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// A header the frontend sent through `encodeURIComponent`: a note title can be
/// any language, and a header value is ASCII.
fn header_text(request: &tauri::ipc::Request<'_>, key: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing {key} header"))?;
    decode_header(raw).ok_or_else(|| format!("{key} is not UTF-8"))
}

fn decode_header(raw: &str) -> Option<String> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

/// Save an export wherever the user points the native save dialog, which opens
/// in `dir` — the vault folder the note lives in. The WebView never names the
/// target — the dialog does — so this cannot be steered at an arbitrary file.
/// Async because the dialog blocks, which must not happen on the main thread.
/// `None` when the dialog was cancelled.
///
/// The bytes are the raw IPC body, not a JSON array of numbers: a long PDF
/// export encoded that way was several times its own size in memory. The file
/// name and folder ride in `x-export-name` / `x-export-dir`.
#[tauri::command]
pub async fn export_file(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let name = header_text(&request, "x-export-name")?;
    let dir = header_text(&request, "x-export-dir")?;
    let start = abs(&state, &dir)?;
    let Some(picked) = app
        .dialog()
        .file()
        .set_directory(start)
        .set_file_name(&name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn export_headers_carry_a_title_in_any_language() {
        // encodeURIComponent("Rapat Évaluasi 🚀.pdf") and ("Proyek/Ü")
        assert_eq!(
            decode_header("Rapat%20%C3%89valuasi%20%F0%9F%9A%80.pdf").as_deref(),
            Some("Rapat Évaluasi 🚀.pdf")
        );
        assert_eq!(
            decode_header("Proyek%2F%C3%9C").as_deref(),
            Some("Proyek/Ü")
        );
        assert_eq!(decode_header("plain.md").as_deref(), Some("plain.md"));
        // Not UTF-8 once decoded: refused, not mangled.
        assert_eq!(decode_header("%FF%FE"), None);
    }

    #[test]
    fn write_asset_puts_bytes_in_assets_and_refuses_everything_else() {
        let root = tmp("write-asset");
        write_asset(&root, ".assets/clip-1.mp4", b"video").unwrap();
        assert_eq!(fs::read(root.join(".assets/clip-1.mp4")).unwrap(), b"video");
        // Never over an existing file, never a note, never outside .assets.
        assert!(write_asset(&root, ".assets/clip-1.mp4", b"again").is_err());
        assert_eq!(fs::read(root.join(".assets/clip-1.mp4")).unwrap(), b"video");
        assert!(write_asset(&root, ".assets/sneaky.md", b"# note").is_err());
        assert!(write_asset(&root, ".assets/noext", b"x").is_err());
        assert!(write_asset(&root, "Projects/a.png", b"x").is_err());
        assert!(write_asset(&root, ".assets/../../outside.png", b"x").is_err());
    }

    #[test]
    fn import_asset_takes_any_attachment_of_the_same_type() {
        let root = tmp("import-any");
        let outside = tmp("import-any-src");
        fs::write(outside.join("talk.mov"), b"mov").unwrap();
        fs::write(outside.join("brief.pdf"), b"pdf").unwrap();
        import_asset(&root, &outside.join("talk.mov"), ".assets/talk-1.mov").unwrap();
        import_asset(&root, &outside.join("brief.pdf"), ".assets/brief-1.pdf").unwrap();
        assert_eq!(fs::read(root.join(".assets/talk-1.mov")).unwrap(), b"mov");
        // Renaming the type on the way in is refused.
        assert!(import_asset(&root, &outside.join("talk.mov"), ".assets/talk-2.png").is_err());
    }

    #[test]
    fn trash_file_keeps_the_extension_of_a_non_note_on_collision() {
        let root = tmp("trash-file-ext");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/Board.excalidraw"), "one").unwrap();
        fs::write(root.join("b/Board.excalidraw"), "two").unwrap();
        trash_file(&root, "a/Board.excalidraw").unwrap();
        trash_file(&root, "b/Board.excalidraw").unwrap();
        let mut names: Vec<String> = fs::read_dir(root.join(TRASH))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), 2);
        assert_eq!(names[1], "Board.excalidraw");
        assert!(names[0].starts_with("Board-"), "{names:?}");
        assert!(
            names.iter().all(|n| n.ends_with(".excalidraw")),
            "{names:?}"
        );
        assert!(!root.join("a/Board.excalidraw").exists());
        assert!(trash_file(&root, "../outside.md").is_err());
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("companion-vault-test-{name}"));
        let _ = fs::remove_dir_all(&dir);

        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn trash_folder_preserves_same_basename_directories_with_suffixes() {
        let root = tmp("trash-folder-collision");
        fs::create_dir_all(root.join("Projects/Notes")).unwrap();
        fs::write(root.join("Projects/Notes/a.md"), "one").unwrap();
        trash_folder(&root, "Projects").unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".trash/Projects/Notes/a.md")).unwrap(),
            "one"
        );

        fs::create_dir_all(root.join("Projects/Notes")).unwrap();
        fs::write(root.join("Projects/Notes/a.md"), "two").unwrap();
        trash_folder(&root, "Projects").unwrap();
        let trashed: Vec<_> = fs::read_dir(root.join(".trash"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.is_dir())
            .collect();
        assert_eq!(trashed.len(), 2);
        assert_eq!(
            fs::read_to_string(root.join(".trash/Projects/Notes/a.md")).unwrap(),
            "one"
        );
        let suffixed = trashed
            .iter()
            .find(|path| path.file_name().unwrap() != "Projects")
            .unwrap();
        assert_eq!(
            fs::read_to_string(suffixed.join("Notes/a.md")).unwrap(),
            "two"
        );
        assert!(trash_folder(&root, "").is_err());
        assert!(trash_folder(&root, "../outside").is_err());
    }

    #[test]
    fn rename_folder_allows_case_only_change_when_filesystem_aliases_case() {
        let root = tmp("rename-folder-case");
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("Projects/a.md"), "one").unwrap();
        let case_alias = fs::create_dir(root.join("projects")).is_err();

        if case_alias {
            rename_folder(&root, "Projects", "projects").unwrap();
            let names: Vec<_> = fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert!(names.iter().any(|name| name == "projects"));
            assert!(!names.iter().any(|name| name == "Projects"));
            assert_eq!(
                fs::read_to_string(root.join("projects/a.md")).unwrap(),
                "one"
            );
        } else {
            assert!(rename_folder(&root, "Projects", "projects").is_err());
            assert!(root.join("Projects/a.md").exists());
        }
    }
    #[test]
    fn trash_folder_preserves_tree_and_rejects_root_escape() {
        let root = tmp("trash-folder");
        fs::create_dir_all(root.join("Projects/Notes")).unwrap();
        fs::write(root.join("Projects/Notes/a.md"), "one").unwrap();
        trash_folder(&root, "Projects").unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".trash/Projects/Notes/a.md")).unwrap(),
            "one"
        );
        assert!(trash_folder(&root, "").is_err());
        assert!(trash_folder(&root, "../outside").is_err());
    }

    #[test]
    fn remembers_a_root_and_reads_it_back() {
        let config = tmp("remember");
        let picked = tmp("remember-target");
        remember_root(&config, Some(&picked)).unwrap();
        assert_eq!(startup_root(&config), picked);
    }

    #[test]
    fn forgetting_returns_to_the_default() {
        let config = tmp("forget");
        let picked = tmp("forget-target");
        remember_root(&config, Some(&picked)).unwrap();
        remember_root(&config, None).unwrap();
        assert_eq!(startup_root(&config), default_root());
        // Forgetting twice is not an error; the file is simply already gone.
        remember_root(&config, None).unwrap();
    }

    #[test]
    fn falls_back_when_the_remembered_folder_is_gone() {
        // A vault on a drive that is no longer mounted must not strand the app
        // on a root it cannot read.
        let config = tmp("missing");
        let picked = tmp("missing-target");
        remember_root(&config, Some(&picked)).unwrap();
        fs::remove_dir_all(&picked).unwrap();
        assert_eq!(startup_root(&config), default_root());
    }

    #[test]
    fn falls_back_on_a_corrupt_or_empty_file() {
        let config = tmp("corrupt");
        fs::create_dir_all(&config).unwrap();
        for junk in ["", "   \n", "\u{0}"] {
            fs::write(config_file(&config), junk).unwrap();
            assert_eq!(startup_root(&config), default_root(), "junk: {junk:?}");
        }
    }

    #[test]
    fn resolve_refuses_a_path_that_climbs_out_of_the_vault() {
        // The move command takes *two* paths from the WebView, and a
        // destination can escape just as easily as a source.
        let root = tmp("escape");
        for bad in ["../outside.md", "a/../../outside.md", "a/b/../../../x.md"] {
            assert!(resolve(&root, bad).is_err(), "allowed: {bad}");
        }
        assert!(resolve(&root, "Rapat/2026-09-04/ok.md").is_ok());

        // A leading slash is trimmed rather than rejected, so an absolute-
        // looking path lands *inside* the vault instead of at the real one.
        // That is the invariant worth asserting: whatever comes in, the
        // resolved path never leaves the root.
        let absolute = resolve(&root, "/etc/passwd").unwrap();
        assert!(absolute.starts_with(&root), "escaped: {absolute:?}");
        assert_eq!(absolute, root.join("etc/passwd"));
    }

    #[test]
    fn lists_files_that_are_not_notes_and_skips_dot_entries() {
        let root = tmp("other-files");
        fs::create_dir_all(root.join("docs/.obsidian")).unwrap();
        fs::create_dir_all(root.join(".assets")).unwrap();
        for f in [
            "docs/spec.pdf",
            "docs/note.md",
            "docs/sheet.xlsx",
            "docs/.DS_Store",
            "docs/.obsidian/app.json",
            ".assets/c.png",
        ] {
            fs::write(root.join(f), b"x").unwrap();
        }
        let mut out = Vec::new();
        walk_other(&root, &root, &mut out).unwrap();
        out.sort();
        assert_eq!(
            out,
            vec!["docs/sheet.xlsx".to_string(), "docs/spec.pdf".to_string()]
        );
        assert!(is_viewable(Path::new("a/B.PDF")));
        assert!(!is_viewable(Path::new("a/b.xlsx")));
    }

    #[test]
    fn import_copies_an_image_and_refuses_everything_else() {
        let root = tmp("import");
        let outside = tmp("import-src");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("cover.png"), b"png").unwrap();
        fs::write(outside.join("notes.txt"), b"txt").unwrap();

        import_asset(&root, &outside.join("cover.png"), ".assets/c.png").unwrap();
        assert_eq!(fs::read(root.join(".assets/c.png")).unwrap(), b"png");

        // Not an image, on either side.
        assert!(import_asset(&root, &outside.join("notes.txt"), ".assets/n.png").is_err());
        assert!(import_asset(&root, &outside.join("cover.png"), ".assets/c.md").is_err());
        // Out of the vault, or over a file that is already there.
        assert!(import_asset(&root, &outside.join("cover.png"), "../c.png").is_err());
        assert!(import_asset(&root, &outside.join("cover.png"), ".assets/c.png").is_err());
    }

    #[test]
    fn move_refuses_to_overwrite_an_existing_note() {
        let root = tmp("move-clash");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/n.md"), "one").unwrap();
        fs::write(root.join("b/n.md"), "two").unwrap();

        assert!(move_within(&root, "a/n.md", "b/n.md").is_err());
        assert_eq!(fs::read_to_string(root.join("b/n.md")).unwrap(), "two");
        assert!(root.join("a/n.md").exists());
    }

    #[test]
    fn move_creates_the_destination_folder() {
        let root = tmp("move-ok");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/n.md"), "one").unwrap();

        move_within(&root, "a/n.md", "Projects/Alpha/n.md").unwrap();
        assert!(!root.join("a/n.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("Projects/Alpha/n.md")).unwrap(),
            "one"
        );
    }

    #[test]
    fn move_refuses_a_destination_outside_the_vault() {
        let root = tmp("move-escape");
        fs::write(root.join("n.md"), "one").unwrap();
        assert!(move_within(&root, "n.md", "../stolen.md").is_err());
        assert!(root.join("n.md").exists());
    }

    #[test]
    fn walk_dirs_skips_storage_directories() {
        let root = tmp("walk");
        fs::create_dir_all(root.join("Rapat/2026-09-04")).unwrap();
        fs::create_dir_all(root.join(TRASH)).unwrap();
        fs::create_dir_all(root.join(TRANSCRIPT)).unwrap();
        let mut out = Vec::new();
        walk_dirs(&root, &root, &mut out).unwrap();
        out.sort();
        // `.trash` and `.transcript` are storage, not places a note belongs.
        assert_eq!(
            out,
            vec!["Rapat".to_string(), "Rapat/2026-09-04".to_string()]
        );
    }

    #[test]
    fn open_external_refuses_anything_that_is_not_a_web_url() {
        // The argument comes from the WebView, which renders note content. On
        // macOS `open` will happily launch a file or an application, so the
        // scheme is the only thing standing between a note and the shell.
        for bad in [
            "file:///etc/passwd",
            "/Applications/Calculator.app",
            "javascript:alert(1)",
            "ftp://example.com",
            "",
        ] {
            assert!(open_external(bad.into()).is_err(), "allowed: {bad}");
        }
    }

    #[test]
    fn probe_reports_a_folder_without_touching_it() {
        let dir = tmp("probe");
        fs::write(dir.join("a.md"), "# one").unwrap();
        fs::write(dir.join("b.md"), "# two").unwrap();
        let probe = probe_vault_root(dir.to_string_lossy().into_owned());
        assert!(probe.exists);
        assert_eq!(probe.markdown, 2);
        assert!(!probe.is_vault);
        // The whole point: nothing was created by looking.
        assert!(!dir.join(TRANSCRIPT).exists());
    }

    #[test]
    fn probe_recognises_an_existing_vault_and_a_missing_folder() {
        let dir = tmp("probe-vault");
        fs::create_dir_all(dir.join(TRANSCRIPT)).unwrap();
        assert!(probe_vault_root(dir.to_string_lossy().into_owned()).is_vault);

        let gone = probe_vault_root(dir.join("nope").to_string_lossy().into_owned());
        assert!(!gone.exists);
        assert_eq!(gone.markdown, 0);
    }
}

/// Hand a URL to the operating system's browser.
///
/// Deliberately not a Tauri plugin: this is one `Command` and a scheme check,
/// and a plugin would mean a crate, a capability entry and a wider surface for
/// the sake of it.
///
/// The scheme check is the point. The argument arrives from the WebView, and
/// the WebView renders note content — without it, a crafted string could reach
/// the shell through `open`/`xdg-open`, which happily launch files and
/// applications, not just web pages.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("refusing to open a non-web URL: {url}"));
    }
    let launcher = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(launcher)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
