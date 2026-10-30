# MayaDesk macOS 原生轻量客户端设计方案 (`docs/MACOS_CLIENT_DESIGN.md`)

## 1. 设计定位与核心指标

MayaDesk macOS 客户端基于 **Tauri v2 (`WKWebView` + Rust Core) + SolidJS** 构建，复用现有极简黑白浅蓝扁平化前端工作台，并在 Rust 原生层提供针对 macOS（Apple Silicon `aarch64` 与 Intel `x86_64` Universal Binary）深度定制的系统级文件同步、虚拟挂载与后台高速传输能力。

| 指标维度 | 目标规格 | 说明 |
| :--- | :--- | :--- |
| **安装包体积** | **~4.5 MB** (`.dmg` 单架构) / **~7.5 MB** (Universal `.dmg`) | 直接调用 macOS 系统内置 `WKWebView`，零 Chromium 内核捆绑 |
| **常驻内存开销** | **后台托盘态 < 25 MB** / **主窗口展开态 < 65 MB** | 关闭主窗口时自动销毁 `WKWebView` 实例，仅保留 Rust 守护协程 |
| **本地哈希与分片吞吐** | **> 2.5 GB/s** (Apple M 系列芯片) | 基于 `blake3` SIMD (NEON) + `memmap2` 零拷贝多线程并行分片计算 |
| **Finder 磁盘映射** | 本地环回 WebDAV (`127.0.0.1:18085`) 零内核扩展挂载 | 无需用户关闭 SIP 或安装 macFUSE，直接映射为 Finder 侧边栏网络卷 |
| **网络通道策略** | **局域网 mDNS / WebRTC P2P 直连优先** + **Cloudflare Tunnel 兜底** | 1500ms Happy Eyeballs 竞速，Wi-Fi / 热点切换时按 4MB 分片断点无感续传 |

## 2. 系统总体分层架构

```text
+-----------------------------------------------------------------------------------+
|                            macOS User Space Interaction                           |
|  +---------------------------+  +-----------------------+  +-------------------+  |
|  | Main Workspace Window     |  | Menu Bar Popover      |  | macOS Finder      |  |
|  | (SolidJS + Tailwind v4)   |  | (NSStatusItem + Tray) |  | (/Volumes/Maya*)  |  |
|  +-------------+-------------+  +-----------+-----------+  +---------+---------+  |
+----------------|----------------------------|------------------------|------------+
                 | Tauri IPC (Commands/Events)|                        | WebDAV HTTP
+----------------v----------------------------v------------------------v------------+
|                         Tauri v2 Rust Core (desktop/src-tauri)                    |
|                                                                                   |
|  +------------------------+  +------------------------+  +---------------------+  |
|  | Server Endpoint Router |  | Native Transfer Engine |  | Local WebDAV Bridge |  |
|  | - Multi-Server Profile |  | - memmap2 4MB Chunker  |  | - Loopback Axum DAV |  |
|  | - macOS Keychain Token |  | - BLAKE3 NEON Hashing  |  | - Finder mount_webdav| |
|  +-----------+------------+  +-----------+------------+  +----------+----------+  |
|              |                           |                          |             |
|  +-----------v---------------------------v--------------------------v----------+  |
|  |               Hybrid Transport Engine (Rust Native + WebRTC)                |  |
|  |  [1] LAN mDNS (_mayadesk._udp.local) & Direct QUIC / WebRTC DataChannel     |  |
|  |  [2] WAN STUN Hole-Punching (UDP 51820)                                     |  |
|  |  [3] Cloudflare Tunnel HTTPS/2 & HTTP/3 Range Stream Fallback               |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

## 3. macOS 专属目录规划 (`desktop/src-tauri`)

为保持与现有 Monorepo 结构完全兼容，macOS 客户端扩展在 `desktop/src-tauri` 下按模块化组织：

```text
desktop/src-tauri/
├── Cargo.toml                   # 引入 tauri-plugin-shell/dialog/fs/notification、keyring、notify、dav-server
├── tauri.conf.json              # macOS 窗口样式 (hiddenInset)、MenuBar 图标、Bundle ID 与公证配置
├── Entitlements.plist           # macOS 硬件与网络权限声明 (Network Client/Server, Keychain, File Access)
├── capabilities/
│   └── macos-default.json       # Tauri v2 ACL 细粒度权限清单
└── src/
    ├── main.rs                  # 桌面进程入口
    ├── lib.rs                   # Tauri Builder 装配、生命周期钩子与 IPC 注册
    ├── commands/
    │   ├── mod.rs
    │   ├── profile.rs           # 远端服务器连接管理与 Keychain 令牌存取
    │   ├── transfer.rs          # 原生流式上传/下载队列与 BLAKE3 快速校验
    │   ├── mount.rs             # Finder 本地 WebDAV 挂载与卸载控制
    │   └── sync.rs              # 本地文件夹双向/单向增量同步配置
    ├── engine/
    │   ├── hasher.rs            # 基于 memmap2 + rayon 的多核 BLAKE3 分片哈希器
    │   ├── transport.rs         # P2P (webrtc-rs) 与 Reqwest HTTPS 分片断点续传调度器
    │   ├── webdav_loopback.rs   # 本地 127.0.0.1 WebDAV 代理服务（对接远端 VFS）
    │   └── watcher.rs           # 基于 macOS FSEvents 的本地同步目录监听引擎
    └── macos/
        ├── tray.rs              # 顶部菜单栏 (NSStatusBar) 状态图标、实时速率展示与快捷菜单
        └── window.rs            # Dock 图标显隐策略、Traffic Lights (红黄绿按钮) 沉浸式内嵌定制
