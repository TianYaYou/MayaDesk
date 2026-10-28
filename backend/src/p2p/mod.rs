use serde::{Deserialize, Serialize};

/// Signaling message exchanged over Cloudflare Tunnel WebSocket (`wss://.../api/v1/p2p/ws`)
/// to negotiate direct WebRTC DataChannel / QUIC P2P connections before falling back to HTTPS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SignalingEnvelope {
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
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    },
    TransportFallback {
        session_id: String,
        reason: String,
    },
}

#[derive(Clone)]
pub struct SignalingHub {
    pub stun_servers: Vec<String>,
}

impl SignalingHub {
    pub fn new(stun_servers: Vec<String>) -> Self {
        Self { stun_servers }
    }
}
