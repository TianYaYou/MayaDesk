mod api;
mod auth;
mod config;
mod db;
mod p2p;
mod tunnel;
mod vfs;

use std::net::SocketAddr;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::AppConfig;
use crate::p2p::SignalingHub;
use crate::vfs::StorageManager;

pub struct AppState {
    pub config: AppConfig,
    pub storage: StorageManager,
    pub signaling: SignalingHub,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            "mayadesk_server=debug,tower_http=info".into()
        }))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::from_env()?;
    info!("Starting MayaDesk Server v{}", env!("CARGO_PKG_VERSION"));

    // Initialize Multi-Disk NAS Storage Manager (Private + Shared Pools)
    let storage = StorageManager::initialize(&config).await?;
    let signaling = SignalingHub::new(config.stun_servers.clone());

    // Ensure Cloudflare Tunnel supervision check
    tunnel::verify_tunnel_status(&config).await;

    let state = Arc::new(AppState {
        config: config.clone(),
        storage,
        signaling,
    });

    let app = api::create_router(state);
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    info!("Listening on local tunnel endpoint http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
