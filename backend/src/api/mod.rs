use std::sync::Arc;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

use crate::AppState;

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health_handler))
        .route("/api/v1/auth/login", post(email_login_handler))
        .route("/api/v1/auth/google/url", get(google_oauth_url_handler))
        .route("/api/v1/disks", get(list_disks_handler))
        .route("/api/v1/p2p/config", get(p2p_config_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "mayadesk-server",
        "tunnel_mode": state.config.cf_tunnel_token.is_some(),
        "p2p_timeout_ms": state.config.p2p_handshake_timeout_ms,
    }))
}

async fn email_login_handler() -> Json<Value> {
    Json(json!({
        "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo",
        "token_type": "Bearer",
        "expires_in": 900,
        "auth_provider": "email"
    }))
}

async fn google_oauth_url_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "provider": "google",
        "authorize_url": format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile",
            state.config.google_client_id,
            state.config.google_redirect_url
        )
    }))
}

async fn list_disks_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "pools": state.storage.list_mounts()
    }))
}

async fn p2p_config_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "stun_servers": state.signaling.stun_servers,
        "handshake_timeout_ms": state.config.p2p_handshake_timeout_ms,
        "fallback_transport": "cloudflare-tunnel-https"
    }))
}
