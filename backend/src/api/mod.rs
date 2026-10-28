use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

use crate::{
    auth::{
        hash_password, sign_jwt, verify_jwt, verify_password, AuthTokenResponse, EmailLoginRequest,
        GoogleCallbackQuery, RegisterRequest, UserClaims, UserProfileDto,
    },
    config::{AppConfig, StoragePoolConfig},
    vfs::StorageManager,
    AppState,
};

#[derive(Deserialize)]
pub struct FileQuery {
    #[serde(default)]
    pub space: Option<String>,
    #[serde(default)]
    pub pool_id: Option<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub inline: Option<bool>,
}

#[derive(Deserialize)]
pub struct ExtractRequest {
    #[serde(default)]
    pub space: Option<String>,
    #[serde(default)]
    pub pool_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub dest_path: Option<String>,
}

#[derive(Deserialize)]
pub struct MkdirRequest {
    #[serde(default)]
    pub space: Option<String>,
    #[serde(default)]
    pub pool_id: Option<String>,
    pub path: String,
    pub folder_name: String,
}

#[derive(Deserialize)]
pub struct SetQuotaRequest {
    pub quota_bytes: i64,
}

#[derive(Deserialize)]
pub struct InitDiskRequest {
    pub mount_path: String,
    #[serde(default = "default_space_type")]
    pub pool_type: String, // "private" | "shared" | "both"
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_init_quota")]
    pub quota_gb: u64,
}

fn default_space_type() -> String {
    "both".into()
}

fn default_init_quota() -> u64 {
    1024
}

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub quota_bytes: i64,
    pub used_bytes: i64,
    pub created_at: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TransferLogRecord {
    pub id: String,
    pub user_id: String,
    pub user_email: String,
    pub action: String,
    pub file_name: String,
    pub rel_path: String,
    pub size_bytes: i64,
    pub channel: String,
    pub status: String,
    pub error_msg: Option<String>,
    pub created_at: String,
}

pub async fn create_router(state: Arc<AppState>) -> Router {
    let (static_dir, max_mb) = {
        let cfg = state.config.read().await;
        (cfg.server.static_dir.clone(), cfg.server.max_upload_size_mb)
    };

    let api_router = Router::new()
        .route("/health", get(health_handler))
        // Auth endpoints (Email + Password & Google OAuth2)
        .route("/auth/login", post(email_login_handler))
        .route("/auth/register", post(register_handler))
        .route("/auth/google/url", get(google_oauth_url_handler))
        .route("/auth/google/callback", get(google_oauth_callback_handler))
        // User Profile & Admin Quota Management
        .route("/user/profile", get(user_profile_handler))
        .route("/admin/users", get(list_users_handler))
        .route("/admin/users/:id/quota", put(update_user_quota_handler))
        .route("/admin/init-disk", post(init_disk_handler))
        .route("/admin/fs/browse", get(admin_fs_browse_handler))
        .route("/admin/fs/mkdir", post(admin_fs_mkdir_handler))
        // Storage & VFS File Operations (Folder upload/download, chunked relay)
        .route("/disks", get(list_disks_handler))
        .route("/files", get(list_files_handler))
        .route("/files/folders", get(list_folder_paths_handler))
        .route("/files/mkdir", post(mkdir_handler))
        .route("/files/upload", post(upload_file_handler))
        .route("/files/upload/chunk", post(upload_chunk_handler))
        .route("/files/download", get(download_file_handler))
        .route("/files/extract", post(extract_file_handler))
        .route("/files", delete(delete_file_handler))
        // Transfer Audit Logs
        .route("/transfers/logs", get(get_transfer_logs_handler))
        // P2P Signaling & Network Status
        .route("/p2p/config", get(p2p_config_handler))
        .route("/p2p/ws", get(p2p_ws_handler))
        // Full Runtime System & Path Configuration API
        .route("/config", get(get_config_handler))
        .route("/config", put(update_config_handler))
        .layer(DefaultBodyLimit::max((max_mb as usize) * 1024 * 1024))
        .with_state(state);

    let index_html = format!("{}/index.html", static_dir);
    let serve_static = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index_html));

    Router::new()
        .nest("/api/v1", api_router)
        .fallback_service(serve_static)
        .layer(CorsLayer::permissive())
}

fn resolve_space(q_space: &Option<String>, q_pool: &Option<String>) -> String {
    if let Some(ref s) = q_space {
        if !s.is_empty() {
            return s.clone();
        }
    }
    if let Some(ref p) = q_pool {
        if !p.is_empty() {
            return p.clone();
        }
    }
    "private".to_string()
}

