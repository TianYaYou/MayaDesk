import { createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
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
  getServerEndpointUrl,
  setServerEndpointUrl,
  setActiveTransportMode,
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
import {
  isTauriRuntime,
  isMacOSPlatform,
  getMacClientConfig,
  saveMacClientConfig,
  probeAndSaveServer,
  keychainSetToken,
  keychainGetToken,
  keychainDeleteToken,
  keychainGetStatus,
  startWebdavBridge,
  getWebdavStatus,
  pickMacOSPath,
  revealPathInFinder,
  hashLocalFileBlake3,
  setMacOSWindowTheme,
  type ThemeMode,
  type MacClientConfig,
  type ServerProbeResult,
  type KeychainStatus,
  type MountStatus,
  type LocalFileBlake3Report,
} from './services/macosClient';

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
  // Boot & Onboarding Gate State:
  // - Mac first launch -> 'welcome' (Step 1: Welcome & Choose Server) -> 'login' (Step 2: Login/Register) -> 'workspace'
  // - Web unauthenticated -> 'login' (Full-page Login/Register) -> 'workspace'
  const [booting, setBooting] = createSignal(true);
  const [entryStep, setEntryStep] = createSignal<'welcome' | 'login' | 'workspace'>('login');

  // Auth state
  const [token, setToken] = createSignal<string | null>(localStorage.getItem('mayadesk_token'));
  const [user, setUser] = createSignal<UserProfile | null>(null);
  const [authMode, setAuthMode] = createSignal<'login' | 'register'>('login');
  const [emailInput, setEmailInput] = createSignal('');
  const [passwordInput, setPasswordInput] = createSignal('');
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = createSignal(false);
  const [probingServer, setProbingServer] = createSignal(false);

  // Main Workspace View: 'files' (Finder view) | 'settings' (Unified macOS System Settings view)
  const [activeView, setActiveView] = createSignal<'files' | 'settings'>('files');
  const [settingsTab, setSettingsTab] = createSignal<
    'general' | 'macos' | 'transfers' | 'admin'
  >('general');
  const [mobileMenuOpen, setMobileMenuOpen] = createSignal(false);

  // macOS Client & Native Shell state + 3-Mode Appearance ('system' default | 'light' | 'dark')
  const [tauriActive] = createSignal<boolean>(isTauriRuntime());
  const [macPlatform] = createSignal<boolean>(isMacOSPlatform());
  const [macConfig, setMacConfig] = createSignal<MacClientConfig | null>(null);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(
    (localStorage.getItem('mayadesk_theme_mode') as ThemeMode) || 'system'
  );
  const [systemPrefersDark, setSystemPrefersDark] = createSignal<boolean>(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );

  const resolvedAppearance = (): 'light' | 'dark' => {
    const mode = themeMode();
    if (mode === 'system') {
      return systemPrefersDark() ? 'dark' : 'light';
    }
    return mode;
  };

  const [serverEndpointInput, setServerEndpointInput] = createSignal<string>(
    getServerEndpointUrl() || 'http://127.0.0.1:8080'
  );
  const [serverProbe, setServerProbe] = createSignal<ServerProbeResult | null>(null);
  const [keychainInfo, setKeychainInfo] = createSignal<KeychainStatus | null>(null);
  const [webdavMount, setWebdavMount] = createSignal<MountStatus | null>(null);
  const [localHashTargetPath, setLocalHashTargetPath] = createSignal<string>('');
  const [localHashReport, setLocalHashReport] = createSignal<LocalFileBlake3Report | null>(null);
  const [hashingLocalFile, setHashingLocalFile] = createSignal(false);
  const [newSyncLocalPath, setNewSyncLocalPath] = createSignal('');
  const [newSyncRemotePath, setNewSyncRemotePath] = createSignal('/MacSync');
  const [newSyncSpace, setNewSyncSpace] = createSignal<'private' | 'shared'>('private');

  // Space & File Explorer state
  const [activeSpace, setActiveSpace] = createSignal<'private' | 'shared'>('private');
  const [currentPath, setCurrentPath] = createSignal<string>('/');
  const [folderTree, setFolderTree] = createSignal<string[]>(['/']);
  const [entries, setEntries] = createSignal<VfsFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string>('就绪');
  const [uploadProgress, setUploadProgress] = createSignal<number | null>(null);
  const [listAnimKey, setListAnimKey] = createSignal(0);

  // Collapsible Directory Tree state
  const [collapsedPaths, setCollapsedPaths] = createSignal<string[]>([]);
  const [showSpaceSection, setShowSpaceSection] = createSignal(true);
  const [showTreeSection, setShowTreeSection] = createSignal(true);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

  // Adjustable widths: Left Sidebar + Multi-Column File List ("name", "size", "hash", "mtime")
  const [sidebarWidth, setSidebarWidth] = createSignal<number>(
    Number(localStorage.getItem('mayadesk_sidebar_width')) || 220
  );
  const [colWidths, setColWidths] = createSignal<{
    name: number;
    size: number;
    hash: number;
    mtime: number;
  }>({
    name:
      Number(localStorage.getItem('mayadesk_col_name')) ||
      Number(localStorage.getItem('mayadesk_name_col_width')) ||
      320,
    size: Number(localStorage.getItem('mayadesk_col_size')) || 96,
    hash: Number(localStorage.getItem('mayadesk_col_hash')) || 135,
    mtime: Number(localStorage.getItem('mayadesk_col_mtime')) || 140,
  });

  // Storage Disks & Fresh Deployment Initialization state
  const [disks, setDisks] = createSignal<DiskMountSummary[]>([]);
  const [disksLoaded, setDisksLoaded] = createSignal(false);
  const [showInitDiskModal, setShowInitDiskModal] = createSignal(false);
  const [initMountPath, setInitMountPath] = createSignal('');
  const [initPoolType, setInitPoolType] = createSignal<'both' | 'private' | 'shared'>('both');
  const [initQuotaGb, setInitQuotaGb] = createSignal(1024);
  const [initDiskName, setInitDiskName] = createSignal('');

  // Transport state (Defaults to P2P Direct 'p2p-lan')
  const [transportChannel, setTransportChannel] = createSignal<TransportChannel>('p2p-lan');
  const [rttMs, setRttMs] = createSignal<number>(6);

  createEffect(() => {
    setActiveTransportMode(transportChannel());
  });

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
  const [previewCategory, setPreviewCategory] = createSignal<
    'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | 'other'
  >('other');
  const [previewContent, setPreviewContent] = createSignal<string>('');
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewWrap, setPreviewWrap] = createSignal(true);
  const [copySuccess, setCopySuccess] = createSignal(false);

  // Remote Archive Extraction State
  const [extractItem, setExtractItem] = createSignal<VfsFileEntry | null>(null);
  const [extractDestOption, setExtractDestOption] = createSignal<'folder' | 'current' | 'custom'>(
    'folder'
  );
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
      setStatusMessage(
        `解压成功！共提取 ${res.file_count} 个文件 (${formatBytes(res.extracted_bytes)}) 至 ${res.dest_path}`
      );
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

  const handleSelectTheme = async (mode: ThemeMode) => {
    setThemeMode(mode);
    localStorage.setItem('mayadesk_theme_mode', mode);
    await setMacOSWindowTheme(mode);
    if (macConfig()) {
      const next: MacClientConfig = { ...macConfig()!, theme_mode: mode };
      setMacConfig(next);
      await saveMacClientConfig(next);
    }
    const label =
      mode === 'system'
        ? `跟随系统 (${resolvedAppearance() === 'dark' ? '黑夜' : '白天'})`
        : mode === 'dark'
        ? '黑夜模式'
        : '白天模式';
    setStatusMessage(`外观已切换为: ${label}`);
  };

  const loadMacClientState = async (): Promise<MacClientConfig | null> => {
    try {
      const cfg = await getMacClientConfig();
      setMacConfig(cfg);
      if (cfg.theme_mode && !localStorage.getItem('mayadesk_theme_mode')) {
        setThemeMode(cfg.theme_mode);
      }
      // Keep server endpoint strictly synchronized between Tauri config and localStorage
      const localUrl = localStorage.getItem('mayadesk_server_url');
      if (localUrl && localUrl.trim()) {
        setServerEndpointInput(localUrl.trim());
        if (cfg.server_url !== localUrl.trim()) {
          const synced = { ...cfg, server_url: localUrl.trim() };
          setMacConfig(synced);
          await saveMacClientConfig(synced);
        }
      } else if (cfg.server_url) {
        setServerEndpointInput(cfg.server_url);
        setServerEndpointUrl(cfg.server_url);
      }
      const acct = user()?.email || 'default';
      const kc = await keychainGetStatus(acct);
      setKeychainInfo(kc);
      const dav = await getWebdavStatus();
      setWebdavMount(dav);
      return cfg;
    } catch {
      return null;
    }
  };

  const refreshUserProfile = async (): Promise<UserProfile | null> => {
    if (!token()) return null;
    try {
      const profile = await apiGetUserProfile(token());
      setUser(profile);
      return profile;
    } catch {
      setToken(null);
      setUser(null);
      localStorage.removeItem('mayadesk_token');
      return null;
    }
  };

  const refreshDisks = async () => {
    if (!token()) return;
    try {
      const list = await apiListDisks(token());
      setDisks(list);
      setDisksLoaded(true);
    } catch {
      // Offline
    }
  };

  const refreshFolderTree = async () => {
    if (!token()) return;
    try {
      const paths = await apiListFolderPaths(activeSpace(), token());
      const normalized = Array.from(new Set(['/', ...(paths || [])])).sort();
      if (JSON.stringify(normalized) !== JSON.stringify(folderTree())) {
        setFolderTree(normalized);
      }
    } catch {
      if (folderTree().length === 0) setFolderTree(['/']);
    }
  };

  const refreshDirectory = async (
    space = activeSpace(),
    path = currentPath(),
    silent = false
  ) => {
    if (!token()) return;
    if (!silent) setLoadingFiles(true);
    try {
      const list = await apiListFiles(space, path, token());
      const prevSig = JSON.stringify(
        entries().map((e) => `${e.rel_path}:${e.size_bytes}:${e.modified_unix}`)
      );
      const nextSig = JSON.stringify(
        list.map((e) => `${e.rel_path}:${e.size_bytes}:${e.modified_unix}`)
      );
      if (!silent || prevSig !== nextSig) {
        setEntries(list);
        if (!silent) setListAnimKey((k) => k + 1);
      }
      const spaceLabel = space === 'private' ? '私人空间' : '共享空间';
      setStatusMessage(`已加载 ${list.length} 项 (${spaceLabel}:${path})`);
    } catch (err: any) {
      if (!silent) {
        setStatusMessage(`提示: ${err?.message || '目录为空'}`);
        setEntries([]);
      }
    } finally {
      if (!silent) setLoadingFiles(false);
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

  // Multi-client silent sync helper (triggered on focus, visibilitychange, storage event, and 3.5s interval)
  const syncWorkspaceStateSilently = async () => {
    if (!token() || !user() || entryStep() !== 'workspace' || uploadProgress() !== null) {
      return;
    }
    await Promise.allSettled([
      refreshDirectory(activeSpace(), currentPath(), true),
      refreshFolderTree(),
      refreshUserProfile(),
      refreshDisks(),
    ]);
  };

  // Global macOS Keyboard Shortcuts (⌘, -> Settings, ⌘R -> Refresh, Esc -> Close Modals)
  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      if (user() && entryStep() === 'workspace') {
        setActiveView('settings');
        setStatusMessage('已打开设置面板 (⌘,)');
      } else {
        setEntryStep('welcome');
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      if (user() && entryStep() === 'workspace') {
        e.preventDefault();
        refreshDirectory();
        refreshFolderTree();
        refreshDisks();
        setStatusMessage('已刷新目录 (⌘R)');
      }
    } else if (e.key === 'Escape') {
      if (previewItem()) closePreview();
      else if (extractItem()) setExtractItem(null);
      else if (showFsExplorerModal()) setShowFsExplorerModal(false);
      else if (showInitDiskModal()) setShowInitDiskModal(false);
    }
  };

  // Sync HTML data-theme attribute & Tauri NSWindow theme whenever themeMode or macOS appearance changes
  createEffect(() => {
    const resolved = resolvedAppearance();
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.style.colorScheme = resolved;
    }
    setMacOSWindowTheme(themeMode());
  });

  onMount(async () => {
    window.addEventListener('keydown', handleGlobalKeyDown);

    const mediaQuery = window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const handleMediaChange = (ev: MediaQueryListEvent) => {
      setSystemPrefersDark(ev.matches);
    };
    if (mediaQuery) {
      setSystemPrefersDark(mediaQuery.matches);
      mediaQuery.addEventListener('change', handleMediaChange);
      onCleanup(() => mediaQuery.removeEventListener('change', handleMediaChange));
    }

    // Multi-client & multi-window automatic synchronization listeners
    const handleWindowFocus = () => {
      syncWorkspaceStateSilently();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncWorkspaceStateSilently();
      }
    };
    const handleStorageSync = (ev: StorageEvent) => {
      if (ev.key === 'mayadesk_server_url' && ev.newValue) {
        setServerEndpointInput(ev.newValue);
        syncWorkspaceStateSilently();
      } else if (ev.key === 'mayadesk_theme_mode' && ev.newValue) {
        setThemeMode(ev.newValue as ThemeMode);
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('storage', handleStorageSync);

    const syncInterval = window.setInterval(() => {
      syncWorkspaceStateSilently();
    }, 3500);

    onCleanup(() => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('storage', handleStorageSync);
      window.clearInterval(syncInterval);
    });

    try {
      const cfg = await loadMacClientState();
      const macFirstLaunch =
        (tauriActive() && !cfg?.onboarding_completed) ||
        localStorage.getItem('mayadesk_force_welcome') === 'true';

      if (!token() && tauriActive() && !macFirstLaunch) {
        const kcToken = await keychainGetToken('default');
        if (kcToken) {
          setToken(kcToken);
          localStorage.setItem('mayadesk_token', kcToken);
        }
      }

      if (macFirstLaunch) {
        setEntryStep('welcome');
      } else if (token()) {
        const profile = await refreshUserProfile();
        if (profile) {
          setEntryStep('workspace');
          await Promise.all([
            refreshDisks(),
            refreshDirectory(),
            refreshFolderTree(),
          ]);
        } else {
          setEntryStep('login');
        }
      } else {
        setEntryStep('login');
      }
    } finally {
      setBooting(false);
    }

    const tm = new HybridTransportManager('/api/v1/p2p/ws', '/api/v1');
    const telemetry = await tm.negotiateOptimalChannel(1200);
    setTransportChannel(telemetry.channel);
    setRttMs(telemetry.rttMs);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleGlobalKeyDown);
  });

  createEffect(() => {
    const s = activeSpace();
    const p = currentPath();
    if (user() && entryStep() === 'workspace') {
      refreshDirectory(s, p);
      refreshFolderTree();
    }
  });

  createEffect(() => {
    const view = activeView();
    const tab = settingsTab();
    if (!user() || entryStep() !== 'workspace') return;
    if (view === 'settings') {
      loadMacClientState();
      if (tab === 'transfers') {
        loadTransferLogs();
      } else if (tab === 'admin' && isAdmin()) {
        loadAdminUsers();
        loadConfigFromServer();
      }
    }
  });

  // Reactive Tree Helpers
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

  const isTreeNodeVisible = (path: string): boolean => {
    if (path === '/') return true;
    const collapsed = collapsedPaths();
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
  };

  // Draggable Left Sidebar Resizer (macOS hairline split-view divider)
  const startResizeSidebar = (e: MouseEvent) => {
    e.preventDefault();
    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(190, Math.min(400, moveEvent.clientX));
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

  // Multi-Column File List Resizer
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

  // Complete Welcome Step 1 (Connect Server) -> Proceed to Step 2 (Login Page)
  const handleCompleteWelcomeStep = async (e?: Event) => {
    e?.preventDefault();
    setProbingServer(true);
    setAuthError(null);
    try {
      const raw = serverEndpointInput().trim();
      if (!raw) {
        setServerEndpointUrl('');
        localStorage.setItem('mayadesk_mac_onboarded', 'true');
        localStorage.removeItem('mayadesk_force_welcome');
        setEntryStep('login');
        return;
      }

      const probe = await probeAndSaveServer(raw);
      setServerProbe(probe);
      setServerEndpointUrl(probe.normalized_url);
      setServerEndpointInput(probe.normalized_url);

      const baseCfg = macConfig() || (await getMacClientConfig());
      const nextCfg: MacClientConfig = {
        ...baseCfg,
        onboarding_completed: true,
        server_url: probe.normalized_url,
      };
      setMacConfig(nextCfg);
      localStorage.setItem('mayadesk_mac_onboarded', 'true');
      localStorage.removeItem('mayadesk_force_welcome');
      await saveMacClientConfig(nextCfg);

      if (probe.reachable) {
        setTransportChannel('p2p-lan');
        setRttMs(probe.rtt_ms);
        setStatusMessage(probe.message);
        setEntryStep('login');
      } else {
        setStatusMessage(probe.message);
      }
    } finally {
      setProbingServer(false);
    }
  };

  const handleProbeOnly = async () => {
    setProbingServer(true);
    try {
      const raw = serverEndpointInput().trim() || window.location.origin;
      const probe = await probeAndSaveServer(raw);
      setServerProbe(probe);
      if (probe.reachable) {
        setServerEndpointUrl(probe.normalized_url);
        setServerEndpointInput(probe.normalized_url);
        setTransportChannel('p2p-lan');
        setRttMs(probe.rtt_ms);
      }
    } finally {
      setProbingServer(false);
    }
  };

  const handleAuthSubmit = async (e: Event) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const resp =
        authMode() === 'login'
          ? await apiLogin(emailInput(), passwordInput())
          : await apiRegister(emailInput(), passwordInput());
      setToken(resp.access_token);
      localStorage.setItem('mayadesk_token', resp.access_token);
      localStorage.setItem('mayadesk_mac_onboarded', 'true');
      setUser(resp.user);

      if (macConfig()) {
        const nextCfg: MacClientConfig = {
          ...macConfig()!,
          onboarding_completed: true,
          server_url: getServerEndpointUrl() || macConfig()!.server_url,
        };
        setMacConfig(nextCfg);
        await saveMacClientConfig(nextCfg);
      }
      await keychainSetToken('default', resp.access_token);
      const kc = await keychainSetToken(resp.user.email, resp.access_token);
      setKeychainInfo(kc);

      setEntryStep('workspace');
      setActiveView('files');
      setStatusMessage(`已登录: ${resp.user.email}`);
      await Promise.all([
        refreshUserProfile(),
        refreshDisks(),
        refreshDirectory(),
        refreshFolderTree(),
      ]);
    } catch (err: any) {
      const msg = err?.message || '登录或注册失败，请检查账号密码或服务器连接';
      setAuthError(msg);
      setStatusMessage(`认证失败: ${msg}`);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    const email = user()?.email || 'default';
    setToken(null);
    setUser(null);
    setEntries([]);
    localStorage.removeItem('mayadesk_token');
    await keychainDeleteToken('default');
    const kc = await keychainDeleteToken(email);
    setKeychainInfo(kc);
    setAuthError(null);
    setPasswordInput('');
    setEntryStep('login');
    setStatusMessage('已退出登录');
  };

  const handleGoogleLogin = async () => {
    setAuthError(null);
    try {
      const info = await apiGetGoogleAuthUrl();
      window.location.href = info.authorize_url;
    } catch {
      setAuthError(
        '当前服务器尚未启用 Google OAuth 2.0，请先使用邮箱密码登录并在「设置 -> 配额与存储池」中配置'
      );
      setStatusMessage('请在「设置」中配置 Google OAuth Client ID');
    }
  };

  const handleSaveServerEndpoint = async (e?: Event) => {
    e?.preventDefault();
    const raw = serverEndpointInput().trim();
    setStatusMessage(`正在探测服务器连通性: ${raw} ...`);
    const probe = await probeAndSaveServer(raw);
    setServerProbe(probe);
    setServerEndpointUrl(probe.normalized_url);
    setServerEndpointInput(probe.normalized_url);
    if (macConfig()) {
      const nextCfg: MacClientConfig = {
        ...macConfig()!,
        onboarding_completed: true,
        server_url: probe.normalized_url,
      };
      setMacConfig(nextCfg);
      await saveMacClientConfig(nextCfg);
    }
    if (probe.reachable) {
      setTransportChannel('p2p-lan');
      setRttMs(probe.rtt_ms);
      setStatusMessage(probe.message);
      await Promise.all([
        refreshUserProfile(),
        refreshDisks(),
        refreshDirectory(),
        refreshFolderTree(),
      ]);
    } else {
      setStatusMessage(probe.message);
    }
  };

  // macOS Local File 4MB BLAKE3 Inspector
  const handleInspectLocalBlake3 = async (pickDialog = false) => {
    try {
      let target = localHashTargetPath().trim();
      if (pickDialog || !target) {
        const picked = await pickMacOSPath(false);
        if (picked) {
          target = picked;
          setLocalHashTargetPath(picked);
        }
      }
      if (!target) return;
      setHashingLocalFile(true);
      setStatusMessage(`正在执行 4MB 分片 BLAKE3 哈希计算: ${target}`);
      const report = await hashLocalFileBlake3(target);
      setLocalHashReport(report);
      setStatusMessage(
        `BLAKE3 校验完成: ${report.file_name} (${report.total_blocks} 个 4MB 分片, 速率 ${report.throughput_mbps} MB/s)`
      );
    } catch (err: any) {
      setStatusMessage(`本地 BLAKE3 校验提示: ${err?.message || err}`);
    } finally {
      setHashingLocalFile(false);
    }
  };

  // macOS Finder Loopback WebDAV Mount
  const handleMountFinderWebdav = async (openInFinder: boolean) => {
    try {
      setStatusMessage('正在启动 127.0.0.1:18085 本地 WebDAV 环回服务...');
      const status = await startWebdavBridge(openInFinder);
      setWebdavMount(status);
      setStatusMessage(status.message);
    } catch (err: any) {
      setStatusMessage(`WebDAV 挂载失败: ${err?.message || err}`);
    }
  };

  // macOS Sync Folder Rule Management
  const handleAddSyncRule = async (e: Event) => {
    e.preventDefault();
    if (!macConfig() || !newSyncLocalPath().trim()) return;
    const rule = {
      id: `sync_${Date.now()}`,
      local_path: newSyncLocalPath().trim(),
      space: newSyncSpace(),
      remote_path: newSyncRemotePath().trim() || '/MacSync',
      enabled: true,
      last_sync_iso: new Date().toISOString(),
    };
    const updated: MacClientConfig = {
      ...macConfig()!,
      sync_folders: [...macConfig()!.sync_folders, rule],
    };
    setMacConfig(updated);
    await saveMacClientConfig(updated);
    setNewSyncLocalPath('');
    setStatusMessage(
      `已添加 macOS 本地同步目录: ${rule.local_path} -> ${rule.space}:${rule.remote_path}`
    );
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
      await apiUploadFiles(activeSpace(), currentPath(), input.files, token(), (pct, msg) => {
        setUploadProgress(pct);
        setStatusMessage(msg);
      });
      setStatusMessage('文件上传完成 (P2P 直连)');
      input.value = '';
      await Promise.all([
        refreshUserProfile(),
        refreshDirectory(),
        refreshFolderTree(),
      ]);
    } catch (err: any) {
      alert(`上传失败: ${err?.message}`);
      setStatusMessage(`上传失败: ${err?.message}`);
    } finally {
      setTimeout(() => setUploadProgress(null), 1200);
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
      setStatusMessage(`正在通过 P2P 上传文件夹 (${input.files.length} 个文件)...`);
      await apiUploadFiles(activeSpace(), currentPath(), input.files, token(), (pct, msg) => {
        setUploadProgress(pct);
        setStatusMessage(msg);
      });
      setStatusMessage('文件夹上传完成');
      input.value = '';
      expandAncestorsOf(currentPath());
      await Promise.all([
        refreshUserProfile(),
        refreshDirectory(),
        refreshFolderTree(),
      ]);
    } catch (err: any) {
      alert(`文件夹上传失败: ${err?.message}`);
      setStatusMessage(`文件夹上传失败: ${err?.message}`);
    } finally {
      setTimeout(() => setUploadProgress(null), 1200);
    }
  };

  const handleDelete = async (entry: VfsFileEntry) => {
    const typeLabel = entry.is_dir ? '文件夹（含其所有子文件）' : '文件';
    if (!window.confirm(`确认删除此${typeLabel} "${entry.name}" 吗？`)) return;
    try {
      await apiDeleteEntry(activeSpace(), entry.rel_path, token());
      setStatusMessage(`已删除: ${entry.name}`);
      await Promise.all([
        refreshUserProfile(),
        refreshDirectory(),
        refreshFolderTree(),
      ]);
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

  const currentServerLabel = () => {
    const url = getServerEndpointUrl();
    if (!url) return `${window.location.origin} (同源)`;
    return url;
  };

  // macOS 3-Mode Appearance Segmented Control (Used inside Settings)
  const renderThemeSegmentedControl = () => (
    <div class="mac-segmented">
      <button
        type="button"
        onClick={() => handleSelectTheme('system')}
        class={`mac-segmented-item ${themeMode() === 'system' ? 'is-active' : ''}`}
      >
        跟随系统
      </button>
      <button
        type="button"
        onClick={() => handleSelectTheme('light')}
        class={`mac-segmented-item ${themeMode() === 'light' ? 'is-active' : ''}`}
      >
        ☀ 白天
      </button>
      <button
        type="button"
        onClick={() => handleSelectTheme('dark')}
        class={`mac-segmented-item ${themeMode() === 'dark' ? 'is-active' : ''}`}
      >
        ☾ 黑夜
      </button>
    </div>
  );

  return (
    <div class="mac-window h-screen flex flex-col text-sm select-text overflow-hidden">
      {/* ==========================================================================
          GATE 0: Initial Session & Keychain Verification Loading Screen
         ========================================================================== */}
      <Show when={booting()}>
        <div
          data-tauri-drag-region
          class="flex-1 flex flex-col items-center justify-center p-6"
          style={{ 'background-color': 'var(--mac-bg-canvas)' }}
        >
          <div class="mac-card p-6 max-w-sm w-full text-center space-y-2.5 md-modal-animate">
            <div class="font-semibold text-sm">正在连接 MayaDesk...</div>
            <div class="text-xs font-mono" style={{ color: 'var(--mac-text-secondary)' }}>
              正在同步网络通道与安全凭据
            </div>
          </div>
        </div>
      </Show>

      {/* ==========================================================================
          GATE 1: macOS First-Launch Welcome & Server Connection Wizard
         ========================================================================== */}
      <Show when={!booting() && entryStep() === 'welcome'}>
        <div
          class="flex-1 flex flex-col overflow-y-auto"
          style={{ 'background-color': 'var(--mac-bg-canvas)' }}
        >
          {/* Minimal Draggable Window Drag Bar (No top-left logo) */}
          <div
            data-tauri-drag-region
            class={`h-11 shrink-0 flex items-center justify-end ${
              tauriActive() && macPlatform() ? 'pl-20 pr-5' : 'px-5'
            }`}
          >
            <Show when={localStorage.getItem('mayadesk_mac_onboarded') === 'true'}>
              <button
                type="button"
                onClick={() => setEntryStep(user() ? 'workspace' : 'login')}
                class="mac-btn text-xs"
              >
                跳过向导 →
              </button>
            </Show>
          </div>

          <div class="flex-1 flex items-center justify-center p-4 sm:p-8">
            <div class="w-full max-w-xl mac-modal p-6 sm:p-8 space-y-6 md-modal-animate">
              <div
                class="flex items-center justify-between pb-4"
                style={{ 'border-bottom': '1px solid var(--mac-border)' }}
              >
                <div class="space-y-1">
                  <div class="flex items-center gap-2">
                    <span class="mac-badge-accent font-mono">STEP 1 / 2</span>
                    <h1 class="text-base sm:text-lg font-semibold tracking-tight">
                      连接 MayaDesk 服务器节点
                    </h1>
                  </div>
                  <p class="text-xs" style={{ color: 'var(--mac-text-secondary)' }}>
                    首次启动请先选择或输入您要连接的 MayaDesk 服务器地址，验证连通后再登录账号。
                  </p>
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div
                  class="p-3 rounded-[8px] space-y-1"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <div class="font-semibold text-[11px]">默认 P2P 直连</div>
                  <div
                    class="text-[11px] leading-relaxed"
                    style={{ color: 'var(--mac-text-secondary)' }}
                  >
                    默认启用 P2P 高速直连通道，复杂网络下自动回退 Cloudflare Tunnel。
                  </div>
                </div>
                <div
                  class="p-3 rounded-[8px] space-y-1"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <div class="font-semibold text-[11px]">私人空间 + 共享盘</div>
                  <div
                    class="text-[11px] leading-relaxed"
                    style={{ color: 'var(--mac-text-secondary)' }}
                  >
                    多块物理硬盘统一挂载聚合，个人空间与团队共享盘物理隔离。
                  </div>
                </div>
                <div
                  class="p-3 rounded-[8px] space-y-1"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <div class="font-semibold text-[11px]">多端实时同步</div>
                  <div
                    class="text-[11px] leading-relaxed"
                    style={{ color: 'var(--mac-text-secondary)' }}
                  >
                    macOS 客户端与 Web 端目录、配额及 4MB 分片 BLAKE3 校验实时同步。
                  </div>
                </div>
              </div>

              <form onSubmit={handleCompleteWelcomeStep} class="space-y-4 text-xs">
                <div class="space-y-2">
                  <label class="block font-medium">
                    服务器连接地址 (Server Endpoint URL)
                  </label>
                  <div class="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={serverEndpointInput()}
                      onInput={(e) => {
                        setServerEndpointInput(e.currentTarget.value);
                        setServerProbe(null);
                      }}
                      placeholder="例如 https://drive.yourdomain.com 或 http://192.168.1.100:8080"
                      class="mac-input flex-1 font-mono"
                    />
                    <button
                      type="button"
                      disabled={probingServer()}
                      onClick={handleProbeOnly}
                      class="mac-btn shrink-0"
                    >
                      {probingServer() ? '探测中...' : '测试连通性'}
                    </button>
                  </div>
                </div>

                <div class="space-y-1.5">
                  <span class="text-[11px] block" style={{ color: 'var(--mac-text-muted)' }}>
                    常用服务器节点快捷填入：
                  </span>
                  <div class="flex flex-wrap gap-2 font-mono text-[11px]">
                    <button
                      type="button"
                      onClick={() => {
                        setServerEndpointInput('http://129.211.25.124:8080');
                        setServerProbe(null);
                      }}
                      class={
                        serverEndpointInput() === 'http://129.211.25.124:8080'
                          ? 'mac-btn-primary text-[11px]'
                          : 'mac-btn text-[11px]'
                      }
                    >
                      云端测试服 (129.211.25.124:8080)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setServerEndpointInput('http://127.0.0.1:8080');
                        setServerProbe(null);
                      }}
                      class={
                        serverEndpointInput() === 'http://127.0.0.1:8080'
                          ? 'mac-btn-primary text-[11px]'
                          : 'mac-btn text-[11px]'
                      }
                    >
                      本机 NAS 服务 (127.0.0.1:8080)
                    </button>
                  </div>
                </div>

                <Show when={serverProbe()}>
                  <div
                    class="p-3 rounded-[8px] font-mono text-xs space-y-1 md-view-animate"
                    style={{
                      'background-color': serverProbe()!.reachable
                        ? 'var(--mac-accent-subtle)'
                        : 'rgba(255, 59, 48, 0.12)',
                      border: '1px solid var(--mac-border)',
                    }}
                  >
                    <div class="font-semibold">
                      {serverProbe()!.reachable ? '✓ 服务器连接验证通过' : '✕ 服务器暂不可达'}
                    </div>
                    <div class="text-[11px]">{serverProbe()!.message}</div>
                    <div class="text-[11px]" style={{ color: 'var(--mac-text-secondary)' }}>
                      API 地址: {serverProbe()!.api_base_url} · 默认通道: P2P 直连优先
                    </div>
                  </div>
                </Show>

                <div
                  class="pt-4 flex flex-col sm:flex-row items-center justify-between gap-3"
                  style={{ 'border-top': '1px solid var(--mac-border)' }}
                >
                  <span class="text-[11px]" style={{ color: 'var(--mac-text-muted)' }}>
                    连接成功后将进入账号登录页面
                  </span>
                  <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <Show when={serverProbe() && !serverProbe()!.reachable}>
                      <button
                        type="button"
                        onClick={() => {
                          setServerEndpointUrl(serverEndpointInput().trim());
                          localStorage.setItem('mayadesk_mac_onboarded', 'true');
                          setEntryStep('login');
                        }}
                        class="mac-btn"
                      >
                        强制使用此地址
                      </button>
                    </Show>
                    <button
                      type="submit"
                      disabled={probingServer()}
                      class="mac-btn-primary px-5 py-2"
                    >
                      {probingServer() ? '正在连接...' : '连接服务器并前往登录 →'}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </Show>

      {/* ==========================================================================
          GATE 2: Full-Screen Login / Register Gate Page
         ========================================================================== */}
      <Show when={!booting() && entryStep() !== 'welcome' && (!user() || entryStep() === 'login')}>
        <div
          class="flex-1 flex flex-col overflow-y-auto"
          style={{ 'background-color': 'var(--mac-bg-canvas)' }}
        >
          {/* Minimal Draggable Window Bar (No top-left logo) */}
          <div
            data-tauri-drag-region
            class={`h-11 shrink-0 flex items-center justify-end gap-2 ${
              tauriActive() && macPlatform() ? 'pl-20 pr-5' : 'px-5'
            }`}
          >
            <span
              class="hidden sm:inline-block font-mono text-[11px] truncate max-w-[240px]"
              style={{ color: 'var(--mac-text-secondary)' }}
            >
              节点: {currentServerLabel()}
            </span>
            <button
              type="button"
              onClick={() => {
                setServerProbe(null);
                setEntryStep('welcome');
              }}
              class="mac-btn text-[11px]"
            >
              切换服务器连接
            </button>
          </div>

          <div class="flex-1 flex items-center justify-center p-4 sm:p-8">
            <div class="w-full max-w-md mac-modal p-6 sm:p-7 space-y-5 md-modal-animate">
              <div
                class="pb-3.5 flex items-center justify-between"
                style={{ 'border-bottom': '1px solid var(--mac-border)' }}
              >
                <div>
                  <h1 class="text-base font-semibold tracking-tight">
                    {authMode() === 'login' ? '登录私有云工作台' : '注册新账号'}
                  </h1>
                  <p
                    class="text-[11px] mt-0.5 font-mono truncate max-w-[280px]"
                    style={{ color: 'var(--mac-text-secondary)' }}
                  >
                    节点: {currentServerLabel()}
                  </p>
                </div>
                <span class="mac-badge-accent font-mono">
                  {authMode() === 'login' ? 'LOGIN' : 'REGISTER'}
                </span>
              </div>

              {/* macOS Segmented Mode Switch */}
              <div class="mac-segmented w-full grid grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                  }}
                  class={`mac-segmented-item py-1.5 ${authMode() === 'login' ? 'is-active' : ''}`}
                >
                  账号登录
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError(null);
                  }}
                  class={`mac-segmented-item py-1.5 ${
                    authMode() === 'register' ? 'is-active' : ''
                  }`}
                >
                  注册新账号
                </button>
              </div>

              <Show when={authError()}>
                <div
                  class="p-2.5 rounded-[8px] text-xs font-mono md-view-animate"
                  style={{
                    'background-color': 'rgba(255, 59, 48, 0.12)',
                    color: '#ff453a',
                    border: '1px solid rgba(255, 59, 48, 0.25)',
                  }}
                >
                  {authError()}
                </div>
              </Show>

              <form onSubmit={handleAuthSubmit} class="space-y-3.5 text-xs">
                <label class="block space-y-1.5">
                  <span class="font-medium">邮箱地址</span>
                  <input
                    type="email"
                    required
                    placeholder="admin@mayadesk.local"
                    value={emailInput()}
                    onInput={(e) => setEmailInput(e.currentTarget.value)}
                    class="mac-input w-full font-mono"
                    autofocus
                  />
                </label>

                <label class="block space-y-1.5">
                  <span class="font-medium">登录密码</span>
                  <input
                    type="password"
                    required
                    placeholder="输入密码"
                    value={passwordInput()}
                    onInput={(e) => setPasswordInput(e.currentTarget.value)}
                    class="mac-input w-full font-mono"
                  />
                </label>

                <button
                  type="submit"
                  disabled={authSubmitting()}
                  class="mac-btn-primary w-full py-2 text-xs font-semibold"
                >
                  {authSubmitting()
                    ? '正在验证身份...'
                    : authMode() === 'login'
                    ? '登录进入云盘'
                    : '注册并进入云盘 (初始无配额)'}
                </button>
              </form>

              <div
                class="pt-3.5 space-y-2.5 text-xs"
                style={{ 'border-top': '1px solid var(--mac-border)' }}
              >
                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  class="mac-btn w-full py-2 font-medium"
                >
                  使用 Google 账号登录 (OAuth 2.0)
                </button>

                <div
                  class="flex items-center justify-between pt-1 text-[11px]"
                  style={{ color: 'var(--mac-text-secondary)' }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('login');
                      setEmailInput('admin@mayadesk.local');
                      setPasswordInput('admin123456');
                      setAuthError(null);
                    }}
                    class="hover:underline cursor-pointer font-mono"
                  >
                    填入默认管理员账号
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setServerProbe(null);
                      setEntryStep('welcome');
                    }}
                    class="hover:underline cursor-pointer"
                  >
                    重新选择服务器
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* ==========================================================================
          GATE 3: Authenticated Main Workspace — Standard macOS Full-Height Split View
          (No Top Global Header Bar! No Top-Left App Icon/Title!)
         ========================================================================== */}
      <Show when={!booting() && user() && entryStep() === 'workspace'}>
        <div class="flex-1 flex overflow-hidden relative">
          {/* ======================================================================
              LEFT PANE: Full-Height macOS Sidebar (Finder Style)
             ====================================================================== */}
          <Show when={!sidebarCollapsed()}>
            <aside
              style={{ width: `${sidebarWidth()}px` }}
              class={`${
                mobileMenuOpen() ? 'fixed inset-y-0 left-0 z-40 flex md-view-animate' : 'hidden'
              } md:flex mac-sidebar flex-col justify-between shrink-0 select-none min-w-[190px] max-w-[400px]`}
            >
              {/* Top Sidebar Drag Region: Traffic Lights Safe Area ONLY + Sidebar Collapse Button */}
              <div>
                <div
                  data-tauri-drag-region
                  class={`h-11 flex items-center justify-end px-2.5 ${
                    tauriActive() && macPlatform() ? 'pl-20' : 'pl-3'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSidebarCollapsed(true)}
                    title="收起边栏"
                    class="mac-btn-ghost w-7 h-7 text-xs"
                  >
                    ◧
                  </button>
                </div>

                {/* Sidebar Scrollable Navigation Sections */}
                <div class="px-2.5 py-1 space-y-4 overflow-y-auto max-h-[calc(100vh-175px)]">
                  {/* Group 1: 位置 (Locations) */}
                  <div class="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => setShowSpaceSection((v) => !v)}
                      class="w-full px-2 py-1 flex items-center justify-between text-[11px] font-semibold cursor-pointer"
                      style={{ color: 'var(--mac-text-muted)' }}
                    >
                      <span>位置</span>
                      <span
                        class={`md-chevron text-[10px] ${showSpaceSection() ? 'is-open' : ''}`}
                      >
                        ▸
                      </span>
                    </button>

                    <div class={`md-collapse-grid ${showSpaceSection() ? '' : 'is-collapsed'}`}>
                      <div class="md-collapse-inner space-y-0.5">
                        <button
                          type="button"
                          onClick={() => selectSpace('private')}
                          class={`mac-nav-item ${
                            activeView() === 'files' && activeSpace() === 'private'
                              ? 'is-selected'
                              : ''
                          }`}
                        >
                          <span class="flex items-center gap-2 truncate">
                            <span
                              class="text-[10px]"
                              style={{ color: 'var(--mac-accent)' }}
                            >
                              ●
                            </span>
                            <span>私人空间</span>
                          </span>
                          <span
                            class="text-[11px]"
                            style={{ color: 'var(--mac-text-muted)' }}
                          >
                            个人
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => selectSpace('shared')}
                          class={`mac-nav-item ${
                            activeView() === 'files' && activeSpace() === 'shared'
                              ? 'is-selected'
                              : ''
                          }`}
                        >
                          <span class="flex items-center gap-2 truncate">
                            <span
                              class="text-[10px]"
                              style={{ color: 'var(--mac-accent)' }}
                            >
                              ●
                            </span>
                            <span>共享空间</span>
                          </span>
                          <span
                            class="text-[11px]"
                            style={{ color: 'var(--mac-text-muted)' }}
                          >
                            团队
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Group 2: 目录树 (Directory Hierarchy) */}
                  <div class="space-y-0.5">
                    <div class="px-2 py-1 flex items-center justify-between text-[11px] font-semibold">
                      <button
                        type="button"
                        onClick={() => setShowTreeSection((v) => !v)}
                        class="flex items-center gap-1 cursor-pointer"
                        style={{ color: 'var(--mac-text-muted)' }}
                      >
                        <span>目录树</span>
                        <span
                          class={`md-chevron text-[10px] ${showTreeSection() ? 'is-open' : ''}`}
                        >
                          ▸
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => refreshFolderTree()}
                        title="刷新目录树"
                        class="mac-btn-ghost px-1.5 py-0.5 text-[10px] font-mono"
                      >
                        {activeSpace() === 'private' ? '私人' : '共享'} ↻
                      </button>
                    </div>

                    <div class={`md-collapse-grid ${showTreeSection() ? '' : 'is-collapsed'}`}>
                      <div class="md-collapse-inner space-y-0.5">
                        <For each={folderTree()}>
                          {(dirPath) => {
                            const depth =
                              dirPath === '/' ? 0 : dirPath.split('/').filter(Boolean).length;
                            const folderName =
                              dirPath === '/' ? '根目录 /' : dirPath.split('/').pop();
                            const isSelected = () =>
                              activeView() === 'files' && currentPath() === dirPath;

                            return (
                              <div
                                class={`md-tree-node ${
                                  isTreeNodeVisible(dirPath) ? '' : 'is-hidden-node'
                                }`}
                              >
                                <div class="md-collapse-inner">
                                  <div
                                    style={{ 'padding-left': `${depth * 12 + 6}px` }}
                                    class={`mac-nav-item py-1 pr-2 ${
                                      isSelected() ? 'is-selected' : ''
                                    }`}
                                  >
                                    <div class="flex items-center min-w-0 flex-1">
                                      <Show
                                        when={hasChildDirs(dirPath)}
                                        fallback={
                                          <span
                                            class="inline-block w-4 text-center text-xs shrink-0"
                                            style={{ color: 'var(--mac-text-muted)' }}
                                          >
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
                                          class="w-4 h-4 flex items-center justify-center text-[10px] shrink-0 cursor-pointer"
                                          style={{ color: 'var(--mac-text-muted)' }}
                                        >
                                          <span
                                            class={`md-chevron ${
                                              isPathCollapsed(dirPath) ? '' : 'is-open'
                                            }`}
                                          >
                                            ▸
                                          </span>
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
                                        class="flex-1 text-left pl-1 truncate cursor-pointer text-xs"
                                      >
                                        {folderName}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sidebar Footer: Storage Quota + Unified Settings Button (⌘,) */}
              <div
                class="p-2.5 space-y-2"
                style={{ 'border-top': '1px solid var(--mac-border)' }}
              >
                <div
                  class="p-2.5 rounded-[8px] space-y-1.5 text-[11px]"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <div class="flex justify-between items-center whitespace-nowrap">
                    <span style={{ color: 'var(--mac-text-secondary)' }}>存储空间</span>
                    <span class="font-mono font-medium">
                      {formatBytes(user()?.used_bytes || 0)} /{' '}
                      {isAdmin()
                        ? '无限'
                        : user()?.quota_bytes && user()!.quota_bytes! > 0
                        ? formatBytes(user()!.quota_bytes!)
                        : '0 B'}
                    </span>
                  </div>
                  <div
                    class="w-full h-1.5 rounded-full overflow-hidden"
                    style={{ 'background-color': 'var(--mac-bg-elevated)' }}
                  >
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      style={{
                        'background-color': 'var(--mac-accent)',
                        width: `${
                          isAdmin()
                            ? 12
                            : user()?.quota_bytes && user()!.quota_bytes! > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  ((user()?.used_bytes || 0) / user()!.quota_bytes!) * 100
                                )
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>

                {/* Unified Settings Entry */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('settings');
                    setMobileMenuOpen(false);
                  }}
                  class={`mac-nav-item ${activeView() === 'settings' ? 'is-selected' : ''}`}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-sm shrink-0">⚙</span>
                    <div class="min-w-0">
                      <div class="text-xs font-medium truncate">设置与系统管理</div>
                      <div
                        class="text-[10px] truncate"
                        style={{ color: 'var(--mac-text-muted)' }}
                      >
                        {user()!.email.split('@')[0]} · 外观 / 节点 / 客户端
                      </div>
                    </div>
                  </div>
                  <span class="mac-badge font-mono text-[10px]">⌘,</span>
                </button>
              </div>
            </aside>

            {/* Invisible 4px Hit Area over 1px Hairline Divider */}
            <div
              onMouseDown={startResizeSidebar}
              onDblClick={() => setSidebarWidth(220)}
              class="hidden md:block w-1 -ml-0.5 cursor-col-resize hover:bg-sky-500/40 shrink-0 transition-colors z-20 select-none"
              title="拖拽调整边栏宽度，双击恢复默认"
            />
          </Show>

          {/* ======================================================================
              RIGHT PANE: Main Content Area (Finder View OR Unified Settings View)
             ====================================================================== */}
          <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Deployment Banner for Admin ONLY when genuinely no storage pool AND no files exist */}
            <Show
              when={
                disksLoaded() &&
                disks().length === 0 &&
                entries().length === 0 &&
                isAdmin()
              }
            >
              <div
                class="px-4 py-2 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 md-view-animate"
                style={{
                  'background-color': 'rgba(255, 159, 10, 0.14)',
                  'border-bottom': '1px solid var(--mac-border)',
                }}
              >
                <div>
                  <span class="font-semibold">存储空间尚未初始化：</span>
                  <span style={{ color: 'var(--mac-text-secondary)' }}>
                    当前系统尚未挂载任何物理存储盘，请先初始化存储盘路径。
                  </span>
                </div>
                <button
                  onClick={() => setShowInitDiskModal(true)}
                  class="mac-btn-primary text-xs shrink-0"
                >
                  配置初始存储盘
                </button>
              </div>
            </Show>

            {/* ====================================================================
                VIEW 1: Finder File Browser (Compact Single-Line Rows, Unified P2P Upload)
               ==================================================================== */}
            <Show when={activeView() === 'files'}>
              <div class="flex-1 flex flex-col overflow-hidden md-view-animate">
                {/* Finder Integrated Window Toolbar (Draggable) */}
                <div
                  data-tauri-drag-region
                  class={`mac-toolbar h-11 px-4 flex items-center justify-between gap-2 shrink-0 ${
                    sidebarCollapsed() && tauriActive() && macPlatform() ? 'pl-20' : ''
                  }`}
                >
                  <div class="flex items-center gap-2 min-w-0" data-tauri-drag-region>
                    <Show when={sidebarCollapsed()}>
                      <button
                        type="button"
                        onClick={() => setSidebarCollapsed(false)}
                        title="展开边栏"
                        class="mac-btn-ghost w-7 h-7 text-xs"
                      >
                        ◧
                      </button>
                    </Show>

                    <button
                      type="button"
                      onClick={() => setMobileMenuOpen((v) => !v)}
                      class="md:hidden mac-btn text-xs"
                    >
                      边栏
                    </button>

                    <button
                      type="button"
                      onClick={navigateUp}
                      disabled={currentPath() === '/'}
                      class="mac-btn text-xs"
                      title="返回上级目录"
                    >
                      ‹ 上级
                    </button>

                    <span class="mac-badge-accent">
                      {activeSpace() === 'private' ? '私人空间' : '共享空间'}
                    </span>
                    <span class="mac-badge font-mono truncate max-w-[200px] sm:max-w-xs">
                      {currentPath()}
                    </span>
                  </div>

                  {/* Right File Actions — Single Unified Upload (Defaults to P2P!) */}
                  <div class="flex items-center gap-1.5 shrink-0">
                    <button onClick={handleCreateFolder} class="mac-btn text-xs">
                      新建文件夹
                    </button>

                    <label
                      class="mac-btn-primary text-xs"
                      title="默认通过 P2P 直连通道上传文件（大文件自动按 4MB 分片流式传输）"
                    >
                      上传文件
                      <input type="file" multiple onChange={handleFileUpload} class="hidden" />
                    </label>

                    <label class="mac-btn text-xs hidden sm:inline-flex">
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
                        refreshUserProfile();
                      }}
                      class="mac-btn text-xs"
                      title="刷新 (⌘R)"
                    >
                      刷新
                    </button>
                  </div>
                </div>

                {/* Upload progress bar */}
                <Show when={uploadProgress() !== null}>
                  <div
                    class="px-4 py-1.5 text-xs flex items-center justify-between md-view-animate"
                    style={{
                      'background-color': 'var(--mac-accent-subtle)',
                      'border-bottom': '1px solid var(--mac-border)',
                    }}
                  >
                    <span class="truncate">{statusMessage()}</span>
                    <span class="font-mono font-semibold shrink-0">{uploadProgress()}%</span>
                  </div>
                </Show>

                {/* File Table Content Area */}
                <div
                  class="flex-1 p-3 sm:p-4 overflow-auto"
                  style={{ 'background-color': 'var(--mac-bg-canvas)' }}
                >
                  <div class="mac-card overflow-x-auto">
                    <div class="min-w-[660px]">
                      {/* Compact macOS Finder Column Header */}
                      <div class="hidden sm:flex mac-table-header items-center select-none h-8">
                        <div
                          style={{ width: `${colWidths().name}px` }}
                          class="relative py-1.5 px-3 shrink-0 flex items-center justify-between"
                        >
                          <span>名称</span>
                          <div
                            onMouseDown={(e) => startResizeCol('name', 160, 900, e)}
                            onDblClick={() => resetColWidth('name', 320)}
                            class="absolute right-0 top-1 bottom-1 w-1 rounded-full hover:bg-sky-500/50 cursor-col-resize z-10"
                            title="拖拽调整列宽，双击恢复默认"
                          />
                        </div>

                        <div
                          style={{ width: `${colWidths().size}px` }}
                          class="relative py-1.5 px-2.5 shrink-0 flex items-center justify-between"
                        >
                          <span>大小</span>
                          <div
                            onMouseDown={(e) => startResizeCol('size', 72, 240, e)}
                            onDblClick={() => resetColWidth('size', 96)}
                            class="absolute right-0 top-1 bottom-1 w-1 rounded-full hover:bg-sky-500/50 cursor-col-resize z-10"
                          />
                        </div>

                        <div
                          style={{ width: `${colWidths().hash}px` }}
                          class="relative py-1.5 px-2.5 shrink-0 flex items-center justify-between"
                        >
                          <span>BLAKE3 校验</span>
                          <div
                            onMouseDown={(e) => startResizeCol('hash', 90, 300, e)}
                            onDblClick={() => resetColWidth('hash', 135)}
                            class="absolute right-0 top-1 bottom-1 w-1 rounded-full hover:bg-sky-500/50 cursor-col-resize z-10"
                          />
                        </div>

                        <div
                          style={{ width: `${colWidths().mtime}px` }}
                          class="relative py-1.5 px-2.5 shrink-0 flex items-center justify-between"
                        >
                          <span>修改时间</span>
                          <div
                            onMouseDown={(e) => startResizeCol('mtime', 110, 280, e)}
                            onDblClick={() => resetColWidth('mtime', 140)}
                            class="absolute right-0 top-1 bottom-1 w-1 rounded-full hover:bg-sky-500/50 cursor-col-resize z-10"
                          />
                        </div>

                        <div class="flex-1 py-1.5 px-3 text-right min-w-[165px] shrink-0">
                          操作
                        </div>
                      </div>

                      <Show
                        when={!loadingFiles() && entries().length > 0}
                        fallback={
                          <div
                            class="p-8 text-center text-xs md-view-animate"
                            style={{ color: 'var(--mac-text-muted)' }}
                          >
                            {loadingFiles()
                              ? '正在读取目录...'
                              : '当前目录为空，可点击上方「新建文件夹」或「上传文件」。'}
                          </div>
                        }
                      >
                        <div data-anim-key={listAnimKey()} class="md-view-animate">
                          <For each={entries()}>
                            {(item) => (
                              <div class="mac-table-row px-3 sm:px-0 py-1.5 sm:py-0 sm:h-9 text-xs flex flex-col sm:flex-row sm:items-center md-row-animate">
                                {/* Name Column */}
                                <div
                                  style={{ width: `${colWidths().name}px` }}
                                  class="sm:shrink-0 sm:py-1 sm:px-3 flex items-center justify-between sm:justify-start gap-2 min-w-0"
                                >
                                  <div class="flex items-center gap-2 min-w-0">
                                    <span
                                      class={
                                        item.is_dir
                                          ? 'mac-badge-accent font-mono text-[10px]'
                                          : 'mac-badge font-mono text-[10px]'
                                      }
                                    >
                                      {item.is_dir
                                        ? 'DIR'
                                        : (() => {
                                            const cat = getFileCategory(item.name);
                                            switch (cat) {
                                              case 'image':
                                                return 'IMG';
                                              case 'video':
                                                return 'VID';
                                              case 'audio':
                                                return 'AUD';
                                              case 'pdf':
                                                return 'PDF';
                                              case 'code':
                                                return 'CODE';
                                              case 'archive':
                                                return 'ZIP';
                                              default:
                                                return 'FILE';
                                            }
                                          })()}
                                    </span>
                                    <Show
                                      when={item.is_dir}
                                      fallback={
                                        getFileCategory(item.name) !== 'archive' &&
                                        getFileCategory(item.name) !== 'other' ? (
                                          <button
                                            onClick={() => openPreview(item)}
                                            class="text-left hover:underline cursor-pointer font-medium truncate"
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
                                        class="text-left hover:underline cursor-pointer font-semibold truncate"
                                        style={{ color: 'var(--mac-accent-text)' }}
                                      >
                                        {item.name}
                                      </button>
                                    </Show>
                                  </div>
                                </div>

                                {/* Size Column */}
                                <div
                                  style={{
                                    width: `${colWidths().size}px`,
                                    color: 'var(--mac-text-secondary)',
                                  }}
                                  class="hidden sm:flex items-center shrink-0 font-mono text-[11px] py-1 px-2.5 truncate"
                                >
                                  {item.is_dir ? '-' : formatBytes(item.size_bytes)}
                                </div>

                                {/* BLAKE3 Hash Column */}
                                <div
                                  style={{
                                    width: `${colWidths().hash}px`,
                                    color: 'var(--mac-text-muted)',
                                  }}
                                  class="hidden sm:flex items-center shrink-0 font-mono text-[11px] py-1 px-2.5 truncate"
                                >
                                  {item.blake3_short || '-'}
                                </div>

                                {/* Modified Time Column */}
                                <div
                                  style={{
                                    width: `${colWidths().mtime}px`,
                                    color: 'var(--mac-text-secondary)',
                                  }}
                                  class="hidden sm:flex items-center shrink-0 font-mono text-[11px] py-1 px-2.5 truncate"
                                >
                                  {formatTime(item.modified_unix)}
                                </div>

                                {/* Action Buttons (Guaranteed single-line horizontal layout) */}
                                <div class="flex flex-1 items-center justify-end gap-1.5 py-1 sm:px-3 min-w-[165px] shrink-0">
                                  <Show
                                    when={
                                      !item.is_dir &&
                                      getFileCategory(item.name) !== 'archive' &&
                                      getFileCategory(item.name) !== 'other'
                                    }
                                  >
                                    <button
                                      onClick={() => openPreview(item)}
                                      class="mac-btn py-0.5 px-2 text-[11px]"
                                    >
                                      预览
                                    </button>
                                  </Show>

                                  <Show
                                    when={!item.is_dir && getFileCategory(item.name) === 'archive'}
                                  >
                                    <button
                                      onClick={() => openExtractModal(item)}
                                      class="mac-btn-primary py-0.5 px-2 text-[11px]"
                                    >
                                      解压
                                    </button>
                                  </Show>

                                  <a
                                    href={getDownloadUrl(activeSpace(), item.rel_path)}
                                    target="_blank"
                                    class="mac-btn py-0.5 px-2 text-[11px] no-underline"
                                  >
                                    {item.is_dir ? '下载(ZIP)' : '下载'}
                                  </a>

                                  <button
                                    onClick={() => handleDelete(item)}
                                    class="mac-btn py-0.5 px-2 text-[11px]"
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </div>
            </Show>

            {/* ====================================================================
                VIEW 2: Unified macOS System Settings View
               ==================================================================== */}
            <Show when={activeView() === 'settings'}>
              <div class="flex-1 flex flex-col overflow-hidden md-view-animate">
                {/* Settings Toolbar */}
                <div
                  data-tauri-drag-region
                  class={`mac-toolbar h-11 px-4 flex items-center justify-between gap-2 shrink-0 ${
                    sidebarCollapsed() && tauriActive() && macPlatform() ? 'pl-20' : ''
                  }`}
                >
                  <div class="flex items-center gap-2" data-tauri-drag-region>
                    <Show when={sidebarCollapsed()}>
                      <button
                        type="button"
                        onClick={() => setSidebarCollapsed(false)}
                        title="展开边栏"
                        class="mac-btn-ghost w-7 h-7 text-xs"
                      >
                        ◧
                      </button>
                    </Show>
                    <button
                      type="button"
                      onClick={() => setActiveView('files')}
                      class="mac-btn text-xs"
                    >
                      ‹ 返回文件
                    </button>
                    <span class="font-semibold text-xs sm:text-sm">设置</span>
                  </div>

                  {/* Settings Sub-Tab Segmented Control */}
                  <div class="mac-segmented overflow-x-auto">
                    <button
                      type="button"
                      onClick={() => setSettingsTab('general')}
                      class={`mac-segmented-item ${
                        settingsTab() === 'general' ? 'is-active' : ''
                      }`}
                    >
                      通用与外观
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettingsTab('macos')}
                      class={`mac-segmented-item ${
                        settingsTab() === 'macos' ? 'is-active' : ''
                      }`}
                    >
                      macOS 客户端
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettingsTab('transfers')}
                      class={`mac-segmented-item ${
                        settingsTab() === 'transfers' ? 'is-active' : ''
                      }`}
                    >
                      传输记录
                    </button>
                    <Show when={isAdmin()}>
                      <button
                        type="button"
                        onClick={() => setSettingsTab('admin')}
                        class={`mac-segmented-item ${
                          settingsTab() === 'admin' ? 'is-active' : ''
                        }`}
                      >
                        配额与存储池
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Settings Scrollable Content */}
                <div
                  class="flex-1 overflow-y-auto p-4 sm:p-6"
                  style={{ 'background-color': 'var(--mac-bg-canvas)' }}
                >
                  <div class="max-w-4xl mx-auto space-y-4">
                    {/* ============================================================
                        SETTINGS TAB 1: 通用与外观 (Appearance, Server & Account)
                       ============================================================ */}
                    <Show when={settingsTab() === 'general'}>
                      <div class="space-y-4 md-view-animate">
                        {/* Group 1: 外观模式 */}
                        <section class="mac-card p-4 sm:p-5 space-y-3.5">
                          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                              <h3 class="text-sm font-semibold">外观主题 (Appearance)</h3>
                              <p
                                class="text-xs mt-0.5"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                默认跟随 macOS 系统外观自动切换，也可手动固定白天或黑夜模式。
                              </p>
                            </div>
                            {renderThemeSegmentedControl()}
                          </div>

                          <div
                            class="pt-3 flex items-center justify-between text-xs"
                            style={{
                              'border-top': '1px solid var(--mac-divider)',
                              color: 'var(--mac-text-secondary)',
                            }}
                          >
                            <span>当前生效主题</span>
                            <span class="mac-badge-accent font-mono">
                              {themeMode() === 'system'
                                ? `跟随系统 (${resolvedAppearance() === 'dark' ? '黑夜' : '白天'})`
                                : themeMode() === 'dark'
                                ? '黑夜模式 (Dark)'
                                : '白天模式 (Light)'}
                            </span>
                          </div>
                        </section>

                        {/* Group 2: 服务器节点与传输通道 */}
                        <section class="mac-card p-4 sm:p-5 space-y-3.5">
                          <div class="flex items-center justify-between">
                            <div>
                              <h3 class="text-sm font-semibold">服务器连接与传输通道</h3>
                              <p
                                class="text-xs mt-0.5"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                多端连接到同一服务器地址即可自动实时同步文件与目录；默认优先走 P2P 直连通道。
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setServerProbe(null);
                                setEntryStep('welcome');
                              }}
                              class="mac-btn text-xs shrink-0"
                            >
                              打开欢迎向导
                            </button>
                          </div>

                          <form onSubmit={handleSaveServerEndpoint} class="space-y-3 text-xs">
                            <div class="flex flex-col sm:flex-row gap-2">
                              <input
                                type="text"
                                value={serverEndpointInput()}
                                onInput={(e) => setServerEndpointInput(e.currentTarget.value)}
                                placeholder="http://127.0.0.1:8080 或 https://drive.yourdomain.com"
                                class="mac-input flex-1 font-mono"
                              />
                              <button type="submit" class="mac-btn-primary shrink-0">
                                探测并切换节点
                              </button>
                            </div>

                            <div class="flex flex-wrap gap-2 font-mono text-[11px]">
                              <button
                                type="button"
                                onClick={() =>
                                  setServerEndpointInput('http://129.211.25.124:8080')
                                }
                                class="mac-btn text-[11px]"
                              >
                                云端测试服 (129.211.25.124:8080)
                              </button>
                              <button
                                type="button"
                                onClick={() => setServerEndpointInput('http://127.0.0.1:8080')}
                                class="mac-btn text-[11px]"
                              >
                                本机节点 (127.0.0.1:8080)
                              </button>
                            </div>

                            <Show when={serverProbe()}>
                              <div
                                class="p-2.5 rounded-[8px] font-mono text-[11px]"
                                style={{
                                  'background-color': 'var(--mac-bg-group)',
                                  border: '1px solid var(--mac-border)',
                                }}
                              >
                                <div>状态: {serverProbe()!.message}</div>
                                <div style={{ color: 'var(--mac-text-secondary)' }}>
                                  API 端点: {serverProbe()!.api_base_url}
                                </div>
                              </div>
                            </Show>
                          </form>

                          <div
                            class="pt-3 flex flex-wrap items-center justify-between gap-2 text-xs"
                            style={{ 'border-top': '1px solid var(--mac-divider)' }}
                          >
                            <span style={{ color: 'var(--mac-text-secondary)' }}>
                              默认传输通道 (macOS 默认 P2P 直连)
                            </span>
                            <div class="mac-segmented">
                              <button
                                type="button"
                                onClick={() => setTransportChannel('p2p-lan')}
                                class={`mac-segmented-item ${
                                  transportChannel() === 'p2p-lan' ? 'is-active' : ''
                                }`}
                              >
                                P2P 直连 ({rttMs()}ms)
                              </button>
                              <button
                                type="button"
                                onClick={() => setTransportChannel('cf-tunnel-web')}
                                class={`mac-segmented-item ${
                                  transportChannel() === 'cf-tunnel-web' ? 'is-active' : ''
                                }`}
                              >
                                服务器中继模式
                              </button>
                            </div>
                          </div>
                        </section>

                        {/* Group 3: 当前登录账号 */}
                        <section class="mac-card p-4 sm:p-5">
                          <div class="flex items-center justify-between">
                            <div>
                              <h3 class="text-sm font-semibold">当前账号</h3>
                              <p
                                class="text-xs mt-0.5 font-mono"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                {user()!.email} ·{' '}
                                {user()!.role === 'admin' ? '系统管理员' : '普通用户'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={handleLogout}
                              class="mac-btn text-xs"
                              style={{ color: '#ff453a' }}
                            >
                              退出登录
                            </button>
                          </div>
                        </section>
                      </div>
                    </Show>

                    {/* ============================================================
                        SETTINGS TAB 2: macOS 客户端
                       ============================================================ */}
                    <Show when={settingsTab() === 'macos'}>
                      <div class="space-y-4 md-view-animate">
                        <section class="mac-card p-4 sm:p-5 space-y-3.5">
                          <div class="flex items-center justify-between">
                            <div>
                              <h3 class="text-sm font-semibold">
                                Finder 本地磁盘挂载与 macOS 钥匙串
                              </h3>
                              <p
                                class="text-xs mt-0.5"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                通过本地环回 WebDAV 服务将云盘映射为 macOS 磁盘卷，无需 macFUSE 内核扩展。
                              </p>
                            </div>
                            <span class="mac-badge-accent font-mono">
                              {tauriActive() ? 'Tauri 原生壳' : 'Web 模式'}
                            </span>
                          </div>

                          <div
                            class="p-3 rounded-[8px] space-y-1.5 font-mono text-xs"
                            style={{
                              'background-color': 'var(--mac-bg-group)',
                              border: '1px solid var(--mac-border)',
                            }}
                          >
                            <div class="flex justify-between">
                              <span style={{ color: 'var(--mac-text-secondary)' }}>
                                本地 WebDAV 环回地址:
                              </span>
                              <span class="font-semibold">
                                {webdavMount()?.loopback_url || 'http://127.0.0.1:18085/'}
                              </span>
                            </div>
                            <div class="flex justify-between">
                              <span style={{ color: 'var(--mac-text-secondary)' }}>
                                Finder 目标挂载卷:
                              </span>
                              <span>{webdavMount()?.mount_point || '/Volumes/MayaDesk'}</span>
                            </div>
                            <div class="flex justify-between">
                              <span style={{ color: 'var(--mac-text-secondary)' }}>
                                钥匙串 ({keychainInfo()?.service || 'com.mayadesk.clouddrive'}):
                              </span>
                              <span>
                                {keychainInfo()?.has_token ? '✓ JWT 已加密托管' : '未存储令牌'}
                              </span>
                            </div>
                          </div>

                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleMountFinderWebdav(true)}
                                class="mac-btn-primary text-xs"
                              >
                                一键挂载至 macOS Finder
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMountFinderWebdav(false)}
                                class="mac-btn text-xs"
                              >
                                仅启动本地环回网关
                              </button>
                            </div>

                            <Show when={macConfig()}>
                              <label class="flex items-center gap-1.5 text-xs cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={macConfig()!.close_to_tray}
                                  onChange={async (e) => {
                                    const next = {
                                      ...macConfig()!,
                                      close_to_tray: e.currentTarget.checked,
                                    };
                                    setMacConfig(next);
                                    await saveMacClientConfig(next);
                                  }}
                                />
                                <span>关闭窗口时隐藏至后台 (⌘W)</span>
                              </label>
                            </Show>
                          </div>
                        </section>

                        <section class="mac-card p-4 sm:p-5 space-y-3">
                          <div>
                            <h3 class="text-sm font-semibold">
                              原生 4MB 分片 BLAKE3 硬件加速校验器
                            </h3>
                            <p
                              class="text-xs mt-0.5"
                              style={{ color: 'var(--mac-text-secondary)' }}
                            >
                              按 4MB 分片计算本地大文件 BLAKE3 哈希，用于 P2P 块级校验与跨盘秒传预检。
                            </p>
                          </div>

                          <div class="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={localHashTargetPath()}
                              onInput={(e) => setLocalHashTargetPath(e.currentTarget.value)}
                              placeholder="输入 Mac 本地文件绝对路径"
                              class="mac-input flex-1 min-w-[240px] font-mono"
                            />
                            <Show when={tauriActive()}>
                              <button
                                type="button"
                                onClick={() => handleInspectLocalBlake3(true)}
                                class="mac-btn text-xs"
                              >
                                选择文件...
                              </button>
                            </Show>
                            <button
                              type="button"
                              disabled={hashingLocalFile()}
                              onClick={() => handleInspectLocalBlake3(false)}
                              class="mac-btn-primary text-xs"
                            >
                              {hashingLocalFile() ? '计算中...' : '计算 4MB 分片指纹'}
                            </button>
                          </div>

                          <Show when={localHashReport()}>
                            <div
                              class="p-3 rounded-[8px] space-y-2 font-mono text-[11px] md-view-animate"
                              style={{
                                'background-color': 'var(--mac-bg-group)',
                                border: '1px solid var(--mac-border)',
                              }}
                            >
                              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                <div>
                                  <span style={{ color: 'var(--mac-text-muted)' }} class="block">
                                    文件名
                                  </span>
                                  <span class="font-semibold">{localHashReport()!.file_name}</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--mac-text-muted)' }} class="block">
                                    大小 / 4MB 块数
                                  </span>
                                  <span class="font-semibold">
                                    {formatBytes(localHashReport()!.size_bytes)} (
                                    {localHashReport()!.total_blocks} 块)
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--mac-text-muted)' }} class="block">
                                    耗时 / 吞吐率
                                  </span>
                                  <span class="font-semibold">
                                    {localHashReport()!.elapsed_ms}ms (
                                    {localHashReport()!.throughput_mbps} MB/s)
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--mac-text-muted)' }} class="block">
                                    短指纹
                                  </span>
                                  <span class="font-semibold">
                                    {localHashReport()!.blake3_short}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </Show>
                        </section>

                        <section class="mac-card p-4 sm:p-5 space-y-3">
                          <div>
                            <h3 class="text-sm font-semibold">
                              macOS 本地文件夹同步规则 (FSEvents)
                            </h3>
                            <p
                              class="text-xs mt-0.5"
                              style={{ color: 'var(--mac-text-secondary)' }}
                            >
                              自动忽略 .DS_Store、._* 与 node_modules。
                            </p>
                          </div>

                          <form
                            onSubmit={handleAddSyncRule}
                            class="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs items-end"
                          >
                            <div class="sm:col-span-5">
                              <span
                                class="text-[11px] block mb-1"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                本地文件夹路径
                              </span>
                              <div class="flex gap-1.5">
                                <input
                                  type="text"
                                  value={newSyncLocalPath()}
                                  onInput={(e) => setNewSyncLocalPath(e.currentTarget.value)}
                                  placeholder="~/Documents/Work"
                                  class="mac-input flex-1 font-mono"
                                />
                                <Show when={tauriActive()}>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      const folder = await pickMacOSPath(true);
                                      if (folder) setNewSyncLocalPath(folder);
                                    }}
                                    class="mac-btn shrink-0"
                                  >
                                    浏览
                                  </button>
                                </Show>
                              </div>
                            </div>

                            <div class="sm:col-span-2">
                              <span
                                class="text-[11px] block mb-1"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                目标空间
                              </span>
                              <select
                                value={newSyncSpace()}
                                onChange={(e) => setNewSyncSpace(e.currentTarget.value as any)}
                                class="mac-input w-full"
                              >
                                <option value="private">私人空间</option>
                                <option value="shared">共享空间</option>
                              </select>
                            </div>

                            <div class="sm:col-span-3">
                              <span
                                class="text-[11px] block mb-1"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                远端目录
                              </span>
                              <input
                                type="text"
                                value={newSyncRemotePath()}
                                onInput={(e) => setNewSyncRemotePath(e.currentTarget.value)}
                                placeholder="/MacSync"
                                class="mac-input w-full font-mono"
                              />
                            </div>

                            <div class="sm:col-span-2">
                              <button type="submit" class="mac-btn-primary w-full py-1.5">
                                + 添加
                              </button>
                            </div>
                          </form>

                          <Show when={macConfig() && macConfig()!.sync_folders.length > 0}>
                            <div class="space-y-1.5 pt-2">
                              <For each={macConfig()!.sync_folders}>
                                {(rule, idx) => (
                                  <div
                                    class="p-2.5 rounded-[8px] flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                                    style={{
                                      'background-color': 'var(--mac-bg-group)',
                                      border: '1px solid var(--mac-border)',
                                    }}
                                  >
                                    <div class="min-w-0 truncate">
                                      <span class="font-semibold">{rule.local_path}</span>
                                      <span class="mx-2" style={{ color: 'var(--mac-text-muted)' }}>
                                        →
                                      </span>
                                      <span class="mac-badge-accent">
                                        {rule.space === 'private' ? '私人' : '共享'}:
                                        {rule.remote_path}
                                      </span>
                                    </div>
                                    <div class="flex items-center gap-1.5 font-sans shrink-0">
                                      <Show when={tauriActive()}>
                                        <button
                                          type="button"
                                          onClick={() => revealPathInFinder(rule.local_path)}
                                          class="mac-btn py-0.5 px-2 text-[11px]"
                                        >
                                          在 Finder 中显示
                                        </button>
                                      </Show>
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          const next = structuredClone(macConfig()!);
                                          next.sync_folders.splice(idx(), 1);
                                          setMacConfig(next);
                                          await saveMacClientConfig(next);
                                        }}
                                        class="mac-btn py-0.5 px-2 text-[11px]"
                                      >
                                        移除
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </section>
                      </div>
                    </Show>

                    {/* ============================================================
                        SETTINGS TAB 3: 传输记录 (Compact Single-Line Table!)
                       ============================================================ */}
                    <Show when={settingsTab() === 'transfers'}>
                      <section class="mac-card overflow-hidden md-view-animate">
                        <div
                          class="px-4 py-3 flex items-center justify-between"
                          style={{ 'border-bottom': '1px solid var(--mac-border)' }}
                        >
                          <div>
                            <h3 class="text-sm font-semibold">文件传输审计记录</h3>
                            <p
                              class="text-xs mt-0.5"
                              style={{ color: 'var(--mac-text-secondary)' }}
                            >
                              记录所有文件上传、下载与传输通道状态。
                            </p>
                          </div>
                          <button onClick={loadTransferLogs} class="mac-btn text-xs">
                            刷新记录
                          </button>
                        </div>

                        <div class="overflow-x-auto">
                          <table class="w-full text-xs text-left border-collapse">
                            <thead class="mac-table-header">
                              <tr class="whitespace-nowrap">
                                <th class="py-2 px-3 w-36">时间</th>
                                <th class="py-2 px-3 w-44">用户</th>
                                <th class="py-2 px-2.5 w-16">类型</th>
                                <th class="py-2 px-3">文件名</th>
                                <th class="py-2 px-2.5 w-24">大小</th>
                                <th class="py-2 px-2.5 w-24">通道</th>
                                <th class="py-2 px-3 w-20 text-right">状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              <Show
                                when={transferLogs().length > 0}
                                fallback={
                                  <tr>
                                    <td
                                      colspan="7"
                                      class="p-8 text-center"
                                      style={{ color: 'var(--mac-text-muted)' }}
                                    >
                                      暂无传输记录
                                    </td>
                                  </tr>
                                }
                              >
                                <For each={transferLogs()}>
                                  {(log) => (
                                    <tr class="mac-table-row font-mono text-[11px] whitespace-nowrap">
                                      <td
                                        class="py-1.5 px-3 whitespace-nowrap"
                                        style={{ color: 'var(--mac-text-secondary)' }}
                                      >
                                        {formatTime(log.created_at)}
                                      </td>
                                      <td class="py-1.5 px-3 whitespace-nowrap truncate max-w-[180px]">
                                        {log.user_email}
                                      </td>
                                      <td class="py-1.5 px-2.5 whitespace-nowrap">
                                        <span
                                          class={
                                            log.action === 'upload'
                                              ? 'mac-badge-accent'
                                              : 'mac-badge'
                                          }
                                        >
                                          {log.action === 'upload' ? '上传' : '下载'}
                                        </span>
                                      </td>
                                      <td class="py-1.5 px-3 font-sans truncate max-w-[260px]">
                                        {log.file_name}
                                      </td>
                                      <td
                                        class="py-1.5 px-2.5 whitespace-nowrap"
                                        style={{ color: 'var(--mac-text-secondary)' }}
                                      >
                                        {formatBytes(log.size_bytes)}
                                      </td>
                                      <td class="py-1.5 px-2.5 whitespace-nowrap">
                                        <span
                                          class={
                                            log.channel === 'p2p'
                                              ? 'mac-badge-accent'
                                              : 'mac-badge'
                                          }
                                        >
                                          {log.channel === 'p2p' ? 'P2P直连' : '服务器中继'}
                                        </span>
                                      </td>
                                      <td class="py-1.5 px-3 whitespace-nowrap text-right">
                                        {log.status === 'success' ? '✓ 成功' : '✕ 失败'}
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </Show>
                            </tbody>
                          </table>
                        </div>
                      </section>
                    </Show>

                    {/* ============================================================
                        SETTINGS TAB 4: 配额与存储池 (Admin Only)
                       ============================================================ */}
                    <Show when={settingsTab() === 'admin' && isAdmin()}>
                      <div class="space-y-4 md-view-animate">
                        {/* User Quota Management */}
                        <section class="mac-card overflow-hidden">
                          <div
                            class="px-4 py-3 flex items-center justify-between"
                            style={{ 'border-bottom': '1px solid var(--mac-border)' }}
                          >
                            <div>
                              <h3 class="text-sm font-semibold">用户存储配额管理</h3>
                              <p
                                class="text-xs mt-0.5"
                                style={{ color: 'var(--mac-text-secondary)' }}
                              >
                                新注册用户初始配额为 0 B，需管理员分配配额后方可上传文件。
                              </p>
                            </div>
                            <button onClick={loadAdminUsers} class="mac-btn text-xs">
                              刷新列表
                            </button>
                          </div>

                          <div class="overflow-x-auto">
                            <table class="w-full text-xs text-left border-collapse">
                              <thead class="mac-table-header">
                                <tr class="whitespace-nowrap">
                                  <th class="py-2 px-3">用户邮箱</th>
                                  <th class="py-2 px-3">角色</th>
                                  <th class="py-2 px-3">已用空间</th>
                                  <th class="py-2 px-3">当前配额</th>
                                  <th class="py-2 px-3">调整配额 (GB)</th>
                                  <th class="py-2 px-3 text-right">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={adminUsers()}>
                                  {(u) => (
                                    <tr class="mac-table-row whitespace-nowrap">
                                      <td class="py-1.5 px-3 font-medium">{u.email}</td>
                                      <td class="py-1.5 px-3">
                                        <span class="mac-badge">
                                          {u.role === 'admin' ? '管理员' : '普通用户'}
                                        </span>
                                      </td>
                                      <td class="py-1.5 px-3 font-mono">
                                        {formatBytes(u.used_bytes)}
                                      </td>
                                      <td class="py-1.5 px-3 font-mono">
                                        {u.role === 'admin'
                                          ? '无限'
                                          : u.quota_bytes > 0
                                          ? formatBytes(u.quota_bytes)
                                          : '0 B'}
                                      </td>
                                      <td class="py-1.5 px-3">
                                        <input
                                          type="number"
                                          min="0"
                                          value={editingQuotas()[u.id] ?? 0}
                                          onInput={(e) => {
                                            const val = Number(e.currentTarget.value);
                                            setEditingQuotas((prev) => ({
                                              ...prev,
                                              [u.id]: val,
                                            }));
                                          }}
                                          class="mac-input w-20 font-mono py-1"
                                        />
                                        <span
                                          class="ml-1"
                                          style={{ color: 'var(--mac-text-muted)' }}
                                        >
                                          GB
                                        </span>
                                      </td>
                                      <td class="py-1.5 px-3 text-right">
                                        <button
                                          onClick={() => handleSaveUserQuota(u.id)}
                                          class="mac-btn-primary py-1 px-2.5 text-xs"
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
                        </section>

                        {/* Storage Pools & Cloudflare Tunnel */}
                        <Show when={sysConfig()}>
                          <section class="mac-card p-4 sm:p-5 space-y-4">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <h3 class="text-sm font-semibold">NAS 物理硬盘挂载池与隧道配置</h3>
                                <p
                                  class="text-xs mt-0.5"
                                  style={{ color: 'var(--mac-text-secondary)' }}
                                >
                                  管理物理硬盘挂载路径与 Cloudflare Tunnel 穿透令牌。
                                </p>
                              </div>
                              <div class="flex items-center gap-2">
                                <button
                                  onClick={() => openFsExplorer()}
                                  class="mac-btn text-xs"
                                >
                                  浏览服务器路径
                                </button>
                                <button
                                  onClick={() => setShowInitDiskModal(true)}
                                  class="mac-btn text-xs"
                                >
                                  + 添加存储盘
                                </button>
                                <button
                                  onClick={handleSaveConfig}
                                  class="mac-btn-primary text-xs"
                                >
                                  保存配置
                                </button>
                              </div>
                            </div>

                            <div class="space-y-2">
                              <For each={sysConfig()!.storage.pools}>
                                {(pool, idx) => (
                                  <div
                                    class="p-2.5 rounded-[8px] text-xs grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
                                    style={{
                                      'background-color': 'var(--mac-bg-group)',
                                      border: '1px solid var(--mac-border)',
                                    }}
                                  >
                                    <div class="sm:col-span-3 font-semibold truncate">
                                      {pool.name}
                                    </div>
                                    <div class="sm:col-span-2">
                                      <span class="mac-badge">
                                        {pool.pool_type === 'private' ? '私人空间' : '共享空间'}
                                      </span>
                                    </div>
                                    <div class="sm:col-span-4 font-mono truncate">
                                      {pool.mount_path}
                                    </div>
                                    <div class="sm:col-span-2 font-mono">{pool.quota_gb} GB</div>
                                    <div class="sm:col-span-1 text-right">
                                      <button
                                        onClick={() => {
                                          const c = structuredClone(sysConfig()!);
                                          c.storage.pools.splice(idx(), 1);
                                          setSysConfig(c);
                                        }}
                                        class="mac-btn py-0.5 px-2 text-[11px]"
                                      >
                                        移除
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>

                            <div
                              class="pt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs"
                              style={{ 'border-top': '1px solid var(--mac-divider)' }}
                            >
                              <label class="block space-y-1">
                                <span class="font-medium">Cloudflare Tunnel Token</span>
                                <input
                                  type="password"
                                  placeholder="eyJhIjoi..."
                                  value={sysConfig()!.network.cloudflare_tunnel.tunnel_token}
                                  onInput={(e) => {
                                    const c = structuredClone(sysConfig()!);
                                    c.network.cloudflare_tunnel.tunnel_token =
                                      e.currentTarget.value;
                                    setSysConfig(c);
                                  }}
                                  class="mac-input w-full font-mono"
                                />
                              </label>
                              <label class="block space-y-1">
                                <span class="font-medium">STUN 打洞服务器</span>
                                <input
                                  type="text"
                                  value={sysConfig()!.network.stun_servers.join(',')}
                                  onInput={(e) => {
                                    const c = structuredClone(sysConfig()!);
                                    c.network.stun_servers = e.currentTarget.value
                                      .split(',')
                                      .map((s) => s.trim());
                                    setSysConfig(c);
                                  }}
                                  class="mac-input w-full font-mono"
                                />
                              </label>
                            </div>
                          </section>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>

            {/* Subtle macOS Finder Bottom Status Bar */}
            <footer
              class="h-7 px-4 flex items-center justify-between text-[11px] font-mono shrink-0"
              style={{
                'background-color': 'var(--mac-bg-window)',
                'border-top': '1px solid var(--mac-border)',
                color: 'var(--mac-text-secondary)',
              }}
            >
              <div class="truncate">{statusMessage()}</div>
              <div class="truncate hidden sm:block">
                {activeSpace() === 'private' ? '私人空间' : '共享空间'} ·{' '}
                {transportChannel() === 'p2p-lan' ? `P2P 直连 (${rttMs()}ms)` : '中继通道'} · ⌘, 设置
              </div>
            </footer>
          </main>
        </div>
      </Show>

      {/* Initial Disk Setup Modal */}
      <Show when={showInitDiskModal()}>
        <div class="fixed inset-0 bg-black/45 flex items-center justify-center p-4 z-50 md-backdrop-animate">
          <div class="w-full max-w-md mac-modal p-5 space-y-4 md-modal-animate">
            <div
              class="flex items-center justify-between pb-2.5"
              style={{ 'border-bottom': '1px solid var(--mac-border)' }}
            >
              <h3 class="font-semibold text-sm">配置存储硬盘路径</h3>
              <button onClick={() => setShowInitDiskModal(false)} class="mac-btn text-xs">
                关闭
              </button>
            </div>

            <form onSubmit={handleInitDiskSubmit} class="space-y-3.5 text-xs">
              <p class="text-[11px]" style={{ color: 'var(--mac-text-secondary)' }}>
                输入服务器物理存储路径。系统将自动在该目录下隔离构建私人空间与共享空间。
              </p>

              <label class="block space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="font-medium">存储盘物理路径 (必填)</span>
                  <button
                    type="button"
                    onClick={() => openFsExplorer(initMountPath())}
                    class="mac-btn py-0.5 px-2 text-[11px]"
                  >
                    从根目录 (/) 浏览...
                  </button>
                </div>
                <input
                  type="text"
                  required
                  placeholder="例如：/data/storage 或 /mnt/nas_disk"
                  value={initMountPath()}
                  onInput={(e) => setInitMountPath(e.currentTarget.value)}
                  class="mac-input w-full font-mono"
                />
              </label>

              <label class="block space-y-1.5">
                <span class="font-medium">空间用途</span>
                <select
                  value={initPoolType()}
                  onChange={(e) => setInitPoolType(e.currentTarget.value as any)}
                  class="mac-input w-full"
                >
                  <option value="both">同时支持私人空间与共享空间 (推荐)</option>
                  <option value="private">仅私人空间</option>
                  <option value="shared">仅共享空间</option>
                </select>
              </label>

              <div class="grid grid-cols-2 gap-2.5">
                <label class="block space-y-1">
                  <span class="font-medium">硬盘显示名称</span>
                  <input
                    type="text"
                    placeholder="留空自动命名"
                    value={initDiskName()}
                    onInput={(e) => setInitDiskName(e.currentTarget.value)}
                    class="mac-input w-full"
                  />
                </label>
                <label class="block space-y-1">
                  <span class="font-medium">容量上限 (GB)</span>
                  <input
                    type="number"
                    min="1"
                    value={initQuotaGb()}
                    onInput={(e) => setInitQuotaGb(Number(e.currentTarget.value))}
                    class="mac-input w-full font-mono"
                  />
                </label>
              </div>

              <button type="submit" class="mac-btn-primary w-full py-2 font-semibold">
                保存并初始化存储空间
              </button>
            </form>
          </div>
        </div>
      </Show>

      {/* Physical Path Manager Modal (Scrollable Directory List Fixed!) */}
      <Show when={showFsExplorerModal()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center p-3 sm:p-6 z-[60] md-backdrop-animate">
          <div class="w-full max-w-2xl mac-modal p-5 flex flex-col max-h-[85vh] space-y-3 md-modal-animate">
            <div
              class="flex items-center justify-between pb-2.5 shrink-0"
              style={{ 'border-bottom': '1px solid var(--mac-border)' }}
            >
              <div>
                <h3 class="font-semibold text-sm">服务器物理路径管理器 (根目录 /)</h3>
                <p class="text-[11px]" style={{ color: 'var(--mac-text-secondary)' }}>
                  上下滚动浏览服务器磁盘目录结构，点击目录名进入下一级，或点击右侧「选取」。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFsExplorerModal(false)}
                class="mac-btn text-xs"
              >
                关闭
              </button>
            </div>

            {/* Path Input & Controls */}
            <div class="flex flex-wrap items-center gap-2 text-xs shrink-0">
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
                class="mac-input flex-1 min-w-[180px] font-mono"
                placeholder="/"
              />
              <button
                type="button"
                onClick={() => loadFsDirectory(fsInputPath())}
                class="mac-btn text-xs"
              >
                跳转
              </button>
              <button
                type="button"
                disabled={!fsParentPath() || fsCurrentPath() === '/'}
                onClick={() => fsParentPath() && loadFsDirectory(fsParentPath()!)}
                class="mac-btn text-xs"
              >
                ‹ 上级
              </button>
              <button
                type="button"
                onClick={() => setShowFsMkdirInput(!showFsMkdirInput())}
                class="mac-btn text-xs"
              >
                {showFsMkdirInput() ? '取消新建' : '+ 新建子目录'}
              </button>
            </div>

            {/* Breadcrumbs */}
            <div class="flex items-center gap-1 overflow-x-auto py-1 text-xs font-mono shrink-0">
              <For each={fsBreadcrumbs()}>
                {(crumb, idx) => (
                  <div class="flex items-center shrink-0">
                    <button
                      type="button"
                      onClick={() => loadFsDirectory(crumb.path)}
                      class={
                        crumb.path === fsCurrentPath()
                          ? 'mac-badge-accent cursor-pointer'
                          : 'mac-btn-ghost py-0.5 px-1.5 text-[11px]'
                      }
                    >
                      {crumb.name}
                    </button>
                    <Show when={idx() < fsBreadcrumbs().length - 1}>
                      <span class="mx-0.5" style={{ color: 'var(--mac-text-muted)' }}>
                        /
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <Show when={showFsMkdirInput()}>
              <div
                class="p-2.5 rounded-[8px] flex items-center gap-2 text-xs shrink-0 md-view-animate"
                style={{
                  'background-color': 'var(--mac-bg-group)',
                  border: '1px solid var(--mac-border)',
                }}
              >
                <span class="font-medium shrink-0">新建目录:</span>
                <input
                  type="text"
                  placeholder="输入子目录名称 (如 nas_storage)"
                  value={fsNewFolderName()}
                  onInput={(e) => setFsNewFolderName(e.currentTarget.value)}
                  class="mac-input flex-1 font-mono"
                />
                <button type="button" onClick={handleFsCreateSubdir} class="mac-btn-primary">
                  创建并进入
                </button>
              </div>
            </Show>

            <Show when={fsError()}>
              <div
                class="p-2.5 rounded-[8px] text-xs font-mono shrink-0"
                style={{ 'background-color': 'rgba(255, 59, 48, 0.12)', color: '#ff453a' }}
              >
                错误: {fsError()}
              </div>
            </Show>

            {/* Scrollable Directory List Container (mac-scroll-area ensures smooth wheel/trackpad scrolling) */}
            <div
              class="mac-scroll-area mac-card flex-1 min-h-[220px] max-h-[340px]"
              style={{ 'overflow-y': 'auto' }}
            >
              <Show
                when={!fsLoading()}
                fallback={
                  <div
                    class="p-8 text-center text-xs font-mono"
                    style={{ color: 'var(--mac-text-muted)' }}
                  >
                    正在读取服务器物理目录...
                  </div>
                }
              >
                <Show
                  when={fsDirs().length > 0}
                  fallback={
                    <div
                      class="p-8 text-center text-xs"
                      style={{ color: 'var(--mac-text-muted)' }}
                    >
                      当前目录下没有子目录，可直接点击下方按钮选取此路径。
                    </div>
                  }
                >
                  <table class="w-full text-left text-xs border-collapse">
                    <thead class="mac-table-header sticky top-0 z-10">
                      <tr>
                        <th class="py-1.5 px-3">子目录名称</th>
                        <th class="py-1.5 px-3">完整路径</th>
                        <th class="py-1.5 px-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody class="font-mono">
                      <For each={fsDirs()}>
                        {(dir) => (
                          <tr class="mac-table-row">
                            <td class="py-1.5 px-3 font-semibold">
                              <button
                                type="button"
                                onClick={() => loadFsDirectory(dir.path)}
                                class="hover:underline cursor-pointer flex items-center gap-1.5"
                                style={{ color: 'var(--mac-accent-text)' }}
                              >
                                <span class="mac-badge text-[10px]">DIR</span>
                                <span>{dir.name}</span>
                              </button>
                            </td>
                            <td
                              class="py-1.5 px-3 truncate max-w-[240px]"
                              style={{ color: 'var(--mac-text-secondary)' }}
                            >
                              {dir.path}
                            </td>
                            <td class="py-1.5 px-3 text-right space-x-1.5 font-sans">
                              <button
                                type="button"
                                onClick={() => loadFsDirectory(dir.path)}
                                class="mac-btn py-0.5 px-2 text-[11px]"
                              >
                                进入
                              </button>
                              <button
                                type="button"
                                onClick={() => handleFsSelectPath(dir.path)}
                                class="mac-btn-primary py-0.5 px-2 text-[11px]"
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

            <div
              class="pt-3 flex flex-wrap items-center justify-between gap-3 shrink-0"
              style={{ 'border-top': '1px solid var(--mac-border)' }}
            >
              <div class="text-xs truncate">
                <span style={{ color: 'var(--mac-text-secondary)' }}>当前路径: </span>
                <span class="font-mono font-semibold">{fsCurrentPath()}</span>
              </div>
              <button
                type="button"
                onClick={() => handleFsSelectPath(fsCurrentPath())}
                class="mac-btn-primary text-xs"
              >
                选取此路径作为存储盘: {fsCurrentPath()}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* File Preview Modal */}
      <Show when={previewItem()}>
        <div class="fixed inset-0 bg-black/60 flex items-center justify-center p-3 sm:p-6 z-[70] md-backdrop-animate">
          <div class="w-full max-w-4xl mac-modal p-4 sm:p-5 flex flex-col max-h-[92vh] space-y-3 md-modal-animate">
            <div
              class="flex items-center justify-between pb-2.5"
              style={{ 'border-bottom': '1px solid var(--mac-border)' }}
            >
              <div class="flex items-center gap-2 min-w-0 pr-3">
                <span class="mac-badge-accent font-mono">
                  {previewCategory().toUpperCase()}
                </span>
                <span class="font-semibold text-sm truncate font-mono">
                  {previewItem()!.name}
                </span>
                <span
                  class="text-xs shrink-0 font-mono"
                  style={{ color: 'var(--mac-text-muted)' }}
                >
                  ({formatBytes(previewItem()!.size_bytes)})
                </span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <a
                  href={getDownloadUrl(activeSpace(), previewItem()!.rel_path)}
                  target="_blank"
                  class="mac-btn text-xs no-underline"
                >
                  下载
                </a>
                <button type="button" onClick={closePreview} class="mac-btn-primary text-xs">
                  关闭
                </button>
              </div>
            </div>

            <div class="flex-1 overflow-auto flex flex-col items-center justify-center min-h-[250px]">
              <Show when={previewCategory() === 'image'}>
                <div class="max-h-[75vh] w-full flex items-center justify-center p-2 rounded-[8px]">
                  <img
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    alt={previewItem()!.name}
                    class="max-h-[70vh] max-w-full object-contain rounded-[6px]"
                  />
                </div>
              </Show>

              <Show when={previewCategory() === 'video'}>
                <div class="w-full flex flex-col items-center justify-center bg-black rounded-[8px] p-1">
                  <video
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    controls
                    autoplay
                    class="max-h-[70vh] max-w-full rounded-[6px]"
                  />
                </div>
              </Show>

              <Show when={previewCategory() === 'audio'}>
                <div class="w-full max-w-lg p-6 mac-card text-center space-y-4 my-auto">
                  <div class="font-semibold text-sm">{previewItem()!.name}</div>
                  <audio
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    controls
                    autoplay
                    class="w-full"
                  />
                </div>
              </Show>

              <Show when={previewCategory() === 'pdf'}>
                <div class="w-full h-[75vh] mac-card">
                  <iframe
                    src={getPreviewUrl(activeSpace(), previewItem()!.rel_path, token())}
                    class="w-full h-full border-0"
                    title={previewItem()!.name}
                  />
                </div>
              </Show>

              <Show when={previewCategory() === 'code'}>
                <div class="w-full flex-1 flex flex-col min-h-[350px] max-h-[75vh] mac-card">
                  <div
                    class="flex items-center justify-between px-3 py-2 text-xs"
                    style={{
                      'background-color': 'var(--mac-bg-group)',
                      'border-bottom': '1px solid var(--mac-border)',
                    }}
                  >
                    <span class="font-mono" style={{ color: 'var(--mac-text-secondary)' }}>
                      {previewContent()
                        ? `${previewContent().split('\n').length} 行`
                        : '加载中...'}
                    </span>
                    <div class="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewWrap(!previewWrap())}
                        class="mac-btn py-0.5 px-2 text-[11px]"
                      >
                        {previewWrap() ? '不自动换行' : '自动换行'}
                      </button>
                      <button
                        type="button"
                        onClick={copyCodeContent}
                        class="mac-btn-primary py-0.5 px-2 text-[11px]"
                      >
                        {copySuccess() ? '已复制' : '复制全部'}
                      </button>
                    </div>
                  </div>

                  <Show
                    when={!previewLoading()}
                    fallback={
                      <div
                        class="p-8 text-center text-xs font-mono"
                        style={{ color: 'var(--mac-text-muted)' }}
                      >
                        正在加载代码内容...
                      </div>
                    }
                  >
                    <div class="flex-1 overflow-auto flex font-mono text-xs">
                      <div
                        class="select-none py-3 px-2.5 text-right shrink-0 font-mono leading-relaxed"
                        style={{
                          'background-color': 'var(--mac-bg-group)',
                          color: 'var(--mac-text-muted)',
                          'border-right': '1px solid var(--mac-border)',
                        }}
                      >
                        <For each={previewContent().split('\n')}>
                          {(_, idx) => <div>{idx() + 1}</div>}
                        </For>
                      </div>
                      <pre
                        class={`p-3 font-mono leading-relaxed flex-1 focus:outline-none ${
                          previewWrap()
                            ? 'whitespace-pre-wrap break-all'
                            : 'whitespace-pre overflow-x-auto'
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
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[70] md-backdrop-animate">
          <div class="w-full max-w-md mac-modal p-5 space-y-4 md-modal-animate">
            <div
              class="flex items-center justify-between pb-2.5"
              style={{ 'border-bottom': '1px solid var(--mac-border)' }}
            >
              <h3 class="font-semibold text-sm">远程解压压缩包</h3>
              <button
                type="button"
                onClick={() => setExtractItem(null)}
                class="mac-btn text-xs"
              >
                关闭
              </button>
            </div>

            <div class="space-y-3 text-xs">
              <div
                class="p-2.5 rounded-[8px] font-mono"
                style={{
                  'background-color': 'var(--mac-bg-group)',
                  border: '1px solid var(--mac-border)',
                }}
              >
                <span class="block text-[11px]" style={{ color: 'var(--mac-text-muted)' }}>
                  压缩包文件:
                </span>
                <span class="font-semibold">{extractItem()!.name}</span>
              </div>

              <div class="space-y-2">
                <span class="font-medium block">解压目标位置:</span>

                <label
                  class="flex items-start gap-2 p-2.5 rounded-[8px] cursor-pointer"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <input
                    type="radio"
                    name="extract_option"
                    checked={extractDestOption() === 'folder'}
                    onChange={() => setExtractDestOption('folder')}
                    class="mt-0.5"
                  />
                  <div>
                    <span class="font-semibold block">解压到同名子文件夹 (推荐)</span>
                    <span class="text-[11px] font-mono" style={{ color: 'var(--mac-text-muted)' }}>
                      {currentPath() === '/' ? '' : currentPath()}/
                      {extractItem()!.name.replace(/\.(tar\.gz|tgz|zip|tar|gz)$/i, '')}/
                    </span>
                  </div>
                </label>

                <label
                  class="flex items-start gap-2 p-2.5 rounded-[8px] cursor-pointer"
                  style={{
                    'background-color': 'var(--mac-bg-group)',
                    border: '1px solid var(--mac-border)',
                  }}
                >
                  <input
                    type="radio"
                    name="extract_option"
                    checked={extractDestOption() === 'current'}
                    onChange={() => setExtractDestOption('current')}
                    class="mt-0.5"
                  />
                  <div>
                    <span class="font-semibold block">解压到当前目录</span>
                    <span class="text-[11px] font-mono" style={{ color: 'var(--mac-text-muted)' }}>
                      {currentPath()}
                    </span>
                  </div>
                </label>
              </div>

              <div
                class="flex items-center justify-end gap-2 pt-3"
                style={{ 'border-top': '1px solid var(--mac-border)' }}
              >
                <button
                  type="button"
                  onClick={() => setExtractItem(null)}
                  class="mac-btn"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={extractLoading()}
                  onClick={handleExecuteExtract}
                  class="mac-btn-primary"
                >
                  {extractLoading() ? '正在解压...' : '开始解压'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
