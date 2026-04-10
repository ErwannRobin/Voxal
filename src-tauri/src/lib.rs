use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Ctrl+` is the default PTT shortcut (works globally, even when app is in background)
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::Backquote);
            app.handle().global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                match event.state {
                    ShortcutState::Pressed  => { let _ = app.emit("ptt-press",   ()); }
                    ShortcutState::Released => { let _ = app.emit("ptt-release", ()); }
                }
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
