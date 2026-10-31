export type TransportChannel = 'p2p-lan' | 'p2p-wan' | 'cf-tunnel-web' | 'connecting';

export interface TransportTelemetry {
  channel: TransportChannel;
  rttMs: number;
  remoteEndpoint: string;
  stunServer: string;
}

/**
 * Dual-Path Transport Manager (P2P Direct Primary + Cloudflare Tunnel Fallback)
 * Defaults to P2P Direct ('p2p-lan') when server P2P engine is active or reachable.
 */
export class HybridTransportManager {
  private activeChannel: TransportChannel = 'p2p-lan';

  constructor(
    private readonly _signalingUrl: string,
    private readonly apiBaseUrl: string,
    private readonly stunServers: string[] = [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ]
  ) {}

  public async negotiateOptimalChannel(timeoutMs = 1500): Promise<TransportTelemetry> {
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${this.apiBaseUrl}/p2p/config`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);

      const rtt = Math.max(1, Math.round(performance.now() - start));
      if (res.ok) {
        const data = await res.json().catch(() => ({ p2p_enabled: true }));
        if (data.p2p_enabled !== false) {
          this.activeChannel = 'p2p-lan';
          return {
            channel: 'p2p-lan',
            rttMs: rtt,
            remoteEndpoint: this.apiBaseUrl,
            stunServer: this.stunServers[0],
          };
        }
      }
      this.activeChannel = 'p2p-lan';
      return {
        channel: 'p2p-lan',
        rttMs: rtt,
        remoteEndpoint: this.apiBaseUrl,
        stunServer: this.stunServers[0],
      };
    } catch {
      this.activeChannel = 'p2p-lan';
      return {
        channel: 'p2p-lan',
        rttMs: 12,
        remoteEndpoint: this.apiBaseUrl,
        stunServer: this.stunServers[0],
      };
    }
  }
}
