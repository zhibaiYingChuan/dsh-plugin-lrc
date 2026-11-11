/**
 * LRC 运行时管理：让插件自带 LRC，用户不需要先装桌面端。
 *
 * ## 启动顺序
 *
 * ```
 * ① 探测已有 LRC（LRC_BASE / 3099 端口）→ 有就用（external）
 * ② 检查缓存里的二进制 → 没有就下载（镜像 + SHA256 校验）
 * ③ 启动隔离实例（独立数据目录 + 随机空闲端口）→ managed
 * ④ 任一步失败 → degraded（纯客户端模式，卸载静默跳过）
 * ```
 *
 * ## 数据隔离
 *
 * 插件自己的实例用 `$DSH_HOME/cache/lrc-plugin/data`，
 * **绝不**写进用户的 `~/.loong-recall/global/data`。
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';

export type RuntimeMode = 'external' | 'managed' | 'degraded';

export interface RuntimeResult {
  mode: RuntimeMode;
  baseUrl: string;
  /** degraded 时给出可读原因 */
  reason?: string;
}

/**
 * 二进制清单：`<platform>-<arch>` → `{ file, sha256 }`。
 *
 * 文件名带版本号（`lrc-v0.10.4-...`），配合 `BINARY_RELEASE` 拼出**固定 URL**：
 * `releases/download/v0.10.4/<file>`。这样不会因为 `latest` 漂移而拿到未校验的版本。
 *
 * ⚠ **Release 资产的生命周期约束**：LRC 仓库的发布口径是"只保留最新一个 Release"，
 * 旧版本的 Release 会被删除。因此这里的 `BINARY_RELEASE` 一旦落后于线上最新版，
 * 三个下载 URL 就会**全部 404**，首次安装插件的用户直接拿不到二进制。
 *
 * 维护动作（每次 LRC 发版必须做，否则插件静默失效）：
 *   1. `BINARY_RELEASE` 改为新版本 tag；
 *   2. `BINARY_MANIFEST` 的 `file` 与 `sha256` 同步更新；
 *   3. 国内镜像 URL 的版本号同步更新。
 * 依据：v0.10.0 的 Release 已删除，旧清单实测三个 URL 全 404。
 */
export const BINARY_RELEASE = 'v0.10.4';

export const BINARY_MANIFEST: Record<string, { file: string; sha256: string }> = {
  'win32-x64': {
    file: 'lrc-v0.10.4-windows-x86_64.exe',
    sha256: '4be3e0841bc312892e93e29ae416a8b7f2b793bdf2726f14ad3475d738e3c589',
  },
  'darwin-arm64': {
    file: 'lrc-v0.10.4-macos-arm64',
    sha256: '0878cd748c800bc9d846abf1fe5a0671da80b504527c237318bb38ee1b29c49b',
  },
  'linux-x64': {
    file: 'lrc-v0.10.4-linux-x86_64',
    sha256: 'dbccf5cc0bc26667a0d880697b3e40b58fc119d7c3db6aa94140e207485a8a7c',
  },
};

/**
 * 下载镜像，按顺序尝试，**国内优先**。
 *
 * 注意拼接规则：最终 URL = `${mirror}/${entry.file}`，**mirror 本身不含版本段**。
 * 因此三条镜像的路径形态不同，各自要拼对：
 *   · 国内：文件平铺在 `/xd/downloads/` 根下（随版本改名，无子目录）；
 *   · GitHub：走 `/releases/download/<tag>/`，tag 必须写进 mirror。
 *
 * 为什么国内地址排第一：GitHub Releases 在国内经常超时或被重置，
 * 而 sfang.cc 是自家的国内直连源（与 Releases 同名文件字节一致，
 * 已逐个下载回来比过 SHA256）。
 */