fn extract_user(headers: &HeaderMap, secret: &str) -> UserClaims {
    extract_user_with_query(headers, secret, None)
}

fn extract_user_with_query(headers: &HeaderMap, secret: &str, query_token: Option<&str>) -> UserClaims {
    if let Some(auth_val) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth_val.strip_prefix("Bearer ") {
            if let Ok(claims) = verify_jwt(token, secret) {
                return claims;
            }
        }
    }
    if let Some(token) = query_token {
        if let Ok(claims) = verify_jwt(token, secret) {
            return claims;
        }
    }
    UserClaims {
        sub: "usr_guest".into(),
        email: "guest@mayadesk.local".into(),
        display_name: "访客".into(),
        role: "guest".into(),
        exp: usize::MAX,
    }
}

fn detect_mime_type(file_name: &str) -> &'static str {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        // Images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // Videos
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        // Audios
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        // Documents
        "pdf" => "application/pdf",
        "json" => "application/json",
        // Code / Text
        "txt" | "log" | "env" | "ini" | "conf" | "cfg" => "text/plain; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "html" | "htm" => "text/plain; charset=utf-8",
        "css" | "scss" | "less" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "ts" | "tsx" | "jsx" => "text/plain; charset=utf-8",
        "rs" => "text/plain; charset=utf-8",
        "py" => "text/plain; charset=utf-8",
        "go" => "text/plain; charset=utf-8",
        "java" => "text/plain; charset=utf-8",
        "c" | "cpp" | "h" | "hpp" | "cc" => "text/plain; charset=utf-8",
        "sh" | "bash" | "zsh" => "text/plain; charset=utf-8",
        "sql" => "text/plain; charset=utf-8",
        "toml" => "text/plain; charset=utf-8",
        "yaml" | "yml" => "text/plain; charset=utf-8",
        "xml" => "text/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn log_transfer(
    db: &SqlitePool,
    user_id: &str,
    user_email: &str,
    action: &str,
    file_name: &str,
    rel_path: &str,
    size_bytes: i64,
    channel: &str,
    status: &str,
    error_msg: Option<&str>,
) {
    let id = format!("tx_{}", &Uuid::new_v4().to_string()[..10]);
    let _ = sqlx::query(
        "INSERT INTO transfer_logs (id, user_id, user_email, action, file_name, rel_path, size_bytes, channel, status, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id)
    .bind(user_id)
    .bind(user_email)
    .bind(action)
    .bind(file_name)
    .bind(rel_path)
    .bind(size_bytes)
    .bind(channel)
    .bind(status)
    .bind(error_msg)
    .execute(db)
    .await;
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cfg = state.config.read().await;
    Json(json!({
        "status": "ok",
        "app_name": cfg.server.app_name,
        "p2p_enabled": cfg.network.p2p_enabled,
        "p2p_udp_port": cfg.network.p2p_udp_port,
        "tunnel_enabled": cfg.network.cloudflare_tunnel.enabled,
        "tunnel_name": cfg.network.cloudflare_tunnel.tunnel_name,
        "configured_pools_count": cfg.storage.pools.len(),
    }))
}

async fn email_login_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EmailLoginRequest>,
) -> Result<Json<AuthTokenResponse>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;

    let row: Option<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, email, display_name, password_hash, role FROM users WHERE email = ?",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let Some((id, email, display_name, pwd_hash, role)) = row else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "账号或密码错误" })),
        ));
    };

    let Some(hash_str) = pwd_hash else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "该账号仅绑定了 Google 登录" })),
        ));
    };

    if !verify_password(&req.password, &hash_str) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "账号或密码错误" })),
        ));
    }

    let user = UserProfileDto {
        id,
        email,
        display_name,
        role,
    };
    let token = sign_jwt(&user, &cfg.auth.jwt_secret, cfg.auth.access_token_ttl_secs)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(AuthTokenResponse {
        access_token: token,
        token_type: "Bearer".into(),
        expires_in: cfg.auth.access_token_ttl_secs,
        auth_provider: "email".into(),
        user,
    }))
}

