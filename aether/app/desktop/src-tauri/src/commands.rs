use crate::sandbox::{SandboxManager, SandboxStatus};
use crate::vault;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, WebviewWindow};

const DEFAULT_PLATFORM_URL: &str = "https://aether-mesh-production.up.railway.app";

/// Persisted application configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub tenant_id: String,
    pub auto_start: bool,
    pub provider: String,
    pub model: String,
    pub ollama_url: Option<String>,
    pub tier: String,
    pub channels: Vec<String>,
    pub configured: bool,
    #[serde(default = "default_platform_url")]
    pub platform_url: String,
}

fn default_platform_url() -> String {
    DEFAULT_PLATFORM_URL.to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            tenant_id: uuid_v4(),
            auto_start: false,
            provider: "anthropic".to_string(),
            model: "claude-3-5-sonnet-20241022".to_string(),
            ollama_url: None,
            tier: "starter".to_string(),
            channels: vec![],
            configured: false,
            platform_url: DEFAULT_PLATFORM_URL.to_string(),
        }
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("aether-{:x}", t)
}

fn config_path() -> std::path::PathBuf {
    dirs_next::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aether")
        .join("desktop-config.json")
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_config() -> AppConfig {
    let path = config_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

#[tauri::command]
pub async fn save_config(cfg: AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sandbox_start(tenant_id: String) -> Result<String, String> {
    let mut env: HashMap<String, String> = HashMap::new();

    // Load secrets from vault.
    if let Ok(Some(key)) = vault::load_secret("api_key") {
        env.insert("BRAIN_API_KEY".to_string(), key);
    }
    if let Ok(Some(provider)) = vault::load_secret("provider") {
        env.insert("BRAIN_PROVIDER".to_string(), provider);
    }
    if let Ok(Some(model)) = vault::load_secret("model") {
        env.insert("BRAIN_MODEL".to_string(), model);
    }
    if let Ok(Some(ollama_url)) = vault::load_secret("ollama_url") {
        env.insert("OLLAMA_BASE_URL".to_string(), ollama_url);
    }

    SandboxManager::start(&tenant_id, &env)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sandbox_stop(tenant_id: String) -> Result<(), String> {
    SandboxManager::stop(&tenant_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sandbox_status(tenant_id: String) -> SandboxStatus {
    SandboxManager::status(&tenant_id).await
}

#[tauri::command]
pub async fn is_docker_available() -> bool {
    SandboxManager::is_docker_available().await
}

/// Pull the aether-stack image and emit progress events to the frontend.
#[tauri::command]
pub async fn pull_image(window: WebviewWindow) -> Result<(), String> {
    let window_clone = window.clone();
    SandboxManager::pull_image(move |line| {
        let _ = window_clone.emit("pull-progress", &line);
    })
    .await
    .map_err(|e| e.to_string())?;

    let _ = window.emit("pull-complete", ());
    Ok(())
}

#[tauri::command]
pub async fn get_logs(tenant_id: String, tail: u32) -> Vec<String> {
    SandboxManager::get_logs(&tenant_id, tail).await
}

/// Ping the platform health endpoint. Returns true if reachable.
#[tauri::command]
pub async fn platform_ping(platform_url: String) -> bool {
    let url = format!("{}/health", platform_url.trim_end_matches('/'));
    match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Open the Aether web dashboard in the default browser.
/// Uses the configured platform_url; falls back to localhost for local mode.
#[tauri::command]
pub async fn open_dashboard(_app: AppHandle) {
    let cfg = get_config().await;
    let url = if cfg.platform_url.is_empty() {
        "http://localhost:8080".to_string()
    } else {
        cfg.platform_url.clone()
    };
    let _ = open::that(url);
}

/// Save a secret to the OS vault.
#[tauri::command]
pub fn vault_save(key: String, value: String) -> Result<(), String> {
    vault::save_secret(&key, &value).map_err(|e| e.to_string())
}

/// Load a secret from the OS vault (returns None if not found).
#[tauri::command]
pub fn vault_load(key: String) -> Result<Option<String>, String> {
    vault::load_secret(&key).map_err(|e| e.to_string())
}

/// Delete a secret from the OS vault.
#[tauri::command]
pub fn vault_delete(key: String) -> Result<(), String> {
    vault::delete_secret(&key).map_err(|e| e.to_string())
}
