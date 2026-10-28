mod api;
mod auth;
mod config;
mod db;
mod p2p;
mod tunnel;
mod vfs;

use std::net::SocketAddr;
use std::sync::Arc;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::AppConfig;
use crate::p2p::SignalingHub;

pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub db: SqlitePool,
    pub signaling: SignalingHub,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            "mayadesk_server=info,tower_http=info".into()
        }))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::load()?;
    info!(
        "Starting {} v{} (config: {})",
        config.server.app_name,
        env!("CARGO_PKG_VERSION"),
        config.config_file_path
    );

    let db = db::init_db(&config).await?;
    let signaling = SignalingHub::new();

    tunnel::verify_tunnel_status(&config).await;

    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    let state = Arc::new(AppState {
        config: RwLock::new(config),
        db,
        signaling,
    });

    let app = api::create_router(state).await;
    info!("Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