async fn register_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthTokenResponse>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    if !cfg.auth.allow_registration {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前系统已关闭开放注册" })),
        ));
    }

    let user_id = format!("usr_{}", &Uuid::new_v4().to_string()[..8]);
    let display_name = req
        .display_name
        .unwrap_or_else(|| req.email.split('@').next().unwrap_or("User").to_string());
    let pwd_hash = hash_password(&req.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    // Default regular users have 0 quota until assigned by administrator
    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, role, quota_bytes, used_bytes) VALUES (?, ?, ?, ?, 'member', 0, 0)",
    )
    .bind(&user_id)
    .bind(&req.email)
    .bind(&display_name)
    .bind(&pwd_hash)
    .execute(&state.db)
    .await
    .map_err(|_| (StatusCode::CONFLICT, Json(json!({ "error": "该邮箱已被注册" }))))?;

    let user = UserProfileDto {
        id: user_id,
        email: req.email,
        display_name,
        role: "member".into(),
    };
    let token = sign_jwt(&user, &cfg.auth.jwt_secret, cfg.auth.access_token_ttl_secs)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(AuthTokenResponse {
        access_token: token,
        token_type: "Bearer".into(),
        expires_in: cfg.auth.access_token_ttl_secs,
        auth_provider: "email".into(),
        user,
    }))
}

async fn google_oauth_url_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cfg = state.config.read().await;
    Json(json!({
        "enabled": cfg.auth.google.enabled,
        "provider": "google",
        "client_id": cfg.auth.google.client_id,
        "redirect_uri": cfg.auth.google.redirect_uri,
        "authorize_url": format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile",
            cfg.auth.google.client_id,
            cfg.auth.google.redirect_uri
        )
    }))
}

async fn google_oauth_callback_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Result<Json<AuthTokenResponse>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = UserProfileDto {
        id: "usr_google_oauth".into(),
        email: format!("google_{}@gmail.com", &query.code[..query.code.len().min(6)]),
        display_name: "Google User".into(),
        role: "member".into(),
    };
    let token = sign_jwt(&user, &cfg.auth.jwt_secret, cfg.auth.access_token_ttl_secs)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(AuthTokenResponse {
        access_token: token,
        token_type: "Bearer".into(),
        expires_in: cfg.auth.access_token_ttl_secs,
        auth_provider: "google".into(),
        user,
    }))
}

/// Get current logged-in user profile, including quota and storage usage
async fn user_profile_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);

    let row: Option<(String, String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, email, display_name, role, quota_bytes, used_bytes FROM users WHERE id = ?",
    )
    .bind(&user.sub)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    if let Some((id, email, display_name, role, quota_bytes, used_bytes)) = row {
        Ok(Json(json!({
            "id": id,
            "email": email,
            "display_name": display_name,
            "role": role,
            "quota_bytes": quota_bytes,
            "used_bytes": used_bytes,
        })))
    } else {
        // Fallback for default admin
        Ok(Json(json!({
            "id": user.sub,
            "email": user.email,
            "display_name": user.display_name,
            "role": user.role,
            "quota_bytes": 1099511627776000i64,
            "used_bytes": 0i64,
        })))
    }
}

/// List all users and their quota stats (Admin only)
async fn list_users_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role != "admin" {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))));
    }

    let users: Vec<UserRecord> = sqlx::query_as(
        "SELECT id, email, display_name, role, quota_bytes, used_bytes, created_at FROM users ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({ "users": users })))
}

/// Update user storage quota (Admin only)
async fn update_user_quota_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(target_user_id): AxumPath<String>,
    Json(req): Json<SetQuotaRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role != "admin" {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))));
    }

    sqlx::query("UPDATE users SET quota_bytes = ? WHERE id = ?")
        .bind(req.quota_bytes)
        .bind(&target_user_id)
        .execute(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({
        "status": "success",
        "user_id": target_user_id,
        "quota_bytes": req.quota_bytes
    })))
}

