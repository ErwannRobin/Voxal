use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
#[cfg(target_os = "macos")]
use tauri::{Manager, WindowEvent};
use tauri::menu::{MenuItem, MenuBuilder, SubmenuBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_autostart::MacosLauncher;

const DEFAULT_SHORTCUT: &str = "Shift+Space";

struct PttShortcut(Mutex<String>);

fn presence_method(method: &str) -> &str {
    match method.to_uppercase().as_str() {
        "POST" => "POST",
        "DELETE" => "DELETE",
        _ => "GET",
    }
}

fn parse_presence_response_text(text: &str) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|_| {
        let preview = &trimmed[..trimmed.len().min(120)];
        format!("Non-JSON response: {}", preview)
    })
}

// Proxy HTTP requests through Rust to bypass WebView CORS restrictions.
// The Tauri WebView origin (tauri://localhost) is not whitelisted by external APIs.
#[tauri::command]
async fn presence_fetch(
    url: String,
    method: String,
    token: Option<String>,
    secret: Option<String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    eprintln!("[presence_fetch] {} {}", method.to_uppercase(), url);
    let client = reqwest::Client::new();
    let mut req = match presence_method(&method) {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(t) = token {
        req = req.header("x-api-token", t);
    }
    if let Some(s) = secret {
        req = req.header("x-room-secret", s);
    }
    if let Some(b) = body {
        req = req.header("content-type", "application/json").body(b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    eprintln!("[presence_fetch] → {}", status);
    if status >= 400 {
        return Err(format!("HTTP {}", status));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    parse_presence_response_text(&text)
}

// Device diagnostics for the dev-mode debug panel. The WebView (WKWebView on
// macOS) exposes none of `performance.memory` / `navigator.getBattery` /
// per-process CPU, so we read them natively here. Best-effort: any field the OS
// won't give us stays `None` and renders as "—" in the panel.
#[derive(serde::Serialize, Default)]
struct DeviceStats {
    mem_app: Option<u64>,          // process resident memory, bytes
    mem_total: Option<u64>,        // total system memory, bytes
    mem_used: Option<u64>,         // used system memory, bytes
    cpu_app: Option<f32>,          // process CPU, percent
    cpu_total: Option<f32>,        // system-wide CPU, percent
    battery_level: Option<u8>,     // 0..=100
    battery_charging: Option<bool>,
}

fn read_battery() -> (Option<u8>, Option<bool>) {
    let manager = match starship_battery::Manager::new() {
        Ok(m) => m,
        Err(_) => return (None, None),
    };
    let mut batteries = match manager.batteries() {
        Ok(b) => b,
        Err(_) => return (None, None),
    };
    if let Some(Ok(battery)) = batteries.next() {
        let level = (battery.state_of_charge().value * 100.0).round() as u8;
        let charging = matches!(
            battery.state(),
            starship_battery::State::Charging | starship_battery::State::Full
        );
        return (Some(level.min(100)), Some(charging));
    }
    (None, None)
}

#[tauri::command]
async fn get_device_stats() -> Result<DeviceStats, String> {
    // CPU usage needs two samples spaced by at least the platform minimum, and
    // sysinfo refreshes are blocking — run the whole thing off the async runtime.
    tauri::async_runtime::spawn_blocking(|| {
        use sysinfo::{get_current_pid, ProcessesToUpdate, System};

        let mut sys = System::new();
        sys.refresh_memory();
        sys.refresh_cpu_all();
        let pid = get_current_pid().ok();
        if let Some(pid) = pid {
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        }

        // Second sample so per-process/global CPU deltas are meaningful.
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_all();
        if let Some(pid) = pid {
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        }

        let (mem_app, cpu_app) = pid
            .and_then(|pid| sys.process(pid))
            .map(|p| (Some(p.memory()), Some(p.cpu_usage())))
            .unwrap_or((None, None));

        let (battery_level, battery_charging) = read_battery();

        DeviceStats {
            mem_app,
            mem_total: Some(sys.total_memory()),
            mem_used: Some(sys.used_memory()),
            cpu_app,
            cpu_total: Some(sys.global_cpu_usage()),
            battery_level,
            battery_charging,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_ptt_shortcut(
    app: AppHandle,
    state: State<PttShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let mut current = state.0.lock().unwrap();
    if !current.is_empty() {
        app.global_shortcut().unregister(current.as_str()).ok();
    }
    if !shortcut.is_empty() {
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), |app, _, event| {
                match event.state {
                    ShortcutState::Pressed  => { let _ = app.emit("ptt-press",   ()); }
                    ShortcutState::Released => { let _ = app.emit("ptt-release", ()); }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    *current = shortcut;
    Ok(())
}

async fn check_for_updates(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        eprintln!("[updater] Update available: {}", update.version);
        let _ = app.emit("update-available", &update.version);

        update.download_and_install(
            |chunk, total| {
                eprintln!("[updater] Downloaded {} / {:?}", chunk, total);
            },
            || {
                eprintln!("[updater] Download complete, restarting…");
            },
        ).await?;

        app.restart();
    } else {
        eprintln!("[updater] Already up to date");
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(PttShortcut(Mutex::new(DEFAULT_SHORTCUT.to_string())))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(main_window) = app.get_webview_window("main") {
                let window = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.minimize();
                    }

                });
            }

            // Register voxal:// scheme (Windows/Linux: dynamic registry/desktop entry;
            // macOS: requires a proper build — scheme is baked into the .app bundle)
            app.deep_link().register_all().ok();

            // Build the app menu
            let about = MenuItem::with_id(app, "about", "About Voxal", true, None::<&str>)?;
            let prefs = MenuItem::with_id(app, "preferences", "Preferences…", true, Some("CmdOrCtrl+,"))?;

            let app_submenu = SubmenuBuilder::new(app, "Voxal")
                .item(&about)
                .separator()
                .item(&prefs)
                .separator()
                .quit()
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(
                    &SubmenuBuilder::new(app, "Edit")
                        .undo()
                        .redo()
                        .separator()
                        .cut()
                        .copy()
                        .paste()
                        .separator()
                        .select_all()
                        .build()?
                )
                .build()?;

            app.set_menu(menu)?;

            let about_id = about.id().clone();
            let prefs_id = prefs.id().clone();
            app.on_menu_event(move |app, event| {
                if event.id() == &about_id {
                    app.emit("open-about", ()).ok();
                } else if event.id() == &prefs_id {
                    app.emit("open-preferences", ()).ok();
                }
            });

            // Register the default PTT global shortcut
            app.handle().global_shortcut()
                .on_shortcut(DEFAULT_SHORTCUT, |app, _, event| {
                    match event.state {
                        ShortcutState::Pressed  => { let _ = app.emit("ptt-press",   ()); }
                        ShortcutState::Released => { let _ = app.emit("ptt-release", ()); }
                    }
                })?;

            // Check for updates in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_updates(handle).await {
                    eprintln!("[updater] {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![update_ptt_shortcut, presence_fetch, get_device_stats])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{parse_presence_response_text, presence_method};

    #[test]
    fn presence_method_defaults_to_get() {
        assert_eq!(presence_method("PATCH"), "GET");
        assert_eq!(presence_method(""), "GET");
    }

    #[test]
    fn presence_method_accepts_post_and_delete_case_insensitive() {
        assert_eq!(presence_method("post"), "POST");
        assert_eq!(presence_method("DELETE"), "DELETE");
    }

    #[test]
    fn parse_presence_response_handles_empty_as_null() {
        let parsed = parse_presence_response_text("   \n\t").unwrap();
        assert!(parsed.is_null());
    }

    #[test]
    fn parse_presence_response_parses_valid_json() {
        let parsed = parse_presence_response_text("{\"ok\":true,\"count\":2}").unwrap();
        assert_eq!(parsed.get("ok").unwrap().as_bool(), Some(true));
        assert_eq!(parsed.get("count").unwrap().as_i64(), Some(2));
    }

    #[test]
    fn parse_presence_response_returns_non_json_error_with_preview() {
        let err = parse_presence_response_text("not-json-response").unwrap_err();
        assert!(err.starts_with("Non-JSON response:"));
    }

    #[test]
    fn parse_presence_response_truncates_long_non_json_preview_to_120_chars() {
        // A long HTML-ish body (e.g. a proxy error page) must not be echoed in full.
        let body = "x".repeat(500);
        let err = parse_presence_response_text(&body).unwrap_err();
        let preview = err.trim_start_matches("Non-JSON response: ");
        assert_eq!(preview.chars().count(), 120);
    }

    #[test]
    fn parse_presence_response_parses_json_array() {
        let parsed = parse_presence_response_text("[{\"a\":1},{\"a\":2}]").unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed.as_array().unwrap().len(), 2);
    }
}
