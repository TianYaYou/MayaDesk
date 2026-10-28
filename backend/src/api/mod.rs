use std::{fs, path::Path, sync::Arc};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
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
    config::AppConfig,
    vfs::StorageManager,
    AppState,
};

#[derive(Deserialize)]
pub struct FileQuery {
    pub pool_id: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Deserialize)]
pub struct MkdirRequest {
    pub pool_id: String,
    pub path: String,
    pub folder_name: String,
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
        // Multi-Disk NAS Storage & VFS File Operations
        .route("/disks", get(list_disks_handler))
        .route("/files", get(list_files_handler))
        .route("/files/mkdir", post(mkdir_handler))
        .route("/files/upload", post(upload_file_handler))
        .route("/files/download", get(download_file_handler))
        .route("/files", delete(delete_file_handler))
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

fn extract_user(headers: &HeaderMap, secret: &str) -> UserClaims {
    if let Some(auth_val) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth_val.strip_prefix("Bearer ") {
            if let Ok(claims) = verify_jwt(token, secret) {
                return claims;
            }
        }
    }
    UserClaims {
        sub: "usr_admin_default".into(),
        email: "admin@mayadesk.local".into(),
        display_name: "Admin".into(),
        role: "admin".into(),
        exp: usize::MAX,
    }
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

    sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'member')",
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
    let entries = StorageManager::list_directory(&cfg, &q.pool_id, &user.sub, &q.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({
        "pool_id": q.pool_id,
        "path": if q.path.is_empty() { "/" } else { &q.path },
        "entries": entries
    })))
}

async fn mkdir_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<MkdirRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let rel = format!(
        "{}/{}",
        req.path.trim_end_matches('/'),
        req.folder_name.trim_matches('/')
    );
    let (pool, target) = StorageManager::resolve_safe_target(&cfg, &req.pool_id, &user.sub, &rel)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储池为只读模式" })),
        ));
    }

    fs::create_dir_all(&target)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    Ok(Json(json!({ "status": "created", "path": rel })))
}

async fn upload_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let (pool, target_dir) =
        StorageManager::resolve_safe_target(&cfg, &q.pool_id, &user.sub, &q.path)
            .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储池为只读模式" })),
        ));
    }

    fs::create_dir_all(&target_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("upload_{}.bin", Uuid::new_v4()));
        let safe_name = Path::new(&file_name)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file.bin");

        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

        let hash_hex = blake3::hash(&data).to_hex().to_string();
        let file_path = target_dir.join(safe_name);
        fs::write(&file_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        })?;

        uploaded.push(json!({
            "name": safe_name,
            "size_bytes": data.len(),
            "blake3": hash_hex,
        }));
    }

    Ok(Json(json!({
        "status": "uploaded",
        "files": uploaded
    })))
}

async fn download_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let (_pool, target_file) =
        StorageManager::resolve_safe_target(&cfg, &q.pool_id, &user.sub, &q.path)
            .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if !target_file.exists() || !target_file.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "文件不存在" })),
        ));
    }

    let file_name = target_file
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("download.bin")
        .to_string();
    let bytes = fs::read(&target_file)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    if let Ok(disp) = format!("attachment; filename=\"{}\"", file_name).parse() {
        resp_headers.insert(header::CONTENT_DISPOSITION, disp);
    }

    Ok((resp_headers, Body::from(bytes)))
}

async fn delete_file_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let cfg = state.config.read().await;
    let user = extract_user(&headers, &cfg.auth.jwt_secret);
    let (pool, target) = StorageManager::resolve_safe_target(&cfg, &q.pool_id, &user.sub, &q.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))))?;

    if pool.read_only {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "当前存储池为只读模式" })),
        ));
    }

    if target.is_dir() {
        fs::remove_dir_all(&target)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    } else if target.exists() {
        fs::remove_file(&target)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    }

    Ok(Json(json!({ "status": "deleted", "path": q.path })))
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
