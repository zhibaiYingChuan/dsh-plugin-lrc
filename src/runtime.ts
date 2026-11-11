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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
 * 下载源语义（插件**永不**跟着 LRC 改版本号）。
 *
 *   · 所有源都用**稳定路径**（不含版本号）：国内平铺在 `/xd/downloads/` 根下，
 *     GitHub 用 `releases/latest/download/` 稳定别名。
 *   · 版本靠同目录的 `<file>.sha256` 识别：哈希变了就是新版本。
 *
 * 但两类源地位不同 —— 国内镜像靠人工同步，会滞后；GitHub latest 才是版本真源。
 * 若让"第一个能连上的源"决定版本，滞后镜像会把插件永久钉在旧版上而毫无提示。
 * 故：**指纹优先取真源，镜像仅用于加速下载**（见 `digestSources` / `downloadSources`）。
 */

/** GitHub 官方的稳定别名路径：永远指向最新 Release，是版本真源。 */
const GITHUB_LATEST = 'https://github.com/zhibaiYingChuan/LRC/releases/latest/download';

/** 内置源：`authoritative` 表明它是否代表"当前最新版本"。 */
export const BUILTIN_SOURCES: ReadonlyArray<{ url: string; authoritative: boolean }> = [
  // ① 国内直连（自家服务器，不依赖 GitHub 可达性）—— 只提速，**不代表版本**
  { url: 'https://sfang.cc/xd/downloads', authoritative: false },
  // ② GitHub 官方稳定别名（永远指向最新 Release）
  { url: GITHUB_LATEST, authoritative: true },
  // ③ GitHub 加速代理（转发同一份 latest 内容，同样代表版本）
  { url: `https://ghproxy.net/${GITHUB_LATEST}`, authoritative: true },
];

/**
 * 排定**指纹查询**顺序：显式源 > 真源 > 非真源镜像。
 *
 * 这是"镜像滞后不会把插件钉死在旧版"的唯一保障，故抽成纯函数便于测试：
 * 即使国内镜像排在配置第一位（下载要快），查版本时也被压到最后。
 */
