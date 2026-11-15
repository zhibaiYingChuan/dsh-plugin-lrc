// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { dirname as dirname3, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "node:fs";

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
var INJECTION_HEADER = "[LRC 历史记忆（可能过时，与当前任务无关时请忽略）]";
var DEFAULT_RECALL_INJECTION = {
  // 2 条足够覆盖"用户偏好 + 关键决定"这类最常见场景，再多就是噪音
  maxItems: 2,
  maxCharsPerItem: 80,
  // 与快照 220 字符同量级，避免单次注入就把上下文撑大
  maxTotalChars: 240,
  // 相对分只用于筛掉同批里的掉队项（top1 恒为 1.0，单靠它等于永远放行）
  minScore: 0.85,
  // RRF 分：单路 ≈0.0164 / 双路 ≈0.0301。0.025 等价于「要求至少两路命中」。
  // 注意它是名次信号而非相关度，见字段注释里的实测数据。
  minRawScore: 0.025
};
function isRelevant(memory, options) {
  const norm = typeof memory.score_norm === "number" && Number.isFinite(memory.score_norm) ? memory.score_norm : 1;
  if (norm < options.minScore) return false;
  const raw = absoluteScore(memory);
  if (raw === null) return true;
  return raw >= options.minRawScore;
}
function absoluteScore(memory) {
  const raw = memory.score;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
}
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
    // 相对分必须落在 [0,1]，否则过滤条件会恒真或恒假
    minScore: Math.min(1, Math.max(0, num(raw.minScore, DEFAULT_RECALL_INJECTION.minScore))),
    // 绝对分是 RRF 分（值域 (0, 2/61]），**不能**夹到 [0,1]：
    // 夹上限到 1 会让所有候选都被判为不相关 ⇒ 永不注入。
    // 夹下限到 0 则是「显式关闭绝对闸门」，这是合法配置，不做拦截。
    minRawScore: Math.max(0, num(raw.minRawScore, DEFAULT_RECALL_INJECTION.minRawScore))
  };
}
function formatRecallInjection(memories, options = DEFAULT_RECALL_INJECTION) {
  if (options.maxItems <= 0) return "";
  const picked = memories.filter((m) => typeof m.content === "string" && m.content.trim().length > 0).filter((m) => isRelevant(m, options)).sort((a, b) => sortScoreOf(b) - sortScoreOf(a)).slice(0, options.maxItems);
  if (picked.length === 0) return "";
  const render = (list) => {
    const lines = list.map((m) => {
      const body = m.content.trim().replace(/\s+/g, " ");
      const cut = body.length > options.maxCharsPerItem ? `${body.slice(0, options.maxCharsPerItem)}…` : body;
      return `- ${cut}`;
    });
    return `${INJECTION_HEADER}
${lines.join("\n")}`;
  };
  let text = render(picked);
  while (text.length > options.maxTotalChars && picked.length > 1) {
    picked.pop();
    text = render(picked);
  }
  if (text.length > options.maxTotalChars) {
    text = `${text.slice(0, options.maxTotalChars - 1)}…`;
  }
  return text;
}
function sortScoreOf(memory) {
  const raw = absoluteScore(memory);
  if (raw !== null) return raw;
  const norm = memory.score_norm;
  return typeof norm === "number" && Number.isFinite(norm) ? norm : 0;
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
  if (/^\|.*\|/.test(t)) return true;
  return false;
}
function looksLikeMachineOutput(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[{\[]/.test(t)) {
    if (t.includes('"')) return true;
    if (/^\[[\w\s,.-]*\]$/.test(t)) return true;
  }
  if (/"[^"]{1,40}"\s*:/.test(t)) return true;
  const kv = /^[A-Za-z_$][\w$.-]*\s*[:=]\s*([\s\S]*)$/.exec(t);
  if (kv !== null) {
    const value = (kv[1] ?? "").trim();
    const maskedValue = maskPaths(value);
    const cjk = (maskedValue.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    if (cjk >= 3 && /[，。；！？]/.test(maskedValue)) return false;
    if (/(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律|不要|别用|别再|改用|换成|改成|定为|决定)/.test(
      maskedValue
    )) {
      return false;
    }
    if (/(?:上限|下限|不超过|不低于|不少于|不大于|不小于|压到|降到|控制在|限制在)\s*[0-9]/.test(maskedValue)) {
      return false;
    }
    if (cjk < 6) return true;
  }
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
function jaccard(a, b) {
  const setA = new Set(a.replace(/\s+/g, ""));
  const setB = new Set(b.replace(/\s+/g, ""));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
function valueTokens(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.\-/\\]*|\d+/g)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}
var ANTONYM_PAIRS = [
  ["之外", "之内"],
  ["以外", "以内"],
  ["中文", "英文"],
  ["启用", "禁用"],
  ["保留", "删除"],
  ["删除", "保留"],
  ["开头", "结尾"],
  ["前面", "后面"],
  ["之前", "之后"],
  ["同步", "异步"],
  ["包含", "排除"]
];
function antonymConflict(a, b) {
  for (const [x, y] of ANTONYM_PAIRS) {
    if (a.includes(x) && b.includes(y) || a.includes(y) && b.includes(x)) return [x, y];
  }
  return null;
}
function areNearDuplicate(a, b, threshold) {
  const va = valueTokens(a);
  const vb = valueTokens(b);
  if (va.length > 0 && vb.length > 0) {
    const sa = new Set(va);
    const sb = new Set(vb);
    const same = va.every((x) => sb.has(x)) && vb.every((x) => sa.has(x));
    if (!same) return false;
  }
  if (antonymConflict(a, b) !== null) return false;
  return jaccard(a, b) >= threshold;
}
var DEFAULT_DEDUP_THRESHOLD = 0.85;
function isDuplicate(text, recent, threshold = DEFAULT_DEDUP_THRESHOLD) {
  const t = text.trim();
  if (t.length === 0) return true;
  return recent.some((r) => areNearDuplicate(r, t, threshold));
}

// src/memory-schema.ts
var KIND_LABEL = {
  constraint: "约束",
  decision: "决策",
  conclusion: "结论",
  goal: "约束",
  location: "事实",
  artifact: "工件",
  statement: "事实",
  fact: "事实"
};
var MIN_VALUE_CHARS = 2;
var MIN_STATEMENT = 6;
var MAX_STATEMENT = 300;
var MAX_JUDGED_STATEMENT = 500;
var MIN_CONFIDENCE = 0.6;
var PREDICATES = {
  constraint: [
    "只允许",
    "不允许",
    "统一为",
    "一定要",
    "只支持",
    "仅支持",
    "只兼容",
    "仅兼容",
    "不需要",
    "不用",
    "无需",
    "不要",
    "不能",
    "不得",
    "必须",
    "务必",
    "禁止",
    "严禁",
    "切勿",
    "杜绝",
    "只能",
    "一律",
    "别再",
    "别用",
    "别碰",
    "别动",
    "别改",
    "别删",
    "别写",
    "别加",
    "别存",
    "别把",
    "别连",
    "别忘",
    "请用",
    "请勿",
    "记得"
  ],
  decision: [
    "方案是",
    "最终选",
    "选定",
    "选用",
    "改用",
    "换成",
    "改成",
    "改到",
    "换到",
    "换为",
    "切成",
    "设为",
    "设成",
    "调成",
    "调为",
    "定为",
    "采用",
    "选型",
    "就用",
    "决定",
    // 单字「选」：`数据库选 PostgreSQL` 是最常见的选型表达。
    // 它靠 `deriveClaim` 里的单字谓词约束（取值须为 ASCII 专名）把
    // `我选择看一下` 这类误收挡掉。
    "选"
  ],
  conclusion: [
    "根本原因是",
    "原因在于",
    "问题在于",
    "问题出在",
    "最终确认",
    "结论是",
    "结论为",
    "结论：",
    "结论:",
    "定位到",
    "查明",
    "根因是"
  ],
  goal: [
    "不超过",
    "不低于",
    "不少于",
    "不大于",
    "不小于",
    "目标是",
    "压到",
    "降到",
    "控制到",
    "限制到"
  ],
  /**
   * **陈述性谓词**：回答「这是什么 / 包含什么 / 怎么用」。
   *
   * ## 为什么必须有这一类（★2026-11-14 真实测试暴露）
   *
   * 此前词表里只有**规范性**谓词（必须/不要/改用/根因是）。于是用户问
   * 「这个仓库是什么」，模型的答案整类进不了记忆库 —— 实测 4/4 全漏：
   * ```
   * MISS awesome-code-animation 是一个收录代码动画项目的聚合仓库。
   * MISS 这个仓库收录了 443 个代码动画项目。
   * MISS 使用方法是把仓库里的 demo 目录直接用浏览器打开。
   * MISS 这个仓库不需要安装，克隆下来直接看 examples 目录。
   * ```
   * 后果：压缩完上下文后，接手方只知道「不要改 README」「商用前必须核对」，
   * 却不知道**这个仓库到底是什么** —— 而后者才是用户问题的答案。
   *
   * ## 为什么必须带严格约束
   *
   * 「是」是中文最高频的系词，裸用会把整类垃圾收进来：
   * ```
   * 是的，我明白了。            ← 应答
   * 这个是刚才那个文件。        ← 指代
   * 问题是我还不知道能不能跑。    ← 疑问
   * ```
   * 约束见 `deriveFromClause` 里的 `STATEMENT_*` 判据组：
   * 主语含具体名词、取值 ≥4 字、排除疑问/否定/应答/指代。
   */
  statement: [
    "的用法是",
    "的定位是",
    "的作用是",
    "的本质是",
    "基于",
    "收录了",
    "包含了",
    "提供了",
    "属于",
    "是一个",
    "是一套",
    "是一款",
    "是一种",
    "支持",
    "是"
  ]
};
var OBSERVATIONAL_GOAL_VERB = /^(?:降|减)到$/;
var GOAL_QUANTITY = /[0-9]|以内|以下|之内|不超过|不低于|不少于|不大于|不小于|上限|下限/;
var GOAL_BOUND_SUFFIX = /(?:以内|以下|之内|不超过|不低于|不少于|不大于|不小于)/;
var EMPTY_POINTER = /^(?:如下|见下|见上|原因如下|理由如下|具体如下|以下|略|待定|待补|同上|详见|稍后|具体见|后述|前述)[：:，,。\s]*$/;
var MAX_VALUE_CHARS = 30;
var LEADING_CONJUNCTION = /^(?:而|且|并|但|却|也|还|就|才|则|另外|此外|再者|反之|不过|然而|那)/;
var LEADING_CAUSAL = /^(?:所以|因此|于是|由此|故而|从而|进而|因而)/;
var TIME_ADVERB_ONLY = /^(?:现在|接下来|然后|之后|随后|接着|下面|下一步|刚才|刚刚|目前|当前|此时|眼下|如今|当时|此前|这时|那时|随即)$/;
var CLAUSE_TEMPORAL = /[，,。；;！!]\s*(?:接下来|然后|接着|下一步|随后|之后)\s*(?:改|换|做|写|跑|试|看|查|读|补|删|加|去掉|重跑|调整|修|执行)/;
var CLAUSE_ACTION = new RegExp(
  [
    // 分句首的单数「我」+ 动作：与 `AGENT_EXECUTION` 里那条完全同构
    "[，,。；;！!]\\s*我(?!们)(?!(?:认为|觉得|建议|推荐|倾向|估计|猜|怀疑|同意|反对|注意到|发现))[\\u4e00-\\u9fa5]",
    // 分句后「于是/然后/接着」+ 可选「直接」+ 处置式 ⇒ 我刚做/正在做的事
    "[，,。；;！!]\\s*(?:于是|然后就?|接着就?|随后就?)\\s*(?:直接|干脆)?[把将]",
    // 分句后「开始/继续/着手」+ 单字动作 ⇒ 执行步骤
    "[，,。；;！!]\\s*(?:开始|继续|着手|接着)\\s*(?:读|写|改|查|看|跑|试|做|补|删|加|执行|访问|克隆|搜|扫|装|跑)"
  ].join("|")
);
var DEMONSTRATIVE_TAIL = /^(?:个|些|款|套|种|位|类|份|条|张|组)?/;
var SPECIFIC_NOUN = /^(?:仓库|项目|工具|文件|目录|脚本|配置|方案|方法|代码|引擎|库|框架|接口|服务|模型|插件|提示词|流程|结构|数据|字段|参数|版本|端口|缓存|日志|文档|测试|命令|变量|函数|模块|组件|页面|问题|结论|决策|约束|目标|任务|步骤|环节|阶段|部分|章节|表格|图片|音频|视频|素材|配置项|依赖|环境|分支|提交|改动|差异)/;
function startsWithBareDemonstrative(text) {
  const head = DEMONSTRATIVE_HEAD.exec(text);
  if (head === null) return false;
  const afterHead = text.slice(head[0].length);
  const tail = DEMONSTRATIVE_TAIL.exec(afterHead);
  const rest = afterHead.slice(tail === null ? 0 : tail[0].length).trim();
  if (SPECIFIC_NOUN.test(rest)) return false;
  if (rest.replace(/[\s，。；：、！？]/g, "").length < 2) return true;
  return false;
}
var DEPENDENT_CLAUSE = /^(?:如果|若|假如|倘若|一旦|除非|虽然|尽管|即使|即便|哪怕|纵使|纵然|无论|不管|因为|由于|要?不然|或者?|还是|把|将|给|被|有件事|顺便|另外说|不是|并非|而不是)/;
var IMPERATIVE_PREDICATE = /^(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律|只支持|仅支持|只兼容|仅兼容|不要|别用|别再|别碰|别动|别改|别删|别写|别加|别存|别把|别连|别忘|请用|请勿|记得)$/;
var COMMENT_MARKER = /^(?:TODO|FIXME|NOTE|HACK|XXX|注意|备注|提醒)\s*[：:]\s*/i;
function stripCommentMarker(text) {
  return text.replace(COMMENT_MARKER, "");
}
var ORDERED_PREDICATES = Object.entries(PREDICATES).flatMap(([kind, words]) => words.map((word) => ({ kind, word }))).sort((a, b) => b.word.length - a.word.length);
var ENGLISH_PREDICATES = [
  { kind: "constraint", word: "must not" },
  { kind: "constraint", word: "should not" },
  { kind: "constraint", word: "do not" },
  { kind: "constraint", word: "only use" },
  { kind: "constraint", word: "must use" },
  { kind: "constraint", word: "must" },
  { kind: "constraint", word: "never" },
  { kind: "constraint", word: "always" },
  { kind: "decision", word: "decided to" },
  { kind: "decision", word: "switched to" },
  { kind: "decision", word: "chose" },
  { kind: "conclusion", word: "root cause is" },
  { kind: "conclusion", word: "the conclusion is" },
  { kind: "goal", word: "at most" },
  { kind: "goal", word: "no more than" }
].sort((a, b) => b.word.length - a.word.length);
var ALL_PREDICATES = [...ORDERED_PREDICATES, ...ENGLISH_PREDICATES];
var COPYULA_SINGLE = ["是"];
var PROCESS_NARRATION = /^(?:我(?:先|来|去|再|正在|会先|要|得|需要)|让我|接下来我|下面我|现在(?:我)?(?:来|去)|先(?:看|查|读|试|跑))|(?:那我?得|我需要先|我还得|得先|还要先|我要先|让我先)|(?:得|要|需要|待|准备)(?:确认|核实|梳理|查一下|看看|确认一下)/;
var AGENT_EXECUTION = new RegExp(
  [
    // 时间 / 顺序副词开头
    "^(?:接下来|下面|然后|接着|下一步|随后|之后)",
    // 时间副词 + 处置式（`现在把 X 改成 Y`）
    "^现在(?:就)?[把将]",
    // 并列副词 + 处置式（`同时把 X 改成 Y` / `并把它换成`）
    //
    // ## 为什么单独处理「把」开头的祈使句（★2026-11-14）
    //
    // `把` 既可能是**处置式动作**（我要把 X 改成 Y），也可能是**祈使规则**
    // （把音频放到桌面 —— 让人照做）。区别在「把」后面的宾语：
    // ```
    // 同时把 `base.css` 那段改成…   ← 宾语是具体文件 + 有「改成」（执行）
    // 把缓存放在工作区之外            ← 祈使交付指令，必须保留
    // ```
    // 判据：只有「把」前面有并列/时间副词时才按执行叙述拒；
    // 裸「把」开头不在此列（交给三元组与祈使判据决定）。
    "^(?:同时|顺便|一并|并且|然后)[把将]",
    "^[并也再就又][把将]",
    // ## 单数「我」+ 动作谓词 ⇒ 执行叙述（★2026-11-14 真实会话）
    //
    // 实测残留：`我会补上两个图标` / `我改用点击` / `我用 foldSurface 验证`
    // 原先靠枚举「我先/我来/我去…」覆盖，但动词是开放集合，枚举永远漏。
    //
    // 反向的判据更稳：**助手说「我」+ 具体动作，就是在讲自己做了什么**。
    // 而下面这些「我」开头的句子必须保留，它们是判断不是动作：
    // ```
    // 我们必须完整经历五屏引导     ← 复数「我们」= 产品规则
    // 我建议用 pnpm 替代 npm       ← 建议（情态动词，不是动作）
    // 我认为这个方案更好           ← 认为（认知动词，是判断）
    // ```
    // 所以只排除两类：复数主语、以及认知/建议类情态动词。
    "^我(?!们)(?!(?:认为|觉得|建议|推荐|倾向|估计|猜|怀疑|同意|反对|注意到|发现))[\\u4e00-\\u9fa5]",
    // 省略主语的执行动作
    "^换(?:到|成|一个|个)|^重(?:跑|来|做)|^删掉|^加上|^去掉",
    // ## 完成时态「全部/都/已 + 换成/改成」⇒ 刚做完的动作（★2026-11-15）
    //
    // ```
    // 全部换成了真正绘制的线条        ← 我刚做完的事
    // 都改成 SVG 了                  ← 我刚做完的事
    // ```
    // 判据是**完成标记 + 变更动词**的组合：`全部/都/已/已经` 修饰
    // `换成/改成/改为` 时，句子在报告一次已完成的操作，而不是留一条约定。
    // 真正的决策不会带「全部」「都」这类范围副词 —— 那是已完成动作的总结。
    "^(?:全部|全都|都|已|已经|均已|现已)[^，。]{0,6}(?:换成|改成|改为|换作|改作)",
    // ## 建议式 + 变更动词 ⇒ 待定方案（★2026-11-15）
    //
    // ```
    // 建议改成墨底 + 朱边          ← 我提议的改法（尚未拍板）
    // 建议收集用户反馈             ← 产品层面的建议（有价值，保留）
    // 改用 --stdin 传入 JSON       ← 已定的做法（保留）
    // ```
    // 只拦「建议 + 改/换/调」这种**改动方案**，不拦一般性建议。
    "^(?:建议|推荐|不妨|可以考虑|不如)[^，。]{0,4}(?:改|换|调|替换)",
    // ## 征询/自荐句式 ⇒ 执行意图，不是结论（★2026-11-14）
    //
    // ```
    // 需要我把它改成方印的形状        ← 征询下一步动作（过程）
    // 我来帮你补上这两个图标          ← 自荐（过程）
    // ```
    // 这类句子主语被前置的「需要/要」挡住，逃过了上面「我」开头的判据。
    "^(?:需要|要|是否要|要不要)我"
  ].join("|")
);
var DEMONSTRATIVE_HEAD = /^(?:这|那|它|其|该|此)(?:个|些|样|种)?/;
var TEMPORARY_MARKER = /(?:这次|本次|本轮|临时|先这么|暂时|这个任务|当前任务|做一?个)/;
var PLANNING_AFTER_DECLARATION = /(?:目标|结论)\s*(?:是|为|：|:)\s*(?:先|再|准备|打算|将要|待|接下来|下一步|后续)|(?:下一步|接下来|后续|然后|下面|接着)\s*目标/;
var QUESTION_TAIL = /[？?]\s*$|(?:吗|呢)\s*$/;
var QUESTION_WORD = /为什么|为何|怎么|如何|是否|有没有|是不是|能不能|可不可以|哪里|哪儿|哪个|哪些|多少|请问/;
var A_NOT_A_QUESTION = /(?:要不要|是不是|能不能|能否|会不会|该不该|可不可以|应不应该|可否)/;
var A_NOT_A_HAS = /有无(?:$|[？?，,。；;])|有无(?:更|其|任|何|哪)/;
var EXPLANATION_VERB = /(?:说明|解释|讲清楚?|搞清楚?|查清楚?|弄清楚?|写明|记录|分析|确认|判断|理解)$/;
var REBUTTAL = /不是(?:已经)?(?:告诉|跟|给|对)(?:过)?你|我(?:已经|早就)?(?:跟你说过|告诉过你|讲过|强调过|说的是|要的是)|(?:跟|和|对)你说(?:过)?(?:多少|几)(?:遍|次)|说(?:过|了)(?:两|三|好几|\d+)(?:遍|次)|(?:强调|重申)(?:过|一?次)/;
function deriveRebuttal(text) {
  const t = text.trim();
  if (!REBUTTAL.test(t)) return null;
  const body = t.replace(/[？?]+$/, "").trim();
  if (body.length < MIN_STATEMENT) return null;
  return { subject: "", value: body };
}
function isPlannedNarration(text) {
  return PLANNING_AFTER_DECLARATION.test(text.trim());
}
function isQuestion(text) {
  const t = text.trim();
  if (REBUTTAL.test(t)) return false;
  if (QUESTION_TAIL.test(t)) return true;
  const m = QUESTION_WORD.exec(t);
  const anotA = A_NOT_A_QUESTION.exec(t) ?? A_NOT_A_HAS.exec(t);
  const hit = m !== null ? m : anotA;
  if (hit === null) return false;
  const before = t.slice(0, hit.index).trim().replace(/[，,：:\s]+$/, "");
  if (EXPLANATION_VERB.test(before)) return false;
  return true;
}
function isProcessNarration(text, origin = "assistant") {
  const t = text.trim();
  if (PROCESS_NARRATION.test(t)) return true;
  if (origin !== "assistant") return false;
  if (AGENT_EXECUTION.test(t)) return true;
  if (CLAUSE_TEMPORAL.test(t)) return true;
  if (CLAUSE_ACTION.test(t)) return true;
  return false;
}
var POSITIONAL_SUBJECT = /^的?(?:旁边|左侧|右侧|左边|右边|上方|下方|上面|下面|里面|内部|外面|周围|中间|后面|前面|身边|身上|底下|对面|两侧|两端|四周|附近|隔壁|顶部|底部)\s*(?:是|为|在|有|放|装|摆)/;
function isSelfContained(text) {
  const t = text.trim();
  const head = DEMONSTRATIVE_HEAD.exec(t);
  if (head === null) return true;
  const rest = t.slice(head[0].length).trim();
  if (POSITIONAL_SUBJECT.test(rest)) return false;
  if (rest.replace(/[\s，。；：、！？]/g, "").length < 6) return false;
  return true;
}
var PATH_TOKEN = /\bhttps?:\/\/[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+|[A-Za-z]:[\\/][^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*|\\\\[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*|(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]*|[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|ini|png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|pptx?|csv|log|mp4|mp3|wav|sh|ps1|zip)\b/gi;
function maskPathTokens(text) {
  return text.replace(PATH_TOKEN, (token) => " ".repeat(token.length));
}
var QUOTED_SEGMENT = /`[^`]*`|「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g;
function maskQuotedSegments(text) {
  return text.replace(QUOTED_SEGMENT, (segment) => " ".repeat(segment.length));
}
function deriveClaim(statement, hint) {
  const text = statement.trim();
  if (text.length < MIN_STATEMENT) return null;
  if (/^[{\[]/.test(text) && text.includes('"')) return null;
  if (/"[^"]{1,40}"\s*:/.test(text)) return null;
  const clauses = text.split(/[，,；;]/).map((c) => c.trim()).filter((c) => c.length > 0);
  const candidates = clauses.length > 1 ? clauses : [text];
  for (const clause of candidates) {
    const claim = deriveFromClause(clause, hint);
    if (claim !== null) return claim;
  }
  return null;
}
function deriveFromClause(clause, hint) {
  const text = clause.trim();
  if (text.length < MIN_STATEMENT) return null;
  const masked = maskQuotedSegments(maskPathTokens(text));
  let best = null;
  for (const { kind, word } of ALL_PREDICATES) {
    if (hint !== void 0 && hint !== kind && !(hint === "constraint" && kind === "goal")) continue;
    const at = masked.indexOf(word);
    if (at < 0) continue;
    if (word.length === 1 && !COPYULA_SINGLE.includes(word)) {
      const after = masked[at + 1] ?? "";
      if (/[\u4e00-\u9fa5]/.test(after)) continue;
    }
    if (best === null || at < best.at || at === best.at && word.length > best.word.length) {
      best = { kind, word, at };
    }
  }
  if (best === null) return null;
  if (LEADING_CONJUNCTION.test(text)) return null;
  if (startsWithBareDemonstrative(text)) return null;
  if (DEPENDENT_CLAUSE.test(text)) return null;
  const leadingPredicate = best.at === 0;
  if (leadingPredicate && !IMPERATIVE_PREDICATE.test(best.word)) {
    const declarative = (best.kind === "decision" || best.kind === "conclusion" || best.kind === "goal") && best.word.length >= 2;
    const english = /^[A-Za-z ]+$/.test(best.word);
    if (!declarative && !english) return null;
  }
  const rawSubject = text.slice(0, best.at).trim();
  const subjectIsCausalOnly = LEADING_CAUSAL.test(rawSubject) && rawSubject.length <= 4;
  const subject = subjectIsCausalOnly ? rawSubject : rawSubject.replace(/[，,；;：:]?\s*(?:并|且|而|但|却|也|还|就|才|则)\s*$/, "").trim();
  if (subjectIsCausalOnly && !(best.kind === "decision" || best.kind === "conclusion" || best.kind === "goal")) {
    return null;
  }
  if (TIME_ADVERB_ONLY.test(subject) && !IMPERATIVE_PREDICATE.test(best.word)) {
    if (!/^(?:不再|无需|无需再|已经|仍然|仍)/.test(best.word)) return null;
  }
  const value = text.slice(best.at + best.word.length).trim().replace(/^[：:，,\s]+/, "").replace(/[：:，,。；;！!？?\s]+$/, "").trim();
  if (/(?:的|了|过|过的|了的)$/.test(value)) return null;
  if (hasUnpairedQuote(`${subject}${value}`)) return null;
  if (value.replace(/[\s，。；：、！？"'`]/g, "").length < MIN_VALUE_CHARS) return null;
  if (EMPTY_POINTER.test(value)) return null;
  if (value.length > MAX_VALUE_CHARS) return null;
  if (/你/.test(subject) && /我/.test(subject)) return null;
  const subjectNoPronoun = subject.replace(/^(?:那么|所以|但是|而且|另外|其实|然后)?\s*(?:我|我们|你|你们|他|她|它)\s*(?:们)?/g, "").trim();
  if (subject.length > 0 && subjectNoPronoun.replace(/[\s，。；：、！？"'`]/g, "").length === 0) {
    if (!/^(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律|不要)$/.test(best.word)) {
      return null;
    }
  }
  if (subject.length > 0 && !isSelfContained(subject + best.word + value)) return null;
  const subjectShape = stripCommentMarker(subject).trim();
  if (subjectShape.length > 0) {
    if (/的$/.test(subjectShape)) return null;
    if (/[：:]/.test(subjectShape)) return null;
    if (/[。！!？?]/.test(subjectShape)) return null;
    if (hasUnpairedBracket(subjectShape)) return null;
    if (/^(?:一款|一个|一种|一套|一份|一条|一项|这个|那个|这些|那些|其|该|此)$/.test(subjectShape)) {
      return null;
    }
  }
  const finalSubject = subjectIsCausalOnly ? "" : subject;
  if (best.kind === "goal" && !GOAL_QUANTITY.test(value)) return null;
  if (OBSERVATIONAL_GOAL_VERB.test(best.word) && !GOAL_BOUND_SUFFIX.test(value)) return null;
  if (best.word.length === 1 && !/[A-Za-z0-9]/.test(value)) return null;
  if ((best.word === "只能" || best.word === "只允许") && !hasConcreteValue(value)) return null;
  if (/(?:一个|一下|这个|那个|一次|一项|一条|一种)$/.test(value)) return null;
  if (best.kind === "statement" && !passesStatementGate(best.word, subject, value)) return null;
  return { kind: best.kind, subject: finalSubject, predicate: best.word, value };
}
function passesStatementGate(word, rawSubject, value) {
  const subject = rawSubject.trim();
  const subjectBody = subject.replace(/[\s，。；：、！？"'`（）()]/g, "");
  if (subjectBody.length < 2) return false;
  const withoutDemonstrative = subjectBody.replace(/^(?:这|那|它|其|该|此)(?:个|些|样|种|位|款)?/, "");
  if (withoutDemonstrative.length === 0) return false;
  if (withoutDemonstrative.length < 2) return false;
  if (/^(?:是的?|不是|并非|就是)$/.test(subjectBody)) return false;
  if (/^(?:可能|似乎|应该|大概|也许|或许|好像)/.test(subjectBody)) return false;
  const valueBody = value.replace(/[\s，。；：、！？"'`（）()]/g, "");
  if (valueBody.length < 4) return false;
  if (/^(?:吗|呢|吧|了|的|啊|呀|嘛)$/.test(valueBody)) return false;
  if (/[？?]/.test(value)) return false;
  if (/(?:吗|呢)\s*$/.test(value)) return false;
  if (word === "是") {
    const hasProperNoun = /[A-Za-z0-9]/.test(subject);
    if (!hasProperNoun && subjectBody.length < 4) return false;
  }
  return true;
}
function hasUnpairedQuote(text) {
  const pairs = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["（", "）"],
    ["(", ")"],
    ["《", "》"]
  ];
  for (const [open, close] of pairs) {
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    if (opens !== closes) return true;
  }
  if (text.includes("——")) return true;
  return false;
}
function hasUnpairedBracket(text) {
  const pairs = [
    ["（", "）"],
    ["(", ")"],
    ["【", "】"],
    ["[", "]"]
  ];
  for (const [open, close] of pairs) {
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    if (opens !== closes) return true;
  }
  return false;
}
function hasConcreteValue(value) {
  if (/[A-Za-z0-9]/.test(value)) return true;
  return /(?:端口|目录|文件夹|路径|工作区|缓存|配置|文件|音频|视频|图片|脚本|密钥|参数|环境|分支|提交|首页|封面|字体|配色|版式|动效)/.test(
    value
  );
}
var PLACE_NOUN = /(?:桌面|下载目录|文档目录|视频目录|目录|文件夹|盘|硬盘|网盘|云盘|U\s*盘|移动硬盘|本地|本机|电脑|服务器|共享|onedrive|素材库|assets|build|dist|public|temp|tmp|工作区|项目|工程|当前目录|根目录|子目录|同目录|上级目录|这里|这儿|那儿|路径)/;
var LOCATION_VERB = /(?:位于|放在|放到|存在|来自|存到|拷到|复制到|在)/;
function deriveLocation(text) {
  const t = text.trim();
  const m = LOCATION_VERB.exec(t);
  if (m === null) return null;
  const verb = m[0];
  const at = m.index;
  const subject = t.slice(0, at).trim();
  const value = t.slice(at + verb.length).trim().replace(/^[：:，,\s]+/, "");
  if (subject.replace(/[\s，。；：、！？]/g, "").length < 2) return null;
  if (value.replace(/[\s，。；：、！？"'`]/g, "").length < 2) return null;
  if (/[：:]/.test(subject)) return null;
  const valueAtFirstComma = value.split(/[，,；;]/)[0].trim();
  if (valueAtFirstComma.length === 0) return null;
  const hasPlace = PLACE_NOUN.test(valueAtFirstComma) || /^[A-Za-z]:[\\/]/.test(valueAtFirstComma) || /\.(?:wav|mp3|mp4|mov|png|jpe?g|gif|webp|md|txt|json|ts|js)\b/i.test(valueAtFirstComma) || /[\\/]/.test(valueAtFirstComma);
  if (!hasPlace) return null;
  return { subject, predicate: "位于", value: valueAtFirstComma };
}
function validateFact(fact) {
  const statement = fact.statement.trim();
  if (fact.kind === "artifact") {
    if (fact.value.trim().length === 0) return { ok: false, reason: "no_value" };
    if (!/^[0-9a-f]{8,64}$/i.test(fact.value.trim())) return { ok: false, reason: "bad_artifact_hash" };
    if (fact.predicate.trim().length === 0) return { ok: false, reason: "no_predicate" };
    if (statement.length < MIN_STATEMENT) return { ok: false, reason: "statement_too_short" };
    return { ok: true };
  }
  if (statement.length < MIN_STATEMENT) return { ok: false, reason: "statement_too_short" };
  if (statement.length > MAX_STATEMENT) return { ok: false, reason: "statement_too_long" };
  if (/\*\*|__|`{2,}|^\s*[-*+]\s/.test(statement)) return { ok: false, reason: "markup_fragment" };
  if (fact.predicate.trim().length === 0) return { ok: false, reason: "no_predicate" };
  if (fact.value.trim().length === 0) return { ok: false, reason: "no_value" };
  if (!isSelfContained(statement)) return { ok: false, reason: "not_self_contained" };
  if (isProcessNarration(statement, fact.origin)) return { ok: false, reason: "process_narration" };
  if (fact.confidence < MIN_CONFIDENCE) return { ok: false, reason: "low_confidence" };
  if (isPlannedNarration(statement)) return { ok: false, reason: "planned_narration" };
  if (isQuestion(statement)) return { ok: false, reason: "question" };
  if (/^[{\[]/.test(statement) && statement.includes('"')) return { ok: false, reason: "machine_output" };
  if (/"[^"]{1,40}"\s*:/.test(statement)) return { ok: false, reason: "machine_output" };
  return { ok: true };
}
function validateJudgedFact(fact) {
  const statement = fact.statement.trim();
  if (fact.kind === "artifact") return validateFact(fact);
  if (statement.length < MIN_STATEMENT) return { ok: false, reason: "statement_too_short" };
  if (statement.length > MAX_JUDGED_STATEMENT) return { ok: false, reason: "statement_too_long" };
  if (/\*\*|__|`{2,}|^\s*[-*+]\s/.test(statement)) return { ok: false, reason: "markup_fragment" };
  if (/^\s*\|.*\|\s*$/.test(statement)) return { ok: false, reason: "markup_fragment" };
  if (/^[{\[]/.test(statement) && statement.includes('"')) return { ok: false, reason: "machine_output" };
  if (/"[^"]{1,40}"\s*:/.test(statement)) return { ok: false, reason: "machine_output" };
  if (isQuestion(statement)) return { ok: false, reason: "question" };
  if (isPlannedNarration(statement)) return { ok: false, reason: "planned_narration" };
  return { ok: true };
}
function makeArtifactFact(input) {
  const preview = input.preview.trim();
  return {
    kind: "artifact",
    subject: input.kindLabel,
    predicate: "位于工件库",
    value: input.hash,
    statement: `${input.kindLabel}已存入工件库（${input.chars} 字符，hash=${input.hash}）${preview.length > 0 ? `：${preview}` : ""}`,
    scope: "session",
    origin: input.origin,
    confidence: 0.95,
    source: { sessionId: input.sessionId, turn: input.turn },
    status: "active"
  };
}
function makeFact(input) {
  const raw = input.statement.trim().replace(/^[-*+\d.)\s]+/, "");
  if (raw.length === 0) return null;
  const loc = input.asLocation === true ? deriveLocation(raw) : null;
  const claim = loc !== null ? { kind: "location", ...loc } : deriveClaim(raw, input.hint);
  if (claim === null) {
    const scope2 = TEMPORARY_MARKER.test(raw) ? "session" : "project";
    return {
      kind: input.hint ?? "statement",
      subject: "",
      predicate: "",
      value: "",
      statement: raw,
      scope: scope2,
      origin: input.origin,
      confidence: input.confidence ?? 0.8,
      source: { sessionId: input.sessionId, turn: input.turn },
      status: "active",
      enriched: false
    };
  }
  const join4 = (left, right) => {
    if (left.length === 0) return right;
    const needSpace = /[A-Za-z0-9]$/.test(left) || /^[A-Za-z0-9]/.test(right);
    return needSpace ? `${left} ${right}` : `${left}${right}`;
  };
  const head = join4(claim.subject, claim.predicate === "位于" ? "位于" : claim.predicate);
  const statement = join4(head, claim.value);
  const scope = TEMPORARY_MARKER.test(raw) ? "session" : "project";
  return {
    kind: claim.kind,
    subject: claim.subject,
    predicate: claim.predicate,
    value: claim.value,
    statement: statement.trim(),
    scope,
    origin: input.origin,
    confidence: input.confidence ?? 0.8,
    source: { sessionId: input.sessionId, turn: input.turn },
    status: "active",
    enriched: true
  };
}
function renderFact(fact) {
  return `[${KIND_LABEL[fact.kind]}] ${fact.statement}`;
}
function factKey(fact) {
  const norm = (s) => s.replace(/[\s，。；：、！？"'`（）()]/g, "").toLowerCase();
  const kind = fact.kind === "goal" ? "constraint" : fact.kind;
  if (fact.predicate.length === 0) {
    return `${kind}|statement|${norm(fact.statement ?? "")}`;
  }
  return `${kind}|${norm(fact.subject)}|${norm(fact.predicate)}`;
}
var MEMORY_TYPE = {
  constraint: "preference",
  goal: "preference",
  decision: "decision",
  conclusion: "fact",
  location: "fact",
  artifact: "fact",
  statement: "fact",
  fact: "fact"
};
var IMPORTANCE_BASE = {
  constraint: 7,
  goal: 7,
  decision: 7,
  location: 8,
  artifact: 8,
  conclusion: 6,
  statement: 6,
  fact: 5
};
function importanceOf(fact) {
  let score = IMPORTANCE_BASE[fact.kind];
  if (fact.origin === "user") score += 1;
  if (fact.scope === "session") score -= 2;
  if (fact.enriched === true) score += 1;
  return Math.max(1, Math.min(10, score));
}
function factsToItems(facts) {
  return facts.map((fact) => ({
    content: renderFact(fact),
    memory_type: MEMORY_TYPE[fact.kind],
    tags: [fact.kind, "distilled", "lrc_schema", `scope:${fact.scope}`],
    importance: importanceOf(fact),
    source_turns: [fact.source.turn ?? 0, fact.source.turn ?? 0],
    origin: fact.origin
  }));
}

// src/memory-extract.ts
var MAX_CLAUSE = 200;
var ABS_PATH = /(?:^|[^A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\)[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*)/;
var MEDIA_TOKEN = /[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp)\b/i;
var RESOURCE_NOUN = /(?:音频|视频|文案|脚本|素材|图片|封面|成片|录音|音乐|文件|目录)/;
var TAG_KIND = /^(决策|约束|结论|决定|事实)\s*[：:]\s*/;
function hintOf(head) {
  switch (head) {
    case "决策":
      return "decision";
    case "约束":
      return "constraint";
    case "结论":
      return "conclusion";
    case "事实":
      return "statement";
    default:
      return "fact";
  }
}
function splitClauses(text) {
  const source = text.replace(/^\s*\|.*\|\s*$/gm, " ").replace(/^\s*#{1,6}\s.*$/gm, " ");
  return source.split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/).map((raw) => raw.trim().replace(/^[-*+\d.)\s]+/, "").trim()).filter((line) => line.length > 0 && line.length <= MAX_CLAUSE);
}
function isStructuralNoise(line) {
  if (isSmallTalk(line)) return true;
  if (isOptionLabel(line)) return true;
  if (looksLikeNormalLog(line)) return true;
  if (looksLikeMachineOutput(line)) return true;
  if (/^\s{4,}|^(?:const|let|var|function|class|import|export|def|fn)\s/.test(line)) return true;
  return false;
}
function pathLocations(text) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(new RegExp(ABS_PATH.source, "g"))) {
    const token = (m[1] ?? "").trim().replace(/[，。；：、]+$/, "");
    if (token.length < 3) continue;
    if (seen.has(token)) continue;
    const after = text.slice((m.index ?? 0) + token.length, (m.index ?? 0) + token.length + 24);
    const noun = RESOURCE_NOUN.exec(after);
    if (noun === null) continue;
    seen.add(token);
    out.push({ subject: noun[0], value: token });
  }
  const media = MEDIA_TOKEN.exec(text);
  if (media !== null && out.length === 0 && !seen.has(media[0])) {
    const at = media.index ?? 0;
    const window = text.slice(Math.max(0, at - 24), at + media[0].length + 24);
    const noun = RESOURCE_NOUN.exec(window);
    if (noun === null) return out;
    out.push({ subject: noun[0], value: media[0] });
  }
  return out;
}
function extractFacts(input) {
  const facts = [];
  const rejected = [];
  const pending = [];
  const body0 = input.text.trim();
  if (body0.length === 0) return { facts, rejected, pending };
  const base = {
    origin: input.origin,
    sessionId: input.sessionId,
    turn: input.turn
  };
  const tag = extractMemoryTag(body0);
  if (tag !== null && !isNoUpdate(tag)) {
    for (const raw of stripCodeFences(tag).split("\n")) {
      const line = raw.trim().replace(/^[-*+]\s*/, "").trim();
      if (line.length === 0) continue;
      const head = TAG_KIND.exec(line);
      const hint = head !== null ? hintOf(head[1]) : void 0;
      const statement = head !== null ? line.slice(head[0].length).trim() : line;
      const fact = makeFact({ statement, ...base, hint, confidence: 0.95 });
      if (fact === null) {
        rejected.push({ text: line, reason: "no_claim" });
        continue;
      }
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        rejected.push({ text: line, reason: verdict.reason });
        continue;
      }
      facts.push(fact);
    }
  }
  const body = stripMemoryTag(stripCodeFences(body0));
  if (input.origin === "user") {
    for (const loc of pathLocations(body)) {
      const statement = `${loc.subject}位于 ${loc.value}`;
      const fact = makeFact({ statement, ...base, asLocation: true, confidence: 0.9 });
      if (fact === null) {
        rejected.push({ text: statement, reason: "no_claim" });
        continue;
      }
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        rejected.push({ text: statement, reason: verdict.reason });
        continue;
      }
      facts.push(fact);
    }
  }
  for (const line of splitClauses(body)) {
    if (isStructuralNoise(line)) {
      rejected.push({ text: line, reason: "structural_noise" });
      continue;
    }
    if (isProcessNarration(line, input.origin)) {
      rejected.push({ text: line, reason: "process_narration" });
      continue;
    }
    if (!isSelfContained(line)) {
      rejected.push({ text: line, reason: "not_self_contained" });
      continue;
    }
    let fact = null;
    if (input.origin === "user") {
      const loc = deriveLocation(line);
      if (loc !== null) {
        fact = makeFact({ statement: line, ...base, asLocation: true, confidence: 0.85 });
      }
      if (fact === null) {
        const rebuttal = deriveRebuttal(line);
        if (rebuttal !== null) {
          fact = {
            kind: "constraint",
            subject: rebuttal.subject,
            predicate: "已明确要求",
            value: rebuttal.value,
            statement: rebuttal.value,
            scope: "project",
            origin: "user",
            confidence: 0.9,
            source: { sessionId: input.sessionId, turn: input.turn },
            status: "active",
            enriched: true
          };
        }
      }
    }
    if (fact === null) {
      fact = makeFact({ statement: line, ...base, confidence: input.origin === "user" ? 0.9 : 0.85 });
    }
    if (fact === null) {
      rejected.push({ text: line, reason: "no_claim" });
      continue;
    }
    const verdict = validateFact(fact);
    if (!verdict.ok) {
      if (verdict.reason === "no_predicate" || verdict.reason === "no_value") {
        pending.push(line);
        continue;
      }
      rejected.push({ text: line, reason: verdict.reason });
      continue;
    }
    facts.push(fact);
  }
  return { facts, rejected, pending };
}
function extractFactsFromReasoning(input) {
  const result = extractFacts(input);
  return {
    facts: result.facts.map((fact) => ({ ...fact, confidence: Math.min(fact.confidence, 0.8) })),
    rejected: result.rejected,
    pending: result.pending
  };
}
function factsFromLlmLines(lines, base) {
  const facts = [];
  const rejected = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const head = TAG_KIND.exec(line);
    const hint = head !== null ? hintOf(head[1]) : void 0;
    const statement = head !== null ? line.slice(head[0].length).trim() : line;
    const fact = makeFact({ statement, ...base, hint, confidence: 0.7 });
    if (fact === null) {
      rejected.push({ text: line, reason: "no_claim" });
      continue;
    }
    const verdict = validateJudgedFact(fact);
    if (!verdict.ok) {
      rejected.push({ text: line, reason: verdict.reason });
      continue;
    }
    facts.push(fact);
  }
  return { facts, rejected, pending: [] };
}
function dedupeKey(fact) {
  return maskPaths(fact.statement).replace(/\s+/g, "");
}
function dedupeFacts(incoming, existing, isNear) {
  const fresh = [];
  let dropped = 0;
  for (const fact of incoming) {
    const key = dedupeKey(fact);
    const dup = fresh.some((f) => dedupeKey(f) === key || isNear(f.statement, fact.statement)) || existing.some((f) => dedupeKey(f) === key || isNear(f.statement, fact.statement));
    if (dup) {
      dropped += 1;
      continue;
    }
    fresh.push(fact);
  }
  return { fresh, dropped };
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
function keepPriority(fact) {
  switch (fact.kind) {
    case "location":
    case "constraint":
    case "goal":
      return 0;
    case "artifact":
      return 0;
    case "decision":
      return 1;
    case "conclusion":
      return 2;
    default:
      return 3;
  }
}
function buildSnapshot(facts, maxItems) {
  if (facts.length === 0) return "";
  const picked = pickDiverseSnapshot(facts, maxItems);
  if (picked.length === 0) return "";
  return `[LRC 状态] ${picked.join("；")}。细节在 LRC，需要时 recall。`;
}
function pickDiverseSnapshot(facts, maxItems) {
  if (facts.length === 0 || maxItems <= 0) return [];
  const groups = /* @__PURE__ */ new Map();
  for (const fact of facts) {
    const rank = keepPriority(fact);
    const list = groups.get(rank) ?? [];
    list.push(fact);
    groups.set(rank, list);
  }
  const bodyOf = (fact) => fact.statement.trim();
  const keyOf = (s) => s.replace(/[\s，。；：、！？（）()"'`*]/g, "");
  const picked = [];
  const pickedKeys = [];
  const cursor = /* @__PURE__ */ new Map();
  const push = (fact) => {
    const body = bodyOf(fact);
    picked.push(body.length > 120 ? `${body.slice(0, 120)}…` : body);
    pickedKeys.push(keyOf(body));
  };
  const takeNext = (rank) => {
    const list = groups.get(rank) ?? [];
    let i = cursor.get(rank) ?? 0;
    while (i < list.length) {
      const fact = list[i];
      const key = keyOf(bodyOf(fact));
      i += 1;
      if (key.length === 0) continue;
      if (pickedKeys.some((p) => areNearDuplicate(p, key, 0.75))) continue;
      push(fact);
      cursor.set(rank, i);
      return true;
    }
    cursor.set(rank, i);
    return false;
  };
  const takeMatching = (rank, pred) => {
    const list = groups.get(rank) ?? [];
    const idx = list.findIndex(pred);
    if (idx < 0) return false;
    push(list[idx]);
    list.splice(idx, 1);
    return true;
  };
  if (maxItems >= 3) {
    takeMatching(0, (f) => f.kind === "location");
    takeMatching(0, (f) => f.kind === "artifact");
    takeMatching(0, (f) => f.origin === "user" && f.kind !== "location" && f.kind !== "artifact");
  }
  const order2 = [...groups.keys()].sort((a, b) => a - b);
  const HIGH = order2.filter((r) => r <= 1);
  const LOW = order2.filter((r) => r > 1);
  let progress = true;
  while (picked.length < maxItems && progress) {
    progress = false;
    for (const rank of HIGH) {
      if (picked.length >= maxItems) break;
      if (takeNext(rank)) progress = true;
    }
  }
  for (const rank of [...LOW, ...HIGH]) {
    if (picked.length >= maxItems) break;
    while (picked.length < maxItems && takeNext(rank)) {
    }
  }
  return picked;
}
var Offloader = class {
  /**
   * LRC 客户端**可后置注入**。
   *
   * 为什么不是构造时写死：插件可能在 LRC 还没起来时加载（实测桌面端晚 20 分钟），
   * 此前的做法是整个 Offloader 都不创建 —— 连 `observe()` 的计数都不做，
   * 于是 LRC 恢复后，之前那些轮次的内容已经不在待沉淀队列里了。
   */
  client;
  cursors;
  config;
  recentStore;
  pendingTurns = 0;
  pendingChars = 0;
  pendingSteps = 0;
  /** 最近已发送的内容，用于本地查重（跨会话共享，避免重复入库） */
  recent = [];
  /**
   * 快照候选池（**跨批累积**，上限 20）。
   *
   * `buildSnapshot` 只对**传入的那一批**排序，而真实调用每次只传
   * 当前这一条消息抽出的 1~2 条 —— 此时「按类别优先排序」在数学上
   * 等于「原序」，整场会话结束时关键约束全被下一条过程记录顶掉。
   */
  snapshotPool = [];
  snapshotPoolMax = 20;
  /**
   * 池代次：会话切换时递增，用于丢弃**在飞**的旧会话沉淀结果。
   *
   * 光有 `snapshotGeneration` 不够：那个闸门在 `index.ts` 的 `.then` 回调里，
   * 而 `buildPooledSnapshot()` **内部**就改池子 —— 等闸门返回时池子早已被改脏。
   */
  poolEpoch = 0;
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
  get connected() {
    return this.client !== null;
  }
  /** 当前池代次（发起异步请求时先取一份，返回时比对）。 */
  get epoch() {
    return this.poolEpoch;
  }
  bind(client) {
    this.client = client;
  }
  requireClient() {
    if (this.client === null) {
      throw new Error("LRC 尚未连接");
    }
    return this.client;
  }
  /** 记录一轮新增文本（由 index.ts 在 assistant/message 事件里调用）。 */
  observe(text) {
    if (text.trim().length === 0) return;
    this.pendingTurns += 1;
    this.pendingChars += text.length;
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
  shouldOffload() {
    return this.pendingTurns >= this.config.turnsThreshold || this.pendingChars >= this.config.charsThreshold || this.pendingSteps >= this.config.stepsThreshold;
  }
  /**
   * 是否有待沉淀内容（turn/end 兜底用）。
   *
   * 必须包含 `pendingSteps`：长任务里可能只有工具调用、没有正文，
   * 此时步数阈值已经触发，但 turns/chars 都是 0。
   */
  hasPending() {
    return this.pendingTurns > 0 || this.pendingChars > 0 || this.pendingSteps > 0;
  }
  resetCounters() {
    this.pendingTurns = 0;
    this.pendingChars = 0;
    this.pendingSteps = 0;
  }
  /**
   * 清空快照池（**会话切换时必须调用**）。
   *
   * 池子里装的是本会话的约束/决策，换会话后不能继续注入 ——
   * 那与 `bindSnapshotToSession` 防的跨会话泄漏是同一类问题。
   */
  resetSnapshotPool() {
    this.snapshotPool = [];
    this.poolEpoch += 1;
  }
  /**
   * 把新条目并入池子，再用**整个池子**生成快照。
   *
   * @param facts - 本批新记忆
   * @param epoch - 发起请求时的池代次；与当前不一致说明已切会话，
   *                这批结果属旧会话，**不得写入池子**
   */
  buildPooledSnapshot(facts, epoch = this.poolEpoch) {
    if (epoch !== this.poolEpoch) return "";
    const seen = new Set(this.snapshotPool.map((f) => f.statement.replace(/\s+/g, "")));
    for (const fact of facts) {
      const key = fact.statement.replace(/\s+/g, "");
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      this.snapshotPool.push(fact);
    }
    if (this.snapshotPool.length > this.snapshotPoolMax) {
      const isHigh = (f) => keepPriority(f) <= 1;
      const pinned = [];
      const rest = [];
      let pinnedLoc = 0;
      let pinnedArtifact = 0;
      for (const fact of this.snapshotPool) {
        if (fact.kind === "location" && pinnedLoc < 2) {
          pinned.push(fact);
          pinnedLoc += 1;
        } else if (fact.kind === "artifact" && pinnedArtifact < 1) {
          pinned.push(fact);
          pinnedArtifact += 1;
        } else {
          rest.push(fact);
        }
      }
      const high = rest.filter(isHigh);
      const low = rest.filter((f) => !isHigh(f));
      const budget = Math.max(0, this.snapshotPoolMax - pinned.length);
      const highKept = budget > 0 ? high.slice(-budget) : [];
      const room = Math.max(0, budget - highKept.length);
      this.snapshotPool = room > 0 ? [...pinned, ...highKept, ...low.slice(-room)] : [...pinned, ...highKept];
    }
    return buildSnapshot([...this.snapshotPool].reverse(), this.config.snapshotItems);
  }
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
   * 执行一次卸载：从 transcript 的新增切片提取记忆并落库。
   *
   * @param sessionId 会话 ID（游标按会话分槽）
   * @param lines 当前 transcript 的全部行
   */
  async offload(sessionId, lines) {
    const epoch = this.poolEpoch;
    const state = this.cursors.get(sessionId);
    const plain = lines.map((l) => typeof l === "string" ? l : l.text);
    const originOf = (i) => {
      const l = lines[i];
      return typeof l === "string" ? "assistant" : l.origin ?? "assistant";
    };
    const slice = sliceByCursor(plain, state);
    if (slice.text.trim().length === 0) {
      this.resetCounters();
      return null;
    }
    const collected = [];
    let charsSent = 0;
    for (let i = slice.fromLine; i < plain.length; i += 1) {
      const message = plain[i];
      if (message.trim().length === 0) continue;
      charsSent += message.length;
      const result2 = extractFacts({
        text: message,
        origin: originOf(i),
        sessionId,
        turn: i
      });
      collected.push(...result2.facts);
    }
    const { fresh, dropped } = dedupeFacts(
      collected,
      [],
      (a, b) => areNearDuplicate(a, b, this.config.dedupThreshold)
    );
    const kept = [];
    let deduped = dropped;
    for (const fact of fresh) {
      if (isDuplicate(fact.statement, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      kept.push(fact);
    }
    if (kept.length === 0) {
      this.commitCursor(sessionId, plain, slice.fromLine);
      const empty = {
        charsSent,
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
    const migrated = await this.requireClient().migrate(factsToItems(kept), this.config.project);
    this.commitCursor(sessionId, plain, slice.fromLine);
    this.recent.push(...kept.map((f) => f.statement));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);
    const result = {
      charsSent,
      distilled: kept.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      snapshot: this.buildPooledSnapshot(kept, epoch),
      reset: slice.reset
    };
    this.record(result);
    return result;
  }
  /**
   * 直接沉淀一批已提取的记忆（**不走行游标**）。
   *
   * 用于推理兜底与 LLM 补全：这些内容不在 transcript 行流里，
   * 无法用行号游标追踪，只能按内容查重。
   *
   * @param options.intoPool - 是否并入快照池。**补写旧会话时必须传 `false`**：
   *   补写发生在切会话之后，此时池子已属于新会话，push 进去会让新会话
   *   下一次注入出现「B 的约束；A 会话私有：…」。
   */
  async offloadFacts(facts, options = {}) {
    const epoch = this.poolEpoch;
    const { fresh, dropped } = dedupeFacts(
      facts,
      [],
      (a, b) => areNearDuplicate(a, b, this.config.dedupThreshold)
    );
    const kept = [];
    let deduped = dropped;
    for (const fact of fresh) {
      if (isDuplicate(fact.statement, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      kept.push(fact);
    }
    if (kept.length === 0) {
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
    const migrated = await this.requireClient().migrate(factsToItems(kept), this.config.project);
    this.recent.push(...kept.map((f) => f.statement));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);
    const result = {
      charsSent: kept.reduce((sum, f) => sum + f.statement.length, 0),
      distilled: kept.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      snapshot: options.intoPool === false ? "" : this.buildPooledSnapshot(kept, epoch),
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
function linesWithOrigin(session) {
  const log = session?.log;
  if (!Array.isArray(log)) return [];
  const lines = [];
  for (const raw of log) {
    const event = raw;
    const category = classifyEvent(event);
    if (category === "assistant") {
      const text = textBlocksOnly(event.data?.message?.content);
      if (text.length > 0) lines.push({ text, origin: "assistant" });
    } else if (category === "user") {
      if (!isRealUserMessage(event)) continue;
      const text = textBlocksOnly(event.data?.content);
      if (text.length === 0) continue;
      lines.push({ text, origin: "user" });
    }
  }
  return lines;
}

// src/context-trim.ts
import { randomUUID } from "node:crypto";
var DEFAULT_KEEP_RECENT = 8;
var DEFAULT_MAX_NODES_PER_RUN = 40;
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
function normalizeCount(value, fallback, min = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  const floored = Math.floor(value);
  if (floored === 0 && value !== 0) return fallback;
  return Math.max(min, floored);
}
function normalizeMaxNodes(value) {
  if (value === void 0) return void 0;
  const asNumber = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return DEFAULT_MAX_NODES_PER_RUN;
  if (asNumber < 1) return DEFAULT_MAX_NODES_PER_RUN;
  if (asNumber > 1e3) return DEFAULT_MAX_NODES_PER_RUN;
  return Math.max(1, Math.floor(asNumber));
}
function selectTrimRange(nodes, events, keepRecentNodes, maxNodes) {
  const rawKeep = normalizeCount(keepRecentNodes, DEFAULT_KEEP_RECENT, 0);
  const keep = rawKeep < 1 ? DEFAULT_KEEP_RECENT : rawKeep;
  const limit = normalizeMaxNodes(maxNodes);
  const n = nodes.length;
  if (n <= keep + 1) return null;
  const cut = new Array(n + 1).fill(false);
  let running = 0;
  cut[0] = true;
  for (let i = 0; i < n; i += 1) {
    running += toolDelta(events[nodes[i]]);
    cut[i + 1] = running === 0;
  }
  const hardEnd = n - keep - 1;
  let endIdx = hardEnd;
  while (endIdx >= 0 && (cut[endIdx + 1] !== true || !isTrimBoundaryEligible(events[nodes[endIdx]]))) {
    endIdx -= 1;
  }
  if (endIdx < 0) return null;
  let startIdx = 0;
  while (startIdx <= endIdx && (cut[startIdx] !== true || !isTrimBoundaryEligible(events[nodes[startIdx]]))) {
    startIdx += 1;
  }
  if (startIdx > endIdx) return null;
  if (limit !== void 0 && endIdx - startIdx + 1 > limit) {
    let want = Math.min(endIdx, startIdx + limit - 1);
    let e = want;
    while (e >= startIdx && (cut[e + 1] !== true || !isTrimBoundaryEligible(events[nodes[e]]))) {
      e -= 1;
    }
    if (e >= startIdx) {
      endIdx = e;
    } else {
      const hardCap = Math.min(endIdx, startIdx + limit * 2 - 1);
      let up = Math.max(want, startIdx);
      while (up <= hardCap && (cut[up + 1] !== true || !isTrimBoundaryEligible(events[nodes[up]]))) {
        up += 1;
      }
      if (up > hardCap) return null;
      endIdx = up;
    }
  }
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
function splitSentences(text) {
  return text.split(/[\n。！？；]+/).map((line) => line.trim().replace(/^[-*+\d.)\s|#]+/, "").trim()).filter((line) => line.length > 0);
}
function collect(target, seen, line, limit, options = {}) {
  if (line.length === 0 || seen.has(line)) return;
  if (target.length >= limit) {
    if (options.keepNewest !== true) return;
    const evicted = target.shift();
    if (evicted !== void 0) seen.delete(evicted);
  }
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
  // 系统提示首句（`systemPromptUpdate: in-history` 时它作为 role:'system'
  // 消息进入重放历史；即使 role 字段丢失，也不能把它当结论收进摘要）
  "You are an AI agent powered by DeepSeek Harness",
  "The available skill catalog changed",
  "The user changed the approval policy",
  "Approval prompts are disabled",
  // 每轮 prepare 时宿主采样时间并注入，同样伪装成 role:'user'
  "Time sampled while preparing",
  "Browser time zone for this request:",
  // ## 后台任务通知（`source.kind === 'tool-jobs'`）不是用户发言（★2026-11-15）
  //
  // 实测最新摘要的「用户请求」首条是：
  // ```
  // - background job pwsh-2b002cc2420941a9 (pwsh: cd H:\xjz; node server/src/index.js) finished …
  // ```
  // 这是宿主报告后台命令结束的注入，与用户意图无关，却占了仅有的
  // 12 个请求槽位之一。`source.kind` 已能识别，但摘要采集只看内容，
  // 所以这里补前缀兜底（两条通道都要拦，不能只靠 kind）。
  "background job ",
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
  return isProcessNarration(text, "assistant");
}
var ASSISTANT_PROSE_MARKER = /!\[[^\]]*\]\([^)]*\)/;
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
    if (section === "requests" && ASSISTANT_PROSE_MARKER.test(body)) continue;
    collect(buckets[section], seen, `- ${body}`, limits[section]);
  }
}
function isConversationRole(role) {
  return role === "user" || role === "assistant" || role === void 0;
}
var CONCLUSION_SLOTS = 15;
var PRUNE_CONCLUSION_LIMIT = 10;
function isConclusionRole(role) {
  return role === "assistant" || role === void 0;
}
function buildDeterministicSummary(messages, maxChars, realCounts, facts) {
  const max = typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 4e3;
  const requests = [];
  const calls = [];
  const errors = [];
  const conclusions = [];
  const pruneConclusions = [];
  const pruneSeen = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const requestSeen = /* @__PURE__ */ new Set();
  const priorSummaries = [];
  for (const raw of messages) {
    const message = raw;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const prunedByLrc = message.source?.kind === "lrc-prune";
    if (message.source?.kind === "tool-jobs") continue;
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
        if (!prunedByLrc && isNoiseText(b.text)) continue;
        if (!isConversationRole(message.role)) continue;
        const line = oneLine(b.text, 300);
        if (message.role === "user" && !prunedByLrc) {
          collect(requests, requestSeen, `- ${line}`, 12, { keepNewest: true });
        } else if ((isConclusionRole(message.role) || prunedByLrc) && (facts === void 0 || prunedByLrc)) {
          const bucket = prunedByLrc ? pruneConclusions : conclusions;
          const limit = prunedByLrc ? PRUNE_CONCLUSION_LIMIT : CONCLUSION_SLOTS;
          const seenForBucket = prunedByLrc ? pruneSeen : seen;
          if (!prunedByLrc) {
            if (isProcessNarration2(b.text)) continue;
            collect(bucket, seenForBucket, `- ${line}`, limit);
          } else {
            for (const clause of splitSentences(b.text)) {
              if (isProcessNarration2(clause)) continue;
              collect(bucket, seenForBucket, `- ${oneLine(clause, 300)}`, limit, { keepNewest: true });
            }
          }
        }
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
  if (facts !== void 0) {
    for (let i = facts.length - 1; i >= 0; i -= 1) {
      const fact = facts[i];
      if (fact.status !== void 0 && fact.status !== "active") continue;
      if (fact.kind !== "constraint" && fact.kind !== "decision" && fact.kind !== "conclusion" && fact.kind !== "statement") {
        continue;
      }
      collect(conclusions, seen, `- ${oneLine(fact.statement, 300)}`, CONCLUSION_SLOTS);
    }
  }
  for (let i = pruneConclusions.length - 1; i >= 0; i -= 1) {
    if (conclusions.length >= CONCLUSION_SLOTS) break;
    collect(conclusions, seen, pruneConclusions[i], CONCLUSION_SLOTS);
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
  if (conclusions.length === 0) {
    const cutCount = Array.isArray(messages) ? messages.length : 0;
    conclusions.push(`（本段无可用结论：已裁 ${cutCount} 条消息）`);
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
  if (text.length <= max) return text;
  const working = all.map((s) => ({ ...s, lines: [...s.lines] }));
  while (text.length > max) {
    const target = working.filter((s) => s.lines.length > 0).sort((a, b) => a.weight - b.weight)[0];
    if (!target) break;
    target.lines.pop();
    text = render(working.filter((s) => s.lines.length > 0));
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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
  const part = (label, total, real) => {
    if (real === void 0 || real === total) return `${label} ${total}`;
    if (real > total) return `${label} ${total}(截断自 ${real})`;
    return `${label} ${total}(${real}新+${total - real}继承)`;
  };
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
  const keepRecentNodes = normalizeCount(deps.options?.keepRecentNodes, DEFAULT_KEEP_RECENT, 0);
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
  const keepRecentNodes = normalizeCount(deps.options?.keepRecentNodes, DEFAULT_KEEP_RECENT, 0);
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
  const range = selectTrimRange(
    nodes,
    events,
    options.keepRecentNodes,
    // **两条触发路径都必须限流**。
    //
    // 上一版写 `force ? maxNodesPerRun : undefined`，理由是「token 超阈值
    // 说明真的太大了，该一次裁够」。这个判断是错的：
    //
    // - 事故的伤害不来自「裁得不够」，而来自「一次重写整段前缀」——
    //   KV 缓存按前缀复用，整段作废的代价与裁多少成正比。
    // - 真实日志里同一个窗口（contextWindow=1M ⇒ trimMin≈10.5 万）下，
    //   141 节点时刻 force 先触发；但窗口降到 800K 时 trimMin=8 万，
    //   节点数 114 就触发 token 路径 ⇒ 一次裁 104（91%），事故原样复发。
    // - 「一次裁够」并不会更快收敛：每步都有新节点进来，摊开裁同样能
    //   把规模压下去，且缓存损失小得多。
    //
    // ## 默认值必须下沉到函数内部
    //
    // 可以写成 `options.maxNodesPerRun`，也可以让 `selectTrimRange` 的
    // `undefined` 表示不限制 —— 但后者意味着**任何漏传的调用方都会精确
    // 复现事故**（实测 141 节点 → 裁 129，91.5%）。限流阀的默认值不能
    // 依赖「唯一装配点恰好传了」，所以这里自己补默认。
    options.maxNodesPerRun ?? DEFAULT_MAX_NODES_PER_RUN
  );
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
    const text = buildDeterministicSummary(list, cap, summaryRealCounts, options.facts);
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

// src/handoff-projection.ts
var MAX_PER_SECTION = 12;
var MAX_LINE = 160;
function weightOf(fact) {
  switch (fact.kind) {
    case "constraint":
      return 0;
    case "goal":
      return 1;
    case "decision":
      return 2;
    case "conclusion":
      return 3;
    case "location":
      return 4;
    case "artifact":
      return 5;
    default:
      return 6;
  }
}
function oneLine2(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}…` : flat;
}
function unique(lines) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const line of lines) {
    const key = line.replace(/[\s，。；：、]/g, "");
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
function order(facts) {
  const indexed = facts.map((fact, index) => ({ fact, index }));
  indexed.sort((a, b) => {
    const byWeight = weightOf(a.fact) - weightOf(b.fact);
    if (byWeight !== 0) return byWeight;
    return b.index - a.index;
  });
  return indexed.map((entry) => entry.fact);
}
function buildHandoffSections(input) {
  const ordered = order(input.facts.filter((f) => f.status === "active"));
  const confirmed = unique(
    ordered.filter((f) => f.kind === "constraint" || f.kind === "decision" || f.kind === "conclusion").map((f) => `${KIND_LABEL[f.kind]}：${oneLine2(f.statement)}`)
  ).slice(0, MAX_PER_SECTION);
  const progress = unique(
    ordered.filter((f) => f.kind === "location" || f.kind === "artifact").map((f) => oneLine2(f.statement))
  ).slice(0, MAX_PER_SECTION);
  const next = unique(
    ordered.filter((f) => f.kind === "goal" || f.kind === "constraint").map((f) => oneLine2(f.statement))
  ).slice(0, MAX_PER_SECTION);
  return {
    task: oneLine2(input.task),
    confirmed,
    progress,
    next,
    note: (input.note ?? "").trim()
  };
}
function renderHandoff(sections) {
  const out = ["# 会话交接", ""];
  out.push("## 当前任务");
  out.push(sections.task.length > 0 ? sections.task : "（未记录）");
  out.push("");
  const list = (title, lines) => {
    out.push(`## ${title}`);
    if (lines.length === 0) out.push("（无）");
    else for (const line of lines) out.push(`- ${line}`);
    out.push("");
  };
  list("已确认事实", sections.confirmed);
  list("当前进展", sections.progress);
  list("下一步意图", sections.next);
  if (sections.note.length > 0) {
    out.push("## 补充说明");
    out.push(sections.note);
    out.push("");
  }
  out.push("---");
  out.push("原文与长文档在 LRC / 工件库，需要时用 `lrc_recall` 或 `lrc_fetch_artifact` 取回。");
  return out.join("\n");
}
function projectHandoff(input) {
  const sections = buildHandoffSections(input);
  return { text: renderHandoff(sections), sections };
}

// src/artifact-store.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, readFileSync as readFileSync3, statSync as statSync2, unlinkSync, utimesSync as utimesSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var MIN_ARTIFACT_CHARS = 8e3;
var MAX_ARTIFACT_CHARS = 2e6;
var DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024;
function hashContent(text) {
  return createHash3("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
function isArtifactWorthy(text, minChars = MIN_ARTIFACT_CHARS) {
  return text.trim().length >= minChars;
}
function previewOf(text) {
  const firstLine = text.split("\n").map((l) => l.replace(/^[#>\-*+\s]+/, "").trim()).find((l) => l.length > 0) ?? "";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
var ArtifactStore = class {
  root;
  quotaBytes;
  index = null;
  constructor(root, quotaBytes = DEFAULT_QUOTA_BYTES) {
    this.root = root;
    this.quotaBytes = typeof quotaBytes === "number" && Number.isFinite(quotaBytes) && quotaBytes > 0 ? Math.floor(quotaBytes) : DEFAULT_QUOTA_BYTES;
  }
  indexPath() {
    return join2(this.root, "index.json");
  }
  bodyPath(hash) {
    return join2(this.root, `${hash}.txt`);
  }
  /** 载入索引（文件损坏时按空索引处理，不阻断主流程）。 */
  load() {
    if (this.index !== null) return this.index;
    try {
      if (existsSync3(this.indexPath())) {
        const parsed = JSON.parse(readFileSync3(this.indexPath(), "utf8"));
        this.index = parsed !== null && typeof parsed === "object" ? parsed : {};
      } else {
        this.index = {};
      }
    } catch {
      this.index = {};
    }
    return this.index;
  }
  persist() {
    try {
      mkdirSync3(dirname2(this.indexPath()), { recursive: true });
      writeFileSync3(this.indexPath(), JSON.stringify(this.load(), null, 2), "utf8");
    } catch {
    }
  }
  /**
   * 落盘一份工件。
   *
   * @param text - 原文
   * @returns 元数据；`reused` 为 true 表示 hash 已存在、未重复写盘
   */
  store(text) {
    const body = text.length > MAX_ARTIFACT_CHARS ? text.slice(0, MAX_ARTIFACT_CHARS) : text;
    const hash = hashContent(body);
    const index = this.load();
    const existing = index[hash];
    if (existing !== void 0) {
      this.touch(hash);
      return { meta: existing, reused: true };
    }
    const meta = {
      hash,
      chars: body.length,
      preview: previewOf(body),
      createdAt: Date.now()
    };
    try {
      mkdirSync3(this.root, { recursive: true });
      writeFileSync3(this.bodyPath(hash), body, "utf8");
    } catch {
    }
    index[hash] = meta;
    this.persist();
    this.evictIfNeeded();
    return { meta, reused: false };
  }
  /** 取回原文；不存在或已被淘汰时返回 null。 */
  fetch(hash) {
    const index = this.load();
    if (index[hash] === void 0) return null;
    try {
      const body = readFileSync3(this.bodyPath(hash), "utf8");
      this.touch(hash);
      return body;
    } catch {
      return null;
    }
  }
  /** 是否存在。 */
  has(hash) {
    return this.load()[hash] !== void 0;
  }
  /** 元数据（不存在返回 null）。 */
  meta(hash) {
    return this.load()[hash] ?? null;
  }
  /** 全部工件（按写入时间从新到旧）。 */
  list() {
    return Object.values(this.load()).sort((a, b) => b.createdAt - a.createdAt);
  }
  /** 刷新访问时间（LRU 用）。失败静默。 */
  touch(hash) {
    try {
      const path = this.bodyPath(hash);
      if (existsSync3(path)) {
        const now = /* @__PURE__ */ new Date();
        utimesSync2(path, now, now);
      }
    } catch {
    }
  }
  /** 当前占用字节数（按实际文件大小，不是字符数）。 */
  usageBytes() {
    try {
      if (!existsSync3(this.root)) return 0;
      let total = 0;
      for (const name2 of readdirSync(this.root)) {
        if (!name2.endsWith(".txt")) continue;
        try {
          total += statSync2(join2(this.root, name2)).size;
        } catch {
        }
      }
      return total;
    } catch {
      return 0;
    }
  }
  /**
   * 超额时按**最旧访问时间**淘汰，直到回到配额内。
   *
   * 用访问时间而不是写入时间：一个很早写入、但今天还在被取回的工件，
   * 比上周写入、再也没碰过的更值得保留。
   */
  evictIfNeeded() {
    let usage = this.usageBytes();
    if (usage <= this.quotaBytes) return;
    const index = this.load();
    const candidates = Object.values(index).map((meta) => {
      let atimeMs = meta.createdAt;
      try {
        atimeMs = statSync2(this.bodyPath(meta.hash)).atimeMs;
      } catch {
      }
      return { meta, atimeMs };
    }).sort((a, b) => a.atimeMs - b.atimeMs);
    for (const { meta } of candidates) {
      if (usage <= this.quotaBytes) break;
      try {
        const path = this.bodyPath(meta.hash);
        const size = existsSync3(path) ? statSync2(path).size : 0;
        if (existsSync3(path)) unlinkSync(path);
        delete index[meta.hash];
        usage -= size;
      } catch {
      }
    }
    this.persist();
  }
};

// src/llm-extract.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var MAX_INPUT_CHARS = 6e3;
var MAX_OUTPUT_TOKENS = 1200;
var MAX_JUDGE_CANDIDATES = 200;
var CALL_TIMEOUT_MS = 45e3;
var SYSTEM_PROMPT = [
  "你是记忆提取器。从用户提供的对话片段中挑出「值得跨会话复用」的信息，只输出 JSON。",
  "",
  "## 判断标准（这是唯一标准）",
  "",
  "问自己一个问题：**一个完全没看过这段对话的人，读到这句话能获得有用信息吗？**",
  "",
  "能 ⇒ 记。不能 ⇒ 不记。",
  "",
  "值得记的典型形态（不限于这些，措辞可以任意）：",
  "- 对某事物的判断、评价、定性",
  "- 已经查清的原因、机制、结果",
  "- 已定下来的做法、选型、约定",
  "- 对后续有强制力的规则",
  "- 可验收的量化目标",
  "- 某对象是什么 / 包含什么 / 在哪",
  "",
  "不值得记的：",
  "- 应答与确认（是的、明白了、好的）",
  "- 讲自己刚才/接下来在做什么（我先看一下、已经读完了、下面开始）",
  "- 指代不明、脱离上下文看不懂的句子（这个是刚才那个文件、这样的话就只能重写了）",
  "- 代码、表格行、JSON、日志",
  "- 纯粹的过渡句与章节标题",
  "",
  "## 输出格式（严格）",
  "",
  '{"items":[{"kind":"<类别>","text":"<一句话陈述>"}]}',
  "",
  "类别取值（选最贴合的一个）：",
  "- constraint：有强制力的规则",
  "- decision：定下来的做法",
  "- conclusion：查清的原因/结果",
  "- goal：量化目标",
  "- scope：范围约定",
  "- statement：定义、属性、构成、位置",
  "",
  "## 硬性要求",
  "",
  "1. text 必须自足：把这句话单独发给别人，他能看懂在说什么。",
  "2. text 保留原文的**判断与限定**（「比多数开源 agent 认真」这样的程度词不要丢）。",
  "3. 不要加「结论：」这类前缀，只写内容本身。",
  '4. 没有值得记的就输出 {"items":[]}。',
  "5. 最多 12 条，按重要性排序。"
].join("\n");
var JUDGE_PROMPT = [
  "你是记忆筛选器。用户会给出一批**从对话里切出的候选句**，你只判断哪些值得保留。",
  "",
  "## 唯一的判断标准",
  "",
  "问自己：**一个完全没看过这段对话的人，读到这句话能获得有用信息吗？**",
  "",
  "能 ⇒ 保留。不能 ⇒ 丢掉。",
  "",
  "## 保留（true）",
  "- 判断、评价、定性：`分层极其干净，改造成本低`",
  "- 查清的原因、机制、结果：`根因是旧进程没有随会话退出`",
  "- 定下来的做法：`改用 --stdin 传入 JSON`",
  "- 有强制力的规则：`以后都不要碰 3099`",
  "- 量化目标：`握手耗时压到 200ms 以内`",
  "- 对象的定义、属性、构成：`这个仓库收录了 443 个项目`",
  "",
  "## 丢弃（false）",
  "- 应答确认：`是的，我明白了` / `好的`",
  "- 自述步骤：`我先看一下这个文件` / `代码已全部读完，结论如下`",
  "- 指代不明、脱离上下文看不懂：`这个是刚才那个文件` / `这样的话就只能重写了`",
  "- 过渡与标题：`## 二、优点` / `下面分三点说`",
  "- 代码、表格行、JSON、日志片段",
  "",
  "## 输出格式（严格）",
  "",
  "只保留判为 true 的句子，**原样复制**，一个字都不要改：",
  '{"items":[{"kind":"statement","text":"<原句>"}]}',
  "",
  "kind 取值：constraint / decision / conclusion / goal / scope / statement",
  "",
  "## 硬性要求",
  "1. text 必须与候选句**完全一致**（不改写、不缩写、不补全）。",
  '2. 没有值得保留的就输出 {"items":[]}。',
  "3. 最多 12 条，优先保留信息密度高的。"
].join("\n");
var KIND_PREFIX = {
  constraint: "约束",
  decision: "决策",
  conclusion: "结论",
  goal: "约束",
  scope: "约束",
  // ## 必须与 `memory-extract.ts` 的 `TAG_KIND` 对齐
  //
  // 这里只是「行前缀」，真正决定类别的是 `factsFromLlmLines` 里的
  // `hintOf`。若两边不一致（例如这里给「事实」而 TAG_KIND 不认识），
  // 前缀会被当成正文，hint 丢失 ⇒ 陈述句退化成「随便命中的第一个谓词」。
  statement: "事实"
};
var CHARS_PER_EXPECTED_ITEM = 1200;
var ABSOLUTE_MIN_CHARS = 24;
var CAUSAL_SIGNAL = /根因|根本原因|原因在于|问题出在|问题在于|定位到|最终确认|结论是|结论为|确定为|查明|真相是/;
var DECISION_SIGNAL = /决定|决策|采用|改用|换成|改成|定为|选型|就用|方案是|最终选/;
var GOAL_SIGNAL = /(?:压|降|控制|限制)(?:到|至)\s*[0-9]|(?:不超过|不低于|不少于|不大于|不小于)\s*[0-9]|[0-9][0-9.]*\s*(?:ms|毫秒|秒|分钟|元|块|%|％|倍|MB|GB|KB|TB)\s*(?:以下|以内|内)/;
function missingKinds(text, extracted, extractedKinds) {
  const missing = [];
  const hasOf = (kind, prefix) => extractedKinds !== void 0 ? extractedKinds.includes(kind) : extracted.some((line) => line.startsWith(prefix));
  if (CAUSAL_SIGNAL.test(text) && !hasOf("conclusion", "结论：")) missing.push("结论");
  if (DECISION_SIGNAL.test(text) && !hasOf("decision", "决策：")) missing.push("决策");
  const goalCovered = (extractedKinds?.includes("goal") ?? false) || extracted.some((line) => GOAL_SIGNAL.test(line));
  if (GOAL_SIGNAL.test(text) && !goalCovered) {
    missing.push("目标");
  }
  return missing;
}
function shouldFallbackToLlm(input) {
  if (!input.enabled) return false;
  const pendingCount = input.pending?.length ?? 0;
  const chars = pendingCount > 0 ? input.pending.reduce((sum, line) => sum + line.length, 0) : input.text.trim().length;
  const materialChars = Math.max(chars, input.text.trim().length);
  const extractedCount = input.extracted.length;
  if (materialChars < ABSOLUTE_MIN_CHARS) return false;
  if (input.maxCalls > 0 && input.usedCalls >= input.maxCalls) return false;
  if (input.minIntervalMs > 0 && input.sinceLastMs < input.minIntervalMs) return false;
  const globalMax = input.globalMaxCalls ?? 0;
  if (globalMax > 0 && (input.globalCalls ?? 0) >= globalMax) return false;
  if (pendingCount > 0) return true;
  if (missingKinds(input.text, input.extracted, input.extractedKinds).length > 0) return true;
  if (chars < Math.max(1, input.minChars)) return false;
  if (extractedCount === 0) return true;
  const expected = Math.ceil(chars / CHARS_PER_EXPECTED_ITEM);
  return extractedCount < expected;
}
function safeGet3(ctx, name2) {
  try {
    return ctx?.get?.(name2);
  } catch {
    return void 0;
  }
}
function collectText(chunks) {
  const byIndex = /* @__PURE__ */ new Map();
  let finishKind = "unknown";
  for (const raw of chunks) {
    const chunk = raw;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      byIndex.set(index, (byIndex.get(index) ?? "") + chunk.text);
    } else if (chunk.type === "block-end" && chunk.block?.type === "text") {
      const index = typeof chunk.index === "number" ? chunk.index : 0;
      if (!byIndex.has(index) && typeof chunk.block.text === "string") {
        byIndex.set(index, chunk.block.text);
      }
    } else if (chunk.type === "finish") {
      finishKind = typeof chunk.reason?.kind === "string" ? chunk.reason.kind : "unknown";
    }
  }
  const text = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join("");
  return { text, finishKind };
}
function parseItems(raw) {
  const withoutFence = raw.replace(/```(?:json)?/gi, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return [];
  }
  const items = parsed?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    const rec = item;
    const kind = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase() : "";
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (text.length < 4 || text.length > 500) continue;
    out.push({ kind: KIND_PREFIX[kind] === void 0 ? "conclusion" : kind, text });
  }
  return out;
}
async function extractWithLlm(ctx, session, text, options = {}) {
  const maxInputChars = options.maxInputChars ?? MAX_INPUT_CHARS;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const body = text.trim();
  if (body.length === 0) return [];
  const config = session?.requestHeader?.()?.config;
  const provider = typeof config?.provider === "string" ? config.provider : "";
  const model = typeof config?.model === "string" ? config.model : "";
  if (provider.length === 0 || model.length === 0) return [];
  const llm = safeGet3(ctx, "llm");
  if (typeof llm?.stream !== "function") return [];
  const body2 = body.length > maxInputChars ? body.slice(-maxInputChars) : body;
  const candidates = options.candidates ?? [];
  const useJudge = candidates.length > 0;
  const input = useJudge ? candidates.slice(0, MAX_JUDGE_CANDIDATES).map((line, index) => `${index + 1}. ${line}`).join("\n") : body2;
  const system = useJudge ? JUDGE_PROMPT : SYSTEM_PROMPT;
  const messages = [
    {
      id: randomUUID2(),
      role: "user",
      content: [{ type: "text", text: input }],
      source: { kind: "plugin", plugin: "dsh-plugin-lrc" }
    }
  ];
  const collected = [];
  try {
    const stream = llm.stream({
      provider,
      model,
      messages,
      system,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      // `purpose` 只接受宿主已声明的枚举值（compaction / session-title），
      // 传未知值可能被适配器拒绝，故不设。
      signal: AbortSignal.timeout(timeoutMs),
      sessionId: session?.id
    });
    for await (const chunk of stream) collected.push(chunk);
  } catch (error) {
    options.onFailure?.(error instanceof Error ? error.message : String(error));
    return [];
  }
  const { text: rawText, finishKind } = collectText(collected);
  if (finishKind === "error" || finishKind === "aborted") return [];
  const parsed = parseItems(rawText);
  const lines = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of parsed) {
    const prefix = KIND_PREFIX[item.kind] ?? "结论";
    const flat = item.text.replace(/\s*\r?\n\s*/g, " ").trim();
    if (flat.length === 0) continue;
    const key = flat.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${prefix}：${flat}`);
  }
  return lines;
}

// src/capabilities.ts
function safeGet4(ctx, name2) {
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
  const presets = safeGet4(ctx, "agentPresets");
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
  const meter = fromEngine(engine, "tokenMeter") ?? safeGet4(ctx, "tokenMeter");
  const tokenMeter = {
    available: hasFn(meter, "measure"),
    detail: meter === void 0 ? "tokenMeter 不可达" : "measure 可用"
  };
  const pruner = safeGet4(ctx, "toolResultPruner") ?? (() => {
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
  const sessions = safeGet4(ctx, "sessions");
  const agents = safeGet4(ctx, "agents");
  const systemPrompt = safeGet4(ctx, "systemPrompt");
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
var MIN_TRIM_TOKENS = 8e3;
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function safeGet5(ctx, name2) {
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
function declaredWindow(session) {
  const context = session?.requestContext?.();
  const window = context?.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return void 0;
  if (window < MIN_SANE_WINDOW || window > 1e8) return void 0;
  return window;
}
async function resolveBudget(deps) {
  const { ctx, agent, config } = deps;
  if (config.contextWindowTokens > 0) {
    return derive(config.contextWindowTokens, config, "configured");
  }
  const session = agent?.session;
  const declared = declaredWindow(session);
  if (declared !== void 0) {
    return { ...derive(declared, config, "configured"), note: "from requestContext" };
  }
  const target = routedTarget(session);
  if (target === void 0) {
    return {
      windowTokens: 0,
      trimMinTokens: config.trimMinTokens,
      pruneResultThreshold: config.pruneResultThreshold,
      source: "fallback"
    };
  }
  const llm = safeGet5(ctx, "llm");
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
    // 下限用 MIN_TRIM_TOKENS：窗口按比例算出来太小时，攒够再裁，
    // 避免「一次工具输出就超阈值 ⇒ 每步重写历史 ⇒ 缓存永不命中」。
    trimMinTokens: clamp(
      Math.floor(windowTokens * config.trimRatio),
      MIN_TRIM_TOKENS,
      2e5
    ),
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
    const annotated = executed.map((name2) => {
      const outcome = state.lastOutcome[name2];
      if (outcome === void 0) return name2;
      if (outcome.ok) return name2;
      const short = outcome.reason.startsWith("error") ? outcome.reason : outcome.reason.split(":")[0] ?? outcome.reason;
      return `${name2}(${short})`;
    });
    log(`[lrc][governor] 第 ${state.steps} 步执行：${annotated.join(" → ")}`);
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
  offloadTurns: Schema.number().default(4),
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
  // 阈值按模型窗口比例推导：1M 窗口 → trim 100000 / prune 4000；
  // 128K 窗口 → trim 12800 / prune 2048。
  //
  // ★2026-11-12：0.03 → 0.10。原比例实测代价极高：trim 会重写早期历史，
  // 而 KV 缓存是前缀缓存 ⇒ 每次 trim 后整段缓存失效（实测 2 次 cacheRead=0
  // 全价重发，另 2 次丢 14K tokens 前缀）。而 trim 当次只降 3~7K tokens，
  // 上下文几步后又涨回原水位 —— **净亏**。
  // 0.10 让压缩在「真有必要」时才发生，而不是刚过 3% 就反复重写。
  contextWindowTokens: Schema.number().default(0),
  trimRatio: Schema.number().default(0.1),
  pruneRatio: Schema.number().default(4e-3),
  // 窗口探测失败时的绝对值兜底
  trimMinTokens: Schema.number().default(3e4),
  trimMinSteps: Schema.number().default(10),
  // ★2026-11-08：节点数硬上限兜底。token 计量一旦失真（宿主换版本 / meter 返回 0 /
  // 阈值配错），纯 token 触发会让上下文无限增长；节点数不依赖任何服务，用它兜底。
  // 实测正常稳态 31–72 节点，120 只在异常时触发。
  trimMaxNodes: Schema.number().default(120),
  // 单次最多裁 40 个（约 1/3）。宁可多裁几轮，也别一次重写整段前缀 ——
  // 每裁一次就打断一次 KV 前缀缓存，粗粒度裁剪的代价是细粒度的数倍。
  trimMaxNodesPerRun: Schema.number().default(40),
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
  // 系统提示写了也没用。改为由插件把**相关**记忆推进上下文。
  //
  // 默认仍关闭：这是会改动系统提示的路径，需用户在自己的 patch 里显式开启。
  // 是否启用由 `cordis.patch.yml` 决定（真正生效的是 profile 层那份）。
  /** 是否主动注入相关记忆 */
  recallInjectEnabled: Schema.boolean().default(false),
  /** 最多注入几条 */
  recallInjectMaxItems: Schema.number().default(2),
  /** 相对分下限（top1 恒为 1.0，单靠它等于永远放行一条） */
  recallInjectMinScore: Schema.number().default(0.85),
  /**
   * 绝对分下限（RRF 融合分，**名次信号而非语义相关度**）。
   *
   * RRF = Σ1/(60+rank)，值域 `(0, 2/61]`。实测三个离散簇：单路 0.0164 /
   * 双路 0.0301 / 双路靠前 0.0328，无中间值。0.025 等价于「要求至少两路命中」。
   * 实测区分力：项目内查询 12/12 过线，生活类无关查询 2/12 过线。
   */
  recallInjectMinRawScore: Schema.number().default(0.025),
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: Schema.number().default(80),
  // ── LLM 兜底提取 ──
  // 规则层（正则）只能覆盖「见过的措辞」，而模型表达是开放的。
  // 实测真实日志 214 句含信号句，规则抽出 113 句，边界外仍有真结论。
  // 兜底路径用**一次独立模型调用**补足 —— 这是结构约束，不是提示词。
  //
  // ★默认关闭：这是唯一会额外产生模型请求的路径，必须用户显式开启。
  // 开启后受「仅规则落空时触发 + 长度下限 + 会话额度 + 最小间隔」四重约束。
  /** 是否启用 LLM 兜底提取 */
  llmExtractEnabled: Schema.boolean().default(false),
  /**
   * 会话级最大调用次数（0 = 不限制）。
   *
   * ## 为什么是 200 而不是 40（★2026-11-14）
   *
   * 40 是按「类型缺口偶尔触发」估的。改成「有待裁决句子就触发」后，
   * 长正文几乎每轮都有待裁决句（实测 7258 字符报告里 79/82 句是待裁决），
   * 40 次会在一次长任务内用完，之后**静默关闭** —— 表现为「用着用着就不
   * 提炼了」，用户完全不知道发生了什么。
   *
   * 200 的量级：一次长任务约 30–60 次真实调用。压缩侧已经很省（trim 只在
   * 超阈值时触发），这部分成本换的是信息质量 —— 用户明确要求「既然已经
   * 节省了，就要保证信息质量」。
   */
  llmExtractMaxCalls: Schema.number().default(200),
  /**
   * 进程级最大调用次数（0 = 不限制），滑动窗口 1 小时。
   *
   * 会话配额按桶独立，多窗口下总量会成倍放大。这是最终硬上限。
   * 默认 500：约合 2.5 个满额会话/小时，足够单人常驻使用。
   */
  llmExtractGlobalMaxCalls: Schema.number().default(500),
  /**
   * 两次调用的最小间隔（毫秒）。
   *
   * 从 30 秒降到 5 秒：待裁决句是逐条消息产的，30 秒间隔会让同一轮里
   * 连续几条消息只有第一条能兜底，其余静默跳过。5 秒只用于防异常循环
   * （真正的总量控制由上面两个配额负责）。
   */
  llmExtractMinIntervalMs: Schema.number().default(5e3),
  /** 正文短于此长度不触发（默认 120 字符，短碎片不值得单独问） */
  llmExtractMinChars: Schema.number().default(120),
  /** 单次发送的正文上限（默认 6000 字符，超出取尾部） */
  llmExtractMaxInputChars: Schema.number().default(6e3),
  // ── 工件库（长文本落盘）──
  //
  // 用户粘贴的几百页文档 / 超长代码若留在对话里，会直接吃满窗口；
  // 若塞进 LRC，`recall` 会把长文档片段召回来，等于把上下文重新灌满。
  // 所以单独落盘，只在 LRC 留一条指针 Fact，按 hash 取回。
  /** 是否启用长文本落盘（默认开启：这是纯收益，无模型调用） */
  artifactEnabled: Schema.boolean().default(true),
  /** 超过多少字符才落盘 */
  artifactMinChars: Schema.number().default(8e3),
  /** 工件库磁盘配额（MB），超额按最久未访问淘汰 */
  artifactQuotaMb: Schema.number().default(200)
});
var PROMPT_SECTION = "lrc:memory-capture";
var ARTIFACT_CHUNK_CHARS = 8e3;
function buildPromptText(recallInjected) {
  const recallRule = recallInjected ? [
    "上下文里可能出现 `[LRC 历史记忆（可能过时，与当前任务无关时请忽略）]` 段落，",
    "那是插件按当前话题自动检索出来的历史记录。**用不用、信不信由你判断**：",
    "与当前任务相关就参考；明显无关或与已验证事实冲突时直接忽略，不要为了迎合它改变做法。",
    "若某条记忆与你已知的事实冲突，以**你能当场验证的**为准，并可用 `lrc_recall` 复核。",
    "遇到需要更早的细节、或该段落缺失时，再调 `lrc_recall` 补充检索；",
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
    "## 长文档与工件",
    "",
    "超长输入（整份文档、几百行代码）会由插件落盘为「工件」，上下文里只留一条",
    "`[工件] …（hash=xxxx）` 指针。需要看原文时调 `lrc_fetch_artifact(hash)`，",
    "它单次返回上限 8000 字符，更长的用 `offset` 分段读。",
    "**不要凭预览句臆测原文内容**，需要细节就取回。",
    "",
    "## 长期记忆沉淀",
    "",
    "插件会自动从你的回答里提取**约束**、**决策**、**结论**、**目标**、**范围限定**，",
    "所以不需要额外格式化输出。只要在回答里把结论说清楚即可。",
    "",
    "**最有价值的是这几类**（会被长期保留、跨会话复用）：",
    "- 约束：必须 / 禁止 / 只能 / 只支持 / 不要",
    "- 决策：改用 / 采用 / 定为 / 选型",
    "- 结论：根因 / 排查结论 / 定位到",
    "- 目标：压到 N 以下 / 降到 N 以内 / 不超过 N",
    "- 范围：这次只做什么、明确不做什么",
    "",
    "如果你愿意显式标注，可用下面的块（可选，不是必须）：",
    "",
    "<lrc_memory>",
    "- 决策：…",
    "- 约束：…",
    "- 结论：…",
    "</lrc_memory>",
    "",
    "规则：",
    "- 只写本轮产生的决策、约束、最终结论；没有的条目直接省略。",
    "- 只写结论，不写过程、待办清单、选项罗列或代码。"
  ].join("\n");
}
function apply(ctx, config) {
  const cacheDir = join3(process.env.DSH_HOME ?? join3(homedir2(), ".dsh"), "cache", "lrc-plugin");
  const snapshotPath = join3(cacheDir, "snapshot.json");
  const quotaMb = typeof config.artifactQuotaMb === "number" && Number.isFinite(config.artifactQuotaMb) && config.artifactQuotaMb > 0 ? config.artifactQuotaMb : 200;
  const artifactStore = new ArtifactStore(join3(cacheDir, "artifacts"), Math.floor(quotaMb * 1024 * 1024));
  const artifactEnabled = config.artifactEnabled !== false;
  const artifactMinChars = typeof config.artifactMinChars === "number" && config.artifactMinChars > 0 ? Math.floor(config.artifactMinChars) : 8e3;
  const sessionFacts = [];
  const SESSION_FACTS_MAX = 200;
  function recordSessionFacts(facts) {
    for (const fact of facts) {
      const key = factKey(fact);
      const at = sessionFacts.findIndex((prev) => factKey(prev) === key);
      if (at >= 0) sessionFacts.splice(at, 1);
      sessionFacts.push(fact);
    }
    if (sessionFacts.length > SESSION_FACTS_MAX) {
      sessionFacts.splice(0, sessionFacts.length - SESSION_FACTS_MAX);
    }
  }
  function recheckInterval(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }
  const capabilityRecheckSteps = recheckInterval(config.capabilityRecheckSteps);
  const budgetRecheckSteps = recheckInterval(config.budgetRecheckSteps);
  const trimMaxNodesPerRun = normalizeMaxNodes(config.trimMaxNodesPerRun) ?? DEFAULT_MAX_NODES_PER_RUN;
  function loadSnapshot() {
    const empty = { text: "", sessionId: "" };
    try {
      if (!existsSync4(snapshotPath)) return empty;
      const raw = JSON.parse(readFileSync4(snapshotPath, "utf8"));
      return {
        text: typeof raw.text === "string" ? raw.text : "",
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : ""
      };
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 快照文件读取失败，本次从空快照开始（${error instanceof Error ? error.message : String(error)}）：${snapshotPath}`
      );
      return empty;
    }
  }
  let warnedSaveSnapshot = false;
  function saveSnapshot(text, sessionId) {
    if (sessionId.length > 0 && currentSessionId.length > 0 && sessionId !== currentSessionId) {
      ctx.logger.info(
        `[lrc] 丢弃属于已离开会话（${sessionId}）的快照，当前为 ${currentSessionId}`
      );
      return false;
    }
    if (text.length > 0 && sessionId.length > 0) {
      latestSnapshot = text;
      snapshotOwner = sessionId;
    } else if (text.length > 0 && snapshotOwner === currentSessionId) {
      latestSnapshot = text;
    }
    try {
      mkdirSync4(cacheDir, { recursive: true });
      writeFileSync4(
        snapshotPath,
        JSON.stringify({ text, sessionId, updatedAt: Date.now() }),
        "utf8"
      );
    } catch (error) {
      if (!warnedSaveSnapshot) {
        warnedSaveSnapshot = true;
        ctx.logger.warn(
          `[lrc] 快照落盘失败，重启后 [LRC 状态] 会缺失（${error instanceof Error ? error.message : String(error)}）`
        );
      }
    }
    return true;
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
    minScore: config.recallInjectMinScore,
    minRawScore: config.recallInjectMinRawScore
  });
  let turnHits = 0;
  let turnMisses = 0;
  let proseTurns = 0;
  let llmExtractCalls = 0;
  let llmExtractHits = 0;
  let llmExtractFailures = 0;
  const LLM_EXTRACT_GLOBAL_WINDOW_MS = 60 * 60 * 1e3;
  const llmExtractGlobalStamps = [];
  function globalWindowCount(now) {
    const cutoff = now - LLM_EXTRACT_GLOBAL_WINDOW_MS;
    while (llmExtractGlobalStamps.length > 0 && llmExtractGlobalStamps[0] <= cutoff) {
      llmExtractGlobalStamps.shift();
    }
    return llmExtractGlobalStamps.length;
  }
  const proseBacklog = /* @__PURE__ */ new Map();
  const PROSE_BACKLOG_MAX = 30;
  function proseBacklogSize() {
    let total = 0;
    for (const list of proseBacklog.values()) total += list.length;
    return total;
  }
  function pushProseBacklog(owner, items) {
    const list = proseBacklog.get(owner) ?? [];
    list.push(...items);
    proseBacklog.set(owner, list);
    while (proseBacklogSize() > PROSE_BACKLOG_MAX) {
      const first = proseBacklog.keys().next();
      if (first.done === true) break;
      const head = proseBacklog.get(first.value) ?? [];
      const over = proseBacklogSize() - PROSE_BACKLOG_MAX;
      if (head.length <= over) proseBacklog.delete(first.value);
      else proseBacklog.set(first.value, head.slice(over));
    }
  }
  let snapshotGeneration = 0;
  let turnNoText = 0;
  let turnHadText = false;
  let turnTagSeen = false;
  let turnReasoning = [];
  let turnReasoningChars = 0;
  const storedSnapshot = loadSnapshot();
  let latestSnapshot = "";
  let snapshotOwner = storedSnapshot.sessionId;
  let currentSessionId = "";
  let snapshotServed = false;
  const governor = createGovernorState();
  let budget = null;
  const trimReasonsLogged = /* @__PURE__ */ new Set();
  let lastAgent;
  function bindSnapshotToSession(sessionId) {
    if (sessionId.length === 0) return;
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;
    if (recallText.length > 0 || recallFingerprint.length > 0) {
      recallText = "";
      recallFingerprint = "";
      recallGeneration += 1;
    }
    offloader.resetSnapshotPool();
    sessionFacts.length = 0;
    snapshotGeneration += 1;
    if (snapshotOwner !== sessionId) {
      if (storedSnapshot.text.length > 0) {
        ctx.logger.info(
          `[lrc] 快照属于其他会话（${snapshotOwner || "无归属"}），已丢弃 ${storedSnapshot.text.length} 字符，避免跨会话误导`
        );
      }
      latestSnapshot = "";
      snapshotServed = false;
      return;
    }
    if (latestSnapshot.length === 0 && storedSnapshot.text.length > 0) {
      latestSnapshot = storedSnapshot.text;
      ctx.logger.info(`[lrc] 快照归属本会话（${sessionId}），已恢复 ${latestSnapshot.length} 字符`);
    }
  }
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
    new CursorStore(join3(cacheDir, "cursor.json")),
    {
      turnsThreshold: config.offloadTurns,
      charsThreshold: config.offloadChars,
      stepsThreshold: config.offloadSteps,
      project: config.project,
      maxItems: config.maxItems
    },
    new RecentStore(join3(cacheDir, "recent.json"))
  );
  function attachOffloader(client) {
    offloader?.bind(client);
    drainProseBacklog();
  }
  function drainProseBacklog() {
    for (const [owner, list] of [...proseBacklog.entries()]) {
      if (list.length === 0) continue;
      proseBacklog.delete(owner);
      const pending = list;
      const ownerSessionId = owner.length > 0 ? owner : currentSessionId;
      void offloader.offloadFacts(pending, { intoPool: owner === currentSessionId }).then((result) => {
        if (result.distilled > 0) {
          if (result.snapshot.length > 0 && ownerSessionId.length > 0) {
            saveSnapshot(result.snapshot, ownerSessionId);
          }
          ctx.logger.info(
            `[lrc] 补写未连接期间的 ${result.distilled} 条约束/决策（写入 ${result.written}）`
          );
        }
      }).catch((error) => {
        if (isConnectionError(error)) {
          pushProseBacklog(owner, pending);
          ctx.logger.warn(
            `[lrc] 补写暂存约束失败（已放回队列重试）：${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        ctx.logger.warn(
          `[lrc] 补写暂存约束被 LRC 拒绝，已丢弃 ${pending.length} 条（不重试）：${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }
  function offloadExtracted(facts, ownerSessionId, label) {
    if (facts.length === 0) return;
    recordSessionFacts(facts);
    if (!offloader.connected) {
      pushProseBacklog(ownerSessionId, facts);
      void connection.get();
      return;
    }
    proseTurns += 1;
    const gen = ++snapshotGeneration;
    void offloader.offloadFacts(facts).then((result) => {
      if (gen !== snapshotGeneration) return;
      if (result.distilled > 0) {
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          saveSnapshot(result.snapshot, ownerSessionId);
        }
        ctx.logger.info(`[lrc] ${label} ${result.distilled} 条关键信息（写入 ${result.written}）`);
      }
    }).catch((error) => {
      ctx.logger.warn(
        `[lrc] ${label}沉淀失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  function archiveLongText(text, sessionId) {
    try {
      const { meta, reused } = artifactStore.store(text);
      const fact = makeArtifactFact({
        hash: meta.hash,
        preview: meta.preview,
        chars: meta.chars,
        kindLabel: "长文档",
        origin: "user",
        sessionId
      });
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        ctx.logger.warn(`[lrc] 工件指针 Fact 未通过校验：${verdict.reason}`);
        return;
      }
      offloadExtracted([fact], sessionId, "工件指针");
      ctx.logger.info(
        `[lrc] 长文本已落盘（${meta.chars} 字符，hash=${meta.hash}${reused ? "，复用已有工件" : ""}）：可用 lrc_fetch_artifact 取回`
      );
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 长文本落盘失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const LLM_EXTRACT_QUOTA_MAX = 20;
  const llmExtractQuota = /* @__PURE__ */ new Map();
  function quotaFor(sessionId) {
    const existing = llmExtractQuota.get(sessionId);
    if (existing !== void 0) {
      existing.touchedAt = Date.now();
      return existing;
    }
    if (llmExtractQuota.size >= LLM_EXTRACT_QUOTA_MAX) {
      const maxCalls = Math.max(0, config.llmExtractMaxCalls);
      let victimKey = null;
      let victimAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of llmExtractQuota) {
        const exhausted = maxCalls > 0 && value.count >= maxCalls;
        const rank = exhausted ? value.touchedAt + 1e15 : value.touchedAt;
        if (rank < victimAt) {
          victimAt = rank;
          victimKey = key;
        }
      }
      if (victimKey !== null) llmExtractQuota.delete(victimKey);
    }
    const now = Date.now();
    const fresh = { count: 0, lastCallAt: 0, touchedAt: now };
    llmExtractQuota.set(sessionId, fresh);
    return fresh;
  }
  function shouldFallback(text, extracted, sessionId, extractedKinds, pending) {
    const quota = quotaFor(sessionId);
    return shouldFallbackToLlm({
      text,
      extracted,
      extractedKinds,
      pending,
      enabled: config.llmExtractEnabled,
      minChars: config.llmExtractMinChars,
      maxCalls: config.llmExtractMaxCalls,
      usedCalls: quota.count,
      minIntervalMs: config.llmExtractMinIntervalMs,
      sinceLastMs: quota.lastCallAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - quota.lastCallAt,
      globalCalls: globalWindowCount(Date.now()),
      globalMaxCalls: config.llmExtractGlobalMaxCalls
    });
  }
  async function runLlmFallback(text, session, ownerSessionId, alreadyExtracted = [], candidates = [], origin = "assistant") {
    const quota = quotaFor(ownerSessionId);
    quota.count += 1;
    quota.lastCallAt = Date.now();
    llmExtractCalls += 1;
    llmExtractGlobalStamps.push(Date.now());
    try {
      const lines = await extractWithLlm(ctx, session, text, {
        maxInputChars: config.llmExtractMaxInputChars,
        // 有候选时走「判定」模式：模型只做二分类，产物可追溯到原文
        candidates,
        // ★失败必须留痕（2026-11-16 发布前审查 P1-3）
        //
        // 这是唯一产生额外计费的路径。若不区分「调用失败」与「模型判定无内容」，
        // 超时 / 401 / 路由拒绝在日志里与「没抽到」完全同形，排查时只能靠
        // `lrc_status` 的计数间接推断。
        onFailure: (reason) => {
          ctx.logger.warn(`[lrc] LLM 兜底调用失败（不影响主流程）：${reason.slice(0, 200)}`);
        }
      });
      if (lines.length === 0) {
        llmExtractFailures += 1;
        return;
      }
      const stripPrefix = (line) => line.replace(/^(约束|决策|结论|事实)：/, "").trim();
      const fresh = lines.filter((line) => {
        const body = stripPrefix(line);
        if (body.length === 0) return false;
        return !alreadyExtracted.some((prev) => {
          if (prev.length >= 4 && body.includes(prev.slice(0, 8))) return true;
          return areNearDuplicate(prev, body, 0.85);
        });
      });
      if (fresh.length === 0) {
        llmExtractFailures += 1;
        return;
      }
      const extracted = factsFromLlmLines(fresh, {
        origin,
        sessionId: ownerSessionId
      });
      if (extracted.facts.length === 0) {
        llmExtractFailures += 1;
        ctx.logger.info(
          `[lrc] LLM 兜底 ${fresh.length} 条候选全部被 schema 拒绝：` + extracted.rejected.map((r) => r.reason).join(",")
        );
        return;
      }
      llmExtractHits += 1;
      offloadExtracted(extracted.facts, ownerSessionId, "LLM 兜底");
    } catch (error) {
      llmExtractFailures += 1;
      ctx.logger.warn(
        `[lrc] LLM 兜底提取失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    drainProseBacklog();
  })();
  async function bootstrapSnapshot() {
    const client = connection.peek();
    if (client === null) return;
    try {
      const index = await client.index(config.project, 3);
      ctx.logger.info(
        `[lrc] 项目索引可用（${index.total} 条）。注意：跨会话记忆不注入为 [LRC 状态]，需要时用 lrc_recall 或开启 recallInjectEnabled`
      );
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
      const changed = next !== recallText;
      if (changed) {
        recallText = next;
        recallRewrites += 1;
      }
      const injected = next.length === 0 ? 0 : next.split("\n").length - 1;
      if (next.length === 0) {
        const top = result.memories.reduce((max, m) => {
          const raw = typeof m.score === "number" && Number.isFinite(m.score) ? m.score : -1;
          return raw > max ? raw : max;
        }, -1);
        const message = `[lrc] 本轮无记忆注入（候选 ${result.memories.length} 条，最高绝对分 ${top >= 0 ? top.toFixed(4) : "缺失"}，阈值 ${recallOptions.minRawScore}，指纹 ${fingerprint}）`;
        if (result.memories.length > 0 && top >= 0 && top < recallOptions.minRawScore) {
          ctx.logger.warn(
            `${message} —— 候选全部被绝对分闸门挡掉。若长期如此，检查 LRC 的通路权重（语义/深度路不可用时单路上限约 0.0164）或调低 recallInjectMinRawScore`
          );
        } else {
          ctx.logger.info(message);
        }
      } else if (changed) {
        ctx.logger.info(
          `[lrc] 注入 ${injected}/${result.memories.length} 条候选（${next.length} 字符，指纹 ${fingerprint}，累计改写 ${recallRewrites} 次）`
        );
      }
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
      const sessionId = session?.id ?? "";
      const lines = linesWithOrigin(session);
      if (lines.length === 0) {
        if (!warnedEmpty) {
          warnedEmpty = true;
          ctx.logger.warn("[lrc] 会话日志里没有可沉淀的文本行，本次跳过");
        }
        const fromReasoning = extractFactsFromReasoning({
          text: turnReasoning.join("\n"),
          origin: "assistant",
          sessionId
        });
        if (fromReasoning.facts.length === 0 && turnReasoning.length > 0 && !warnedNoConclusion) {
          warnedNoConclusion = true;
          ctx.logger.info(
            `[lrc] 推理兜底：本轮推理 ${turnReasoningChars} 字符，未拆出可用三元组（拒绝原因：${[...new Set(fromReasoning.rejected.map((r) => r.reason))].join(",") || "无候选"}）`
          );
        }
        if (fromReasoning.facts.length > 0) {
          try {
            const result2 = await offloader.offloadFacts(fromReasoning.facts);
            if (result2.distilled > 0) {
              if (result2.snapshot.length > 0 && snapshotChanged(latestSnapshot, result2.snapshot)) {
                saveSnapshot(result2.snapshot, sessionId);
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
          saveSnapshot(result.snapshot, sessionId);
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
          `[lrc] 沉淀来源：显式标签 ${turnHits}/${seen} 轮，正文抽取命中 ${proseTurns} 条消息（另有 ${turnNoText} 轮无正文）` + (config.llmExtractEnabled ? `；LLM 兜底 ${llmExtractCalls} 次调用，命中 ${llmExtractHits} 次，失败 ${llmExtractFailures} 次` : "；LLM 兜底未启用")
        );
      }
    } else {
      turnNoText += 1;
    }
    const hadText = turnHadText;
    const reasoning = turnReasoning.join("\n");
    resetTurnState();
    const sessionId = session?.id ?? "";
    await flush(session, "turn/end");
    if (hadText || reasoning.length === 0) return;
    const fromReasoning = extractFactsFromReasoning({
      text: reasoning,
      origin: "assistant",
      sessionId
    });
    if (fromReasoning.facts.length === 0) return;
    try {
      const result = await offloader.offloadFacts(fromReasoning.facts);
      if (result.distilled > 0) {
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          saveSnapshot(result.snapshot, sessionId);
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
    const sessionId = session?.id ?? "";
    bindSnapshotToSession(sessionId);
    if (type === "turn/start") {
      resetTurnState();
      return;
    }
    if (type === "turn/end") {
      void finishTurn(session);
      return;
    }
    if (type === "user/message" && isRealUserMessage(event)) {
      const userText = userMessageText(event);
      void refreshRecallInjection(userText);
      const result = extractFacts({
        text: userText,
        origin: "user",
        sessionId
      });
      offloadExtracted(result.facts, sessionId, "用户消息");
      const userExtractedKinds = result.facts.map((f) => f.kind);
      if (shouldFallback(userText, result.facts.map((f) => f.statement), sessionId, userExtractedKinds, result.pending)) {
        void runLlmFallback(
          userText,
          session,
          sessionId,
          result.facts.map((f) => f.statement),
          result.pending,
          "user"
        );
      }
      if (artifactEnabled && isArtifactWorthy(userText, artifactMinChars)) {
        archiveLongText(userText, sessionId);
      }
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
      const extracted = extractFacts({
        text,
        origin: "assistant",
        sessionId
      });
      offloadExtracted(extracted.facts, sessionId, "正文抽取");
      const alreadyExtracted = extracted.facts.map((f) => f.statement);
      const extractedKinds = extracted.facts.map((f) => f.kind);
      if (shouldFallback(text, alreadyExtracted, sessionId, extractedKinds, extracted.pending)) {
        void runLlmFallback(text, session, sessionId, alreadyExtracted, extracted.pending);
      }
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
    if (budget === null || budgetRecheckSteps > 0 && governor.steps % budgetRecheckSteps === 0) {
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
          const trimMaxNodes = typeof config.trimMaxNodes === "number" && Number.isFinite(config.trimMaxNodes) && config.trimMaxNodes > 0 ? config.trimMaxNodes : 120;
          const force = nodeCount > trimMaxNodes;
          if (force) {
            ctx.logger.info(
              `[lrc][trim] 节点数 ${nodeCount} 超过上限 ${trimMaxNodes}，跳过 token 阈值强制裁剪`
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
              force,
              // **两条路径都必须限流，不只 force**。
              //
              // 事故形态（141 节点裁 131 / 137 裁 127）在真实日志里正是
              // 「节点数 >120 ⇒ force」触发的，所以上一版只给 force 加限制，
              // 看起来修好了。但 token 触发路径（窗口 300K~800K 时
              // trimMin 降到 8 万，节点数 114 就触发）传的是 `undefined`
              // ⇒ 一次裁 104（91%），**同一事故原样复发**。
              //
              // 节点数硬上限只是个「兜底触发器」；真正决定「一次裁多少」的
              // 是这里。所以两条路径统一用一个上限：见 `trimMaxNodesPerRun`。
              maxNodesPerRun: trimMaxNodesPerRun,
              // 摘要的「助手结论」段从这里投影，而不是靠 role 猜。
              // 不传的话，摘要会把「我先去仓库看看」这类过程叙述当结论。
              facts: sessionFacts
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
          const extracted = extractFacts({
            text: args.text,
            origin: "assistant",
            sessionId: currentSessionId
          });
          if (extracted.facts.length === 0) {
            const reasons = [...new Set(extracted.rejected.map((r) => r.reason))].join(",");
            ctx.logger.info(`[lrc][tool] lrc_remember_now 无可入库内容（${reasons || "无候选"}）`);
            return {
              snapshot: `未沉淀：没有可拆成「主体+关系+取值」的关键信息${reasons.length > 0 ? `（${reasons}）` : ""}`,
              distilled: 0,
              written: 0,
              merged: 0
            };
          }
          const items = factsToItems(extracted.facts);
          const migrated = await client.migrate(items, config.project);
          ctx.logger.info(
            `[lrc][tool] lrc_remember_now 沉淀 ${items.length} 条（写入 ${migrated.written}，合并 ${migrated.merged}）`
          );
          return {
            snapshot: extracted.facts.map(renderFact).join("\n"),
            distilled: items.length,
            written: migrated.written,
            merged: migrated.merged
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
        let text;
        if (sessionFacts.length > 0) {
          const projected = projectHandoff({
            facts: sessionFacts,
            task: source.lastUserRequest,
            note: args.note ?? ""
          });
          text = projected.text;
          ctx.logger.info(
            `[lrc][tool] lrc_handoff 从 ${sessionFacts.length} 条 Fact 投影：事实 ${projected.sections.confirmed.length} / 进展 ${projected.sections.progress.length} / 下一步 ${projected.sections.next.length}`
          );
        } else if (connection.peek() !== null) {
          let indexLines = [];
          try {
            const index = await connection.peek().index(config.project, 10);
            indexLines = index.items.map((item) => item.content_preview);
          } catch {
          }
          text = buildHandoffText({
            lastUserRequest: source.lastUserRequest,
            recentAssistant: source.recentAssistant,
            snapshot: latestSnapshot,
            indexLines,
            note: args.note ?? ""
          });
          ctx.logger.info("[lrc][tool] lrc_handoff 本会话 Fact 账本为空，退回索引拼装");
        } else {
          text = buildHandoffText({
            lastUserRequest: source.lastUserRequest,
            recentAssistant: source.recentAssistant,
            snapshot: latestSnapshot,
            indexLines: [],
            note: args.note ?? ""
          });
          ctx.logger.info("[lrc][tool] lrc_handoff 无 Fact 账本且 LRC 未连接，退回纯文本交接");
        }
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
    "lrc_fetch_artifact",
    () => defineTool({
      name: "lrc_fetch_artifact",
      description: `取回此前落盘的长文档 / 超长代码原文。当上下文里出现「[工件] 长文档已存入工件库（… hash=xxx）」而你需要看原文时调用。单次最多返回 ${ARTIFACT_CHUNK_CHARS} 字符，超长内容用 offset 分段读。`,
      parameters: {
        hash: {
          type: "string",
          required: true,
          description: "工件 hash（从 [工件] 记忆条目里取 hash= 后面的值）"
        },
        offset: {
          type: "number",
          description: "起始字符偏移，默认 0"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            found: { type: "boolean", required: true },
            total: { type: "number", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      async execute(args) {
        const hash = typeof args.hash === "string" ? args.hash.trim() : "";
        if (hash.length === 0) {
          return { text: "lrc_fetch_artifact 需要非空的 hash。", found: false, total: 0 };
        }
        const body = artifactStore.fetch(hash);
        if (body === null) {
          return {
            text: `未找到工件 ${hash}。可能已被配额淘汰，或 hash 有误。可用 lrc_recall 检索「工件」类记忆确认可用的 hash。`,
            found: false,
            total: 0
          };
        }
        const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
        const chunk = body.slice(offset, offset + ARTIFACT_CHUNK_CHARS);
        const more = offset + chunk.length < body.length;
        const head = offset === 0 ? `工件 ${hash}（共 ${body.length} 字符）` : `工件 ${hash}（共 ${body.length} 字符，从 ${offset} 开始）`;
        const tail = more ? `

--- 还有 ${body.length - offset - chunk.length} 字符，用 offset=${offset + chunk.length} 继续读 ---` : "";
        ctx.logger.info(`[lrc][tool] lrc_fetch_artifact ${hash} → ${chunk.length}/${body.length} 字符`);
        return {
          text: `${head}

${chunk}${tail}`,
          found: true,
          total: body.length
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
        lines.push("## 工件库");
        {
          if (!artifactEnabled) {
            lines.push("已关闭（artifactEnabled=false）：长文本按原样留在上下文。");
          } else {
            const items = artifactStore.list();
            lines.push(
              `启用：阈值 ${artifactMinChars} 字符 / 配额 ${quotaMb} MB / 现有 ${items.length} 个 / 占用 ${(artifactStore.usageBytes() / 1024 / 1024).toFixed(2)} MB`
            );
            for (const item of items.slice(0, 5)) {
              lines.push(`- ${item.hash}（${item.chars} 字符）：${item.preview}`);
            }
            if (items.length > 5) lines.push(`- …另有 ${items.length - 5} 个`);
          }
          lines.push(`本会话 Fact 账本：${sessionFacts.length} 条（交接文档的数据源）`);
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
        if (!recallInjectOn) {
          const dshHome = dirname3(dirname3(cacheDir));
          const patchPath = join3(dshHome, "profiles", "desktop", "cordis.patch.yml");
          lines.push("");
          lines.push("### 主动召回注入未启用");
          lines.push(
            `在 \`${patchPath}\` 的 \`id: dsh-plugin-lrc\` → \`config:\` 下补以下五行，然后重启 DSH：`
          );
          lines.push("```yaml");
          lines.push("        recallInjectEnabled: true");
          lines.push("        recallInjectMaxItems: 2");
          lines.push("        recallInjectMinScore: 0.85");
          lines.push("        recallInjectMinRawScore: 0.025");
          lines.push("        recallInjectMaxCharsPerItem: 80");
          lines.push("```");
          lines.push("（上溯路径来自本插件实际使用的缓存目录；多 profile 时请确认当前 profile 名。）");
        }
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
            `配置：最多 ${recallOptions.maxItems} 条｜相对分 ≥${recallOptions.minScore}｜绝对分 ≥${recallOptions.minRawScore}｜单条 ${recallOptions.maxCharsPerItem} 字符｜总长 ${recallOptions.maxTotalChars}`
          );
          if (recallOptions.minRawScore > 0.0164) {
            lines.push(
              "（绝对分阈值为 RRF 名次分：单路命中上限约 0.0164。若 LRC 的语义/深度通路不可用，该阈值会导致整场不注入 —— 见日志 warn。）"
            );
          }
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
