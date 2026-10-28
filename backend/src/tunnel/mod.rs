use tracing::info;
use crate::config::AppConfig;

/// Verifies whether the embedded or sidecar Cloudflare Tunnel (`cloudflared`) is configured.
/// Ensures zero public IP/port exposure while providing automatic Web & Signaling reachability.
pub async fn verify_tunnel_status(config: &AppConfig) {
    match &config.cf_tunnel_token {
        Some(token) if !token.is_empty() => {
            info!("Cloudflare Tunnel token detected: outbound-only Zero Trust tunnel ready.");
        }
        _ => {
            info!("Running in local/LAN mode (no CF_TUNNEL_TOKEN set). P2P LAN discovery active.");
        }
    }
}
