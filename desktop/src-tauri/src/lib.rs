pub mod client_config;
pub mod hasher;
pub mod macos_keychain;
pub mod webdav_mount;

use client_config::{
    MacClientConfig, NativeUploadResult, ServerProbeResult,
};
use hasher::{ChunkHashResult, LocalFileBlake3Report};
use macos_keychain::KeychainStatus;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State, WindowEvent};
use webdav_mount::MountStatus;

pub struct AppClientState {
    pub config: Mutex<MacClientConfig>,
}

/// Native Rust command exposed to WebView on macOS, Windows, Linux, and Android
/// for high-speed BLAKE3 file chunk hashing and P2P deduplication checks.
#[tauri::command]
fn compute_chunk_blake3(payload: Vec<u8>) -> ChunkHashResult {
    hasher::hash_buffer(&payload)
}

/// Streams a local file in 4MB chunks and returns full & per-block BLAKE3 digests.
#[tauri::command]
fn hash_local_file_blake3(local_path: String) -> Result<LocalFileBlake3Report, String> {
    hasher::hash_local_file(Path::new(&local_path))
}

/// Returns current macOS client configuration, Keychain status, and WebDAV loopback status.
#[tauri::command]
fn get_macos_client_config(state: State<'_, AppClientState>) -> MacClientConfig {
    state
        .config
        .lock()
        .map(|c| c.clone())
        .unwrap_or_else(|_| client_config::load_config())
}

/// Updates and persists the macOS client configuration.
#[tauri::command]
fn save_macos_client_config(
    config: MacClientConfig,
    state: State<'_, AppClientState>,
) -> Result<MacClientConfig, String> {
    client_config::save_config(&config)?;
    if let Ok(mut guard) = state.config.lock() {
        *guard = config.clone();
    }
    Ok(config)
}

/// Probes a remote or LAN MayaDesk server endpoint and persists it if reachable.
#[tauri::command]
async fn probe_and_save_server(
    server_url: String,
    state: State<'_, AppClientState>,
) -> Result<ServerProbeResult, String> {
    let res = client_config::probe_server_endpoint(&server_url).await;
    if let Ok(mut guard) = state.config.lock() {
        guard.server_url = res.normalized_url.clone();
        let _ = client_config::save_config(&guard);
    }
    Ok(res)
}

/// Stores JWT token safely in macOS Keychain (`com.mayadesk.clouddrive`).
#[tauri::command]
fn keychain_set_token(account: String, token: String) -> Result<KeychainStatus, String> {
    macos_keychain::set_password(&account, &token)?;
    Ok(macos_keychain::inspect_status(&account))
}

/// Reads JWT token from macOS Keychain.
#[tauri::command]
fn keychain_get_token(account: String) -> Option<String> {
    macos_keychain::get_password(&account)
}

/// Removes JWT token from macOS Keychain.
#[tauri::command]
fn keychain_delete_token(account: String) -> Result<KeychainStatus, String> {
    macos_keychain::delete_password(&account)?;
    Ok(macos_keychain::inspect_status(&account))
}

/// Inspects macOS Keychain status for the current account.
#[tauri::command]
fn keychain_get_status(account: String) -> KeychainStatus {
    macos_keychain::inspect_status(&account)
}

/// Starts the local loopback WebDAV bridge (`127.0.0.1:18085`) and optionally mounts in Finder.
#[tauri::command]
async fn start_webdav_bridge(
    open_finder: bool,
    state: State<'_, AppClientState>,
) -> Result<MountStatus, String> {
    let (port, mount_point) = state
        .config
        .lock()
        .map(|c| (c.webdav_port, c.finder_mount_point.clone()))
        .unwrap_or((18085, "/Volumes/MayaDesk".to_string()));
    webdav_mount::mount_in_finder(port, &mount_point, open_finder).await
}

/// Queries current loopback WebDAV bridge & Finder mount status.
#[tauri::command]
fn get_webdav_status(state: State<'_, AppClientState>) -> MountStatus {
    let (port, mount_point) = state
        .config
        .lock()
        .map(|c| (c.webdav_port, c.finder_mount_point.clone()))
        .unwrap_or((18085, "/Volumes/MayaDesk".to_string()));
    webdav_mount::check_mount_status(port, &mount_point)
}

/// Reveals a local path in macOS Finder (`open -R`).
#[tauri::command]
fn reveal_path_in_finder(local_path: String) -> Result<(), String> {
    webdav_mount::reveal_in_finder(&local_path)
}

/// Opens a native macOS file or folder picker dialog.
#[tauri::command]
fn pick_macos_path(choose_folder: bool) -> Result<Option<String>, String> {
    webdav_mount::pick_local_path_dialog(choose_folder)
}

/// Uploads a local file from macOS directly to the configured MayaDesk server using 4MB chunks.
#[tauri::command]
async fn native_upload_file(
    space: String,
    remote_dir: String,
    local_path: String,
    token: Option<String>,
    state: State<'_, AppClientState>,
) -> Result<NativeUploadResult, String> {
    let server_url = state
        .config
        .lock()
        .map(|c| c.server_url.clone())
        .unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
    client_config::upload_local_file_native(&server_url, &space, &remote_dir, &local_path, token)
        .await
}

/// Synchronizes the native macOS NSWindow appearance ('system' | 'light' | 'dark').
#[tauri::command]
fn set_macos_window_theme(
    theme_mode: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppClientState>,
) -> Result<(), String> {
    let tauri_theme = match theme_mode.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None, // None follows macOS system appearance automatically
    };
    let _ = window.set_theme(tauri_theme);
    if let Ok(mut guard) = state.config.lock() {
        guard.theme_mode = theme_mode;
        let _ = client_config::save_config(&guard);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_cfg = client_config::load_config();
    let initial_port = initial_cfg.webdav_port;

    tauri::Builder::default()
        .manage(AppClientState {
            config: Mutex::new(initial_cfg),
        })
        .setup(move |_app| {
            // Automatically start local loopback WebDAV bridge in background
            tauri::async_runtime::spawn(async move {
                let _ = webdav_mount::ensure_loopback_webdav_bridge(initial_port).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .app_handle()
                    .try_state::<AppClientState>()
                    .and_then(|st| st.config.lock().ok().map(|c| c.close_to_tray))
                    .unwrap_or(false);

                #[cfg(target_os = "macos")]
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            compute_chunk_blake3,
            hash_local_file_blake3,
            get_macos_client_config,
            save_macos_client_config,
            probe_and_save_server,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            keychain_get_status,
            start_webdav_bridge,
            get_webdav_status,
            reveal_path_in_finder,
            pick_macos_path,
            native_upload_file,
            set_macos_window_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MayaDesk Tauri application");
}
