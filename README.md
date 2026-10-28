# MayaDesk — P2P 优先 + Cloudflare Tunnel 兜底的多盘 NAS 极轻量私有云

MayaDesk 是一款专为私有 NAS 与个人/团队多硬盘服务器设计的**全平台极致轻量云盘系统**。它采用 **Rust (`Axum` + `SQLx SQLite` + `WebRTC`) + SolidJS + Tauri v2** 构建，界面采用**极简黑白浅蓝扁平化设计**，支持**全路径与全参数动态配置**，并可通过 Docker 一键部署。

## 核心特性

* **极简黑白浅蓝扁平化 UI**：纯白底色 (`#FFFFFF`) + 纯黑硬朗细边框 (`#000000`) + 浅蓝交互高亮 (`#E0F2FE` / `#BAE6FD`)，零阴影、零圆角冗余，首屏 gzip 后总包体仅 **~13 KB**。
* **所有路径与参数 100% 可配置**：
  * **配置文件**：统一收口于 [`config/config.toml`](./config/config.toml)（支持配置 SQLite 数据库路径、分片缓存目录、日志目录、静态资源目录、任意数量的私人/共享物理盘挂载路径、配额、STUN 节点、P2P 端口、Google OAuth2 与 Cloudflare Tunnel 令牌）。
  * **环境变量覆盖**：支持通过 [`deploy/.env.example`](./deploy/.env.example) 在 Docker 启动时映射宿主机任意目录与多块物理硬盘。
  * **Web 在线可视化修改**：前端内置**「全路径与参数配置」**面板，修改后直接通过 `PUT /api/v1/config` 写回服务器 `config.toml` 并自动创建对应目录。
* **零公网暴露 + 独立 Cloudflare Tunnel**：服务端无需暴露公网 IP，可通过 `cloudflared` 建立出站 Zero Trust 隧道。
* **P2P 优先 + Web 自动回退**：优先通过 `WebRTC DataChannel / QUIC` 进行局域网直连或 STUN 打洞；若超时失败自动回退至 Cloudflare Tunnel HTTPS 通道。
* **私人硬盘 + 共享硬盘（多盘 NAS 聚合）**：物理路径隔离个人空间（`<private_mount>/<user_id>`）与多块团队共享盘，内置 BLAKE3 文件指纹计算。

## 目录结构

```text
MayaDesk/
├── config/
│   └── config.toml           # 全量核心配置文件（所有路径、多盘挂载点、P2P、Tunnel、OAuth 参数）
├── backend/                  # Rust 后端服务 (Axum + SQLx SQLite WAL + VFS + P2P 信令 + 配置热更新)
├── frontend/                 # 极简黑白浅蓝扁平化前端 (SolidJS + Vite 6 + Tailwind CSS v4)
├── desktop/src-tauri/        # Tauri v2 跨端客户端壳 (macOS / Windows / Linux / Android)
├── deploy/                   # Docker 多阶段构建与 Docker Compose 一键部署编排
│   ├── Dockerfile.backend    # 前后端全栈合一多阶段构建 Dockerfile
│   ├── docker-compose.yml    # 容器编排（支持自定义宿主机所有挂载路径与可选 CF Tunnel）
│   └── .env.example          # Docker 宿主机路径与环境变量模板
└── docs/                     # 架构设计、协议规范与实现路线图文档
```

## 使用 Docker 部署服务器（推荐）

当你准备好调试服务器后，只需在服务器上安装 Docker 和 Docker Compose，按以下三步即可启动：

### 1. 准备环境变量与挂载路径
```bash
cd deploy
cp .env.example .env
# 编辑 .env，可自定义宿主机端口、数据库目录以及多块 NAS 硬盘的真实挂载路径（如 /mnt/disk1）
```

### 2. 一键构建并启动服务（局域网 / IP 调试模式）
```bash
docker compose up -d --build
```
启动后直接用浏览器打开 `http://<服务器IP>:8080`：
* **默认管理员账号**：`admin@mayadesk.local`
* **默认管理员密码**：`admin123456`（可在 `config/config.toml` 中修改）

### 3. 开启独立 Cloudflare Tunnel（零公网 IP 暴露模式）
在 `deploy/.env` 中填入 `CF_TUNNEL_TOKEN=你的隧道Token`，然后执行：
```bash
docker compose --profile tunnel up -d --build
```

## 文档导航

* [系统总体架构与前后端分离设计 (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)
* [P2P 打洞协商与 Cloudflare Tunnel 兜底协议规范 (`docs/P2P_AND_TUNNEL_PROTOCOL.md`)](./docs/P2P_AND_TUNNEL_PROTOCOL.md)
* [多盘 NAS 存储池与双模登录认证规范 (`docs/STORAGE_AND_AUTH_SPEC.md`)](./docs/STORAGE_AND_AUTH_SPEC.md)
* [分阶段实现路线图 (`docs/ROADMAP.md`)](./docs/ROADMAP.md)
