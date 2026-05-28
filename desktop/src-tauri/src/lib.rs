use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Error as IoError, ErrorKind, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    str,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::menu::MenuBuilder;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[cfg(target_os = "macos")]
mod macos_notifications {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    use std::sync::{Mutex, OnceLock};

    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    const ERROR_BUFFER_LEN: usize = 1024;

    unsafe extern "C" {
        fn cchh_notification_authorization_status(
            error_buffer: *mut c_char,
            error_buffer_len: usize,
        ) -> c_int;
        fn cchh_request_notification_authorization(
            error_buffer: *mut c_char,
            error_buffer_len: usize,
        ) -> bool;
        fn cchh_send_user_notification(
            title: *const c_char,
            body: *const c_char,
            target: *const c_char,
            error_buffer: *mut c_char,
            error_buffer_len: usize,
        ) -> bool;
        fn cchh_set_notification_response_callback(callback: Option<extern "C" fn(*const c_char)>);
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NotificationClickPayload {
        target: Option<String>,
    }

    static NOTIFICATION_APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

    fn new_error_buffer() -> [c_char; ERROR_BUFFER_LEN] {
        [0; ERROR_BUFFER_LEN]
    }

    fn read_error(buffer: &[c_char; ERROR_BUFFER_LEN]) -> Option<String> {
        let message = unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .trim()
            .to_string();
        if message.is_empty() {
            None
        } else {
            Some(message)
        }
    }

    fn permission_from_status(status: c_int) -> &'static str {
        match status {
            1 => "denied",
            2 | 3 | 4 => "granted",
            _ => "default",
        }
    }

    pub fn permission_state() -> Result<String, String> {
        let mut error_buffer = new_error_buffer();
        let status = unsafe {
            cchh_notification_authorization_status(error_buffer.as_mut_ptr(), ERROR_BUFFER_LEN)
        };

        if status < 0 {
            return Err(read_error(&error_buffer)
                .unwrap_or_else(|| "failed to read macOS notification permission".to_string()));
        }

        Ok(permission_from_status(status).to_string())
    }

    pub fn request_permission() -> Result<String, String> {
        let mut error_buffer = new_error_buffer();
        let granted = unsafe {
            cchh_request_notification_authorization(error_buffer.as_mut_ptr(), ERROR_BUFFER_LEN)
        };

        if granted {
            return Ok("granted".to_string());
        }

        if let Some(error) = read_error(&error_buffer) {
            return Err(error);
        }

        permission_state()
    }

    extern "C" fn handle_notification_response(target: *const c_char) {
        let target = if target.is_null() {
            None
        } else {
            let value = unsafe { CStr::from_ptr(target) }
                .to_string_lossy()
                .trim()
                .to_string();
            (!value.is_empty()).then_some(value)
        };

        let Some(app) = NOTIFICATION_APP_HANDLE
            .get()
            .and_then(|handle| handle.lock().ok().and_then(|guard| guard.clone()))
        else {
            return;
        };

        super::show_main_window(&app);
        let _ = app.emit(
            "desktop-notification-clicked",
            NotificationClickPayload { target },
        );
    }

    pub fn install_click_handler(app: AppHandle) {
        let handle = NOTIFICATION_APP_HANDLE.get_or_init(|| Mutex::new(None));
        if let Ok(mut guard) = handle.lock() {
            *guard = Some(app);
        }
        unsafe { cchh_set_notification_response_callback(Some(handle_notification_response)) };
    }

    pub fn send_notification(
        title: String,
        body: Option<String>,
        target: Option<String>,
    ) -> Result<bool, String> {
        let title = CString::new(title)
            .map_err(|_| "notification title contains an unsupported NUL byte".to_string())?;
        let body = body
            .map(CString::new)
            .transpose()
            .map_err(|_| "notification body contains an unsupported NUL byte".to_string())?;
        let target = target
            .map(CString::new)
            .transpose()
            .map_err(|_| "notification target contains an unsupported NUL byte".to_string())?;

        let mut error_buffer = new_error_buffer();
        let sent = unsafe {
            cchh_send_user_notification(
                title.as_ptr(),
                body.as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                target
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                error_buffer.as_mut_ptr(),
                ERROR_BUFFER_LEN,
            )
        };

        if sent {
            return Ok(true);
        }

        match read_error(&error_buffer).as_deref() {
            Some("not_authorized") | None => Ok(false),
            Some(error) => Err(error.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_notifications {
    use tauri::AppHandle;

    pub fn permission_state() -> Result<String, String> {
        Ok("unsupported".to_string())
    }

    pub fn request_permission() -> Result<String, String> {
        Ok("unsupported".to_string())
    }

    pub fn install_click_handler(_app: AppHandle) {}

    pub fn send_notification(
        _title: String,
        _body: Option<String>,
        _target: Option<String>,
    ) -> Result<bool, String> {
        Ok(false)
    }
}

const SERVER_STARTUP_LOG_LIMIT: usize = 80;
const SERVER_BIND_HOST: &str = "0.0.0.0";
const SERVER_CONTROL_HOST: &str = "127.0.0.1";
const MAIN_WINDOW_LABEL: &str = "main";

// Sidecar health check constants
// Interval: 60s between checks. Timeout: 5s per TCP probe.
// Max failures: 5 consecutive → triggers restart (5 × 60s = 5 min of unresponsiveness).
const HEALTH_CHECK_INTERVAL_SECS: u64 = 60;
const HEALTH_CHECK_TIMEOUT_SECS: u64 = 5;
const HEALTH_CHECK_MAX_FAILURES: u32 = 5;
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_QUIT_ID: &str = "tray_quit";
const WINDOW_STATE_FILE: &str = "window-state.json";
const TERMINAL_CONFIG_FILE: &str = "terminal-config.json";
const APP_MODE_FILE: &str = "app-mode.json";
const MIN_WINDOW_WIDTH: u32 = 960;
const MIN_WINDOW_HEIGHT: u32 = 640;
const MIN_VISIBLE_PIXELS: i64 = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AppMode {
    #[serde(alias = "Default")]
    Default,
    #[serde(alias = "Portable")]
    Portable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppModeConfig {
    #[serde(default = "default_app_mode")]
    mode: AppMode,
    #[serde(default)]
    portable_dir: Option<String>,
}

fn default_app_mode() -> AppMode {
    AppMode::Default
}

impl Default for AppModeConfig {
    fn default() -> Self {
        Self {
            mode: AppMode::Default,
            portable_dir: None,
        }
    }
}

/// Write the persisted app-mode.json to the given config directory.
fn write_app_mode_config(config_dir: &Path, config: &AppModeConfig) {
    let path = config_dir.join(APP_MODE_FILE);
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("[desktop] failed to create dir for app-mode.json: {e}");
            return;
        }
    }
    let data = match serde_json::to_string_pretty(config) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("[desktop] failed to serialize app-mode.json: {e}");
            return;
        }
    };
    if let Err(e) = fs::write(&path, data) {
        eprintln!("[desktop] failed to write app-mode.json: {e}");
    }
}

/// Check if a directory contains portable config/data files.
fn dir_has_portable_data(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    [
        "settings.json",
        ".claude.json",
        ".mcp.json",
        WINDOW_STATE_FILE,
        TERMINAL_CONFIG_FILE,
    ]
        .iter()
        .any(|f| dir.join(f).is_file())
        || dir.join("Cache").is_dir()
        || dir.join("EBWebView").is_dir()
        || dir.join("projects").is_dir()
        || dir.join("skills").is_dir()
        || dir.join("plugins").is_dir()
        || dir.join("cowork_plugins").is_dir()
        || dir.join("cc-haha").is_dir()
}

/// Resolve the default portable config directory: exe_dir/CLAUDE_CONFIG_DIR.
fn get_default_portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    dir.push("CLAUDE_CONFIG_DIR");
    Some(dir)
}

