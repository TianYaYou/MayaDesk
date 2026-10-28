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
  getPreviewUrl,
  apiExtractArchive,
  getFileCategory,
  apiListAdminUsers,
  apiUpdateUserQuota,
  apiGetTransferLogs,
  apiInitDisk,
  apiGetSystemConfig,
  apiSaveSystemConfig,
  apiBrowseServerFs,
  apiCreateServerFsDir,
  type DiskMountSummary,
  type VfsFileEntry,
  type FullAppConfig,
  type UserProfile,
  type UserRecord,
  type TransferLogRecord,
  type FsDirectoryItem,
  type FsBreadcrumb,
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

  // Space & File Explorer state
  const [activeSpace, setActiveSpace] = createSignal<'private' | 'shared'>('private');
  const [currentPath, setCurrentPath] = createSignal<string>('/');
  const [folderTree, setFolderTree] = createSignal<string[]>(['/']);
  const [entries, setEntries] = createSignal<VfsFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string>('就绪');
  const [uploadProgress, setUploadProgress] = createSignal<number | null>(null);

  // Collapsible Directory Tree state — using immutable string[] so SolidJS tracks every toggle & tree update
  const [collapsedPaths, setCollapsedPaths] = createSignal<string[]>([]);
  const [showSpaceSection, setShowSpaceSection] = createSignal(true);
  const [showTreeSection, setShowTreeSection] = createSignal(true);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

  // Adjustable widths: Left Sidebar + Multi-Column File List ("name", "size", "hash", "mtime")
  const [sidebarWidth, setSidebarWidth] = createSignal<number>(
    Number(localStorage.getItem('mayadesk_sidebar_width')) || 240
  );
  const [colWidths, setColWidths] = createSignal<{
    name: number;
    size: number;
    hash: number;
    mtime: number;
  }>({
    name: Number(localStorage.getItem('mayadesk_col_name')) || Number(localStorage.getItem('mayadesk_name_col_width')) || 340,
    size: Number(localStorage.getItem('mayadesk_col_size')) || 105,
    hash: Number(localStorage.getItem('mayadesk_col_hash')) || 150,
    mtime: Number(localStorage.getItem('mayadesk_col_mtime')) || 150,
  });

  // Storage Disks & Fresh Deployment Initialization state
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

  // Physical Path Manager State (Admin only, starts from root '/')
  const [showFsExplorerModal, setShowFsExplorerModal] = createSignal(false);
  const [fsCurrentPath, setFsCurrentPath] = createSignal('/');
  const [fsParentPath, setFsParentPath] = createSignal<string | null>(null);
  const [fsBreadcrumbs, setFsBreadcrumbs] = createSignal<FsBreadcrumb[]>([]);
  const [fsDirs, setFsDirs] = createSignal<FsDirectoryItem[]>([]);
  const [fsLoading, setFsLoading] = createSignal(false);
  const [fsError, setFsError] = createSignal<string | null>(null);
  const [fsInputPath, setFsInputPath] = createSignal('/');
  const [showFsMkdirInput, setShowFsMkdirInput] = createSignal(false);
  const [fsNewFolderName, setFsNewFolderName] = createSignal('');

  const openFsExplorer = async (initialPath?: string) => {
    setShowFsExplorerModal(true);
    setShowFsMkdirInput(false);
    setFsNewFolderName('');
    const startPath =
      initialPath && initialPath.trim().startsWith('/') ? initialPath.trim() : '/';
    await loadFsDirectory(startPath);
  };

  const loadFsDirectory = async (path: string) => {
    setFsLoading(true);
    setFsError(null);
    try {
      const res = await apiBrowseServerFs(path, token());
      setFsCurrentPath(res.current_path);
      setFsParentPath(res.parent_path);
      setFsBreadcrumbs(res.breadcrumbs);
      setFsDirs(res.directories);
      setFsInputPath(res.current_path);
    } catch (err: any) {
      setFsError(err?.message || '无法读取服务器目录');
    } finally {
      setFsLoading(false);
    }
  };

  const handleFsSelectPath = (selectedPath: string) => {
    setInitMountPath(selectedPath);
    setShowFsExplorerModal(false);
    setShowInitDiskModal(true);
    setStatusMessage(`已选取服务器物理路径: ${selectedPath}`);
  };

  const handleFsCreateSubdir = async () => {
    const name = fsNewFolderName().trim();
    if (!name) return;
    try {
      const res = await apiCreateServerFsDir(fsCurrentPath(), name, token());
      setShowFsMkdirInput(false);
      setFsNewFolderName('');
      await loadFsDirectory(res.path);
      setStatusMessage(`已创建服务器目录: ${res.path}`);
    } catch (err: any) {
      setFsError(err?.message || '创建目录失败');
    }
  };

  // File Preview State (Code, PDF, Image, Video, Audio)
  const [previewItem, setPreviewItem] = createSignal<VfsFileEntry | null>(null);
  const [previewCategory, setPreviewCategory] = createSignal<'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | 'other'>('other');
  const [previewContent, setPreviewContent] = createSignal<string>('');
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewWrap, setPreviewWrap] = createSignal(true);
  const [copySuccess, setCopySuccess] = createSignal(false);

  // Remote Archive Extraction State
  const [extractItem, setExtractItem] = createSignal<VfsFileEntry | null>(null);
  const [extractDestOption, setExtractDestOption] = createSignal<'folder' | 'current' | 'custom'>('folder');
  const [extractCustomPath, setExtractCustomPath] = createSignal('');
  const [extractLoading, setExtractLoading] = createSignal(false);

  const openPreview = async (item: VfsFileEntry) => {
    if (item.is_dir) return;
    const cat = getFileCategory(item.name);
    setPreviewItem(item);
    setPreviewCategory(cat);
    setPreviewContent('');
    setCopySuccess(false);

    if (cat === 'code') {
      setPreviewLoading(true);
      try {
        const url = getPreviewUrl(activeSpace(), item.rel_path, token());
        const res = await fetch(url);
        if (!res.ok) throw new Error('无法读取文件内容');
        const text = await res.text();
        setPreviewContent(text);
      } catch (err: any) {
        setPreviewContent(`读取文件失败: ${err?.message || '网络错误'}`);
      } finally {
        setPreviewLoading(false);
      }
    }
  };

  const closePreview = () => {
    setPreviewItem(null);
    setPreviewContent('');
  };

  const copyCodeContent = async () => {
    if (!previewContent()) return;
    try {
      await navigator.clipboard.writeText(previewContent());
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      // fallback
    }
  };

  const openExtractModal = (item: VfsFileEntry) => {
    setExtractItem(item);
    setExtractDestOption('folder');
    const baseName = item.name.replace(/\.(tar\.gz|tgz|zip|tar|gz)$/i, '');
    const parentDir = currentPath() === '/' ? '' : currentPath();
    setExtractCustomPath(`${parentDir}/${baseName}`);
  };

  const handleExecuteExtract = async () => {
    const item = extractItem();
    if (!item) return;

    let targetDest = currentPath();
    if (extractDestOption() === 'folder') {
      const baseName = item.name.replace(/\.(tar\.gz|tgz|zip|tar|gz)$/i, '');
      const parentDir = currentPath() === '/' ? '' : currentPath();
      targetDest = `${parentDir}/${baseName}`;
    } else if (extractDestOption() === 'custom') {
      targetDest = extractCustomPath().trim() || currentPath();
    }

    setExtractLoading(true);
    try {
      const res = await apiExtractArchive(activeSpace(), item.rel_path, targetDest, token());
      setExtractItem(null);
      setStatusMessage(`解压成功！共提取 ${res.file_count} 个文件 (${formatBytes(res.extracted_bytes)}) 至 ${res.dest_path}`);
      expandAncestorsOf(res.dest_path || targetDest);
      await refreshDirectory();
      await refreshFolderTree();
      await refreshUserProfile();
    } catch (err: any) {
      setStatusMessage(`解压失败: ${err?.message || '操作错误'}`);
    } finally {
      setExtractLoading(false);
    }
  };

  const isAdmin = () => user()?.role === 'admin';

  const refreshUserProfile = async () => {
    if (!token()) return;
    try {
      const profile = await apiGetUserProfile(token());
      setUser(profile);
    } catch {
      // Offline
    }
  };

  const refreshDisks = async () => {
    try {
      const list = await apiListDisks(token());
      setDisks(list);
      if (list.length === 0 && isAdmin()) {
        setShowInitDiskModal(true);
      }
    } catch {
      // Offline
    }
  };

  const refreshFolderTree = async () => {
    try {
      const paths = await apiListFolderPaths(activeSpace(), token());
      const normalized = Array.from(new Set(['/', ...(paths || [])])).sort();
      setFolderTree(normalized);
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

  // Reactive Tree Helpers (Fixes expand/collapse update bugs including root '/' and child folder updates)
  const isPathCollapsed = (path: string): boolean => collapsedPaths().includes(path);

  const toggleCollapsePath = (path: string) => {
    setCollapsedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const expandAncestorsOf = (path: string) => {
    if (!path) return;
    const toExpand = new Set<string>(['/']);
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      toExpand.add(cur);
    }
    setCollapsedPaths((prev) => prev.filter((p) => !toExpand.has(p)));
  };

  const hasChildDirs = (path: string): boolean => {
    const prefix = path === '/' ? '/' : path + '/';
    return folderTree().some((p) => p !== path && p.startsWith(prefix));
  };

  const visibleFolderTree = () => {
    const collapsed = collapsedPaths();
    const allPaths = folderTree();
    return allPaths.filter((path) => {
      if (path === '/') return true;
      if (collapsed.includes('/')) return false;
      const parts = path.split('/').filter(Boolean);
      let cur = '';
      for (let i = 0; i < parts.length - 1; i++) {
        cur += '/' + parts[i];
        if (collapsed.includes(cur)) {
          return false;
        }
      }
      return true;
    });
  };

  // Draggable Left Sidebar Resizer
  const startResizeSidebar = (e: MouseEvent) => {
    e.preventDefault();
    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(160, Math.min(540, moveEvent.clientX));
      setSidebarWidth(newWidth);
      localStorage.setItem('mayadesk_sidebar_width', String(newWidth));
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Multi-Column File List Resizer ("name" | "size" | "hash" | "mtime")
  const startResizeCol = (
    colKey: 'name' | 'size' | 'hash' | 'mtime',
    minW: number,
    maxW: number,
    e: MouseEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths()[colKey];
    const onMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      const newW = Math.max(minW, Math.min(maxW, startW + diff));
      setColWidths((prev) => ({ ...prev, [colKey]: newW }));
      localStorage.setItem(`mayadesk_col_${colKey}`, String(newW));
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const resetColWidth = (colKey: 'name' | 'size' | 'hash' | 'mtime', defaultW: number) => {
    setColWidths((prev) => ({ ...prev, [colKey]: defaultW }));
    localStorage.setItem(`mayadesk_col_${colKey}`, String(defaultW));
  };

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
      expandAncestorsOf(currentPath());
      await refreshDirectory();
      await refreshFolderTree();
    } catch (err: any) {
      setStatusMessage(`创建失败: ${err?.message}`);
    }
  };

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
      setStatusMessage('文件上传完成');
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
      setStatusMessage('文件夹上传完成');
      input.value = '';
      expandAncestorsOf(currentPath());
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
    const typeLabel = entry.is_dir ? '文件夹（含其所有子文件）' : '文件';
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
    setCollapsedPaths([]);
    setMobileMenuOpen(false);
  };

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
    <div class="min-h-screen flex flex-col bg-white text-black text-sm select-text">
      {/* Top Header Bar — Clean Minimalist Flat Style */}
      <header class="border-b border-black px-3 py-2 md:px-4 md:h-12 flex flex-wrap items-center justify-between gap-2 bg-white">
        <div class="flex items-center gap-2 md:gap-4">
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            class="md:hidden px-2 py-1 border border-black bg-sky-100 text-black text-xs font-bold cursor-pointer"
          >
            {mobileMenuOpen() ? '关闭目录' : '目录导航'}
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
            title="点击切换 P2P 直连 / 服务器中继模式"
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
              >
                退出
              </button>
            </div>
          </Show>
        </div>
      </header>

      {/* Deployment Banner for Admin when no storage pool is configured */}
      <Show when={disks().length === 0 && isAdmin()}>
        <div class="bg-amber-100 border-b border-black p-3 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <span class="font-bold">[提示] 存储空间尚未初始化：</span>
            <span>当前系统尚未挂载任何物理存储盘，文件服务暂不可用。</span>
          </div>
          <button
            onClick={() => setShowInitDiskModal(true)}
            class="px-3 py-1 border border-black bg-amber-300 hover:bg-amber-400 font-bold cursor-pointer shrink-0"
          >
            立即配置初始存储盘
          </button>
        </div>
      </Show>

      {/* Main Workspace (Left Path & Space Tree, Right Content) */}
      <div class="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Left Sidebar — Resizable & Collapsible */}
        <Show
          when={!sidebarCollapsed()}
          fallback={
            /* Collapsed Slim Strip */
            <div class="hidden md:flex flex-col items-center py-3 border-r border-black bg-sky-50 w-8 shrink-0">
              <button
                onClick={() => setSidebarCollapsed(false)}
                title="展开左侧栏"
                class="px-1 py-2 text-neutral-700 hover:text-black text-xs font-bold cursor-pointer"
              >
                »
              </button>
            </div>
          }
        >
          <aside
            style={{ width: `${sidebarWidth()}px` }}
            class={`${
              mobileMenuOpen() ? 'flex' : 'hidden'
            } md:flex border-r border-black bg-white flex-col justify-between p-3 shrink-0 overflow-y-auto min-w-[160px] max-w-[540px]`}
          >
            <div class="space-y-5">
              {/* Section 1: Space Categorization — Clean Boxless Dropdown */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowSpaceSection((v) => !v)}
                  class="w-full flex items-center justify-between text-[11px] font-bold uppercase tracking-wider pb-1.5 border-b border-black cursor-pointer hover:text-sky-700 select-none"
                >
                  <span class="flex items-center gap-1.5">
                    <span class="inline-block w-3 text-left text-neutral-500 text-xs">
                      {showSpaceSection() ? '▾' : '▸'}
                    </span>
                    <span>空间分类</span>
                  </span>
                </button>
                <Show when={showSpaceSection()}>
                  <div class="mt-1.5 flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => selectSpace('private')}
                      class={`w-full px-2.5 py-1.5 text-left cursor-pointer flex items-center justify-between transition-colors ${
                        activeSpace() === 'private' && activeView() === 'files'
                          ? 'bg-sky-100 text-black font-bold border-l-2 border-black'
                          : 'bg-white text-neutral-700 hover:bg-sky-50'
                      }`}
                    >
                      <span class="text-xs">私人空间</span>
                      <span class="text-[10px] text-neutral-500">个人隔离</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => selectSpace('shared')}
                      class={`w-full px-2.5 py-1.5 text-left cursor-pointer flex items-center justify-between transition-colors ${
                        activeSpace() === 'shared' && activeView() === 'files'
                          ? 'bg-sky-100 text-black font-bold border-l-2 border-black'
                          : 'bg-white text-neutral-700 hover:bg-sky-50'
                      }`}
                    >
                      <span class="text-xs">共享空间</span>
                      <span class="text-[10px] text-neutral-500">团队共享</span>
                    </button>
                  </div>
                </Show>
              </div>

              {/* Section 2: Boxless Minimalist Directory Tree (Fixes reactive update bug + clean borderless rows) */}
              <div>
                <div class="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider pb-1.5 border-b border-black select-none">
                  <button
                    type="button"
                    onClick={() => setShowTreeSection((v) => !v)}
                    class="flex items-center gap-1.5 cursor-pointer hover:text-sky-700"
                  >
                    <span class="inline-block w-3 text-left text-neutral-500 text-xs">
                      {showTreeSection() ? '▾' : '▸'}
                    </span>
                    <span>路径目录树</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => refreshFolderTree()}
                    title="刷新目录树"
                    class="text-[10px] font-mono text-neutral-500 hover:text-black cursor-pointer"
                  >
                    {activeSpace() === 'private' ? '私人' : '共享'} ↻
                  </button>
                </div>

                <Show when={showTreeSection()}>
                  <div class="mt-1.5 flex flex-col gap-0.5 text-xs select-none">
                    <For each={visibleFolderTree()}>
                      {(dirPath) => {
                        const depth =
                          dirPath === '/' ? 0 : dirPath.split('/').filter(Boolean).length;
                        const folderName =
                          dirPath === '/' ? '根目录 /' : dirPath.split('/').pop();
                        const isSelected = () =>
                          currentPath() === dirPath && activeView() === 'files';

                        return (
                          <div
                            style={{ 'padding-left': `${depth * 14 + 4}px` }}
                            class={`group flex items-center w-full py-1 pr-2 transition-colors ${
                              isSelected()
                                ? 'bg-sky-100 text-black font-semibold border-l-2 border-black'
                                : 'text-neutral-700 hover:bg-sky-50 hover:text-black'
                            }`}
                          >
                            <Show
                              when={hasChildDirs(dirPath)}
                              fallback={
                                <span class="inline-block w-4 text-center text-neutral-300 text-xs shrink-0">
                                  ·
                                </span>
                              }
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleCollapsePath(dirPath);
                                }}
                                title={isPathCollapsed(dirPath) ? '展开子目录' : '折叠子目录'}
                                class="w-4 h-4 flex items-center justify-center text-neutral-500 hover:text-black text-xs shrink-0 cursor-pointer"
                              >
                                {isPathCollapsed(dirPath) ? '▸' : '▾'}
                              </button>
                            </Show>

                            <button
                              type="button"
                              onClick={() => {
                                setActiveView('files');
                                setCurrentPath(dirPath);
                                expandAncestorsOf(dirPath);
                                setMobileMenuOpen(false);
                              }}
                              class="flex-1 text-left pl-1 truncate cursor-pointer"
                            >
                              <span class="truncate">{folderName}</span>
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            {/* Bottom Card: Quota Indicator & Collapse Sidebar Toggle */}
            <div class="border-t border-black pt-3 space-y-2 mt-4">
              <div class="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider">
                <span>存储配额</span>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  class="hidden md:inline-block text-[11px] text-neutral-500 hover:text-black font-normal cursor-pointer"
                  title="收起左侧栏"
                >
                  « 收起
                </button>
              </div>

              <div class="border border-black p-2 bg-sky-50/50 space-y-1.5 text-xs font-mono">
                <div class="flex justify-between items-center text-[11px]">
                  <span>已用:</span>
                  <span class="font-bold">{formatBytes(user()?.used_bytes || 0)}</span>
                </div>
                <div class="flex justify-between items-center text-[11px]">
                  <span>配额:</span>
                  <span>
                    {isAdmin()
                      ? '无限 (管理员)'
                      : user()?.quota_bytes && user()!.quota_bytes! > 0
                      ? formatBytes(user()!.quota_bytes!)
                      : '0 B (需管理员授权)'}
                  </span>
                </div>
                <div class="w-full h-1.5 border border-black bg-white overflow-hidden">
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
            </div>
          </aside>
        </Show>

        {/* Draggable Divider between Left Sidebar and Right Main Area */}
        <Show when={!sidebarCollapsed()}>
          <div
            onMouseDown={startResizeSidebar}
            onDblClick={() => setSidebarWidth(240)}
            class="hidden md:block w-1 hover:w-1.5 bg-neutral-200 hover:bg-sky-400 cursor-col-resize shrink-0 transition-colors select-none"
            title="拖拽调整左侧栏宽度，双击恢复默认"
          />
        </Show>

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
                  上级
                </button>
                <span class="font-semibold px-2 py-0.5 border border-black bg-white">
                  {activeSpace() === 'private' ? '私人空间' : '共享空间'}
                </span>
                <span class="px-2 py-0.5 bg-sky-100 border border-black font-mono truncate max-w-[200px] sm:max-w-xs">
                  {currentPath()}
                </span>
              </div>

              {/* Upload Files, Upload Folder, Create Folder */}
              <div class="flex flex-wrap items-center gap-1.5 text-xs">
                <button
                  onClick={handleCreateFolder}
                  class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 font-medium cursor-pointer"
                >
                  新建文件夹
                </button>

                <label class="px-2.5 py-1 border border-black bg-sky-200 hover:bg-sky-300 font-semibold cursor-pointer">
                  上传文件
                  <input type="file" multiple onChange={handleFileUpload} class="hidden" />
                </label>

                <label class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 font-semibold cursor-pointer">
                  上传文件夹
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
                  onClick={() => {
                    refreshDirectory();
                    refreshFolderTree();
                  }}
                  class="px-2 py-1 border border-black bg-white hover:bg-sky-100 cursor-pointer shrink-0"
                >
                  刷新
                </button>
              </div>
            </div>

            {/* Upload progress bar */}
            <Show when={uploadProgress() !== null}>
              <div class="border-b border-black bg-sky-100 px-4 py-1.5 text-xs flex items-center justify-between">
                <span>{statusMessage()}</span>
                <span class="font-mono font-bold">{uploadProgress()}%</span>
              </div>
            </Show>

            {/* Flat File List with Multi-Column Resizable Widths */}
            <div class="flex-1 p-3 sm:p-6 overflow-x-auto">
              <div class="border border-black min-w-[620px]">
                {/* Desktop Resizable Table Header (All data columns adjustable + double-click reset) */}
                <div class="hidden sm:flex border-b border-black bg-sky-100 text-xs font-bold items-center select-none">
                  {/* Resizable Column 1: Name */}
                  <div
                    style={{ width: `${colWidths().name}px` }}
                    class="relative py-2 px-3 shrink-0 flex items-center justify-between border-r border-black"
                  >
                    <span>名称</span>
                    <div
                      onMouseDown={(e) => startResizeCol('name', 160, 900, e)}
                      onDblClick={() => resetColWidth('name', 340)}
                      class="absolute -right-1 top-0 bottom-0 w-2.5 hover:bg-sky-400 cursor-col-resize z-10"
                      title="左右拖拽调整「名称」列宽，双击恢复默认"
                    />
                  </div>

                  {/* Resizable Column 2: Size */}
                  <div
                    style={{ width: `${colWidths().size}px` }}
                    class="relative py-2 px-2.5 shrink-0 flex items-center justify-between font-mono border-r border-black"
                  >
                    <span>大小</span>
                    <div
                      onMouseDown={(e) => startResizeCol('size', 72, 260, e)}
                      onDblClick={() => resetColWidth('size', 105)}
                      class="absolute -right-1 top-0 bottom-0 w-2.5 hover:bg-sky-400 cursor-col-resize z-10"
                      title="左右拖拽调整「大小」列宽，双击恢复默认"
                    />
                  </div>

                  {/* Resizable Column 3: BLAKE3 Hash */}
                  <div
                    style={{ width: `${colWidths().hash}px` }}
                    class="relative py-2 px-2.5 shrink-0 flex items-center justify-between font-mono border-r border-black"
                  >
                    <span>BLAKE3 校验</span>
                    <div
                      onMouseDown={(e) => startResizeCol('hash', 90, 320, e)}
                      onDblClick={() => resetColWidth('hash', 150)}
                      class="absolute -right-1 top-0 bottom-0 w-2.5 hover:bg-sky-400 cursor-col-resize z-10"
                      title="左右拖拽调整「BLAKE3 校验」列宽，双击恢复默认"
                    />
                  </div>

                  {/* Resizable Column 4: Modified Time */}
                  <div
                    style={{ width: `${colWidths().mtime}px` }}
                    class="relative py-2 px-2.5 shrink-0 flex items-center justify-between font-mono border-r border-black"
                  >
                    <span>修改时间</span>
                    <div
                      onMouseDown={(e) => startResizeCol('mtime', 110, 300, e)}
                      onDblClick={() => resetColWidth('mtime', 150)}
                      class="absolute -right-1 top-0 bottom-0 w-2.5 hover:bg-sky-400 cursor-col-resize z-10"
                      title="左右拖拽调整「修改时间」列宽，双击恢复默认"
                    />
                  </div>

                  {/* Flexible Column 5: Actions */}
                  <div class="flex-1 py-2 px-3 text-right min-w-[130px]">操作</div>
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
                        : '当前目录为空，可点击上方「新建文件夹」、「上传文件」或「上传文件夹」。'}
                    </div>
                  }
                >
                  <For each={entries()}>
                    {(item) => (
                      <div class="px-3 sm:px-0 py-2 sm:py-0 border-b border-black last:border-b-0 hover:bg-sky-50 text-xs flex flex-col sm:flex-row sm:items-stretch">
                        {/* Resizable Name Column */}
                        <div
                          style={{ width: `${colWidths().name}px` }}
                          class="sm:shrink-0 sm:py-2 sm:px-3 sm:border-r sm:border-neutral-200 flex items-center justify-between sm:justify-start gap-2 min-w-0"
                        >
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="font-mono text-[10px] px-1 border border-black bg-white shrink-0 font-semibold">
                              {item.is_dir ? 'DIR' : (() => {
                                const cat = getFileCategory(item.name);
                                switch (cat) {
                                  case 'image': return 'IMG';
                                  case 'video': return 'VID';
                                  case 'audio': return 'AUD';
                                  case 'pdf': return 'PDF';
                                  case 'code': return 'CODE';
                                  case 'archive': return 'ZIP';
                                  default: return 'FILE';
                                }
                              })()}
                            </span>
                            <Show
                              when={item.is_dir}
                              fallback={
                                getFileCategory(item.name) !== 'archive' && getFileCategory(item.name) !== 'other' ? (
                                  <button
                                    onClick={() => openPreview(item)}
                                    class="text-left hover:underline hover:text-sky-800 cursor-pointer font-medium truncate"
                                    title="点击在线预览"
                                  >
                                    {item.name}
                                  </button>
                                ) : (
                                  <span class="font-medium truncate">{item.name}</span>
                                )
                              }
                            >
                              <button
                                onClick={() => {
                                  setCurrentPath(item.rel_path);
                                  expandAncestorsOf(item.rel_path);
                                }}
                                class="text-left underline hover:bg-sky-100 cursor-pointer font-semibold truncate"
                              >
                                {item.name}
                              </button>
                            </Show>
                          </div>

                          {/* Mobile Action Buttons */}
                          <div class="flex sm:hidden items-center gap-1.5 shrink-0">
                            <Show when={!item.is_dir && getFileCategory(item.name) !== 'archive' && getFileCategory(item.name) !== 'other'}>
                              <button
                                onClick={() => openPreview(item)}
                                class="px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-[11px] cursor-pointer"
                              >
                                预览
                              </button>
                            </Show>
                            <Show when={!item.is_dir && getFileCategory(item.name) === 'archive'}>
                              <button
                                onClick={() => openExtractModal(item)}
                                class="px-2 py-0.5 border border-black bg-sky-200 hover:bg-sky-300 font-bold text-[11px] cursor-pointer"
                              >
                                解压
                              </button>
                            </Show>
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
                        <div class="flex sm:hidden items-center gap-3 text-[11px] font-mono text-neutral-600 my-1">
                          <span>{item.is_dir ? '文件夹' : formatBytes(item.size_bytes)}</span>
                          <Show when={item.blake3_short}>
                            <span>BLAKE3:{item.blake3_short}</span>
                          </Show>
                          <span>{formatTime(item.modified_unix)}</span>
                        </div>

                        {/* Desktop Resizable Columns */}
                        <div
                          style={{ width: `${colWidths().size}px` }}
                          class="hidden sm:flex items-center shrink-0 font-mono py-2 px-2.5 border-r border-neutral-200 truncate"
                        >
                          {item.is_dir ? '-' : formatBytes(item.size_bytes)}
                        </div>
                        <div
                          style={{ width: `${colWidths().hash}px` }}
                          class="hidden sm:flex items-center shrink-0 font-mono text-[11px] text-neutral-600 py-2 px-2.5 border-r border-neutral-200 truncate"
                        >
                          {item.blake3_short || '-'}
                        </div>
                        <div
                          style={{ width: `${colWidths().mtime}px` }}
                          class="hidden sm:flex items-center shrink-0 font-mono text-[11px] py-2 px-2.5 border-r border-neutral-200 truncate"
                        >
                          {formatTime(item.modified_unix)}
                        </div>
                        <div class="hidden sm:flex flex-1 items-center justify-end gap-1.5 py-2 px-3 min-w-[130px]">
                          {/* Online Preview Button */}
                          <Show when={!item.is_dir && getFileCategory(item.name) !== 'archive' && getFileCategory(item.name) !== 'other'}>
                            <button
                              onClick={() => openPreview(item)}
                              class="px-1.5 py-0.5 border border-black bg-white hover:bg-sky-100 text-[11px] cursor-pointer shrink-0"
                              title="在线预览"
                            >
                              预览
                            </button>
                          </Show>

                          {/* Remote Extract Button */}
                          <Show when={!item.is_dir && getFileCategory(item.name) === 'archive'}>
                            <button
                              onClick={() => openExtractModal(item)}
                              class="px-1.5 py-0.5 border border-black bg-sky-200 hover:bg-sky-300 font-bold text-[11px] cursor-pointer shrink-0"
                              title="远程解压压缩包"
                            >
                              解压
                            </button>
                          </Show>

                          {/* Directory downloads as ZIP, File downloads directly */}
                          <a
                            href={getDownloadUrl(activeSpace(), item.rel_path)}
                            target="_blank"
                            class="px-1.5 py-0.5 border border-black bg-sky-100 hover:bg-sky-200 text-[11px] shrink-0"
                            title={item.is_dir ? '打包下载整个文件夹为 ZIP 压缩包' : '下载文件'}
                          >
                            {item.is_dir ? '下载(ZIP)' : '下载'}
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

          {/* View 2: User Quota Management (Admin Only) */}
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

          {/* View 3: Transfer Logs */}
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

              {/* Storage Pools List */}
              <section class="border border-black p-3 space-y-3">
                <div class="flex items-center justify-between bg-sky-100 px-2 py-1 border-b border-black text-xs font-bold">
                  <span>NAS 物理硬盘挂载池</span>
                  <div class="flex items-center gap-2">
                    <button
                      onClick={() => openFsExplorer()}
                      class="px-2 py-0.5 border border-black bg-white hover:bg-sky-200 text-xs font-normal cursor-pointer"
                    >
                      物理路径管理器
                    </button>
                    <button
                      onClick={() => setShowInitDiskModal(true)}
                      class="px-2 py-0.5 border border-black bg-white hover:bg-sky-200 text-xs font-normal cursor-pointer"
                    >
                      + 添加新存储盘
                    </button>
                  </div>
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
              {activeSpace() === 'private' ? '私人空间' : '共享空间'} · 通道: {transportChannel()}
            </div>
          </footer>
        </main>
      </div>

      {/* Initial Disk Setup Modal */}
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
                <div class="flex items-center justify-between">
                  <span class="font-medium">存储盘物理路径 (必填)</span>
                  <button
                    type="button"
                    onClick={() => openFsExplorer(initMountPath())}
                    class="px-2 py-0.5 border border-black bg-sky-100 hover:bg-sky-200 text-[11px] font-semibold cursor-pointer"
                  >
                    从根目录 (/) 浏览服务器路径...
                  </button>
                </div>
                <div class="flex gap-1.5">
                  <input
                    type="text"
                    required
                    placeholder="例如：/data/storage 或 /mnt/nas_disk"
                    value={initMountPath()}
                    onInput={(e) => setInitMountPath(e.currentTarget.value)}
                    class="flex-1 px-2.5 py-1.5 border border-black font-mono bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => openFsExplorer(initMountPath())}
                    class="px-2.5 py-1.5 border border-black bg-sky-50 hover:bg-sky-100 text-xs font-semibold cursor-pointer shrink-0"
                  >
                    浏览选择
                  </button>
                </div>
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

      {/* Physical Path Manager Modal (Starts from root '/') */}
      <Show when={showFsExplorerModal()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center p-3 sm:p-6 z-[60]">
          <div class="w-full max-w-3xl border-2 border-black bg-white p-4 sm:p-5 flex flex-col max-h-[90vh] space-y-3 shadow-2xl">
            {/* Header */}
            <div class="flex items-center justify-between border-b border-black pb-2">
              <div>
                <h3 class="font-bold text-sm">服务器物理路径管理器 (根目录 /)</h3>
                <p class="text-[11px] text-neutral-600">
                  浏览服务器物理磁盘目录结构，可创建子目录并一键选择作为存储挂载路径。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFsExplorerModal(false)}
                class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer font-medium"
              >
                关闭
              </button>
            </div>

            {/* Path Jump & Actions Bar */}
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <div class="flex flex-1 min-w-[240px] items-center border border-black bg-neutral-50 px-2 py-1">
                <span class="text-neutral-500 font-mono mr-1.5 shrink-0">路径:</span>
                <input
                  type="text"
                  value={fsInputPath()}
                  onInput={(e) => setFsInputPath(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      loadFsDirectory(fsInputPath());
                    }
                  }}
                  class="flex-1 bg-transparent font-mono text-xs focus:outline-none"
                  placeholder="/"
                />
                <button
                  type="button"
                  onClick={() => loadFsDirectory(fsInputPath())}
                  class="ml-1 px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-[11px] cursor-pointer"
                >
                  跳转
                </button>
              </div>

              <button
                type="button"
                disabled={!fsParentPath() || fsCurrentPath() === '/'}
                onClick={() => fsParentPath() && loadFsDirectory(fsParentPath()!)}
                class={`px-2.5 py-1 border border-black text-xs cursor-pointer ${
                  !fsParentPath() || fsCurrentPath() === '/'
                    ? 'bg-neutral-100 text-neutral-400 border-neutral-300 cursor-not-allowed'
                    : 'bg-white hover:bg-sky-100'
                }`}
              >
                上级目录
              </button>

              <button
                type="button"
                onClick={() => loadFsDirectory(fsCurrentPath())}
                class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
              >
                刷新
              </button>

              <button
                type="button"
                onClick={() => setShowFsMkdirInput(!showFsMkdirInput())}
                class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
              >
                {showFsMkdirInput() ? '取消新建' : '+ 新建子目录'}
              </button>
            </div>

            {/* Breadcrumb Navigation Bar */}
            <div class="flex items-center gap-1 overflow-x-auto text-xs py-1.5 border-y border-neutral-200 bg-sky-50 px-2 font-mono">
              <span class="text-neutral-500 font-sans text-[11px] shrink-0">位置:</span>
              <For each={fsBreadcrumbs()}>
                {(crumb, idx) => (
                  <div class="flex items-center shrink-0">
                    <button
                      type="button"
                      onClick={() => loadFsDirectory(crumb.path)}
                      class={`px-1.5 py-0.5 hover:bg-sky-200 cursor-pointer ${
                        crumb.path === fsCurrentPath()
                          ? 'font-bold bg-sky-200 underline'
                          : 'text-neutral-800'
                      }`}
                    >
                      {crumb.name}
                    </button>
                    <Show when={idx() < fsBreadcrumbs().length - 1}>
                      <span class="text-neutral-400 mx-0.5">/</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            {/* Inline Subdir Creation Bar */}
            <Show when={showFsMkdirInput()}>
              <div class="p-2 border border-black bg-sky-100 flex items-center gap-2 text-xs">
                <span class="font-medium shrink-0">在当前路径下新建目录:</span>
                <input
                  type="text"
                  placeholder="输入子目录名称 (如: nas_storage)"
                  value={fsNewFolderName()}
                  onInput={(e) => setFsNewFolderName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleFsCreateSubdir();
                    }
                  }}
                  class="flex-1 px-2 py-1 border border-black bg-white font-mono"
                  autofocus
                />
                <button
                  type="button"
                  onClick={handleFsCreateSubdir}
                  class="px-3 py-1 border border-black bg-sky-200 hover:bg-sky-300 font-bold cursor-pointer shrink-0"
                >
                  创建并进入
                </button>
                <button
                  type="button"
                  onClick={() => setShowFsMkdirInput(false)}
                  class="px-2 py-1 border border-black bg-white hover:bg-neutral-100 cursor-pointer shrink-0"
                >
                  取消
                </button>
              </div>
            </Show>

            {/* Error Message if any */}
            <Show when={fsError()}>
              <div class="p-2 border border-red-500 bg-red-50 text-red-700 text-xs font-mono">
                错误: {fsError()}
              </div>
            </Show>

            {/* Directory List Container */}
            <div class="flex-1 overflow-y-auto border border-black bg-white min-h-[220px] max-h-[360px]">
              <Show
                when={!fsLoading()}
                fallback={<div class="p-8 text-center text-xs text-neutral-500 font-mono">正在读取服务器物理目录...</div>}
              >
                <Show
                  when={fsDirs().length > 0}
                  fallback={
                    <div class="p-8 text-center text-xs text-neutral-500 space-y-2">
                      <p>当前目录下没有子目录。</p>
                      <p class="text-[11px] text-neutral-400">
                        您可以点击上方 [+ 新建子目录] 在此创建，或直接点击下方按钮选取当前目录作为存储盘。
                      </p>
                    </div>
                  }
                >
                  <table class="w-full text-left text-xs border-collapse">
                    <thead class="sticky top-0 bg-neutral-100 border-b border-black font-semibold text-[11px]">
                      <tr>
                        <th class="py-1.5 px-3">子目录名称</th>
                        <th class="py-1.5 px-3">完整路径</th>
                        <th class="py-1.5 px-3 w-20">访问权限</th>
                        <th class="py-1.5 px-3 w-36 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-neutral-200 font-mono">
                      <For each={fsDirs()}>
                        {(dir) => (
                          <tr class="hover:bg-sky-50 transition-colors">
                            <td class="py-1.5 px-3 font-semibold text-black">
                              <button
                                type="button"
                                onClick={() => loadFsDirectory(dir.path)}
                                class="text-left hover:underline cursor-pointer flex items-center gap-1.5"
                              >
                                <span class="text-neutral-500 font-normal">[目录]</span>
                                <span class="font-bold">{dir.name}</span>
                              </button>
                            </td>
                            <td class="py-1.5 px-3 text-neutral-600 truncate max-w-[240px]">
                              {dir.path}
                            </td>
                            <td class="py-1.5 px-3 text-[11px]">
                              <span
                                class={`px-1.5 py-0.5 border ${
                                  dir.is_readable
                                    ? 'border-neutral-300 bg-neutral-100 text-neutral-700'
                                    : 'border-red-300 bg-red-50 text-red-600'
                                }`}
                              >
                                {dir.is_readable ? '可读' : '受限'}
                              </span>
                            </td>
                            <td class="py-1.5 px-3 text-right space-x-1 font-sans">
                              <button
                                type="button"
                                onClick={() => loadFsDirectory(dir.path)}
                                class="px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-[11px] cursor-pointer"
                              >
                                进入
                              </button>
                              <button
                                type="button"
                                onClick={() => handleFsSelectPath(dir.path)}
                                class="px-2 py-0.5 border border-black bg-sky-200 hover:bg-sky-300 font-semibold text-[11px] cursor-pointer"
                              >
                                选取
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Show>
            </div>

            {/* Footer with Select Current Path Action */}
            <div class="border-t border-black pt-3 flex flex-wrap items-center justify-between gap-3">
              <div class="text-xs">
                <span class="text-neutral-500">当前定位路径: </span>
                <span class="font-mono font-bold text-sky-800">{fsCurrentPath()}</span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowFsExplorerModal(false)}
                  class="px-3 py-1.5 border border-black bg-white hover:bg-neutral-100 text-xs cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => handleFsSelectPath(fsCurrentPath())}
                  class="px-4 py-1.5 border-2 border-black bg-sky-200 hover:bg-sky-300 font-bold text-xs cursor-pointer"
                >
                  选取此路径作为物理存储盘: {fsCurrentPath()}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* File Preview Modal (Code, PDF, Image, Video, Audio) */}
      <Show when={previewItem()}>
        <div class="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-6 z-[70]">
          <div class="w-full max-w-4xl border-2 border-black bg-white p-4 sm:p-5 flex flex-col max-h-[92vh] space-y-3 shadow-2xl">
            {/* Header */}
            <div class="flex items-center justify-between border-b border-black pb-2">
              <div class="flex items-center gap-2 min-w-0 pr-3">
                <span class="px-1.5 py-0.5 border border-black bg-sky-100 font-mono text-[11px] font-bold shrink-0">
                  {previewCategory().toUpperCase()}
                </span>
                <span class="font-bold text-sm truncate font-mono">{previewItem()!.name}</span>
                <span class="text-xs text-neutral-500 shrink-0 font-mono">
                  ({formatBytes(previewItem()!.size_bytes)})
                </span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <a
                  href={getDownloadUrl(activeSpace(), previewItem()!.rel_path)}
                  target="_blank"
                  class="px-2 py-1 border border-black bg-sky-50 hover:bg-sky-100 text-xs font-semibold cursor-pointer"
                >
                  下载
                </a>
                <a
                  href={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                  target="_blank"
                  class="px-2 py-1 border border-black bg-sky-50 hover:bg-sky-100 text-xs font-semibold cursor-pointer"
                >
                  新标签打开
                </a>
                <button
                  type="button"
                  onClick={closePreview}
                  class="px-2.5 py-1 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer font-bold ml-1"
                >
                  关闭
                </button>
              </div>
            </div>

            {/* Preview Body according to Category */}
            <div class="flex-1 overflow-auto flex flex-col items-center justify-center min-h-[250px]">
              {/* 1. Image Preview */}
              <Show when={previewCategory() === 'image'}>
                <div class="max-h-[75vh] w-full flex items-center justify-center p-2 bg-neutral-100 border border-neutral-300">
                  <img
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    alt={previewItem()!.name}
                    class="max-h-[70vh] max-w-full object-contain shadow-sm"
                  />
                </div>
              </Show>

              {/* 2. Video Preview */}
              <Show when={previewCategory() === 'video'}>
                <div class="w-full flex flex-col items-center justify-center bg-black border border-black p-1">
                  <video
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    controls
                    autoplay
                    class="max-h-[70vh] max-w-full"
                  />
                </div>
              </Show>

              {/* 3. Audio Preview */}
              <Show when={previewCategory() === 'audio'}>
                <div class="w-full max-w-lg p-6 border border-black bg-sky-50 text-center space-y-4 my-auto">
                  <div class="font-bold text-sm">{previewItem()!.name}</div>
                  <audio
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    controls
                    autoplay
                    class="w-full"
                  />
                </div>
              </Show>

              {/* 4. PDF Preview */}
              <Show when={previewCategory() === 'pdf'}>
                <div class="w-full h-[75vh] border border-black bg-neutral-50">
                  <iframe
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    class="w-full h-full border-0"
                    title={previewItem()!.name}
                  />
                </div>
              </Show>

              {/* 5. Code & Text Preview */}
              <Show when={previewCategory() === 'code'}>
                <div class="w-full flex-1 flex flex-col min-h-[350px] max-h-[75vh] border border-black bg-white">
                  {/* Code Toolbar */}
                  <div class="flex items-center justify-between px-3 py-1.5 bg-neutral-100 border-b border-black text-xs">
                    <span class="font-mono text-neutral-600">
                      {previewContent() ? `${previewContent().split('\n').length} 行` : '加载中...'}
                    </span>
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewWrap(!previewWrap())}
                        class="px-2 py-0.5 border border-black bg-white hover:bg-neutral-50 text-[11px] cursor-pointer"
                      >
                        {previewWrap() ? '不自动换行' : '自动换行'}
                      </button>
                      <button
                        type="button"
                        onClick={copyCodeContent}
                        class="px-2 py-0.5 border border-black bg-sky-100 hover:bg-sky-200 text-[11px] font-semibold cursor-pointer"
                      >
                        {copySuccess() ? '已复制！' : '复制全部'}
                      </button>
                    </div>
                  </div>

                  {/* Code Display with Line Numbers */}
                  <Show
                    when={!previewLoading()}
                    fallback={<div class="p-8 text-center text-xs text-neutral-500 font-mono">正在加载代码内容...</div>}
                  >
                    <div class="flex-1 overflow-auto flex font-mono text-xs bg-white">
                      {/* Line Numbers */}
                      <div class="select-none py-3 px-2 bg-neutral-50 text-neutral-400 text-right border-r border-neutral-200 shrink-0 font-mono leading-relaxed">
                        <For each={previewContent().split('\n')}>
                          {(_, idx) => <div>{idx() + 1}</div>}
                        </For>
                      </div>
                      {/* Code Content */}
                      <pre
                        class={`p-3 font-mono leading-relaxed text-black flex-1 focus:outline-none ${
                          previewWrap() ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-x-auto'
                        }`}
                      >
                        {previewContent()}
                      </pre>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Archive Extract Modal */}
      <Show when={extractItem()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[70]">
          <div class="w-full max-w-md border-2 border-black bg-white p-5 space-y-4 shadow-2xl">
            <div class="flex items-center justify-between border-b border-black pb-2">
              <h3 class="font-bold text-sm">远程解压压缩包</h3>
              <button
                type="button"
                onClick={() => setExtractItem(null)}
                class="px-2 py-0.5 border border-black bg-white hover:bg-sky-100 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div class="space-y-3 text-xs">
              <div class="p-2 border border-black bg-sky-50 font-mono">
                <span class="text-neutral-500 block text-[11px]">压缩包文件:</span>
                <span class="font-bold">{extractItem()!.name}</span>
                <span class="text-neutral-500 text-[11px] block mt-0.5">
                  大小: {formatBytes(extractItem()!.size_bytes)} | 路径: {extractItem()!.rel_path}
                </span>
              </div>

              <div class="space-y-2">
                <span class="font-semibold block">解压目标位置:</span>

                <label class="flex items-start gap-2 p-2 border border-black cursor-pointer hover:bg-sky-50">
                  <input
                    type="radio"
                    name="extract_option"
                    checked={extractDestOption() === 'folder'}
                    onChange={() => setExtractDestOption('folder')}
                    class="mt-0.5"
                  />
                  <div>
                    <span class="font-bold block">解压到同名子文件夹 (推荐)</span>
                    <span class="text-[11px] text-neutral-500 font-mono">
                      {currentPath() === '/' ? '' : currentPath()}/
                      {extractItem()!.name.replace(/\.(tar\.gz|tgz|zip|tar|gz)$/i, '')}/
                    </span>
                  </div>
                </label>

                <label class="flex items-start gap-2 p-2 border border-black cursor-pointer hover:bg-sky-50">
                  <input
                    type="radio"
                    name="extract_option"
                    checked={extractDestOption() === 'current'}
                    onChange={() => setExtractDestOption('current')}
                    class="mt-0.5"
                  />
                  <div>
                    <span class="font-bold block">解压到当前目录</span>
                    <span class="text-[11px] text-neutral-500 font-mono">{currentPath()}</span>
                  </div>
                </label>

                <label class="flex items-start gap-2 p-2 border border-black cursor-pointer hover:bg-sky-50">
                  <input
                    type="radio"
                    name="extract_option"
                    checked={extractDestOption() === 'custom'}
                    onChange={() => setExtractDestOption('custom')}
                    class="mt-0.5"
                  />
                  <div class="flex-1 min-w-0">
                    <span class="font-bold block">自定义解压路径:</span>
                    <input
                      type="text"
                      value={extractCustomPath()}
                      onInput={(e) => {
                        setExtractCustomPath(e.currentTarget.value);
                        setExtractDestOption('custom');
                      }}
                      class="w-full px-2 py-1 border border-black font-mono text-xs bg-white mt-1"
                    />
                  </div>
                </label>
              </div>

              <div class="flex items-center justify-end gap-2 pt-2 border-t border-neutral-200">
                <button
                  type="button"
                  onClick={() => setExtractItem(null)}
                  class="px-3 py-1.5 border border-black bg-white hover:bg-neutral-100 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={extractLoading()}
                  onClick={handleExecuteExtract}
                  class="px-4 py-1.5 border-2 border-black bg-sky-200 hover:bg-sky-300 font-bold cursor-pointer disabled:opacity-50"
                >
                  {extractLoading() ? '正在解压中...' : '开始解压'}
                </button>
              </div>
            </div>
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
