pub mod commands;
pub mod sandbox;
pub mod vault;

use commands::*;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // ── System Tray ──────────────────────────────────────────────────
            let open_item =
                MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let start_item =
                MenuItem::with_id(app, "start", "Start Agent", true, None::<&str>)?;
            let stop_item =
                MenuItem::with_id(app, "stop", "Stop Agent", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[&open_item, &start_item, &stop_item, &sep, &quit_item],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Aether Mesh")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "start" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let cfg = get_config().await;
                            let _ = sandbox_start(cfg.tenant_id).await;
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit("sandbox-state-changed", "started");
                            }
                        });
                    }
                    "stop" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let cfg = get_config().await;
                            let _ = sandbox_stop(cfg.tenant_id).await;
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit("sandbox-state-changed", "stopped");
                            }
                        });
                    }
                    "quit" => {
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
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // ── Auto-start sandbox if configured ─────────────────────────────
            tauri::async_runtime::spawn(async move {
                let cfg = get_config().await;
                if cfg.configured && cfg.auto_start {
                    let mut env = std::collections::HashMap::new();
                    if let Ok(Some(k)) = vault::load_secret("api_key") {
                        env.insert("BRAIN_API_KEY".to_string(), k);
                    }
                    if let Ok(Some(p)) = vault::load_secret("provider") {
                        env.insert("BRAIN_PROVIDER".to_string(), p);
                    }
                    if let Ok(Some(m)) = vault::load_secret("model") {
                        env.insert("BRAIN_MODEL".to_string(), m);
                    }
                    let _ = sandbox::SandboxManager::start(&cfg.tenant_id, &env).await;
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.emit("sandbox-state-changed", "started");
                    }
                }
            });

            Ok(())
        })
        // ── Minimize to tray on close ────────────────────────────────────────
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        // ── Register IPC commands ────────────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            sandbox_start,
            sandbox_stop,
            sandbox_status,
            is_docker_available,
            pull_image,
            get_logs,
            open_dashboard,
            platform_ping,
            vault_save,
            vault_load,
            vault_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aether Mesh");
}
