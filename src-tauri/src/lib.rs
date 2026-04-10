use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
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
