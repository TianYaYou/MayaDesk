use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use serde::{Deserialize, Serialize};
use crate::config::{AppConfig, StoragePoolConfig};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiskMountSummary {
    pub id: String,
    pub name: String,
    pub pool_type: String, // "private" | "shared"
    pub mount_path: String,
    pub quota_gb: u64,
    pub used_bytes: u64,
    pub read_only: bool,
    pub online: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VfsFileEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_unix: u64,
    pub blake3_short: Option<String>,
}

/// Resolves physical paths safely across multi-disk NAS mounts while preventing path traversal (`..`).
pub struct StorageManager;

impl StorageManager {
    pub fn list_mounts(config: &AppConfig, user_id: &str) -> Vec<DiskMountSummary> {
        config
            .storage
            .pools
            .iter()
            .map(|pool| {
                let root = Self::resolve_pool_base_dir(pool, user_id);
                let online = fs::create_dir_all(&root).is_ok();
                let used_bytes = Self::calculate_dir_size(&root).unwrap_or(0);
                DiskMountSummary {
                    id: pool.id.clone(),
                    name: pool.name.clone(),
                    pool_type: pool.pool_type.clone(),
                    mount_path: pool.mount_path.clone(),
                    quota_gb: pool.quota_gb,
                    used_bytes,
                    read_only: pool.read_only,
                    online,
                }
            })
            .collect()
    }

    pub fn resolve_pool_base_dir(pool: &StoragePoolConfig, user_id: &str) -> PathBuf {
        let base = PathBuf::from(&pool.mount_path);
        if pool.pool_type == "private" {
            base.join(sanitize_segment(user_id))
        } else {
            base
        }
    }

    pub fn resolve_safe_target(
        config: &AppConfig,
        pool_id: &str,
        user_id: &str,
        rel_path: &str,
    ) -> anyhow::Result<(StoragePoolConfig, PathBuf)> {
        let pool = config
            .storage
            .pools
            .iter()
            .find(|p| p.id == pool_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("未找到存储池: {}", pool_id))?;

        let base = Self::resolve_pool_base_dir(&pool, user_id);
        fs::create_dir_all(&base)?;

        let mut clean_rel = PathBuf::new();
        for comp in Path::new(rel_path.trim_start_matches('/')).components() {
            if let Component::Normal(part) = comp {
                clean_rel.push(part);
            }
        }

        Ok((pool, base.join(clean_rel)))
    }

    pub fn list_directory(
        config: &AppConfig,
        pool_id: &str,
        user_id: &str,
        rel_path: &str,
    ) -> anyhow::Result<Vec<VfsFileEntry>> {
        let (_pool, target_dir) = Self::resolve_safe_target(config, pool_id, user_id, rel_path)?;
        if !target_dir.exists() {
            fs::create_dir_all(&target_dir)?;
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&target_dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let child_rel = if rel_path.trim_matches('/').is_empty() {
                format!("/{}", name)
            } else {
                format!("/{}/{}", rel_path.trim_matches('/'), name)
            };
            let modified_unix = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let blake3_short = if meta.is_file() && meta.len() <= 32 * 1024 * 1024 {
                fs::read(entry.path())
                    .ok()
                    .map(|bytes| blake3::hash(&bytes).to_hex()[..12].to_string())
            } else {
                None
            };

            entries.push(VfsFileEntry {
                name,
                rel_path: child_rel,
                is_dir: meta.is_dir(),
                size_bytes: if meta.is_dir() { 0 } else { meta.len() },
                modified_unix,
                blake3_short,
            });
        }

        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
        Ok(entries)
    }

    fn calculate_dir_size(path: &Path) -> std::io::Result<u64> {
        let mut total = 0;
        if path.is_dir() {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let meta = entry.metadata()?;
                if meta.is_dir() {
                    total += Self::calculate_dir_size(&entry.path()).unwrap_or(0);
                } else {
                    total += meta.len();
                }
            }
        }
        Ok(total)
    }
}

fn sanitize_segment(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}
