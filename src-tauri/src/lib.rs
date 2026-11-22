use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::WindowEvent;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
mod vision;

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
        // Truncate by CHARACTERS, not bytes: slicing a &str at a byte index that
        // lands mid-character panics, and the bodies that reach here are exactly
        // the ones likely to be non-ASCII — a proxy or gateway error page in the
        // user's own language. A panic in a #[tauri::command] takes the IPC call
        // down instead of returning this error.
        let preview: String = trimmed.chars().take(120).collect();
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
    mem_app: Option<u64>,      // process resident memory, bytes
    mem_total: Option<u64>,    // total system memory, bytes
    mem_used: Option<u64>,     // used system memory, bytes
    cpu_app: Option<f32>,      // process CPU, percent
    cpu_total: Option<f32>,    // system-wide CPU, percent
    battery_level: Option<u8>, // 0..=100
    battery_charging: Option<bool>,
    net_type: Option<String>, // "Wi-Fi" | "Ethernet" (the active default route)
    low_power: Option<bool>,  // OS Low Power Mode
}

// The Network Information API and Low Power Mode are not exposed to the WebView,
// so read them natively. macOS-only for now (shells out to system tools that are
// always present); best-effort — any failure (incl. an app sandbox denying the
// spawn) just yields None and the panel shows "—".
#[cfg(target_os = "macos")]
fn read_low_power() -> Option<bool> {
    let out = std::process::Command::new("pmset")
        .arg("-g")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("lowpowermode") {
            return Some(line.split_whitespace().last() == Some("1"));
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn read_low_power() -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
fn read_net_type() -> Option<String> {
    // Interface backing the default route, e.g. "en0".
    let route = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    let route_text = String::from_utf8_lossy(&route.stdout);
    let iface = route_text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("interface:")
            .map(|rest| rest.trim().to_string())
    })?;

    // `networksetup -getairportnetwork <iface>` prints "Current Wi-Fi Network:"
    // for a connected Wi-Fi interface, otherwise "… is not a Wi-Fi interface".
    let airport = std::process::Command::new("networksetup")
        .args(["-getairportnetwork", &iface])
        .output()
        .ok()?;
    let airport_text = String::from_utf8_lossy(&airport.stdout);
    if airport_text.contains("Current Wi-Fi Network:") {
        Some("Wi-Fi".to_string())
    } else {
        Some("Ethernet".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_net_type() -> Option<String> {
    None
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
    tauri::async_runtime::spawn_blocking(|| -> Result<DeviceStats, String> {
        use sysinfo::{get_current_pid, ProcessesToUpdate, System};

        // 0.40: building a `System` is fallible (it can fail to reach the OS).
        let mut sys = System::new().map_err(|e| e.to_string())?;
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

        Ok(DeviceStats {
            mem_app,
            mem_total: Some(sys.total_memory()),
            mem_used: Some(sys.used_memory()),
            cpu_app,
            cpu_total: Some(sys.global_cpu_usage()),
            battery_level,
            battery_charging,
            net_type: read_net_type(),
            low_power: read_low_power(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
            .on_shortcut(shortcut.as_str(), |app, _, event| match event.state {
                ShortcutState::Pressed => {
                    let _ = app.emit("ptt-press", ());
                }
                ShortcutState::Released => {
                    let _ = app.emit("ptt-release", ());
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

        update
            .download_and_install(
                |chunk, total| {
                    eprintln!("[updater] Downloaded {} / {:?}", chunk, total);
                },
                || {
                    eprintln!("[updater] Download complete, restarting…");
                },
            )
            .await?;

        app.restart();
    } else {
        eprintln!("[updater] Already up to date");
    }
    Ok(())
}

/// The child windows the frontend opens with `window.open`: the segmentation
/// diagnostic, popped out of the main window (`VideoEffects` → `diagPopOut()`),
/// and the room's chat in its own window (`main.js` → `openChatWindow()`). The
/// main window keeps driving both — it builds the panel, then moves its DOM
/// into the new document — so the new webview MUST share the opener's WebKit
/// configuration (`window_features`): only then is `window.open`'s return value
/// a live window of the same process rather than `null`.
///
/// Only a blank page is ever allowed, and at most one of each at a time (the
/// frontend reuses a window it already has, so a third request is a bug, not a
/// third panel). Anything else keeps the old behaviour of a Tauri webview, where
/// `window.open` does nothing and links go through the shell plugin. The
/// request does not say which panel it is for, so the title is the app's.
const CHILD_WINDOW_PREFIX: &str = "child-";
const CHILD_WINDOW_MAX: usize = 2;
static CHILD_WINDOW_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn open_child_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<R> {
    use tauri::webview::NewWindowResponse;
    let open = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(CHILD_WINDOW_PREFIX))
        .count();
    if url.as_str() != "about:blank" || open >= CHILD_WINDOW_MAX {
        return NewWindowResponse::Deny;
    }
    let seq = CHILD_WINDOW_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("{CHILD_WINDOW_PREFIX}{seq}");
    match tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .window_features(features)
        .title("Voxal")
        .min_inner_size(300.0, 320.0)
        .build()
    {
        Ok(window) => NewWindowResponse::Create { window },
        Err(e) => {
            eprintln!("[window] could not open a child window: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// Two AppKit/WebKit settings Tauri has no option for.
///
/// * Full screen: the window is a full-screen PRIMARY window, so the green
///   button and View → Enter Full Screen take it to its own Space instead of
///   zooming it. Explicit rather than left to AppKit's defaults.
/// * `window.open` without a click: WKWebView refuses it unless
///   `javaScriptCanOpenWindowsAutomatically` is on, and the diagnostic is
///   opened from the Preferences window, i.e. by a `storage` event in this
///   one — never by a gesture here. `open_child_window` still decides what
///   may actually open.
#[cfg(target_os = "macos")]
fn prepare_main_window_macos<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    if let Ok(ptr) = window.ns_window() {
        // SAFETY: `ns_window()` is this window's live NSWindow, and setup runs
        // on the main thread.
        let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        ns_window.setCollectionBehavior(
            ns_window.collectionBehavior() | NSWindowCollectionBehavior::FullScreenPrimary,
        );
    }
    let _ = window.with_webview(|webview| {
        // SAFETY: on macOS `inner()` is the webview's WKWebView, and the
        // closure runs on the main thread.
        unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            view.configuration()
                .preferences()
                .setJavaScriptCanOpenWindowsAutomatically(true);
        }
    });
}

/// The `vision` segmentation engine (`src/vision-engine.js`,
/// docs/apple-vision-evaluation.md): the camera cut-out through Apple Vision.
/// Raw RGBA in (headers `x-width` / `x-height`), a 12-byte header plus an 8-bit
/// mask at the input's size out; see `vision.rs` for the wire format. Errors off
/// macOS and before macOS 14, which sends the engine back to MediaPipe.
#[tauri::command]
async fn vision_foreground_mask(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let started = std::time::Instant::now();
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("expected a raw body".into());
    };
    let dim = |key: &str| -> Result<usize, String> {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("missing or bad header {key}"))
    };
    let (w, h) = (dim("x-width")?, dim("x-height")?);
    let rgba = body.clone();
    #[cfg(target_os = "macos")]
    {
        let mask =
            tauri::async_runtime::spawn_blocking(move || vision::foreground_mask(w, h, &rgba))
                .await
                .map_err(|e| e.to_string())??;
        let mut out = Vec::with_capacity(12 + mask.px.len());
        out.extend_from_slice(&(mask.w as u16).to_le_bytes());
        out.extend_from_slice(&(mask.h as u16).to_le_bytes());
        out.extend_from_slice(&mask.vision_us.to_le_bytes());
        out.extend_from_slice(&(started.elapsed().as_micros() as u32).to_le_bytes());
        out.extend_from_slice(&mask.px);
        Ok(tauri::ipc::Response::new(out))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (w, h, rgba, started);
        Err("Apple Vision is only available on macOS".into())
    }
}

/// Benchmark harness for the prototype, enabled by `VOXAL_VISION_BENCH=<path to a
/// JPEG frame>`: hands the page that frame, so the probe has a real person to cut out.
#[tauri::command]
fn vision_bench_frame() -> Result<tauri::ipc::Response, String> {
    let path = std::env::var("VOXAL_VISION_BENCH").map_err(|_| "off".to_string())?;
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// The probe's report goes to stderr, so a `make dev` run can be read back.
#[tauri::command]
fn vision_bench_report(text: String) {
    eprintln!("[vision-bench] {text}");
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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PttShortcut(Mutex::new(DEFAULT_SHORTCUT.to_string())))
        .setup(|app| {
            // The main window is built here rather than by tauri.conf.json
            // (`"create": false` there), because only a builder can take a
            // `window.open` handler — see `open_child_window`.
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no window labelled \"main\"")?;
            let opener = app.handle().clone();
            #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
            let main_window = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)?
                .on_new_window(move |url, features| open_child_window(&opener, url, features))
                .build()?;

            #[cfg(target_os = "macos")]
            prepare_main_window_macos(&main_window);

            #[cfg(target_os = "macos")]
            {
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
            let prefs = MenuItem::with_id(
                app,
                "preferences",
                "Preferences…",
                true,
                Some("CmdOrCtrl+,"),
            )?;

            let app_submenu = SubmenuBuilder::new(app, "Voxal")
                .item(&about)
                .separator()
                .item(&prefs)
                .separator()
                .quit()
                .build()?;

            // "Enter Full Screen" (⌃⌘F) lives in View and the window's own
            // commands in Window, where every Mac app keeps them. A custom
            // menu replaces the default one wholesale, so leaving these out
            // took the keyboard way into full screen with them. Window is also
            // registered as the app's Window menu (below): that is what makes
            // macOS add its own placement items to it — Fill, Center, Move &
            // Resize (halves, quarters, arrangements), Full Screen Tile — and
            // the list of open windows.
            let view_submenu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
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
                        .build()?,
                )
                .item(&view_submenu)
                .item(&window_submenu)
                .build()?;

            app.set_menu(menu)?;
            #[cfg(target_os = "macos")]
            window_submenu.set_as_windows_menu_for_nsapp()?;

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
            app.handle()
                .global_shortcut()
                .on_shortcut(DEFAULT_SHORTCUT, |app, _, event| match event.state {
                    ShortcutState::Pressed => {
                        let _ = app.emit("ptt-press", ());
                    }
                    ShortcutState::Released => {
                        let _ = app.emit("ptt-release", ());
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
        .invoke_handler(tauri::generate_handler![
            update_ptt_shortcut,
            presence_fetch,
            get_device_stats,
            vision_foreground_mask,
            vision_bench_frame,
            vision_bench_report
        ])
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
    fn parse_presence_response_truncates_multibyte_body_without_panicking() {
        // Regression: the preview used to be a byte slice, so a non-ASCII error
        // page — a gateway's own translated one, say — cut mid-character and
        // panicked, taking the whole IPC call down instead of returning Err.
        let body = format!("a{}", "€".repeat(200));
        let err = parse_presence_response_text(&body).unwrap_err();
        let preview = err.trim_start_matches("Non-JSON response: ");
        assert_eq!(preview.chars().count(), 120);
        assert!(preview.starts_with("a€"));
    }

    #[test]
    fn parse_presence_response_keeps_a_short_non_json_body_whole() {
        let err = parse_presence_response_text("  Bad Gateway  ").unwrap_err();
        assert_eq!(err, "Non-JSON response: Bad Gateway");
    }

    #[test]
    fn parse_presence_response_parses_json_array() {
        let parsed = parse_presence_response_text("[{\"a\":1},{\"a\":2}]").unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed.as_array().unwrap().len(), 2);
    }
}
