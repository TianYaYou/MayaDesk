use std::{
    fs::{self, File},
    io::{Cursor, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, ZipWriter};

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

pub struct StorageManager;

impl StorageManager {
    /// List all physical storage pool summaries (for admin view)
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

    /// Select best active storage pool for a given space ("private" or "shared") or pool_id
    pub fn find_pool_for_space<'a>(
        config: &'a AppConfig,
        space_or_pool_id: &str,
    ) -> anyhow::Result<&'a StoragePoolConfig> {
        // First try matching exact pool id
        if let Some(p) = config.storage.pools.iter().find(|p| p.id == space_or_pool_id) {
            return Ok(p);
        }

        // Then match by pool_type (private | shared)
        let normalized = if space_or_pool_id.starts_with("priv") {
            "private"
        } else if space_or_pool_id.starts_with("shar") {
            "shared"
        } else {
            space_or_pool_id
        };

        config
            .storage
            .pools
            .iter()
            .find(|p| p.pool_type == normalized && !p.read_only)
            .or_else(|| config.storage.pools.iter().find(|p| p.pool_type == normalized))
            .or_else(|| config.storage.pools.first())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "尚未配置【{}】存储硬盘，请管理员在控制台中添加存储盘挂载路径",
                    if normalized == "private" { "私人空间" } else { "共享空间" }
                )
            })
    }

    /// Resolve absolute filesystem path safely while preventing directory traversal (..)
    pub fn resolve_safe_target(
        config: &AppConfig,
        space_or_pool_id: &str,
        user_id: &str,
        rel_path: &str,
    ) -> anyhow::Result<(StoragePoolConfig, PathBuf)> {
        let pool = Self::find_pool_for_space(config, space_or_pool_id)?.clone();
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
        space_or_pool_id: &str,
        user_id: &str,
        rel_path: &str,
    ) -> anyhow::Result<Vec<VfsFileEntry>> {
        let (_pool, target_dir) = Self::resolve_safe_target(config, space_or_pool_id, user_id, rel_path)?;
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

    /// List all subfolder relative paths under a space for left sidebar path navigation
    pub fn list_folder_paths(
        config: &AppConfig,
        space_or_pool_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<String>> {
        let (_pool, base_dir) = Self::resolve_safe_target(config, space_or_pool_id, user_id, "/")?;
        let mut paths = vec!["/".to_string()];
        if base_dir.exists() {
            Self::collect_subdirs_recursive(&base_dir, &base_dir, &mut paths, 3)?;
        }
        paths.sort();
        Ok(paths)
    }

    fn collect_subdirs_recursive(
        root: &Path,
        current: &Path,
        out: &mut Vec<String>,
        max_depth: usize,
    ) -> anyhow::Result<()> {
        if max_depth == 0 {
            return Ok(());
        }
        if let Ok(entries) = fs::read_dir(current) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !name.starts_with('.') {
                            if let Ok(rel) = entry.path().strip_prefix(root) {
                                out.push(format!("/{}", rel.to_string_lossy()));
                                let _ = Self::collect_subdirs_recursive(
                                    root,
                                    &entry.path(),
                                    out,
                                    max_depth - 1,
                                );
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Recursively compress a directory into an in-memory ZIP buffer
    pub fn zip_directory(src_dir: &Path) -> anyhow::Result<Vec<u8>> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            Self::zip_walk(&mut zip, src_dir, Path::new(""))?;
            zip.finish()?;
        }
        Ok(buffer.into_inner())
    }

    fn zip_walk<W: Write + std::io::Seek>(
        zip: &mut ZipWriter<W>,
        current_dir: &Path,
        rel_prefix: &Path,
    ) -> anyhow::Result<()> {
        for entry in fs::read_dir(current_dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }

            let entry_rel = rel_prefix.join(&name);
            let meta = entry.metadata()?;

            if meta.is_dir() {
                let options = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                let dir_str = format!("{}/", entry_rel.to_string_lossy());
                zip.add_directory(&dir_str, options)?;
                Self::zip_walk(zip, &path, &entry_rel)?;
            } else if meta.is_file() {
                let options = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                zip.start_file(entry_rel.to_string_lossy(), options)?;
                let mut f = File::open(&path)?;
                std::io::copy(&mut f, zip)?;
            }
        }
        Ok(())
    }

    pub fn calculate_dir_size(path: &Path) -> std::io::Result<u64> {
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
