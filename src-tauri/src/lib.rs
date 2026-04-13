use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri::menu::{AboutMetadata, MenuItem, MenuBuilder, SubmenuBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_deep_link::DeepLinkExt;

const DEFAULT_SHORTCUT: &str = "Ctrl+Backquote";

struct PttShortcut(Mutex<String>);

// Proxy HTTP requests through Rust to bypass WebView CORS restrictions.
// The Tauri WebView origin (tauri://localhost) is not whitelisted by external APIs.
#[tauri::command]
async fn presence_fetch(
    url: String,
    method: String,
    token: Option<String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut req = match method.to_uppercase().as_str() {
        "POST"   => client.post(&url),
        "DELETE" => client.delete(&url),
        _        => client.get(&url),
    };
    if let Some(t) = token {
        req = req.header("x-api-token", t);
    }
    if let Some(b) = body {
        req = req.header("content-type", "application/json").body(b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status >= 400 {
        return Err(format!("HTTP {}", status));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|_| {
        let preview = &trimmed[..trimmed.len().min(120)];
        format!("Non-JSON response: {}", preview)
    })
}

#[tauri::command]
fn update_ptt_shortcut(
    app: AppHandle,
    state: State<PttShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let mut current = state.0.lock().unwrap();
    app.global_shortcut().unregister(current.as_str()).ok();
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), |app, _, event| {
            match event.state {
                ShortcutState::Pressed  => { let _ = app.emit("ptt-press",   ()); }
                ShortcutState::Released => { let _ = app.emit("ptt-release", ()); }
            }
        })
        .map_err(|e| e.to_string())?;
    *current = shortcut;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .manage(PttShortcut(Mutex::new(DEFAULT_SHORTCUT.to_string())))
        .setup(|app| {
            // Register voxel:// scheme (Windows/Linux: dynamic registry/desktop entry;
            // macOS: requires a proper build — scheme is baked into the .app bundle)
            app.deep_link().register_all().ok();

            // Build the app menu with a native About Voxel dialog
            let about = AboutMetadata {
                name: Some("Voxel".to_string()),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
                comments: Some("Serverless push-to-talk voice chat".to_string()),
                website: Some("https://github.com/erwannrobin/voxel".to_string()),
                icon: app.default_window_icon().cloned(),
                ..Default::default()
            };

            let prefs = MenuItem::with_id(app, "preferences", "Preferences…", true, Some("CmdOrCtrl+,"))?;

            let app_submenu = SubmenuBuilder::new(app, "Voxel")
                .about(Some(about))
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

            let prefs_id = prefs.id().clone();
            app.on_menu_event(move |app, event| {
                if event.id() == &prefs_id {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![update_ptt_shortcut, presence_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
