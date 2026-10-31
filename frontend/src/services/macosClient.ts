/**
 * MayaDesk macOS Client Native Bridge (Tauri v2 IPC + Web Fallback)
 * Uses window.__TAURI_INTERNALS__.invoke directly so no extra npm bundle bloat is required.
 */

export interface SyncFolderRule {
  id: string;
  local_path: string;
  space: 'private' | 'shared';
  remote_path: string;
  enabled: boolean;
  last_sync_iso?: string | null;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface MacClientConfig {
  onboarding_completed?: boolean;
  theme_mode?: ThemeMode;
  server_url: string;
  lan_direct_url?: string | null;
  prefer_p2p_lan: boolean;
  close_to_tray: boolean;
  webdav_port: number;
  finder_mount_point: string;
  cache_limit_gb: number;
  sync_folders: SyncFolderRule[];
}

export interface ServerProbeResult {
  reachable: boolean;
  normalized_url: string;
  api_base_url: string;
  rtt_ms: number;
  mode: string;
  message: string;
}

export interface KeychainStatus {
  service: string;
  account: string;
  has_token: boolean;
  backend: string;
}

export interface MountStatus {
  loopback_running: boolean;
  loopback_url: string;
  finder_mounted: boolean;
  mount_point: string;
  message: string;
}

export interface BlockDigestEntry {
  block_index: number;
  offset_bytes: number;
  byte_len: number;
  blake3_hex: string;
  blake3_prefix: string;
}

export interface LocalFileBlake3Report {
  path: string;
  file_name: string;
  size_bytes: number;
  total_blocks: number;
  full_blake3_hex: string;
  blake3_short: string;
  elapsed_ms: number;
  throughput_mbps: number;
  blocks: BlockDigestEntry[];
}

export interface NativeUploadResult {
  file_name: string;
  local_path: string;
  remote_space: string;
  remote_path: string;
  size_bytes: number;
  total_chunks: number;
  blake3_short: string;
  elapsed_ms: number;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
    };
  }
}

const LOCAL_MAC_CONFIG_KEY = 'mayadesk_macos_client_config';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__?.invoke);
}

export function isMacOSPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh|Mac OS X|MacIntel|MacPPC|Mac68K/i.test(navigator.userAgent);
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (!window.__TAURI_INTERNALS__?.invoke) {
    throw new Error(`当前运行在浏览器模式，原生命令 ${cmd} 仅在 macOS 客户端壳内可用`);
  }
  return window.__TAURI_INTERNALS__.invoke<T>(cmd, args);
}

function getDefaultConfig(): MacClientConfig {
  const savedServer = localStorage.getItem('mayadesk_server_url') || window.location.origin;
  const onboarded = localStorage.getItem('mayadesk_mac_onboarded') === 'true';
  const savedTheme = (localStorage.getItem('mayadesk_theme_mode') as ThemeMode) || 'system';
  return {
    onboarding_completed: onboarded,
    theme_mode: savedTheme,
    server_url: savedServer,
    lan_direct_url: 'http://127.0.0.1:8080',
    prefer_p2p_lan: true,
    close_to_tray: true,
    webdav_port: 18085,
    finder_mount_point: '/Volumes/MayaDesk',
    cache_limit_gb: 4,
    sync_folders: [
      {
        id: 'sync_default_01',
        local_path: '~/Downloads/MayaDeskSync',
        space: 'private',
        remote_path: '/MacSync',
        enabled: false,
        last_sync_iso: null,
      },
    ],
  };
}

export async function getMacClientConfig(): Promise<MacClientConfig> {
  if (isTauriRuntime()) {
    try {
      return await tauriInvoke<MacClientConfig>('get_macos_client_config');
    } catch {
      // Fallback
    }
  }
  try {
    const raw = localStorage.getItem(LOCAL_MAC_CONFIG_KEY);
    if (raw) {
      return JSON.parse(raw) as MacClientConfig;
    }
  } catch {
    // ignore
  }
  return getDefaultConfig();
}

export async function saveMacClientConfig(config: MacClientConfig): Promise<MacClientConfig> {
  localStorage.setItem(LOCAL_MAC_CONFIG_KEY, JSON.stringify(config));
  if (isTauriRuntime()) {
    return await tauriInvoke<MacClientConfig>('save_macos_client_config', { config });
  }
  return config;
}

export async function setMacOSWindowTheme(themeMode: ThemeMode): Promise<void> {
  localStorage.setItem('mayadesk_theme_mode', themeMode);
  if (isTauriRuntime()) {
    try {
      await tauriInvoke<void>('set_macos_window_theme', { themeMode });
    } catch {
      // ignore
    }
  }
}

