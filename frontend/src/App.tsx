import { createSignal, createEffect, For, Show, onMount } from 'solid-js';
import {
  apiLogin,
  apiRegister,
  apiGetGoogleAuthUrl,
  apiListDisks,
  apiListFiles,
  apiCreateFolder,
  apiUploadFiles,
  apiDeleteEntry,
  getDownloadUrl,
  apiGetSystemConfig,
  apiSaveSystemConfig,
  type DiskMountSummary,
  type VfsFileEntry,
  type FullAppConfig,
  type UserProfile,
} from './services/api';
import { HybridTransportManager, type TransportChannel } from './services/p2pTransport';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function formatTime(unixSecs: number): string {
  if (!unixSecs) return '-';
  const d = new Date(unixSecs * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

const DEFAULT_FALLBACK_DISKS: DiskMountSummary[] = [
  {
    id: 'private-main',
    name: '私人主硬盘 (NVMe)',
    pool_type: 'private',
    mount_path: './data/storage/private_nvme',
    quota_gb: 1024,
    used_bytes: 0,
    read_only: false,
    online: true,
  },
  {
    id: 'shared-nas-disk1',
    name: '共享盘 01 · 团队资料库',
    pool_type: 'shared',
    mount_path: './data/storage/shared_disk1',
    quota_gb: 4096,
    used_bytes: 0,
    read_only: false,
    online: true,
  },
  {
    id: 'shared-nas-disk2',
    name: '共享盘 02 · 媒体与归档阵列',
    pool_type: 'shared',
    mount_path: './data/storage/shared_disk2',
    quota_gb: 8192,
    used_bytes: 0,
    read_only: false,
    online: true,
  },
];

export default function App() {
  // Auth state
  const [token, setToken] = createSignal<string | null>(localStorage.getItem('mayadesk_token'));
  const [user, setUser] = createSignal<UserProfile | null>({
    id: 'usr_admin_default',
    email: 'admin@mayadesk.local',
    display_name: 'Admin',
    role: 'admin',
  });
  const [showAuthModal, setShowAuthModal] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<'login' | 'register'>('login');
  const [emailInput, setEmailInput] = createSignal('admin@mayadesk.local');
  const [passwordInput, setPasswordInput] = createSignal('admin123456');

  // Navigation & Mobile Drawer state
  const [activeView, setActiveView] = createSignal<'files' | 'settings'>('files');
  const [mobileMenuOpen, setMobileMenuOpen] = createSignal(false);

  // Disk & File Explorer state
  const [disks, setDisks] = createSignal<DiskMountSummary[]>(DEFAULT_FALLBACK_DISKS);
  const [activePoolId, setActivePoolId] = createSignal<string>('private-main');
  const [currentPath, setCurrentPath] = createSignal<string>('/');
  const [entries, setEntries] = createSignal<VfsFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string>('就绪');

  // Transport state (P2P Primary + CF Tunnel Fallback)
  const [transportChannel, setTransportChannel] = createSignal<TransportChannel>('p2p-lan');
  const [rttMs, setRttMs] = createSignal<number>(6);

  // Full System & Path Configuration state
  const [sysConfig, setSysConfig] = createSignal<FullAppConfig>({
    server: {
      app_name: 'MayaDesk',
      host: '0.0.0.0',
      port: 8080,
      public_url: 'https://drive.example.com',
      static_dir: './frontend/dist',
      temp_upload_dir: './data/tmp_chunks',
      log_dir: './data/logs',
      max_upload_size_mb: 102400,
    },
    database: {
      sqlite_path: './data/db/mayadesk.db',
      auto_migrate: true,
    },
    auth: {
      jwt_secret: 'change-this-to-a-secure-random-64-char-secret-in-production',
      access_token_ttl_secs: 3600,
      refresh_token_ttl_days: 30,
      allow_registration: true,
      default_admin_email: 'admin@mayadesk.local',
      default_admin_password: 'admin123456',
      google: {
        enabled: true,
        client_id: 'your-google-client-id.apps.googleusercontent.com',
        client_secret: 'your-google-client-secret',
        redirect_uri: 'https://drive.example.com/api/v1/auth/google/callback',
      },
    },
    network: {
      p2p_enabled: true,
      p2p_udp_port: 51820,
      p2p_handshake_timeout_ms: 1500,
      chunk_size_kb: 4096,
      stun_servers: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
      cloudflare_tunnel: {
        enabled: true,
        tunnel_name: 'mayadesk-nas-tunnel',
        tunnel_token: '',
        fallback_https_enabled: true,
      },
    },
    storage: {
      pools: [
        {
          id: 'private-main',
          name: '私人主硬盘 (NVMe)',
          pool_type: 'private',
          mount_path: './data/storage/private_nvme',
          quota_gb: 1024,
          read_only: false,
        },
        {
          id: 'shared-nas-disk1',
          name: '共享盘 01 · 团队资料库',
          pool_type: 'shared',
          mount_path: './data/storage/shared_disk1',
          quota_gb: 4096,
          read_only: false,
        },
        {
          id: 'shared-nas-disk2',
          name: '共享盘 02 · 媒体与归档阵列',
          pool_type: 'shared',
          mount_path: './data/storage/shared_disk2',
          quota_gb: 8192,
          read_only: false,
        },
      ],
    },
  });

  const refreshDisks = async () => {
    try {
      const list = await apiListDisks(token());
      if (list.length > 0) {
        setDisks(list);
        if (!list.some((d) => d.id === activePoolId())) {
          setActivePoolId(list[0].id);
        }
      }
    } catch {
      // Offline preview mode uses default disks
    }
  };

  const refreshDirectory = async (poolId = activePoolId(), path = currentPath()) => {
    setLoadingFiles(true);
    try {
      const list = await apiListFiles(poolId, path, token());
      setEntries(list);
      setStatusMessage(`已加载 ${list.length} 项 (${poolId}:${path})`);
    } catch (err: any) {
      setStatusMessage(`提示: ${err?.message || '目录为空'}`);
      setEntries([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadConfigFromServer = async () => {
    try {
      const remoteCfg = await apiGetSystemConfig(token());
      setSysConfig(remoteCfg);
    } catch {
      // Keep local config state when offline
    }
  };

  onMount(async () => {
    await refreshDisks();
    await refreshDirectory();
    await loadConfigFromServer();

    const tm = new HybridTransportManager('/api/v1/p2p/ws', '/api/v1');
    const telemetry = await tm.negotiateOptimalChannel(800);
    setTransportChannel(telemetry.channel);
    setRttMs(telemetry.rttMs);
  });

  createEffect(() => {
    const pid = activePoolId();
    const p = currentPath();
    refreshDirectory(pid, p);
  });

  const handleAuthSubmit = async (e: Event) => {
    e.preventDefault();
    try {
      const resp =
        authMode() === 'login'
          ? await apiLogin(emailInput(), passwordInput())
          : await apiRegister(emailInput(), passwordInput());
      setToken(resp.access_token);
      localStorage.setItem('mayadesk_token', resp.access_token);
      setUser(resp.user);
      setShowAuthModal(false);
      setStatusMessage(`已登录: ${resp.user.email}`);
      await refreshDisks();
      await refreshDirectory();
    } catch (err: any) {
      setStatusMessage(`认证失败: ${err?.message}`);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const info = await apiGetGoogleAuthUrl();
      window.location.href = info.authorize_url;
    } catch {
      setStatusMessage('请在「配置」中填写 Google OAuth Client ID');
    }
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('输入新建文件夹名称:');
    if (!name || !name.trim()) return;
    try {
      await apiCreateFolder(activePoolId(), currentPath(), name.trim(), token());
      setStatusMessage(`已创建文件夹: ${name.trim()}`);
      await refreshDirectory();
    } catch (err: any) {
      setStatusMessage(`创建失败: ${err?.message}`);
    }
  };

  const handleFileUpload = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    try {
      setStatusMessage(`正在通过 ${transportChannel()} 上传 ${input.files.length} 个文件...`);
      await apiUploadFiles(activePoolId(), currentPath(), input.files, token());
      setStatusMessage('上传完成 (BLAKE3 校验通过)');
      input.value = '';
      await refreshDirectory();
      await refreshDisks();
    } catch (err: any) {
      setStatusMessage(`上传失败: ${err?.message}`);
    }
  };

  const handleDelete = async (entry: VfsFileEntry) => {
    if (!window.confirm(`确认删除 "${entry.name}" 吗？`)) return;
    try {
      await apiDeleteEntry(activePoolId(), entry.rel_path, token());
      setStatusMessage(`已删除: ${entry.name}`);
      await refreshDirectory();
      await refreshDisks();
    } catch (err: any) {
      setStatusMessage(`删除失败: ${err?.message}`);
    }
  };

  const navigateUp = () => {
    const cur = currentPath().replace(/\/+$/, '');
    if (!cur || cur === '/') return;
    const idx = cur.lastIndexOf('/');
    setCurrentPath(idx <= 0 ? '/' : cur.slice(0, idx));
  };

  const handleSaveConfig = async () => {
    try {
      await apiSaveSystemConfig(sysConfig(), token());
      setStatusMessage('配置已写入 config/config.toml 并即时生效');
      await refreshDisks();
    } catch (err: any) {
      setStatusMessage(`保存配置失败: ${err?.message}`);
    }
  };

  const addStoragePool = () => {
    const cfg = structuredClone(sysConfig());
    const idx = cfg.storage.pools.length + 1;
    cfg.storage.pools.push({
      id: `shared-nas-disk${idx}`,
      name: `新增硬盘池 0${idx}`,
      pool_type: 'shared',
      mount_path: `./data/storage/disk_${idx}`,
      quota_gb: 2048,
      read_only: false,
    });
    setSysConfig(cfg);
  };

  const removeStoragePool = (index: number) => {
    const cfg = structuredClone(sysConfig());
    cfg.storage.pools.splice(index, 1);
    setSysConfig(cfg);
  };

  const selectPool = (poolId: string) => {
    setActiveView('files');
    setActivePoolId(poolId);
    setCurrentPath('/');
    setMobileMenuOpen(false);
  };

  const activePoolObj = () => disks().find((d) => d.id === activePoolId());

  return (
    <div class="min-h-screen flex flex-col bg-white text-black text-sm">
      {/* Top Flat Header Bar — Fully Responsive for Mobile & Desktop */}
      <header class="border-b border-black px-3 py-2 md:px-4 md:h-12 flex flex-wrap items-center justify-between gap-2 bg-white">
        <div class="flex items-center gap-2 md:gap-4">
          {/* Mobile Disk Drawer Toggle Button */}
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            class="md:hidden px-2 py-1 border border-black bg-sky-100 text-black text-xs font-bold cursor-pointer"
          >
            {mobileMenuOpen() ? '✕ 收起盘符' : '☰ 硬盘池'}
          </button>

          <div class="flex items-center gap-1.5 font-bold tracking-tight text-sm md:text-base">
            <span class="px-1.5 py-0.5 bg-black text-white text-xs font-mono">MD</span>
            <span class="truncate max-w-[110px] sm:max-w-none">{sysConfig().server.app_name}</span>
          </div>

          <nav class="flex items-center border border-black">
            <button
              onClick={() => setActiveView('files')}
              class={`px-2.5 py-1 text-xs font-medium cursor-pointer ${
                activeView() === 'files'
                  ? 'bg-sky-100 text-black font-semibold'
                  : 'bg-white text-black hover:bg-sky-50'
              }`}
            >
              文件
            </button>
            <button
              onClick={() => setActiveView('settings')}
              class={`px-2.5 py-1 text-xs font-medium border-l border-black cursor-pointer ${
                activeView() === 'settings'
                  ? 'bg-sky-100 text-black font-semibold'
                  : 'bg-white text-black hover:bg-sky-50'
              }`}
            >
              配置
            </button>
          </nav>
        </div>

        {/* Right Status & Auth Bar */}
        <div class="flex items-center gap-1.5 md:gap-3 text-xs ml-auto">
          <button
            onClick={() =>
              setTransportChannel((c) => (c === 'p2p-lan' ? 'cf-tunnel-web' : 'p2p-lan'))
            }
            title="点击切换 P2P 直连 / Cloudflare Tunnel 兜底通道"
            class="px-2 py-1 border border-black bg-sky-100 text-black font-mono cursor-pointer text-[11px] md:text-xs"
          >
            {transportChannel() === 'p2p-lan'
              ? `P2P:${rttMs()}ms`
              : `CF-Tunnel`}
          </button>

          <button
            onClick={() => setShowAuthModal(true)}
            class="px-2 py-1 border border-black bg-white hover:bg-sky-100 text-black cursor-pointer text-[11px] md:text-xs truncate max-w-[130px] sm:max-w-none"
          >
            {user() ? user()!.email.split('@')[0] : '登录'}
          </button>
        </div>
      </header>

      {/* Mobile Horizontal Quick Disk Selector Bar (Always visible on small screens in Files view) */}
      <Show when={activeView() === 'files'}>
        <div class="md:hidden border-b border-black bg-white px-3 py-2 flex items-center gap-2 overflow-x-auto whitespace-nowrap">
          <For each={disks()}>
            {(pool) => (
              <button
                onClick={() => selectPool(pool.id)}
                class={`px-2.5 py-1 border border-black text-xs cursor-pointer shrink-0 ${
                  activePoolId() === pool.id
                    ? 'bg-sky-100 font-semibold'
                    : 'bg-white'
                }`}
              >
                {pool.pool_type === 'private' ? '[私] ' : '[享] '}
                {pool.name}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Mobile Slide-Down Full Disk Details Drawer */}
      <Show when={mobileMenuOpen()}>
        <div class="md:hidden border-b-2 border-black bg-white p-3 space-y-3">
          <div class="text-xs font-bold uppercase border-b border-black pb-1">
            存储池详情与切换 (点击选择)
          </div>
          <div class="space-y-1.5">
            <For each={disks()}>
              {(pool) => (
                <button
                  onClick={() => selectPool(pool.id)}
                  class={`w-full text-left p-2 border border-black ${
                    activePoolId() === pool.id ? 'bg-sky-100 font-semibold' : 'bg-white'
                  }`}
                >
                  <div class="flex items-center justify-between text-xs">
                    <span>
                      [{pool.pool_type === 'private' ? '私人盘' : '共享盘'}] {pool.name}
                    </span>
                    <span class="font-mono text-[11px]">
                      {formatBytes(pool.used_bytes)} / {pool.quota_gb}G
                    </span>
                  </div>
                  <div class="text-[11px] font-mono text-neutral-600 truncate mt-0.5">
                    挂载路径: {pool.mount_path}
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Main Workspace */}
      <div class="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Desktop Left Flat Sidebar (Hidden on Mobile, shown on md+) */}
        <aside class="hidden md:flex md:w-64 border-r border-black bg-white flex-col justify-between p-4 shrink-0">
          <div class="space-y-5">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-wider pb-2 border-b border-black">
                私人硬盘池 (按账号隔离)
              </div>
              <div class="mt-2 space-y-1">
                <For each={disks().filter((d) => d.pool_type === 'private')}>
                  {(pool) => (
                    <button
                      onClick={() => selectPool(pool.id)}
                      class={`w-full text-left p-2 border border-black cursor-pointer ${
                        activePoolId() === pool.id && activeView() === 'files'
                          ? 'bg-sky-100 font-semibold'
                          : 'bg-white hover:bg-sky-50'
                      }`}
                    >
                      <div class="flex items-center justify-between text-xs">
                        <span class="truncate">{pool.name}</span>
                        <span class="font-mono text-[10px] shrink-0">
                          {formatBytes(pool.used_bytes)}/{pool.quota_gb}G
                        </span>
                      </div>
                      <div class="text-[10px] font-mono text-neutral-600 truncate mt-1">
                        {pool.mount_path}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div>
              <div class="text-[11px] font-bold uppercase tracking-wider pb-2 border-b border-black">
                多盘 NAS 共享硬盘池
              </div>
              <div class="mt-2 space-y-1">
                <For each={disks().filter((d) => d.pool_type === 'shared')}>
                  {(pool) => (
                    <button
                      onClick={() => selectPool(pool.id)}
                      class={`w-full text-left p-2 border border-black cursor-pointer ${
                        activePoolId() === pool.id && activeView() === 'files'
                          ? 'bg-sky-100 font-semibold'
                          : 'bg-white hover:bg-sky-50'
                      }`}
                    >
                      <div class="flex items-center justify-between text-xs">
                        <span class="truncate">{pool.name}</span>
                        <span class="font-mono text-[10px] shrink-0">
                          {formatBytes(pool.used_bytes)}/{pool.quota_gb}G
                        </span>
                      </div>
                      <div class="text-[10px] font-mono text-neutral-600 truncate mt-1">
                        {pool.mount_path}
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>

          <div class="border-t border-black pt-3 text-[11px] space-y-1 font-mono">
            <div>服务端口: {sysConfig().server.port}</div>
            <div class="truncate">数据库: {sysConfig().database.sqlite_path}</div>
            <div>客户端: Web/Mac/Win/Linux/Android</div>
          </div>
        </aside>

        {/* Right Content Area */}
        <main class="flex-1 flex flex-col bg-white overflow-y-auto min-w-0">
          <Show
            when={activeView() === 'files'}
            fallback={
              /* Full System & Path Config Editor View — Mobile & Desktop Responsive */
              <div class="p-3 sm:p-6 max-w-4xl w-full space-y-5">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-black pb-3">
                  <div>
                    <h2 class="text-sm sm:text-base font-bold">
                      系统全路径与参数配置中心 (config/config.toml)
                    </h2>
                    <p class="text-xs text-neutral-600 mt-0.5">
                      所有挂载路径、数据库位置、缓存目录、Google OAuth、P2P 端口与 Cloudflare Tunnel 均可直接修改并持久化。
                    </p>
                  </div>
                  <button
                    onClick={handleSaveConfig}
                    class="w-full sm:w-auto px-4 py-2 sm:py-1.5 border border-black bg-sky-200 hover:bg-sky-300 text-black font-semibold text-xs cursor-pointer shrink-0"
                  >
                    保存全部配置到服务器
                  </button>
                </div>

                {/* 1. Core Paths & Server Settings */}
                <section class="border border-black p-3 sm:p-4 space-y-3">
                  <h3 class="text-xs font-bold uppercase tracking-wider bg-sky-100 px-2 py-1 border-b border-black">
                    1. 基础服务路径与数据库文件位置
                  </h3>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <label class="block space-y-1">
                      <span class="font-medium">系统名称 (app_name)</span>
                      <input
                        type="text"
                        value={sysConfig().server.app_name}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.server.app_name = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">监听地址与端口 (host : port)</span>
                      <div class="flex gap-2">
                        <input
                          type="text"
                          value={sysConfig().server.host}
                          onInput={(e) => {
                            const c = structuredClone(sysConfig());
                            c.server.host = e.currentTarget.value;
                            setSysConfig(c);
                          }}
                          class="w-2/3 px-2 py-1.5 border border-black font-mono bg-white"
                        />
                        <input
                          type="number"
                          value={sysConfig().server.port}
                          onInput={(e) => {
                            const c = structuredClone(sysConfig());
                            c.server.port = Number(e.currentTarget.value);
                            setSysConfig(c);
                          }}
                          class="w-1/3 px-2 py-1.5 border border-black font-mono bg-white"
                        />
                      </div>
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">SQLite 数据库文件路径 (sqlite_path)</span>
                      <input
                        type="text"
                        value={sysConfig().database.sqlite_path}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.database.sqlite_path = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">临时上传分片目录 (temp_upload_dir)</span>
                      <input
                        type="text"
                        value={sysConfig().server.temp_upload_dir}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.server.temp_upload_dir = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">运行日志目录 (log_dir)</span>
                      <input
                        type="text"
                        value={sysConfig().server.log_dir}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.server.log_dir = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">前端静态资源路径 (static_dir)</span>
                      <input
                        type="text"
                        value={sysConfig().server.static_dir}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.server.static_dir = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                      />
                    </label>
                  </div>
                </section>

                {/* 2. Multi-Disk NAS Storage Pools Config (Responsive Cards on Mobile, Grid on Desktop) */}
                <section class="border border-black p-3 sm:p-4 space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-2 bg-sky-100 px-2 py-1.5 border-b border-black">
                    <h3 class="text-xs font-bold uppercase tracking-wider">
                      2. 多盘 NAS 存储池路径映射
                    </h3>
                    <button
                      onClick={addStoragePool}
                      class="px-2.5 py-1 border border-black bg-white hover:bg-sky-200 text-xs font-medium cursor-pointer"
                    >
                      + 新增物理盘挂载池
                    </button>
                  </div>

                  <div class="space-y-3">
                    <For each={sysConfig().storage.pools}>
                      {(pool, idx) => (
                        <div class="border border-black p-2.5 bg-white text-xs space-y-2">
                          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <label class="block space-y-0.5">
                              <span class="text-[11px] text-neutral-600">池 ID</span>
                              <input
                                type="text"
                                value={pool.id}
                                onInput={(e) => {
                                  const c = structuredClone(sysConfig());
                                  c.storage.pools[idx()].id = e.currentTarget.value;
                                  setSysConfig(c);
                                }}
                                class="w-full px-2 py-1 border border-black font-mono"
                              />
                            </label>
                            <label class="block space-y-0.5">
                              <span class="text-[11px] text-neutral-600">显示名称</span>
                              <input
                                type="text"
                                value={pool.name}
                                onInput={(e) => {
                                  const c = structuredClone(sysConfig());
                                  c.storage.pools[idx()].name = e.currentTarget.value;
                                  setSysConfig(c);
                                }}
                                class="w-full px-2 py-1 border border-black"
                              />
                            </label>
                            <label class="block space-y-0.5">
                              <span class="text-[11px] text-neutral-600">类型</span>
                              <select
                                value={pool.pool_type}
                                onChange={(e) => {
                                  const c = structuredClone(sysConfig());
                                  c.storage.pools[idx()].pool_type = e.currentTarget.value as
                                    | 'private'
                                    | 'shared';
                                  setSysConfig(c);
                                }}
                                class="w-full px-2 py-1 border border-black bg-sky-50"
                              >
                                <option value="private">私人盘 (Private)</option>
                                <option value="shared">共享盘 (Shared)</option>
                              </select>
                            </label>
                          </div>

                          <div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                            <label class="block space-y-0.5 sm:col-span-8">
                              <span class="text-[11px] text-neutral-600">物理挂载路径 (mount_path)</span>
                              <input
                                type="text"
                                value={pool.mount_path}
                                onInput={(e) => {
                                  const c = structuredClone(sysConfig());
                                  c.storage.pools[idx()].mount_path = e.currentTarget.value;
                                  setSysConfig(c);
                                }}
                                class="w-full px-2 py-1 border border-black font-mono"
                              />
                            </label>
                            <label class="block space-y-0.5 sm:col-span-2">
                              <span class="text-[11px] text-neutral-600">配额 (GB)</span>
                              <input
                                type="number"
                                value={pool.quota_gb}
                                onInput={(e) => {
                                  const c = structuredClone(sysConfig());
                                  c.storage.pools[idx()].quota_gb = Number(e.currentTarget.value);
                                  setSysConfig(c);
                                }}
                                class="w-full px-2 py-1 border border-black font-mono"
                              />
                            </label>
                            <button
                              onClick={() => removeStoragePool(idx())}
                              class="sm:col-span-2 w-full py-1 border border-black bg-white hover:bg-sky-100 text-center cursor-pointer"
                            >
                              删除此盘
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                {/* 3. P2P & Independent Cloudflare Tunnel Settings */}
                <section class="border border-black p-3 sm:p-4 space-y-3">
                  <h3 class="text-xs font-bold uppercase tracking-wider bg-sky-100 px-2 py-1 border-b border-black">
                    3. P2P 穿透与独立 Cloudflare Tunnel 配置
                  </h3>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <label class="block space-y-1">
                      <span class="font-medium">P2P UDP 监听端口 (p2p_udp_port)</span>
                      <input
                        type="number"
                        value={sysConfig().network.p2p_udp_port}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.network.p2p_udp_port = Number(e.currentTarget.value);
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">P2P 打洞超时回退毫秒数</span>
                      <input
                        type="number"
                        value={sysConfig().network.p2p_handshake_timeout_ms}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.network.p2p_handshake_timeout_ms = Number(e.currentTarget.value);
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">STUN 服务器列表 (逗号分隔)</span>
                      <input
                        type="text"
                        value={sysConfig().network.stun_servers.join(',')}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.network.stun_servers = e.currentTarget.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">Cloudflare Tunnel 名称与 Token</span>
                      <div class="flex gap-2">
                        <input
                          type="text"
                          placeholder="Tunnel Name"
                          value={sysConfig().network.cloudflare_tunnel.tunnel_name}
                          onInput={(e) => {
                            const c = structuredClone(sysConfig());
                            c.network.cloudflare_tunnel.tunnel_name = e.currentTarget.value;
                            setSysConfig(c);
                          }}
                          class="w-1/3 px-2 py-1.5 border border-black font-mono"
                        />
                        <input
                          type="password"
                          placeholder="CF_TUNNEL_TOKEN"
                          value={sysConfig().network.cloudflare_tunnel.tunnel_token}
                          onInput={(e) => {
                            const c = structuredClone(sysConfig());
                            c.network.cloudflare_tunnel.tunnel_token = e.currentTarget.value;
                            setSysConfig(c);
                          }}
                          class="w-2/3 px-2 py-1.5 border border-black font-mono"
                        />
                      </div>
                    </label>
                  </div>
                </section>

                {/* 4. Auth & Google OAuth Settings */}
                <section class="border border-black p-3 sm:p-4 space-y-3">
                  <h3 class="text-xs font-bold uppercase tracking-wider bg-sky-100 px-2 py-1 border-b border-black">
                    4. 邮箱密码鉴权与 Google OAuth 2.0 参数配置
                  </h3>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <label class="block space-y-1">
                      <span class="font-medium">Google Client ID</span>
                      <input
                        type="text"
                        value={sysConfig().auth.google.client_id}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.auth.google.client_id = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono"
                      />
                    </label>
                    <label class="block space-y-1">
                      <span class="font-medium">Google Callback Redirect URI</span>
                      <input
                        type="text"
                        value={sysConfig().auth.google.redirect_uri}
                        onInput={(e) => {
                          const c = structuredClone(sysConfig());
                          c.auth.google.redirect_uri = e.currentTarget.value;
                          setSysConfig(c);
                        }}
                        class="w-full px-2 py-1.5 border border-black font-mono"
                      />
                    </label>
                  </div>
                </section>
              </div>
            }
          >
            {/* File Explorer Toolbar — Stacks cleanly on Mobile */}
            <div class="border-b border-black px-3 py-2.5 sm:px-6 sm:py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-sky-50/60">
              <div class="flex flex-wrap items-center gap-1.5 text-xs min-w-0">
                <button
                  onClick={navigateUp}
                  class="px-2 py-1 border border-black bg-white hover:bg-sky-100 cursor-pointer font-mono shrink-0"
                >
                  ↑ 上级
                </button>
                <span class="font-semibold truncate">{activePoolObj()?.name || activePoolId()}</span>
                <span class="px-1.5 py-0.5 bg-sky-100 border border-black font-mono truncate max-w-[180px] sm:max-w-xs">
                  {currentPath()}
                </span>
              </div>

              <div class="flex items-center gap-1.5 text-xs">
                <button
                  onClick={handleCreateFolder}
                  class="flex-1 sm:flex-none px-2.5 py-1.5 sm:py-1 border border-black bg-white hover:bg-sky-100 font-medium cursor-pointer text-center"
                >
                  + 新建文件夹
                </button>
                <label class="flex-1 sm:flex-none px-2.5 py-1.5 sm:py-1 border border-black bg-sky-200 hover:bg-sky-300 font-semibold cursor-pointer text-center">
                  ↑ 上传文件
                  <input type="file" multiple onChange={handleFileUpload} class="hidden" />
                </label>
                <button
                  onClick={() => refreshDirectory()}
                  class="px-2.5 py-1.5 sm:py-1 border border-black bg-white hover:bg-sky-100 cursor-pointer shrink-0"
                >
                  刷新
                </button>
              </div>
            </div>

            {/* Flat File List — Mobile Card Rows on <sm, 12-Col Table on sm+ */}
            <div class="flex-1 p-3 sm:p-6">
              <div class="border border-black">
                {/* Desktop Table Header */}
                <div class="hidden sm:grid sm:grid-cols-12 border-b border-black bg-sky-100 px-3 py-2 text-xs font-bold">
                  <div class="col-span-5">名称</div>
                  <div class="col-span-2">大小</div>
                  <div class="col-span-2">BLAKE3 校验</div>
                  <div class="col-span-2">修改时间</div>
                  <div class="col-span-1 text-right">操作</div>
                </div>

                {/* Mobile List Header */}
                <div class="sm:hidden border-b border-black bg-sky-100 px-3 py-1.5 text-xs font-bold flex justify-between">
                  <span>文件 / 目录列表</span>
                  <span>操作</span>
                </div>

                <Show
                  when={!loadingFiles() && entries().length > 0}
                  fallback={
                    <div class="p-6 sm:p-8 text-center text-xs text-neutral-600">
                      {loadingFiles()
                        ? '正在读取目录...'
                        : '当前目录为空，可点击上方「+ 新建文件夹」或「↑ 上传文件」测试。'}
                    </div>
                  }
                >
                  <For each={entries()}>
                    {(item) => (
                      <div class="px-3 py-2.5 sm:py-2 border-b border-black last:border-b-0 hover:bg-sky-50 text-xs flex flex-col sm:grid sm:grid-cols-12 sm:items-center gap-1.5 sm:gap-0">
                        <div class="sm:col-span-5 flex items-center justify-between sm:justify-start gap-2 min-w-0">
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="font-mono text-[10px] px-1 border border-black bg-white shrink-0">
                              {item.is_dir ? 'DIR' : 'FILE'}
                            </span>
                            <Show
                              when={item.is_dir}
                              fallback={<span class="font-medium truncate">{item.name}</span>}
                            >
                              <button
                                onClick={() => setCurrentPath(item.rel_path)}
                                class="text-left underline hover:bg-sky-100 cursor-pointer font-semibold truncate"
                              >
                                {item.name}
                              </button>
                            </Show>
                          </div>

                          {/* Mobile Action Buttons */}
                          <div class="flex sm:hidden items-center gap-1.5 shrink-0">
                            <Show when={!item.is_dir}>
                              <a
                                href={getDownloadUrl(activePoolId(), item.rel_path)}
                                target="_blank"
                                class="px-2 py-0.5 border border-black bg-sky-100 text-[11px]"
                              >
                                下载
                              </a>
                            </Show>
                            <button
                              onClick={() => handleDelete(item)}
                              class="px-2 py-0.5 border border-black bg-white text-[11px] cursor-pointer"
                            >
                              删除
                            </button>
                          </div>
                        </div>

                        {/* Mobile Metadata Subtitle */}
                        <div class="flex sm:hidden items-center gap-3 text-[11px] font-mono text-neutral-600">
                          <span>{item.is_dir ? '目录' : formatBytes(item.size_bytes)}</span>
                          <Show when={item.blake3_short}>
                            <span>BLAKE3:{item.blake3_short}</span>
                          </Show>
                          <span>{formatTime(item.modified_unix)}</span>
                        </div>

                        {/* Desktop Columns */}
                        <div class="hidden sm:block sm:col-span-2 font-mono">
                          {item.is_dir ? '-' : formatBytes(item.size_bytes)}
                        </div>
                        <div class="hidden sm:block sm:col-span-2 font-mono text-[11px] text-neutral-600 truncate">
                          {item.blake3_short || '-'}
                        </div>
                        <div class="hidden sm:block sm:col-span-2 font-mono text-[11px]">
                          {formatTime(item.modified_unix)}
                        </div>
                        <div class="hidden sm:flex sm:col-span-1 justify-end gap-1.5">
                          <Show when={!item.is_dir}>
                            <a
                              href={getDownloadUrl(activePoolId(), item.rel_path)}
                              target="_blank"
                              class="px-1.5 py-0.5 border border-black bg-sky-100 hover:bg-sky-200 text-[11px] shrink-0"
                            >
                              下载
                            </a>
                          </Show>
                          <button
                            onClick={() => handleDelete(item)}
                            class="px-1.5 py-0.5 border border-black bg-white hover:bg-sky-100 text-[11px] cursor-pointer shrink-0"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Show>

          {/* Bottom Flat Status Bar */}
          <footer class="border-t border-black px-3 py-1.5 sm:px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1 bg-white text-[11px] font-mono">
            <div class="truncate">状态: {statusMessage()}</div>
            <div class="text-neutral-600 truncate">
              P2P ({sysConfig().network.p2p_handshake_timeout_ms}ms) → CF Tunnel
            </div>
          </footer>
        </main>
      </div>

      {/* Minimalist Flat Login / Register Modal */}
      <Show when={showAuthModal()}>
        <div class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div class="w-full max-w-sm border-2 border-black bg-white p-4 sm:p-5 space-y-4">
            <div class="flex items-center justify-between border-b border-black pb-2">
              <h3 class="font-bold text-sm">
                {authMode() === 'login' ? '账号登录 (邮箱密码 / Google)' : '注册新账号'}
              </h3>
              <button
                onClick={() => setShowAuthModal(false)}
                class="px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} class="space-y-3 text-xs">
              <label class="block space-y-1">
                <span class="font-medium">邮箱地址</span>
                <input
                  type="email"
                  required
                  value={emailInput()}
                  onInput={(e) => setEmailInput(e.currentTarget.value)}
                  class="w-full px-2.5 py-1.5 border border-black font-mono bg-white"
                />
              </label>
              <label class="block space-y-1">
                <span class="font-medium">密码</span>
                <input
                  type="password"
                  required
                  value={passwordInput()}
                  onInput={(e) => setPasswordInput(e.currentTarget.value)}
                  class="w-full px-2.5 py-1.5 border border-black font-mono bg-white"
                />
              </label>

              <button
                type="submit"
                class="w-full py-2 border border-black bg-sky-200 hover:bg-sky-300 font-bold cursor-pointer"
              >
                {authMode() === 'login' ? '通过邮箱密码登录' : '注册并登录'}
              </button>
            </form>

            <div class="border-t border-black pt-3 space-y-2 text-xs">
              <button
                type="button"
                onClick={handleGoogleLogin}
                class="w-full py-2 border border-black bg-white hover:bg-sky-100 font-semibold cursor-pointer"
              >
                使用 Google 账号登录 (OAuth 2.0)
              </button>

              <div class="text-center pt-1">
                <button
                  type="button"
                  onClick={() =>
                    setAuthMode((m) => (m === 'login' ? 'register' : 'login'))
                  }
                  class="underline cursor-pointer text-neutral-700"
                >
                  {authMode() === 'login' ? '没有账号？点击注册' : '已有账号？返回登录'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