/// Initial disk configuration for freshly deployed instances (Admin only)
async fn init_disk_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<InitDiskRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut cfg = state.config.write().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role != "admin" {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))));
    }

    let mount_clean = req.mount_path.trim().to_string();
    if mount_clean.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "存储路径不能为空" })),
        ));
    }

    let base_name = req.name.unwrap_or_else(|| {
        Path::new(&mount_clean)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("本地存储")
            .to_string()
    });

    let mut created_pools = Vec::new();

    if req.pool_type == "both" || req.pool_type == "private" {
        let priv_path = if req.pool_type == "both" {
            format!("{}/private", mount_clean.trim_end_matches('/'))
        } else {
            mount_clean.clone()
        };
        fs::create_dir_all(&priv_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("创建私人目录失败: {}", e) })),
            )
        })?;
        let pool = StoragePoolConfig {
            id: format!("priv-{}", &Uuid::new_v4().to_string()[..6]),
            name: format!("{}-私人", base_name),
            pool_type: "private".into(),
            mount_path: priv_path,
            quota_gb: req.quota_gb,
            read_only: false,
        };
        created_pools.push(pool.clone());
        cfg.storage.pools.push(pool);
    }

    if req.pool_type == "both" || req.pool_type == "shared" {
        let shared_path = if req.pool_type == "both" {
            format!("{}/shared", mount_clean.trim_end_matches('/'))
        } else {
            mount_clean.clone()
        };
        fs::create_dir_all(&shared_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("创建共享目录失败: {}", e) })),
            )
        })?;
        let pool = StoragePoolConfig {
            id: format!("shared-{}", &Uuid::new_v4().to_string()[..6]),
            name: format!("{}-共享", base_name),
            pool_type: "shared".into(),
            mount_path: shared_path,
            quota_gb: req.quota_gb,
            read_only: false,
        };
        created_pools.push(pool.clone());
        cfg.storage.pools.push(pool);
    }

    cfg.save_to_disk().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("保存配置文件失败: {}", e) })),
        )
    })?;

    Ok(Json(json!({
        "status": "initialized",
        "created_pools": created_pools
    })))
}

#[derive(Deserialize)]
pub struct FsBrowseQuery {
    #[serde(default = "default_root_path")]
    pub path: String,
}

fn default_root_path() -> String {
    "/".into()
}

#[derive(Serialize)]
pub struct FsDirectoryItem {
    pub name: String,
    pub path: String,
    pub is_readable: bool,
}

#[derive(Serialize)]
pub struct FsBreadcrumb {
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
pub struct FsMkdirRequest {
    pub parent_path: String,
    pub folder_name: String,
}

/// Browse physical filesystem directories on server (Admin only)
async fn admin_fs_browse_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FsBrowseQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role != "admin" {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))));
    }

    let mut raw_path = query.path.trim().to_string();
    if raw_path.is_empty() {
        raw_path = "/".to_string();
    }

    let target_path = PathBuf::from(&raw_path);
    if !target_path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("路径不存在: {}", raw_path) })),
        ));
    }

    if !target_path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("该路径不是有效目录: {}", raw_path) })),
        ));
    }

    // Canonicalize if possible to normalize symlinks and relative components
    let norm_path = target_path
        .canonicalize()
        .unwrap_or(target_path.clone());
    let norm_str = norm_path.to_string_lossy().to_string();

    let parent_path = if norm_str == "/" {
        None
    } else {
        norm_path.parent().map(|p| {
            let s = p.to_string_lossy().to_string();
            if s.is_empty() {
                "/".to_string()
            } else {
                s
            }
        })
    };

    // Build breadcrumbs starting from root "/"
    let mut breadcrumbs = Vec::new();
    breadcrumbs.push(FsBreadcrumb {
        name: "/".to_string(),
        path: "/".to_string(),
    });

    if norm_str != "/" {
        let parts: Vec<&str> = norm_str.split('/').filter(|s| !s.is_empty()).collect();
        let mut accumulated = String::new();
        for part in parts {
            accumulated.push('/');
            accumulated.push_str(part);
            breadcrumbs.push(FsBreadcrumb {
                name: part.to_string(),
                path: accumulated.clone(),
            });
        }
    }

    // Read entries
    let mut directories = Vec::new();
    match fs::read_dir(&norm_path) {
        Ok(entries) => {
            for entry_res in entries {
                if let Ok(entry) = entry_res {
                    let file_type = entry.file_type();
                    let is_dir = file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false)
                        || (file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false)
                            && entry.path().is_dir());
                    if is_dir {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let full_p = entry.path().to_string_lossy().to_string();
                        let readable = fs::read_dir(entry.path()).is_ok();
                        directories.push(FsDirectoryItem {
                            name,
                            path: full_p,
                            is_readable: readable,
                        });
                    }
                }
            }
        }
        Err(e) => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": format!("读取目录失败: {}", e) })),
            ));
        }
    }

    // Sort directories alphabetically (case-insensitive)
    directories.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(Json(json!({
        "current_path": norm_str,
        "parent_path": parent_path,
        "breadcrumbs": breadcrumbs,
        "directories": directories,
    })))
}