```

## 4. 核心功能模块详细设计

### 4.1 多服务器连接引导与 macOS Keychain 安全凭据
由于 Web 端通过同源相对路径 `/api/v1` 访问后端，而 macOS 独立客户端通过本地 `tauri://localhost` 协议加载前端静态资源，因此需引入**动态服务端点管理（Server Profile Manager）**：

1. **首次启动连接向导**：
   * 若本地未配置服务器地址，前端自动弹出「连接 MayaDesk NAS 服务器」引导框，支持填入：
     * **Cloudflare Tunnel 域名**：如 `https://drive.example.com`
     * **局域网直连地址**：如 `http://192.168.1.100:8080`
   * 支持局域网自动发现：Rust 层通过 Bonjour / mDNS 扫描 `_mayadesk._tcp.local.`，一键列出家庭内网在线的 MayaDesk 节点。
2. **macOS 钥匙串（Keychain）持久化**：
   * 登录获取的 `access_token` 与 `refresh_token` 不再仅存于易失的 `localStorage`，而是通过 `security-framework`（macOS Keychain Services）以 Service Name `com.mayadesk.clouddrive` 加密存储。
   * 支持可选的 **Touch ID 生物识别解锁**，保护「私人空间」敏感文件访问。

### 4.2 原生零拷贝分片引擎与拖拽传输（绕过 WebView 内存瓶颈）
在浏览器中通过 `<input type="file">` 上传数十 GB 的 4K 视频或大型归档包时，JavaScript `File.slice` 与 `FormData` 容易产生较高的内存拷贝开销。macOS 客户端采用 **WebView 仅传递本地绝对路径、Rust 原生后台直接读写磁盘** 的方案：

1. **全窗口原生拖拽（Native Drag & Drop）**：
   * 监听 Tauri `tauri://drag-drop` 事件，当用户从 macOS Finder 拖拽任意数量的文件或整个文件夹进入窗口时，直接获取本地绝对路径数组 `Vec<PathBuf>`。
2. **零拷贝 BLAKE3 秒传预检**：
   * Rust 后台线程池使用 `memmap2::Mmap` 映射本地文件，按 **4MB 逻辑块** 并行计算 BLAKE3 指纹与全文件根哈希。
   * 上传前先向服务端查询 `blake3_hash`，若命中已有块则直接跳过网络传输，实现跨盘秒传。
