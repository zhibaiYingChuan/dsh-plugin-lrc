// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";

// src/runtime.ts
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join } from "node:path";
var BINARY_FILES = {
  "win32-x64": "lrc-sidecar-windows-x64.exe",
  "darwin-arm64": "lrc-sidecar-darwin-arm64",
  "linux-x64": "lrc-sidecar-linux-x64"
};
var GITHUB_LATEST = "https://github.com/zhibaiYingChuan/LRC/releases/latest/download";
var BUILTIN_SOURCES = [
  // ① 国内直连（自家服务器，不依赖 GitHub 可达性）—— 只提速，**不代表版本**
  { url: "https://sfang.cc/xd/downloads", authoritative: false },
  // ② GitHub 官方稳定别名（永远指向最新 Release）
  { url: GITHUB_LATEST, authoritative: true },
  // ③ GitHub 加速代理（转发同一份 latest 内容，同样代表版本）
  { url: `https://ghproxy.net/${GITHUB_LATEST}`, authoritative: true }
];
function orderDigestSources(explicit, builtin) {
  const authoritative = builtin.filter((s) => s.authoritative).map((s) => s.url);
  const fallback = builtin.filter((s) => !s.authoritative).map((s) => s.url);
  return [...explicit, ...authoritative, ...fallback];
}
function defaultCacheDir() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(dshHome, "cache", "lrc-plugin");
}
function platformKey() {
  return `${platform()}-${arch()}`;
}
function binaryName() {
  return platform() === "win32" ? "lrc-sidecar.exe" : "lrc-sidecar";
}
function extractSha256(text) {
  const match = /(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/i.exec(text);
  return match === null ? null : match[1].toLowerCase();
}
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("无法获取空闲端口"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
async function isHealthy(baseUrl, timeoutMs = 3e3) {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}
var LrcRuntime = class {
  cacheDir;
  log;
  healthTimeoutMs;
  manifest;
  /** 显式指定的源（插件配置 / 环境变量 / 测试注入），优先且被视为可信。 */
  explicitSources;
  /** 内置源，带"是否版本真源"标记。 */
  builtinSources;
  probeLocal;
  recheckAfterMs;
  /** 显式实例地址：配置 `baseUrl` 优先，其次 `LRC_BASE` 环境变量。 */
  explicitBase;
  child = null;
  result = null;
  /** 下次允许重探的时刻（degraded 时的退避，毫秒时间戳）。 */
  nextRetryAt = 0;
  /** 连续 degraded 次数（用于指数退避）。 */
  degradeCount = 0;
  /** 降级退避策略。 */
  retryBackoff;
  constructor(options = {}) {
    this.explicitBase = options.baseUrl?.trim() || process.env.LRC_BASE;
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.log = options.log ?? (() => {
    });
    this.healthTimeoutMs = options.healthTimeoutMs ?? 15e3;
    this.manifest = options.manifest ?? {};
    this.probeLocal = options.probeLocal ?? true;
    this.recheckAfterMs = options.recheckAfterMs ?? 60 * 60 * 1e3;
    this.retryBackoff = options.retryBackoff ?? { baseMs: 5e3, maxMs: 6e4 };
    const explicit = [options.mirror ?? process.env.LRC_MIRROR ?? "", ...options.mirrors ?? []].map((m) => m.trim().replace(/\/+$/, "")).filter(Boolean);
    this.explicitSources = [...new Set(explicit)];
    this.builtinSources = options.builtinSources ?? BUILTIN_SOURCES;
  }
  /** 下载候选源：显式源优先，其次国内镜像（快），最后 GitHub。 */
  downloadSources() {
    return [...this.explicitSources, ...this.builtinSources.map((s) => s.url)];
  }
  /**
   * 指纹查询源：**版本真源优先**。
   *
   * 顺序 = 显式源 > GitHub latest（及其代理）> 国内镜像（仅当真源全都不可达时兜底）。
   * 国内镜像是人工同步的，可能落后一版甚至更久；若让它先出指纹，
   * 用户在 LRC 发新版后会一直停在旧版，且毫无提示。
   */
  digestSources() {
    return orderDigestSources(this.explicitSources, this.builtinSources);
  }
  /** 该源是否代表"当前最新版本"。 */
  isAuthoritative(url) {
    if (this.explicitSources.includes(url)) return true;
    return this.builtinSources.some((s) => s.url === url && s.authoritative);
  }
  /**
   * 幂等：**成功**结果只算一次，失败结果可被作废重探。
   *
   * # 为什么失败不能永久缓存
   *
   * 此前 `if (this.result !== null) return this.result;` 连 degraded 也缓存。
   * 真实事故：LRC 桌面端比 DSH 晚 20 分钟启动，插件启动那一刻探测失败、
   * 判为 degraded，此后整个会话再也不重试 —— 即使 LRC 早已健康，
   * `lrc_recall` 仍永久返回「未就绪」。
   *
   * 现在：成功结果仍然复用（不重复探测/下载），失败结果在
   * `invalidate()` 之后会重新走一遍完整探测。
   *
   * # force（避免双层退避）
   *
   * 上层 `Recoverable` 已经有一套退避：它只在自己判定「该重试了」时才调用这里。
   * 若这里再卡一次自己的退避窗口，两层叠加会让实际恢复时间远超任一层设定
   * （实测：上层 2s、下层 5s ⇒ 用户要等 5s 以上）。故 `force=true` 时跳过本地退避。
   */
  async ensure(options = {}) {
    if (this.result !== null && this.result.mode !== "degraded") return this.result;
    if (this.result !== null && this.result.mode === "degraded" && options.force !== true && !this.mayRetry()) {
      return this.result;
    }
    const explicit = this.explicitBase;
    if (explicit) {
      if (await isHealthy(explicit)) {
        this.result = { mode: "external", baseUrl: explicit.replace(/\/+$/, "") };
        this.log(`[lrc] 复用已有实例：${this.result.baseUrl}`);
        return this.succeed();
      }
      return this.degrade(explicit, `配置的实例不可用：${explicit}`);
    }
    const local = "http://127.0.0.1:3099";
    if (this.probeLocal && await isHealthy(local)) {
      this.result = { mode: "external", baseUrl: local };
      this.log(`[lrc] 复用本地实例：${local}`);
      return this.succeed();
    }
    let binary;
    try {
      binary = await this.ensureBinary();
    } catch (error) {
      return this.degrade(
        explicit ?? local,
        `LRC 二进制不可用：${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      const port = await findFreePort();
      const dataDir = join(this.cacheDir, "data");
      mkdirSync(dataDir, { recursive: true });
      this.child = spawn(binary, ["--port", String(port), "--data-dir", dataDir], {
        stdio: "ignore",
        detached: false
      });
      this.child.on("error", (error) => this.log(`[lrc] 子进程错误：${error.message}`));
      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + this.healthTimeoutMs;
      while (Date.now() < deadline) {
        if (await isHealthy(baseUrl, 1e3)) {
          this.result = { mode: "managed", baseUrl };
          this.log(`[lrc] 已启动隔离实例：${baseUrl}（数据目录 ${dataDir}）`);
          return this.succeed();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`健康检查超时（${this.healthTimeoutMs}ms）`);
    } catch (error) {
      this.stop();
      return this.degrade(
        explicit ?? local,
        `LRC 启动失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /** 成功：清空退避状态（下次仍可正常复用结果）。 */
  succeed() {
    this.degradeCount = 0;
    this.nextRetryAt = 0;
    return this.result;
  }
  /**
   * 降级：记录退避窗口。
   *
   * 退避的意义：宿主每次 recall 都可能触发一次 `ensure()`，
   * 若 LRC 长期不在，不加退避就会每次请求都白等 3 秒健康检查超时。
   */
  degrade(baseUrl, reason) {
    this.degradeCount += 1;
    const exp = this.retryBackoff.baseMs * 2 ** Math.min(this.degradeCount - 1, 4);
    const backoff = Math.min(exp, this.retryBackoff.maxMs);
    this.nextRetryAt = backoff > 0 ? Date.now() + backoff : 0;
    this.result = { mode: "degraded", baseUrl, reason };
    this.log(
      backoff > 0 ? `[lrc] 降级：${reason}（${Math.round(backoff / 1e3)}s 后重新探测）` : `[lrc] 降级：${reason}`
    );
    return this.result;
  }
  /** 当前是否可以重新探测（退避窗口是否已过）。 */
  mayRetry() {
    return Date.now() >= this.nextRetryAt;
  }
  /**
   * 显式作废当前状态，下次 `ensure()` 立刻重新探测。
   *
   * 用于热路径发现连接断了：既然是刚断的，没必要再等退避窗口。
   *
   * 托管实例额外 `stop()` 掉子进程 —— 「进程还在但不应答」是最常见的死法，
   * 直接复用只会立刻再次失败；杀掉后重探才会重新拉起。频繁重拉由调用方
   * （`Recoverable` 的指数退避）节流，这里不再叠一层冷却，避免两套节奏打架。
   */
  invalidate(reason) {
    if (this.result?.mode === "managed") this.stop();
    this.result = null;
    this.nextRetryAt = 0;
    if (reason !== void 0) this.log(`[lrc] 状态已作废，下次重新探测：${reason}`);
  }
  /** 当前状态（诊断用）。 */
  status() {
    return {
      mode: this.result?.mode ?? "idle",
      retryInMs: Math.max(0, this.nextRetryAt - Date.now()),
      degradeCount: this.degradeCount
    };
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
  async ensureBinary() {
    const key = platformKey();
    const file = this.manifest[key]?.file ?? BINARY_FILES[key];
    if (file === void 0) {
      throw new Error(
        `没有 ${key} 的二进制文件名。请手动安装 LRC 桌面端，或设置 LRC_BASE 指向已有实例。`
      );
    }
    const binDir = join(this.cacheDir, "bin");
    const target = join(binDir, binaryName());
    const stampPath = join(binDir, `${binaryName()}.version`);
    mkdirSync(binDir, { recursive: true });
    const pinned = this.manifest[key]?.sha256;
    if (pinned === void 0 && existsSync(target) && this.recentlyChecked(stampPath)) {
      const cached = this.readStamp(stampPath);
      if (cached !== null && this.verify(target, cached)) {
        this.log("[lrc] 上次检查后本地二进制完好，跳过版本查询");
        return target;
      }
    }
    const remote = await this.fetchRemoteDigest(file, pinned);
    if (existsSync(target) && remote.digest !== null) {
      const localStamp = this.readStamp(stampPath);
      if (localStamp === remote.digest && this.verify(target, remote.digest)) {
        this.touch(stampPath);
        this.log(`[lrc] 复用已缓存二进制（${remote.digest.slice(0, 12)}…）`);
        return target;
      }
    }
    if (remote.digest === null) {
      if (existsSync(target)) {
        this.log("[lrc] 无法确认远端版本，沿用本地已缓存二进制");
        return target;
      }
      throw new Error(`无法获取版本指纹：${remote.error ?? "所有源均不可达"}`);
    }
    let lastError = null;
    let staleMirrors = 0;
    for (const source of this.downloadSources()) {
      const url = `${source}/${file}`;
      try {
        this.log(`[lrc] 下载 ${url}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(12e4) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(target, buffer);
        if (!this.verify(target, remote.digest)) {
          rmSync(target, { force: true });
          if (remote.authoritative && !this.isAuthoritative(source)) {
            staleMirrors += 1;
            throw new Error(
              `镜像内容落后于 ${remote.digest.slice(0, 12)}…（可能尚未同步新版），已跳过`
            );
          }
          throw new Error(
            `SHA256 校验失败（期望 ${remote.digest.slice(0, 12)}…）。文件可能被篡改或下载不完整，已删除。`
          );
        }
        if (platform() !== "win32") chmodSync(target, 493);
        writeFileSync(stampPath, remote.digest);
        this.log(`[lrc] 已就绪（${remote.digest.slice(0, 12)}…）`);
        return target;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("SHA256 校验失败")) throw error;
        this.log(`[lrc] 源失败（${source}）：${msg}`);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      staleMirrors > 0 ? `所有源均失败：${detail}（${staleMirrors} 个镜像尚未同步新版，请稍后重试）` : `所有源均失败：${detail}`
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
  async fetchRemoteDigest(file, pinned) {
    if (pinned !== void 0) {
      return { digest: pinned.toLowerCase(), authoritative: true };
    }
    let lastError;
    for (const source of this.digestSources()) {
      try {
        const response = await fetch(`${source}/${file}.sha256`, {
          signal: AbortSignal.timeout(1e4)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const digest = extractSha256(text);
        if (digest === null) throw new Error(".sha256 内容无法解析");
        const authoritative = this.isAuthoritative(source);
        return { digest, authoritative };
      } catch (error) {
        lastError = `${source}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return { digest: null, authoritative: false, error: lastError };
  }
  readStamp(path) {
    try {
      return readFileSync(path, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }
  /**
   * 指纹文件是否"刚刚写过"。
   *
   * 用 mtime 而不是往文件里塞时间戳：格式保持不变，老缓存无需迁移。
   */
  recentlyChecked(stampPath) {
    if (this.recheckAfterMs <= 0) return false;
    try {
      return Date.now() - statSync(stampPath).mtimeMs < this.recheckAfterMs;
    } catch {
      return false;
    }
  }
  /** 续期检查窗口（只改 mtime，不动内容）。 */
  touch(stampPath) {
    if (this.recheckAfterMs <= 0) return;
    try {
      const now = /* @__PURE__ */ new Date();
      utimesSync(stampPath, now, now);
    } catch {
    }
  }
  verify(file, expected) {
    try {
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      return actual === expected.toLowerCase();
    } catch {
      return false;
    }
  }
  /** 停止托管实例（插件卸载时调用）。 */
  stop() {
    if (this.child !== null && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
  }
};

// src/lrc-client.ts
var LrcClient = class {
  baseUrl;
  token;
  timeoutMs;
  constructor(options = {}) {
    const raw = options.baseUrl ?? process.env.LRC_BASE ?? "http://127.0.0.1:3099";
    this.baseUrl = raw.replace(/\/+$/, "");
    this.token = options.token ?? process.env.LRC_TOKEN;
    this.timeoutMs = options.timeoutMs ?? 2e4;
  }
  headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }
  /**
   * 底层请求封装。
   *
   * 非 2xx 一律抛错并带上状态码与响应体前 300 字符 —— 调用方必须能区分
   * "服务没起"（fetch 抛错）与"服务起了但拒绝"（带状态码的 Error）。
   */
  async request(path, init) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LRC ${path} 返回 ${response.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }
  /** 健康检查：服务是否可用。 */
  async health() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3e3)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  /** 提炼对话文本（不写库）。 */
  async distill(text, project, maxItems = 40) {
    return this.request("/v1/context/distill", {
      method: "POST",
      body: JSON.stringify({ text, project, max_items: maxItems })
    });
  }
  /** 批量写入（幂等：同内容走相似合并）。 */
  async migrate(items, project) {
    return this.request("/v1/context/migrate", {
      method: "POST",
      body: JSON.stringify({ items, project })
    });
  }
  /** 取归档索引。 */
  async index(project, limit = 20) {
    const query = new URLSearchParams();
    if (project) query.set("project", project);
    query.set("limit", String(limit));
    return this.request(`/v1/context/index?${query.toString()}`, {
      method: "GET"
    });
  }
  /** 记忆总数（用于验收"不膨胀"）。 */
  async totalMemories() {
    const stats = await this.request("/v1/memories/stats", {
      method: "GET"
    });
    return stats.total_memories ?? 0;
  }
  /**
   * 召回相关记忆（三路融合 + 近重复折叠）。
   *
   * 这是插件唯一的**读**路径：DSH 没有 MCP 客户端，AI 看不到 LRC 的
   * `recall` 工具，只能通过插件注册的原生工具读回记忆。
   */
  async recall(query, options = {}) {
    const body = {
      query,
      top_k: options.topK ?? 5
    };
    if (options.project !== void 0 && options.project.length > 0) {
      body.project = options.project;
    }
    const data = await this.request(
      "/v1/memories/enrich",
      { method: "POST", body: JSON.stringify(body) }
    );
    return { memories: data.memories ?? [], total: data.total ?? 0 };
  }
  /**
   * 删除一条记忆（幂等）。
   *
   * 用于**纠错**：AI 发现某条记忆是错的（例如把「没找到」误写成「不存在」），
   * 必须能撤回，否则错误结论会被持续召回、污染后续所有对话。
   */
  async forget(memoryId) {
    const data = await this.request("/v1/memories/forget", {
      method: "POST",
      body: JSON.stringify({ memory_id: memoryId })
    });
    return {
      deleted: data.deleted === true,
      alreadyDeleted: data.already_deleted === true
    };
  }
  /** 一步完成"提炼 + 迁移"。 */
  async migrateText(text, project, maxItems = 40) {
    const distilled = await this.distill(text, project, maxItems);
    if (distilled.items.length === 0) {
      return { distilled: 0, written: 0, merged: 0, indexLine: distilled.index_line };
    }
    const migrated = await this.migrate(distilled.items, project);
    return {
      distilled: distilled.count,
      written: migrated.written,
      merged: migrated.merged,
      indexLine: distilled.index_line
    };
  }
};

// src/recoverable.ts
var DEFAULT_BACKOFF = {
  // 2s 起步：足够躲开「刚失败就立刻重试」的抖动，又不至于让用户等太久
  baseMs: 2e3,
  // 60s 封顶：即使连续失败很久，一分钟后至少还有一次机会自愈
  maxMs: 6e4
};
function normalizeBackoff(input) {
  const raw = input ?? {};
  const pick = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const baseMs = pick(raw.baseMs, DEFAULT_BACKOFF.baseMs);
  const maxMs = pick(raw.maxMs, DEFAULT_BACKOFF.maxMs);
  return { baseMs, maxMs: Math.max(baseMs, maxMs) };
}
var Recoverable = class {
  factory;
  now;
  backoff;
  value = null;
  state = "idle";
  inflight = null;
  /** 下次允许尝试的时刻（毫秒时间戳） */
  nextAttemptAt = 0;
  successes = 0;
  failures = 0;
  consecutiveFailures = 0;
  lastError;
  lastBackoffMs = 0;
  /**
   * 显式作废后置位。
   *
   * 与「失败退避」区分开：作废是「之前好好的，刚才那一下断了」，
   * 应该**立刻**允许重连；退避只在连续失败时才拉长等待。
   */
  invalidated = false;
  constructor(factory, options = {}) {
    this.factory = factory;
    this.now = options.now ?? (() => Date.now());
    this.backoff = normalizeBackoff(options.backoff);
  }
  /** 当前是否已有可用值（不触发任何重试）。 */
  get ready() {
    return this.value !== null;
  }
  /** 已就绪则直接返回，否则 null（不触发重试）。 */
  peek() {
    return this.value;
  }
  /**
   * 取资源。未就绪时按需重试。
   *
   * @returns 资源；本轮不该尝试（退避中）或重试失败时为 null
   */
  async get() {
    if (this.value !== null) return this.value;
    if (this.now() < this.nextAttemptAt) return null;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.attempt();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
  /** 执行一次真实的初始化尝试。 */
  async attempt() {
    try {
      const value = await this.factory();
      this.value = value;
      this.state = "ready";
      this.successes += 1;
      this.consecutiveFailures = 0;
      this.lastError = void 0;
      this.nextAttemptAt = 0;
      this.invalidated = false;
      return value;
    } catch (error) {
      this.failures += 1;
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "failed";
      this.value = null;
      const exp = this.backoff.baseMs * 2 ** Math.min(this.consecutiveFailures - 1, 10);
      this.lastBackoffMs = Math.min(exp, this.backoff.maxMs);
      this.nextAttemptAt = this.now() + this.lastBackoffMs;
      return null;
    }
  }
  /**
   * 作废当前值，下次 `get()` 立刻重试。
   *
   * 用于**热路径发现连接断了**的场景：既然是刚断的，就没必要再等退避。
   * 注意不清零 `consecutiveFailures`——连续失败仍然会拉长下一次的等待。
   */
  invalidate(reason) {
    this.value = null;
    this.state = "failed";
    this.invalidated = true;
    if (reason !== void 0) this.lastError = reason;
    this.nextAttemptAt = 0;
  }
  /** 状态快照。 */
  status() {
    const wait = Math.max(0, this.nextAttemptAt - this.now());
    return {
      state: this.state,
      successes: this.successes,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      retryInMs: this.value === null ? wait : 0,
      lastBackoffMs: this.lastBackoffMs
    };
  }
  /** 是否处于「作废后待重连」状态（诊断用）。 */
  get wasInvalidated() {
    return this.invalidated;
  }
};
function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/返回 \d{3}:/.test(message)) return false;
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|network/i.test(
    message
  );
}

// src/recall-injection.ts
var DEFAULT_RECALL_INJECTION = {
  // 2 条足够覆盖"用户偏好 + 关键决定"这类最常见场景，再多就是噪音
  maxItems: 2,
  maxCharsPerItem: 80,
  // 与快照 220 字符同量级，避免单次注入就把上下文撑大
  maxTotalChars: 240,
  // enrich 的 score_norm 是相对 top1 归一化的，低于 0.5 基本是"沾边"
  minScore: 0.5
};
function normalizeRecallOptions(input) {
  const raw = input ?? {};
  const num = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    // 0 是合法值（显式关闭），负数一律归 0
    maxItems: Math.max(0, Math.floor(num(raw.maxItems, DEFAULT_RECALL_INJECTION.maxItems))),
    maxCharsPerItem: Math.max(
      1,
      Math.floor(num(raw.maxCharsPerItem, DEFAULT_RECALL_INJECTION.maxCharsPerItem))
    ),
    maxTotalChars: Math.max(
      1,
      Math.floor(num(raw.maxTotalChars, DEFAULT_RECALL_INJECTION.maxTotalChars))
    ),
    // 相关度必须落在 [0,1]，否则过滤条件会恒真或恒假
    minScore: Math.min(1, Math.max(0, num(raw.minScore, DEFAULT_RECALL_INJECTION.minScore)))
  };
}
function formatRecallInjection(memories, options = DEFAULT_RECALL_INJECTION) {
  if (options.maxItems <= 0) return "";
  const picked = memories.filter((m) => typeof m.content === "string" && m.content.trim().length > 0).filter((m) => (m.score_norm ?? 1) >= options.minScore).slice(0, options.maxItems);
  if (picked.length === 0) return "";
  const lines = picked.map((m) => {
    const body = m.content.trim().replace(/\s+/g, " ");
    const cut = body.length > options.maxCharsPerItem ? `${body.slice(0, options.maxCharsPerItem)}…` : body;
    return `- ${cut}`;
  });
  let text = `[LRC 相关记忆]
${lines.join("\n")}`;
  while (text.length > options.maxTotalChars && picked.length > 1) {
    picked.pop();
    const kept = picked.map((m) => {
      const body = m.content.trim().replace(/\s+/g, " ");
      return `- ${body.length > options.maxCharsPerItem ? `${body.slice(0, options.maxCharsPerItem)}…` : body}`;
    });
    text = `[LRC 相关记忆]
${kept.join("\n")}`;
  }
  if (text.length > options.maxTotalChars) {
    text = `${text.slice(0, options.maxTotalChars - 1)}…`;
  }
  return text;
}
var CONTINUATION_HINTS = [
  "继续",
  "接着",
  "然后",
  "往下",
  "下一步",
  "再来",
  "好的",
  "好",
  "行",
  "可以",
  "go on",
  "continue",
  "next",
  "ok",
  "okay",
  "proceed",
  "carry on"
];
function isContinuation(text) {
  const t = text.toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, "");
  if (t.length === 0 || t.length > 8) return false;
  for (const h of CONTINUATION_HINTS) {
    const stripped = t.replace(h, "");
    if (stripped.length !== t.length && stripped.length <= 2) return true;
  }
  return false;
}
function topicFingerprint(text, previous) {
  if (previous !== void 0 && previous.length > 0 && isContinuation(text)) {
    return previous;
  }
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  if (normalized.length === 0) return "";
  const STOP = /* @__PURE__ */ new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "you",
    "can",
    "please",
    "然后",
    "继续",
    "现在",
    "这个",
    "那个",
    "帮我",
    "一下",
    "可以",
    "怎么",
    "什么",
    "还是",
    "就是",
    "已经",
    "需要",
    "的",
    "了",
    "吗",
    "呢"
  ]);
  const tokens = [];
  for (const part of normalized.split(" ")) {
    if (part.length === 0) continue;
    if (/^[a-z0-9_.-]+$/.test(part)) {
      if (part.length >= 2 && !STOP.has(part)) tokens.push(part);
      continue;
    }
    const cleaned = [...part].filter((ch) => !STOP.has(ch)).join("");
    if (cleaned.length === 1) tokens.push(cleaned);
    for (let i = 0; i + 2 <= cleaned.length; i += 1) tokens.push(cleaned.slice(i, i + 2));
  }
  const uniq = [...new Set(tokens)].sort();
  const bucket = Math.floor(normalized.length / 20);
  if (uniq.length === 0) return `len:${bucket}`;
  return `len:${bucket}|${uniq.slice(0, 6).join(",")}`;
}

// src/cursor.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname } from "node:path";
function hashLine(line) {
  return createHash2("sha256").update(line, "utf8").digest("hex").slice(0, 16);
}
function snapshotFingerprint(text) {
  return hashLine(text.replace(/\s+/g, " ").trim());
}
function snapshotChanged(previous, next) {
  if (previous === next) return false;
  return snapshotFingerprint(previous) !== snapshotFingerprint(next);
}
function sliceByCursor(lines, state) {
  if (state === null || state.lastLine <= 0) {
    return { text: lines.join("\n"), fromLine: 0, reset: false };
  }
  if (state.lastLine > lines.length) {
    return { text: lines.join("\n"), fromLine: 0, reset: true };
  }
  const anchor = lines[state.lastLine - 1] ?? "";
  if (hashLine(anchor) !== state.lastHash) {
    return { text: lines.join("\n"), fromLine: 0, reset: true };
  }
  return {
    text: lines.slice(state.lastLine).join("\n"),
    fromLine: state.lastLine,
    reset: false
  };
}
function advanceCursor(lines, sessionId, fromLine, consumedLines) {
  const lastLine = Math.min(fromLine + consumedLines, lines.length);
  return {
    sessionId,
    lastLine,
    lastHash: lastLine > 0 ? hashLine(lines[lastLine - 1] ?? "") : "",
    updatedAt: Date.now()
  };
}
var CursorStore = class {
  filePath;
  cache = null;
  constructor(filePath) {
    this.filePath = filePath;
  }
  loadAll() {
    if (this.cache !== null) return this.cache;
    try {
      if (existsSync2(this.filePath)) {
        this.cache = JSON.parse(readFileSync2(this.filePath, "utf8"));
      } else {
        this.cache = {};
      }
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
  get(sessionId) {
    return this.loadAll()[sessionId] ?? null;
  }
  set(state) {
    const all = this.loadAll();
    all[state.sessionId] = state;
    try {
      mkdirSync2(dirname(this.filePath), { recursive: true });
      writeFileSync2(this.filePath, JSON.stringify(all, null, 2), "utf8");
    } catch {
    }
  }
};
var RecentStore = class {
  filePath;
  cache = null;
  constructor(filePath) {
    this.filePath = filePath;
  }
  load() {
    if (this.cache !== null) return this.cache;
    try {
      if (existsSync2(this.filePath)) {
        const parsed = JSON.parse(readFileSync2(this.filePath, "utf8"));
        this.cache = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
      } else {
        this.cache = [];
      }
    } catch {
      this.cache = [];
    }
    return this.cache;
  }
  save(items) {
    this.cache = items;
    try {
      mkdirSync2(dirname(this.filePath), { recursive: true });
      writeFileSync2(this.filePath, JSON.stringify(items), "utf8");
    } catch {
    }
  }
};

// src/memory-filter.ts
var MEMORY_TAG_OPEN = "<lrc_memory>";
var MEMORY_TAG_CLOSE = "</lrc_memory>";
function findTagBlocks(text) {
  const blocks = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith(MEMORY_TAG_OPEN)) {
      const openAt = offset + line.indexOf(MEMORY_TAG_OPEN);
      const closeAt = text.indexOf(MEMORY_TAG_CLOSE, openAt + MEMORY_TAG_OPEN.length);
      if (closeAt >= 0) {
        blocks.push({
          start: openAt,
          end: closeAt + MEMORY_TAG_CLOSE.length,
          body: text.slice(openAt + MEMORY_TAG_OPEN.length, closeAt).trim()
        });
      }
    }
    offset += line.length + 1;
  }
  return blocks;
}
function extractMemoryTag(text) {
  const blocks = findTagBlocks(text);
  if (blocks.length === 0) return null;
  const body = blocks[blocks.length - 1].body;
  return body.length > 0 ? body : null;
}
function stripMemoryTag(text) {
  const blocks = findTagBlocks(text);
  if (blocks.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return out + text.slice(cursor);
}
function isNoUpdate(body) {
  const t = body.trim().replace(/[。.!！\s]/g, "").toLowerCase();
  return t === "无新增" || t === "无" || t === "none" || t === "noupdate" || t === "nothing";
}
var SMALL_TALK = [
  "你好",
  "您好",
  "谢谢",
  "多谢",
  "好的",
  "收到",
  "明白",
  "了解",
  "ok",
  "okay",
  "thanks",
  "thankyou",
  "hello",
  "hi"
];
function isSmallTalk(line) {
  const t = line.trim().toLowerCase().replace(/[。！!，,、；;：:\s]/g, "");
  if (t.length === 0) return true;
  if (t.length > 12) return false;
  return SMALL_TALK.some((word) => t.startsWith(word));
}
var ERROR_MARKERS = [
  "error",
  "exception",
  "panic",
  "failed",
  "failure",
  "traceback",
  "错误",
  "异常",
  "失败",
  "报错",
  "崩溃",
  "堆栈",
  "调用栈"
];
function hasErrorMarker(line) {
  const lower = maskPaths(line).toLowerCase();
  return ERROR_MARKERS.some((marker) => lower.includes(marker));
}
function looksLikeNormalLog(line) {
  const t = line.trim();
  if (hasErrorMarker(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return true;
  if (/^\[?(INFO|DEBUG|TRACE|VERBOSE)\]?[\s:]/i.test(t)) return true;
  return false;
}
function stripCodeFences(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}
function isOptionLabel(line) {
  const t = line.trim();
  if (/^[-*+]\s*\*\*[A-Za-z0-9]{1,3}\*\*\s*[：:]/.test(t)) return true;
  if (/^[-*+]\s*[A-Za-z0-9]{1,3}[.、)]\s/.test(t)) return true;
  return false;
}
var PATH_BOUNDARY = "[^\\s，。；：、！？\"'`（）()【】\\[\\]{}<>《》「」]";
var PATH_PATTERNS = [
  /\bhttps?:\/\/[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+/gi,
  /[A-Za-z]:[\\/][^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*/g,
  /\\\\[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*/g,
  // 相对路径：**只认 ASCII 路径段**。
  //
  // 不能用 `${PATH_BOUNDARY}*[\\/]${PATH_BOUNDARY}*` —— PATH_BOUNDARY 含 CJK，
  // 会把 `禁止使用3099/3111` 整段挖成空格，真实约束直接丢失（实测回归）。
  // CJK 文件名由下面的扩展名规则兜住（`docs/规范.md` 仍会被完整挖掉）。
  /(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]*/g,
  new RegExp(
    `${PATH_BOUNDARY}+\\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|ini|cfg|conf|png|jpe?g|gif|svg|webp|bmp|pdf|docx?|xlsx?|pptx?|csv|log|exe|dll|so|dylib|lock|html?|css|scss|less|py|rs|go|java|kt|sh|ps1|bat|cmd|zip|tar|gz|7z|mp4|mp3|wav)\\b`,
    "gi"
  )
];
function maskPaths(text) {
  let out = text;
  for (const pattern of PATH_PATTERNS) {
    out = out.replace(pattern, (token) => " ".repeat(token.length));
  }
  return out;
}
var CONSTRAINT_WORDS = [
  "必须",
  "禁止",
  "严禁",
  "切勿",
  "不得",
  "不能",
  "不要",
  "不允许",
  "不许",
  "不准",
  "禁用",
  "杜绝",
  "一律",
  "统一",
  "统一为",
  "默认",
  "只允许",
  "只能",
  "务必",
  "一定要",
  "请用",
  "记得",
  "别忘",
  "下次",
  "别用",
  "别再",
  "别动",
  "别改",
  "别删",
  "别碰",
  "别连",
  "别把",
  "别写",
  "别存",
  "别加",
  "改用",
  "换成",
  "改成",
  "以后都",
  "今后都"
];
var ENGLISH_CONSTRAINT = /\b(?:never|always|must(?:\s+not)?|should\s+not|do\s+not|don'?t|dont|avoid|forbidden|prohibited|not\s+allowed|only\s+use|required\s+to)\b/i;
var SHORT_LINE_KEYWORDS = [
  .../* @__PURE__ */ new Set([
    ...CONSTRAINT_WORDS,
    "严禁",
    "决定",
    "决策",
    "结论",
    "约束",
    "规范",
    "约定",
    "原则",
    "端口",
    "架构"
  ])
];
var MIN_CHARS = 20;
var MIN_BODY_CHARS = 8;
function hitsKeyword(body) {
  if (ENGLISH_CONSTRAINT.test(body)) return true;
  return SHORT_LINE_KEYWORDS.some((k) => body.includes(k));
}
function hasConstraintMarker(text) {
  return hitsKeyword(maskPaths(text));
}
function hardFilter(text) {
  const tag = extractMemoryTag(text);
  if (tag !== null) {
    if (isNoUpdate(tag)) return "";
    return stripCodeFences(tag).trim();
  }
  const body = stripCodeFences(stripMemoryTag(text));
  const kept = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (isSmallTalk(line)) continue;
    if (isOptionLabel(line)) continue;
    if (looksLikeNormalLog(line)) continue;
    const masked = maskPaths(line);
    const hasKeyword = hitsKeyword(masked);
    if (line.length < MIN_CHARS && !hasKeyword) continue;
    if (!hasKeyword && masked.replace(/\s+/g, "").length < MIN_BODY_CHARS) continue;
    kept.push(line);
  }
  return kept.join("\n");
}
var CONCLUSION_MARKERS = [
  "结论",
  "因此",
  "所以",
  "决定",
  "必须",
  "不能",
  "应该",
  "最终",
  "综上",
  "关键是",
  "根因",
  "原因",
  "方案",
  "改用",
  "采用",
  "确认",
  "发现",
  "注意"
];
var ENGLISH_STRONG = /\b(?:therefore|thus|hence|conclusion|concluded|decided|decision|root\s+cause)\b/i;
var ENGLISH_WEAK = /\b(?:must|should|need\s+to|because)\b/i;
var PROCESS_NARRATION = /^(?:(?:I|We)\s+(?:should|need\s+to|will|am|are|'ll|'re)\s+(?:check|look|read|see|try|start|begin|open|run|search|find|verify|inspect|edit|update|fix|add|remove|change)\b|Let\s+me\b|Now\b|First\b|Next\b|Then\b|Okay\b|OK\b|Hmm\b|Wait\b|Looking\b|Checking\b|Reading\b|Let's\b)/i;
function conclusionsFromReasoning(text, maxLines = 5, maxChars = 300) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of text.split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/)) {
    const line = raw.trim();
    if (line.length < 8 || line.length > maxChars) continue;
    if (isSmallTalk(line) || isOptionLabel(line) || looksLikeNormalLog(line)) continue;
    if (stripCodeFences(line) !== line) continue;
    const masked = maskPaths(line);
    const chineseHit = CONCLUSION_MARKERS.some((marker) => masked.includes(marker));
    const englishStrong = ENGLISH_STRONG.test(masked);
    const englishWeak = ENGLISH_WEAK.test(masked);
    if (!chineseHit && !englishStrong && !englishWeak) continue;
    if (!chineseHit && !englishStrong && englishWeak) {
      if (line.length < 20 || PROCESS_NARRATION.test(line)) continue;
    }
    const key = line.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}
function jaccard(a, b) {
  const setA = new Set(a.replace(/\s+/g, ""));
  const setB = new Set(b.replace(/\s+/g, ""));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
var DEFAULT_DEDUP_THRESHOLD = 0.85;
function isDuplicate(text, recent, threshold = DEFAULT_DEDUP_THRESHOLD) {
  const t = text.trim();
  if (t.length === 0) return true;
  return recent.some((r) => jaccard(r, t) >= threshold);
}

// src/offloader.ts
var DEFAULT_OFFLOAD_CONFIG = {
  turnsThreshold: 8,
  charsThreshold: 6e3,
  stepsThreshold: 20,
  project: "dsh",
  maxItems: 40,
  snapshotItems: 3,
  dedupThreshold: DEFAULT_DEDUP_THRESHOLD,
  recentWindow: 50
};
function buildSnapshot(items, maxItems) {
  if (items.length === 0) return "";
  const picked = items.slice(0, maxItems).map((item) => {
    const body = item.content.replace(/^\[[^\]]+\]\s*/, "");
    const short = body.length > 120 ? `${body.slice(0, 120)}…` : body;
    return short;
  });
  return `[LRC 状态] ${picked.join("；")}。细节在 LRC，需要时 recall。`;
}
var PROCESS_NARRATION2 = /接下来|下一步|我要|待确认|待验证|还需要|准备|打算|将要/;
var COMPLETION_WORDS = /已完成|已确认|已验证|已修复|结论是|因此|所以|说明|表明/;
function isProcessNarration(body) {
  return PROCESS_NARRATION2.test(body) && !COMPLETION_WORDS.test(body);
}
function classifyTagLine(line) {
  const head = /^(决策|约束|结论)\s*[：:]/.exec(line);
  if (head !== null) {
    const body2 = line.slice(head[0].length).trim();
    switch (head[1]) {
      case "约束":
        return { kind: "约束", memoryType: "preference", tag: "constraint", importance: 7 };
      case "决策":
        return { kind: "决策", memoryType: "decision", tag: "decision", importance: 7 };
      default:
        if (isProcessNarration(body2)) {
          return { kind: "事实", memoryType: "fact", tag: "fact", importance: 5 };
        }
        return { kind: "结论", memoryType: "fact", tag: "conclusion", importance: 6 };
    }
  }
  const body = maskPaths(line);
  if (/禁止|严禁|不得|不要|不能|切勿|杜绝|不允许|必须|约束|一律|统一为/.test(body)) {
    return { kind: "约束", memoryType: "preference", tag: "constraint", importance: 7 };
  }
  if (/决策|决定|采用|改用|选型|定为|换成|改成/.test(body)) {
    return { kind: "决策", memoryType: "decision", tag: "decision", importance: 7 };
  }
  return { kind: "结论", memoryType: "fact", tag: "conclusion", importance: 6 };
}
function itemsFromTag(tag) {
  const items = [];
  const lines = tag.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim().replace(/^[-*+]\s*/, "").trim();
    if (line.length === 0) continue;
    const { kind, memoryType, tag: tagName, importance } = classifyTagLine(line);
    const body = line.replace(/^(决策|约束|结论|决定)\s*[：:]\s*/, "").trim();
    items.push({
      content: `[${kind}] ${body.length > 0 ? body : line}`,
      memory_type: memoryType,
      tags: [tagName, "distilled", "lrc_memory"],
      importance,
      source_turns: [i, i]
    });
  }
  return items;
}
var Offloader = class {
  /**
   * LRC 客户端**可后置注入**。
   *
   * 为什么不是构造时写死：插件可能在 LRC 还没起来时加载（实测桌面端晚 20 分钟），
   * 此前的做法是整个 Offloader 都不创建 —— 连 `observe()` 的计数都不做，
   * 于是 LRC 恢复后，之前那些轮次的内容已经不在待沉淀队列里了。
   *
   * 现在计数器先跑起来，连接一旦就绪只需 `bind()`，不丢历史累计。
   */
  client;
  cursors;
  config;
  recentStore;
  pendingTurns = 0;
  pendingChars = 0;
  pendingSteps = 0;
  /** 最近已发送的块，用于本地查重（跨会话共享，避免重复入库） */
  recent = [];
  /** 累计统计（`lrc_status` 用） */
  flushCount = 0;
  totalWritten = 0;
  totalMerged = 0;
  totalDeduped = 0;
  lastFlushAt = 0;
  lastFlushWritten = 0;
  lastFlushMerged = 0;
  constructor(client, cursors, config = {}, recentStore) {
    this.client = client;
    this.cursors = cursors;
    this.config = { ...DEFAULT_OFFLOAD_CONFIG, ...config };
    this.recentStore = recentStore;
    this.recent = recentStore?.load() ?? [];
  }
  /** 连接是否已就绪。 */
  get connected() {
    return this.client !== null;
  }
  /**
   * 注入 / 替换客户端。
   *
   * 传 `null` 表示连接已断：保留所有计数器与游标，
   * 只停止发起 HTTP —— 恢复后可以接着从断点继续，不会重复也不会丢失。
   */
  bind(client) {
    this.client = client;
  }
  /** 取客户端（未连接时抛错，调用方负责先判 `connected`）。 */
  requireClient() {
    if (this.client === null) {
      throw new Error("LRC 尚未连接");
    }
    return this.client;
  }
  /** 记录一轮新增文本（由 index.ts 在 assistant/message 事件里调用）。 */
  observe(text) {
    const cleaned = hardFilter(text);
    if (cleaned.trim().length === 0) return;
    this.pendingTurns += 1;
    this.pendingChars += cleaned.length;
  }
  /**
   * 记录一步。
   *
   * 长任务（88 步 / 138 次工具调用）里正文可能只有最后一条，
   * 只按"正文消息数"计数永远到不了阈值 —— 必须同时按步数兜底。
   */
  observeStep() {
    this.pendingSteps += 1;
  }
  /** 是否达到卸载阈值。 */
  shouldOffload() {
    return this.pendingTurns >= this.config.turnsThreshold || this.pendingChars >= this.config.charsThreshold || this.pendingSteps >= this.config.stepsThreshold;
  }
  /**
   * 是否有待沉淀内容（turn/end 兜底用）。
   *
   * 必须包含 `pendingSteps`：长任务里可能只有工具调用、没有正文，
   * 此时步数阈值已经触发，但 turns/chars 都是 0。漏掉步数会让
   * "88 步兜底"恰好在这类任务上失效。
   */
  hasPending() {
    return this.pendingTurns > 0 || this.pendingChars > 0 || this.pendingSteps > 0;
  }
  /** 重置计数器（卸载成功或会话切换时调用）。 */
  resetCounters() {
    this.pendingTurns = 0;
    this.pendingChars = 0;
    this.pendingSteps = 0;
  }
  /** 累计沉淀统计（`lrc_status` 用）。 */
  stats() {
    return {
      flushCount: this.flushCount,
      totalWritten: this.totalWritten,
      totalMerged: this.totalMerged,
      totalDeduped: this.totalDeduped,
      lastFlushAt: this.lastFlushAt,
      lastFlushWritten: this.lastFlushWritten,
      lastFlushMerged: this.lastFlushMerged,
      recentWindow: this.recent.length
    };
  }
  /** 记录一次沉淀结果（只统计真正有产出的批次）。 */
  record(result) {
    this.totalDeduped += result.deduped;
    if (result.written === 0 && result.merged === 0) return;
    this.flushCount += 1;
    this.totalWritten += result.written;
    this.totalMerged += result.merged;
    this.lastFlushAt = Date.now();
    this.lastFlushWritten = result.written;
    this.lastFlushMerged = result.merged;
  }
  /**
   * 执行一次卸载。
   *
   * @param sessionId 会话 ID（游标按会话分槽）
   * @param lines 当前 transcript 的全部行
   * @returns 卸载结果；没有新增内容时返回 null
   */
  async offload(sessionId, lines) {
    const state = this.cursors.get(sessionId);
    const slice = sliceByCursor(lines, state);
    if (slice.text.trim().length === 0) {
      this.resetCounters();
      return null;
    }
    const newLines = lines.slice(slice.fromLine);
    const taggedItems = [];
    const untagged = [];
    for (const message of newLines) {
      const tag = extractMemoryTag(message);
      if (tag !== null) {
        if (!isNoUpdate(tag)) taggedItems.push(...itemsFromTag(tag));
        continue;
      }
      const cleaned = hardFilter(message);
      if (cleaned.trim().length > 0) untagged.push(cleaned);
    }
    const freshTagged = [];
    const freshBlocks = [];
    let deduped = 0;
    for (const item of taggedItems) {
      if (isDuplicate(item.content, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      freshTagged.push(item);
    }
    for (const block of untagged) {
      if (isDuplicate(block, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      freshBlocks.push(block);
    }
    if (freshTagged.length === 0 && freshBlocks.length === 0) {
      this.commitCursor(sessionId, lines, slice.fromLine);
      const empty = {
        charsSent: 0,
        distilled: 0,
        written: 0,
        merged: 0,
        deduped,
        snapshot: "",
        reset: slice.reset
      };
      this.record(empty);
      return empty;
    }
    let items = [...freshTagged];
    let charsSent = freshTagged.reduce((sum, item) => sum + item.content.length, 0);
    if (freshBlocks.length > 0) {
      const text = freshBlocks.join("\n");
      charsSent += text.length;
      const distilled = await this.requireClient().distill(
        text,
        this.config.project,
        this.config.maxItems
      );
      items = [...items, ...distilled.items];
    }
    let written = 0;
    let merged = 0;
    if (items.length > 0) {
      const migrated = await this.requireClient().migrate(items, this.config.project);
      written = migrated.written;
      merged = migrated.merged;
    }
    this.commitCursor(sessionId, lines, slice.fromLine);
    this.recent.push(...freshTagged.map((item) => item.content), ...freshBlocks);
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);
    const result = {
      charsSent,
      distilled: items.length,
      written,
      merged,
      deduped,
      snapshot: buildSnapshot(items, this.config.snapshotItems),
      reset: slice.reset
    };
    this.record(result);
    return result;
  }
  /**
   * 直接沉淀一批已提炼的条目（**不走行游标**）。
   *
   * 用于推理结论兜底：这些句子来自 reasoning 流，不在 transcript 行流里，
   * 无法用行号游标追踪，只能按内容查重。查重窗口与主路径共用。
   *
   * @param items 已分类的记忆条目
   * @returns 卸载结果；全部被查重拦下时返回零值结果
   */
  async offloadItems(items) {
    const fresh = [];
    let deduped = 0;
    for (const item of items) {
      if (isDuplicate(item.content, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      fresh.push(item);
    }
    if (fresh.length === 0) {
      const empty = {
        charsSent: 0,
        distilled: 0,
        written: 0,
        merged: 0,
        deduped,
        snapshot: "",
        reset: false
      };
      this.record(empty);
      return empty;
    }
    const migrated = await this.requireClient().migrate(fresh, this.config.project);
    this.recent.push(...fresh.map((item) => item.content));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);
    const result = {
      charsSent: fresh.reduce((sum, item) => sum + item.content.length, 0),
      distilled: fresh.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      snapshot: buildSnapshot(fresh, this.config.snapshotItems),
      reset: false
    };
    this.record(result);
    return result;
  }
  /** 推进游标并重置计数器（只在本次内容已处理完时调用）。 */
  commitCursor(sessionId, lines, fromLine) {
    const consumed = lines.length - fromLine;
    this.cursors.set(advanceCursor(lines, sessionId, fromLine, consumed));
    this.resetCounters();
  }
};

// src/event-classify.ts
function classifyEvent(event) {
  const e = event;
  switch (e?.type) {
    case "system/message":
      return "system";
    case "assistant/message":
      return "assistant";
    case "tool/result":
      return "tool-result";
    case "user/message": {
      const kind = e.data?.source?.kind;
      return kind === void 0 || kind === "user" ? "user" : "injected";
    }
    default:
      return "unknown";
  }
}
function isConversationNode(event) {
  const category = classifyEvent(event);
  return category === "user" || category === "assistant" || category === "tool-result";
}
function isRealUserEvent(event) {
  return classifyEvent(event) === "user";
}

// src/session-text.ts
function messageContent(event) {
  const candidate = event;
  if (candidate?.type !== "assistant/message") return void 0;
  return candidate.data?.message?.content ?? candidate.message?.content;
}
function textBlocksOnly(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];
  for (const block of content) {
    const b = block;
    if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) texts.push(b.text);
  }
  return texts.join("\n");
}
function reasoningBlocksOnly(content) {
  if (!Array.isArray(content)) return "";
  const texts = [];
  for (const block of content) {
    const b = block;
    if (b?.type === "reasoning" && typeof b.text === "string" && b.text.length > 0) {
      texts.push(b.text);
    }
  }
  return texts.join("\n");
}
function hasMalformedTextBlock(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block;
    return (b?.type === "text" || b?.type === "reasoning") && typeof b.text !== "string";
  });
}
function userMessageText(event) {
  const candidate = event;
  if (candidate?.type !== "user/message") return "";
  return textBlocksOnly(candidate.data?.content);
}
function isRealUserMessage(event) {
  return isRealUserEvent(event);
}
function hasUserConstraint(text) {
  return hasConstraintMarker(text);
}
function linesFromSession(session) {
  const log = session?.log;
  if (!Array.isArray(log)) return [];
  const lines = [];
  for (const raw of log) {
    const event = raw;
    const category = classifyEvent(event);
    if (category === "assistant") {
      const text = textBlocksOnly(event.data?.message?.content);
      if (text.length > 0) lines.push(text);
    } else if (category === "user") {
      if (!isRealUserMessage(event)) continue;
      const text = textBlocksOnly(event.data?.content);
      if (text.length === 0) continue;
      if (!hasUserConstraint(text)) continue;
      lines.push(text);
    }
  }
  return lines;
}

// src/context-trim.ts
import { randomUUID } from "node:crypto";
function safeGet(ctx, name2) {
  try {
    return ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
function resolveSessionEvents(session) {
  const s = session;
  try {
    const snapshot = s?.snapshotEvents?.();
    if (Array.isArray(snapshot)) return snapshot;
  } catch {
  }
  if (Array.isArray(s?.events)) return s.events;
  if (Array.isArray(s?.log)) return s.log;
  return void 0;
}
var SUMMARY_TEXT_PREFIXES = [
  "## 已裁剪的历史",
  "This is an automatically generated checkpoint",
  "<compacted-summary>"
];
function isSummaryNode(event) {
  const e = event;
  if (e?.type !== "user/message") return false;
  const kind = e.data?.source?.kind;
  if (kind === "compact-checkpoint" || kind === "compaction" || kind === "summary" || // LRC 自己产出的「已剪枝」节点（prune-reasoning 的替换体）：
  // 它是旧对话的改写版，必须可再次被 trim 覆盖，否则会像摘要一样累积。
  kind === "lrc-prune") {
    return true;
  }
  const content = e.data?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const text = block?.text;
    if (typeof text !== "string") continue;
    const head = text.trimStart();
    if (SUMMARY_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix))) return true;
  }
  return false;
}
function isTrimBoundaryEligible(event) {
  return isConversationNode(event) || isSummaryNode(event);
}
function toolDelta(event) {
  const e = event;
  if (e?.type === "assistant/message") {
    const content = e.data?.message?.content;
    if (!Array.isArray(content)) return 0;
    let calls = 0;
    for (const block of content) {
      if (block?.type === "tool-call") calls += 1;
    }
    return calls;
  }
  if (e?.type === "tool/result") return -1;
  return 0;
}
function selectTrimRange(nodes, events, keepRecentNodes) {
  const n = nodes.length;
  if (n <= keepRecentNodes + 1) return null;
  const cut = new Array(n + 1).fill(false);
  let running = 0;
  cut[0] = true;
  for (let i = 0; i < n; i += 1) {
    running += toolDelta(events[nodes[i]]);
    cut[i + 1] = running === 0;
  }
  let endIdx = n - keepRecentNodes - 1;
  while (endIdx >= 0 && (cut[endIdx + 1] !== true || !isTrimBoundaryEligible(events[nodes[endIdx]]))) {
    endIdx -= 1;
  }
  if (endIdx < 0) return null;
  let startIdx = 0;
  while (startIdx <= endIdx && (cut[startIdx] !== true || !isTrimBoundaryEligible(events[nodes[startIdx]]))) {
    startIdx += 1;
  }
  if (startIdx > endIdx) return null;
  return {
    start: nodes[startIdx],
    end: nodes[endIdx],
    startIdx,
    endIdx
  };
}
function findRetryStart(nodes, events, startIdx, endIdx) {
  let running = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    running += toolDelta(events[nodes[i]]);
    const candidate = i + 1;
    if (running === 0 && isTrimBoundaryEligible(events[nodes[candidate]])) {
      return candidate;
    }
  }
  return null;
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    const b = block;
    if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) out.push(b.text);
  }
  return out.join("\n");
}
function oneLine(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
function collect(target, seen, line, limit) {
  if (target.length >= limit) return;
  if (line.length === 0 || seen.has(line)) return;
  seen.add(line);
  target.push(line);
}
var NOISE_PREFIXES = [
  "Current runtime context.",
  "Current working directory:",
  "Current DSH file policy:",
  "Current DeepSeek Harness",
  "This is an automatically generated checkpoint",
  "<compacted-summary>",
  "</compacted-summary>",
  "<system-reminder>",
  "The available skill catalog changed",
  "The user changed the approval policy",
  "Approval prompts are disabled",
  // 每轮 prepare 时宿主采样时间并注入，同样伪装成 role:'user'
  "Time sampled while preparing",
  "Browser time zone for this request:",
  "## 已裁剪的历史",
  "### 用户请求",
  "### 工具调用与结果",
  "### 工具错误",
  "### 助手结论",
  "### 早期结论",
  "[LRC 状态]"
];
function isNoiseText(text) {
  const t = text.trimStart();
  if (t.length === 0) return true;
  const head = t.length > 160 ? t.slice(0, 160) : t;
  return NOISE_PREFIXES.some((p) => head.startsWith(p));
}
function isProcessNarration2(text) {
  if (!/接下来|下一步|我要|待确认|待验证|还需要|准备|打算|将要/.test(text)) return false;
  return !/已完成|已确认|已验证|已修复|结论是|因此|所以|说明|表明/.test(text);
}
function absorbPriorSummary(text, buckets, seen) {
  const limits = { requests: 8, calls: 20, errors: 10, conclusions: 10 };
  let section;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("## ")) continue;
    if (line.startsWith("### ")) {
      const title = line.slice(4).trim();
      if (title.startsWith("用户请求")) section = "requests";
      else if (title.startsWith("工具调用")) section = "calls";
      else if (title.startsWith("工具错误")) section = "errors";
      else if (title.startsWith("助手结论") || title.startsWith("早期结论")) section = "conclusions";
      else section = void 0;
      continue;
    }
    if (section === void 0) continue;
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    if (isNoiseText(body)) continue;
    collect(buckets[section], seen, `- ${body}`, limits[section]);
  }
}
function buildDeterministicSummary(messages, maxChars, realCounts) {
  const requests = [];
  const calls = [];
  const errors = [];
  const conclusions = [];
  const seen = /* @__PURE__ */ new Set();
  const priorSummaries = [];
  for (const raw of messages) {
    const message = raw;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (message.role === "tool") {
      const text2 = textOf(content);
      if (text2.length > 0) {
        const isError = message.isError === true || Array.isArray(content) && content.some((b) => b?.isError === true);
        if (isError) collect(errors, seen, `- ${oneLine(text2, 300)}`, 15);
        else collect(calls, seen, `- 结果：${oneLine(text2.split("\n")[0] ?? "", 150)}`, 30);
      }
      continue;
    }
    for (const block of content) {
      const b = block;
      if (b?.type === "text" && typeof b.text === "string") {
        if (isNoiseText(b.text) && b.text.trimStart().startsWith("## 已裁剪的历史")) {
          priorSummaries.push(b.text);
          continue;
        }
        if (isNoiseText(b.text)) continue;
        const line = oneLine(b.text, 300);
        if (message.role === "user") collect(requests, seen, `- ${line}`, 12);
        else if (!isProcessNarration2(b.text)) collect(conclusions, seen, `- ${line}`, 15);
      } else if (b?.type === "tool-call") {
        const name2 = typeof b.name === "string" ? b.name : "tool";
        const args = typeof b.arguments === "string" ? oneLine(b.arguments, 150) : "";
        collect(calls, seen, `- ${name2}(${args})`, 30);
      } else if (b?.type === "tool-result") {
        const text2 = textOf(b.content);
        if (text2.length === 0) continue;
        if (b.isError === true) collect(errors, seen, `- ${oneLine(text2, 300)}`, 15);
        else collect(calls, seen, `- 结果：${oneLine(text2.split("\n")[0] ?? "", 150)}`, 30);
      }
    }
  }
  if (realCounts !== void 0) {
    realCounts.requests = requests.length;
    realCounts.conclusions = conclusions.length;
    realCounts.errors = errors.length;
    realCounts.calls = calls.length;
  }
  for (let i = priorSummaries.length - 1; i >= 0; i -= 1) {
    absorbPriorSummary(priorSummaries[i], { requests, calls, errors, conclusions }, seen);
  }
  const all = [
    { title: "### 用户请求", lines: requests, weight: 3 },
    { title: "### 助手结论", lines: conclusions, weight: 2 },
    { title: "### 工具错误", lines: errors, weight: 1 },
    { title: "### 工具调用与结果", lines: calls, weight: 0 }
  ].filter((s) => s.lines.length > 0);
  const render = (sections) => {
    const out = ["## 已裁剪的历史（确定性摘要，无 LLM）"];
    for (const s of sections) out.push(s.title, ...s.lines);
    return out.join("\n");
  };
  let text = render(all);
  if (text.length <= maxChars) return text;
  const working = all.map((s) => ({ ...s, lines: [...s.lines] }));
  while (text.length > maxChars) {
    const target = working.filter((s) => s.lines.length > 0).sort((a, b) => a.weight - b.weight)[0];
    if (!target) break;
    target.lines.pop();
    text = render(working.filter((s) => s.lines.length > 0));
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
function summaryStats(text, realCounts) {
  const counts = { requests: 0, conclusions: 0, errors: 0, calls: 0 };
  let section;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      const title = line.slice(4).trim();
      if (title.startsWith("用户请求")) section = "requests";
      else if (title.startsWith("助手结论") || title.startsWith("早期结论")) section = "conclusions";
      else if (title.startsWith("工具错误")) section = "errors";
      else if (title.startsWith("工具调用")) section = "calls";
      else section = void 0;
      continue;
    }
    if (section !== void 0 && line.startsWith("- ")) counts[section] += 1;
  }
  const part = (label, total, real) => real !== void 0 && real !== total ? `${label} ${total}（真实 ${real}）` : `${label} ${total}`;
  return `${part("请求", counts.requests, realCounts?.requests)} / ${part("结论", counts.conclusions, realCounts?.conclusions)} / ${part("错误", counts.errors, realCounts?.errors)} / ${part("调用", counts.calls, realCounts?.calls)}`;
}
function meterOf(engine, ctx) {
  const engineCtx = engine?.ctx;
  const own = safeGet(engineCtx, "tokenMeter");
  if (own !== void 0) return own;
  return safeGet(ctx, "tokenMeter");
}
function resolvePruner(ctx, agent) {
  const direct = safeGet(ctx, "toolResultPruner");
  if (typeof direct?.pruneSession === "function") {
    return direct;
  }
  const presets = safeGet(ctx, "agentPresets");
  try {
    const viaPreset = presets?.serviceFor?.(agent, "toolResultPruner");
    if (typeof viaPreset?.pruneSession === "function") {
      return viaPreset;
    }
  } catch {
  }
  try {
    const engine = presets?.serviceFor?.(agent, "compaction");
    const viaEngine = engine?.ctx?.get?.(
      "toolResultPruner"
    );
    if (typeof viaEngine?.pruneSession === "function") {
      return viaEngine;
    }
  } catch {
  }
  return void 0;
}
function pruneToolResults(deps) {
  const { ctx, agent, log } = deps;
  const session = agent?.session;
  if (session === void 0) return { ok: false, reason: "no-session" };
  const pruner = resolvePruner(ctx, agent);
  if (typeof pruner?.pruneSession !== "function") {
    return { ok: false, reason: "pruner-unavailable" };
  }
  const originalConfig = pruner.config;
  let patched = false;
  if (deps.thresholdChars !== void 0 && originalConfig !== void 0) {
    const threshold = deps.thresholdChars;
    const head = Math.min(2048, Math.max(0, threshold - 600));
    const tail = Math.min(512, Math.max(0, threshold - head - 100));
    try {
      pruner.config = { ...originalConfig, thresholdChars: threshold, headChars: head, tailChars: tail };
      patched = true;
    } catch {
    }
  }
  try {
    const result = pruner.pruneSession(session);
    const count = Array.isArray(result?.pruned) ? result.pruned.length : 0;
    const charsRemoved = result?.charsRemoved ?? 0;
    if (count > 0) {
      log(`[lrc][prune] 裁剪 ${count} 条工具输出（省 ${charsRemoved} 字符）`);
    }
    return { ok: true, reason: "ok", pruned: count, charsRemoved };
  } catch (error) {
    return {
      ok: false,
      reason: `error:${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (patched) pruner.config = originalConfig;
  }
}
function appendReplace(session, content, seq) {
  const append = session?.append;
  if (typeof append !== "function") throw new Error("session.append unavailable");
  if (content.some((block) => block?.type === "tool-call")) {
    return false;
  }
  append.call(
    session,
    "user/message",
    // 必须带 `role: 'user'` 与 `id`：宿主 `createUserMessage` 会补这两个字段，
    // 而 `deriveEventMessage` 对 user/message 是**原样返回 data**，
    // 缺 role 会让 LLM 适配器拿不到消息角色。
    { role: "user", id: randomUUID(), content, source: { kind: "lrc-prune" } },
    {
      surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq]
    }
  );
  return true;
}
function pruneToolCallArguments(deps) {
  const { agent, log } = deps;
  const thresholdChars = deps.options?.thresholdChars ?? 4e3;
  const headChars = deps.options?.headChars ?? 2e3;
  const keepRecentNodes = deps.options?.keepRecentNodes ?? 8;
  const session = agent?.session;
  if (session === void 0) return { ok: false, reason: "no-session" };
  const nodes = session?.surface?.nodes;
  const events = resolveSessionEvents(session);
  const append = session?.append;
  if (!Array.isArray(nodes) || events === void 0 || typeof append !== "function") {
    return { ok: false, reason: "no-range" };
  }
  return { ok: false, reason: "incompatible-with-host-surface" };
}
function pruneReasoning(deps) {
  const { agent, log } = deps;
  const keepRecentNodes = deps.options?.keepRecentNodes ?? 8;
  const session = agent?.session;
  if (session === void 0) return { ok: false, reason: "no-session" };
  const nodes = session?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === void 0) {
    return { ok: false, reason: "no-range" };
  }
  const cutoff = nodes.length - keepRecentNodes;
  let pruned = 0;
  let charsRemoved = 0;
  try {
    for (let index = 0; index < cutoff; index += 1) {
      const seq = nodes[index];
      const event = events[seq];
      if (event?.type !== "assistant/message") continue;
      const message = event.data?.message;
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      const reasoningBlocks = content.filter(
        (block) => block?.type === "reasoning"
      );
      if (reasoningBlocks.length === 0) continue;
      if (reasoningBlocks.length === content.length) continue;
      const nextContent = content.filter(
        (block) => block?.type !== "reasoning"
      );
      if (appendReplace(session, nextContent, seq)) {
        for (const block of reasoningBlocks) {
          const text = block.text;
          if (typeof text === "string") charsRemoved += text.length;
        }
        pruned += 1;
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: `error:${error instanceof Error ? error.message : String(error)}`,
      pruned,
      charsRemoved
    };
  }
  if (pruned > 0) {
    log(`[lrc][prune-reasoning] 丢弃 ${pruned} 条旧推理（省 ${charsRemoved} 字符）`);
  }
  return { ok: true, reason: "ok", pruned, charsRemoved };
}
async function trimContext(deps) {
  const { ctx, agent, signal, options, log } = deps;
  const presets = safeGet(ctx, "agentPresets");
  let engine;
  try {
    engine = presets?.serviceFor?.(agent, "compaction");
  } catch (error) {
    return { ok: false, reason: `error:serviceFor ${String(error)}` };
  }
  const compactRegion = engine?.compactRegion;
  if (typeof compactRegion !== "function") {
    return {
      ok: false,
      reason: "engine-unavailable",
      detail: `serviceFor=${typeof presets?.serviceFor} engine=${engine === void 0 ? "undefined" : "present"}`
    };
  }
  const session = agent?.session;
  const nodes = session?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === void 0) {
    return {
      ok: false,
      reason: "no-range",
      detail: `nodes=${Array.isArray(nodes) ? nodes.length : "missing"} events=${events === void 0 ? "missing" : events.length}`
    };
  }
  const range = selectTrimRange(nodes, events, options.keepRecentNodes);
  if (range === null) {
    return {
      ok: false,
      reason: "no-range",
      detail: `nodes=${nodes.length} keepRecent=${options.keepRecentNodes}（节点太少或找不到平衡切点）`
    };
  }
  const meter = meterOf(engine, ctx);
  let totalTokens = 0;
  let shadowedTokens = 0;
  try {
    const measurement = meter?.measure?.(session);
    totalTokens = measurement?.totalTokens ?? 0;
    const priced = measurement?.nodes;
    if (Array.isArray(priced)) {
      for (let i = range.startIdx; i <= range.endIdx; i += 1) {
        shadowedTokens += priced[i]?.tokens ?? 0;
      }
    }
  } catch {
  }
  if (!options.force && totalTokens < options.minTokens) {
    return {
      ok: false,
      reason: "below-threshold",
      detail: `totalTokens=${totalTokens} min=${options.minTokens} meter=${meter === void 0 ? "missing" : "present"}`
    };
  }
  const target = engine;
  if (typeof target.summarize !== "function") {
    return {
      ok: false,
      reason: "engine-unavailable",
      detail: `summarize=${typeof target.summarize}`
    };
  }
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "summarize");
  const original = target.summarize;
  let summaryChars = 0;
  let summaryText = "";
  let summaryRealCounts = {
    requests: 0,
    conclusions: 0,
    errors: 0,
    calls: 0
  };
  target.summarize = async (input) => {
    const messages = input?.messages;
    const list = Array.isArray(messages) ? messages : [];
    let sourceChars = 0;
    for (const message of list) {
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block;
          if (typeof b?.text === "string") sourceChars += b.text.length;
          if (typeof b?.arguments === "string") sourceChars += b.arguments.length;
        }
      }
    }
    const cap = Math.max(200, Math.min(options.maxSummaryChars, Math.floor(sourceChars / 4)));
    const text = buildDeterministicSummary(list, cap, summaryRealCounts);
    summaryChars = text.length;
    summaryText = text;
    return {
      summary: [{ type: "text", text }],
      provider: "lrc",
      model: "deterministic"
    };
  };
  try {
    await target.compactRegion(range.start, range.end, agent, signal);
    log(
      `[lrc][trim] 已裁剪 ${range.endIdx - range.startIdx + 1} 个节点（总 ${totalTokens} tokens，${options.force ? "节点数强制" : "超阈值"}；约 ${shadowedTokens} tokens → 摘要 ${summaryChars} 字符：${summaryStats(summaryText, summaryRealCounts)}）`
    );
    return { ok: true, reason: "ok", shadowedTokens, summaryChars, summaryStats: summaryStats(summaryText, summaryRealCounts) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("holds the system prompt")) {
      const retryIdx = findRetryStart(nodes, events, range.startIdx, range.endIdx);
      if (retryIdx !== null) {
        try {
          await target.compactRegion(nodes[retryIdx], range.end, agent, signal);
          log(
            `[lrc][trim] 起点回退后成功（${retryIdx}..${range.endIdx}）（总 ${totalTokens} tokens，${options.force ? "节点数强制" : "超阈值"}；约 ${shadowedTokens} tokens → 摘要 ${summaryChars} 字符：${summaryStats(summaryText, summaryRealCounts)}）`
          );
          return { ok: true, reason: "ok", shadowedTokens, summaryChars, summaryStats: summaryStats(summaryText, summaryRealCounts) };
        } catch (retryError) {
          return {
            ok: false,
            reason: `error:${retryError instanceof Error ? retryError.message : String(retryError)}`,
            detail: `retry range=${retryIdx}..${range.endIdx}`
          };
        }
      }
    }
    return {
      ok: false,
      reason: `error:${message}`,
      detail: `range=${range.startIdx}..${range.endIdx} shadowedTokens=${shadowedTokens}`
    };
  } finally {
    if (hadOwn) target.summarize = original;
    else delete target.summarize;
  }
}

// src/handoff.ts
function buildHandoffText(input) {
  const sections = ["# 会话交接", ""];
  sections.push("## 当前任务");
  sections.push(input.lastUserRequest.trim().length > 0 ? input.lastUserRequest.trim() : "（未记录）");
  sections.push("");
  if (input.recentAssistant.length > 0) {
    sections.push("## 最近结论");
    for (const line of input.recentAssistant) {
      const flat = line.replace(/\s+/g, " ").trim();
      if (flat.length > 0) sections.push(`- ${flat.length > 300 ? `${flat.slice(0, 300)}…` : flat}`);
    }
    sections.push("");
  }
  if (input.snapshot.trim().length > 0) {
    sections.push("## 已沉淀状态");
    sections.push(input.snapshot.trim());
    sections.push("");
  }
  if (input.indexLines.length > 0) {
    sections.push("## 长期记忆索引");
    for (const line of input.indexLines) sections.push(`- ${line}`);
    sections.push("");
  }
  sections.push("## 下一步");
  sections.push(input.note.trim().length > 0 ? input.note.trim() : "（由接手方根据上述上下文继续）");
  return sections.join("\n");
}
function extractHandoffSource(session) {
  const log = session?.log;
  if (!Array.isArray(log)) return { lastUserRequest: "", recentAssistant: [] };
  let lastUserRequest = "";
  const assistant = [];
  for (const raw of log) {
    const event = raw;
    if (event?.type === "user/message") {
      const kind = event.data?.source?.kind;
      if (kind !== void 0 && kind !== "user") continue;
      const text = textOf2(event.data?.content);
      if (text.length > 0) lastUserRequest = text;
    } else if (event?.type === "assistant/message") {
      const text = textOf2(event.data?.message?.content);
      if (text.length > 0) assistant.push(text);
    }
  }
  return { lastUserRequest, recentAssistant: assistant.slice(-5) };
}
function textOf2(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    const b = block;
    if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) out.push(b.text);
  }
  return out.join("\n");
}
function safeGet2(ctx, name2) {
  try {
    return ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
async function createHandoffSession(deps) {
  const { ctx, agent, text, log } = deps;
  const current = agent;
  const currentId = current?.session?.id;
  const cwd = current?.session?.header?.cwd;
  const meta = {
    ...cwd === void 0 ? {} : { cwd },
    ...currentId === void 0 ? {} : { parentSession: currentId }
  };
  const userMessage = {
    content: [{ type: "text", text }],
    source: { kind: "user" }
  };
  const agents = safeGet2(ctx, "agents");
  if (typeof agents?.create === "function") {
    try {
      const handle = await agents.create({
        sessionId: `session-handoff-${Date.now()}`,
        meta,
        ...current?.options === void 0 ? {} : { agentOptions: current.options }
      });
      const session = handle?.agent?.session;
      if (typeof session?.append === "function") {
        session.append("user/message", userMessage);
        log(`[lrc][handoff] 已创建带 agent 的新会话：${session.id ?? "unknown"}`);
        return { ok: true, sessionId: session.id, mode: "agent", text };
      }
    } catch (error) {
      log(
        `[lrc][handoff] agents.create 失败，退回 sessions.create：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const sessions = safeGet2(ctx, "sessions");
  if (typeof sessions?.create === "function") {
    try {
      const session = sessions.create(void 0, { meta });
      if (typeof session?.append === "function") {
        session.append("user/message", userMessage);
        log(`[lrc][handoff] 已创建新会话（无 agent）：${session.id ?? "unknown"}`);
        return { ok: true, sessionId: session.id, mode: "session", text };
      }
    } catch (error) {
      log(
        `[lrc][handoff] sessions.create 失败，只返回摘要：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { ok: false, mode: "text-only", text, reason: "sessions-unavailable" };
}

// src/capabilities.ts
function safeGet3(ctx, name2) {
  try {
    return ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
function hasFn(value, name2) {
  return typeof value?.[name2] === "function";
}
function fromEngine(engine, name2) {
  try {
    return engine?.ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
function probeSurfaceOpShape(session) {
  const events = resolveSessionEvents(session);
  if (events === void 0) return "unknown";
  for (const raw of events) {
    const op = raw?.surfaceOp;
    if (op === null || typeof op !== "object") continue;
    const record = op;
    if (record["op"] !== "replace") continue;
    if (Object.hasOwn(record, "start") && Object.hasOwn(record, "end")) return "start-end";
    if (Object.hasOwn(record, "startSeq") && Object.hasOwn(record, "endSeq")) return "startSeq-endSeq";
  }
  return "unknown";
}
function probeCapabilities(ctx, agent) {
  const presets = safeGet3(ctx, "agentPresets");
  let engine;
  let engineError = "";
  try {
    engine = presets?.serviceFor?.(agent, "compaction");
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
  }
  const compaction = {
    available: hasFn(engine, "compactRegion"),
    detail: engineError !== "" ? `serviceFor 抛错：${engineError}` : engine === void 0 ? "serviceFor 返回 undefined" : `引擎=${engine?.constructor?.name ?? "unknown"}`
  };
  const meter = fromEngine(engine, "tokenMeter") ?? safeGet3(ctx, "tokenMeter");
  const tokenMeter = {
    available: hasFn(meter, "measure"),
    detail: meter === void 0 ? "tokenMeter 不可达" : "measure 可用"
  };
  const pruner = safeGet3(ctx, "toolResultPruner") ?? (() => {
    try {
      return presets?.serviceFor?.(agent, "toolResultPruner");
    } catch {
      return void 0;
    }
  })() ?? fromEngine(engine, "toolResultPruner");
  const toolResultPruner = {
    available: hasFn(pruner, "pruneSession"),
    detail: pruner === void 0 ? "toolResultPruner 不可达" : "pruneSession 可用"
  };
  const sessions = safeGet3(ctx, "sessions");
  const agents = safeGet3(ctx, "agents");
  const systemPrompt = safeGet3(ctx, "systemPrompt");
  return {
    compaction,
    tokenMeter,
    toolResultPruner,
    sessions: {
      available: hasFn(sessions, "create"),
      detail: sessions === void 0 ? "sessions 不可达" : "create 可用"
    },
    agents: {
      available: hasFn(agents, "create"),
      detail: agents === void 0 ? "agents 不可达" : "create 可用"
    },
    systemPrompt: {
      available: hasFn(systemPrompt, "section") || hasFn(systemPrompt, "context"),
      detail: systemPrompt === void 0 ? "systemPrompt 不可达" : "section/context 可用"
    },
    surfaceOpShape: probeSurfaceOpShape(agent?.session),
    probedAt: Date.now()
  };
}
function formatCapabilities(matrix) {
  const rows = [
    ["compaction", matrix.compaction],
    ["tokenMeter", matrix.tokenMeter],
    ["toolResultPruner", matrix.toolResultPruner],
    ["sessions", matrix.sessions],
    ["agents", matrix.agents],
    ["systemPrompt", matrix.systemPrompt]
  ];
  const lines = rows.map(
    ([name2, cap]) => `[lrc][cap] ${cap.available ? "可用  " : "不可用"} ${name2} | ${cap.detail}`
  );
  lines.push(`[lrc][cap] surfaceOp 形状：${matrix.surfaceOpShape}`);
  return lines;
}

// src/budget.ts
var MIN_SANE_WINDOW = 8192;
var MAX_TRUSTED_WINDOW = 1e6;
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function safeGet4(ctx, name2) {
  try {
    return ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
function routedTarget(session) {
  const config = session?.requestHeader?.()?.config;
  const provider = config?.provider;
  const model = config?.model;
  if (typeof provider !== "string" || typeof model !== "string") return void 0;
  if (provider.length === 0 || model.length === 0) return void 0;
  return { provider, model };
}
async function resolveBudget(deps) {
  const { ctx, agent, config } = deps;
  if (config.contextWindowTokens > 0) {
    return derive(config.contextWindowTokens, config, "configured");
  }
  const session = agent?.session;
  const target = routedTarget(session);
  if (target === void 0) {
    return {
      windowTokens: 0,
      trimMinTokens: config.trimMinTokens,
      pruneResultThreshold: config.pruneResultThreshold,
      source: "fallback"
    };
  }
  const llm = safeGet4(ctx, "llm");
  if (typeof llm?.resolveModelInfo !== "function") {
    return {
      windowTokens: 0,
      trimMinTokens: config.trimMinTokens,
      pruneResultThreshold: config.pruneResultThreshold,
      source: "fallback"
    };
  }
  try {
    const info = await llm.resolveModelInfo(target.provider, target.model);
    const window = info?.context?.contextWindow;
    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
      if (window >= MAX_TRUSTED_WINDOW) {
        return {
          windowTokens: 0,
          trimMinTokens: config.trimMinTokens,
          pruneResultThreshold: config.pruneResultThreshold,
          source: "fallback",
          model: target.model,
          // 提示可显式配置：哨兵值无法区分「真实 1M 窗口」与「未知模型」，
          // 若确知模型窗口，配置 contextWindowTokens 即可按真实窗口推导阈值。
          note: `probe=${window} 达到可信上限，视为未知模型；如确知窗口请显式配置 contextWindowTokens`
        };
      }
      const sane = Math.max(MIN_SANE_WINDOW, window);
      return { ...derive(sane, config, "auto"), model: target.model };
    }
  } catch {
  }
  return {
    windowTokens: 0,
    trimMinTokens: config.trimMinTokens,
    pruneResultThreshold: config.pruneResultThreshold,
    source: "fallback"
  };
}
function derive(windowTokens, config, source) {
  return {
    windowTokens,
    trimMinTokens: clamp(Math.floor(windowTokens * config.trimRatio), 8e3, 2e5),
    pruneResultThreshold: clamp(Math.floor(windowTokens * config.pruneRatio), 2048, 8192),
    source
  };
}
function formatBudget(budget) {
  const window = budget.windowTokens > 0 ? `${budget.windowTokens} tokens` : "未知";
  const model = budget.model === void 0 ? "" : ` model=${budget.model}`;
  const note = budget.note === void 0 ? "" : ` note=${budget.note}`;
  return `[lrc][budget] 窗口=${window}（${budget.source}）${model}${note} trim=${budget.trimMinTokens} tokens prune=${budget.pruneResultThreshold} 字符`;
}

// src/context-profile.ts
var EMPTY = {
  system: 0,
  injected: 0,
  user: 0,
  assistantText: 0,
  reasoning: 0,
  toolArgs: 0,
  toolResult: 0
};
function textChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block;
    if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
  }
  return chars;
}
function reasoningChars(content) {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block;
    if (b?.type === "reasoning" && typeof b.text === "string") chars += b.text.length;
  }
  return chars;
}
function toolArgsChars(content) {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block;
    if (b?.type === "tool-call" && typeof b.arguments === "string") chars += b.arguments.length;
  }
  return chars;
}
function profileSurface(session) {
  const nodes = session?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === void 0) {
    return { nodes: 0, totalChars: 0, checkpoints: 0, byCategory: { ...EMPTY }, shares: { ...EMPTY } };
  }
  const byCategory = { ...EMPTY };
  let checkpoints = 0;
  for (const seq of nodes) {
    const event = events[seq];
    if (event === void 0) continue;
    if (isSummaryNode(event)) checkpoints += 1;
    const category = classifyEvent(event);
    if (category === "system") {
      byCategory.system += textChars(event.data?.content ?? event.data?.message?.content);
    } else if (category === "injected") {
      byCategory.injected += textChars(event.data?.content);
    } else if (category === "user") {
      byCategory.user += textChars(event.data?.content);
    } else if (category === "assistant") {
      const content = event.data?.message?.content;
      byCategory.assistantText += textChars(content);
      byCategory.reasoning += reasoningChars(content);
      byCategory.toolArgs += toolArgsChars(content);
    } else if (category === "tool-result") {
      const content = event.data?.message?.content;
      byCategory.toolResult += textChars(content);
      if (Array.isArray(content)) {
        for (const block of content) {
          const nested = block?.content;
          if (nested !== void 0) byCategory.toolResult += textChars(nested);
        }
      }
    }
  }
  const totalChars = Object.values(byCategory).reduce((sum, value) => sum + value, 0);
  const shares = { ...EMPTY };
  if (totalChars > 0) {
    for (const key of Object.keys(byCategory)) {
      shares[key] = byCategory[key] / totalChars;
    }
  }
  return { nodes: nodes.length, totalChars, checkpoints, byCategory, shares };
}
function formatProfile(profile) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const parts = [
    `toolResult ${pct(profile.shares.toolResult)}`,
    `reasoning ${pct(profile.shares.reasoning)}`,
    `toolArgs ${pct(profile.shares.toolArgs)}`,
    `user ${pct(profile.shares.user)}`,
    `injected ${pct(profile.shares.injected)}`,
    `system ${pct(profile.shares.system)}`,
    `assistantText ${pct(profile.shares.assistantText)}`
  ];
  const warn = profile.checkpoints > 3 ? " ⚠摘要堆叠" : "";
  return `[lrc][profile] 节点=${profile.nodes} 总字符=${profile.totalChars} checkpoint=${profile.checkpoints}${warn} | ${parts.join(" ")}`;
}

// src/governor.ts
var MAX_CONSECUTIVE_FAILURES = 3;
var HALF_OPEN_AFTER_STEPS = 20;
function createGovernorState() {
  return {
    capabilities: null,
    steps: 0,
    failures: {},
    disabled: /* @__PURE__ */ new Set(),
    lastOutcome: {},
    lastRunStep: {},
    runs: {},
    disabledAtStep: {}
  };
}
async function runGovernor(deps) {
  const { state, actions, log, warn } = deps;
  state.steps += 1;
  const executed = [];
  for (const action of actions) {
    if (!action.enabled) continue;
    if (state.disabled.has(action.name)) {
      const since = state.disabledAtStep[action.name] ?? state.steps;
      if (state.steps - since < HALF_OPEN_AFTER_STEPS) continue;
      state.disabled.delete(action.name);
      delete state.disabledAtStep[action.name];
      state.failures[action.name] = 0;
      log(`[lrc][governor] ${action.name} 进入半开，允许试跑一次`);
    }
    const throttle = action.throttleSteps ?? 1;
    const last = state.lastRunStep[action.name];
    if (last !== void 0 && state.steps - last < throttle) continue;
    state.lastRunStep[action.name] = state.steps;
    state.runs[action.name] = (state.runs[action.name] ?? 0) + 1;
    executed.push(action.name);
    let outcome;
    try {
      outcome = await action.run();
    } catch (error) {
      outcome = {
        ok: false,
        reason: `error:${error instanceof Error ? error.message : String(error)}`
      };
    }
    state.lastOutcome[action.name] = outcome;
    if (outcome.ok) {
      state.failures[action.name] = 0;
      continue;
    }
    if (!outcome.reason.startsWith("error")) continue;
    const failures = (state.failures[action.name] ?? 0) + 1;
    state.failures[action.name] = failures;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      state.disabled.add(action.name);
      state.disabledAtStep[action.name] = state.steps;
      warn(
        `[lrc][governor] ${action.name} 连续失败 ${failures} 次，已熔断（${HALF_OPEN_AFTER_STEPS} 步后半开重试）：${outcome.reason}`
      );
    } else {
      warn(
        `[lrc][governor] ${action.name} 失败（${failures}/${MAX_CONSECUTIVE_FAILURES}）：${outcome.reason}`
      );
    }
  }
  if (executed.length > 0) {
    log(`[lrc][governor] 第 ${state.steps} 步执行：${executed.join(" → ")}`);
  }
  return executed;
}
function formatGovernorState(state) {
  const lines = [`步数：${state.steps}`];
  const names = /* @__PURE__ */ new Set([
    ...Object.keys(state.runs),
    ...Object.keys(state.lastOutcome),
    ...state.disabled
  ]);
  if (names.size === 0) {
    lines.push("尚未执行任何动作");
    return lines.join("\n");
  }
  for (const name2 of names) {
    const outcome = state.lastOutcome[name2];
    let disabled = "";
    if (state.disabled.has(name2)) {
      const since = state.disabledAtStep[name2] ?? state.steps;
      const remain = Math.max(0, HALF_OPEN_AFTER_STEPS - (state.steps - since));
      disabled = ` [已熔断，${remain} 步后半开]`;
    }
    const runs = state.runs[name2] ?? 0;
    const failures = state.failures[name2] ?? 0;
    lines.push(
      `- ${name2}${disabled}：执行 ${runs} 次，连续失败 ${failures}${outcome === void 0 ? "" : `，最近 ${outcome.ok ? "成功" : outcome.reason}`}${outcome?.detail === void 0 ? "" : `（${outcome.detail}）`}`
    );
  }
  return lines.join("\n");
}

// src/index.ts
var name = "dsh-plugin-lrc";
var inject = ["tools"];
var Config = Schema.object({
  baseUrl: Schema.string().default(""),
  token: Schema.string().default(""),
  project: Schema.string().default("dsh"),
  offloadTurns: Schema.number().default(8),
  offloadChars: Schema.number().default(6e3),
  // 20 步对工具密集型轮次太晚：实测 16 步的会话一次都没触发，
  // 快照始终为空。降到 8 步，让中途也能沉淀出 `[LRC 状态]`。
  offloadSteps: Schema.number().default(8),
  maxItems: Schema.number().default(40),
  pruneEnabled: Schema.boolean().default(true),
  pruneResultThreshold: Schema.number().default(4096),
  // ★2026-11-07：默认关闭。宿主 surface 校验不允许替换含 tool-call 的
  // assistant 节点（会破坏 tool-pairing 平衡），本路径在当前宿主版本下不可用。
  // 保留配置项，等宿主提供「原地改参数」能力后再启用。
  pruneArgsEnabled: Schema.boolean().default(false),
  pruneArgsThreshold: Schema.number().default(4e3),
  pruneArgsHead: Schema.number().default(2e3),
  pruneReasoningEnabled: Schema.boolean().default(true),
  // 统一保留策略：trim 与 prune-reasoning 共用，避免两套 keep-recent 漂移
  keepRecentNodes: Schema.number().default(8),
  trimEnabled: Schema.boolean().default(true),
  // 阈值按模型窗口比例推导：1M 窗口 → trim 30000 / prune 4000；
  // 128K 窗口 → trim 8000（下限）/ prune 2048（下限）。
  contextWindowTokens: Schema.number().default(0),
  trimRatio: Schema.number().default(0.03),
  pruneRatio: Schema.number().default(4e-3),
  // 窗口探测失败时的绝对值兜底
  trimMinTokens: Schema.number().default(3e4),
  trimMinSteps: Schema.number().default(10),
  // ★2026-11-08：节点数硬上限兜底。token 计量一旦失真（宿主换版本 / meter 返回 0 /
  // 阈值配错），纯 token 触发会让上下文无限增长；节点数不依赖任何服务，用它兜底。
  // 实测正常稳态 31–72 节点，120 只在异常时触发。
  trimMaxNodes: Schema.number().default(120),
  // ★2026-11-07：2000 → 4000。实测 2000 字符的摘要会把关键结论截掉，
  // 用户反馈「关键信息基本都丢了」；4000 仍远小于被裁剪区间（约 9k tokens）。
  trimMaxSummaryChars: Schema.number().default(4e3),
  // ── 连接恢复 ──
  // LRC 可能比 DSH 晚启动（实测桌面端晚 20 分钟）。此前插件只在加载时连一次，
  // 失败即永久降级 —— 召回整场会话都用不了。这两项控制重连退避节奏。
  /** 首次重连等待（毫秒）；0 = 不重试（仅排障用） */
  reconnectBaseMs: Schema.number().default(2e3),
  /** 重连退避上限（毫秒）：封顶保证最终能自愈 */
  reconnectMaxMs: Schema.number().default(6e4),
  // ── 一次性判定的复查 ──
  // 宿主服务可能后起（compaction 在 preset 初始化 / tokenMeter 随模型切换就绪）。
  // 一次性探测会把「启动瞬间没准备好」固化成「整场会话不可用」。
  capabilityRecheckSteps: Schema.number().default(20),
  budgetRecheckSteps: Schema.number().default(20),
  // ── 主动召回注入 ──
  // 实测（2026-11-12，379 步真实会话）：模型从未想起调用 lrc_recall，
  // 系统提示写了也没用。改为由插件主动把相关记忆推进上下文。
  // 默认关闭：先让用户按需开启并观察缓存命中率，确认无副作用再改默认值。
  /** 是否主动注入相关记忆 */
  recallInjectEnabled: Schema.boolean().default(false),
  /** 最多注入几条 */
  recallInjectMaxItems: Schema.number().default(2),
  /** 低于该相关度不注入（0–1） */
  recallInjectMinScore: Schema.number().default(0.5),
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: Schema.number().default(80)
});
var PROMPT_SECTION = "lrc:memory-capture";
function buildPromptText(recallInjected) {
  const recallRule = recallInjected ? [
    "上下文里可能已出现 `[LRC 相关记忆]` 段落，那是插件按当前话题**自动检索**的结果，",
    "直接当事实使用，不需要再调 `lrc_recall` 确认。",
    "只有当该段落缺失、或明显不足以回答（例如需要更早的细节）时，才调 `lrc_recall` 补充检索；",
    "检索为空时回退内置搜索，并在回复中说明「LRC 未命中，已回退内置搜索」。"
  ] : [
    "涉及项目历史、用户偏好、之前做过的决定、上次怎么改的，**先调 `lrc_recall` 工具**，",
    "不要直接 Grep 或翻文件。检索为空时才回退内置搜索，并在回复中说明「LRC 未命中，已回退内置搜索」。"
  ];
  return [
    "## 长期记忆（LRC）",
    "",
    ...recallRule,
    "",
    "发现某条记忆与事实不符时，用 `lrc_forget` 撤回（id 从 `lrc_recall` 输出里取），",
    "不要让它继续污染后续对话。",
    "",
    "## 长期记忆沉淀（必须遵守）",
    "",
    "每次回答的最后一行，必须输出一个 <lrc_memory> 块，格式固定：",
    "",
    "<lrc_memory>",
    "- 决策：…",
    "- 约束：…",
    "- 结论：…",
    "</lrc_memory>",
    "",
    "规则：",
    "- 只写本轮产生的决策、约束、最终结论；没有的条目直接省略。",
    "- 本轮没有任何值得长期保留的内容时，输出 <lrc_memory>无新增</lrc_memory>。",
    "- 只写结论，不写过程、待办清单、选项罗列或代码。",
    "- 标签必须出现在回答的最末尾，且每轮只出现一次。"
  ].join("\n");
}
function apply(ctx, config) {
  const cacheDir = join2(process.env.DSH_HOME ?? join2(homedir2(), ".dsh"), "cache", "lrc-plugin");
  const snapshotPath = join2(cacheDir, "snapshot.json");
  function recheckInterval(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }
  const capabilityRecheckSteps = recheckInterval(config.capabilityRecheckSteps);
  const budgetRecheckSteps = recheckInterval(config.budgetRecheckSteps);
  function loadSnapshot() {
    try {
      if (!existsSync3(snapshotPath)) return "";
      const raw = JSON.parse(readFileSync3(snapshotPath, "utf8"));
      return typeof raw.text === "string" ? raw.text : "";
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 快照文件读取失败，本次从空快照开始（${error instanceof Error ? error.message : String(error)}）：${snapshotPath}`
      );
      return "";
    }
  }
  let warnedSaveSnapshot = false;
  function saveSnapshot(text) {
    try {
      mkdirSync3(cacheDir, { recursive: true });
      writeFileSync3(snapshotPath, JSON.stringify({ text, updatedAt: Date.now() }), "utf8");
    } catch (error) {
      if (!warnedSaveSnapshot) {
        warnedSaveSnapshot = true;
        ctx.logger.warn(
          `[lrc] 快照落盘失败，重启后 [LRC 状态] 会缺失（${error instanceof Error ? error.message : String(error)}）`
        );
      }
    }
  }
  const runtime = new LrcRuntime({
    // 配置里的 baseUrl 必须传下去，否则 patch 里写 3111 也会打到 3099
    baseUrl: config.baseUrl,
    cacheDir,
    log: (message) => ctx.logger.info(message)
  });
  let offloader;
  const connection = new Recoverable(
    async () => {
      const result = await runtime.ensure({ force: true });
      if (result.mode === "degraded") {
        throw new Error(result.reason ?? "LRC 不可用");
      }
      const created = new LrcClient({ baseUrl: result.baseUrl, token: config.token || void 0 });
      attachOffloader(created);
      return created;
    },
    { backoff: { baseMs: config.reconnectBaseMs, maxMs: config.reconnectMaxMs } }
  );
  let warnedShape = false;
  let warnedEmpty = false;
  let warnedNoConclusion = false;
  let flushing = false;
  let probed = false;
  let recallText = "";
  let recallFingerprint = "";
  let recallGeneration = 0;
  let recallRewrites = 0;
  const recallOptions = normalizeRecallOptions({
    maxItems: config.recallInjectMaxItems,
    maxCharsPerItem: config.recallInjectMaxCharsPerItem,
    maxTotalChars: 240,
    minScore: config.recallInjectMinScore
  });
  let turnHits = 0;
  let turnMisses = 0;
  let turnNoText = 0;
  let turnHadText = false;
  let turnTagSeen = false;
  let turnReasoning = [];
  let turnReasoningChars = 0;
  let latestSnapshot = loadSnapshot();
  let snapshotServed = false;
  const governor = createGovernorState();
  let budget = null;
  const trimReasonsLogged = /* @__PURE__ */ new Set();
  let lastAgent;
  const recallInjectOn = config.recallInjectEnabled === true;
  const systemPrompt = ctx.get("systemPrompt");
  if (typeof systemPrompt?.section === "function") {
    try {
      systemPrompt.section({ name: PROMPT_SECTION, order: 9e3, text: buildPromptText(recallInjectOn) });
      systemPrompt.context?.({
        name: "lrc:snapshot",
        // ★2026-11-07（缓存命中率）：order 取 9999，让 LRC 快照排在
        // runtime-context 快照的**最末尾**（宿主内置 context 最高 210）。
        // 宿主把整块 runtime-context 作为一条 user 消息 append 到 surface 尾部，
        // 因此快照位于历史之后、不打断前缀；order 只决定块内顺序。
        order: 9999,
        text: () => {
          const merged = recallText.length === 0 ? latestSnapshot : latestSnapshot.length === 0 ? recallText : `${recallText}

${latestSnapshot}`;
          if (merged.length > 0 && !snapshotServed) {
            snapshotServed = true;
            ctx.logger.info(
              `[lrc] 已注入上下文（${merged.length} 字符${recallText.length > 0 ? `，含召回 ${recallText.length}` : ""}）`
            );
          }
          return merged;
        }
      });
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 系统提示注册失败（不影响沉淀）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    ctx.logger.warn("[lrc] systemPrompt 服务不可用，跳过 <lrc_memory> 提示注入（沉淀仍走硬规则）");
  }
  ctx.effect(() => () => runtime.stop(), "lrc.runtime.stop()");
  const compaction = ctx.get("compaction");
  ctx.logger.info(
    `[lrc] compaction 服务：${compaction === void 0 ? "不可达（preset 隔离）" : typeof compaction.compactRegion === "function" ? "可用（支持 compactRegion）" : "存在但无 compactRegion"}`
  );
  offloader = new Offloader(
    null,
    new CursorStore(join2(cacheDir, "cursor.json")),
    {
      turnsThreshold: config.offloadTurns,
      charsThreshold: config.offloadChars,
      stepsThreshold: config.offloadSteps,
      project: config.project,
      maxItems: config.maxItems
    },
    new RecentStore(join2(cacheDir, "recent.json"))
  );
  function attachOffloader(client) {
    offloader?.bind(client);
  }
  void (async () => {
    const client = await connection.get();
    if (client === null) {
      const status = connection.status();
      ctx.logger.warn(
        `[lrc] 暂未连上 LRC（${status.lastError ?? "未知原因"}）。将在工具调用时按退避重试（下次最早 ${Math.round(status.retryInMs / 1e3)}s 后）。`
      );
      return;
    }
    ctx.logger.info(`[lrc] 记忆沉淀已就绪：${client.baseUrl}`);
    void bootstrapSnapshot();
  })();
  async function bootstrapSnapshot() {
    if (latestSnapshot.length > 0) return;
    const client = connection.peek();
    if (client === null) return;
    try {
      const index = await client.index(config.project, 3);
      if (index.items.length === 0) return;
      const picked = index.items.map((item) => {
        const body = item.content_preview.replace(/^\[[^\]]+\]\s*/, "");
        return body.length > 120 ? `${body.slice(0, 120)}…` : body;
      });
      latestSnapshot = `[LRC 状态] ${picked.join("；")}。细节在 LRC，需要时 recall。`;
      saveSnapshot(latestSnapshot);
      ctx.logger.info(`[lrc] 快照已从 LRC 索引重建（${index.items.length} 条）`);
    } catch {
    }
  }
  async function acquireClient() {
    const client = await connection.get();
    if (client !== null) return { client };
    const status = connection.status();
    const wait = Math.ceil(status.retryInMs / 1e3);
    return {
      reason: `LRC 暂时不可用：${status.lastError ?? "未知原因"}` + (wait > 0 ? `（约 ${wait}s 后自动重试）` : "")
    };
  }
  function noteToolFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isConnectionError(error)) {
      connection.invalidate(message);
      offloader?.bind(null);
      ctx.logger.warn(`[lrc][tool] 连接失效，已标记重连：${message}`);
    }
    return message;
  }
  async function refreshRecallInjection(rawQuery) {
    if (!recallInjectOn || recallOptions.maxItems <= 0) return;
    const query = textBlocksOnly(rawQuery).trim();
    if (query.length === 0) return;
    const fingerprint = topicFingerprint(query, recallFingerprint);
    if (fingerprint.length === 0) return;
    if (fingerprint === recallFingerprint) return;
    const generation = recallGeneration + 1;
    recallGeneration = generation;
    const acquired = await acquireClient();
    if ("reason" in acquired) {
      return;
    }
    try {
      const result = await acquired.client.recall(query.slice(0, 200), {
        topK: Math.max(recallOptions.maxItems * 3, 3)
      });
      if (generation !== recallGeneration) return;
      const next = formatRecallInjection(result.memories, recallOptions);
      recallFingerprint = fingerprint;
      if (next === recallText) return;
      recallText = next;
      recallRewrites += 1;
      ctx.logger.info(
        next.length === 0 ? `[lrc] 本轮无相关记忆，不注入（指纹 ${fingerprint}）` : `[lrc] 注入 ${result.memories.length} 条候选中的 ${recallOptions.maxItems} 条（${next.length} 字符，指纹 ${fingerprint}，累计改写 ${recallRewrites} 次）`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        connection.invalidate(message);
        offloader.bind(null);
      }
      ctx.logger.warn(`[lrc] 召回注入失败（保留上次内容）：${message}`);
    }
  }
  async function flush(session, reason) {
    if (flushing) return;
    if (!offloader.hasPending()) return;
    if (!offloader.connected) {
      void connection.get();
      return;
    }
    flushing = true;
    try {
      const sessionId = session?.id ?? "default";
      const lines = linesFromSession(session);
      if (lines.length === 0) {
        if (!warnedEmpty) {
          warnedEmpty = true;
          ctx.logger.warn("[lrc] 会话日志里没有可沉淀的文本行，本次跳过");
        }
        const conclusions = conclusionsFromReasoning(turnReasoning.join("\n"));
        if (conclusions.length === 0 && turnReasoning.length > 0 && !warnedNoConclusion) {
          warnedNoConclusion = true;
          ctx.logger.info(
            `[lrc] 推理兜底：本轮推理 ${turnReasoningChars} 字符，未抽到结论句（词表未命中）`
          );
        }
        if (conclusions.length > 0) {
          try {
            const result2 = await offloader.offloadItems(itemsFromTag(conclusions.join("\n")));
            if (result2.distilled > 0) {
              if (result2.snapshot.length > 0 && snapshotChanged(latestSnapshot, result2.snapshot)) {
                latestSnapshot = result2.snapshot;
                saveSnapshot(result2.snapshot);
              }
              ctx.logger.info(
                `[lrc] 推理兜底沉淀 ${result2.distilled} 条（写入 ${result2.written}，合并 ${result2.merged}${result2.deduped > 0 ? `；本地去重 ${result2.deduped}` : ""}，触发：${reason}）`
              );
            }
          } catch (error) {
            ctx.logger.warn(
              `[lrc] 推理兜底沉淀失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`
            );
          }
          turnReasoning = [];
          turnReasoningChars = 0;
        }
        offloader.resetCounters();
        return;
      }
      const result = await offloader.offload(sessionId, lines);
      if (result !== null) {
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          latestSnapshot = result.snapshot;
          saveSnapshot(result.snapshot);
        }
        ctx.logger.info(
          `[lrc] 已沉淀 ${result.distilled} 条（写入 ${result.written}，其中合并 ${result.merged}${result.deduped > 0 ? `；本地去重 ${result.deduped}` : ""}，触发：${reason}）`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        connection.invalidate(message);
        offloader?.bind(null);
        ctx.logger.warn(`[lrc] 沉淀失败，连接已标记失效（下次调用重连）：${message}`);
      } else {
        ctx.logger.warn(`[lrc] 沉淀失败（不影响对话）：${message}`);
      }
    } finally {
      flushing = false;
    }
  }
  function resetTurnState() {
    turnHadText = false;
    turnTagSeen = false;
    turnReasoning = [];
    turnReasoningChars = 0;
  }
  const REASONING_CAP = 2e4;
  async function finishTurn(session) {
    if (turnHadText) {
      if (turnTagSeen) turnHits += 1;
      else turnMisses += 1;
      const seen = turnHits + turnMisses;
      if (seen % 20 === 0) {
        ctx.logger.info(
          `[lrc] <lrc_memory> 命中率 ${turnHits}/${seen} 轮（另有 ${turnNoText} 轮无正文）`
        );
      }
    } else {
      turnNoText += 1;
    }
    const hadText = turnHadText;
    const reasoning = turnReasoning.join("\n");
    resetTurnState();
    await flush(session, "turn/end");
    if (hadText || reasoning.length === 0) return;
    const conclusions = conclusionsFromReasoning(reasoning);
    if (conclusions.length === 0) return;
    try {
      const result = await offloader.offloadItems(itemsFromTag(conclusions.join("\n")));
      if (result.distilled > 0) {
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          latestSnapshot = result.snapshot;
          saveSnapshot(result.snapshot);
        }
        ctx.logger.info(
          `[lrc] 推理兜底沉淀 ${result.distilled} 条（写入 ${result.written}，合并 ${result.merged}${result.deduped > 0 ? `；本地去重 ${result.deduped}` : ""}）`
        );
      }
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 推理兜底沉淀失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "turn/start") {
      resetTurnState();
      return;
    }
    if (type === "turn/end") {
      void finishTurn(session);
      return;
    }
    if (type === "user/message" && isRealUserMessage(event)) {
      void refreshRecallInjection(userMessageText(event));
      return;
    }
    if (type !== "assistant/message") return;
    const content = messageContent(event);
    const text = textBlocksOnly(content);
    const reasoning = reasoningBlocksOnly(content);
    if (text.length > 0) {
      turnHadText = true;
      if (extractMemoryTag(text) !== null) turnTagSeen = true;
      offloader.observe(text);
    } else if (!warnedShape && hasMalformedTextBlock(content)) {
      warnedShape = true;
      const data = event?.data;
      const keys = data !== null && typeof data === "object" ? Object.keys(data).join(",") : typeof data;
      ctx.logger.warn(`[lrc] assistant/message 文本块结构异常（data 字段：${keys}）`);
    }
    if (reasoning.length > 0 && turnReasoningChars < REASONING_CAP) {
      turnReasoning.push(reasoning);
      turnReasoningChars += reasoning.length;
    }
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    const agent = payload?.agent;
    lastAgent = agent;
    if (!probed) {
      probed = true;
      try {
        governor.capabilities = probeCapabilities(ctx, agent);
        for (const line of formatCapabilities(governor.capabilities)) ctx.logger.info(line);
      } catch (error) {
        ctx.logger.warn(
          `[lrc][cap] 能力探测异常：${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (capabilityRecheckSteps > 0 && governor.steps > 0 && governor.steps % capabilityRecheckSteps === 0) {
      const before = governor.capabilities;
      const needsRecheck = before === null || !before.compaction.available || !before.tokenMeter.available || !before.toolResultPruner.available;
      if (needsRecheck) {
        try {
          const after = probeCapabilities(ctx, agent);
          governor.capabilities = after;
          const recovered = [];
          if (before !== null && !before.compaction.available && after.compaction.available) {
            recovered.push("compaction");
          }
          if (before !== null && !before.tokenMeter.available && after.tokenMeter.available) {
            recovered.push("tokenMeter");
          }
          if (before !== null && !before.toolResultPruner.available && after.toolResultPruner.available) {
            recovered.push("toolResultPruner");
          }
          if (recovered.length > 0) {
            ctx.logger.info(`[lrc][cap] 复查后恢复可用：${recovered.join("、")}`);
          }
        } catch {
        }
      }
    }
    const caps = governor.capabilities;
    if (budget === null || budget.source === "fallback" && budgetRecheckSteps > 0 && governor.steps % budgetRecheckSteps === 0) {
      try {
        const resolved = await resolveBudget({
          ctx,
          agent,
          config: {
            contextWindowTokens: config.contextWindowTokens,
            trimRatio: config.trimRatio,
            pruneRatio: config.pruneRatio,
            trimMinTokens: config.trimMinTokens,
            pruneResultThreshold: config.pruneResultThreshold
          }
        });
        if (budget === null || resolved.source !== budget.source || resolved.windowTokens !== budget.windowTokens) {
          ctx.logger.info(formatBudget(resolved));
        }
        budget = resolved;
      } catch (error) {
        ctx.logger.warn(
          `[lrc][budget] 预算解析失败，使用配置绝对值：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const trimMinTokens = budget?.trimMinTokens ?? config.trimMinTokens;
    const pruneResultThreshold = budget?.pruneResultThreshold ?? config.pruneResultThreshold;
    const actions = [
      {
        name: "prune-results",
        enabled: config.pruneEnabled && (caps === null || caps.toolResultPruner.available),
        run: () => {
          const outcome = pruneToolResults({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            thresholdChars: pruneResultThreshold
          });
          return { ok: outcome.ok, reason: outcome.reason };
        }
      },
      {
        name: "prune-args",
        enabled: config.pruneArgsEnabled,
        run: () => {
          const outcome = pruneToolCallArguments({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            options: {
              thresholdChars: config.pruneArgsThreshold,
              headChars: config.pruneArgsHead,
              keepRecentNodes: config.keepRecentNodes
            }
          });
          return { ok: outcome.ok, reason: outcome.reason };
        }
      },
      {
        name: "prune-reasoning",
        enabled: config.pruneReasoningEnabled,
        run: () => {
          const outcome = pruneReasoning({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            options: { keepRecentNodes: config.keepRecentNodes }
          });
          return { ok: outcome.ok, reason: outcome.reason };
        }
      },
      {
        name: "trim",
        enabled: config.trimEnabled && (caps === null || caps.compaction.available && caps.tokenMeter.available),
        throttleSteps: config.trimMinSteps,
        run: async () => {
          const surfaceNodes = agent?.session?.surface?.nodes;
          const nodeCount = Array.isArray(surfaceNodes) ? surfaceNodes.length : 0;
          const force = nodeCount > config.trimMaxNodes;
          if (force) {
            ctx.logger.info(
              `[lrc][trim] 节点数 ${nodeCount} 超过上限 ${config.trimMaxNodes}，跳过 token 阈值强制裁剪`
            );
          }
          const outcome = await trimContext({
            ctx,
            agent,
            signal: payload?.signal,
            options: {
              minTokens: trimMinTokens,
              keepRecentNodes: config.keepRecentNodes,
              maxSummaryChars: config.trimMaxSummaryChars,
              force
            },
            log: (message) => ctx.logger.info(message)
          });
          if (!outcome.ok && !outcome.reason.startsWith("error")) {
            if (!trimReasonsLogged.has(outcome.reason)) {
              trimReasonsLogged.add(outcome.reason);
              ctx.logger.info(
                `[lrc][trim] 未裁剪：${outcome.reason}${outcome.detail === void 0 ? "" : `（${outcome.detail}）`}`
              );
            }
          }
          return {
            ok: outcome.ok,
            reason: outcome.reason,
            detail: outcome.summaryStats ?? outcome.detail
          };
        }
      }
    ];
    await runGovernor({
      state: governor,
      actions,
      log: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message)
    });
    if (governor.steps % 10 === 0) {
      try {
        ctx.logger.info(formatProfile(profileSurface(agent?.session)));
      } catch {
      }
    }
    offloader.observeStep();
    if (offloader.shouldOffload()) {
      const session = payload?.agent?.session;
      void flush(session, "threshold");
    }
    const decision = await next();
    if (decision !== null && typeof decision === "object") {
      const d = decision;
      if (d.kind === "enter" && Array.isArray(d.messages)) {
        const messages = d.messages;
        const ctxIdx = messages.findIndex((m) => m?.source?.kind === "runtime-context");
        if (ctxIdx > 0) {
          const [ctx2] = messages.splice(ctxIdx, 1);
          messages.unshift(ctx2);
        }
      }
    }
    return decision;
  });
  function registerTool(name2, factory) {
    try {
      ctx.tools.register(factory());
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 工具 ${name2} 注册失败（不影响沉淀与剪枝）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  registerTool(
    "lrc_remember_now",
    () => defineTool({
      name: "lrc_remember_now",
      description: '立即把当前对话的结论沉淀到 LRC 长期记忆库。用于用户要求"把这段记下来"或上下文即将变长时。返回一行状态快照。',
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "要沉淀的对话原文（可含多轮，按换行分隔）"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            snapshot: { type: "string", required: true },
            distilled: { type: "number", required: true },
            written: { type: "number", required: true },
            merged: { type: "number", required: true }
          }
        },
        render: (_args, value) => [
          { type: "text", text: value.snapshot }
        ]
      },
      async execute(args) {
        const acquired = await acquireClient();
        if ("reason" in acquired) {
          return { snapshot: acquired.reason, distilled: 0, written: 0, merged: 0 };
        }
        const { client } = acquired;
        try {
          const tag = extractMemoryTag(args.text);
          if (tag !== null) {
            if (isNoUpdate(tag)) {
              return { snapshot: "本轮无新增，未沉淀", distilled: 0, written: 0, merged: 0 };
            }
            const items = itemsFromTag(tag);
            const migrated = await client.migrate(items, config.project);
            ctx.logger.info(
              `[lrc][tool] lrc_remember_now 沉淀 ${items.length} 条（写入 ${migrated.written}，合并 ${migrated.merged}）`
            );
            return {
              snapshot: `已沉淀 ${items.length} 条（写入 ${migrated.written}，其中合并 ${migrated.merged}）`,
              distilled: items.length,
              written: migrated.written,
              merged: migrated.merged
            };
          }
          const result = await client.migrateText(args.text, config.project, config.maxItems);
          ctx.logger.info(
            `[lrc][tool] lrc_remember_now 沉淀 ${result.distilled} 条（写入 ${result.written}，合并 ${result.merged}）`
          );
          return {
            snapshot: result.indexLine,
            distilled: result.distilled,
            written: result.written,
            merged: result.merged
          };
        } catch (error) {
          return {
            snapshot: `本次未沉淀：${noteToolFailure(error).slice(0, 160)}`,
            distilled: 0,
            written: 0,
            merged: 0
          };
        }
      }
    })
  );
  const describeRecall = (returned, total) => `召回 ${returned} 条（三路候选 ${total} 条，融合前；已折叠近重复）`;
  registerTool(
    "lrc_recall",
    () => defineTool({
      name: "lrc_recall",
      description: "从 LRC 长期记忆库检索相关记忆。涉及项目历史、用户偏好、之前做过的决定、上次怎么改的，先调这个工具，不要直接 Grep 或翻文件。返回按相关度排序的记忆条目（已做近重复折叠）。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "自然语言查询，如「上次那个检索接口怎么改的」"
        },
        top_k: {
          type: "number",
          description: "返回条数，默认 5，最大 20"
        },
        project: {
          type: "string",
          description: "按项目过滤（可选，缺省搜全部项目）"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            count: { type: "number", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      async execute(args) {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query.length === 0) {
          return { text: "lrc_recall 需要非空的 query。", count: 0 };
        }
        const acquired = await acquireClient();
        if ("reason" in acquired) {
          return { text: `${acquired.reason}。可先用内置搜索。`, count: 0 };
        }
        const { client } = acquired;
        try {
          const topK = Math.min(Math.max(args.top_k ?? 5, 1), 20);
          const result = await client.recall(query, {
            topK,
            // 缺省不按项目过滤：插件沉淀写 config.project，手工 remember 可能写别的项目，
            // 过滤会漏掉一半。需要收窄时由调用方显式传 project。
            project: args.project
          });
          ctx.logger.info(
            `[lrc][tool] lrc_recall "${query}" → ${describeRecall(result.memories.length, result.total)}`
          );
          if (result.memories.length === 0) {
            return { text: "LRC 未命中，可回退内置搜索。", count: 0 };
          }
          const lines = result.memories.map((m, i) => {
            const rel = Math.round((m.score_norm ?? 0) * 100);
            const kind = m.memory_type ?? "fact";
            return `（记忆 #${i + 1} · 相关度 ${rel}% · ${kind} · id=${m.id}）
${m.content}`;
          });
          return {
            text: `LRC ${describeRecall(result.memories.length, result.total)}：

` + lines.join("\n\n"),
            count: result.memories.length
          };
        } catch (error) {
          return { text: `LRC 召回失败：${noteToolFailure(error).slice(0, 200)}`, count: 0 };
        }
      }
    })
  );
  registerTool(
    "lrc_forget",
    () => defineTool({
      name: "lrc_forget",
      description: "删除一条错误的 LRC 记忆。当 lrc_recall 返回的某条记忆与事实不符（例如把「没找到」误写成「不存在」、把旧结论当成现状），用这个工具撤回。memory_id 从 lrc_recall 的输出里取。",
      parameters: {
        memory_id: {
          type: "string",
          required: true,
          description: "要删除的记忆 ID（lrc_recall 输出里的 id=...）"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            deleted: { type: "boolean", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      async execute(args) {
        const memoryId = typeof args.memory_id === "string" ? args.memory_id.trim() : "";
        if (memoryId.length === 0) {
          return { text: "lrc_forget 需要非空的 memory_id。", deleted: false };
        }
        const acquired = await acquireClient();
        if ("reason" in acquired) {
          return { text: acquired.reason, deleted: false };
        }
        const { client } = acquired;
        try {
          const result = await client.forget(memoryId);
          ctx.logger.info(
            `[lrc][tool] lrc_forget ${memoryId} → ${result.deleted ? "已删除" : result.alreadyDeleted ? "幂等不存在" : "未删除"}`
          );
          if (result.deleted) {
            return { text: `已删除记忆 ${memoryId}。`, deleted: true };
          }
          if (result.alreadyDeleted) {
            return { text: `记忆 ${memoryId} 已不存在（幂等）。`, deleted: true };
          }
          return { text: `记忆 ${memoryId} 未删除（服务端返回 deleted=false）。`, deleted: false };
        } catch (error) {
          return { text: `LRC 删除失败：${noteToolFailure(error).slice(0, 200)}`, deleted: false };
        }
      }
    })
  );
  registerTool(
    "lrc_handoff",
    () => defineTool({
      name: "lrc_handoff",
      description: "把当前会话整理成交接摘要，并新建一个会话注入该摘要（原会话保留）。用于上下文接近上限、需要另起炉灶继续同一任务时。",
      parameters: {
        // **不要写 `required: false`**：DSH 的 defineTool 规定参数上的
        // `required` 只要出现就必须是 `true`，省略该键才表示可选。
        // 写成 false 会抛 JsonSchemaError，把整个 apply() 掀翻（实测回归）。
        note: {
          type: "string",
          description: "给接手方的下一步说明（可选）"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            sessionId: { type: "string", required: true },
            mode: { type: "string", required: true },
            text: { type: "string", required: true }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: (value.ok ? `已创建交接会话（${value.mode}）：${value.sessionId}` : "未能创建新会话，仅返回交接摘要") + `

${value.text}`
          }
        ]
      },
      async execute(args) {
        const session = lastAgent?.session;
        const source = extractHandoffSource(session);
        let indexLines = [];
        const client = connection.peek();
        if (client !== null) {
          try {
            const index = await client.index(config.project, 10);
            indexLines = index.items.map((item) => item.content_preview);
          } catch {
          }
        }
        const text = buildHandoffText({
          lastUserRequest: source.lastUserRequest,
          recentAssistant: source.recentAssistant,
          snapshot: latestSnapshot,
          indexLines,
          note: args.note ?? ""
        });
        const result = await createHandoffSession({
          ctx,
          agent: lastAgent,
          text,
          log: (message) => ctx.logger.info(message)
        });
        ctx.logger.info(
          `[lrc][tool] lrc_handoff → ${result.ok ? "已创建交接会话" : "仅返回摘要"}（${result.mode}）`
        );
        return {
          ok: result.ok,
          sessionId: result.sessionId ?? "",
          mode: result.mode,
          text: result.text
        };
      }
    })
  );
  registerTool(
    "lrc_status",
    () => defineTool({
      name: "lrc_status",
      description: '查看 LRC 插件的运行状态：能力矩阵（哪些路径可用）、各动作执行次数与熔断状态、当前配置阈值、快照是否存在。排查"为什么没生效"时先调这个。',
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      async execute() {
        ctx.logger.info("[lrc][tool] lrc_status 调用");
        const lines = ["# LRC 状态", ""];
        lines.push("## 能力矩阵");
        if (governor.capabilities === null) {
          lines.push("尚未探测（还没有走过一步）");
        } else {
          lines.push(...formatCapabilities(governor.capabilities));
        }
        lines.push("");
        lines.push("## 动作状态");
        lines.push(formatGovernorState(governor));
        lines.push("");
        lines.push("## 连接");
        {
          const conn = connection.status();
          const rt = runtime.status();
          const stateText = conn.state === "ready" ? "已连接" : conn.state === "failed" ? `未连接（${conn.lastError ?? "未知原因"}）` : "尚未尝试";
          lines.push(
            `- LRC 连接：${stateText}` + (conn.state === "ready" ? "" : `｜重试倒计时 ${Math.ceil(conn.retryInMs / 1e3)}s（退避 ${Math.round(conn.lastBackoffMs / 1e3)}s）`)
          );
          lines.push(
            `- 累计：成功 ${conn.successes} 次 / 失败 ${conn.failures} 次（连续 ${conn.consecutiveFailures}）`
          );
          lines.push(
            `- 运行时：${rt.mode}｜连续降级 ${rt.degradeCount} 次｜下次重探 ${Math.ceil(rt.retryInMs / 1e3)}s`
          );
          if (conn.lastError !== void 0 && conn.state !== "ready") {
            lines.push(`- 最近错误：${conn.lastError}`);
          }
        }
        lines.push("");
        lines.push("## 上下文画像");
        try {
          lines.push(formatProfile(profileSurface(lastAgent?.session)));
        } catch {
          lines.push("不可用");
        }
        lines.push("");
        lines.push("## 沉淀");
        {
          const stats = offloader.stats();
          if (!offloader.connected) {
            lines.push("连接未就绪：本轮新增内容已计入待沉淀队列，连上后会自动补写。");
          }
          lines.push(
            `累计 ${stats.flushCount} 次：新写入 ${stats.totalWritten} 条 / 合并 ${stats.totalMerged} 条 / 本地查重拦下 ${stats.totalDeduped} 块`
          );
          lines.push(
            stats.lastFlushAt === 0 ? "最近一次：尚未沉淀" : `最近一次：${new Date(stats.lastFlushAt).toISOString()}（写入 ${stats.lastFlushWritten} / 合并 ${stats.lastFlushMerged}）`
          );
          lines.push(`查重窗口：${stats.recentWindow} 块`);
        }
        lines.push("");
        lines.push("## 预算");
        lines.push(budget === null ? "尚未解析" : formatBudget(budget));
        lines.push("");
        lines.push("## 配置");
        lines.push(
          [
            `prune=${config.pruneEnabled}（阈值 ${budget?.pruneResultThreshold ?? config.pruneResultThreshold} 字符）`,
            `pruneArgs=${config.pruneArgsEnabled}（阈值 ${config.pruneArgsThreshold} 字符）`,
            `pruneReasoning=${config.pruneReasoningEnabled}（保留最近 ${config.keepRecentNodes} 节点）`,
            `trim=${config.trimEnabled}（阈值 ${budget?.trimMinTokens ?? config.trimMinTokens} tokens，每 ${config.trimMinSteps} 步，节点上限 ${config.trimMaxNodes}）`,
            `offload=${config.offloadTurns} 轮 / ${config.offloadChars} 字符 / ${config.offloadSteps} 步`
          ].join("\n")
        );
        lines.push("");
        lines.push("## 快照");
        lines.push(
          latestSnapshot.length > 0 ? `已存在（${latestSnapshot.length} 字符）${snapshotServed ? "，已被渲染层取走" : "，尚未被取走"}` : "为空（还没有成功沉淀过）"
        );
        lines.push("");
        lines.push("## 主动召回注入");
        if (!recallInjectOn) {
          lines.push("已关闭（recallInjectEnabled=false）");
        } else {
          lines.push(
            recallText.length > 0 ? `已注入 ${recallText.length} 字符｜指纹 ${recallFingerprint}` : `本轮无匹配，未注入｜指纹 ${recallFingerprint || "(空)"}`
          );
          lines.push(
            `配置：最多 ${recallOptions.maxItems} 条｜阈值 ${recallOptions.minScore}｜单条 ${recallOptions.maxCharsPerItem} 字符｜总长 ${recallOptions.maxTotalChars}`
          );
          lines.push(`累计改写 ${recallRewrites} 次（每次改写会打断一次前缀缓存）`);
          if (recallText.length > 0) {
            lines.push("内容：");
            for (const line of recallText.split("\n")) lines.push(`  ${line}`);
          }
        }
        return { text: lines.join("\n") };
      }
    })
  );
}
export {
  Config,
  apply,
  inject,
  name
};