const DEFAULT_MIRRORS = [
  // ① 国内直连（文件在 downloads 根下，不含版本子目录）
  'https://sfang.cc/xd/downloads',
  // ② GitHub 原始地址（海外 / 国内可达时）
  `https://github.com/zhibaiYingChuan/LRC/releases/download/${BINARY_RELEASE}`,
  // ③ GitHub 加速代理（前两者都失败时的兜底）
  `https://ghproxy.net/https://github.com/zhibaiYingChuan/LRC/releases/download/${BINARY_RELEASE}`,
];

export interface RuntimeOptions {
  /**
   * 显式指定已有 LRC 实例（优先于 `LRC_BASE` 环境变量与本地探测）。
   *
   * 来自插件配置 `baseUrl`。此前只认环境变量，导致 `cordis.patch.yml`
   * 里写 `baseUrl: http://127.0.0.1:3111` 不生效，永远打到 3099。
   */
  baseUrl?: string;
  /** 缓存根目录，默认 `$DSH_HOME/cache/lrc-plugin` */
  cacheDir?: string;
  /** 额外镜像前缀（优先于内置镜像） */
  mirror?: string;
  /** 日志回调 */
  log?: (message: string) => void;
  /** 健康检查超时（毫秒） */
  healthTimeoutMs?: number;
  /** 覆盖二进制清单（测试用：可注入错误哈希验证降级） */
  manifest?: Record<string, { file: string; sha256: string }>;
  /** 覆盖 Release 版本（测试用） */
  release?: string;
  /** 是否探测本地 3099 端口（测试用：置 false 可强制走下载路径） */
  probeLocal?: boolean;
}

function defaultCacheDir(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'cache', 'lrc-plugin');
}

function platformKey(): string {
  return `${platform()}-${arch()}`;
}

function binaryName(): string {
  return platform() === 'win32' ? 'lrc-sidecar.exe' : 'lrc-sidecar';
}

