import { createSignal } from 'solid-js';
import type { TransportChannel } from './services/p2pTransport';

export interface StoragePoolItem {
  id: string;
  name: string;
  type: 'private' | 'shared';
  mountPath: string;
  usedGb: number;
  totalGb: number;
}

const initialPools: StoragePoolItem[] = [
  {
    id: 'pool-private-nvme',
    name: '私人加密盘 (NVMe 0)',
    type: 'private',
    mountPath: '/mnt/nvme_pool/users/uid_01',
    usedGb: 245,
    totalGb: 1024,
  },
  {
    id: 'pool-shared-media',
    name: '家庭与团队共享盘 (RAID5)',
    type: 'shared',
    mountPath: '/mnt/hdd_array_1/media',
    usedGb: 5420,
    totalGb: 16384,
  },
  {
    id: 'pool-shared-archive',
    name: '多盘 NAS 归档池 (ZFS)',
    type: 'shared',
    mountPath: '/mnt/hdd_array_2/archive',
    usedGb: 3100,
    totalGb: 12288,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = createSignal<'private' | 'shared'>('private');
  const [transportMode, setTransportMode] = createSignal<TransportChannel>('p2p-lan');
  const [authMethod, setAuthMethod] = createSignal<'email' | 'google'>('google');

  return (
    <div class="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Bar: P2P / Cloudflare Tunnel Dual-Channel Status */}
      <header class="border-b border-slate-800 bg-slate-900/70 backdrop-blur px-6 py-3.5 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white">
            M
          </div>
          <div>
            <h1 class="text-base font-semibold tracking-tight">MayaDesk 云盘</h1>
            <p class="text-xs text-slate-400">多盘 NAS 聚合 · 零公网暴露架构</p>
          </div>
        </div>

        <div class="flex items-center gap-3 text-xs">
          <button
            onClick={() =>
              setTransportMode((prev) => (prev === 'p2p-lan' ? 'cf-tunnel-web' : 'p2p-lan'))
            }
            class="px-3 py-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 flex items-center gap-2 cursor-pointer"
          >
            <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            {transportMode() === 'p2p-lan'
              ? '通道: P2P QUIC/WebRTC 直连 (8ms)'
              : '通道: Cloudflare Tunnel 安全兜底 (45ms)'}
          </button>

          <span class="px-3 py-1.5 rounded-full border border-slate-700 bg-slate-800 text-slate-300">
            登录方式: {authMethod() === 'google' ? 'Google OAuth 2.0' : '邮箱密码 (Argon2)'}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main class="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Left Sidebar: Multi-Disk NAS Pools */}
        <aside class="md:col-span-1 space-y-4">
          <div class="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400">
              存储空间切换
            </h2>
            <div class="flex flex-col gap-1.5">
              <button
                onClick={() => setActiveTab('private')}
                class={`text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab() === 'private'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                私人加密硬盘
              </button>
              <button
                onClick={() => setActiveTab('shared')}
                class={`text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab() === 'shared'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                多盘 NAS 共享池
              </button>
            </div>
          </div>

          <div class="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400">
              物理挂载盘状态
            </h2>
            {initialPools.map((pool) => (
              <div class="p-3 rounded-lg bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                <div class="flex items-center justify-between text-xs font-medium">
                  <span>{pool.name}</span>
                  <span class="text-indigo-400">
                    {Math.round((pool.usedGb / pool.totalGb) * 100)}%
                  </span>
                </div>
                <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-indigo-500"
                    style={{ width: `${(pool.usedGb / pool.totalGb) * 100}%` }}
                  />
                </div>
                <p class="text-[11px] text-slate-500 font-mono truncate">{pool.mountPath}</p>
              </div>
            ))}
          </div>
        </aside>

        {/* Right File Browser Area */}
        <section class="md:col-span-3 rounded-xl border border-slate-800 bg-slate-900/40 p-6 flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between pb-4 border-b border-slate-800">
              <div>
                <h2 class="text-lg font-semibold">
                  {activeTab() === 'private' ? '私人加密空间' : '共享协作硬盘 (多盘聚合)'}
                </h2>
                <p class="text-xs text-slate-400 mt-0.5">
                  支持 BLAKE3 分片秒传 · P2P 优先传输 · 断网自动切换 Cloudflare Tunnel
                </p>
              </div>
              <div class="flex gap-2">
                <button
                  onClick={() =>
                    setAuthMethod((m) => (m === 'google' ? 'email' : 'google'))
                  }
                  class="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-medium"
                >
                  切换鉴权演示
                </button>
                <button class="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white">
                  + 上传文件 (P2P 分片)
                </button>
              </div>
            </div>

            <div class="mt-6 space-y-2 text-sm">
              <div class="grid grid-cols-12 text-xs text-slate-400 px-3 py-2 border-b border-slate-800/60">
                <span class="col-span-6">文件 / 目录名</span>
                <span class="col-span-3">所属物理盘池</span>
                <span class="col-span-3 text-right">传输协议</span>
              </div>
              <div class="grid grid-cols-12 items-center px-3 py-3 rounded-lg hover:bg-slate-800/40 transition">
                <span class="col-span-6 font-medium">📁 2026_Project_Datasets</span>
                <span class="col-span-3 text-xs text-slate-400 font-mono">/mnt/nvme_pool</span>
                <span class="col-span-3 text-right text-xs text-emerald-400">QUIC P2P Direct</span>
              </div>
              <div class="grid grid-cols-12 items-center px-3 py-3 rounded-lg hover:bg-slate-800/40 transition">
                <span class="col-span-6 font-medium">🎬 4K_RAW_Footage_Archive.mkv (18.4 GB)</span>
                <span class="col-span-3 text-xs text-slate-400 font-mono">/mnt/hdd_array_1</span>
                <span class="col-span-3 text-right text-xs text-emerald-400">WebRTC DataChannel</span>
              </div>
            </div>
          </div>

          <footer class="pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
            <span>客户端支持: Web · macOS · Windows · Linux · Android (Tauri v2 &lt; 8MB)</span>
            <span>安全隧道: Cloudflare Zero Trust Outbound-Only</span>
          </footer>
        </section>
      </main>
    </div>
  );
}
