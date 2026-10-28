export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

export interface AuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  auth_provider: string;
  user: UserProfile;
}

export interface DiskMountSummary {
  id: string;
  name: string;
  pool_type: 'private' | 'shared';
  mount_path: string;
  quota_gb: number;
  used_bytes: number;
  read_only: boolean;
  online: boolean;
}

export interface VfsFileEntry {
  name: string;
  rel_path: string;
  is_dir: boolean;
  size_bytes: number;
  modified_unix: number;
  blake3_short: string | null;
}

export interface StoragePoolConfig {
  id: string;
  name: string;
  pool_type: 'private' | 'shared';
  mount_path: string;
  quota_gb: number;
  read_only: boolean;
}

export interface FullAppConfig {
  server: {
    app_name: string;
    host: string;
    port: number;
    public_url: string;
    static_dir: string;
    temp_upload_dir: string;
    log_dir: string;
    max_upload_size_mb: number;
  };
  database: {
    sqlite_path: string;
    auto_migrate: boolean;
  };
  auth: {
    jwt_secret: string;
    access_token_ttl_secs: number;
    refresh_token_ttl_days: number;
    allow_registration: boolean;
    default_admin_email: string;
    default_admin_password: string;
    google: {
      enabled: boolean;
      client_id: string;
      client_secret: string;
      redirect_uri: string;
    };
  };
  network: {
    p2p_enabled: boolean;
    p2p_udp_port: number;
    p2p_handshake_timeout_ms: number;
    chunk_size_kb: number;
    stun_servers: string[];
    cloudflare_tunnel: {
      enabled: boolean;
      tunnel_name: string;
      tunnel_token: string;
      fallback_https_enabled: boolean;
    };
  };
  storage: {
    pools: StoragePoolConfig[];
  };
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

function getAuthHeaders(token?: string | null): HeadersInit {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function apiLogin(email: string, password: string): Promise<AuthTokenResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '登录失败');
  return data;
}

export async function apiRegister(
  email: string,
  password: string,
  displayName?: string
): Promise<AuthTokenResponse> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '注册失败');
  return data;
}

export async function apiGetGoogleAuthUrl(): Promise<{ authorize_url: string; enabled: boolean }> {
  const res = await fetch(`${API_BASE}/auth/google/url`);
  return res.json();
}

export async function apiListDisks(token?: string | null): Promise<DiskMountSummary[]> {
  const res = await fetch(`${API_BASE}/disks`, {
    headers: getAuthHeaders(token),
  });
  if (!res.ok) throw new Error('无法加载磁盘挂载列表');
  const data = await res.json();
  return data.pools || [];
}

export async function apiListFiles(
  poolId: string,
  path: string,
  token?: string | null
): Promise<VfsFileEntry[]> {
  const params = new URLSearchParams({ pool_id: poolId, path });
  const res = await fetch(`${API_BASE}/files?${params.toString()}`, {
    headers: getAuthHeaders(token),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '无法读取目录');
  return data.entries || [];
}

export async function apiCreateFolder(
  poolId: string,
  path: string,
  folderName: string,
  token?: string | null
): Promise<void> {
  const res = await fetch(`${API_BASE}/files/mkdir`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(token),
    },
    body: JSON.stringify({ pool_id: poolId, path, folder_name: folderName }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '新建文件夹失败');
  }
}

export async function apiUploadFiles(
  poolId: string,
  path: string,
  files: FileList,
  token?: string | null
): Promise<void> {
  const form = new FormData();
  Array.from(files).forEach((f) => form.append('file', f));
  const params = new URLSearchParams({ pool_id: poolId, path });
  const res = await fetch(`${API_BASE}/files/upload?${params.toString()}`, {
    method: 'POST',
    headers: getAuthHeaders(token),
    body: form,
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '上传失败');
  }
}

export async function apiDeleteEntry(
  poolId: string,
  path: string,
  token?: string | null
): Promise<void> {
  const params = new URLSearchParams({ pool_id: poolId, path });
  const res = await fetch(`${API_BASE}/files?${params.toString()}`, {
    method: 'DELETE',
    headers: getAuthHeaders(token),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '删除失败');
  }
}

export function getDownloadUrl(poolId: string, path: string): string {
  const params = new URLSearchParams({ pool_id: poolId, path });
  return `${API_BASE}/files/download?${params.toString()}`;
}

export async function apiGetSystemConfig(token?: string | null): Promise<FullAppConfig> {
  const res = await fetch(`${API_BASE}/config`, {
    headers: getAuthHeaders(token),
  });
  if (!res.ok) throw new Error('无法读取系统配置');
  return res.json();
}

export async function apiSaveSystemConfig(
  cfg: FullAppConfig,
  token?: string | null
): Promise<void> {
  const res = await fetch(`${API_BASE}/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(token),
    },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '保存系统配置失败');
  }
}
