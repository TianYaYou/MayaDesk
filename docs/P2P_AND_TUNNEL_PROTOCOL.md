# P2P 优先与 Cloudflare Tunnel 兜底通信协议规范 (`docs/P2P_AND_TUNNEL_PROTOCOL.md`)

## 1. 为什么选择 WebRTC DataChannel + QUIC 双栈

由于云盘要求**“既能在 Web 浏览器直接打开使用 P2P，又能在 Mac/Win/Linux/Android 客户端使用 P2P”**：
* 浏览器安全沙箱禁止网页直接创建原生 UDP Socket，但所有现代浏览器均原生支持 **WebRTC `RTCDataChannel`（底层基于 SCTP over DTLS over UDP）**。
* 因此，服务端集成 `webrtc-rs`：
  * 对 **Web 浏览器端**与**Tauri 客户端**：统一提供基于 `RTCDataChannel` 的二进制分片传输协议。
  * 对 **桌面/移动端后台同步引擎**：可选启用基于 `Iroh / QUIC` 的高吞吐流式同步通道。

## 2. 零公网暴露下的连接建立状态机

```text
[Client: Web / Tauri App]                              [NAS Server behind NAT]
           |                                                      |
           |--- 1. HTTPS Auth & WSS Signaling (via CF Tunnel) --->|
           |<-- 2. Return STUN list + SDP Offer/Answer -----------|
           |                                                      |
           |=== 3. Parallel ICE Probing (1500ms Window) =========>|
           |    3a. LAN Host Candidate (192.168.x.x / mDNS)       |
           |    3b. WAN STUN Srflx Candidate (UDP Hole Punching)  |
           |                                                      |
     [握手成功?]                                                  |
      /       \                                                   |
    YES        NO (Timeout > 1500ms or Symmetric NAT)             |
    /           \                                                 |
[P2P Direct]   [CF Tunnel HTTPS Range Stream]                     |
```

## 3. 信令报文格式 (`SignalingEnvelope`)

客户端与服务端通过 `/api/v1/p2p/ws` 交换 JSON 报文：

```json
{
  "type": "offer",
  "session_id": "sess_9f8a7b6c",
  "sdp": "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1..."
}
```

```json
{
  "type": "ice_candidate",
  "session_id": "sess_9f8a7b6c",
  "candidate": "candidate:842163049 1 udp 1677729535 203.0.113.5 51820 typ srflx...",
  "sdp_mid": "0",
  "sdp_mline_index": 0
}
```

## 4. 二进制块传输帧格式 (`mayadesk-vfs-blocks`)

在 `RTCDataChannel` 或 HTTPS Fallback Chunk 流中，文件均按 **4MB 逻辑块（Block）** 切分，并以 **64KB 子帧（Frame）** 发送，每帧头部包含：

| 字段 | 字节长度 | 说明 |
| :--- | :--- | :--- |
| `Magic` | 2 Bytes | 固定 `0x4D 0x44` (`MD`) |
| `FrameType` | 1 Byte | `0x01`=读取请求, `0x02`=数据块响应, `0x03`=写入块, `0x04`=ACK/校验结果 |
| `TransferId` | 16 Bytes | UUID 二进制，标识单次文件传输会话 |
| `BlockIndex` | 4 Bytes | `u32` 大端序，当前 4MB 分片序号 |
| `Blake3Prefix` | 8 Bytes | 当前分片 BLAKE3 哈希前 8 字节，用于快速完整性校验 |
| `PayloadLen` | 4 Bytes | `u32` 大端序，后续二进制数据长度 |
| `Payload` | Variable | 实际文件二进制内容 |

## 5. 无感断线降级（Seamless Failover）

由于每一个 4MB 分片都有独立的 `BlockIndex` 和 `Blake3` 校验值：
* 当用户在移动端从家里 Wi-Fi（`p2p-lan`）走到户外蜂窝网络时，若 P2P 通道中断，前端 `HybridTransportManager` 立即捕获 `dataChannel.onclose`。
* 未完成的 `BlockIndex` 无需从头重传整个大文件，直接向 Cloudflare Tunnel 的 `PUT /api/v1/files/upload/{transfer_id}/block/{block_index}` 续传剩余分片。
