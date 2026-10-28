# MayaDesk 系统架构与核心模块设计 (`docs/ARCHITECTURE.md`)

## 1. 设计目标与边界约束

MayaDesk 旨在构建一套**零公网 IP 暴露、P2P 直连优先、Cloudflare Tunnel 兜底、支持多盘 NAS 聚合（私人盘与共享盘隔离）且全平台极致轻量**的私有云盘系统：

1. **多端覆盖与极致轻量**：支持 Web 网页直接打开，并提供 macOS、Windows、Linux 与 Android 原生轻量客户端（基于 **Tauri v2 + SolidJS**，安装包控制在 **3MB ~ 8MB**，运行时内存开销远低于 Electron/Flutter）。
2. **双模身份认证**：原生支持 **邮箱+密码（Argon2id 哈希）** 与 **Google OAuth 2.0 (OIDC)** 统一账号体系。
3. **私人硬盘 + 共享硬盘（多盘 NAS 聚合）**：通过虚拟文件系统（VFS）与 **Apache OpenDAL** 抽象层，将宿主机的 NVMe SSD、SATA RAID 阵列、ZFS/Btrfs 存储池乃至外部 SMB/WebDAV 挂载点聚合为逻辑存储池，严格隔离用户的私人加密空间与多角色协作共享盘。
4. **P2P 优先 + Web (Cloudflare Tunnel) 自动回退**：内网/公网打洞成功时走 **WebRTC DataChannel / QUIC** 点对点高速通道；当遇到对称型 NAT（Symmetric NAT）或防火墙阻断时，1.5 秒内无感回退至 **Cloudflare Tunnel** 的 HTTPS/WSS 通道。
5. **零公网端口暴露**：NAS 服务端仅监听本地回环 `127.0.0.1:8080` 与局域网/STUN UDP 端口，无需路由器公网 IP 或固定端口映射，通过独立 `cloudflared` 建立出站（Outbound-Only）安全隧道。

## 2. 前后端分离文件架构设计

项目采用 **Monorepo 前后端与客户端解耦架构**，各端职责边界清晰，前端构建产物既可独立部署于 Web，又可嵌入 Tauri v2 跨端壳与 Rust 后端单二进制包：

```text
MayaDesk/
├── Cargo.toml                     # Rust Workspace 根配置 (统一管理服务端与桌面/移动端 Core 依赖)
├── README.md                      # 项目总览、快速启动与架构导航
├── backend/                       # [后端服务] Rust (Axum + SQLx SQLite + OpenDAL + WebRTC)
│   ├── Cargo.toml                 # 后端依赖清单
│   ├── .env.example               # 服务端环境变量模板 (CF Tunnel, Google OAuth, 多盘挂载路径)
│   ├── migrations/                # SQLite 数据库迁移脚本 (WAL 模式)
│   │   └── 0001_initial_schema.sql
│   └── src/
│       ├── main.rs                # 服务端入口与生命周期管理
│       ├── config.rs              # 多盘挂载池、STUN 节点与鉴权参数解析
│       ├── api/mod.rs             # RESTful 路由与 WebSocket 信令入口
│       ├── auth/mod.rs            # 邮箱密码 (Argon2id) + Google OAuth2 + JWT 签发与校验
│       ├── vfs/mod.rs             # 多盘 NAS 虚拟文件系统 (私人池隔离 + 共享池 RBAC 权限)
│       ├── p2p/mod.rs             # WebRTC/QUIC 信令交换与 ICE 候选协商
│       ├── tunnel/mod.rs          # Cloudflare Tunnel 守护状态巡检与回退策略
│       └── db/mod.rs              # SQLite 连接池与元数据索引操作
├── frontend/                      # [前端应用] SolidJS + Vite 6 + Tailwind CSS v4 (Web 与客户端共用)
│   ├── package.json               # 极简前端依赖 (零虚拟 DOM，编译产物 < 100KB)
│   ├── vite.config.ts             # Vite 构建与本地开发 API / WS 代理配置
│   ├── tsconfig.json              # TypeScript 严格模式配置
│   ├── index.html                 # 响应式 Web 入口
│   └── src/
│       ├── main.tsx               # 前端挂载入口
│       ├── App.tsx                # 网盘工作台主视图 (私人盘/共享盘切换、通道状态监控)
│       └── services/
│           ├── p2pTransport.ts    # P2P (WebRTC DataChannel) 与 CF Tunnel 双通道竞速管理器
│           └── authService.ts     # 邮箱密码登录与 Google OAuth2 授权客户端
├── desktop/                       # [跨平台轻量客户端] Tauri v2 (macOS / Windows / Linux / Android)
│   └── src-tauri/
│       ├── Cargo.toml             # 客户端 Rust 原生层依赖
│       ├── tauri.conf.json        # 多端打包与窗口配置 (直接复用 ../frontend/dist)
│       └── src/
│           ├── main.rs            # 桌面端启动入口
│           └── lib.rs             # 桌面与 Android 共享入口 + 原生 BLAKE3 高速分片哈希命令
├── deploy/                        # [零公网暴露部署配置]
│   ├── docker-compose.yml         # 服务端 + 独立 cloudflared 隧道容器编排与多盘挂载
│   ├── Dockerfile.backend         # 多阶段构建极小体积 Rust 服务端镜像
│   └── cloudflared/
│       └── config.yml             # Cloudflare Zero Trust Tunnel Ingress 路由规则
└── docs/                          # [开发文档与实现规范]
    ├── ARCHITECTURE.md            # 系统总体架构、前后端分离目录规范与模块设计
    ├── P2P_AND_TUNNEL_PROTOCOL.md # P2P 打洞协商、Happy Eyeballs 竞速与 CF Tunnel 回退协议
    ├── STORAGE_AND_AUTH_SPEC.md   # 多盘 NAS 聚合、私人/共享权限模型与双模登录规范
    └── ROADMAP.md                 # 分阶段实现路线图与里程碑验收标准
```

## 3. 核心数据流转机制

1. **信令与鉴权阶段（始终走 Cloudflare Tunnel HTTPS/WSS）**：
   * 无论用户在浏览器打开 `https://drive.yourdomain.com`，还是启动 Mac/Win/Linux/Android 客户端，首包请求均通过 Cloudflare Tunnel 到达内网 `mayadesk-server`。
   * 完成邮箱密码或 Google OAuth2 登录后，获取短期 `Access Token (JWT)`。
2. **通道竞速与升级阶段（Happy Eyeballs P2P Upgrade）**：
   * 客户端通过 `wss://drive.yourdomain.com/api/v1/p2p/ws` 与服务端交换 SDP Offer/Answer 及 ICE Candidates（包含局域网 host 地址与 STUN 反射 srflx 地址）。
   * 若在 `1500ms` 窗口内 `RTCDataChannel` (`mayadesk-vfs-blocks`) 握手成功，后续所有文件列表拉取、分片上传与流媒体播放全部切入 **P2P 加密直连通道**（局域网跑满物理网卡速率，跨网跑满上行带宽，不经过 Cloudflare 中转）。
   * 若超时或处于严格对称型 NAT，客户端立即将传输器锁定为 `cf-tunnel-web` 模式，通过 HTTP/2 / HTTP/3 Range 分片流完成读写。
