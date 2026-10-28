# MayaDesk — P2P 优先 + Cloudflare Tunnel 兜底的多盘 NAS 极轻量私有云

MayaDesk 是一款专为私有 NAS 与个人/团队多硬盘服务器设计的**全平台极致轻量云盘系统**。它采用 **Rust (`Axum` + `OpenDAL` + `WebRTC`) + SolidJS + Tauri v2** 构建，在不暴露任何公网端口的前提下，实现 **P2P 高速直连优先、Cloudflare Tunnel 自动兜底** 的跨端文件管理与协作体验。

## 核心特性

* **零公网暴露 + 独立 Cloudflare Tunnel**：服务端仅监听本地回环与内网，通过 `cloudflared` 建立出站 Zero Trust 隧道，彻底杜绝公网扫描与攻击。
* **P2P 优先 + Web 自动回退（Happy Eyeballs）**：无论是浏览器 Web 端还是桌面/安卓客户端，均优先通过 `WebRTC DataChannel / QUIC` 进行局域网直连或公网 STUN 打洞；若 1.5 秒内打洞失败（如对称型 NAT），无感回退至 Cloudflare Tunnel HTTPS 通道。
* **私人硬盘 + 共享硬盘（多盘 NAS 聚合）**：原生兼容多物理盘挂载（NVMe SSD、RAID 阵列、ZFS/Btrfs、SMB/WebDAV），严格隔离个人加密空间与团队多角色（只读/读写/管理）共享盘。
* **双模账号体系**：支持 **邮箱 + 密码（Argon2id 加密）** 与 **Google OAuth 2.0** 一键登录，自动关联合并同邮箱账号。
* **全平台极致轻量**：
  * **Web 端**：基于 SolidJS + Tailwind CSS v4，零虚拟 DOM，首屏包体积 `< 100KB`，浏览器打开即用。
  * **客户端（macOS / Windows / Linux / Android）**：基于 **Tauri v2** 共享同一套前端与 Rust 核心，安装包仅 **3MB ~ 8MB**。

## 目录结构（前后端与跨端客户端分离）

```text
MayaDesk/
├── backend/                  # Rust 后端服务 (Axum + SQLx SQLite + OpenDAL + WebRTC)
├── frontend/                 # SolidJS + Vite + Tailwind CSS v4 (Web 与 Tauri 共用前端)
├── desktop/src-tauri/        # Tauri v2 跨端客户端壳 (macOS / Windows / Linux / Android)
├── deploy/                   # Docker Compose + 独立 Cloudflare Tunnel 部署编排
└── docs/                     # 架构设计、协议规范与实现路线图文档
```

## 文档导航

* [系统总体架构与前后端分离设计 (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)
* [P2P 打洞协商与 Cloudflare Tunnel 兜底协议规范 (`docs/P2P_AND_TUNNEL_PROTOCOL.md`)](./docs/P2P_AND_TUNNEL_PROTOCOL.md)
* [多盘 NAS 存储池与双模登录认证规范 (`docs/STORAGE_AND_AUTH_SPEC.md`)](./docs/STORAGE_AND_AUTH_SPEC.md)
* [分阶段实现路线图 (`docs/ROADMAP.md`)](./docs/ROADMAP.md)

## 快速开始

### 1. 启动前端开发环境（Web 预览）
```bash
cd frontend
npm install
npm run dev
```

### 2. 启动 Rust 服务端
> 若本地尚未安装 Rust 工具链，请先执行：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

```bash
cd backend
cp .env.example .env
cargo run
```

### 3. 使用 Docker + Cloudflare Tunnel 零公网暴露部署
```bash
cd deploy
CF_TUNNEL_TOKEN=your_tunnel_token docker compose up -d
```
