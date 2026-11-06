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
 * **当前为空**：LRC 的 Release 还没产出插件专用的 sidecar 资产。
 * 填上之前，`ensure()` 会走 degraded 并提示用户手动安装 LRC ——
 * 这是刻意的：宁可明确失败，也不下载一个无法校验的文件。
 */
export const BINARY_MANIFEST: Record<string, { file: string; sha256: string }> = {};

const DEFAULT_MIRRORS = [
  'https://github.com/zhibaiYingChuan/LRC/releases/latest/download',
  'https://ghproxy.net/https://github.com/zhibaiYingChuan/LRC/releases/latest/download',
];

export interface RuntimeOptions {
  /** 缓存根目录，默认 `$DSH_HOME/cache/lrc-plugin` */
  cacheDir?: string;
  /** 额外镜像前缀（优先于内置镜像） */
  mirror?: string;
  /** 日志回调 */
  log?: (message: string) => void;
  /** 健康检查超时（毫秒） */
  healthTimeoutMs?: number;
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
  private child: ChildProcess | null = null;
  private result: RuntimeResult | null = null;

  constructor(options: RuntimeOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.mirror = options.mirror ?? process.env.LRC_MIRROR;
    this.log = options.log ?? (() => {});
    this.healthTimeoutMs = options.healthTimeoutMs ?? 15_000;
  }

  /** 幂等：多次调用只启动一次。 */
  async ensure(): Promise<RuntimeResult> {
    if (this.result !== null) return this.result;

    // ① 已有实例
    const explicit = process.env.LRC_BASE;
    if (explicit && (await isHealthy(explicit))) {
      this.result = { mode: 'external', baseUrl: explicit.replace(/\/+$/, '') };
      this.log(`[lrc] 复用已有实例：${this.result.baseUrl}`);
      return this.result;
    }
    const local = 'http://127.0.0.1:3099';
    if (await isHealthy(local)) {
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
    const entry = BINARY_MANIFEST[key];
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

    const mirrors = this.mirror ? [this.mirror, ...DEFAULT_MIRRORS] : DEFAULT_MIRRORS;
    let lastError: unknown = null;
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
          throw new Error('SHA256 校验失败');
        }
        if (platform() !== 'win32') chmodSync(target, 0o755);
        return target;
      } catch (error) {
        lastError = error;
        this.log(`[lrc] 镜像失败（${mirror}）：${error instanceof Error ? error.message : error}`);
      }
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
