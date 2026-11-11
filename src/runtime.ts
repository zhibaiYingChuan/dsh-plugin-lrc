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
 * 二进制**稳定文件名**（不含版本号）：`<platform>-<arch>` → file。
 *
 * 为什么不用版本号：LRC 的发布口径是"只保留最新一个 Release"，旧 Release 会被删除。
 * 若插件把版本号写死（如 `lrc-v0.10.4-...`），LRC 一发新版，这里的固定 URL 就全部
 * 404，首次安装的用户直接拿不到二进制。v0.10.0 → v0.10.4 期间已真实发生过。
 *
 * 现在改为下载 CI 产出的**稳定别名**（见 release.yml 的 "Publish plugin sidecar alias"）：
 * 文件名不随版本变化，内容才是最新的那一个。
 */
export const BINARY_FILES: Record<string, string> = {
  'win32-x64': 'lrc-sidecar-windows-x64.exe',
  'darwin-arm64': 'lrc-sidecar-darwin-arm64',
  'linux-x64': 'lrc-sidecar-linux-x64',
};

/**
 * 下载源，按顺序尝试，**国内优先**。
 *
 * 两条源都提供稳定路径（不含版本号），因此**插件永远不需要跟着 LRC 改版本**：
 *   · 国内：文件平铺在 `/xd/downloads/` 根下；
 *   · GitHub：`releases/latest/download/` 是 GitHub 的稳定别名，永远指向最新 Release。
 *
 * 版本识别不靠 URL，而靠同目录的 `<file>.sha256`：哈希变了就是新版本。
 * 这样即使 LRC 换了版本号，插件也无需任何改动。
 */
