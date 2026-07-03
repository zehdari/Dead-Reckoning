//! Desktop backend: the same tiny file API the dev server exposes over HTTP
//! (server/fsApi.ts), as Tauri commands — plus app-local state files for
//! settings/viz data that belong to the app rather than next to the config.

use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::Manager;

/// Same policy as the dev-server API: only absolute paths under the user's
/// home directory or /tmp are reachable from the UI. `..` segments are
/// rejected rather than resolved.
fn check_allowed(path: &str, home: &Path) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let dotdot = p.components().any(|c| matches!(c, Component::ParentDir));
    if p.is_absolute() && !dotdot && (p.starts_with(home) || p.starts_with("/tmp")) {
        Ok(p)
    } else {
        Err(format!("path not allowed: {path}"))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    home: String,
    default_config_path: String,
    default_config_exists: bool,
}

#[tauri::command]
fn env_info(app: tauri::AppHandle) -> Result<EnvInfo, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let default =
        home.join("osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml");
    Ok(EnvInfo {
        home: home.to_string_lossy().into_owned(),
        default_config_exists: default.exists(),
        default_config_path: default.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let p = check_allowed(&path, &home)?;
    fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))
}

#[tauri::command]
fn write_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let p = check_allowed(&path, &home)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| format!("{}: {e}", p.display()))
}

/// App-local state files (per-config viz state, future settings) live under
/// the platform app-data dir, e.g. ~/.local/share/edu.osu.uwrt.deadreckoning/state.
/// Keys are bare file names chosen by the frontend; anything path-like is rejected.
fn state_file(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let ok = !key.is_empty()
        && !key.starts_with('.')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(format!("bad state key: {key}"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(key))
}

#[tauri::command]
fn read_app_state(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let p = state_file(&app, &key)?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_app_state(app: tauri::AppHandle, key: String, content: String) -> Result<(), String> {
    let p = state_file(&app, &key)?;
    fs::write(&p, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            env_info,
            read_file,
            write_file,
            read_app_state,
            write_app_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
