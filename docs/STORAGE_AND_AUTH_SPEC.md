# 多盘 NAS 存储架构与双模认证规范 (`docs/STORAGE_AND_AUTH_SPEC.md`)

## 1. 多盘 NAS 存储池（Storage Pools）设计

针对家庭或团队 NAS 常见的“系统盘 + 高速 NVMe SSD + 多块大容量机械硬盘（RAID/ZFS/JBOD）+ 外部挂载盘”场景，MayaDesk 在 `backend/src/vfs` 层引入了统一的存储池抽象：

### 1.1 存储池分类
* **私人硬盘池（Private Pool）**：
  * 挂载类型：`pool_type = 'private'`。
  * 目录隔离策略：物理路径自动按 `/<private_pool_mount>/<user_uuid>/` 隔离。
  * 访问控制：仅该 `user_uuid` 对应的 JWT 令牌拥有读写权限，系统管理员在未授权情况下亦不可通过 API 跨用户浏览私人池逻辑树。
* **共享硬盘池（Shared Pool）**：
  * 挂载类型：`pool_type = 'shared'`。
  * 多盘兼容：支持在 `.env` 或后台动态挂载多个物理路径（例如 `media:/mnt/hdd_array_1/media`, `project:/mnt/hdd_array_2/project`, `nas_smb:/mnt/synology_share`）。
  * 角色权限（RBAC）：通过 `shared_pool_permissions` 表控制每个用户对每个共享池的访问级别：
    * `read`：仅允许浏览目录、P2P/Web 下载与流媒体预览。
    * `write`：允许上传、新建文件夹、重命名与移动。
    * `admin`：允许删除文件、管理该共享盘成员权限与配额。

### 1.2 BLAKE3 秒传与跨盘去重索引
* 所有上传的文件在客户端（通过 WebAssembly 或 Tauri 原生 Rust 命令 `compute_chunk_blake3`）预先计算全文与 4MB 分片的 **BLAKE3 哈希**。
* 服务端在 `vfs_nodes` 表中查询 `blake3_hash`：若目标存储池已存在相同哈希的物理文件，则直接创建一条新的 VFS 元数据节点引用（硬链接或 Reflink Copy-on-Write），实现 **0 字节网络传输的极速秒传**。

## 2. 双模身份认证体系（邮箱密码 + Google 登录）

### 2.1 邮箱 + 密码认证流程
1. **密码安全存储**：使用 `argon2` crate（默认 `Argon2id` 算法，19 MiB 内存成本，2 次迭代），严禁明文或弱哈希存储。
2. **登录接口**：`POST /api/v1/auth/login` 校验通过后，签发：
   * `access_token`：15 分钟有效期的 `JWT (HS256/EdDSA)`，内含 `sub (user_id)`、`email`、`role`。
   * `refresh_token`：30 天有效期，Web 端写入 `HttpOnly; Secure; SameSite=Lax` Cookie，Tauri 客户端存入系统安全凭据库（macOS Keychain / Windows Credential Manager / Android Keystore）。

### 2.2 Google OAuth 2.0 (OIDC) 登录流程
1. **获取授权地址**：前端调用 `GET /api/v1/auth/google/url`，服务端生成带 `PKCE (code_challenge)` 与防 CSRF `state` 的 Google 授权链接。
2. **固定回调域名（依托 Cloudflare Tunnel）**：
   * Google OAuth 回调重定向至 `https://drive.yourdomain.com/api/v1/auth/google/callback`。
   * 服务端使用 `code` 向 Google Token Endpoint 换取 `id_token`，校验签名与 `email_verified` 字段。
3. **账号自动关联（Account Linking）**：
   * 若 `google_sub` 已存在，直接登录。
   * 若 `google_sub` 不存在但 `email` 与现有邮箱账号一致，自动绑定 `google_sub` 到该账号并为您开启私人盘空间。
   * 若为全新用户，自动在 `users` 表创建记录，并在默认 `Private Pool` 下初始化该用户的专属私人目录。