export function orderDigestSources(
  explicit: readonly string[],
  builtin: ReadonlyArray<{ url: string; authoritative: boolean }>,
): string[] {
  const authoritative = builtin.filter((s) => s.authoritative).map((s) => s.url);
  const fallback = builtin.filter((s) => !s.authoritative).map((s) => s.url);
  return [...explicit, ...authoritative, ...fallback];
}

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
  /**
   * 覆盖**内置源表**（测试用）。
   *
   * 内置表里"国内镜像 = 非真源、GitHub latest = 真源"，而真实域名不可在测试里模拟，
   * 故允许注入一张同构的源表来验证"镜像滞后时按真源判版本并绕过镜像"。
   */
  builtinSources?: ReadonlyArray<{ url: string; authoritative: boolean }>;
  /**
   * 版本检查结果的复用时长（毫秒），默认 1 小时。
   *
   * 本地二进制已通过校验、且不久前刚问过远端，就没必要每次启动都再问一遍：
   * 真源在境外，国内用户每次启动都要等超时才回退，纯属白等。
   * 置 0 表示每次都查（测试用）。
   */
  recheckAfterMs?: number;
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
  private readonly log: (message: string) => void;
  private readonly healthTimeoutMs: number;
  private readonly manifest: Record<string, { file: string; sha256: string }>;
  /** 显式指定的源（插件配置 / 环境变量 / 测试注入），优先且被视为可信。 */
  private readonly explicitSources: string[];
  /** 内置源，带"是否版本真源"标记。 */
  private readonly builtinSources: ReadonlyArray<{ url: string; authoritative: boolean }>;
  private readonly probeLocal: boolean;
  private readonly recheckAfterMs: number;
  /** 显式实例地址：配置 `baseUrl` 优先，其次 `LRC_BASE` 环境变量。 */
  private readonly explicitBase?: string;
  private child: ChildProcess | null = null;
  private result: RuntimeResult | null = null;

  constructor(options: RuntimeOptions = {}) {
    this.explicitBase = options.baseUrl?.trim() || process.env.LRC_BASE;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.log = options.log ?? (() => {});
    this.healthTimeoutMs = options.healthTimeoutMs ?? 15_000;
    this.manifest = options.manifest ?? {};
    this.probeLocal = options.probeLocal ?? true;
    this.recheckAfterMs = options.recheckAfterMs ?? 60 * 60 * 1000;
    const explicit = [options.mirror ?? process.env.LRC_MIRROR ?? '', ...(options.mirrors ?? [])]
      .map((m) => m.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    this.explicitSources = [...new Set(explicit)];
    this.builtinSources = options.builtinSources ?? BUILTIN_SOURCES;
  }

  /** 下载候选源：显式源优先，其次国内镜像（快），最后 GitHub。 */
  private downloadSources(): string[] {
    return [...this.explicitSources, ...this.builtinSources.map((s) => s.url)];
  }

  /**
   * 指纹查询源：**版本真源优先**。
   *
   * 顺序 = 显式源 > GitHub latest（及其代理）> 国内镜像（仅当真源全都不可达时兜底）。
   * 国内镜像是人工同步的，可能落后一版甚至更久；若让它先出指纹，
   * 用户在 LRC 发新版后会一直停在旧版，且毫无提示。
   */
  private digestSources(): string[] {
    return orderDigestSources(this.explicitSources, this.builtinSources);
  }

  /** 该源是否代表"当前最新版本"。 */
  private isAuthoritative(url: string): boolean {
    if (this.explicitSources.includes(url)) return true;
    return this.builtinSources.some((s) => s.url === url && s.authoritative);
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

    // ── 0. 刚查过且本地完好 ⇒ 直接用，不必再打扰境外真源 ──
    if (pinned === undefined && existsSync(target) && this.recentlyChecked(stampPath)) {
      const cached = this.readStamp(stampPath);
      if (cached !== null && this.verify(target, cached)) {
        this.log('[lrc] 上次检查后本地二进制完好，跳过版本查询');
        return target;
      }
    }

    // ── 1. 向各源取"当前版本指纹"（.sha256 内容）──
    const remote = await this.fetchRemoteDigest(file, pinned);

    // ── 2. 本地已是最新？直接复用（不重复下载）──
    if (existsSync(target) && remote.digest !== null) {
      const localStamp = this.readStamp(stampPath);
      if (localStamp === remote.digest && this.verify(target, remote.digest)) {
        // 已向真源确认过，续期检查窗口；否则复用窗口只生效一次，
        // 之后每次启动都要再连境外，等于没做。
        this.touch(stampPath);
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
    let lastError: unknown = null;
    let staleMirrors = 0;
    for (const source of this.downloadSources()) {
      const url = `${source}/${file}`;
      try {
        this.log(`[lrc] 下载 ${url}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(target, buffer);
        if (!this.verify(target, remote.digest)) {
          rmSync(target, { force: true });
          // 指纹来自真源、而本文件来自**非真源** ⇒ 更可能是镜像还没同步到新版，
          // 不是篡改。此时换下一个源继续，不能因为镜像滞后就把用户卡死。
          if (remote.authoritative && !this.isAuthoritative(source)) {
            staleMirrors += 1;
            throw new Error(
              `镜像内容落后于 ${remote.digest.slice(0, 12)}…（可能尚未同步新版），已跳过`,
            );
          }
          // 指纹与该文件同源，或指纹本身就来自该源 ⇒ 这是**安全信号**：
          // 宁可失败也不能运行被篡改的二进制。
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
        // 篡改信号不换源重试——同一哈希下换了源也一样不对，且会掩盖攻击
        if (msg.includes('SHA256 校验失败')) throw error;
        this.log(`[lrc] 源失败（${source}）：${msg}`);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      staleMirrors > 0
        ? `所有源均失败：${detail}（${staleMirrors} 个镜像尚未同步新版，请稍后重试）`
        : `所有源均失败：${detail}`,
    );
  }

  /**
   * 向各源查询二进制的当前版本指纹（`.sha256` 内容）。
   *
   * 返回 `digest` 为规范化后的 64 位小写十六进制；拿不到则 `digest === null`。
   * `authoritative` 标记该指纹是否来自**版本真源**（GitHub latest 或其代理）——
   * 只有真源给出的指纹才允许判定"镜像落后"，否则只能当篡改处理。
   *
   * 注意各源 `.sha256` 格式不一：GitHub 的 Windows 产物是 `certutil` 输出
   * （带描述行），必须**从全部文本里提取哈希**而不是取首行。
   */
  private async fetchRemoteDigest(
    file: string,
    pinned?: string,
  ): Promise<{ digest: string | null; authoritative: boolean; error?: string }> {
    if (pinned !== undefined) {
      return { digest: pinned.toLowerCase(), authoritative: true };
    }

    let lastError: string | undefined;
    for (const source of this.digestSources()) {
      try {
        const response = await fetch(`${source}/${file}.sha256`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const digest = extractSha256(text);
        if (digest === null) throw new Error('.sha256 内容无法解析');
        // 用户显式配置的源（自建镜像/测试）同样算可信：他指定了就由他负责。
        const authoritative = this.isAuthoritative(source);
        return { digest, authoritative };
      } catch (error) {
        lastError = `${source}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return { digest: null, authoritative: false, error: lastError };
  }

  private readStamp(path: string): string | null {
    try {
      return readFileSync(path, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 指纹文件是否"刚刚写过"。
   *
   * 用 mtime 而不是往文件里塞时间戳：格式保持不变，老缓存无需迁移。
   */
  private recentlyChecked(stampPath: string): boolean {
    if (this.recheckAfterMs <= 0) return false;
    try {
      return Date.now() - statSync(stampPath).mtimeMs < this.recheckAfterMs;
    } catch {
      return false;
    }
  }

  /** 续期检查窗口（只改 mtime，不动内容）。 */
  private touch(stampPath: string): void {
    if (this.recheckAfterMs <= 0) return;
    try {
      const now = new Date();
      utimesSync(stampPath, now, now);
    } catch {
      // 续期失败只影响下次多查一次版本，不影响正确性
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
