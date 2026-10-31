use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::Instant;

use crate::hasher::LOGICAL_BLOCK_SIZE;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFolderRule {
    pub id: String,
    pub local_path: String,
    pub space: String,
    pub remote_path: String,
    pub enabled: bool,
    pub last_sync_iso: Option<String>,
}

fn default_theme_mode() -> String {
    "system".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacClientConfig {
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    pub server_url: String,
    pub lan_direct_url: Option<String>,
    pub prefer_p2p_lan: bool,
    pub close_to_tray: bool,
    pub webdav_port: u16,
    pub finder_mount_point: String,
    pub cache_limit_gb: u32,
    pub sync_folders: Vec<SyncFolderRule>,
}

impl Default for MacClientConfig {
    fn default() -> Self {
        let default_download_sync = dirs::download_dir()
            .unwrap_or_else(|| PathBuf::from("/Users/shared"))
            .join("MayaDeskSync");

        Self {
            onboarding_completed: false,
            theme_mode: "system".to_string(),
            server_url: "http://127.0.0.1:8080".to_string(),
            lan_direct_url: Some("http://127.0.0.1:8080".to_string()),
            prefer_p2p_lan: true,
            close_to_tray: true,
            webdav_port: 18085,
            finder_mount_point: "/Volumes/MayaDesk".to_string(),
            cache_limit_gb: 4,
            sync_folders: vec![SyncFolderRule {
                id: "sync_default_01".to_string(),
                local_path: default_download_sync.display().to_string(),
                space: "private".to_string(),
                remote_path: "/MacSync".to_string(),
                enabled: false,
                last_sync_iso: None,
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerProbeResult {
    pub reachable: bool,
    pub normalized_url: String,
    pub api_base_url: String,
    pub rtt_ms: u64,
    pub mode: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeUploadResult {
    pub file_name: String,
    pub local_path: String,
    pub remote_space: String,
    pub remote_path: String,
    pub size_bytes: u64,
    pub total_chunks: u32,
    pub blake3_short: String,
    pub elapsed_ms: u64,
}

pub fn app_support_dir() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = base.join("com.mayadesk.clouddrive");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn config_file_path() -> PathBuf {
    app_support_dir().join("macos_client.json")
}

pub fn load_config() -> MacClientConfig {
    let path = config_file_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<MacClientConfig>(&raw) {
            return cfg;
        }
    }
    let cfg = MacClientConfig::default();
    let _ = save_config(&cfg);
    cfg
}

pub fn save_config(cfg: &MacClientConfig) -> Result<(), String> {
    let path = config_file_path();
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("序列化客户端配置失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入客户端配置失败 ({}): {e}", path.display()))
}

pub fn normalize_server_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "http://127.0.0.1:8080".to_string();
    }
    if let Some(stripped) = trimmed.strip_suffix("/api/v1") {
        return stripped.to_string();
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return format!("http://{trimmed}");
    }
    trimmed.to_string()
}

pub async fn probe_server_endpoint(raw_url: &str) -> ServerProbeResult {
    let normalized = normalize_server_url(raw_url);
    let api_base = format!("{normalized}/api/v1");
    let probe_target = format!("{api_base}/disks");

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ServerProbeResult {
                reachable: false,
                normalized_url: normalized,
                api_base_url: api_base,
                rtt_ms: 0,
                mode: "offline".to_string(),
                message: format!("HTTP 客户端初始化失败: {e}"),
            }
        }
    };

    let started = Instant::now();
    match client.get(&probe_target).send().await {
        Ok(resp) => {
            let rtt_ms = started.elapsed().as_millis() as u64;
            let is_lan = normalized.contains("127.0.0.1")
                || normalized.contains("localhost")
                || normalized.contains("192.168.")
                || normalized.contains("10.")
                || normalized.contains(".local");
            let mode = if is_lan {
                "p2p-lan".to_string()
            } else {
                "cf-tunnel-web".to_string()
            };
            ServerProbeResult {
                reachable: resp.status().is_success() || resp.status().as_u16() == 401,
                normalized_url: normalized,
                api_base_url: api_base,
                rtt_ms: rtt_ms.max(1),
                mode,
                message: format!("连接成功 (HTTP {}, RTT {} ms)", resp.status().as_u16(), rtt_ms.max(1)),
            }
        }
        Err(err) => ServerProbeResult {
            reachable: false,
            normalized_url: normalized,
            api_base_url: api_base,
            rtt_ms: 0,
            mode: "offline".to_string(),
            message: format!("无法连接至服务器: {err}"),
        },
    }
}

/// Native Rust zero-OOM chunked file upload directly from macOS filesystem to MayaDesk Server.
pub async fn upload_local_file_native(
    server_url: &str,
    space: &str,
    remote_dir: &str,
    local_path_str: &str,
    token: Option<String>,
) -> Result<NativeUploadResult, String> {
    let started = Instant::now();
    let local_path = PathBuf::from(local_path_str);
    if !local_path.exists() {
        return Err(format!("本地文件不存在: {local_path_str}"));
    }

    let hash_report = crate::hasher::hash_local_file(&local_path)?;
    let normalized = normalize_server_url(server_url);
    let api_base = format!("{normalized}/api/v1");
    let client = reqwest::Client::new();

    let mut file = fs::File::open(&local_path)
        .map_err(|e| format!("无法打开本地文件: {e}"))?;

    let total_chunks = ((hash_report.size_bytes as usize + LOGICAL_BLOCK_SIZE - 1)
        / LOGICAL_BLOCK_SIZE)
        .max(1) as u32;
    let upload_id = format!("mac_{}", uuid::Uuid::new_v4().simple());

    for c_idx in 0..total_chunks {
        let offset = (c_idx as u64) * (LOGICAL_BLOCK_SIZE as u64);
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("文件分片定位失败: {e}"))?;

        let remaining = hash_report.size_bytes.saturating_sub(offset) as usize;
        let read_len = remaining.min(LOGICAL_BLOCK_SIZE);
        let mut buf = vec![0u8; read_len];
        file.read_exact(&mut buf)
            .map_err(|e| format!("读取本地分片失败: {e}"))?;

        let part = reqwest::multipart::Part::bytes(buf).file_name(hash_report.file_name.clone());
        let form = reqwest::multipart::Form::new()
            .text("upload_id", upload_id.clone())
            .text("chunk_index", c_idx.to_string())
            .text("total_chunks", total_chunks.to_string())
            .text("file_name", hash_report.file_name.clone())
            .text("rel_path", hash_report.file_name.clone())
            .text("space", space.to_string())
            .text("path", remote_dir.to_string())
            .part("chunk", part);

        let mut req = client
            .post(format!("{api_base}/files/upload/chunk"))
            .multipart(form);
        if let Some(ref tk) = token {
            if !tk.is_empty() {
                req = req.header("Authorization", format!("Bearer {tk}"));
            }
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("分片 {} 上传网络错误: {e}", c_idx + 1))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("服务端拒绝分片 {}: {}", c_idx + 1, body));
        }
    }

    Ok(NativeUploadResult {
        file_name: hash_report.file_name,
        local_path: local_path_str.to_string(),
        remote_space: space.to_string(),
        remote_path: remote_dir.to_string(),
        size_bytes: hash_report.size_bytes,
        total_chunks,
        blake3_short: hash_report.blake3_short,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