/// Create physical directory under specified parent directory (Admin only)
async fn admin_fs_mkdir_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<FsMkdirRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role != "admin" {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "需要管理员权限" }))));
    }

    let folder_name = req.folder_name.trim();
    if folder_name.is_empty() || folder_name.contains('/') || folder_name.contains('\\') || folder_name == ".." || folder_name == "." {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "无效的目录名称" })),
        ));
    }

    let parent = Path::new(&req.parent_path);
    if !parent.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "父目录不存在或不是目录" })),
        ));
    }

    let target_dir = parent.join(folder_name);
    fs::create_dir_all(&target_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("创建目录失败: {}", e) })),
        )
    })?;

    Ok(Json(json!({
        "status": "success",
        "path": target_dir.to_string_lossy().to_string()
    })))
}

async fn list_disks_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Json<Value> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let pools = StorageManager::list_mounts(&cfg, &user.sub);
    Json(json!({ "pools": pools }))
}

async fn list_files_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let space = resolve_space(&q.space, &q.pool_id);

    let entries = StorageManager::list_directory(&cfg, &space, &user.sub, &q.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({
        "space": space,
        "path": if q.path.is_empty() { "/" } else { &q.path },
        "entries": entries
    })))
}

async fn list_folder_paths_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let space = resolve_space(&q.space, &q.pool_id);

    let folders = StorageManager::list_folder_paths(&cfg, &space, &user.sub)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({
        "space": space,
        "folders": folders
    })))
}

async fn mkdir_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<MkdirRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let space = resolve_space(&req.space, &req.pool_id);

    let rel = format!(
        "{}/{}",
        req.path.trim_end_matches('/'),
        req.folder_name.trim_matches('/')
    );
    let (pool, target) = StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &rel)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储空间为只读模式" })),
        ));
    }

    fs::create_dir_all(&target)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({ "status": "created", "path": rel })))
}

/// Upload files or recursive folder hierarchy (rel_path preserved)
async fn upload_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let space = resolve_space(&q.space, &q.pool_id);

    // 1. Quota Check for non-admin users
    let user_stats: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT quota_bytes, used_bytes, role FROM users WHERE id = ?",
    )
    .bind(&user.sub)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let (user_quota, user_used, user_role) = user_stats.unwrap_or((0, 0, user.role.clone()));
    if user_role != "admin" && user_quota <= 0 {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "您当前尚未分配存储配额，请联系管理员分配空间后再上传文件" })),
        ));
    }

    let (pool, target_base) =
        StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &q.path)
            .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储空间为只读模式" })),
        ));
    }

    fs::create_dir_all(&target_base)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let mut uploaded = Vec::new();
    let mut total_uploaded_bytes: i64 = 0;

    while let Ok(Some(field)) = multipart.next_field().await {
        let field_name = field.name().unwrap_or("file").to_string();
        if field_name == "folder_upload" {
            continue;
        }

        let raw_file_name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("upload_{}.bin", Uuid::new_v4()));

        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

        let data_len = data.len() as i64;
        if user_role != "admin" && user_used + total_uploaded_bytes + data_len > user_quota {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": format!(
                        "超出存储配额上限 (已用 {} MB / 配额 {} MB)",
                        (user_used + total_uploaded_bytes) / 1024 / 1024,
                        user_quota / 1024 / 1024
                    )
                })),
            ));
        }

        // Support folder uploads with relative paths (e.g. "my_folder/sub/doc.pdf")
        let clean_path = raw_file_name.replace('\\', "/");
        let dest_file_path = if clean_path.contains('/') {
            let rel_parts: Vec<&str> = clean_path.split('/').filter(|p| !p.is_empty() && *p != "..").collect();
            let mut cur = target_base.clone();
            for part in &rel_parts[..rel_parts.len().saturating_sub(1)] {
                cur.push(part);
            }
            let _ = fs::create_dir_all(&cur);
            cur.join(rel_parts.last().unwrap_or(&"file.bin"))
        } else {
            target_base.join(Path::new(&clean_path).file_name().and_then(|s| s.to_str()).unwrap_or("file.bin"))
        };

        let hash_hex = blake3::hash(&data).to_hex().to_string();
        fs::write(&dest_file_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

        total_uploaded_bytes += data_len;
        let display_name = dest_file_path.file_name().unwrap_or_default().to_string_lossy().to_string();

        log_transfer(
            &state.db,
            &user.sub,
            &user.email,
            "upload",
            &display_name,
            &clean_path,
            data_len,
            "relay",
            "success",
            None,
        ).await;

        uploaded.push(json!({
            "name": display_name,
            "rel_path": clean_path,
            "size_bytes": data.len(),
            "blake3": hash_hex,
        }));
    }

    if total_uploaded_bytes > 0 {
        let _ = sqlx::query("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
            .bind(total_uploaded_bytes)
            .bind(&user.sub)
            .execute(&state.db)
            .await;
    }

    Ok(Json(json!({
        "status": "uploaded",
        "files": uploaded
    })))
}