#[derive(Serialize, Deserialize)]
struct TerminalConfig {
    #[serde(default)]
    bash_path: Option<String>,
}

impl TerminalConfig {
    fn load(app: &AppHandle) -> Self {
        let path = match terminal_config_path(app) {
            Some(p) => p,
            None => return Self::default(),
        };
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        let Some(path) = terminal_config_path(app) else {
            return Err("terminal config path is unavailable".to_string());
        };
        if let Some(parent) = path.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                return Err(format!("create terminal config directory: {err}"));
            }
        }
        let data = match serde_json::to_string_pretty(self) {
            Ok(data) => data,
            Err(err) => {
                return Err(format!("serialize terminal config: {err}"));
            }
        };
        if let Err(err) = fs::write(&path, data) {
            return Err(format!("write terminal config: {err}"));
        }
        Ok(())
    }
}

fn terminal_config_path(app: &AppHandle) -> Option<PathBuf> {
    // honour CLAUDE_CONFIG_DIR for portable installs
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(|dir| PathBuf::from(&dir).join(TERMINAL_CONFIG_FILE))
        .or_else(|| match app.path().app_config_dir() {
            Ok(dir) => Some(dir.join(TERMINAL_CONFIG_FILE)),
            Err(err) => {
                eprintln!("[desktop] failed to resolve app config dir: {err}");
                None
            }
        })
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self { bash_path: None }
    }
}

#[derive(Default)]
struct ServerState(Mutex<ServerStatus>);

struct ServerRuntime {
    url: String,
    child: CommandChild,
}

#[derive(Default)]
struct ServerStatus {
    runtime: Option<ServerRuntime>,
    startup_error: Option<String>,
}

#[derive(Default)]
struct AppExitState {
    is_quitting: Mutex<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct StoredWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

/// 与 ServerState 平级的 adapter 子进程状态。
///
/// adapter sidecar（claude-sidecar adapters --telegram 等）的生命周期
/// 跟 server 不同：它没有 HTTP 端口可探活，没配凭据时会自己干净退出，
/// 而且需要支持运行时热重启 —— 用户在设置页保存 IM 凭据后，
/// 前端会通过 invoke('restart_adapters_sidecar') 来重启它，让新凭据生效。
#[derive(Default)]
struct AdapterState(Mutex<Vec<CommandChild>>);

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Serialize, Clone)]
struct TerminalSpawnResult {
    session_id: u32,
    shell: String,
    cwd: String,
}

