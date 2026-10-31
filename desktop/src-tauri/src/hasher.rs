use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::Instant;

pub const LOGICAL_BLOCK_SIZE: usize = 4 * 1024 * 1024; // 4MB per P2P / Relay block

#[derive(Debug, Clone, Serialize)]
pub struct ChunkHashResult {
    pub blake3_hex: String,
    pub blake3_short: String,
    pub byte_len: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockDigestEntry {
    pub block_index: u32,
    pub offset_bytes: u64,
    pub byte_len: usize,
    pub blake3_hex: String,
    pub blake3_prefix: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalFileBlake3Report {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub total_blocks: u32,
    pub full_blake3_hex: String,
    pub blake3_short: String,
    pub elapsed_ms: u64,
    pub throughput_mbps: f64,
    pub blocks: Vec<BlockDigestEntry>,
}

/// Computes BLAKE3 hash for an in-memory byte buffer.
pub fn hash_buffer(payload: &[u8]) -> ChunkHashResult {
    let hash = blake3::hash(payload);
    let hex = hash.to_hex().to_string();
    let short = hex.chars().take(12).collect();
    ChunkHashResult {
        blake3_hex: hex,
        blake3_short: short,
        byte_len: payload.len(),
    }
}

/// Streams a local file on macOS in 4MB blocks without loading the entire file into WebView memory,
/// computing both per-4MB-block BLAKE3 digests (for P2P block deduplication) and the full-file BLAKE3 hash.
pub fn hash_local_file(local_path: &Path) -> Result<LocalFileBlake3Report, String> {
    let started = Instant::now();
    let file = File::open(local_path)
        .map_err(|e| format!("无法打开本地文件 '{}': {e}", local_path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取文件元数据: {e}"))?;

    if metadata.is_dir() {
        return Err("所选路径为文件夹，请选择单个本地文件或使用目录批量扫描".to_string());
    }

    let size_bytes = metadata.len();
    let file_name = local_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| local_path.display().to_string());

    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut full_hasher = blake3::Hasher::new();
    let mut blocks = Vec::new();

    let mut block_buf = vec![0u8; LOGICAL_BLOCK_SIZE];
    let mut block_index: u32 = 0;
    let mut offset_bytes: u64 = 0;

    loop {
        let mut filled = 0usize;
        while filled < LOGICAL_BLOCK_SIZE {
            let n = reader
                .read(&mut block_buf[filled..])
                .map_err(|e| format!("读取本地文件块失败: {e}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }

        if filled == 0 {
            break;
        }

        let slice = &block_buf[..filled];
        full_hasher.update(slice);
        let blk_hash = blake3::hash(slice).to_hex().to_string();
        let blk_prefix = blk_hash.chars().take(16).collect();

        blocks.push(BlockDigestEntry {
            block_index,
            offset_bytes,
            byte_len: filled,
            blake3_hex: blk_hash,
            blake3_prefix: blk_prefix,
        });

        offset_bytes += filled as u64;
        block_index += 1;
    }

    let full_hex = full_hasher.finalize().to_hex().to_string();
    let short = full_hex.chars().take(12).collect();
    let elapsed_secs = started.elapsed().as_secs_f64().max(0.000_1);
    let elapsed_ms = (elapsed_secs * 1000.0).round() as u64;
    let throughput_mbps = ((size_bytes as f64) / (1024.0 * 1024.0) / elapsed_secs * 10.0).round() / 10.0;

    Ok(LocalFileBlake3Report {
        path: local_path.display().to_string(),
        file_name,
        size_bytes,
        total_blocks: blocks.len() as u32,
        full_blake3_hex: full_hex,
        blake3_short: short,
        elapsed_ms,
        throughput_mbps,
        blocks,
    })
}