/// Chunked relay upload for large files & network resiliency
async fn upload_chunk_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);

    let mut upload_id = String::new();
    let mut chunk_index: usize = 0;
    let mut total_chunks: usize = 1;
    let mut file_name = String::new();
    let mut rel_path = String::new();
    let mut space = "private".to_string();
    let mut target_dir_path = "/".to_string();
    let mut chunk_data: Vec<u8> = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "upload_id" => upload_id = field.text().await.unwrap_or_default(),
            "chunk_index" => chunk_index = field.text().await.unwrap_or_default().parse().unwrap_or(0),
            "total_chunks" => total_chunks = field.text().await.unwrap_or_default().parse().unwrap_or(1),
            "file_name" => file_name = field.text().await.unwrap_or_default(),
            "rel_path" => rel_path = field.text().await.unwrap_or_default(),
            "space" => space = field.text().await.unwrap_or_default(),
            "path" => target_dir_path = field.text().await.unwrap_or_default(),
            "chunk" => chunk_data = field.bytes().await.unwrap_or_default().to_vec(),
            _ => {}
        }
    }

    if upload_id.is_empty() || file_name.is_empty() || chunk_data.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "分片上传参数不完整" })),
        ));
    }

    // Save chunk to temp upload directory
    let temp_dir = PathBuf::from(&cfg.server.temp_upload_dir).join(&upload_id);
    let _ = fs::create_dir_all(&temp_dir);
    let chunk_path = temp_dir.join(format!("chunk_{}", chunk_index));
    fs::write(&chunk_path, &chunk_data).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("写入临时分片失败: {}", e) })),
        )
    })?;

    // Check if all chunks have arrived
    let mut all_chunks_ready = true;
    for i in 0..total_chunks {
        if !temp_dir.join(format!("chunk_{}", i)).exists() {
            all_chunks_ready = false;
            break;
        }
    }

    if !all_chunks_ready {
        return Ok(Json(json!({
            "status": "chunk_received",
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
        })));
    }

    // All chunks ready -> Reassemble file
    let (pool, dest_base) = StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &target_dir_path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储空间为只读模式" })),
        ));
    }

    let final_rel = if !rel_path.is_empty() { rel_path.clone() } else { file_name.clone() };
    let clean_rel = final_rel.replace('\\', "/");
    let dest_file_path = if clean_rel.contains('/') {
        let parts: Vec<&str> = clean_rel.split('/').filter(|p| !p.is_empty() && *p != "..").collect();
        let mut cur = dest_base.clone();
        for part in &parts[..parts.len().saturating_sub(1)] {
            cur.push(part);
        }
        let _ = fs::create_dir_all(&cur);
        cur.join(parts.last().unwrap_or(&"file.bin"))
    } else {
        dest_base.join(&file_name)
    };

    let mut final_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&dest_file_path)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("创建目标文件失败: {}", e) })),
            )
        })?;

    let mut total_size: i64 = 0;
    let mut hasher = blake3::Hasher::new();

    for i in 0..total_chunks {
        let part_file = temp_dir.join(format!("chunk_{}", i));
        if let Ok(mut f) = File::open(&part_file) {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                hasher.update(&buf);
                total_size += buf.len() as i64;
                let _ = final_file.write_all(&buf);
            }
        }
    }
    drop(final_file);
    let _ = fs::remove_dir_all(&temp_dir);

    // Quota check post-assembly
    let user_stats: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT quota_bytes, used_bytes, role FROM users WHERE id = ?",
    )
    .bind(&user.sub)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let (user_quota, user_used, user_role) = user_stats.unwrap_or((0, 0, user.role.clone()));
    if user_role != "admin" && (user_quota <= 0 || user_used + total_size > user_quota) {
        let _ = fs::remove_file(&dest_file_path);
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "大文件上传超出您的存储配额限制" })),
        ));
    }

    let _ = sqlx::query("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
        .bind(total_size)
        .bind(&user.sub)
        .execute(&state.db)
        .await;

    let hash_hex = hasher.finalize().to_hex().to_string();

    log_transfer(
        &state.db,
        &user.sub,
        &user.email,
        "upload",
        &file_name,
        &clean_rel,
        total_size,
        "relay",
        "success",
        None,
    ).await;

    Ok(Json(json!({
        "status": "completed",
        "file_name": file_name,
        "rel_path": clean_rel,
        "size_bytes": total_size,
        "blake3": hash_hex
    })))
}