3. **断点续传本地状态机**：
   * 在 `~/Library/Application Support/com.mayadesk.clouddrive/transfers.db` 中维护本地传输队列（`upload_id`、已完成 `chunk_index` 位图、本地路径 `mtime`）。
   * 即使合上 MacBook 盖子休眠或切换 Wi-Fi，唤醒后自动从最后一个未确认的 4MB 分片继续传输。

### 4.3 Finder 虚拟磁盘挂载（零内核扩展 Loopback WebDAV）
为了让用户在 macOS Finder、Final Cut Pro、VS Code 等原生应用中直接读写 NAS 上的「私人空间」与「共享空间」，客户端采用**用户态本地 WebDAV 环回挂载**方案（避免 macFUSE 要求用户进恢复模式降低系统安全性的痛点）：

1. **本地环回服务**：
   * Rust 核心层在 `127.0.0.1:18085` 启动仅限本机访问的轻量 WebDAV 网关，并生成随机一次性 Basic Auth 会话密钥。
   * `/private` 映射当前账号的私人空间，`/shared` 映射团队共享空间。
2. **一键挂载至 Finder 侧边栏**：
   * 客户端通过调用 macOS 系统原生命令 `mount_webdav -S -v "MayaDesk NAS" http://127.0.0.1:18085/ /Volumes/MayaDesk` 完成挂载。
   * 自动过滤 macOS 产生的 `.DS_Store`、`._*` (AppleDouble) 与 `.Spotlight-V100` 元数据垃圾请求，防止污染远端 NAS 存储池。
3. **流式 Range 预读缓存**：
   * 在 `~/Library/Caches/com.mayadesk.clouddrive/vfs_blocks/` 维护 LRU 分片缓存（默认上限 4 GB，可在设置中调整），确保在 Finder 中使用空格键 **Quick Look（快速预览）** 浏览图片、PDF 与视频时瞬时响应。

### 4.4 基于 FSEvents 的本地目录自动同步（Sync Folders）
支持用户将 Mac 本地的指定目录（如 `~/Documents/Work` 或 `~/Desktop`）与 NAS 私人空间/共享空间的子目录建立绑定：

* **内核级事件监听**：通过 `notify` crate 调用 macOS 原生 `FSEvents` API，以极低 CPU 占用监听文件新增、修改、重命名与删除。
* **防抖与冲突处理**：设置 `500ms` 写入防抖窗口；当检测到本地与远端同时修改同一文件时，自动保留双份并生成 `<filename>.conflict-<mac-hostname>-<timestamp>.<ext>`，绝不静默覆盖用户数据。
* **忽略规则**：内置默认忽略列表（`.DS_Store`、`node_modules`、`target`、`.git/objects/pack/*.tmp`），并支持同步根目录下的 `.mayadeskignore` 文件。

### 4.5 极简黑白浅蓝 macOS 窗口与菜单栏体验
延续 MayaDesk 标志性的**纯白底色 (`#FFFFFF`) + 纯黑硬朗细边框 (`#000000`) + 浅蓝高亮 (`#E0F2FE`)** 设计语言，同时融入 macOS 原生交互习惯：

1. **沉浸式标题栏 (`titleBarStyle: "Overlay"` / `"Transparent"`)**：
   * 隐藏系统默认灰底标题栏，将 macOS 左上角红黄绿窗口控制按钮（Traffic Lights）内嵌至前端顶部 `h-12` 导航栏左侧（预留 `pl-20` 安全边距），导航栏空白区域添加 `data-tauri-drag-region` 支持原生窗口拖拽与双击最大化。