#[derive(Serialize, Clone)]
struct TerminalOutputPayload {
    session_id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct TerminalExitPayload {
    session_id: u32,
    code: u32,
    signal: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopTerminalSettingsFile {
    desktop_terminal: Option<DesktopTerminalConfig>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopTerminalConfig {
    startup_shell: Option<String>,
    custom_shell_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalHostPlatform {
    Windows,
    Posix,
}

#[tauri::command]
fn get_server_url(state: State<'_, ServerState>) -> Result<String, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "desktop server state is unavailable".to_string())?;

    if let Some(runtime) = guard.runtime.as_ref() {
        return Ok(runtime.url.clone());
    }

    Err(guard
        .startup_error
        .clone()
        .unwrap_or_else(|| "desktop server did not start".to_string()))
}

/// 前端在设置页保存飞书 / Telegram / 微信凭据后调用，触发 adapter sidecar 热重启。
///
/// 流程：
///   1. kill 当前 adapter 子进程（如果在跑）
///   2. spawn 新的 adapter 子进程
///   3. 新 sidecar 内部的 loadConfig() 会读到最新的 ~/.claude/adapters.json
///      并重新建立 WebSocket 连接到飞书 / Telegram
///
/// 凭据缺失时 sidecar 自己会 warn + skip + 退出，所以这里不需要前置检查。
#[tauri::command]
fn restart_adapters_sidecar(app: AppHandle) -> Result<(), String> {
    stop_adapters_sidecar(&app);
    spawn_and_track_adapters_sidecar(&app);
    Ok(())
}

#[tauri::command]
fn prepare_for_update_install(app: AppHandle) -> Result<(), String> {
    mark_app_quitting(&app);
    stop_server_sidecar(&app);
    stop_adapters_sidecar(&app);

    #[cfg(target_os = "windows")]
    {
        kill_windows_sidecars();
    }

    // Give Windows a short moment to release executable file handles before the
    // updater starts replacing bundled sidecars in the install directory.
    std::thread::sleep(Duration::from_millis(750));
    Ok(())
}

#[tauri::command]
fn prepare_for_app_mode_restart(app: AppHandle) -> Result<(), String> {
    mark_app_quitting(&app);
    stop_server_sidecar(&app);
    stop_adapters_sidecar(&app);

    #[cfg(target_os = "windows")]
    {
        kill_windows_sidecars();
    }

    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

#[tauri::command]
fn cancel_update_install(app: AppHandle) -> Result<(), String> {
    clear_app_quitting(&app);
    Ok(())
}

/// Returns the current app mode and portable directory info.
#[tauri::command]
fn get_app_mode(app: AppHandle) -> serde_json::Value {
    let env_config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok().map(PathBuf::from);
    let active_config_dir = env_config_dir
        .clone()
        .or_else(|| app.path().app_config_dir().ok());
    let config_dir_source = if env_config_dir.is_some() {
        if std::env::var_os("CC_HAHA_APP_PORTABLE_DIR").is_some() {
            "portable"
        } else {
            "environment"
        }
    } else {
        "system"
    };
    let config_dir = env_config_dir.clone().or_else(get_default_portable_dir);

    serde_json::json!({
        "mode": if env_config_dir.is_some() { "portable" } else { "default" },
        "portableDir": config_dir.as_ref().and_then(|p| p.to_str()),
        "defaultPortableDir": get_default_portable_dir().as_ref().and_then(|p| p.to_str()),
        "activeConfigDir": active_config_dir.as_ref().and_then(|p| p.to_str()),
        "configDirSource": config_dir_source,
    })
}

/// Sets the app mode. Persists to app-mode.json in the current active config dir.
/// Requires restart to take effect.
#[tauri::command]
fn set_app_mode(
    app: tauri::AppHandle,
    mode: String,
    portable_dir: Option<String>,
) -> Result<(), String> {
    // 确定当前正在使用的配置目录
    let active_config_dir = if let Ok(cd) = std::env::var("CLAUDE_CONFIG_DIR") {
        std::path::PathBuf::from(&cd)
    } else {
        app.path()
            .app_config_dir()
            .map_err(|e| format!("resolve app config dir: {e}"))?
    };

    let (app_mode, portable_dir, target_portable_dir) = if mode == "portable" {
        let selected_dir = portable_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(get_default_portable_dir)
            .ok_or_else(|| "portable config directory is unavailable".to_string())?;

        if selected_dir.exists() && !selected_dir.is_dir() {
            return Err(format!(
                "portable config path is not a directory: {}",
                selected_dir.display()
            ));
        }

        fs::create_dir_all(&selected_dir)
            .map_err(|e| format!("create portable config directory: {e}"))?;

        let persisted_portable_dir = if get_default_portable_dir().as_ref() == Some(&selected_dir) {
            None
        } else {
            Some(selected_dir.to_string_lossy().to_string())
        };

        (
            AppMode::Portable,
            persisted_portable_dir,
            Some(selected_dir),
        )
    } else {
        (AppMode::Default, None, None)
    };

    let config = AppModeConfig {
        mode: app_mode,
        portable_dir: portable_dir.clone(),
    };

    // 写入当前活跃的配置目录
    write_app_mode_config(&active_config_dir, &config);

    if let Some(dir) = target_portable_dir.as_ref() {
        if dir != &active_config_dir {
            write_app_mode_config(dir, &config);
        }
    }

    // 修复：同时始终将模式状态写入系统默认配置目录，
    // 以防止应用层切换模式后，main.rs在下一次启动时读取到旧的系统全局状态
    if let Ok(sys_dir) = app.path().app_config_dir() {
        if sys_dir != active_config_dir {
            write_app_mode_config(&sys_dir, &config);
        }
    }

    Ok(())
}

/// Checks if the default portable directory has existing data files.
#[tauri::command]
fn detect_portable_dir() -> serde_json::Value {
    let default_portable = get_default_portable_dir();
    let has_data = default_portable
        .as_ref()
        .map(|d| dir_has_portable_data(d))
        .unwrap_or(false);
    serde_json::json!({
        "defaultPortableDir": default_portable.as_ref().and_then(|p| p.to_str()),
        "hasData": has_data,
    })
}

fn set_app_quitting(app: &AppHandle, next: bool) {
    if let Some(state) = app.try_state::<AppExitState>() {
        if let Ok(mut is_quitting) = state.is_quitting.lock() {
            *is_quitting = next;
        }
    }
}

fn mark_app_quitting(app: &AppHandle) {
    set_app_quitting(app, true);
}

fn clear_app_quitting(app: &AppHandle) {
    set_app_quitting(app, false);
}

fn should_hide_to_tray(app: &AppHandle, label: &str) -> bool {
    if label != MAIN_WINDOW_LABEL {
        return false;
    }

    app.try_state::<AppExitState>()
        .and_then(|state| state.is_quitting.lock().ok().map(|value| !*value))
        .unwrap_or(true)
}

fn is_persistable_window_state(state: &StoredWindowState) -> bool {
    state.width >= MIN_WINDOW_WIDTH && state.height >= MIN_WINDOW_HEIGHT
}

fn has_meaningful_intersection(
    state: &StoredWindowState,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> bool {
    let left = state.x as i64;
    let top = state.y as i64;
    let right = left + state.width as i64;
    let bottom = top + state.height as i64;

    let monitor_left = monitor_x as i64;
    let monitor_top = monitor_y as i64;
    let monitor_right = monitor_left + monitor_width as i64;
    let monitor_bottom = monitor_top + monitor_height as i64;

    right > monitor_left + MIN_VISIBLE_PIXELS
        && bottom > monitor_top + MIN_VISIBLE_PIXELS
        && left < monitor_right - MIN_VISIBLE_PIXELS
        && top < monitor_bottom - MIN_VISIBLE_PIXELS
}

fn is_window_state_visible_on_any_monitor(
    state: &StoredWindowState,
    monitors: &[tauri::Monitor],
) -> bool {
    if monitors.is_empty() {
        return true;
    }

    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        has_meaningful_intersection(state, position.x, position.y, size.width, size.height)
    })
}

fn window_state_path(app: &AppHandle) -> Option<PathBuf> {
    // honour CLAUDE_CONFIG_DIR so portable installs keep window-state.json
    // and terminal-config.json alongside the config dir instead of
    // %APPDATA%\com.claude-code-haha.desktop\.
    resolve_portable_state_path().or_else(|| match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(WINDOW_STATE_FILE)),
        Err(err) => {
            eprintln!("[desktop] failed to resolve app config dir: {err}");
            None
        }
    })
}

fn resolve_portable_state_path() -> Option<PathBuf> {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(|dir| PathBuf::from(&dir).join(WINDOW_STATE_FILE))
}

fn read_stored_window_state(app: &AppHandle) -> Option<StoredWindowState> {
    let path = window_state_path(app)?;
    let data = match fs::read_to_string(&path) {
        Ok(data) => data,
        Err(err) if err.kind() == ErrorKind::NotFound => return None,
        Err(err) => {
            eprintln!(
                "[desktop] failed to read window state {}: {err}",
                path.display()
            );
            return None;
        }
    };

    match serde_json::from_str::<StoredWindowState>(&data) {
        Ok(state) if is_persistable_window_state(&state) => Some(state),
        Ok(_) => None,
        Err(err) => {
            eprintln!(
                "[desktop] failed to parse window state {}: {err}",
                path.display()
            );
            None
        }
    }
}

fn write_stored_window_state(app: &AppHandle, state: &StoredWindowState) {
    if !is_persistable_window_state(state) {
        return;
    }

    let Some(path) = window_state_path(app) else {
        return;
    };

    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!(
                "[desktop] failed to create window state directory {}: {err}",
                parent.display()
            );
            return;
        }
    }

    let data = match serde_json::to_string_pretty(state) {
        Ok(data) => data,
        Err(err) => {
            eprintln!("[desktop] failed to serialize window state: {err}");
            return;
        }
    };

    if let Err(err) = fs::write(&path, data) {
        eprintln!(
            "[desktop] failed to write window state {}: {err}",
            path.display()
        );
    }
}

fn capture_window_state(window: &tauri::WebviewWindow) -> Option<StoredWindowState> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }

    let position = match window.outer_position() {
        Ok(position) => position,
        Err(err) => {
            eprintln!("[desktop] failed to read window position: {err}");
            return None;
        }
    };
    let size = match window.outer_size() {
        Ok(size) => size,
        Err(err) => {
            eprintln!("[desktop] failed to read window size: {err}");
            return None;
        }
    };

    let state = StoredWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };

    is_persistable_window_state(&state).then_some(state)
}

fn save_main_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let Some(state) = capture_window_state(&window) else {
        return;
    };

    write_stored_window_state(app, &state);
}

fn restore_main_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let Some(state) = read_stored_window_state(app) else {
        return;
    };

    let monitors = window.available_monitors().unwrap_or_default();
    if !is_window_state_visible_on_any_monitor(&state, &monitors) {
        return;
    }

    let _ = window.unmaximize();
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    if state.maximized {
        let _ = window.maximize();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_ID, "Show Claude Code Haha")
        .separator()
        .text(TRAY_QUIT_ID, "Quit Claude Code Haha")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Claude Code Haha")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_QUIT_ID => {
                mark_app_quitting(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;

    Ok(())
}