const DEFAULT_MIRRORS = [
  // ① 国内直连（自家服务器，不依赖 GitHub 可达性）
  'https://sfang.cc/xd/downloads',
  // ② GitHub 官方稳定别名（永远指向最新 Release）
  'https://github.com/zhibaiYingChuan/LRC/releases/latest/download',
  // ③ GitHub 加速代理（前两者都失败时的兜底）
  'https://ghproxy.net/https://github.com/zhibaiYingChuan/LRC/releases/latest/download',
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
  /**
   * 覆盖二进制的**文件名**（测试用）。
   *
   * 注意：内核不持有"期望哈希"——期望值一律从下载源的 `<file>.sha256` 现取，
   * 这样 LRC 发新版时插件无需改动。需要注入错误哈希验证降级时，
   * 用 `manifest` 显式给出 sha256（一旦给出则以它为准，跳过远端查询）。
   */
  manifest?: Record<string, { file: string; sha256: string }>;
  /** 是否探测本地 3099 端口（测试用：置 false 可强制走下载路径） */
  probeLocal?: boolean;
  /** 额外下载源（优先于内置源，测试/自建镜像用） */
  mirrors?: string[];
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

/**
 * 从 `.sha256` 文件内容里提取哈希。
 *
 * 两种格式并存（都是 CI 真实产出）：
 *   · `sha256sum`：`abcdef...  lrc-sidecar-linux-x64`
 *   · `certutil`（Windows）：三行，中间一行才是纯哈希
 *
 * 因此不能"取首行"，必须**全文匹配 64 位十六进制**。
 */
export function extractSha256(text: string): string | null {
  const match = /(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/i.exec(text);
  return match === null ? null : match[1].toLowerCase();
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
    this.manifest = options.manifest ?? {};
    this.probeLocal = options.probeLocal ?? true;
    // 额外源优先于内置源（测试/自建镜像）；去掉空串与末尾斜杠。
    const extra = (options.mirrors ?? []).map((m) => m.replace(/\/+$/, '')).filter(Boolean);
    this.mirrors = [...extra, ...DEFAULT_MIRRORS];
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

  /**
   * 确保二进制存在且校验通过。
   *
   * # 版本自发现（不硬编码任何版本号）
   *
   * 期望哈希**不在代码里写死**，而是每次启动时从下载源的 `<file>.sha256` 现取：
   *   · 下载源路径本身稳定（国内 `/xd/downloads/`、GitHub `releases/latest/download/`）；
   *   · `.sha256` 内容随 LRC 发版变化 ⇒ **哈希变即版本变**。
   *
   * 于是 LRC 发新版时，插件无需改一行代码：下次启动发现哈希与本地指纹不符，
   * 自动重下新版本。
   *
   * # 降级策略
   *
   * 远端不可达（离线/被墙）且本地二进制**完好**时，用本地版本继续跑，不阻断用户。
   * 只有"本地也没有 / 本地哈希与远端不符"才真正失败。
   */
  private async ensureBinary(): Promise<string> {
    const key = platformKey();
    const file = this.manifest[key]?.file ?? BINARY_FILES[key];
    if (file === undefined) {
      throw new Error(
        `没有 ${key} 的二进制文件名。请手动安装 LRC 桌面端，或设置 LRC_BASE 指向已有实例。`,
      );
    }

    const binDir = join(this.cacheDir, 'bin');
    const target = join(binDir, binaryName());
    const stampPath = join(binDir, `${binaryName()}.version`);
    mkdirSync(binDir, { recursive: true });

    const pinned = this.manifest[key]?.sha256;

    // ── 1. 向各源取"当前版本指纹"（.sha256 内容）──
    const remote = await this.fetchRemoteDigest(file, pinned);

    // ── 2. 本地已是最新？直接复用（不重复下载）──
    if (existsSync(target) && remote.digest !== null) {
      const localStamp = this.readStamp(stampPath);
      if (localStamp === remote.digest && this.verify(target, remote.digest)) {
        this.log(`[lrc] 复用已缓存二进制（${remote.digest.slice(0, 12)}…）`);
        return target;
      }
    }

    // ── 3. 远端不可达：本地完好就继续用（离线可用）──
    if (remote.digest === null) {
      if (existsSync(target)) {
        this.log('[lrc] 无法确认远端版本，沿用本地已缓存二进制');
        return target;
      }
      throw new Error(`无法获取版本指纹：${remote.error ?? '所有源均不可达'}`);
    }

    // ── 4. 下载并校验 ──
    const sources = this.mirror
      ? [this.mirror.replace(/\/+$/, ''), ...this.mirrors]
      : this.mirrors;
    let lastError: unknown = null;
    for (const source of sources) {
      const url = `${source}/${file}`;
      try {
        this.log(`[lrc] 下载 ${url}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(target, buffer);
        if (!this.verify(target, remote.digest)) {
          rmSync(target, { force: true });
          // 哈希不符是**安全信号**：宁可失败也不能运行被篡改的二进制
          throw new Error(
            `SHA256 校验失败（期望 ${remote.digest.slice(0, 12)}…）。` +
              '文件可能被篡改或下载不完整，已删除。',
          );
        }
        if (platform() !== 'win32') chmodSync(target, 0o755);
        writeFileSync(stampPath, remote.digest);
        this.log(`[lrc] 已就绪（${remote.digest.slice(0, 12)}…）`);
        return target;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        // 校验失败不换源重试——同一哈希下换了源也一样不对，且会掩盖篡改
        if (msg.includes('SHA256 校验失败')) throw error;
        this.log(`[lrc] 源失败（${source}）：${msg}`);
      }
    }
    throw new Error(
      `所有源均失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /**
   * 向各源查询二进制的当前版本指纹（`.sha256` 内容）。
   *
   * 返回 `digest` 为规范化后的 64 位小写十六进制；拿不到则 `digest === null`。
   * 注意各源 `.sha256` 格式不一：GitHub 的 Windows 产物是 `certutil` 输出
   * （带描述行），必须**从全部文本里提取哈希**而不是取首行。
   */
  private async fetchRemoteDigest(
    file: string,
    pinned?: string,
  ): Promise<{ digest: string | null; error?: string }> {
    if (pinned !== undefined) return { digest: pinned.toLowerCase() };

    const sources = this.mirror
      ? [this.mirror.replace(/\/+$/, ''), ...this.mirrors]
      : this.mirrors;
    let lastError: string | undefined;
    for (const source of sources) {
      try {
        const response = await fetch(`${source}/${file}.sha256`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const digest = extractSha256(text);
        if (digest === null) throw new Error('.sha256 内容无法解析');
        return { digest };
      } catch (error) {
        lastError = `${source}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return { digest: null, error: lastError };
  }

  private readStamp(path: string): string | null {
    try {
      return readFileSync(path, 'utf-8').trim() || null;
    } catch {
      return null;
    }
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
