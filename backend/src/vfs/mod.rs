use serde::{Deserialize, Serialize};
use crate::config::{AppConfig, StoragePoolConfig};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiskMountSummary {
    pub id: String,
    pub name: String,
    pub pool_type: String, // "private" | "shared"
    pub mount_path: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub online: bool,
}

#[derive(Clone)]
pub struct StorageManager {
    pools: Vec<StoragePoolConfig>,
}

impl StorageManager {
    pub async fn initialize(config: &AppConfig) -> anyhow::Result<Self> {
        Ok(Self {
            pools: config.storage_pools.clone(),
        })
    }

    pub fn list_mounts(&self) -> Vec<DiskMountSummary> {
        self.pools
            .iter()
            .map(|p| DiskMountSummary {
                id: p.id.clone(),
                name: p.name.clone(),
                pool_type: p.pool_type.clone(),
                mount_path: p.mount_path.clone(),
                total_bytes: 4 * 1024 * 1024 * 1024 * 1024, // 4 TB example pool metric
                used_bytes: 1_280 * 1024 * 1024 * 1024,
                online: true,
            })
            .collect()
    }
}
