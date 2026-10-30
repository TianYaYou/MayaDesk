# MayaDesk 实现路线图与开发计划 (`docs/ROADMAP.md`)

本项目采用分阶段迭代交付策略，确保每个阶段均可独立编译、测试与部署运行。

## Phase 1：基础骨架、双模鉴权与多盘 VFS 引擎（当前阶段已完成脚手架）

- [x] 建立前后端与跨端客户端分离的 Monorepo 目录结构（`backend/`、`frontend/`、`desktop/`、`deploy/`、`docs/`）
- [x] 完成 SQLite (WAL) 核心表结构设计（`users`、`storage_pools`、`shared_pool_permissions`、`vfs_nodes`）
- [x] 搭建 Rust `Axum` 后端基础路由与配置加载器（支持多盘挂载解析与 STUN 列表配置）
- [x] 搭建 `SolidJS + Vite + Tailwind CSS v4` 极简前端工作台与双通道状态切换器
- [x] 配置 `Tauri v2` 跨平台工程（支持 macOS / Windows / Linux / Android 共享构建）与 `compute_chunk_blake3` 原生指令
- [ ] 对接 SQLx 持久化实现完整的邮箱注册/Argon2id 登录与 Google OAuth2 回调闭环
- [ ] 基于 `OpenDAL` 实现私人盘与多共享盘的目录遍历、流式上传（HTTP Range）、重命名与删除接口

## Phase 2：Cloudflare Tunnel 零暴露集成与 Web 端完备体验

- [ ] 完善 `deploy/docker-compose.yml` 与 `cloudflared` 自动健康检查，实现一键启动无公网 IP 安全访问
- [ ] 实现大文件 4MB 分片断点续传与 BLAKE3 秒传校验接口（`POST /api/v1/files/upload/init`、`PUT /api/v1/files/upload/:id/:block`）
- [ ] 前端增加文件拖拽上传队列、图片/音视频流媒体在线预览（支持 Range 拖动播放）与共享盘权限管理面板

## Phase 3：P2P 混合双通道引擎（WebRTC DataChannel + STUN 打洞）

- [ ] 实现 `/api/v1/p2p/ws` WebSocket 信令服务端，管理在线客户端 Session 与 ICE Candidate 转发
- [ ] 在 `backend/src/p2p` 中接入 `webrtc-rs`，为每个对端会话创建 `RTCPeerConnection` 与 `mayadesk-vfs-blocks` 数据通道
- [ ] 实现局域网 mDNS / Host Candidate 优先探测，确保手机/电脑在家庭内网访问 NAS 时跑满局域网千兆/万兆带宽
- [ ] 完善 `frontend/src/services/p2pTransport.ts` 的 1500ms Happy Eyeballs 竞速与断线自动回退 Cloudflare Tunnel 逻辑

## Phase 4：全平台轻量客户端打包与高阶 NAS 特性

> macOS 客户端详细架构参见 [`docs/MACOS_CLIENT_DESIGN.md`](./MACOS_CLIENT_DESIGN.md)。

- [ ] 使用 Tauri v2 构建全平台超小体积安装包：
  - macOS (`.dmg` / `.app` Universal, ~4.5MB - 7.5MB)
  - Windows (`.msi` / `-setup.exe` WebView2, ~3MB)
  - Linux (`.AppImage` / `.deb`, ~6MB)
  - Android (`.apk` / `.aab`, ~8MB)
- [ ] macOS 客户端实现沉浸式标题栏、顶部菜单栏 (`NSStatusItem`) 常驻、Keychain 令牌安全存储与原生零拷贝 BLAKE3 分片传输
- [ ] Android 客户端增加相册后台增量备份（仅在连上 P2P 局域网或 Wi-Fi 时自动触发）
- [ ] 桌面端增加本地 WebDAV 环回挂载，将远程 NAS 的「私人空间」与「共享空间」直接映射为本地系统盘符（Mac Finder `/Volumes/MayaDesk` / Windows 资源管理器直接读写）
