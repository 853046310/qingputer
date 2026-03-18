#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
#[derive(Clone, Deserialize, Serialize)]
struct RuntimeConnection {
    port: u16,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResponse {
    status: u16,
    body: String,
}

#[derive(Clone, Serialize)]
struct CapabilityGrants {
    terminal: bool,
    filesystem: bool,
    browser: bool,
}

#[derive(Clone, Serialize)]
struct DefaultSessionConfig {
    cwd: String,
    grants: CapabilityGrants,
    approval_mode: String,
    idle_timeout_minutes: u32,
    absolute_timeout_hours: u32,
}

#[derive(Default)]
struct AppState {
    runtime: Mutex<Option<RuntimeConnection>>,
    child: Mutex<Option<Child>>,
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn runtime_root() -> PathBuf {
    project_root().join("runtime")
}

fn bundled_resources_dir() -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let macos_dir = current_exe
        .parent()
        .ok_or_else(|| "Current executable path has no parent directory".to_string())?;
    let contents_dir = macos_dir
        .parent()
        .ok_or_else(|| "Current executable path is not inside a macOS app bundle".to_string())?;
    Ok(contents_dir.join("Resources"))
}

fn runtime_python() -> PathBuf {
    runtime_root().join(".venv/bin/python")
}

fn spawn_runtime_process() -> Result<Child, String> {
    if cfg!(debug_assertions) {
        let python = runtime_python();
        let interpreter = if python.exists() {
            python
        } else {
            PathBuf::from("python3")
        };
        let mut command = Command::new(interpreter);
        command
            .arg("-m")
            .arg("app.main")
            .current_dir(runtime_root())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        return command.spawn().map_err(|error| format!("Failed to start python runtime: {error}"));
    }

    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = current_exe
        .parent()
        .ok_or_else(|| "Current executable path has no parent directory".to_string())?;
    let runtime_bin = std::env::var("QINGPUTER_RUNTIME_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let bare = executable_dir.join("qingputer-runtime");
            if bare.exists() {
                bare
            } else {
                executable_dir.join("qingputer-runtime-aarch64-apple-darwin")
            }
        });
    let mut command = Command::new(runtime_bin);
    if let Ok(resources_dir) = bundled_resources_dir() {
        let bundled_browsers = resources_dir.join("playwright-browsers");
        if bundled_browsers.exists() {
            command.env("PLAYWRIGHT_BROWSERS_PATH", bundled_browsers);
        }
    }
    command
        .current_dir(home_dir().unwrap_or_else(project_root))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    command.spawn().map_err(|error| format!("Failed to start packaged runtime: {error}"))
}

fn ensure_runtime(state: &Arc<AppState>) -> Result<RuntimeConnection, String> {
    {
        let runtime_guard = state
            .runtime
            .lock()
            .map_err(|_| "Runtime state poisoned".to_string())?;
        let mut child_guard = state
            .child
            .lock()
            .map_err(|_| "Runtime child state poisoned".to_string())?;

        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *child_guard = None;
                    drop(child_guard);
                    drop(runtime_guard);
                    *state
                        .runtime
                        .lock()
                        .map_err(|_| "Runtime state poisoned".to_string())? = None;
                }
                Ok(None) => {
                    if let Some(connection) = runtime_guard.clone() {
                        return Ok(connection);
                    }
                }
                Err(error) => {
                    return Err(format!("Failed to inspect runtime process: {error}"));
                }
            }
        } else if let Some(connection) = runtime_guard.clone() {
            return Ok(connection);
        }
    }

    let mut child = spawn_runtime_process()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Runtime stdout was not piped".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("Failed to read runtime handshake: {error}"))?;
    let connection: RuntimeConnection =
        serde_json::from_str(line.trim()).map_err(|error| format!("Invalid runtime handshake: {error}"))?;
    eprintln!(
        "qingputer-runtime-handshake port={} token={}",
        connection.port, connection.token
    );
    wait_for_runtime_ready(&connection)?;

    *state
        .runtime
        .lock()
        .map_err(|_| "Runtime state poisoned".to_string())? = Some(connection.clone());
    *state
        .child
        .lock()
        .map_err(|_| "Runtime child state poisoned".to_string())? = Some(child);
    Ok(connection)
}

fn runtime_request_via_tcp(
    connection: &RuntimeConnection,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<RuntimeResponse, String> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, connection.port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(3))
        .map_err(|error| format!("Runtime TCP connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("Failed to set runtime read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("Failed to set runtime write timeout: {error}"))?;

    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{payload}",
        port = connection.port,
        token = connection.token,
        length = payload.as_bytes().len(),
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Runtime TCP write failed: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("Runtime TCP flush failed: {error}"))?;

    let mut response_bytes = Vec::new();
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|error| format!("Runtime TCP read failed: {error}"))?;
    let response = String::from_utf8(response_bytes)
        .map_err(|error| format!("Runtime response was not valid UTF-8: {error}"))?;

    let header_split = response
        .find("\r\n\r\n")
        .ok_or_else(|| format!("Runtime response missing header terminator: {response}"))?;
    let (header_block, body_block) = response.split_at(header_split);
    let body = body_block.strip_prefix("\r\n\r\n").unwrap_or(body_block).to_string();

    let mut header_lines = header_block.lines();
    let status_line = header_lines
        .next()
        .ok_or_else(|| "Runtime response missing status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("Runtime response invalid status line: {status_line}"))?
        .parse::<u16>()
        .map_err(|error| format!("Runtime response invalid status code: {error}"))?;

    Ok(RuntimeResponse { status, body })
}

fn wait_for_runtime_ready(connection: &RuntimeConnection) -> Result<(), String> {
    let mut last_error: Option<String> = None;
    for _ in 0..40 {
        match runtime_request_via_tcp(connection, "GET", "/health", None) {
            Ok(response) if response.status == 200 => return Ok(()),
            Ok(response) => last_error = Some(format!("Runtime health returned {}", response.status)),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Runtime did not become ready after startup: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[tauri::command]
fn runtime_connection(state: tauri::State<Arc<AppState>>) -> Result<RuntimeConnection, String> {
    ensure_runtime(&state.inner().clone())
}

#[tauri::command]
fn runtime_request(
    state: tauri::State<Arc<AppState>>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<RuntimeResponse, String> {
    let connection = ensure_runtime(&state.inner().clone())?;
    let upper_method = method.trim().to_uppercase();
    if upper_method.is_empty() {
        return Err("Invalid runtime request method: empty".to_string());
    }
    runtime_request_via_tcp(&connection, &upper_method, &path, body.as_deref())
}

#[tauri::command]
fn default_session_config() -> Result<DefaultSessionConfig, String> {
    let cwd = home_dir()
        .unwrap_or_else(|| project_root())
        .display()
        .to_string();
    Ok(DefaultSessionConfig {
        cwd,
        grants: CapabilityGrants {
            terminal: true,
            filesystem: true,
            browser: true,
        },
        approval_mode: "default".to_string(),
        idle_timeout_minutes: 60,
        absolute_timeout_hours: 8,
    })
}

fn main() {
    let state = Arc::new(AppState::default());
    let shutdown_state = state.clone();
    tauri::Builder::default()
        .manage(state.clone())
        .setup({
            let state = state.clone();
            move |_app| {
                ensure_runtime(&state)?;
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_connection,
            runtime_request,
            default_session_config
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Qingputer desktop")
        .run(move |_app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Ok(mut child_slot) = shutdown_state.child.lock() {
                    if let Some(child) = child_slot.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
