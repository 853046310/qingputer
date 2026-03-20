#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri::webview::PageLoadEvent;
#[derive(Clone, Deserialize, Serialize)]
struct RuntimeConnection {
    port: u16,
    token: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct QingflowAuthProbe {
    window_open: bool,
    url: Option<String>,
    token_candidate: Option<String>,
    ws_id_candidate: Option<i64>,
    observed_keys: Vec<String>,
    last_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QingflowAuthProbeReport {
    url: Option<String>,
    token_candidate: Option<String>,
    ws_id_candidate: Option<i64>,
    observed_keys: Option<Vec<String>>,
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
    qingflow_auth_probe: Mutex<QingflowAuthProbe>,
}

fn clear_qingflow_auth_probe(state: &Arc<AppState>, window_open: bool) -> Result<(), String> {
    let mut probe = state
        .qingflow_auth_probe
        .lock()
        .map_err(|_| "Qingflow auth probe state poisoned".to_string())?;
    *probe = QingflowAuthProbe {
        window_open,
        ..QingflowAuthProbe::default()
    };
    Ok(())
}

fn qingflow_auth_probe_script() -> &'static str {
    r#"
(() => {
  if (window.__QINGPUTER_QF_PROBE_INSTALLED__) return;
  window.__QINGPUTER_QF_PROBE_INSTALLED__ = true;
  const tauriInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!tauriInvoke) return;

  const exactTokenKeys = ["qf_token", "qflowToken", "token"];
  const exactWsKeys = ["qf_wsId", "qf_wsid", "qf_ws_id", "wsId", "ws_id", "qfWsid", "qf_wsid"];
  const blockedTokenFragments = ["csrf", "xsrf", "refresh", "trace"];

  function readCookies() {
    const entries = {};
    try {
      const raw = document.cookie || "";
      for (const part of raw.split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const index = trimmed.indexOf("=");
        if (index <= 0) continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim();
        if (key && value) entries[key] = value;
      }
    } catch {}
    return entries;
  }

  function readStorage(storage) {
    const entries = {};
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        const value = storage.getItem(key);
        if (typeof value === "string" && value) entries[key] = value;
      }
    } catch {}
    return entries;
  }

  function findExact(entries, keys) {
    for (const key of keys) {
      if (typeof entries[key] === "string" && entries[key]) return entries[key];
    }
    return null;
  }

  function findToken(entries) {
    const exact = findExact(entries, exactTokenKeys);
    if (exact) return exact;
    for (const [key, value] of Object.entries(entries)) {
      const normalized = key.toLowerCase();
      if (!(normalized.endsWith("token") || normalized.includes("token"))) continue;
      if (blockedTokenFragments.some((fragment) => normalized.includes(fragment))) continue;
      if (typeof value === "string" && value) return value;
    }
    return null;
  }

  function findWorkspaceId(entries) {
    const exact = findExact(entries, exactWsKeys);
    const parse = (value) => {
      if (value == null) return null;
      const normalized = String(value).trim();
      if (!normalized) return null;
      const parsed = Number.parseInt(normalized, 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const exactParsed = parse(exact);
    if (exactParsed != null) return exactParsed;
    for (const [key, value] of Object.entries(entries)) {
      const normalized = key.toLowerCase();
      if (
        !(
          normalized.endsWith("wsid") ||
          normalized.endsWith("ws_id") ||
          normalized.includes("wsid") ||
          normalized.includes("workspaceid")
        )
      ) continue;
      const parsed = parse(value);
      if (parsed != null) return parsed;
    }
    return null;
  }

  async function report() {
    const cookies = readCookies();
    const local = readStorage(window.localStorage);
    const session = readStorage(window.sessionStorage);
    const merged = { ...cookies, ...local, ...session };
    const observedKeys = Array.from(new Set([
      ...Object.keys(cookies).map((key) => `cookie:${key}`),
      ...Object.keys(local).map((key) => `local:${key}`),
      ...Object.keys(session).map((key) => `session:${key}`),
    ])).sort();
    const payload = {
      url: window.location.href,
      tokenCandidate: findToken(merged),
      wsIdCandidate: findWorkspaceId(merged),
      observedKeys,
    };
    try {
      await tauriInvoke("qingflow_auth_report", { payloadJson: JSON.stringify(payload) });
    } catch {}
  }

  window.setInterval(() => { void report(); }, 800);
  window.addEventListener("focus", () => { void report(); });
  window.addEventListener("pageshow", () => { void report(); });
  window.addEventListener("hashchange", () => { void report(); });
  void report();
})();
"#
}

