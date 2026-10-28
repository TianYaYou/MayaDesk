export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  role: string;
  quota_bytes?: number;
  used_bytes?: number;
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

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  role: string;
  quota_bytes: number;
  used_bytes: number;
  created_at: string;
}

export interface TransferLogRecord {
  id: string;
  user_id: string;
  user_email: string;
  action: 'upload' | 'download';
  file_name: string;
  rel_path: string;
  size_bytes: number;
  channel: string;
  status: string;
  error_msg?: string | null;
  created_at: string;
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

export async function apiGetUserProfile(token?: string | null): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/user/profile`, {
    headers: getAuthHeaders(token),
  });
  if (!res.ok) throw new Error('无法读取用户信息');
  return res.json();
}

export async function apiListAdminUsers(token?: string | null): Promise<UserRecord[]> {
  const res = await fetch(`${API_BASE}/admin/users`, {
    headers: getAuthHeaders(token),
  });
  if (!res.ok) throw new Error('无法读取用户列表');
  const data = await res.json();
  return data.users || [];
}

export async function apiUpdateUserQuota(
  userId: string,
  quotaBytes: number,
  token?: string | null
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/users/${userId}/quota`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(token),
    },
    body: JSON.stringify({ quota_bytes: quotaBytes }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '更新配额失败');
  }
}

export async function apiInitDisk(
  params: { mount_path: string; pool_type?: string; name?: string; quota_gb?: number },
  token?: string | null
): Promise<any> {
  const res = await fetch(`${API_BASE}/admin/init-disk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(token),
    },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '初始化存储硬盘失败');
  return data;
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
  space: string,
  path: string,
  token?: string | null
): Promise<VfsFileEntry[]> {
  const params = new URLSearchParams({ space, path });
  const res = await fetch(`${API_BASE}/files?${params.toString()}`, {
    headers: getAuthHeaders(token),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '无法读取目录');
  return data.entries || [];
}

export async function apiListFolderPaths(
  space: string,
  token?: string | null
): Promise<string[]> {
  const params = new URLSearchParams({ space });
  const res = await fetch(`${API_BASE}/files/folders?${params.toString()}`, {
    headers: getAuthHeaders(token),
  });
  const data = await res.json();
  if (!res.ok) return ['/'];
  return data.folders || ['/'];
}

export async function apiCreateFolder(
  space: string,
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
    body: JSON.stringify({ space, path, folder_name: folderName }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '新建文件夹失败');
  }
}

export async function apiUploadFiles(
  space: string,
  path: string,
  files: FileList | File[],
  token?: string | null,
  onProgress?: (percent: number, msg: string) => void
): Promise<void> {
  const fileArray = Array.from(files);
  const CHUNK_THRESHOLD = 8 * 1024 * 1024; // 8MB: files larger than this use chunked relay upload
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per chunk

  for (let fIdx = 0; fIdx < fileArray.length; fIdx++) {
    const file = fileArray[fIdx];
    const relPath = file.webkitRelativePath || file.name;
    const progressBase = Math.round((fIdx / fileArray.length) * 100);

    if (file.size > CHUNK_THRESHOLD) {
      // Large file: Chunked relay upload
      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
        const start = cIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const form = new FormData();
        form.append('upload_id', uploadId);
        form.append('chunk_index', String(cIdx));
        form.append('total_chunks', String(totalChunks));
        form.append('file_name', file.name);
        form.append('rel_path', relPath);
        form.append('space', space);
        form.append('path', path);
        form.append('chunk', chunkBlob, file.name);

        const chunkPercent = Math.round(((cIdx + 1) / totalChunks) * 100);
        onProgress?.(
          Math.min(99, progressBase + Math.round(chunkPercent / fileArray.length)),
          `正在中继上传大文件 "${file.name}" [分片 ${cIdx + 1}/${totalChunks}]`
        );

        const res = await fetch(`${API_BASE}/files/upload/chunk`, {
          method: 'POST',
          headers: getAuthHeaders(token),
          body: form,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `大文件分片 ${cIdx + 1} 上传失败`);
        }
      }
    } else {
      // Standard upload (single or multiple)
      const form = new FormData();
      form.append('file', file, relPath);
      const params = new URLSearchParams({ space, path });
      onProgress?.(
        Math.min(99, progressBase + 10),
        `正在上传 "${file.name}"...`
      );

      const res = await fetch(`${API_BASE}/files/upload?${params.toString()}`, {
        method: 'POST',
        headers: getAuthHeaders(token),
        body: form,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '上传失败');
      }
    }
  }

  onProgress?.(100, '上传完成');
}

export async function apiDeleteEntry(
  space: string,
  path: string,
  token?: string | null
): Promise<void> {
  const params = new URLSearchParams({ space, path });
  const res = await fetch(`${API_BASE}/files?${params.toString()}`, {
    method: 'DELETE',
    headers: getAuthHeaders(token),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || '删除失败');
  }
}

export function getDownloadUrl(space: string, path: string): string {
  const params = new URLSearchParams({ space, path });
  return `${API_BASE}/files/download?${params.toString()}`;
}

export async function apiGetTransferLogs(token?: string | null): Promise<TransferLogRecord[]> {
  const res = await fetch(`${API_BASE}/transfers/logs`, {
    headers: getAuthHeaders(token),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.logs || [];
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