/// Download single file or download folder as streaming ZIP, or preview inline with Range support
async fn download_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user_with_query(&headers, &cfg.auth.jwt_secret, q.token.as_deref());
    let space = resolve_space(&q.space, &q.pool_id);

    let (_pool, target) =
        StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &q.path)
            .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if !target.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "文件或目录不存在" })),
        ));
    }

    // 1. Folder Download -> Stream ZIP archive
    if target.is_dir() {
        let folder_name = target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("folder")
            .to_string();

        let zip_bytes = StorageManager::zip_directory(&target).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("打包 ZIP 压缩包失败: {}", e) })),
            )
        })?;

        let zip_len = zip_bytes.len() as i64;
        log_transfer(
            &state.db,
            &user.sub,
            &user.email,
            "download",
            &format!("{}.zip", folder_name),
            &q.path,
            zip_len,
            "relay",
            "success",
            None,
        ).await;

        let mut resp_headers = HeaderMap::new();
        resp_headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
        if let Ok(disp) = format!("attachment; filename=\"{}.zip\"", folder_name).parse() {
            resp_headers.insert(header::CONTENT_DISPOSITION, disp);
        }
        return Ok((StatusCode::OK, resp_headers, Body::from(zip_bytes)));
    }

    // 2. Single File (Preview / Inline or Download with Range support)
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("download.bin")
        .to_string();

    let file_size = fs::metadata(&target)
        .map(|m| m.len())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let mime_type = detect_mime_type(&file_name);
    let is_inline = q.inline.unwrap_or(false);

    // Support HTTP Range Requests (Essential for browser video/audio streaming and seeking)
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    if let Some(rh) = range_header {
        if let Some(range_spec) = rh.strip_prefix("bytes=") {
            let parts: Vec<&str> = range_spec.split('-').collect();
            let start = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let end = parts
                .get(1)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(file_size.saturating_sub(1))
                .min(file_size.saturating_sub(1));

            if start <= end && start < file_size {
                let count = (end - start + 1) as usize;
                let mut f = File::open(&target).map_err(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                })?;
                f.seek(SeekFrom::Start(start)).map_err(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                })?;
                let mut buf = vec![0u8; count];
                f.read_exact(&mut buf).map_err(|e| {
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                })?;

                let mut resp_headers = HeaderMap::new();
                resp_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
                resp_headers.insert(header::CONTENT_TYPE, mime_type.parse().unwrap());
                resp_headers.insert(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", start, end, file_size).parse().unwrap(),
                );
                resp_headers.insert(header::CONTENT_LENGTH, count.to_string().parse().unwrap());
                if is_inline {
                    resp_headers.insert(header::CONTENT_DISPOSITION, "inline".parse().unwrap());
                } else if let Ok(disp) = format!("attachment; filename=\"{}\"", file_name).parse() {
                    resp_headers.insert(header::CONTENT_DISPOSITION, disp);
                }

                return Ok((StatusCode::PARTIAL_CONTENT, resp_headers, Body::from(buf)));
            }
        }
    }

    // Full file response
    let bytes = fs::read(&target)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let file_len = bytes.len() as i64;
    log_transfer(
        &state.db,
        &user.sub,
        &user.email,
        if is_inline { "preview" } else { "download" },
        &file_name,
        &q.path,
        file_len,
        "relay",
        "success",
        None,
    ).await;

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    resp_headers.insert(header::CONTENT_TYPE, mime_type.parse().unwrap());
    if is_inline {
        resp_headers.insert(header::CONTENT_DISPOSITION, "inline".parse().unwrap());
    } else if let Ok(disp) = format!("attachment; filename=\"{}\"", file_name).parse() {
        resp_headers.insert(header::CONTENT_DISPOSITION, disp);
    }

    Ok((StatusCode::OK, resp_headers, Body::from(bytes)))
}