2. **顶部菜单栏常驻小组件（Menu Bar Extra）**：
   * 在 macOS 右上角状态栏常驻 `MD` 极简黑白图标：
     * 空闲时显示静态黑白 `MD` 标识；
     * 传输中动态切换为浅蓝呼吸点并显示实时速率（如 `↑ 42.8 MB/s`）。
   * 点击图标弹出 `320 × 420` 极简黑白浅蓝悬浮面板：展示当前通道状态（`P2P 直连 4ms` / `CF Tunnel 中继`）、最近 5 条传输任务进度、「在 Finder 中打开挂载盘」与「打开主工作台」快捷按钮。
3. **窗口关闭转后台驻留**：
   * 用户点击左上角红色关闭按钮（或按 `⌘W`）时，拦截 `WindowEvent::CloseRequested`，隐藏并释放主窗口 WebView 内存，应用继续在顶部菜单栏保持同步与 Finder 挂载服务；按 `⌘Q` 或在菜单栏点击「完全退出」时安全卸载 WebDAV 卷并退出进程。
4. **macOS 原生快捷键映射**：
   * `⌘ + ,`：快速打开「系统配置 / 客户端偏好设置」
   * `⌘ + U`：唤起原生文件选择器上传文件
   * `⌘ + Shift + N`：在当前目录新建文件夹
   * `Space`（空格键）：对当前选中的文件触发在线预览 Modal
   * `⌘ + R`：刷新当前目录与存储池状态

## 5. Tauri IPC 接口规范（Frontend <-> Rust Core）

前端通过 `@tauri-apps/api/core` 的 `invoke` 与 `@tauri-apps/api/event` 的 `listen` 与 Rust 核心层通信，同时保持对纯 Web 环境的向后兼容（通过 `window.__TAURI_INTERNALS__` 检测运行时）：

| 命令名称 (`#[tauri::command]`) | 参数说明 | 返回值 | 功能描述 |
| :--- | :--- | :--- | :--- |
| `get_client_config` | 无 | `MacClientConfig` | 读取当前绑定的 NAS 服务器地址、挂载状态与本地缓存占用 |
| `save_server_endpoint` | `server_url: String` | `ServerProbeResult` | 探测服务端连通性、保存地址并初始化 P2P/Tunnel 传输器 |
| `keychain_set_token` | `account: String, token: String` | `Result<(), String>` | 将 JWT 令牌安全存入 macOS Keychain |
| `keychain_get_token` | `account: String` | `Option<String>` | 从 macOS Keychain 读取已保存的登录令牌 |
| `compute_chunk_blake3` | `payload: Vec<u8>` | `ChunkHashResult` | 内存缓冲区快速 BLAKE3 计算（已实现） |
| `enqueue_native_upload` | `space: String, remote_dir: String, local_paths: Vec<String>` | `Vec<TransferTaskId>` | 将本地文件/文件夹交由 Rust 多线程引擎执行零拷贝分片上传 |
| `enqueue_native_download` | `space: String, remote_path: String, save_dir: String` | `TransferTaskId` | 使用 Rust 原生多并发分片流下载文件至 Mac 本地并校验 BLAKE3 |
| `mount_finder_drive` | `mount_point: Option<String>` | `MountStatus` | 启动本地 WebDAV 环回服务并挂载至 `/Volumes/MayaDesk` |
| `unmount_finder_drive` | 无 | `Result<(), String>` | 安全卸载 Finder 虚拟卷并停止环回服务 |
| `reveal_in_finder` | `local_path: String` | `Result<(), String>` | 调用 `NSWorkspace` 在 Finder 中高亮定位已下载或已同步的文件 |

**Rust 主动推送至前端的事件流（Events）**：
* `mayadesk://transfer-progress`：实时推送 `{ task_id, file_name, transferred_bytes, total_bytes, speed_bps, channel, status }`。
* `mayadesk://transport-state`：当网络环境切换（如局域网 P2P 升级成功或回退至 Cloudflare Tunnel）时推送最新 `TransportTelemetry`。
* `mayadesk://native-file-drop`：当用户向窗口拖入 Finder 文件/文件夹时触发上传确认或直接入队。

## 6. 前端无感双模适配方案（Web 与 macOS 客户端共用一套代码）