#[tauri::command]
fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<TerminalSpawnResult, String> {
    let cwd_path = resolve_terminal_cwd(cwd)?;
    let shell = resolved_terminal_shell(&app)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("open terminal pty: {err}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(cwd_path.as_os_str());
    for (key, value) in terminal_environment(&shell) {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("spawn terminal shell: {err}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("clone terminal reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("open terminal writer: {err}"))?;
    let killer = child.clone_killer();
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal state is unavailable".to_string())?;
        sessions.insert(
            session_id,
            TerminalSession {
                master: pair.master,
                writer: Mutex::new(writer),
                killer: Mutex::new(killer),
            },
        );
    }

    let output_app = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_terminal_output(&mut pending_utf8, &buffer[..n]);
                    if !data.is_empty() {
                        let _ = output_app.emit(
                            "terminal-output",
                            TerminalOutputPayload { session_id, data },
                        );
                    }
                }
                Err(err) => {
                    let _ = output_app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            session_id,
                            data: format!("\r\n[terminal read error: {err}]\r\n"),
                        },
                    );
                    break;
                }
            }
        }
        if !pending_utf8.is_empty() {
            let data = String::from_utf8_lossy(&pending_utf8).to_string();
            let _ = output_app.emit(
                "terminal-output",
                TerminalOutputPayload { session_id, data },
            );
        }
    });

    let exit_app = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        if let Some(state) = exit_app.try_state::<TerminalState>() {
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&session_id);
            }
        }
        match status {
            Ok(status) => {
                let _ = exit_app.emit(
                    "terminal-exit",
                    TerminalExitPayload {
                        session_id,
                        code: status.exit_code(),
                        signal: status.signal().map(ToString::to_string),
                    },
                );
            }
            Err(err) => {
                let _ = exit_app.emit(
                    "terminal-output",
                    TerminalOutputPayload {
                        session_id,
                        data: format!("\r\n[terminal wait error: {err}]\r\n"),
                    },
                );
            }
        }
    });

    Ok(TerminalSpawnResult {
        session_id,
        shell,
        cwd: cwd_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: u32,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer is unavailable".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("write terminal input: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("flush terminal input: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("resize terminal: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_kill(state: State<'_, TerminalState>, session_id: u32) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal state is unavailable".to_string())?;
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        let mut killer = session
            .killer
            .lock()
            .map_err(|_| "terminal killer is unavailable".to_string())?;
        killer
            .kill()
            .map_err(|err| format!("kill terminal shell: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_terminal_bash_path(app: AppHandle) -> Option<String> {
    let config = TerminalConfig::load(&app);
    config.bash_path
}

#[tauri::command]
fn set_terminal_bash_path(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let mut config = TerminalConfig::load(&app);
    config.bash_path = normalize_terminal_bash_path(path)?;
    config.save(&app)
}

#[tauri::command]
async fn macos_notification_permission_state() -> Result<String, String> {
    run_notification_bridge(macos_notifications::permission_state).await
}

#[tauri::command]
async fn macos_request_notification_permission() -> Result<String, String> {
    run_notification_bridge(macos_notifications::request_permission).await
}

#[tauri::command]
async fn macos_send_notification(
    title: String,
    body: Option<String>,
    target: Option<String>,
) -> Result<bool, String> {
    run_notification_bridge(move || macos_notifications::send_notification(title, body, target))
        .await
}

#[tauri::command]
fn open_windows_notification_settings() -> Result<bool, String> {
    open_windows_notification_settings_impl()
}

#[tauri::command]
fn set_app_zoom(window: tauri::WebviewWindow, zoom_factor: f64) -> Result<(), String> {
    let clamped = zoom_factor.clamp(0.5, 2.0);
    window
        .set_zoom(clamped)
        .map_err(|err| format!("set app zoom: {err}"))
}

#[cfg(target_os = "windows")]
fn open_windows_notification_settings_impl() -> Result<bool, String> {
    StdCommand::new("explorer.exe")
        .arg("ms-settings:notifications")
        .spawn()
        .map_err(|err| format!("open Windows notification settings: {err}"))?;

    Ok(true)
}

#[cfg(not(target_os = "windows"))]
fn open_windows_notification_settings_impl() -> Result<bool, String> {
    Ok(false)
}

async fn run_notification_bridge<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|err| format!("notification bridge worker failed: {err}"))?
}

fn decode_terminal_output(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut output = String::new();

    loop {
        match str::from_utf8(pending) {
            Ok(text) => {
                output.push_str(text);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let text = str::from_utf8(&pending[..valid_up_to])
                        .expect("valid_up_to marks a valid UTF-8 prefix");
                    output.push_str(text);
                    pending.drain(..valid_up_to);
                    continue;
                }

                match err.error_len() {
                    Some(error_len) => {
                        output.push('\u{fffd}');
                        pending.drain(..error_len);
                    }
                    None => break,
                }
            }
        }
    }

    output
}

fn terminal_environment(shell: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.extend(login_shell_environment(shell));
    ensure_utf8_locale(&mut env);
    env
}

fn ensure_utf8_locale(env: &mut HashMap<String, String>) {
    let fallback = default_utf8_locale();
    for key in ["LANG", "LC_CTYPE", "LC_ALL"] {
        let needs_fallback = env
            .get(key)
            .map(|value| !is_utf8_locale(value))
            .unwrap_or(true);
        if needs_fallback {
            env.insert(key.to_string(), fallback.to_string());
        }
    }
}

fn is_utf8_locale(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase().replace('-', "");
    normalized.contains("utf8")
}

fn default_utf8_locale() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "en_US.UTF-8"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "C.UTF-8"
    }
    #[cfg(not(unix))]
    {
        "C.UTF-8"
    }
}

#[cfg(not(target_os = "windows"))]
fn login_shell_environment(shell: &str) -> HashMap<String, String> {
    let Ok(mut child) = StdCommand::new(shell)
        .args(["-l", "-c", "env -0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashMap::new();
    };

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return HashMap::new();
                }
                let mut stdout = Vec::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_end(&mut stdout);
                }
                return parse_env_block(&stdout);
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return HashMap::new();
            }
            Err(_) => return HashMap::new(),
        }
    }
}

#[cfg(target_os = "windows")]
fn login_shell_environment(_shell: &str) -> HashMap<String, String> {
    HashMap::new()
}

fn parse_env_block(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let equals = entry.iter().position(|byte| *byte == b'=')?;
            if equals == 0 {
                return None;
            }
            let key = String::from_utf8_lossy(&entry[..equals]).to_string();
            let value = String::from_utf8_lossy(&entry[equals + 1..]).to_string();
            Some((key, value))
        })
        .collect()
}

fn resolve_terminal_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = match cwd.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    }) {
        Some(path) => path,
        None => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(home_dir)
            .unwrap_or(
                std::env::current_dir()
                    .map_err(|err| format!("resolve current directory: {err}"))?,
            ),
    };

    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("terminal cwd does not exist: {}", path.display()))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|path| path.join(".claude")))
}

fn desktop_terminal_settings_path() -> Option<PathBuf> {
    claude_config_dir().map(|path| path.join("settings.json"))
}

fn read_desktop_terminal_config() -> Option<DesktopTerminalConfig> {
    let path = desktop_terminal_settings_path()?;
    let contents = fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<DesktopTerminalSettingsFile>(&contents).ok()?;
    settings.desktop_terminal
}

fn resolved_terminal_shell(app: &AppHandle) -> Result<String, String> {
    let terminal_config = TerminalConfig::load(app);
    let system_default = default_shell(terminal_config.bash_path.as_deref());
    let platform = current_terminal_host_platform();
    let configured = read_desktop_terminal_config();
    let override_shell =
        resolve_desktop_terminal_shell(platform, configured.as_ref(), &system_default)?;
    Ok(override_shell.unwrap_or(system_default))
}