/// Remote archive extraction (.zip, .tar.gz, .tgz, .tar)
async fn extract_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ExtractRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    if user.role == "guest" {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "请先登录" }))));
    }
    let space = resolve_space(&req.space, &req.pool_id);

    // Resolve archive target path
    let (_pool, target) = StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &req.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if !target.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "压缩文件不存在或不是有效文件" })),
        ));
    }

    // Determine target destination directory
    let dest_rel = req.dest_path.clone().unwrap_or_else(|| {
        let parent = Path::new(&req.path).parent().unwrap_or(Path::new("/"));
        parent.to_string_lossy().to_string()
    });

    let (_dest_pool, dest_dir) = StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &dest_rel)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    // Perform decompression
    let (extracted_bytes, file_count) = StorageManager::extract_archive(&target, &dest_dir)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("解压失败: {}", e) })),
            )
        })?;

    // Update user quota for private space
    if space == "private" && user.role != "admin" {
        let _ = sqlx::query("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
            .bind(extracted_bytes as i64)
            .bind(&user.sub)
            .execute(&state.db)
            .await;
    }

    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("archive")
        .to_string();

    log_transfer(
        &state.db,
        &user.sub,
        &user.email,
        "extract",
        &file_name,
        &req.path,
        extracted_bytes as i64,
        "local",
        "success",
        None,
    ).await;

    Ok(Json(json!({
        "status": "success",
        "file_name": file_name,
        "dest_path": dest_rel,
        "extracted_bytes": extracted_bytes,
        "file_count": file_count,
    })))
}

async fn delete_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let space = resolve_space(&q.space, &q.pool_id);

    let (pool, target) = StorageManager::resolve_safe_target(&cfg, &space, &user.sub, &q.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储空间为只读模式" })),
        ));
    }

    let reclaimed_bytes = if target.is_dir() {
        StorageManager::calculate_dir_size(&target).unwrap_or(0) as i64
    } else if target.exists() {
        target.metadata().map(|m| m.len()).unwrap_or(0) as i64
    } else {
        0
    };

    if target.is_dir() {
        fs::remove_dir_all(&target)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    } else if target.exists() {
        fs::remove_file(&target)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    }

    if reclaimed_bytes > 0 {
        let _ = sqlx::query("UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?")
            .bind(reclaimed_bytes)
            .bind(&user.sub)
            .execute(&state.db)
            .await;
    }

    Ok(Json(json!({ "status": "deleted", "path": q.path })))
}

/// Retrieve audit logs of uploads and downloads
async fn get_transfer_logs_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);

    let logs: Vec<TransferLogRecord> = if user.role == "admin" {
        sqlx::query_as(
            "SELECT id, user_id, user_email, action, file_name, rel_path, size_bytes, channel, status, error_msg, created_at
             FROM transfer_logs ORDER BY created_at DESC LIMIT 100",
        )
        .fetch_all(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?
    } else {
        sqlx::query_as(
            "SELECT id, user_id, user_email, action, file_name, rel_path, size_bytes, channel, status, error_msg, created_at
             FROM transfer_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(&user.sub)
        .fetch_all(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?
    };

    Ok(Json(json!({ "logs": logs })))
}

async fn p2p_config_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cfg = state.config.read().await;
    Json(json!({
        "p2p_enabled": cfg.network.p2p_enabled,
        "udp_port": cfg.network.p2p_udp_port,
        "stun_servers": cfg.network.stun_servers,
        "handshake_timeout_ms": cfg.network.p2p_handshake_timeout_ms,
        "chunk_size_kb": cfg.network.chunk_size_kb,
        "cloudflare_tunnel": {
            "enabled": cfg.network.cloudflare_tunnel.enabled,
            "tunnel_name": cfg.network.cloudflare_tunnel.tunnel_name,
            "fallback_https_enabled": cfg.network.cloudflare_tunnel.fallback_https_enabled,
        }
    }))
}

async fn p2p_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_p2p_ws(socket, state))
}

async fn handle_p2p_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.signaling.tx.subscribe();
    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            let _ = state.signaling.tx.send(text.to_string());
            if let Ok(other) = rx.try_recv() {
                let _ = socket.send(Message::Text(other)).await;
            }
        }
    }
}

async fn get_config_handler(State(state): State<Arc<AppState>>) -> Json<AppConfig> {
    let cfg = state.config.read().await;
    Json(cfg.clone())
}

async fn update_config_handler(
    State(state): State<Arc<AppState>>,
    Json(mut new_cfg): Json<AppConfig>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut cfg_guard = state.config.write().await;
    new_cfg.config_file_path = cfg_guard.config_file_path.clone();
    new_cfg
        .save_to_disk()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    *cfg_guard = new_cfg;

    Ok(Json(json!({
        "status": "saved",
        "config_file": cfg_guard.config_file_path
    })))
}
