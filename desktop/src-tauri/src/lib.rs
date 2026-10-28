use serde::Serialize;

#[derive(Serialize)]
pub struct ChunkHashResult {
    pub blake3_hex: String,
    pub byte_len: usize,
}

/// Native Rust command exposed to WebView on macOS, Windows, Linux, and Android
/// for high-speed BLAKE3 file chunk hashing and P2P deduplication checks.
#[tauri::command]
pub fn compute_chunk_blake3(payload: Vec<u8>) -> ChunkHashResult {
    let hash = blake3::hash(&payload);
    ChunkHashResult {
        blake3_hex: hash.to_hex().to_string(),
        byte_len: payload.len(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![compute_chunk_blake3])
        .run(tauri::generate_context!())
        .expect("error while running MayaDesk Tauri application");
}
