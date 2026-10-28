import { createSignal, createEffect, For, Show, onMount } from 'solid-js';
import {
  apiLogin,
  apiRegister,
  apiGetGoogleAuthUrl,
  apiGetUserProfile,
  apiListDisks,
  apiListFiles,
  apiListFolderPaths,
  apiCreateFolder,
  apiUploadFiles,
  apiDeleteEntry,
  getDownloadUrl,
  apiListAdminUsers,
  apiUpdateUserQuota,
  apiGetTransferLogs,
  apiInitDisk,
  apiGetSystemConfig,
  apiSaveSystemConfig,
  type DiskMountSummary,
  type VfsFileEntry,
  type FullAppConfig,
  type UserProfile,
  type UserRecord,
  type TransferLogRecord,
} from './services/api';
import { HybridTransportManager, type TransportChannel } from './services/p2pTransport';

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function formatTime(unixOrIso: number | string): string {
  if (!unixOrIso) return '-';
  const d = typeof unixOrIso === 'number' ? new Date(unixOrIso * 1000) : new Date(unixOrIso);
  if (isNaN(d.getTime())) return String(unixOrIso);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

export default function App() {
  // Auth state
  const [token, setToken] = createSignal<string | null>(localStorage.getItem('mayadesk_token'));
  const [user, setUser] = createSignal<UserProfile | null>(null);
  const [showAuthModal, setShowAuthModal] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<'login' | 'register'>('login');
  const [emailInput, setEmailInput] = createSignal('');
  const [passwordInput, setPasswordInput] = createSignal('');

  // Main Navigation View: 'files' | 'users' | 'transfers' | 'settings'
  const [activeView, setActiveView] = createSignal<'files' | 'users' | 'transfers' | 'settings'>('files');
  const [mobileMenuOpen, setMobileMenuOpen] = createSignal(false);

  // Requirement 3: Normal users only see two spaces: "私人" (private) and "共享" (shared)
  const [activeSpace, setActiveSpace] = createSignal<'private' | 'shared'>('private');
  const [currentPath, setCurrentPath] = createSignal<string>('/');
  const [folderTree, setFolderTree] = createSignal<string[]>(['/']);
  const [entries, setEntries] = createSignal<VfsFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string>('就绪');
  const [uploadProgress, setUploadProgress] = createSignal<number | null>(null);

  // Storage Disks & Requirement 1: Fresh Deployment Initialization state
  const [disks, setDisks] = createSignal<DiskMountSummary[]>([]);
  const [showInitDiskModal, setShowInitDiskModal] = createSignal(false);
  const [initMountPath, setInitMountPath] = createSignal('');
  const [initPoolType, setInitPoolType] = createSignal<'both' | 'private' | 'shared'>('both');
  const [initQuotaGb, setInitQuotaGb] = createSignal(1024);
  const [initDiskName, setInitDiskName] = createSignal('');

  // Transport state (P2P Primary + CF Tunnel Fallback)
  const [transportChannel, setTransportChannel] = createSignal<TransportChannel>('p2p-lan');
  const [rttMs, setRttMs] = createSignal<number>(6);

  // Admin Data: Users Quota Management & Transfer Logs
  const [adminUsers, setAdminUsers] = createSignal<UserRecord[]>([]);
  const [editingQuotas, setEditingQuotas] = createSignal<Record<string, number>>({});
  const [transferLogs, setTransferLogs] = createSignal<TransferLogRecord[]>([]);

  // System Configuration (Admin Only)
  const [sysConfig, setSysConfig] = createSignal<FullAppConfig | null>(null);

  const isAdmin = () => user()?.role === 'admin';

  const refreshUserProfile = async () => {
    if (!token()) return;
    try {
      const profile = await apiGetUserProfile(token());
      setUser(profile);
    } catch {
      // If profile fetch fails, token may be expired
    }
  };

  const refreshDisks = async () => {
    try {
      const list = await apiListDisks(token());
      setDisks(list);
      // Requirement 1: If disks are empty and user is admin, prompt initialization wizard
      if (list.length === 0 && isAdmin()) {
        setShowInitDiskModal(true);
      }
    } catch {
      // Offline fallback
    }
  };

  const refreshFolderTree = async () => {
    try {
      const paths = await apiListFolderPaths(activeSpace(), token());
      setFolderTree(paths);
    } catch {
      setFolderTree(['/']);
    }
  };

  const refreshDirectory = async (space = activeSpace(), path = currentPath()) => {
    setLoadingFiles(true);
    try {
      const list = await apiListFiles(space, path, token());
      setEntries(list);
      const spaceLabel = space === 'private' ? '私人空间' : '共享空间';
      setStatusMessage(`已加载 ${list.length} 项 (${spaceLabel}:${path})`);
    } catch (err: any) {
      setStatusMessage(`提示: ${err?.message || '目录为空'}`);
      setEntries([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadAdminUsers = async () => {
    if (!isAdmin()) return;
    try {
      const users = await apiListAdminUsers(token());
      setAdminUsers(users);
      const initialMap: Record<string, number> = {};
      users.forEach((u) => {
        initialMap[u.id] = Math.round(u.quota_bytes / 1024 / 1024 / 1024);
      });
      setEditingQuotas(initialMap);
    } catch (err: any) {
      setStatusMessage(`加载用户列表失败: ${err?.message}`);
    }
  };

  const loadTransferLogs = async () => {
    try {
      const logs = await apiGetTransferLogs(token());
      setTransferLogs(logs);
    } catch (err: any) {
      setStatusMessage(`加载传输记录失败: ${err?.message}`);
    }
  };

  const loadConfigFromServer = async () => {
    if (!isAdmin()) return;
    try {
      const remoteCfg = await apiGetSystemConfig(token());
      setSysConfig(remoteCfg);
    } catch {
      // Offline
    }
  };

  onMount(async () => {
    await refreshUserProfile();
    await refreshDisks();
    await refreshDirectory();
    await refreshFolderTree();

    const tm = new HybridTransportManager('/api/v1/p2p/ws', '/api/v1');
    const telemetry = await tm.negotiateOptimalChannel(800);
    setTransportChannel(telemetry.channel);
    setRttMs(telemetry.rttMs);
  });

  createEffect(() => {
    const s = activeSpace();
    const p = currentPath();
    refreshDirectory(s, p);
    refreshFolderTree();
  });

  createEffect(() => {
    const view = activeView();
    if (view === 'users') {
      loadAdminUsers();
    } else if (view === 'transfers') {
      loadTransferLogs();
    } else if (view === 'settings') {
      loadConfigFromServer();
    }
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
      await refreshUserProfile();
      await refreshDisks();
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      setStatusMessage(`认证失败: ${err?.message}`);
    }
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('mayadesk_token');
    setStatusMessage('已退出登录');
  };

  const handleGoogleLogin = async () => {
    try {
      const info = await apiGetGoogleAuthUrl();
      window.location.href = info.authorize_url;
    } catch {
      setStatusMessage('请在「系统配置」中填写 Google OAuth Client ID');
    }
  };

  // Requirement 1: Fresh Deployment Initial Disk Setup Wizard
  const handleInitDiskSubmit = async (e: Event) => {
    e.preventDefault();
    if (!initMountPath().trim()) {
      alert('请输入物理硬盘挂载路径');
      return;
    }
    try {
      setStatusMessage('正在初始化存储硬盘挂载路径...');
      await apiInitDisk(
        {
          mount_path: initMountPath().trim(),
          pool_type: initPoolType(),
          name: initDiskName().trim() || undefined,
          quota_gb: initQuotaGb(),
        },
        token()
      );
      setShowInitDiskModal(false);
      setStatusMessage('存储硬盘初始化成功！');
      await refreshDisks();
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      alert(`初始化失败: ${err?.message}`);
    }
  };

  // Requirement 3: Quota check prior to upload
  const checkUploadAllowed = (): boolean => {
    if (isAdmin()) return true;
    const u = user();
    if (!u || !u.quota_bytes || u.quota_bytes <= 0) {
      alert('您当前尚未分配存储配额，请联系管理员分配空间后再上传文件。');
      return false;
    }
    if ((u.used_bytes || 0) >= u.quota_bytes) {
      alert('您的存储配额已用尽，无法上传新文件。请联系管理员扩充配额。');
      return false;
    }
    return true;
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('输入新建文件夹名称:');
    if (!name || !name.trim()) return;
    try {
      await apiCreateFolder(activeSpace(), currentPath(), name.trim(), token());
      setStatusMessage(`已创建文件夹: ${name.trim()}`);
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      setStatusMessage(`创建失败: ${err?.message}`);
    }
  };

  // Requirement 2 & 4: Upload files with relay fallback & chunked upload for large files
  const handleFileUpload = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    if (!checkUploadAllowed()) {
      input.value = '';
      return;
    }

    try {
      setUploadProgress(0);
      await apiUploadFiles(
        activeSpace(),
        currentPath(),
        input.files,
        token(),
        (pct, msg) => {
          setUploadProgress(pct);
          setStatusMessage(msg);
        }
      );
      setStatusMessage('文件上传完成 (已记录审计日志)');
      input.value = '';
      await refreshUserProfile();
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      alert(`上传失败: ${err?.message}`);
      setStatusMessage(`上传失败: ${err?.message}`);
    } finally {
      setTimeout(() => setUploadProgress(null), 1500);
    }
  };

  // Requirement 2: Folder Upload preserving directory hierarchy (webkitdirectory)
  const handleFolderUpload = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    if (!checkUploadAllowed()) {
      input.value = '';
      return;
    }

    try {
      setUploadProgress(0);
      setStatusMessage(`正在上传文件夹 (${input.files.length} 个文件)...`);
      await apiUploadFiles(
        activeSpace(),
        currentPath(),
        input.files,
        token(),
        (pct, msg) => {
          setUploadProgress(pct);
          setStatusMessage(msg);
        }
      );
      setStatusMessage('文件夹上传完成 (层级结构已还原)');
      input.value = '';
      await refreshUserProfile();
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      alert(`文件夹上传失败: ${err?.message}`);
      setStatusMessage(`文件夹上传失败: ${err?.message}`);
    } finally {
      setTimeout(() => setUploadProgress(null), 1500);
    }
  };

  const handleDelete = async (entry: VfsFileEntry) => {
    const typeLabel = entry.is_dir ? '文件夹（包含其所有子文件）' : '文件';
    if (!window.confirm(`确认删除此${typeLabel} "${entry.name}" 吗？`)) return;
    try {
      await apiDeleteEntry(activeSpace(), entry.rel_path, token());
      setStatusMessage(`已删除: ${entry.name}`);
      await refreshUserProfile();
      await refreshDirectory();
      await refreshFolderTree();
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

  const selectSpace = (space: 'private' | 'shared') => {
    setActiveView('files');
    setActiveSpace(space);
    setCurrentPath('/');
    setMobileMenuOpen(false);
  };

  // Admin Quota Update
  const handleSaveUserQuota = async (userId: string) => {
    const gb = editingQuotas()[userId] || 0;
    const bytes = gb * 1024 * 1024 * 1024;
    try {
      await apiUpdateUserQuota(userId, bytes, token());
      setStatusMessage(`已将用户配额更新为 ${gb} GB`);
      await loadAdminUsers();
    } catch (err: any) {
      alert(`更新配额失败: ${err?.message}`);
    }
  };

  const handleSaveConfig = async () => {
    if (!sysConfig()) return;
    try {
      await apiSaveSystemConfig(sysConfig()!, token());
      setStatusMessage('配置已写入 config/config.toml 并即时生效');
      await refreshDisks();
    } catch (err: any) {
      setStatusMessage(`保存配置失败: ${err?.message}`);
    }
  };

  return (
    <div class="min-h-screen flex flex-col bg-white text-black text-sm">
      {/* Top Flat Header Bar */}
      <header class="border-b border-black px-3 py-2 md:px-4 md:h-12 flex flex-wrap items-center justify-between gap-2 bg-white">
        <div class="flex items-center gap-2 md:gap-4">
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            class="md:hidden px-2 py-1 border border-black bg-sky-100 text-black text-xs font-bold cursor-pointer"
          >
            {mobileMenuOpen() ? '✕ 收起目录' : '☰ 空间路径'}
          </button>

          <div class="flex items-center gap-1.5 font-bold tracking-tight text-sm md:text-base">
            <span class="px-1.5 py-0.5 bg-black text-white text-xs font-mono">MD</span>
            <span class="truncate max-w-[120px] sm:max-w-none">MayaDesk</span>
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
            <Show when={isAdmin()}>
              <button
                onClick={() => setActiveView('users')}
                class={`px-2.5 py-1 text-xs font-medium border-l border-black cursor-pointer ${
                  activeView() === 'users'
                    ? 'bg-sky-100 text-black font-semibold'
                    : 'bg-white text-black hover:bg-sky-50'
                }`}
              >
                用户配额
              </button>
              <button
                onClick={() => setActiveView('transfers')}
                class={`px-2.5 py-1 text-xs font-medium border-l border-black cursor-pointer ${
                  activeView() === 'transfers'
                    ? 'bg-sky-100 text-black font-semibold'
                    : 'bg-white text-black hover:bg-sky-50'
                }`}
              >
                传输记录
              </button>
              <button
                onClick={() => setActiveView('settings')}
                class={`px-2.5 py-1 text-xs font-medium border-l border-black cursor-pointer ${
                  activeView() === 'settings'
                    ? 'bg-sky-100 text-black font-semibold'
                    : 'bg-white text-black hover:bg-sky-50'
                }`}
              >
                系统配置
              </button>
            </Show>
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
            {transportChannel() === 'p2p-lan' ? `P2P:${rttMs()}ms` : `中继模式`}
          </button>

          <Show
            when={user()}
            fallback={
              <button
                onClick={() => setShowAuthModal(true)}
                class="px-2.5 py-1 border border-black bg-sky-200 hover:bg-sky-300 text-black cursor-pointer text-[11px] md:text-xs font-semibold"
              >
                登录 / 注册
              </button>
            }
          >
            <div class="flex items-center gap-1">
              <span class="px-2 py-1 border border-black bg-white text-[11px] md:text-xs truncate max-w-[110px] sm:max-w-none">
                {user()!.email.split('@')[0]} ({user()!.role === 'admin' ? '管理员' : '普通用户'})
              </span>
              <button
                onClick={handleLogout}
                class="px-1.5 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
                title="退出登录"
              >
                退出
              </button>
            </div>
          </Show>
        </div>
      </header>

      {/* Requirement 1: Fresh Deployment Banner for Admin when no storage pool is configured */}
      <Show when={disks().length === 0 && isAdmin()}>
        <div class="bg-amber-100 border-b border-black p-3 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <span class="font-bold">⚠️ 存储空间尚未初始化：</span>
            <span>当前系统尚未挂载任何物理存储盘，文件服务暂不可用。</span>
          </div>
          <button
            onClick={() => setShowInitDiskModal(true)}
            class="px-3 py-1 border border-black bg-amber-300 hover:bg-amber-400 font-bold cursor-pointer shrink-0"
          >
            + 立即配置初始存储盘
          </button>
        </div>
      </Show>

      {/* Main Workspace: Requirement 5 (Left Path Navigation, Right Main Content) */}
      <div class="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left Sidebar — Path & Space Tree Navigation (Hidden on Mobile unless toggled) */}
        <aside
          class={`${
            mobileMenuOpen() ? 'flex' : 'hidden'
          } md:flex md:w-64 border-r border-black bg-white flex-col justify-between p-3 shrink-0 overflow-y-auto`}
        >
          <div class="space-y-4">
            {/* Requirement 3: Normal users ONLY see "私人" and "共享" spaces (no physical disks/paths) */}
            <div>
              <div class="text-[11px] font-bold uppercase tracking-wider pb-1.5 border-b border-black">
                空间分类
              </div>
              <div class="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => selectSpace('private')}
                  class={`p-2 border border-black text-left cursor-pointer ${
                    activeSpace() === 'private' && activeView() === 'files'
                      ? 'bg-sky-100 font-bold'
                      : 'bg-white hover:bg-sky-50'
                  }`}
                >
                  <div class="text-xs">🔒 私人空间</div>
                  <div class="text-[10px] text-neutral-500 mt-0.5">个人加密隔离</div>
                </button>
                <button
                  onClick={() => selectSpace('shared')}
                  class={`p-2 border border-black text-left cursor-pointer ${
                    activeSpace() === 'shared' && activeView() === 'files'
                      ? 'bg-sky-100 font-bold'
                      : 'bg-white hover:bg-sky-50'
                  }`}
                >
                  <div class="text-xs">👥 共享空间</div>
                  <div class="text-[10px] text-neutral-500 mt-0.5">团队协作共享</div>
                </button>
              </div>
            </div>

            {/* Requirement 5: Left Path Navigation (左侧路径导航) */}
            <div>
              <div class="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider pb-1.5 border-b border-black">
                <span>路径目录树</span>
                <span class="text-[10px] font-mono text-neutral-500">
                  {activeSpace() === 'private' ? '私人' : '共享'}
                </span>
              </div>
              <div class="mt-2 space-y-1 text-xs">
                <For each={folderTree()}>
                  {(dirPath) => {
                    const depth = dirPath === '/' ? 0 : dirPath.split('/').filter(Boolean).length;
                    const folderName = dirPath === '/' ? '根目录 /' : dirPath.split('/').pop();
                    const isSelected = () => currentPath() === dirPath && activeView() === 'files';

                    return (
                      <button
                        onClick={() => {
                          setActiveView('files');
                          setCurrentPath(dirPath);
                          setMobileMenuOpen(false);
                        }}
                        style={{ 'padding-left': `${8 + depth * 14}px` }}
                        class={`w-full text-left py-1 pr-2 border border-black truncate cursor-pointer ${
                          isSelected()
                            ? 'bg-sky-100 font-semibold'
                            : 'bg-white hover:bg-sky-50'
                        }`}
                      >
                        <span class="mr-1.5 font-mono text-[10px]">📁</span>
                        <span class="truncate">{folderName}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>

          {/* User Quota Indicator Card (Requirement 3: Default no quota, assigned by admin) */}
          <div class="border-t border-black pt-3 space-y-2 mt-4">
            <div class="text-[11px] font-bold uppercase tracking-wider">我的存储配额</div>
            <div class="border border-black p-2 bg-sky-50/50 space-y-1.5 text-xs font-mono">
              <div class="flex justify-between items-center text-[11px]">
                <span>已使用:</span>
                <span class="font-bold">{formatBytes(user()?.used_bytes || 0)}</span>
              </div>
              <div class="flex justify-between items-center text-[11px]">
                <span>配额上限:</span>
                <span>
                  {isAdmin()
                    ? '无限 (管理员)'
                    : user()?.quota_bytes && user()!.quota_bytes! > 0
                    ? formatBytes(user()!.quota_bytes!)
                    : '无配额 (需管理员授权)'}
                </span>
              </div>
              <div class="w-full h-2 border border-black bg-white overflow-hidden">
                <div
                  class="h-full bg-black"
                  style={{
                    width: `${
                      isAdmin()
                        ? 10
                        : user()?.quota_bytes && user()!.quota_bytes! > 0
                        ? Math.min(100, Math.round(((user()?.used_bytes || 0) / user()!.quota_bytes!) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
            <div class="text-[10px] text-neutral-500 font-mono">
              P2P 穿透优先 · Cloudflare 中继兜底
            </div>
          </div>
        </aside>

        {/* Right Content Area */}
        <main class="flex-1 flex flex-col bg-white overflow-y-auto min-w-0">
          {/* View 1: Files View (Default) */}
          <Show when={activeView() === 'files'}>
            {/* Action & Path Toolbar */}
            <div class="border-b border-black px-3 py-2.5 sm:px-6 sm:py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-sky-50/60">
              <div class="flex flex-wrap items-center gap-1.5 text-xs min-w-0">
                <button
                  onClick={navigateUp}
                  class="px-2 py-1 border border-black bg-white hover:bg-sky-100 cursor-pointer font-mono shrink-0"
                >
                  ↑ 上级
                </button>
                <span class="font-semibold px-2 py-0.5 border border-black bg-white">
                  {activeSpace() === 'private' ? '🔒 私人空间' : '👥 共享空间'}
                </span>
                <span class="px-2 py-0.5 bg-sky-100 border border-black font-mono truncate max-w-[200px] sm:max-w-xs">
                  {currentPath()}
                </span>
              </div>

              {/* Requirement 2: Upload Files & Upload Folder buttons */}
              <div class="flex flex-wrap items-center gap-1.5 text-xs">
                <button
                  onClick={handleCreateFolder}
                  class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 font-medium cursor-pointer"
                >
                  + 新建文件夹
                </button>

                <label class="px-2.5 py-1 border border-black bg-sky-200 hover:bg-sky-300 font-semibold cursor-pointer">
                  ↑ 上传文件
                  <input type="file" multiple onChange={handleFileUpload} class="hidden" />
                </label>

                {/* Requirement 2: Folder Upload */}
                <label class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 font-semibold cursor-pointer">
                  📁 上传文件夹
                  <input
                    type="file"
                    /* @ts-ignore */
                    webkitdirectory
                    directory
                    multiple
                    onChange={handleFolderUpload}
                    class="hidden"
                  />
                </label>

                <button
                  onClick={() => refreshDirectory()}
                  class="px-2 py-1 border border-black bg-white hover:bg-sky-100 cursor-pointer shrink-0"
                >
                  刷新
                </button>
              </div>
            </div>

            {/* Requirement 4: Upload progress bar for large relay chunked uploads */}
            <Show when={uploadProgress() !== null}>
              <div class="border-b border-black bg-sky-100 px-4 py-1.5 text-xs flex items-center justify-between">
                <span>{statusMessage()}</span>
                <span class="font-mono font-bold">{uploadProgress()}%</span>
              </div>
            </Show>

            {/* Flat File List */}
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

                {/* Mobile Header */}
                <div class="sm:hidden border-b border-black bg-sky-100 px-3 py-1.5 text-xs font-bold flex justify-between">
                  <span>文件 / 目录列表</span>
                  <span>操作</span>
                </div>

                <Show
                  when={!loadingFiles() && entries().length > 0}
                  fallback={
                    <div class="p-8 text-center text-xs text-neutral-600">
                      {loadingFiles()
                        ? '正在读取目录...'
                        : '当前目录为空，可点击上方「+ 新建文件夹」、「↑ 上传文件」或「📁 上传文件夹」。'}
                    </div>
                  }
                >
                  <For each={entries()}>
                    {(item) => (
                      <div class="px-3 py-2 border-b border-black last:border-b-0 hover:bg-sky-50 text-xs flex flex-col sm:grid sm:grid-cols-12 sm:items-center gap-1.5 sm:gap-0">
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
                            <a
                              href={getDownloadUrl(activeSpace(), item.rel_path)}
                              target="_blank"
                              class="px-2 py-0.5 border border-black bg-sky-100 text-[11px]"
                            >
                              {item.is_dir ? '下载(ZIP)' : '下载'}
                            </a>
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
                          <span>{item.is_dir ? '文件夹' : formatBytes(item.size_bytes)}</span>
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
                          {/* Requirement 2: Directory downloads as ZIP, File downloads directly */}
                          <a
                            href={getDownloadUrl(activeSpace(), item.rel_path)}
                            target="_blank"
                            class="px-1.5 py-0.5 border border-black bg-sky-100 hover:bg-sky-200 text-[11px] shrink-0"
                            title={item.is_dir ? '打包下载整个文件夹为 ZIP 压缩包' : '下载文件'}
                          >
                            {item.is_dir ? 'ZIP' : '下载'}
                          </a>
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

          {/* View 2: User Quota Management (Admin Only - Requirement 3) */}
          <Show when={activeView() === 'users' && isAdmin()}>
            <div class="p-4 sm:p-6 space-y-4 max-w-4xl">
              <div class="flex items-center justify-between border-b border-black pb-2">
                <div>
                  <h2 class="text-sm sm:text-base font-bold">用户存储配额管理 (Quota Management)</h2>
                  <p class="text-xs text-neutral-600">
                    默认新注册用户无存储配额（0 B），需管理员手动分配配额后方可上传文件。
                  </p>
                </div>
                <button
                  onClick={loadAdminUsers}
                  class="px-3 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
                >
                  刷新列表
                </button>
              </div>

              <div class="border border-black overflow-x-auto">
                <table class="w-full text-xs text-left">
                  <thead class="bg-sky-100 border-b border-black font-bold">
                    <tr>
                      <th class="p-2.5">用户邮箱</th>
                      <th class="p-2.5">角色</th>
                      <th class="p-2.5">已用空间</th>
                      <th class="p-2.5">当前配额</th>
                      <th class="p-2.5">调整配额 (GB)</th>
                      <th class="p-2.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={adminUsers()}>
                      {(u) => (
                        <tr class="border-b border-black last:border-b-0 hover:bg-sky-50">
                          <td class="p-2.5 font-medium">{u.email}</td>
                          <td class="p-2.5">
                            <span class="px-1.5 py-0.5 border border-black text-[10px] bg-white">
                              {u.role === 'admin' ? '管理员' : '普通用户'}
                            </span>
                          </td>
                          <td class="p-2.5 font-mono">{formatBytes(u.used_bytes)}</td>
                          <td class="p-2.5 font-mono">
                            {u.role === 'admin'
                              ? '无限'
                              : u.quota_bytes > 0
                              ? formatBytes(u.quota_bytes)
                              : '0 B (无配额)'}
                          </td>
                          <td class="p-2.5">
                            <input
                              type="number"
                              min="0"
                              value={editingQuotas()[u.id] ?? 0}
                              onInput={(e) => {
                                const val = Number(e.currentTarget.value);
                                setEditingQuotas((prev) => ({ ...prev, [u.id]: val }));
                              }}
                              class="w-20 px-2 py-1 border border-black font-mono bg-white"
                            />
                            <span class="ml-1 text-neutral-500">GB</span>
                          </td>
                          <td class="p-2.5 text-right">
                            <button
                              onClick={() => handleSaveUserQuota(u.id)}
                              class="px-2.5 py-1 border border-black bg-sky-200 hover:bg-sky-300 font-semibold cursor-pointer"
                            >
                              保存配额
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>

          {/* View 3: Transfer Logs (Requirement 4) */}
          <Show when={activeView() === 'transfers'}>
            <div class="p-4 sm:p-6 space-y-4 max-w-5xl">
              <div class="flex items-center justify-between border-b border-black pb-2">
                <div>
                  <h2 class="text-sm sm:text-base font-bold">文件传输审计记录 (Transfer Logs)</h2>
                  <p class="text-xs text-neutral-600">
                    记录所有大文件分片中继上传、文件夹打包下载与常规文件的传输状态与信道模式。
                  </p>
                </div>
                <button
                  onClick={loadTransferLogs}
                  class="px-3 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
                >
                  刷新记录
                </button>
              </div>

              <div class="border border-black overflow-x-auto">
                <table class="w-full text-xs text-left">
                  <thead class="bg-sky-100 border-b border-black font-bold">
                    <tr>
                      <th class="p-2.5">时间</th>
                      <th class="p-2.5">用户</th>
                      <th class="p-2.5">类型</th>
                      <th class="p-2.5">文件名 / 路径</th>
                      <th class="p-2.5">文件大小</th>
                      <th class="p-2.5">通道模式</th>
                      <th class="p-2.5">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Show
                      when={transferLogs().length > 0}
                      fallback={
                        <tr>
                          <td colspan="7" class="p-6 text-center text-neutral-500">
                            暂无传输记录
                          </td>
                        </tr>
                      }
                    >
                      <For each={transferLogs()}>
                        {(log) => (
                          <tr class="border-b border-black last:border-b-0 hover:bg-sky-50 font-mono text-[11px]">
                            <td class="p-2.5">{formatTime(log.created_at)}</td>
                            <td class="p-2.5">{log.user_email}</td>
                            <td class="p-2.5">
                              <span
                                class={`px-1.5 py-0.5 border border-black ${
                                  log.action === 'upload' ? 'bg-sky-100 font-bold' : 'bg-white'
                                }`}
                              >
                                {log.action === 'upload' ? '上传' : '下载'}
                              </span>
                            </td>
                            <td class="p-2.5 font-sans truncate max-w-xs">{log.file_name}</td>
                            <td class="p-2.5">{formatBytes(log.size_bytes)}</td>
                            <td class="p-2.5">
                              <span class="px-1 border border-black bg-white">
                                {log.channel === 'p2p' ? 'P2P直连' : '服务器中继'}
                              </span>
                            </td>
                            <td class="p-2.5">
                              <span
                                class={`px-1 text-[10px] ${
                                  log.status === 'success' ? 'text-green-700 font-bold' : 'text-red-600'
                                }`}
                              >
                                {log.status === 'success' ? '成功' : '失败'}
                              </span>
                            </td>
                          </tr>
                        )}
                      </For>
                    </Show>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>

          {/* View 4: System Configuration (Admin Only) */}
          <Show when={activeView() === 'settings' && isAdmin() && sysConfig()}>
            <div class="p-4 sm:p-6 max-w-4xl space-y-4">
              <div class="flex items-center justify-between border-b border-black pb-2">
                <div>
                  <h2 class="text-sm sm:text-base font-bold">系统与物理存储池配置 (System Settings)</h2>
                  <p class="text-xs text-neutral-600">
                    配置 NAS 物理硬盘挂载路径、Cloudflare Tunnel 隧道令牌与网络穿透参数。
                  </p>
                </div>
                <button
                  onClick={handleSaveConfig}
                  class="px-4 py-1.5 border border-black bg-sky-200 hover:bg-sky-300 font-bold text-xs cursor-pointer"
                >
                  保存配置并生效
                </button>
              </div>

              {/* Requirement 1: Storage Pools List */}
              <section class="border border-black p-3 space-y-3">
                <div class="flex items-center justify-between bg-sky-100 px-2 py-1 border-b border-black text-xs font-bold">
                  <span>NAS 物理硬盘挂载池</span>
                  <button
                    onClick={() => setShowInitDiskModal(true)}
                    class="px-2 py-0.5 border border-black bg-white hover:bg-sky-200 text-xs font-normal cursor-pointer"
                  >
                    + 添加新存储盘
                  </button>
                </div>

                <div class="space-y-2">
                  <Show
                    when={sysConfig()!.storage.pools.length > 0}
                    fallback={<div class="p-4 text-center text-xs text-neutral-500">当前尚未挂载物理存储盘</div>}
                  >
                    <For each={sysConfig()!.storage.pools}>
                      {(pool, idx) => (
                        <div class="border border-black p-2.5 bg-white text-xs grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                          <div class="sm:col-span-3">
                            <span class="text-[11px] text-neutral-500 block">标识 / 名称</span>
                            <span class="font-bold">{pool.name}</span>
                          </div>
                          <div class="sm:col-span-2">
                            <span class="text-[11px] text-neutral-500 block">用途</span>
                            <span>{pool.pool_type === 'private' ? '私人空间' : '共享空间'}</span>
                          </div>
                          <div class="sm:col-span-4 font-mono truncate">
                            <span class="text-[11px] text-neutral-500 block">物理路径</span>
                            {pool.mount_path}
                          </div>
                          <div class="sm:col-span-2 font-mono">
                            <span class="text-[11px] text-neutral-500 block">容量上限</span>
                            {pool.quota_gb} GB
                          </div>
                          <div class="sm:col-span-1 text-right">
                            <button
                              onClick={() => {
                                const c = structuredClone(sysConfig()!);
                                c.storage.pools.splice(idx(), 1);
                                setSysConfig(c);
                              }}
                              class="px-2 py-0.5 border border-black bg-white hover:bg-red-50 text-[11px] cursor-pointer"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </section>

              {/* Tunnel & Network */}
              <section class="border border-black p-3 space-y-3">
                <div class="bg-sky-100 px-2 py-1 border-b border-black text-xs font-bold">
                  Cloudflare Zero Trust Tunnel 配置
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <label class="block space-y-1">
                    <span class="font-medium">Cloudflare Tunnel Token</span>
                    <input
                      type="password"
                      placeholder="eyJhIjoi..."
                      value={sysConfig()!.network.cloudflare_tunnel.tunnel_token}
                      onInput={(e) => {
                        const c = structuredClone(sysConfig()!);
                        c.network.cloudflare_tunnel.tunnel_token = e.currentTarget.value;
                        setSysConfig(c);
                      }}
                      class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                    />
                  </label>
                  <label class="block space-y-1">
                    <span class="font-medium">STUN 打洞服务器</span>
                    <input
                      type="text"
                      value={sysConfig()!.network.stun_servers.join(',')}
                      onInput={(e) => {
                        const c = structuredClone(sysConfig()!);
                        c.network.stun_servers = e.currentTarget.value.split(',').map((s) => s.trim());
                        setSysConfig(c);
                      }}
                      class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                    />
                  </label>
                </div>
              </section>
            </div>
          </Show>

          {/* Bottom Flat Status Bar */}
          <footer class="border-t border-black px-3 py-1.5 sm:px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1 bg-white text-[11px] font-mono mt-auto">
            <div class="truncate">状态: {statusMessage()}</div>
            <div class="text-neutral-600 truncate">
              {activeSpace() === 'private' ? '🔒 私人空间' : '👥 共享空间'} · 通道: {transportChannel()}
            </div>
          </footer>
        </main>
      </div>

      {/* Requirement 1: Initial Disk Configuration Wizard Modal (Admin) */}
      <Show when={showInitDiskModal()}>
        <div class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div class="w-full max-w-md border-2 border-black bg-white p-5 space-y-4">
            <div class="flex items-center justify-between border-b border-black pb-2">
              <h3 class="font-bold text-sm">配置存储硬盘路径 (初始化向导)</h3>
              <Show when={disks().length > 0}>
                <button
                  onClick={() => setShowInitDiskModal(false)}
                  class="px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
                >
                  关闭
                </button>
              </Show>
            </div>

            <form onSubmit={handleInitDiskSubmit} class="space-y-3 text-xs">
              <p class="text-neutral-600 text-[11px]">
                输入服务器物理存储路径。系统将自动在该目录下隔离构建私人空间与共享空间。
              </p>

              <label class="block space-y-1">
                <span class="font-medium">存储盘物理路径 (必填)</span>
                <input
                  type="text"
                  required
                  placeholder="例如：/data/storage 或 /mnt/nas_disk"
                  value={initMountPath()}
                  onInput={(e) => setInitMountPath(e.currentTarget.value)}
                  class="w-full px-2.5 py-1.5 border border-black font-mono bg-white"
                />
              </label>

              <label class="block space-y-1">
                <span class="font-medium">空间用途</span>
                <select
                  value={initPoolType()}
                  onChange={(e) => setInitPoolType(e.currentTarget.value as any)}
                  class="w-full px-2.5 py-1.5 border border-black bg-sky-50 font-medium"
                >
                  <option value="both">同时支持私人空间与共享空间 (推荐)</option>
                  <option value="private">仅私人空间</option>
                  <option value="shared">仅共享空间</option>
                </select>
              </label>

              <div class="grid grid-cols-2 gap-2">
                <label class="block space-y-1">
                  <span class="font-medium">硬盘显示名称 (可选)</span>
                  <input
                    type="text"
                    placeholder="留空自动命名"
                    value={initDiskName()}
                    onInput={(e) => setInitDiskName(e.currentTarget.value)}
                    class="w-full px-2 py-1.5 border border-black bg-white"
                  />
                </label>
                <label class="block space-y-1">
                  <span class="font-medium">容量上限 (GB)</span>
                  <input
                    type="number"
                    min="1"
                    value={initQuotaGb()}
                    onInput={(e) => setInitQuotaGb(Number(e.currentTarget.value))}
                    class="w-full px-2 py-1.5 border border-black font-mono bg-white"
                  />
                </label>
              </div>

              <button
                type="submit"
                class="w-full py-2 border border-black bg-sky-200 hover:bg-sky-300 font-bold cursor-pointer mt-2"
              >
                保存并初始化存储空间
              </button>
            </form>
          </div>
        </div>
      </Show>

      {/* Login / Register Modal */}
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
                  placeholder="user@example.com"
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
                {authMode() === 'login' ? '登录' : '注册账号 (初始无配额)'}
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
