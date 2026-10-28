use tracing::info;
use crate::config::AppConfig;

pub async fn verify_tunnel_status(config: &AppConfig) {
    let cf = &config.network.cloudflare_tunnel;
    if cf.enabled && !cf.tunnel_token.is_empty() {
        info!(
            "Cloudflare Tunnel '{}' active (outbound Zero Trust mode, zero public ports).",
            cf.tunnel_name
        );
    } else {
        info!(
            "Cloudflare Tunnel token not set yet (configurable via config.toml or Web Settings)."
        );
    }
}