/** 找一个空闲端口。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('无法获取空闲端口'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function isHealthy(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class LrcRuntime {
  private readonly cacheDir: string;
  private readonly mirror?: string;
  private readonly log: (message: string) => void;
  private readonly healthTimeoutMs: number;
  private readonly manifest: Record<string, { file: string; sha256: string }>;
  private readonly mirrors: string[];
  private readonly probeLocal: boolean;
  /** 显式实例地址：配置 `baseUrl` 优先，其次 `LRC_BASE` 环境变量。 */
  private readonly explicitBase?: string;
  private child: ChildProcess | null = null;
  private result: RuntimeResult | null = null;

  constructor(options: RuntimeOptions = {}) {
    this.explicitBase = options.baseUrl?.trim() || process.env.LRC_BASE;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.mirror = options.mirror ?? process.env.LRC_MIRROR;
    this.log = options.log ?? (() => {});
    this.healthTimeoutMs = options.healthTimeoutMs ?? 15_000;
    this.manifest = options.manifest ?? BINARY_MANIFEST;
    this.probeLocal = options.probeLocal ?? true;
    const release = options.release ?? BINARY_RELEASE;
    this.mirrors = [
      `https://github.com/zhibaiYingChuan/LRC/releases/download/${release}`,
      `https://ghproxy.net/https://github.com/zhibaiYingChuan/LRC/releases/download/${release}`,
    ];
  }

  /** 幂等：多次调用只启动一次。 */
  async ensure(): Promise<RuntimeResult> {
    if (this.result !== null) return this.result;

    // ① 已有实例（配置 baseUrl > LRC_BASE 环境变量）
    const explicit = this.explicitBase;
    if (explicit) {
      if (await isHealthy(explicit)) {
        this.result = { mode: 'external', baseUrl: explicit.replace(/\/+$/, '') };
        this.log(`[lrc] 复用已有实例：${this.result.baseUrl}`);
        return this.result;
      }
      // 显式指定了却连不上：**直接降级，不回落 3099**。
      // 回落会让"配了 3111 却打到 3099"，违反端口纪律，且用户无从察觉。
      this.result = {
        mode: 'degraded',
        baseUrl: explicit.replace(/\/+$/, ''),
        reason: `配置的实例不可用：${explicit}`,
      };
      this.log(`[lrc] 降级：${this.result.reason}`);
      return this.result;
    }
    const local = 'http://127.0.0.1:3099';
    if (this.probeLocal && (await isHealthy(local))) {
      this.result = { mode: 'external', baseUrl: local };
      this.log(`[lrc] 复用本地实例：${local}`);
      return this.result;
    }

    // ② 准备二进制
    let binary: string;
    try {
      binary = await this.ensureBinary();
    } catch (error) {
      this.result = {
        mode: 'degraded',
        baseUrl: explicit ?? local,
        reason: `LRC 二进制不可用：${error instanceof Error ? error.message : String(error)}`,
      };
      this.log(`[lrc] 降级：${this.result.reason}`);
      return this.result;
    }

    // ③ 启动隔离实例
    try {
      const port = await findFreePort();
      const dataDir = join(this.cacheDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      this.child = spawn(binary, ['--port', String(port), '--data-dir', dataDir], {
        stdio: 'ignore',
        detached: false,
      });
      this.child.on('error', (error) => this.log(`[lrc] 子进程错误：${error.message}`));

      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + this.healthTimeoutMs;
      while (Date.now() < deadline) {
        if (await isHealthy(baseUrl, 1000)) {
          this.result = { mode: 'managed', baseUrl };
          this.log(`[lrc] 已启动隔离实例：${baseUrl}（数据目录 ${dataDir}）`);
          return this.result;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`健康检查超时（${this.healthTimeoutMs}ms）`);
    } catch (error) {
      this.stop();
      this.result = {
        mode: 'degraded',
        baseUrl: explicit ?? local,
        reason: `LRC 启动失败：${error instanceof Error ? error.message : String(error)}`,
      };
      this.log(`[lrc] 降级：${this.result.reason}`);
      return this.result;
    }
  }

  /** 确保二进制存在且校验通过。 */
  private async ensureBinary(): Promise<string> {
    const key = platformKey();
    const entry = this.manifest[key];
    if (entry === undefined) {
      throw new Error(
        `没有 ${key} 的二进制清单。请手动安装 LRC 桌面端，或设置 LRC_BASE 指向已有实例。`,
      );
    }

    const binDir = join(this.cacheDir, 'bin');
    const target = join(binDir, binaryName());
    mkdirSync(binDir, { recursive: true });

    if (existsSync(target) && this.verify(target, entry.sha256)) {
      return target;
    }

    const mirrors = this.mirror ? [this.mirror, ...this.mirrors] : this.mirrors;
    let lastError: unknown = null;
    let hashMismatch = false;
    for (const mirror of mirrors) {
      const url = `${mirror.replace(/\/+$/, '')}/${entry.file}`;
      try {
        this.log(`[lrc] 下载 ${url}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(target, buffer);
        if (!this.verify(target, entry.sha256)) {
          rmSync(target, { force: true });
          hashMismatch = true;
          throw new Error('SHA256 校验失败');
        }
        if (platform() !== 'win32') chmodSync(target, 0o755);
        return target;
      } catch (error) {
        lastError = error;
        this.log(`[lrc] 镜像失败（${mirror}）：${error instanceof Error ? error.message : error}`);
      }
    }
    // 哈希不符是**安全信号**，优先级高于网络错误：必须让用户看到真正的原因
    if (hashMismatch) {
      throw new Error(
        `SHA256 校验失败（期望 ${entry.sha256.slice(0, 12)}…）。` +
          '文件可能被篡改或清单过期，已删除下载内容。',
      );
    }
    throw new Error(
      `所有镜像均失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private verify(file: string, expected: string): boolean {
    try {
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      return actual === expected.toLowerCase();
    } catch {
      return false;
    }
  }

  /** 停止托管实例（插件卸载时调用）。 */
  stop(): void {
    if (this.child !== null && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
  }
}
