use anyhow::Result;
use std::collections::HashMap;
use tokio::process::Command;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStatus {
    pub running: bool,
    pub container_id: Option<String>,
    pub uptime_secs: Option<u64>,
}

pub struct SandboxManager;

impl SandboxManager {
    /// Check if Docker daemon is reachable.
    pub async fn is_docker_available() -> bool {
        Command::new("docker")
            .args(["info", "--format", "{{.ServerVersion}}"])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Returns true if the aether stack containers for `tenant_id` are running.
    pub async fn is_running(tenant_id: &str) -> bool {
        let output = Command::new("docker")
            .args([
                "ps",
                "--filter",
                &format!("label=aether.tenant={}", tenant_id),
                "--format",
                "{{.ID}}",
            ])
            .output()
            .await;

        match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                !stdout.trim().is_empty()
            }
            _ => false,
        }
    }

    /// Start the aether stack via docker compose.
    /// Returns the first container ID on success.
    pub async fn start(
        tenant_id: &str,
        env: &HashMap<String, String>,
    ) -> Result<String> {
        let compose_file = Self::compose_file_path(tenant_id)?;

        let mut cmd = Command::new("docker");
        cmd.args(["compose", "-f", &compose_file, "up", "-d", "--pull", "never"]);

        // Forward env vars into the subprocess environment.
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.env("AETHER_TENANT_ID", tenant_id);

        let output = cmd.output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("docker compose up failed: {}", stderr);
        }

        // Retrieve the first container ID for this tenant.
        let id_output = Command::new("docker")
            .args([
                "ps",
                "-q",
                "--filter",
                &format!("label=aether.tenant={}", tenant_id),
            ])
            .output()
            .await?;

        let container_id = String::from_utf8_lossy(&id_output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        Ok(container_id)
    }

    /// Stop the aether stack via docker compose.
    pub async fn stop(tenant_id: &str) -> Result<()> {
        let compose_file = Self::compose_file_path(tenant_id)?;

        let output = Command::new("docker")
            .args(["compose", "-f", &compose_file, "down"])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("docker compose down failed: {}", stderr);
        }
        Ok(())
    }

    /// Returns detailed status for the tenant's sandbox.
    pub async fn status(tenant_id: &str) -> SandboxStatus {
        let output = Command::new("docker")
            .args([
                "ps",
                "--filter",
                &format!("label=aether.tenant={}", tenant_id),
                "--format",
                "{{.ID}}|||{{.RunningFor}}",
            ])
            .output()
            .await;

        match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let line = stdout.trim();
                if line.is_empty() {
                    return SandboxStatus {
                        running: false,
                        container_id: None,
                        uptime_secs: None,
                    };
                }
                let parts: Vec<&str> = line.splitn(2, "|||").collect();
                let container_id = parts.first().map(|s| s.trim().to_string());
                // Parse uptime from docker's "X minutes ago" string — approximate.
                let uptime_secs = parts
                    .get(1)
                    .and_then(|s| Self::parse_uptime(s.trim()));

                SandboxStatus {
                    running: true,
                    container_id,
                    uptime_secs,
                }
            }
            _ => SandboxStatus {
                running: false,
                container_id: None,
                uptime_secs: None,
            },
        }
    }

    /// Stream docker logs for the tenant's main container.
    /// Returns a channel receiver; the caller should read lines until closed.
    pub async fn get_logs(tenant_id: &str, tail: u32) -> Vec<String> {
        // Discover the first container for this tenant.
        let id_out = Command::new("docker")
            .args([
                "ps",
                "-q",
                "--filter",
                &format!("label=aether.tenant={}", tenant_id),
            ])
            .output()
            .await;

        let container_id = match id_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string(),
            Err(_) => return vec!["docker ps failed".to_string()],
        };

        if container_id.is_empty() {
            return vec!["No running container found for this tenant.".to_string()];
        }

        let log_out = Command::new("docker")
            .args([
                "logs",
                "--tail",
                &tail.to_string(),
                "--timestamps",
                &container_id,
            ])
            .output()
            .await;

        match log_out {
            Ok(o) => {
                let combined = [o.stdout, o.stderr].concat();
                String::from_utf8_lossy(&combined)
                    .lines()
                    .map(str::to_string)
                    .collect()
            }
            Err(e) => vec![format!("Failed to fetch logs: {e}")],
        }
    }

    /// Pull the latest aether-stack image, reporting progress via callback.
    pub async fn pull_image<F>(progress_cb: F) -> Result<()>
    where
        F: Fn(String) + Send + 'static,
    {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut child = Command::new("docker")
            .args([
                "pull",
                "ghcr.io/aethermesh/aether-stack:latest",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                progress_cb(line);
            }
        }

        if let Some(stderr) = child.stderr.take() {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                progress_cb(line);
            }
        }

        let status = child.wait().await?;
        if !status.success() {
            anyhow::bail!("docker pull failed with status {status}");
        }
        Ok(())
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn compose_file_path(tenant_id: &str) -> Result<String> {
        // The docker-compose.yml lives two levels above the app directory.
        let exe = std::env::current_exe()?;
        // Walk up to find the project root containing docker-compose.yml.
        let mut dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
        for _ in 0..8 {
            let candidate = dir.join("docker-compose.yml");
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().to_string());
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
        // Fallback: use tenant-specific path from config dir.
        let config_dir = dirs_next::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("aether")
            .join(tenant_id);
        Ok(config_dir
            .join("docker-compose.yml")
            .to_string_lossy()
            .to_string())
    }

    /// Roughly parse Docker's human-readable uptime strings to seconds.
    fn parse_uptime(s: &str) -> Option<u64> {
        let s = s.to_lowercase();
        let s = s.trim_end_matches(" ago").trim();
        let parts: Vec<&str> = s.split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }
        let n: u64 = parts[0].parse().ok()?;
        let unit = parts[1];
        let secs = if unit.starts_with("second") {
            n
        } else if unit.starts_with("minute") {
            n * 60
        } else if unit.starts_with("hour") {
            n * 3600
        } else if unit.starts_with("day") {
            n * 86400
        } else if unit.starts_with("week") {
            n * 604800
        } else if unit.starts_with("month") {
            n * 2592000
        } else {
            return None;
        };
        Some(secs)
    }
}
