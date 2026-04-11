use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri::menu::{AboutMetadata, MenuItem, MenuBuilder, SubmenuBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const DEFAULT_SHORTCUT: &str = "Ctrl+Backquote";

struct PttShortcut(Mutex<String>);

#[tauri::command]
fn update_ptt_shortcut(
    app: AppHandle,
    state: State<PttShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let mut current = state.0.lock().unwrap();

    // Unregister the old shortcut (ignore error – may not be registered yet)
    app.global_shortcut().unregister(current.as_str()).ok();

    // Register the new one with the same ptt-press / ptt-release handler
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
        .manage(PttShortcut(Mutex::new(DEFAULT_SHORTCUT.to_string())))
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![update_ptt_shortcut])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