fn qingflow_auth_user_agent() -> &'static str {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
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
    for _ in 0..120 {
        match runtime_request_via_tcp(connection, "GET", "/health", None) {
            Ok(response) if response.status == 200 => return Ok(()),
            Ok(response) => last_error = Some(format!("Runtime health returned {}", response.status)),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(150));
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

#[tauri::command]
fn local_ip_address() -> Result<String, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|error| format!("Failed to bind UDP socket: {error}"))?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|error| format!("Failed to probe local network interface: {error}"))?;
    let local = socket
        .local_addr()
        .map_err(|error| format!("Failed to read local socket address: {error}"))?;
    match local.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() => Ok(ip.to_string()),
        std::net::IpAddr::V4(_) => Err("Resolved local IP is loopback; please confirm the machine is on a LAN.".to_string()),
        std::net::IpAddr::V6(_) => Err("Resolved local IP is IPv6; LAN QR pairing currently expects IPv4.".to_string()),
    }
}

#[tauri::command]
fn qingflow_auth_start(
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
    web_origin: String,
) -> Result<(), String> {
    let normalized_origin = web_origin.trim().trim_end_matches('/').to_string();
    if normalized_origin.is_empty() {
        return Err("Qingflow web origin cannot be empty.".to_string());
    }
    let target = format!("{normalized_origin}/passport/login");
    eprintln!("qingflow-auth-start target={target}");
    let target_url = target
        .parse()
        .map_err(|error| format!("Invalid Qingflow auth URL: {error}"))?;
    let shared_state = state.inner().clone();
    clear_qingflow_auth_probe(&shared_state, true)?;

    if let Some(window) = app.get_webview_window("qingflow-auth") {
        eprintln!("qingflow-auth-start reuse-existing-window");
        window
            .navigate(target_url)
            .map_err(|error| format!("Failed to navigate Qingflow auth window: {error}"))?;
        window
            .show()
            .map_err(|error| format!("Failed to show Qingflow auth window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Failed to focus Qingflow auth window: {error}"))?;
        return Ok(());
    }

    let window_state = shared_state.clone();
    let window = WebviewWindowBuilder::new(&app, "qingflow-auth", WebviewUrl::External(target_url))
        .title("连接轻流账号")
        .inner_size(1120.0, 860.0)
        .resizable(true)
        .center()
        .incognito(true)
        .user_agent(qingflow_auth_user_agent())
        .initialization_script(qingflow_auth_probe_script())
        .on_page_load({
            let page_state = shared_state.clone();
            move |window, payload| {
                eprintln!(
                    "qingflow-auth-page-load event={:?} url={}",
                    payload.event(),
                    payload.url()
                );
                if let Ok(mut probe) = page_state.qingflow_auth_probe.lock() {
                    probe.window_open = true;
                    probe.url = Some(payload.url().to_string());
                    if matches!(payload.event(), PageLoadEvent::Started) {
                        probe.last_error = None;
                    }
                }
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    if let Err(error) = window.eval(qingflow_auth_probe_script()) {
                        eprintln!("qingflow-auth-page-load eval-error={error}");
                    }
                }
            }
        })
        .build()
        .map_err(|error| format!("Failed to open Qingflow auth window: {error}"))?;
    eprintln!("qingflow-auth-start opened-new-window");
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            let _ = clear_qingflow_auth_probe(&window_state, false);
        }
    });
    Ok(())
}

#[tauri::command]
fn qingflow_auth_snapshot(state: tauri::State<Arc<AppState>>) -> Result<QingflowAuthProbe, String> {
    state
        .qingflow_auth_probe
        .lock()
        .map_err(|_| "Qingflow auth probe state poisoned".to_string())
        .map(|probe| probe.clone())
}

#[tauri::command]
fn qingflow_auth_stop(
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("qingflow-auth") {
        window
            .close()
            .map_err(|error| format!("Failed to close Qingflow auth window: {error}"))?;
    }
    clear_qingflow_auth_probe(&state.inner().clone(), false)
}

#[tauri::command]
fn qingflow_auth_report(
    state: tauri::State<Arc<AppState>>,
    payload_json: String,
) -> Result<(), String> {
    let report: QingflowAuthProbeReport = serde_json::from_str(&payload_json)
        .map_err(|error| format!("Invalid Qingflow auth report: {error}"))?;
    let mut probe = state
        .qingflow_auth_probe
        .lock()
        .map_err(|_| "Qingflow auth probe state poisoned".to_string())?;
    probe.window_open = true;
    probe.url = report.url.filter(|value| !value.trim().is_empty());
    probe.token_candidate = report.token_candidate.filter(|value| !value.trim().is_empty());
    probe.ws_id_candidate = report.ws_id_candidate;
    probe.observed_keys = report.observed_keys.unwrap_or_default();
    probe.last_error = None;
    eprintln!(
        "qingflow-auth-report url={} token_present={} ws_id={:?} keys={:?}",
        probe.url.as_deref().unwrap_or(""),
        probe.token_candidate.is_some(),
        probe.ws_id_candidate,
        probe.observed_keys
    );
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty.".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(trimmed);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(trimmed);
        cmd
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", trimmed]);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open external URL: {error}"))
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
            default_session_config,
            local_ip_address,
            qingflow_auth_start,
            qingflow_auth_snapshot,
            qingflow_auth_stop,
            qingflow_auth_report,
            open_external_url
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