fn current_terminal_host_platform() -> TerminalHostPlatform {
    #[cfg(target_os = "windows")]
    {
        TerminalHostPlatform::Windows
    }
    #[cfg(not(target_os = "windows"))]
    {
        TerminalHostPlatform::Posix
    }
}

fn resolve_desktop_terminal_shell(
    platform: TerminalHostPlatform,
    config: Option<&DesktopTerminalConfig>,
    _system_default: &str,
) -> Result<Option<String>, String> {
    if platform != TerminalHostPlatform::Windows {
        return Ok(None);
    }

    let Some(config) = config else {
        return Ok(None);
    };

    let Some(startup_shell) = config.startup_shell.as_deref().map(str::trim) else {
        return Ok(None);
    };

    match startup_shell {
        "" | "system" => Ok(None),
        "pwsh" => Ok(Some("pwsh.exe".to_string())),
        "powershell" => Ok(Some("powershell.exe".to_string())),
        "cmd" => Ok(Some("cmd.exe".to_string())),
        "custom" => {
            let path = config
                .custom_shell_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "custom terminal shell path is empty".to_string())?;
            Ok(Some(path.to_string()))
        }
        _ => Ok(None),
    }
}

fn normalize_terminal_bash_path(path: Option<String>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let bash_path = PathBuf::from(trimmed);
    if !bash_path.is_file() {
        return Err(format!("terminal bash path does not exist: {trimmed}"));
    }
    Ok(Some(trimmed.to_string()))
}

fn default_shell(_custom_bash: Option<&str>) -> String {
    // On Windows, use configured bash path if set and valid
    #[cfg(target_os = "windows")]
    if let Some(bash_path) = _custom_bash {
        let trimmed = bash_path.trim();
        if !trimmed.is_empty() && PathBuf::from(trimmed).is_file() {
            return trimmed.to_string();
        }
    }

    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if PathBuf::from("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
    }
}

fn reserve_local_port(bind_host: &str) -> Result<u16, String> {
    let listener = TcpListener::bind(format!("{bind_host}:0"))
        .map_err(|err| format!("bind local port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("read local port: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(url_host: &str, port: u16) -> Result<(), String> {
    let addr: SocketAddr = format!("{url_host}:{port}")
        .parse()
        .map_err(|err| format!("parse server address: {err}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);

    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    Err(format!(
        "desktop server did not start listening on {url_host}:{port} within 10 seconds"
    ))
}

/// Check if the server is responsive via TCP connect (same mechanism as wait_for_server).
fn check_server_health(url_host: &str, port: u16) -> bool {
    let addr: SocketAddr = match format!("{url_host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_secs(HEALTH_CHECK_TIMEOUT_SECS)).is_ok()
}

/// Kill a process and all its child processes (entire process tree).
///
/// On Windows: uses `taskkill /T /F /PID <pid>` — /T kills the tree, /F forces.
/// On Unix: sends SIGKILL to the process (children will get SIGHUP when parent dies).
fn kill_process_tree(child: &CommandChild) {
    let _ = child.kill();

    #[cfg(target_os = "windows")]
    {
        // child.pid() returns the PID. taskkill /T kills the entire process tree.
        let pid = child.pid();
        if pid > 0 {
            let _ = StdCommand::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    #[cfg(unix)]
    {
        // On Unix, sending SIGTERM/SIGKILL to the direct child is usually enough
        // since Bun.spawn creates a process group. The kill() from tauri-plugin-shell
        // already sent SIGKILL. If children linger, the OS will reap them on parent exit.
    }
}

/// Spawn a background thread that periodically health-checks the server sidecar.
/// After `HEALTH_CHECK_MAX_FAILURES` consecutive failures, kill and respawn the sidecar.
///
/// **Limitations**: Restarting the sidecar will break active WebSocket connections
/// and orphan any running CLI subprocesses. The frontend will need to reconnect.
/// This is a last-resort recovery mechanism — the high failure threshold (5 min of
/// continuous unresponsiveness) ensures it only triggers when the sidecar is truly stuck.
fn spawn_sidecar_health_check(app: &AppHandle) {
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut consecutive_failures: u32 = 0;

        loop {
            thread::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS));

            // Read the current server URL from state
            let url = {
                let Some(state) = app_handle.try_state::<ServerState>() else {
                    continue;
                };
                let Ok(guard) = state.0.lock() else {
                    continue;
                };
                match &guard.runtime {
                    Some(rt) => rt.url.clone(),
                    None => continue, // No runtime — server might be starting up
                }
            };

            // Parse host:port from the URL (format: "http://127.0.0.1:PORT")
            let parsed = url
                .strip_prefix("http://")
                .or_else(|| url.strip_prefix("https://"))
                .unwrap_or(&url);
            let (host, port_str) = match parsed.rsplit_once(':') {
                Some(pair) => pair,
                None => continue,
            };
            let port: u16 = match port_str.parse() {
                Ok(p) => p,
                Err(_) => continue,
            };

            if check_server_health(host, port) {
                consecutive_failures = 0;
                continue;
            }

            consecutive_failures += 1;
            eprintln!(
                "[desktop] sidecar health check failed ({consecutive_failures}/{HEALTH_CHECK_MAX_FAILURES})"
            );

            if consecutive_failures < HEALTH_CHECK_MAX_FAILURES {
                continue;
            }

            // Threshold reached — restart the sidecar
            eprintln!("[desktop] sidecar unresponsive after {HEALTH_CHECK_MAX_FAILURES} consecutive failures, restarting...");
            consecutive_failures = 0;

            let Some(state) = app_handle.try_state::<ServerState>() else {
                continue;
            };
            let Ok(mut guard) = state.0.lock() else {
                continue;
            };

            // Kill the old sidecar and all its child CLI processes
            if let Some(old_runtime) = guard.runtime.take() {
                kill_process_tree(&old_runtime.child);
            }

            // Respawn
            match start_server_sidecar(&app_handle) {
                Ok(new_runtime) => {
                    guard.runtime = Some(new_runtime);
                    guard.startup_error = None;
                    eprintln!("[desktop] sidecar restarted successfully");
                }
                Err(err) => {
                    eprintln!("[desktop] failed to restart sidecar: {err}");
                    guard.startup_error = Some(err);
                }
            }
        }
    });
}

fn push_server_startup_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return;
    }

    let Ok(mut guard) = logs.lock() else {
        return;
    };
    if guard.len() >= SERVER_STARTUP_LOG_LIMIT {
        guard.pop_front();
    }
    guard.push_back(line);
}

fn format_server_startup_error(message: &str, logs: &Arc<Mutex<VecDeque<String>>>) -> String {
    let log_text = logs
        .lock()
        .ok()
        .map(|guard| guard.iter().cloned().collect::<Vec<_>>().join("\n"))
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "No server stdout/stderr was captured before the timeout.".to_string());

    format!("{message}\n\nRecent server logs:\n{log_text}")
}

fn resolve_app_root(_app: &AppHandle) -> Result<PathBuf, String> {
    // 历史用途：此前 sidecar launcher 用 dynamic file:// import 加载磁盘上
    // 的 src/server/index.ts 和 preload.ts，所以 Tauri 必须把整个 src/ +
    // node_modules/ 当 Resource 一起 ship 到 .app/Contents/Resources/app/。
    //
    // 现在 launcher 改成静态 import + bun build --compile 整棵静态打进二进制，
    // sidecar 不再读磁盘上的 src/ 或 node_modules/。CLAUDE_APP_ROOT 现在
    // 只剩一个名义上的"app 安装根目录"作用，给 conversationService 在
    // spawn CLI 子进程时通过 --app-root 透传。
    //
    // 我们直接用当前可执行文件所在目录作为 app_root：
    //   Dev:  desktop/src-tauri/target/<profile>/  （rust 跑出来的 binary 那一层）
    //   Prod: <App>.app/Contents/MacOS/             （sidecar 二进制的同级目录）
    let exe = std::env::current_exe().map_err(|err| format!("resolve current exe path: {err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current exe has no parent dir".to_string())?
        .to_path_buf();
    Ok(dir)
}

fn select_h5_dist_dir(resource_dir: Option<&Path>, app_root: &Path) -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("_up_").join("dist"));
        candidates.push(resource_dir.join("dist"));
    }
    candidates.push(app_root.join("../Resources/_up_/dist"));
    candidates.push(app_root.join("../Resources/dist"));

    candidates
        .iter()
        .find(|candidate| candidate.join("index.html").is_file())
        .cloned()
        .unwrap_or_else(|| {
            resource_dir
                .map(|dir| dir.join("_up_").join("dist"))
                .unwrap_or_else(|| app_root.join("../Resources/_up_/dist"))
        })
}