export async function probeAndSaveServer(serverUrl: string): Promise<ServerProbeResult> {
  if (isTauriRuntime()) {
    return await tauriInvoke<ServerProbeResult>('probe_and_save_server', {
      serverUrl,
    });
  }

  // Web mode probe fallback
  const trimmed = serverUrl.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const normalized = trimmed || window.location.origin;
  const apiBase = `${normalized}/api/v1`;
  const start = performance.now();
  try {
    const res = await fetch(`${apiBase}/disks`);
    const rtt = Math.max(1, Math.round(performance.now() - start));
    const isLan =
      normalized.includes('127.0.0.1') ||
      normalized.includes('localhost') ||
      normalized.includes('192.168.') ||
      normalized.includes('.local');
    return {
      reachable: res.ok || res.status === 401,
      normalized_url: normalized,
      api_base_url: apiBase,
      rtt_ms: rtt,
      mode: isLan ? 'p2p-lan' : 'cf-tunnel-web',
      message: `连接就绪 (HTTP ${res.status}, RTT ${rtt} ms)`,
    };
  } catch (err: any) {
    return {
      reachable: false,
      normalized_url: normalized,
      api_base_url: apiBase,
      rtt_ms: 0,
      mode: 'offline',
      message: `无法连接服务器: ${err?.message || '网络不可达'}`,
    };
  }
}

export async function keychainSetToken(
  account: string,
  token: string
): Promise<KeychainStatus> {
  if (isTauriRuntime()) {
    return await tauriInvoke<KeychainStatus>('keychain_set_token', { account, token });
  }
  return {
    service: 'com.mayadesk.clouddrive',
    account,
    has_token: Boolean(token),
    backend: 'Web LocalStorage (macOS Keychain requires Tauri App)',
  };
}

export async function keychainGetToken(account: string): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      return await tauriInvoke<string | null>('keychain_get_token', { account });
    } catch {
      return null;
    }
  }
  return localStorage.getItem('mayadesk_token');
}

export async function keychainDeleteToken(account: string): Promise<KeychainStatus> {
  if (isTauriRuntime()) {
    return await tauriInvoke<KeychainStatus>('keychain_delete_token', { account });
  }
  return {
    service: 'com.mayadesk.clouddrive',
    account,
    has_token: false,
    backend: 'Web LocalStorage',
  };
}

export async function keychainGetStatus(account: string): Promise<KeychainStatus> {
  if (isTauriRuntime()) {
    try {
      return await tauriInvoke<KeychainStatus>('keychain_get_status', { account });
    } catch {
      // ignore
    }
  }
  return {
    service: 'com.mayadesk.clouddrive',
    account,
    has_token: Boolean(localStorage.getItem('mayadesk_token')),
    backend: isTauriRuntime()
      ? 'macOS Keychain Services (/usr/bin/security)'
      : 'Web LocalStorage (在 macOS 客户端中自动启用系统钥匙串)',
  };
}

export async function startWebdavBridge(openFinder: boolean): Promise<MountStatus> {
  if (isTauriRuntime()) {
    return await tauriInvoke<MountStatus>('start_webdav_bridge', { openFinder });
  }
  return {
    loopback_running: false,
    loopback_url: 'http://127.0.0.1:18085/',
    finder_mounted: false,
    mount_point: '/Volumes/MayaDesk',
    message: '浏览器沙箱不支持本地环回端口监听，请使用 Tauri macOS 客户端启动 Finder 挂载',
  };
}

export async function getWebdavStatus(): Promise<MountStatus> {
  if (isTauriRuntime()) {
    try {
      return await tauriInvoke<MountStatus>('get_webdav_status');
    } catch {
      // ignore
    }
  }
  return {
    loopback_running: false,
    loopback_url: 'http://127.0.0.1:18085/',
    finder_mounted: false,
    mount_point: '/Volumes/MayaDesk',
    message: '在 macOS 客户端运行后自动启动 127.0.0.1:18085 本地 WebDAV 环回服务',
  };
}

export async function pickMacOSPath(chooseFolder: boolean): Promise<string | null> {
  if (isTauriRuntime()) {
    return await tauriInvoke<string | null>('pick_macos_path', { chooseFolder });
  }
  return null;
}

export async function revealPathInFinder(localPath: string): Promise<void> {
  if (isTauriRuntime()) {
    await tauriInvoke<void>('reveal_path_in_finder', { localPath });
  }
}

export async function hashLocalFileBlake3(
  localPath: string
): Promise<LocalFileBlake3Report> {
  return await tauriInvoke<LocalFileBlake3Report>('hash_local_file_blake3', {
    localPath,
  });
}

export async function nativeUploadLocalFile(
  space: string,
  remoteDir: string,
  localPath: string,
  token?: string | null
): Promise<NativeUploadResult> {
  return await tauriInvoke<NativeUploadResult>('native_upload_file', {
    space,
    remoteDir,
    localPath,
    token: token || null,
  });
}
