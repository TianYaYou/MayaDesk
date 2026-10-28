-- 0001_initial_schema.sql
-- MayaDesk SQLite Schema (WAL Mode Enabled)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Users Table (Supports Email/Password & Google OAuth2)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,                -- Nullable for pure Google OAuth users
    google_sub TEXT UNIQUE,            -- Google OAuth2 Subject Identifier
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'member', -- 'admin', 'member', 'guest'
    quota_bytes INTEGER NOT NULL DEFAULT 0, -- Default 0 (no quota for regular users until assigned by admin)
    used_bytes INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Storage Pools Table (Multi-Disk NAS Aggregation)
CREATE TABLE IF NOT EXISTS storage_pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    pool_type TEXT NOT NULL,           -- 'private' or 'shared'
    backend_driver TEXT NOT NULL DEFAULT 'fs', -- 'fs', 'webdav', 's3', 'smb'
    mount_path TEXT NOT NULL,          -- Physical NAS path e.g. /mnt/nvme0/users or /mnt/raid1/media
    total_bytes INTEGER NOT NULL DEFAULT 0,
    available_bytes INTEGER NOT NULL DEFAULT 0,
    is_online BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Shared Drive ACL (Role-Based Access Control for Shared Pools)
CREATE TABLE IF NOT EXISTS shared_pool_permissions (
    pool_id TEXT NOT NULL REFERENCES storage_pools(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,          -- 'read', 'write', 'admin'
    granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool_id, user_id)
);

-- 4. Virtual File Index & Content-Addressed Deduplication (BLAKE3)
CREATE TABLE IF NOT EXISTS vfs_nodes (
    id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL REFERENCES storage_pools(id) ON DELETE CASCADE,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES vfs_nodes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_dir BOOLEAN NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    blake3_hash TEXT,                  -- Used for instant dedup upload & P2P chunk verification
    mime_type TEXT,
    physical_rel_path TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pool_id, parent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_vfs_blake3 ON vfs_nodes(blake3_hash);
CREATE INDEX IF NOT EXISTS idx_vfs_parent ON vfs_nodes(pool_id, parent_id);

-- 5. Transfer Logs Table (Audit & History of Uploads and Downloads)
CREATE TABLE IF NOT EXISTS transfer_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,              -- 'upload' | 'download'
    file_name TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    channel TEXT NOT NULL DEFAULT 'relay', -- 'p2p' | 'relay'
    status TEXT NOT NULL DEFAULT 'success', -- 'success' | 'failed'
    error_msg TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfer_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfer_logs(created_at);