fn resolve_h5_dist_dir(app: &AppHandle, app_root: &Path) -> PathBuf {
    let resource_dir = app.path().resource_dir().ok();
    select_h5_dist_dir(resource_dir.as_deref(), app_root)
}

fn start_server_sidecar(app: &AppHandle) -> Result<ServerRuntime, String> {
    let bind_host = SERVER_BIND_HOST;
    let control_host = SERVER_CONTROL_HOST;
    let port = reserve_local_port(bind_host)?;
    let url = format!("http://{control_host}:{port}");
    let app_root = resolve_app_root(app)?;
    let app_root_arg = app_root.to_string_lossy().to_string();
    let h5_dist_dir = resolve_h5_dist_dir(app, &app_root)
        .to_string_lossy()
        .to_string();

    // 单一合并 sidecar：第一个参数选 server / cli / adapters 模式。
    let mut sidecar = app
        .shell()
        .sidecar("claude-sidecar")
        .map_err(|err| format!("resolve sidecar: {err}"))?;
    for (key, value) in terminal_environment(&default_shell(None)) {
        sidecar = sidecar.env(key, value);
    }
    // Pass through CLAUDE_CONFIG_DIR so the sidecar (Node.js) uses the same
    // portable config directory. Also set XDG_CACHE_HOME to redirect the
    // env-paths cache from %LOCALAPPDATA%\claude-cli-nodejs\ to alongside
    // the portable config dir.
    if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let cache_dir = PathBuf::from(&config_dir).join("Cache");
        if let Err(e) = fs::create_dir_all(&cache_dir) {
            eprintln!("[desktop] failed to create Cache dir: {e}");
        }
        sidecar = sidecar
            .env("CLAUDE_CONFIG_DIR", &config_dir)
            .env("XDG_CACHE_HOME", cache_dir.to_string_lossy().to_string())
            .env("CLAUDE_H5_AUTO_PUBLIC_URL", "1")
            .env("CLAUDE_H5_DIST_DIR", h5_dist_dir);
    } else {
        sidecar = sidecar
            .env("CLAUDE_H5_AUTO_PUBLIC_URL", "1")
            .env("CLAUDE_H5_DIST_DIR", h5_dist_dir);
    }
    let sidecar = sidecar.args([
        "server",
        "--app-root",
        &app_root_arg,
        "--host",
        bind_host,
        "--port",
        &port.to_string(),
    ]);

    let startup_logs = Arc::new(Mutex::new(VecDeque::new()));
    let logs_for_task = Arc::clone(&startup_logs);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|err| format!("spawn server sidecar: {err}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end();
                    println!("[claude-server] {line}");
                    push_server_startup_log(&logs_for_task, format!("[stdout] {line}"));
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end();
                    eprintln!("[claude-server] {line}");
                    push_server_startup_log(&logs_for_task, format!("[stderr] {line}"));
                }
                CommandEvent::Terminated(payload) => {
                    let line = format!(
                        "sidecar exited (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    eprintln!("[claude-server] {line}");
                    push_server_startup_log(&logs_for_task, format!("[exit] {line}"));
                }
                _ => {}
            }
        }
    });

    if let Err(err) = wait_for_server(control_host, port) {
        let _ = child.kill();
        return Err(format_server_startup_error(&err, &startup_logs));
    }

    Ok(ServerRuntime { url, child })
}

fn stop_server_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerState>() else {
        return;
    };

    let Ok(mut guard) = state.0.lock() else {
        return;
    };

    if let Some(runtime) = guard.runtime.take() {
        kill_process_tree(&runtime.child);
    }
}

/// 启动 adapter sidecars。每个平台单独一个进程，避免某个平台的 SDK / long polling
/// 影响其它平台（Telegram 尤其要求同一个 Bot Token 只有一个活跃 consumer）。
fn start_adapters_sidecars(app: &AppHandle) -> Result<Vec<CommandChild>, String> {
    #[cfg(unix)]
    kill_stale_unix_adapter_sidecars();

    let app_root = resolve_app_root(app)?;
    let app_root_arg = app_root.to_string_lossy().to_string();

    // adapter 内部的 WsBridge 默认连 ws://127.0.0.1:3456，但桌面端的 server
    // 用的是 reserve_local_port() 拿到的动态端口。这里把实际端口通过
    // ADAPTER_SERVER_URL env var 传过去 —— adapters/common/config.ts 的
    // loadConfig() 会读它。
    //
    // 如果 server 还没起来 / 没拿到 URL，回退到 3456 作为最后兜底（adapter
    // 自己有重连逻辑，等 server 上线就能连上）。
    let server_http_url = app
        .try_state::<ServerState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|guard| guard.runtime.as_ref().map(|r| r.url.clone()))
        })
        .unwrap_or_else(|| "http://127.0.0.1:3456".to_string());
    // WsBridge 直接 `new WebSocket('${serverUrl}/ws/...')`，必须传 ws://；
    // 不会自动从 http 转。
    let server_ws_url = if let Some(rest) = server_http_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = server_http_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        server_http_url.clone()
    };

    let mut children = Vec::new();
    for (label, flag) in [
        ("feishu", "--feishu"),
        ("telegram", "--telegram"),
        ("wechat", "--wechat"),
        ("dingtalk", "--dingtalk"),
    ] {
        let mut sidecar = app
            .shell()
            .sidecar("claude-sidecar")
            .map_err(|err| format!("resolve {label} adapter sidecar: {err}"))?;
        for (key, value) in terminal_environment(&default_shell(None)) {
            sidecar = sidecar.env(key, value);
        }
        // Pass through CLAUDE_CONFIG_DIR for portable installs
        let mut sidecar_final = sidecar.env("ADAPTER_SERVER_URL", &server_ws_url);
        if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
            let cache_dir = PathBuf::from(&config_dir).join("Cache");
            sidecar_final = sidecar_final
                .env("CLAUDE_CONFIG_DIR", &config_dir)
                .env("XDG_CACHE_HOME", cache_dir.to_string_lossy().to_string());
        }
        let sidecar = sidecar_final.args(["adapters", "--app-root", &app_root_arg, flag]);

        let (mut rx, child) = sidecar
            .spawn()
            .map_err(|err| format!("spawn {label} adapter sidecar: {err}"))?;
        let label = label.to_string();

        // 用一个 async task 把 sidecar 的 stdout/stderr 转发出来。它退出时
        // 整个 task 也会自然结束。
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let line = String::from_utf8_lossy(&line);
                        println!("[claude-adapters:{label}] {}", line.trim_end());
                    }
                    CommandEvent::Stderr(line) => {
                        let line = String::from_utf8_lossy(&line);
                        eprintln!("[claude-adapters:{label}] {}", line.trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        // exit code != 0 是常态：用户没配凭据时 sidecar 内部会
                        // warn + skip + process.exit(1)。这里只 info 一行，
                        // 不要当错误冒泡。
                        println!(
                            "[claude-adapters:{label}] sidecar exited (code={:?}, signal={:?})",
                            payload.code, payload.signal
                        );
                    }
                    _ => {}
                }
            }
        });

        children.push(child);
    }

    Ok(children)
}

