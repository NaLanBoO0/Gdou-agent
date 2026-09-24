// The Gdouwork Tauri shell. Deliberately thin: it hosts a native window for the
// Vue workbench and owns the lifetime of the bridge process. All real logic is
// in the bridge (JSON-RPC over WebSocket on 7438), which the webview reaches by
// a direct WebSocket — no Rust IPC forwarding.

use std::env;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, State};

/// The spawned bridge process, if any. `daemon_start` may find an existing
/// bridge (from an earlier run) and then there is nothing to own.
struct BridgeState {
    child: Option<Child>,
}

impl BridgeState {
    fn new() -> Self {
        Self { child: None }
    }
}

/// Located in dev by walking up from `src-tauri`; release uses a path resolved
/// from the executable's directory. A `GDOU_BRIDGE` env var overrides both.
fn bridge_path() -> PathBuf {
    if let Ok(p) = env::var("GDOU_BRIDGE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // In dev, CARGO_MANIFEST_DIR is `<root>/shell/src-tauri`; the bundled bridge
    // lives at `<root>/dist/bridge.cjs`, two levels up then into dist/.
    if let Ok(manifest) = env::var("CARGO_MANIFEST_DIR") {
        let root = PathBuf::from(manifest)
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        if let Some(root) = root {
            let candidate = root.join("dist").join("bridge.cjs");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // Fallback: alongside the executable (packaged layout).
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("bridge.cjs");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("dist/bridge.cjs")
}

/// A self-contained `bridge.exe` located alongside the app executable (the
/// packaged layout, where Tauri lands the bundled resource). Returns `None`
/// when running from a dev checkout that only has `dist/bridge.cjs`. A
/// `GDOU_BRIDGE` env var overrides both.
fn bridge_exe_path() -> Option<PathBuf> {
    if let Ok(p) = env::var("GDOU_BRIDGE") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri installs `bundle.resources` under `<installDir>/resources/`.
            for candidate in [dir.join("bridge.exe"), dir.join("resources").join("bridge.exe")] {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// True when something is already listening on the bridge port — in that case we
/// reuse it rather than spawn a second (which would die on `EADDRINUSE`).
fn bridge_running(host: &str, port: u16) -> bool {
    TcpStream::connect((host, port)).is_ok()
}

/// Wait (briefly, polling) for the bridge to start listening.
fn wait_for_bridge(host: &str, port: u16, attempts: u32) -> bool {
    for _ in 0..attempts {
        if bridge_running(host, port) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    false
}

#[tauri::command]
fn daemon_start(state: State<Mutex<BridgeState>>) -> Result<(), String> {
    let host = "127.0.0.1";
    let port = 7438;

    // Reuse an already-running bridge. Returning `Ok` (rather than reporting a
    // conflict) is the same stance as `scripts/dev-shell.mjs`: an existing
    // bridge is fully usable, and starting a second one only produces EADDRINUSE.
    if bridge_running(host, port) {
        return Ok(());
    }

    let mut lock = state.lock().map_err(|_| "state poisoned".to_string())?;
    if lock.child.is_some() {
        return Ok(());
    }

    let current = env::current_dir().map_err(|e| e.to_string())?;

    // Prefer a self-contained bridge.exe (packaged); fall back to `node` +
    // dist/bridge.cjs for dev checkouts that lack the SEA build.
    let child = if let Some(exe) = bridge_exe_path() {
        Command::new(exe).current_dir(current.clone()).spawn()
    } else {
        let path = bridge_path();
        let node = env::var("GDOU_NODE").unwrap_or_else(|_| "node".to_string());
        Command::new(node).arg(&path).current_dir(current.clone()).spawn()
    };
    let child = child.map_err(|e| format!("failed to start bridge: {e}"))?;

    lock.child = Some(child);
    drop(lock);

    if !wait_for_bridge(host, port, 40) {
        // ~10s of retries without a listener; report that the bridge did not
        // come up. The front-end's own reconnect loop will retry the connection.
        return Err("bridge started but did not listen on 7438".into());
    }
    Ok(())
}

/// Stop the bridge process we own. Called on app/window exit so no orphan `node`
/// keeps holding 7438.
fn stop_bridge(state: &State<Mutex<BridgeState>>) {
    if let Ok(mut lock) = state.lock() {
        if let Some(mut child) = lock.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(BridgeState::new()))
        .invoke_handler(tauri::generate_handler![daemon_start])
        .build(tauri::generate_context!())
        .expect("error while building Gdouwork")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<Mutex<BridgeState>>();
                stop_bridge(&state);
            }
        });
}