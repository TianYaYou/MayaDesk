use std::env;

#[derive(Clone, Debug)]
pub struct StoragePoolConfig {
    pub id: String,
    pub name: String,
    pub pool_type: String, // "private" | "shared"
    pub mount_path: String,
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub google_client_id: String,
    pub google_client_secret: String,
    pub google_redirect_url: String,
    pub cf_tunnel_token: Option<String>,
    pub stun_servers: Vec<String>,
    pub p2p_handshake_timeout_ms: u64,
    pub storage_pools: Vec<StoragePoolConfig>,
}

impl AppConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let private_root = env::var("PRIVATE_POOL_ROOT").unwrap_or_else(|_| "./data/private".into());
        let mut pools = vec![StoragePoolConfig {
            id: "pool-private-main".into(),
            name: "Private Drive Pool".into(),
            pool_type: "private".into(),
            mount_path: private_root,
        }];

        if let Ok(shared_raw) = env::var("SHARED_POOLS") {
            for entry in shared_raw.split(',').filter(|s| !s.trim().is_empty()) {
                if let Some((name, path)) = entry.split_once(':') {
                    pools.push(StoragePoolConfig {
                        id: format!("pool-shared-{}", name.trim()),
                        name: format!("NAS Shared ({})", name.trim()),
                        pool_type: "shared".into(),
                        mount_path: path.trim().into(),
                    });
                }
            }
        }

        let stun_servers = env::var("STUN_SERVERS")
            .unwrap_or_else(|_| "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        Ok(Self {
            host: env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env::var("SERVER_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8080),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite://./data/mayadesk.db?mode=rwc".into()),
            jwt_secret: env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-key".into()),
            google_client_id: env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            google_client_secret: env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
            google_redirect_url: env::var("GOOGLE_REDIRECT_URL").unwrap_or_default(),
            cf_tunnel_token: env::var("CF_TUNNEL_TOKEN").ok(),
            stun_servers,
            p2p_handshake_timeout_ms: env::var("P2P_HANDSHAKE_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1500),
            storage_pools: pools,
        })
    }
}