/// spawn adapter sidecars 并把 child handles 存进 AdapterState。
/// 在启动 + 重启路径里复用，集中处理"无法 spawn"的日志。
fn spawn_and_track_adapters_sidecar(app: &AppHandle) {
    match start_adapters_sidecars(app) {
        Ok(children) => {
            if let Some(state) = app.try_state::<AdapterState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = children;
                }
            }
        }
        Err(err) => {
            eprintln!("[desktop] failed to start adapter sidecar: {err}");
        }
    }
}

fn stop_adapters_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<AdapterState>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    for child in guard.drain(..) {
        let _ = child.kill();
    }
}

#[cfg(unix)]
fn kill_stale_unix_adapter_sidecars() {
    let current_pid = std::process::id();
    let Ok(output) = StdCommand::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
    else {
        return;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let mut parts = line.trim_start().splitn(2, char::is_whitespace);
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(command) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        if pid == current_pid {
            continue;
        }
        if !command.contains("claude-sidecar") || !command.contains(" adapters") {
            continue;
        }

        let _ = StdCommand::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(target_os = "windows")]
fn kill_windows_sidecars() {
    for image_name in [
        "claude-sidecar-x86_64-pc-windows-msvc.exe",
        "claude-sidecar-aarch64-pc-windows-msvc.exe",
        "claude-sidecar.exe",
    ] {
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/IM", image_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_terminal_output, default_utf8_locale, ensure_utf8_locale,
        dir_has_portable_data, has_meaningful_intersection, is_persistable_window_state,
        normalize_terminal_bash_path, parse_env_block, resolve_desktop_terminal_shell,
        resolve_terminal_cwd, run_notification_bridge,
        select_h5_dist_dir, DesktopTerminalConfig, StoredWindowState, TerminalHostPlatform,
        SERVER_BIND_HOST, SERVER_CONTROL_HOST,
    };
    use std::{collections::HashMap, fs};

    #[test]
    fn window_state_rejects_too_small_sizes() {
        let valid = StoredWindowState {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
            maximized: false,
        };
        let too_narrow = StoredWindowState {
            width: 959,
            ..valid.clone()
        };
        let too_short = StoredWindowState {
            height: 639,
            ..valid.clone()
        };

        assert!(is_persistable_window_state(&valid));
        assert!(!is_persistable_window_state(&too_narrow));
        assert!(!is_persistable_window_state(&too_short));
    }

    #[test]
    fn window_state_requires_visible_monitor_intersection() {
        let state = StoredWindowState {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
            maximized: false,
        };

        assert!(has_meaningful_intersection(&state, 0, 0, 1920, 1080));
        assert!(!has_meaningful_intersection(
            &StoredWindowState {
                x: -1200,
                y: 100,
                ..state.clone()
            },
            0,
            0,
            1920,
            1080,
        ));
        assert!(!has_meaningful_intersection(
            &StoredWindowState {
                x: 1900,
                y: 100,
                ..state
            },
            0,
            0,
            1920,
            1080,
        ));
    }

    #[test]
    fn terminal_output_decoder_preserves_split_chinese_characters() {
        let mut pending = Vec::new();
        let bytes = "安装 Skills 成功\n".as_bytes();

        assert_eq!(decode_terminal_output(&mut pending, &bytes[..2]), "");
        assert_eq!(decode_terminal_output(&mut pending, &bytes[2..4]), "安");
        assert_eq!(
            decode_terminal_output(&mut pending, &bytes[4..]),
            "装 Skills 成功\n"
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn terminal_output_decoder_keeps_incomplete_suffix_pending() {
        let mut pending = Vec::new();
        let bytes = "中文".as_bytes();

        assert_eq!(decode_terminal_output(&mut pending, &bytes[..4]), "中");
        assert_eq!(pending, bytes[3..4]);
        assert_eq!(decode_terminal_output(&mut pending, &bytes[4..]), "文");
        assert!(pending.is_empty());
    }

    #[test]
    fn parse_env_block_reads_nul_delimited_values() {
        let env =
            parse_env_block(b"PATH=/opt/homebrew/bin:/usr/bin\0NODE_PATH=/tmp/node\0EMPTY=\0");

        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(env.get("NODE_PATH").map(String::as_str), Some("/tmp/node"));
        assert_eq!(env.get("EMPTY").map(String::as_str), Some(""));
    }

    #[test]
    fn terminal_bash_path_normalizer_clears_blank_values() {
        assert_eq!(
            normalize_terminal_bash_path(Some("   ".to_string())).expect("blank path clears"),
            None
        );
        assert_eq!(
            normalize_terminal_bash_path(None).expect("missing path clears"),
            None
        );
    }

    #[test]
    fn terminal_bash_path_normalizer_rejects_missing_files() {
        let missing =
            std::env::temp_dir().join(format!("cchh-missing-bash-{}", std::process::id()));

        let error = normalize_terminal_bash_path(Some(missing.to_string_lossy().to_string()))
            .expect_err("missing path should be rejected");

        assert!(error.contains("terminal bash path does not exist"));
    }

    #[test]
    fn terminal_bash_path_normalizer_accepts_existing_files() {
        let path = std::env::temp_dir().join(format!("cchh-bash-path-test-{}", std::process::id()));
        fs::write(&path, "").expect("write bash path fixture");

        assert_eq!(
            normalize_terminal_bash_path(Some(format!("  {}  ", path.display())))
                .expect("existing file is accepted"),
            Some(path.to_string_lossy().to_string())
        );

        fs::remove_file(path).expect("remove bash path fixture");
    }

    #[test]
    fn terminal_environment_forces_utf8_locale_when_shell_uses_c_locale() {
        let mut env = HashMap::from([
            ("LANG".to_string(), "C".to_string()),
            ("LC_CTYPE".to_string(), "POSIX".to_string()),
            ("LC_ALL".to_string(), "C".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(
            env.get("LANG").map(String::as_str),
            Some(default_utf8_locale())
        );
        assert_eq!(
            env.get("LC_CTYPE").map(String::as_str),
            Some(default_utf8_locale())
        );
        assert_eq!(
            env.get("LC_ALL").map(String::as_str),
            Some(default_utf8_locale())
        );
    }

    #[test]
    fn terminal_environment_keeps_existing_utf8_locale() {
        let mut env = HashMap::from([
            ("LANG".to_string(), "zh_CN.UTF-8".to_string()),
            ("LC_CTYPE".to_string(), "en_US.UTF8".to_string()),
            ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("zh_CN.UTF-8"));
        assert_eq!(env.get("LC_CTYPE").map(String::as_str), Some("en_US.UTF8"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
    }

    #[test]
    fn terminal_cwd_defaults_to_portable_config_dir_when_present() {
        let original = std::env::var_os("CLAUDE_CONFIG_DIR");
        let dir = std::env::temp_dir().join(format!(
            "cchh-terminal-portable-cwd-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create portable config dir");
        std::env::set_var("CLAUDE_CONFIG_DIR", &dir);

        let cwd = resolve_terminal_cwd(None).expect("portable cwd should resolve");

        assert_eq!(cwd, dir);

        if let Some(value) = original {
            std::env::set_var("CLAUDE_CONFIG_DIR", value);
        } else {
            std::env::remove_var("CLAUDE_CONFIG_DIR");
        }
        fs::remove_dir_all(cwd).expect("remove portable config dir");
    }

    #[test]
    fn portable_data_detection_includes_cli_state_dirs() {
        let root = std::env::temp_dir().join(format!(
            "cchh-portable-data-detect-{}",
            std::process::id()
        ));
        let skills = root.join("skills");
        fs::create_dir_all(&skills).expect("create skills dir");

        assert!(dir_has_portable_data(&root));

        fs::remove_dir_all(root).expect("remove portable data fixture");
    }

    #[test]
    fn desktop_terminal_shell_resolution_keeps_system_default_without_preference() {
        assert_eq!(
            resolve_desktop_terminal_shell(TerminalHostPlatform::Windows, None, "powershell.exe",)
                .expect("resolution should succeed"),
            None
        );
    }

    #[test]
    fn desktop_terminal_shell_resolution_supports_windows_pwsh_and_custom_path() {
        let pwsh = DesktopTerminalConfig {
            startup_shell: Some("pwsh".to_string()),
            custom_shell_path: None,
        };
        assert_eq!(
            resolve_desktop_terminal_shell(
                TerminalHostPlatform::Windows,
                Some(&pwsh),
                "powershell.exe",
            )
            .expect("pwsh resolution should succeed"),
            Some("pwsh.exe".to_string())
        );

        let custom = DesktopTerminalConfig {
            startup_shell: Some("custom".to_string()),
            custom_shell_path: Some("/tmp/custom-shell".to_string()),
        };
        assert_eq!(
            resolve_desktop_terminal_shell(
                TerminalHostPlatform::Windows,
                Some(&custom),
                "powershell.exe",
            )
            .expect("custom resolution should succeed"),
            Some("/tmp/custom-shell".to_string())
        );
    }

    #[test]
    fn server_sidecar_binds_lan_but_reports_loopback_control_url() {
        assert_eq!(SERVER_BIND_HOST, "0.0.0.0");
        assert_eq!(SERVER_CONTROL_HOST, "127.0.0.1");
    }

    #[test]
    fn h5_dist_dir_prefers_tauri_parent_resource_mapping() {
        let root = std::env::temp_dir().join(format!("cchh-h5-dist-test-{}", std::process::id()));
        let resource_dir = root.join("Contents").join("Resources");
        let app_root = root.join("Contents").join("MacOS");
        let mapped_dist = resource_dir.join("_up_").join("dist");

        fs::create_dir_all(&mapped_dist).expect("create mapped dist dir");
        fs::create_dir_all(&app_root).expect("create app root dir");
        fs::write(mapped_dist.join("index.html"), "").expect("write h5 shell");

        assert_eq!(
            select_h5_dist_dir(Some(&resource_dir), &app_root),
            mapped_dist
        );

        fs::remove_dir_all(root).expect("remove temp app tree");
    }

    #[test]
    fn notification_bridge_runs_off_the_calling_thread() {
        let caller_thread = std::thread::current().id();
        let ran_on_worker = tauri::async_runtime::block_on(run_notification_bridge(move || {
            Ok(std::thread::current().id() != caller_thread)
        }))
        .expect("notification bridge operation should complete");

        assert!(ran_on_worker);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Keep this first so duplicate launches are stopped before sidecars start.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(ServerState::default())
        .manage(AdapterState::default())
        .manage(TerminalState::default())
        .manage(AppExitState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            restart_adapters_sidecar,
            prepare_for_update_install,
            prepare_for_app_mode_restart,
            cancel_update_install,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            get_terminal_bash_path,
            set_terminal_bash_path,
            macos_notification_permission_state,
            macos_request_notification_permission,
            macos_send_notification,
            open_windows_notification_settings,
            get_app_mode,
            set_app_mode,
            detect_portable_dir,
            set_app_zoom
        ]);

    // macOS: native menu bar (traffic-light overlay style)
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let about_item =
                MenuItemBuilder::with_id("nav_about", "关于 Claude Code Haha").build(app)?;
            let settings_item = MenuItemBuilder::with_id("nav_settings", "设置...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_submenu = SubmenuBuilder::new(app, "Claude Code Haha")
                .item(&about_item)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_submenu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .close_window()
                .build()?;

            MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "nav_about" => {
                let _ = app.emit("native-menu-navigate", "about");
            }
            "nav_settings" => {
                let _ = app.emit("native-menu-navigate", "settings");
            }
            _ => {}
        });

    let app = builder
        .setup(|app| {
            setup_system_tray(app)?;
            macos_notifications::install_click_handler(app.handle().clone());
            restore_main_window_state(&app.handle());

            let state = app.state::<ServerState>();
            let mut guard = state
                .0
                .lock()
                .map_err(|_| IoError::new(ErrorKind::Other, "server state lock poisoned"))?;

            match start_server_sidecar(&app.handle()) {
                Ok(runtime) => {
                    guard.runtime = Some(runtime);
                    guard.startup_error = None;
                }
                Err(err) => {
                    eprintln!("[desktop] failed to start local server: {err}");
                    guard.runtime = None;
                    guard.startup_error = Some(err);
                }
            }
            drop(guard);

            // Start background health monitoring for the sidecar
            spawn_sidecar_health_check(&app.handle());

            // server 起来之后再起 adapter sidecar —— start_adapters_sidecar
            // 内部会从 ServerState 读 server URL 注入 ADAPTER_SERVER_URL env，
            // 让 adapter 连上动态端口。
            spawn_and_track_adapters_sidecar(&app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if should_hide_to_tray(app_handle, &label) => {
            api.prevent_close();
            save_main_window_state(app_handle);
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.hide();
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
            ..
        } if label == MAIN_WINDOW_LABEL => {
            save_main_window_state(app_handle);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            show_main_window(app_handle);
        }
        RunEvent::ExitRequested { .. } => {
            mark_app_quitting(app_handle);
            save_main_window_state(app_handle);
            stop_server_sidecar(app_handle);
            stop_adapters_sidecar(app_handle);
        }
        RunEvent::Exit => {
            mark_app_quitting(app_handle);
            save_main_window_state(app_handle);
            stop_server_sidecar(app_handle);
            stop_adapters_sidecar(app_handle);
        }
        _ => {}
    });
}
