use std::{env, fs, path::Path};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServerSection {
    pub app_name: String,
    pub host: String,
    pub port: u16,
    pub public_url: String,
    pub static_dir: String,
    pub temp_upload_dir: String,
    pub log_dir: String,
    pub max_upload_size_mb: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DatabaseSection {
    pub sqlite_path: String,
    pub auto_migrate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GoogleAuthSection {
    pub enabled: bool,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthSection {
    pub jwt_secret: String,
    pub access_token_ttl_secs: usize,
    pub refresh_token_ttl_days: usize,
    pub allow_registration: bool,
    pub default_admin_email: String,
    pub default_admin_password: String,
    pub google: GoogleAuthSection,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloudflareTunnelSection {
    pub enabled: bool,
    pub tunnel_name: String,
    pub tunnel_token: String,
    pub fallback_https_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NetworkSection {
    pub p2p_enabled: bool,
    pub p2p_udp_port: u16,
    pub p2p_handshake_timeout_ms: u64,
    pub chunk_size_kb: usize,
    pub stun_servers: Vec<String>,
    pub cloudflare_tunnel: CloudflareTunnelSection,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoragePoolConfig {
    pub id: String,
    pub name: String,
    pub pool_type: String, // "private" | "shared"
    pub mount_path: String,
    pub quota_gb: u64,
    pub read_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageSection {
    pub pools: Vec<StoragePoolConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerSection,
    pub database: DatabaseSection,
    pub auth: AuthSection,
    pub network: NetworkSection,
    pub storage: StorageSection,
    #[serde(skip)]
    pub config_file_path: String,
}

impl AppConfig {
    pub fn load() -> anyhow::Result<Self> {
        let config_path = env::var("MAYADESK_CONFIG")
            .unwrap_or_else(|_| "./config/config.toml".to_string());

        let mut cfg: AppConfig = if Path::new(&config_path).exists() {
            let raw = fs::read_to_string(&config_path)?;
            toml::from_str(&raw)?
        } else {
            Self::default_config()
        };

        cfg.config_file_path = config_path;
        cfg.apply_env_overrides();
        cfg.ensure_directories()?;
        Ok(cfg)
    }

    pub fn save_to_disk(&self) -> anyhow::Result<()> {
        if let Some(parent) = Path::new(&self.config_file_path).parent() {
            fs::create_dir_all(parent)?;
        }
        let serialized = toml::to_string_pretty(self)?;
        fs::write(&self.config_file_path, serialized)?;
        self.ensure_directories()?;
        Ok(())
    }

    pub fn ensure_directories(&self) -> anyhow::Result<()> {
        fs::create_dir_all(&self.server.temp_upload_dir)?;
        fs::create_dir_all(&self.server.log_dir)?;
        if let Some(db_parent) = Path::new(&self.database.sqlite_path).parent() {
            fs::create_dir_all(db_parent)?;
        }
        for pool in &self.storage.pools {
            fs::create_dir_all(&pool.mount_path)?;
        }
        Ok(())
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(v) = env::var("SERVER_HOST") {
            self.server.host = v;
        }
        if let Ok(v) = env::var("SERVER_PORT") {
            if let Ok(p) = v.parse() {
                self.server.port = p;
            }
        }
        if let Ok(v) = env::var("PUBLIC_URL") {
            self.server.public_url = v;
        }
        if let Ok(v) = env::var("STATIC_DIR") {
            self.server.static_dir = v;
        }
        if let Ok(v) = env::var("TEMP_UPLOAD_DIR") {
            self.server.temp_upload_dir = v;
        }
        if let Ok(v) = env::var("SQLITE_PATH") {
            self.database.sqlite_path = v;
        }
        if let Ok(v) = env::var("JWT_SECRET") {
            self.auth.jwt_secret = v;
        }
        if let Ok(v) = env::var("GOOGLE_CLIENT_ID") {
            self.auth.google.client_id = v;
        }
        if let Ok(v) = env::var("GOOGLE_CLIENT_SECRET") {
            self.auth.google.client_secret = v;
        }
        if let Ok(v) = env::var("GOOGLE_REDIRECT_URI") {
            self.auth.google.redirect_uri = v;
        }
        if let Ok(v) = env::var("CF_TUNNEL_TOKEN") {
            if !v.is_empty() {
                self.network.cloudflare_tunnel.tunnel_token = v;
                self.network.cloudflare_tunnel.enabled = true;
            }
        }
        if let Ok(v) = env::var("PRIVATE_POOL_ROOT") {
            if let Some(first_priv) = self.storage.pools.iter_mut().find(|p| p.pool_type == "private") {
                first_priv.mount_path = v;
            }
        }
    }

    pub fn default_config() -> Self {
        Self {
            server: ServerSection {
                app_name: "MayaDesk".into(),
                host: "0.0.0.0".into(),
                port: 8080,
                public_url: "http://localhost:8080".into(),
                static_dir: "./frontend/dist".into(),
                temp_upload_dir: "./data/tmp_chunks".into(),
                log_dir: "./data/logs".into(),
                max_upload_size_mb: 102400,
            },
            database: DatabaseSection {
                sqlite_path: "./data/db/mayadesk.db".into(),
                auto_migrate: true,
            },
            auth: AuthSection {
                jwt_secret: "dev-secret-change-in-production".into(),
                access_token_ttl_secs: 3600,
                refresh_token_ttl_days: 30,
                allow_registration: true,
                default_admin_email: "admin@mayadesk.local".into(),
                default_admin_password: "admin123456".into(),
                google: GoogleAuthSection {
                    enabled: true,
                    client_id: "".into(),
                    client_secret: "".into(),
                    redirect_uri: "http://localhost:8080/api/v1/auth/google/callback".into(),
                },
            },
            network: NetworkSection {
                p2p_enabled: true,
                p2p_udp_port: 51820,
                p2p_handshake_timeout_ms: 1500,
                chunk_size_kb: 4096,
                stun_servers: vec![
                    "stun:stun.cloudflare.com:3478".into(),
                    "stun:stun.l.google.com:19302".into(),
                ],
                cloudflare_tunnel: CloudflareTunnelSection {
                    enabled: true,
                    tunnel_name: "mayadesk-nas-tunnel".into(),
                    tunnel_token: "".into(),
                    fallback_https_enabled: true,
                },
            },
            storage: StorageSection {
                pools: vec![
                    StoragePoolConfig {
                        id: "private-main".into(),
                        name: "私人主硬盘 (NVMe)".into(),
                        pool_type: "private".into(),
                        mount_path: "./data/storage/private_nvme".into(),
                        quota_gb: 1024,
                        read_only: false,
                    },
                    StoragePoolConfig {
                        id: "shared-nas-disk1".into(),
                        name: "共享盘 01 · 团队资料库".into(),
                        pool_type: "shared".into(),
                        mount_path: "./data/storage/shared_disk1".into(),
                        quota_gb: 4096,
                        read_only: false,
                    },
                    StoragePoolConfig {
                        id: "shared-nas-disk2".into(),
                        name: "共享盘 02 · 媒体与归档阵列".into(),
                        pool_type: "shared".into(),
                        mount_path: "./data/storage/shared_disk2".into(),
                        quota_gb: 8192,
                        read_only: false,
                    },
                ],
            },
            config_file_path: "./config/config.toml".into(),
        }
    }
}