在 `frontend/src/services/` 下新增轻量桥接层 `platformBridge.ts`，确保同一套 SolidJS 代码在浏览器与 macOS 客户端下均拥有最佳体验：

1. **API Base URL 动态路由**：
   * Web 模式：默认使用相对路径 `/api/v1`。
   * macOS 客户端模式：从 `platformBridge.getServerUrl()` 读取用户配置的远端地址（如 `https://drive.yourdomain.com/api/v1` 或 `http://192.168.1.100:8080/api/v1`）。
2. **上传/下载能力自动升级**：
   * 在浏览器中点击「上传文件」调用标准 `<input type="file">`；
   * 在 macOS 客户端中点击「上传文件 / 文件夹」直接调用系统原生 `NSOpenPanel`（支持同时多选大文件与深层目录），并交由 `enqueue_native_upload` 在后台高速传输。

## 7. 构建、签名、公证与分发流水线

### 7.1 开发调试与构建指令
在项目根目录下即可直接联调或构建 macOS 客户端：

```bash
# 1. 启动 macOS 客户端热重载开发模式（自动拉起 ../frontend Vite 服务）
cd desktop/src-tauri
cargo tauri dev

# 2. 构建当前架构 Release 安装包 (.app & .dmg)
cargo tauri build

# 3. 构建 Apple Silicon (M1/M2/M3/M4) + Intel 双架构通用包 (Universal Binary)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri build --target universal-apple-darwin
```

### 7.2 Apple Developer 签名与公证（Notarization）
为消除 macOS Gatekeeper 的“无法验证开发者”弹窗，发布构建配置如下环境变量：
* `APPLE_SIGNING_IDENTITY`：`Developer ID Application: Your Name (TEAMID)`
* `APPLE_ID` / `APPLE_PASSWORD`（App 专用密码） / `APPLE_TEAM_ID`
* 开启 Hardened Runtime，并在 `Entitlements.plist` 中声明：
  * `com.apple.security.network.client`（访问 NAS 与 Cloudflare Tunnel）
  * `com.apple.security.network.server`（用于 WebRTC P2P UDP 打洞监听与本地 WebDAV 环回）
  * `com.apple.security.files.user-selected.read-write`（读写用户授权的同步与下载目录）

## 8. 分阶段落地实施计划

### Step 1：macOS 沉浸式壳与动态服务器连接（M1 里程碑）
- [ ] 更新 `desktop/src-tauri/tauri.conf.json`，启用 macOS `hiddenInset` 标题栏与高分屏 Retina 图标配置。
- [ ] 在 `frontend/src/services/api.ts` 中接入 `isTauriMac()` 检测与动态 `API_BASE` 地址切换，支持首次启动配置远端 NAS URL。
- [ ] 集成 macOS Keychain 存取登录 JWT，并在顶部导航栏为 macOS 窗口红黄绿控制按钮预留内边距与拖拽区 (`data-tauri-drag-region`)。

### Step 2：Rust 原生零拷贝分片上传/下载与菜单栏常驻（M2 里程碑）
- [ ] 在 `desktop/src-tauri/src/` 中实现基于 `memmap2` + `blake3` 的流式 4MB 分片上传与下载命令。
- [ ] 接入 Finder 拖拽上传（`tauri://drag-drop`）与系统原生文件选择对话框。
- [ ] 实现 macOS 顶部菜单栏 (`TrayIcon`) 常驻、窗口关闭转后台驻留以及实时传输速率状态显示。

### Step 3：Finder 本地 WebDAV 环回挂载与 FSEvents 同步（M3 里程碑）
- [ ] 实现 `127.0.0.1:18085` 本地 WebDAV 环回网关，支持一键将私人空间与共享空间挂载至 `/Volumes/MayaDesk`。
- [ ] 引入本地 4MB 块 LRU 磁盘缓存，优化 Finder Quick Look 空格预览与流媒体拖动响应。
- [ ] 基于 macOS `FSEvents` 实现指定本地文件夹与远端 NAS 的增量自动同步。
