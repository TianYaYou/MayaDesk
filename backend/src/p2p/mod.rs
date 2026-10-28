use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Signaling message exchanged over Cloudflare Tunnel WebSocket (`/api/v1/p2p/ws`)
/// to negotiate direct WebRTC DataChannel / QUIC P2P connections before falling back to HTTPS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingEnvelope {
    Hello {
        peer_id: String,
    },
    Offer {
        session_id: String,
        sdp: String,
    },
    Answer {
        session_id: String,
        sdp: String,
    },
    IceCandidate {
        session_id: String,
        candidate: String,
    },
    Ping {
        ts: u64,
    },
    Pong {
        ts: u64,
        mode: String,
    },
}

#[derive(Clone)]
pub struct SignalingHub {
    pub tx: broadcast::Sender<String>,
}

impl SignalingHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(128);
        Self { tx }
    }
}
